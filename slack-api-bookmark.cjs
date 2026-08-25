#!/usr/bin/env node

const {
  loadAuth,
  parseCommonArgs,
  parsePermalink,
  parsePositiveInt,
  permalinkFor,
  slackApiCall,
} = require("./slack-api-common.cjs");

const DEFAULT_HYDRATION_CONCURRENCY = 4;
const SAVED_FILTERS = ["saved", "completed", "archived"];
const BOOKMARK_ACTIONS = new Set(["add", "remove"]);

function parseArgs(argv) {
  const { args, remaining } = parseCommonArgs(argv, {
    action: "list",
    link: "",
    channel: "",
    ts: "",
    dryRun: false,
    limit: 100,
    maxPages: 20,
    includeText: false,
    includeArchived: false,
  });

  if (remaining[0] && !remaining[0].startsWith("-")) {
    const rawAction = remaining.shift();
    if (!BOOKMARK_ACTIONS.has(rawAction)) {
      throw new Error(`Unknown bookmarks action: ${rawAction}. Use \`add <permalink>\` or \`remove <permalink>\`.`);
    }
    args.action = rawAction;
    if (remaining[0] && !remaining[0].startsWith("-")) {
      args.link = remaining.shift();
    }
  }

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    const next = () => {
      index += 1;
      if (index >= remaining.length) throw new Error(`Missing value for ${arg}`);
      return remaining[index];
    };

    if (arg === "--link") args.link = next();
    else if (arg === "--channel") args.channel = next();
    else if (arg === "--ts") args.ts = next();
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--limit") args.limit = parsePositiveInt(next(), "--limit");
    else if (arg === "--max-pages") args.maxPages = parsePositiveInt(next(), "--max-pages");
    else if (arg === "--include-text") args.includeText = true;
    else if (arg === "--redact-text") args.includeText = false;
    else if (arg === "--include-archived") args.includeArchived = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (!arg.startsWith("-") && args.action !== "list") {
      if (args.link) throw new Error(`Unexpected extra argument: ${arg}`);
      args.link = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (args.action !== "list") {
    if (args.link) {
      const target = parsePermalink(args.link);
      args.channel = target.channelId;
      args.ts = target.messageTs;
    }
    if (!args.channel) throw new Error("--link or --channel is required");
    if (!args.ts) throw new Error("--link or --ts is required");
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  slack-api bookmarks
  slack-api bookmarks --limit 50 --include-text
  slack-api bookmarks add <permalink>
  slack-api bookmarks remove <permalink>

Actions:
  (none)             List your saved Later messages. Default
  add <permalink>    Save a message to Later (bookmark it)
  remove <permalink> Unsave a message from Later

List options:
  --limit N          Maximum bookmarked messages to return. Default: 100
  --max-pages N      Maximum saved-list pages to read. Default: 20
  --include-text     Include bookmarked message text
  --redact-text      Redact bookmarked message text. Default
  --include-archived Include completed and archived Later messages

add/remove options:
  --link <permalink> Permalink of the message to save/unsave (or pass it positionally)
  --channel <id>     Channel ID instead of a permalink
  --ts <ts>          Message timestamp instead of a permalink
  --dry-run          Show what would happen without saving/unsaving

Common:
  --workspace URL    Slack workspace URL
  --auth-cache FILE  Auth cache path
  --refresh-auth     Refresh auth from browser profile first
`);
}

function itemState(item) {
  return String(item.state || item.todo_state || "").trim().toLowerCase();
}

function isHistoricalSavedItem(item) {
  const state = itemState(item);
  if (["completed", "archived"].includes(state)) return true;
  if (item.is_archived === true) return true;
  return !["saved", "in_progress"].includes(state)
    && Number(item.date_completed || 0) > 0;
}

function isNonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isResultMessage(item, args) {
  return item?.item_type === "message"
    && isNonemptyString(item.item_id)
    && isNonemptyString(item.ts)
    && (args.includeArchived || !isHistoricalSavedItem(item));
}

function savedFilters(args) {
  return args.includeArchived ? SAVED_FILTERS : [SAVED_FILTERS[0]];
}

function itemKey(item) {
  return `${item.item_type || ""}\u0000${item.item_id || ""}\u0000${item.ts || ""}`;
}

function threadAwarePermalink(args, channelId, ts, message, canonicalPermalink) {
  if (canonicalPermalink) return canonicalPermalink;
  if (!channelId || !ts) return null;

  const link = permalinkFor(args.workspace, channelId, ts);
  const rootTs = message?.thread_ts;
  if (!rootTs || rootTs === ts) return link;

  const url = new URL(link);
  url.searchParams.set("thread_ts", rootTs);
  url.searchParams.set("cid", channelId);
  return url.toString();
}

function summarizeItem(item, message, args, canonicalPermalink = "") {
  const channelId = item.item_id || null;
  const ts = item.ts || null;
  return {
    channelId,
    ts,
    threadTs: message?.thread_ts || null,
    user: message?.user || null,
    state: itemState(item) || null,
    isArchived: typeof item.is_archived === "boolean" ? item.is_archived : null,
    savedAt: item.date_created || null,
    completedAt: item.date_completed || null,
    permalink: threadAwarePermalink(args, channelId, ts, message, canonicalPermalink),
    text: args.includeText
      ? (message?.text || "")
      : "[redacted; rerun with --include-text to save message text]",
  };
}

async function fetchMessage(args, item, call) {
  const fallbackPermalink = permalinkFor(args.workspace, item.item_id, item.ts);
  const history = await call(args, "conversations.history", {
    channel: item.item_id,
    oldest: item.ts,
    latest: item.ts,
    inclusive: true,
    limit: 1,
  });
  if (!history.json?.ok) {
    return {
      message: null,
      permalink: fallbackPermalink,
      error: history.json?.error || "history_unavailable",
    };
  }

  const message = (history.json.messages || []).find((entry) => entry.ts === item.ts);
  if (message) return { message, permalink: fallbackPermalink, error: null };

  // saved.list does not include a reply's root timestamp. Ask Slack for the
  // canonical reply link, which contains thread_ts, before reading the thread.
  const permalinkResult = await call(args, "chat.getPermalink", {
    channel: item.item_id,
    message_ts: item.ts,
  });
  const canonicalPermalink = permalinkResult.json?.permalink || "";
  if (!permalinkResult.json?.ok || !canonicalPermalink) {
    return {
      message: null,
      permalink: fallbackPermalink,
      error: permalinkResult.json?.error || "permalink_unavailable",
    };
  }

  let target;
  try {
    target = parsePermalink(canonicalPermalink);
  } catch {
    return { message: null, permalink: fallbackPermalink, error: "invalid_message_permalink" };
  }
  if (target.channelId !== item.item_id || target.messageTs !== item.ts) {
    return { message: null, permalink: fallbackPermalink, error: "permalink_target_mismatch" };
  }

  const replies = await call(args, "conversations.replies", {
    channel: item.item_id,
    ts: target.rootTs,
    oldest: item.ts,
    latest: item.ts,
    inclusive: true,
    limit: 1,
  });
  if (!replies.json?.ok) {
    return {
      message: null,
      permalink: canonicalPermalink,
      error: replies.json?.error || "message_unavailable",
    };
  }
  const reply = (replies.json.messages || []).find((entry) => entry.ts === item.ts) || null;
  return {
    message: reply,
    permalink: canonicalPermalink,
    error: reply ? null : "message_not_found",
  };
}

function listFailure(result, error, overrides = {}) {
  return {
    ok: false,
    complete: false,
    error,
    status: result.status,
    authSource: result.authSource,
    authHint: result.authHint,
    hasMore: true,
    truncated: true,
    remainingFilters: [],
    pageCount: result.pageCount,
    fetchedItemCount: result.fetchedItemCount,
    items: result.items,
    ...overrides,
  };
}

async function fetchSavedItems(args, call) {
  const result = {
    status: null,
    authSource: null,
    authHint: null,
    pageCount: 0,
    fetchedItemCount: 0,
    items: [],
  };
  const seenItems = new Set();
  const filters = savedFilters(args);

  for (let filterIndex = 0; filterIndex < filters.length; filterIndex += 1) {
    const filter = filters[filterIndex];
    const seenCursors = new Set();
    let cursor = "";

    while (result.items.length < args.limit) {
      if (result.pageCount >= args.maxPages) {
        return listFailure(result, "saved_page_limit_reached", {
          nextCursor: cursor,
        });
      }
      if (seenCursors.has(cursor)) {
        return listFailure(result, "saved_pagination_stalled", {
          nextCursor: cursor,
        });
      }
      seenCursors.add(cursor);

      result.pageCount += 1;
      let page;
      try {
        page = await call({ ...args, enterprise: true }, "saved.list", {
          filter,
          include_tombstones: true,
          limit: Math.min(args.limit - result.items.length, 50),
          ...(cursor ? { cursor } : {}),
        });
      } catch (error) {
        return listFailure(result, error.message || String(error), {
          nextCursor: cursor,
        });
      }
      result.status = page.response?.status ?? result.status;
      result.authSource = page.auth?.source || result.authSource;
      result.authHint = page.json?.authHint || result.authHint;

      if (!page.json || typeof page.json !== "object") {
        return listFailure(result, "invalid_saved_list_response", { nextCursor: cursor });
      }
      if (!page.json.ok) {
        return listFailure(result, page.json.error || "saved_list_failed", {
          hasMore: Boolean(cursor),
          nextCursor: cursor,
        });
      }
      if (!Array.isArray(page.json.saved_items)) {
        return listFailure(result, "invalid_saved_items_response", { nextCursor: cursor });
      }

      const pageItems = page.json.saved_items;
      result.fetchedItemCount += pageItems.length;
      for (const item of pageItems) {
        if (item?.item_type === "message"
          && (!isNonemptyString(item.item_id) || !isNonemptyString(item.ts))) {
          return listFailure(result, "invalid_saved_message_item", {
            nextCursor: cursor,
          });
        }
        if (!isResultMessage(item, args)) continue;
        const key = itemKey(item);
        if (seenItems.has(key)) continue;
        seenItems.add(key);
        result.items.push(item);
        if (result.items.length >= args.limit) break;
      }

      const nextCursor = page.json.response_metadata?.next_cursor || "";
      if (page.json.has_more && !nextCursor) {
        return listFailure(result, "saved_next_cursor_missing", { nextCursor: "" });
      }
      if (result.items.length >= args.limit) {
        return {
          ok: true,
          complete: true,
          error: null,
          status: result.status,
          authSource: result.authSource,
          authHint: result.authHint,
          hasMore: Boolean(nextCursor),
          truncated: Boolean(nextCursor || filterIndex < filters.length - 1),
          remainingFilters: filters.slice(filterIndex + 1),
          nextCursor,
          pageCount: result.pageCount,
          fetchedItemCount: result.fetchedItemCount,
          items: result.items,
        };
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  }

  return {
    ok: true,
    complete: true,
    error: null,
    status: result.status,
    authSource: result.authSource,
    authHint: result.authHint,
    hasMore: false,
    truncated: false,
    remainingFilters: [],
    nextCursor: "",
    pageCount: result.pageCount,
    fetchedItemCount: result.fetchedItemCount,
    items: result.items,
  };
}

function isRateLimited(result) {
  return result?.response?.status === 429 || result?.json?.error === "ratelimited";
}

function retryAfterMs(result) {
  const raw = result?.response?.headers?.get?.("retry-after");
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1_000;
  return Math.min(seconds, 60) * 1_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withRateLimitRetries(call, options = {}) {
  const maxRetries = options.maxRetries ?? 2;
  const wait = options.sleep || sleep;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("Rate-limit retries must be an integer >= 0");
  }

  return async (...callArgs) => {
    let result;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      result = await call(...callArgs);
      if (!isRateLimited(result) || attempt === maxRetries) return result;
      await wait(retryAfterMs(result));
    }
    return result;
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Hydration concurrency must be an integer >= 1");
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function enterpriseSavedHint(error, args, method = "saved.list") {
  if (!/^(?:enterprise|team)_is_restricted$/.test(String(error || ""))) return null;
  if (args?.auth?.enterpriseToken) {
    return `${method} was rejected on the enterprise host. Re-run with \`slack-api auth --refresh\` to refresh the enterprise session, then retry bookmarks.`;
  }
  return `${method} is restricted on Enterprise Grid without an organization-scoped session. Re-run \`slack-api auth --refresh\` once (this captures the enterprise token), then retry bookmarks.`;
}

async function run(args, dependencies = {}) {
  const call = dependencies.slackApiCall || slackApiCall;
  const listed = await fetchSavedItems(args, dependencies.savedListApiCall || call);
  if (!listed.ok || !listed.complete) {
    return {
      ok: listed.ok,
      complete: listed.complete,
      status: listed.status,
      error: listed.error,
      errorHint: enterpriseSavedHint(listed.error, args),
      authSource: listed.authSource,
      authHint: listed.authHint,
      includeText: args.includeText,
      includeArchived: args.includeArchived,
      hasMore: listed.hasMore,
      truncated: listed.truncated,
      remainingFilters: listed.remainingFilters,
      nextCursor: listed.nextCursor || "",
      pageCount: listed.pageCount,
      fetchedItemCount: listed.fetchedItemCount,
      resultCount: 0,
      hydrationErrorCount: 0,
      results: [],
    };
  }

  const hydrationConcurrency = dependencies.hydrationConcurrency
    ?? DEFAULT_HYDRATION_CONCURRENCY;
  const messageCall = withRateLimitRetries(dependencies.messageApiCall || call, {
    maxRetries: dependencies.rateLimitRetries,
    sleep: dependencies.sleep,
  });
  const hydrated = await mapWithConcurrency(
    listed.items,
    hydrationConcurrency,
    async (item) => {
      try {
        return { item, ...(await fetchMessage(args, item, messageCall)) };
      } catch (error) {
        return {
          item,
          message: null,
          permalink: permalinkFor(args.workspace, item.item_id, item.ts),
          error: error.message || String(error),
        };
      }
    },
  );
  const hydrationErrorCount = hydrated.filter(({ error }) => Boolean(error)).length;
  const complete = hydrationErrorCount === 0;
  return {
    ok: true,
    complete,
    status: listed.status,
    error: complete ? null : "partial_message_hydration",
    errorHint: null,
    authSource: listed.authSource,
    authHint: listed.authHint,
    includeText: args.includeText,
    includeArchived: args.includeArchived,
    hasMore: listed.hasMore,
    truncated: listed.truncated,
    remainingFilters: listed.remainingFilters,
    nextCursor: listed.nextCursor || "",
    pageCount: listed.pageCount,
    fetchedItemCount: listed.fetchedItemCount,
    resultCount: hydrated.length,
    hydrationErrorCount,
    results: hydrated.map(({ item, message, permalink, error }) => ({
      ...summarizeItem(item, message, args, permalink),
      messageAvailable: Boolean(message),
      messageError: error,
    })),
  };
}

function savedMutationOutput(args, plannedAction) {
  const { channel, ts } = args;
  return {
    ok: false,
    complete: false,
    action: plannedAction,
    channelId: channel,
    ts,
    permalink: permalinkFor(args.workspace, channel, ts),
    planned: true,
    dryRun: Boolean(args.dryRun),
    status: null,
    error: null,
    errorHint: null,
    authSource: args.auth?.source || null,
    authHint: null,
    item: null,
  };
}

async function mutateSavedItem(args, method, plannedAction, dependencies = {}) {
  const call = dependencies.slackApiCall || slackApiCall;
  const output = savedMutationOutput(args, plannedAction);
  if (args.dryRun) {
    return {
      ...output,
      ok: true,
      complete: true,
      planned: true,
      message: `${plannedAction === "add" ? "Would save" : "Would unsave"} message ${args.channel}/${args.ts}`,
    };
  }

  const params = {
    item_id: args.channel,
    item_type: "message",
    ts: args.ts,
  };
  const { response, json } = await call({ ...args, enterprise: true }, method, params);
  const already = json?.error === "already_saved" || json?.error === "saved_item_exists";
  const jsonOk = Boolean(json?.ok);
  // saved.delete returns ok:true even when the item was never saved, so remove
  // is unconditional; saved.add may flag an existing item as already_saved on
  // some hosts, so treat that as success too.
  const ok = jsonOk || (plannedAction === "add" ? already : false);
  return {
    ...output,
    ok,
    complete: ok,
    planned: false,
    dryRun: false,
    status: response?.status ?? null,
    error: json?.error || null,
    errorHint: enterpriseSavedHint(json?.error, args, method),
    authHint: json?.authHint || null,
    already: plannedAction === "add" ? already : null,
    item: json?.item || null,
  };
}

function exitCodeForOutput(output) {
  return output?.ok && output.complete ? 0 : 1;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = parseArgs(argv);
  const authenticate = dependencies.loadAuth || loadAuth;
  args.auth = await authenticate(args);

  let output;
  if (args.action === "add") {
    output = await mutateSavedItem(args, "saved.add", "add", dependencies);
  } else if (args.action === "remove") {
    output = await mutateSavedItem(args, "saved.delete", "remove", dependencies);
  } else {
    output = await run(args, dependencies);
  }
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) {
  main().then((output) => {
    process.exitCode = exitCodeForOutput(output);
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  exitCodeForOutput,
  fetchMessage,
  fetchSavedItems,
  isHistoricalSavedItem,
  isResultMessage,
  main,
  mapWithConcurrency,
  mutateSavedItem,
  parseArgs,
  run,
  savedFilters,
  savedMutationOutput,
  summarizeItem,
  withRateLimitRetries,
};
