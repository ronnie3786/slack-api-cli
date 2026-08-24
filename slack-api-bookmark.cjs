#!/usr/bin/env node

const {
  loadAuth,
  parseCommonArgs,
  parsePositiveInt,
  permalinkFor,
  slackApiCall,
} = require("./slack-api-common.cjs");

function parseArgs(argv) {
  const { args, remaining } = parseCommonArgs(argv, {
    limit: 100,
    includeText: false,
    includeArchived: false,
  });

  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index];
    const next = () => {
      index += 1;
      if (index >= remaining.length) throw new Error(`Missing value for ${arg}`);
      return remaining[index];
    };

    if (arg === "--limit") args.limit = parsePositiveInt(next(), "--limit");
    else if (arg === "--include-text") args.includeText = true;
    else if (arg === "--redact-text") args.includeText = false;
    else if (arg === "--include-archived") args.includeArchived = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  slack-api bookmarks
  slack-api bookmarks --limit 50 --include-text

Options:
  --limit N          Maximum bookmarked messages to return. Default: 100
  --include-text     Include bookmarked message text
  --redact-text      Redact bookmarked message text. Default
  --include-archived Include archived saved messages
  --workspace URL    Slack workspace URL
  --auth-cache FILE  Auth cache path
  --refresh-auth     Refresh auth from browser profile first
`);
}

function summarizeItem(item, message, args) {
  const channelId = item.item_id || null;
  const ts = item.ts || null;
  return {
    channelId,
    ts,
    threadTs: message?.thread_ts || null,
    user: message?.user || null,
    state: item.state || null,
    savedAt: item.date_created || null,
    permalink: channelId && ts ? permalinkFor(args.workspace, channelId, ts) : null,
    text: args.includeText
      ? (message?.text || "")
      : "[redacted; rerun with --include-text to save message text]",
  };
}

async function fetchMessage(args, item, call) {
  const result = await call(args, "conversations.history", {
    channel: item.item_id,
    latest: item.ts,
    inclusive: true,
    limit: 1,
  });
  if (!result.json.ok) return { message: null, error: result.json.error || "history_unavailable" };

  const message = (result.json.messages || []).find((entry) => entry.ts === item.ts);
  if (message) return { message, error: null };

  // Saved items can be thread replies, which conversations.history does not return.
  const replies = await call(args, "conversations.replies", {
    channel: item.item_id,
    ts: item.ts,
    oldest: item.ts,
    latest: item.ts,
    inclusive: true,
    limit: 1,
  });
  if (!replies.json.ok) return { message: null, error: replies.json.error || "message_unavailable" };
  return {
    message: (replies.json.messages || []).find((entry) => entry.ts === item.ts) || null,
    error: null,
  };
}

async function run(args, dependencies = {}) {
  const call = dependencies.slackApiCall || slackApiCall;
  const isResultMessage = (item) => item.item_type === "message"
    && (args.includeArchived || item.state !== "archived");
  const items = [];
  let cursor = "";
  let lastResult;

  do {
    const messageCount = items.filter(isResultMessage).length;
    const result = await call(args, "saved.list", {
      limit: Math.min(args.limit - messageCount, 50),
      ...(cursor ? { cursor } : {}),
    });
    lastResult = result;
    if (!result.json.ok) break;

    items.push(...(result.json.saved_items || []));
    cursor = result.json.response_metadata?.next_cursor || "";
  } while (cursor && items.filter(isResultMessage).length < args.limit);

  const json = lastResult.json;
  const messageItems = items.filter(isResultMessage).slice(0, args.limit);
  const hydrated = await Promise.all(messageItems.map(async (item) => {
    try {
      return { item, ...(await fetchMessage(args, item, call)) };
    } catch (error) {
      return { item, message: null, error: error.message || String(error) };
    }
  }));
  return {
    ok: json.ok,
    status: lastResult.response.status,
    error: json.error,
    authSource: lastResult.auth.source,
    includeText: args.includeText,
    includeArchived: args.includeArchived,
    fetchedItemCount: items.length,
    resultCount: hydrated.length,
    results: hydrated.map(({ item, message, error }) => ({
      ...summarizeItem(item, message, args),
      messageAvailable: Boolean(message),
      messageError: error,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.auth = await loadAuth(args);
  console.log(JSON.stringify(await run(args), null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { fetchMessage, parseArgs, run, summarizeItem };
