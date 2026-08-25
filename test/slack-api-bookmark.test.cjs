const assert = require("node:assert/strict");
const test = require("node:test");

const {
  exitCodeForOutput,
  fetchSavedItems,
  isHistoricalSavedItem,
  parseArgs,
  run,
  savedFilters,
  withRateLimitRetries,
} = require("../slack-api-bookmark.cjs");

function response(json, status = 200) {
  return {
    response: { status },
    json,
    auth: { source: "cache" },
  };
}

function args(overrides = {}) {
  return {
    ...parseArgs(["--workspace", "https://example.slack.com"]),
    ...overrides,
  };
}

function savedItem(overrides = {}) {
  return {
    item_type: "message",
    item_id: "C123",
    ts: "1000000000.000001",
    state: "in_progress",
    is_archived: false,
    date_created: 1_700_000_000,
    date_completed: 0,
    ...overrides,
  };
}

test("bookmarks requests the production saved filter and redacts hydrated text", async () => {
  const calls = [];
  const output = await run(args({ limit: 1 }), {
    slackApiCall: async (_args, method, params) => {
      calls.push({ method, params });
      if (method === "saved.list") {
        return response({ ok: true, saved_items: [savedItem()] });
      }
      assert.equal(method, "conversations.history");
      return response({
        ok: true,
        messages: [{ ts: params.latest, user: "U123", text: "Saved message" }],
      });
    },
  });

  assert.deepEqual(calls[0], {
    method: "saved.list",
    params: {
      filter: "saved",
      include_tombstones: true,
      limit: 1,
    },
  });
  assert.equal(output.ok, true);
  assert.equal(output.complete, true);
  assert.equal(output.resultCount, 1);
  assert.equal(output.results[0].state, "in_progress");
  assert.equal(output.results[0].isArchived, false);
  assert.equal(output.results[0].text, "[redacted; rerun with --include-text to save message text]");
});

test("bookmarks includes text only when requested", async () => {
  const output = await run(args({ limit: 1, includeText: true }), {
    slackApiCall: async (_args, method) => (method === "saved.list"
      ? response({ ok: true, saved_items: [savedItem()] })
      : response({ ok: true, messages: [{ ts: "1000000000.000001", text: "Saved message" }] })),
  });

  assert.equal(output.results[0].text, "Saved message");
});

test("bookmarks paginates saved items without counting nonmessages or historical races", async () => {
  const listCalls = [];
  const output = await run(args({ limit: 2 }), {
    slackApiCall: async (_args, method, params) => {
      if (method === "conversations.history") {
        return response({ ok: true, messages: [{ ts: params.latest, text: "Current" }] });
      }
      assert.equal(method, "saved.list");
      listCalls.push(params);
      if (!params.cursor) {
        return response({
          ok: true,
          saved_items: [
            { item_type: "file" },
            savedItem(),
            savedItem({
              item_id: "C200",
              ts: "2000000000.000001",
              state: "completed",
              date_completed: 1_700_000_100,
            }),
          ],
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({
        ok: true,
        saved_items: [savedItem({ item_id: "C300", ts: "3000000000.000001" })],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(listCalls.length, 2);
  assert.equal(listCalls[0].limit, 2);
  assert.equal(listCalls[1].limit, 1);
  assert.equal(listCalls[1].cursor, "page-2");
  assert.equal(output.fetchedItemCount, 4);
  assert.deepEqual(output.results.map(({ channelId }) => channelId), ["C123", "C300"]);
});

test("--include-archived reads saved, completed, and archived buckets and deduplicates", async () => {
  const filters = [];
  const duplicate = savedItem();
  const output = await run(args({ includeArchived: true, limit: 10 }), {
    slackApiCall: async (_args, method, params) => {
      if (method === "conversations.history") {
        return response({ ok: true, messages: [{ ts: params.latest, text: params.channel }] });
      }
      filters.push(params.filter);
      if (params.filter === "saved") {
        return response({ ok: true, saved_items: [duplicate] });
      }
      if (params.filter === "completed") {
        return response({
          ok: true,
          saved_items: [
            duplicate,
            savedItem({
              item_id: "C200",
              ts: "2000000000.000001",
              state: "completed",
              date_completed: 1_700_000_100,
            }),
          ],
        });
      }
      return response({
        ok: true,
        saved_items: [savedItem({
          item_id: "C300",
          ts: "3000000000.000001",
          state: "archived",
          is_archived: true,
        })],
      });
    },
  });

  assert.deepEqual(filters, ["saved", "completed", "archived"]);
  assert.deepEqual(savedFilters(args({ includeArchived: true })), filters);
  assert.deepEqual(output.results.map(({ state }) => state), ["in_progress", "completed", "archived"]);
  assert.equal(output.resultCount, 3);
});

test("historical detection accepts production state, archive, and completion fields", () => {
  assert.equal(isHistoricalSavedItem(savedItem({ state: "completed" })), true);
  assert.equal(isHistoricalSavedItem(savedItem({ state: "archived" })), true);
  assert.equal(isHistoricalSavedItem(savedItem({ state: "", is_archived: true })), true);
  assert.equal(isHistoricalSavedItem(savedItem({ state: "", date_completed: 123 })), true);
  assert.equal(isHistoricalSavedItem(savedItem({ state: "in_progress", date_completed: 123 })), false);
});

test("a saved.list API error fails closed, exits nonzero, and skips hydration", async () => {
  const methods = [];
  const output = await run(args(), {
    slackApiCall: async (_args, method) => {
      methods.push(method);
      return response({ ok: false, error: "ratelimited" }, 429);
    },
  });

  assert.deepEqual(methods, ["saved.list"]);
  assert.equal(output.ok, false);
  assert.equal(output.complete, false);
  assert.equal(output.error, "ratelimited");
  assert.equal(output.resultCount, 0);
  assert.equal(exitCodeForOutput(output), 1);
});

test("Enterprise policy failures include an org-session routing hint", async () => {
  const output = await run(args(), {
    slackApiCall: async () => response({ ok: false, error: "team_is_restricted" }),
  });

  assert.match(output.errorHint, /organization-scoped browser session/);
  assert.equal(exitCodeForOutput(output), 1);
});

test("saved pagination fails on a repeated cursor instead of looping", async () => {
  let calls = 0;
  const result = await fetchSavedItems(args({ limit: 2, maxPages: 5 }), async () => {
    calls += 1;
    return response({
      ok: true,
      saved_items: [],
      response_metadata: { next_cursor: "loop" },
    });
  });

  assert.equal(calls, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error, "saved_pagination_stalled");
});

test("saved pagination fails closed when its page cap is reached", async () => {
  const result = await fetchSavedItems(args({ limit: 2, maxPages: 1 }), async () => response({
    ok: true,
    saved_items: [],
    response_metadata: { next_cursor: "page-2" },
  }));

  assert.equal(result.ok, false);
  assert.equal(result.complete, false);
  assert.equal(result.error, "saved_page_limit_reached");
  assert.equal(result.pageCount, 1);
});

test("saved pagination rejects has_more without a cursor", async () => {
  const result = await fetchSavedItems(args({ limit: 2 }), async () => response({
    ok: true,
    saved_items: [],
    has_more: true,
  }));

  assert.equal(result.ok, false);
  assert.equal(result.error, "saved_next_cursor_missing");
});

test("saved pagination rejects a successful response without a saved-items array", async () => {
  const result = await fetchSavedItems(args(), async () => response({ ok: true }));

  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_saved_items_response");
});

test("saved pagination rejects message items without a channel or timestamp", async () => {
  for (const item of [
    { item_type: "message", ts: "1000000000.000001" },
    { item_type: "message", item_id: "C123" },
    { item_type: "message", item_id: 123, ts: "1000000000.000001" },
    { item_type: "message", item_id: "C123", ts: { bad: true } },
  ]) {
    const result = await fetchSavedItems(args(), async () => response({
      ok: true,
      saved_items: [item],
    }));

    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_saved_message_item");
  }
});

test("a thrown saved-list transport error returns structured incomplete output", async () => {
  const output = await run(args(), {
    slackApiCall: async () => {
      throw new Error("request timed out");
    },
  });

  assert.equal(output.ok, false);
  assert.equal(output.complete, false);
  assert.equal(output.error, "request timed out");
  assert.equal(output.pageCount, 1);
  assert.equal(exitCodeForOutput(output), 1);
});

test("unqueried historical filters are reported as truncation, not resumable pagination", async () => {
  const result = await fetchSavedItems(args({ includeArchived: true, limit: 1 }), async () => response({
    ok: true,
    saved_items: [savedItem()],
    response_metadata: { next_cursor: "" },
  }));

  assert.equal(result.hasMore, false);
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, "");
  assert.deepEqual(result.remainingFilters, ["completed", "archived"]);
});

test("message hydration retries Slack rate limits using Retry-After", async () => {
  const waits = [];
  let calls = 0;
  const call = withRateLimitRetries(async () => {
    calls += 1;
    if (calls === 1) {
      return {
        ...response({ ok: false, error: "ratelimited" }, 429),
        response: {
          status: 429,
          headers: { get: (name) => (name === "retry-after" ? "2" : null) },
        },
      };
    }
    return response({ ok: true, messages: [] });
  }, {
    maxRetries: 2,
    sleep: async (ms) => waits.push(ms),
  });

  const result = await call();
  assert.equal(result.json.ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2_000]);
});

test("hydration concurrency is bounded and result ordering stays stable", async () => {
  const items = Array.from({ length: 6 }, (_, index) => savedItem({
    item_id: `C${index}`,
    ts: `100000000${index}.000001`,
  }));
  let active = 0;
  let peak = 0;
  const output = await run(args({ limit: items.length }), {
    hydrationConcurrency: 2,
    slackApiCall: async (_args, method, params) => {
      if (method === "saved.list") return response({ ok: true, saved_items: items });
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return response({ ok: true, messages: [{ ts: params.latest, text: params.channel }] });
    },
  });

  assert.equal(peak, 2);
  assert.deepEqual(output.results.map(({ channelId }) => channelId), items.map(({ item_id }) => item_id));
});

test("bookmarks resolves a reply root and preserves Slack's canonical permalink", async () => {
  const canonical = "https://example.slack.com/archives/C123/p1000000000000002?thread_ts=1000000000.000001&cid=C123";
  const methods = [];
  const output = await run(args({ limit: 1, includeText: true }), {
    slackApiCall: async (_args, method, params) => {
      methods.push(method);
      if (method === "saved.list") {
        return response({ ok: true, saved_items: [savedItem({ ts: "1000000000.000002" })] });
      }
      if (method === "conversations.history") {
        return response({ ok: true, messages: [{ ts: "1000000000.000001", text: "Parent" }] });
      }
      if (method === "chat.getPermalink") {
        assert.equal(params.message_ts, "1000000000.000002");
        return response({ ok: true, permalink: canonical });
      }
      assert.equal(method, "conversations.replies");
      assert.equal(params.ts, "1000000000.000001");
      assert.equal(params.oldest, "1000000000.000002");
      assert.equal(params.latest, "1000000000.000002");
      return response({
        ok: true,
        messages: [
          { ts: "1000000000.000001", text: "Parent" },
          {
            ts: "1000000000.000002",
            thread_ts: "1000000000.000001",
            text: "Saved reply",
          },
        ],
      });
    },
  });

  assert.deepEqual(methods, [
    "saved.list",
    "conversations.history",
    "chat.getPermalink",
    "conversations.replies",
  ]);
  assert.equal(output.results[0].messageAvailable, true);
  assert.equal(output.results[0].text, "Saved reply");
  assert.equal(output.results[0].threadTs, "1000000000.000001");
  assert.equal(output.results[0].permalink, canonical);
});

test("a per-item hydration failure remains visible without discarding the list", async () => {
  const output = await run(args({ limit: 1 }), {
    slackApiCall: async (_args, method) => {
      if (method === "saved.list") return response({ ok: true, saved_items: [savedItem()] });
      throw new Error("fetch failed");
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.complete, false);
  assert.equal(output.error, "partial_message_hydration");
  assert.equal(output.hydrationErrorCount, 1);
  assert.equal(output.results[0].messageAvailable, false);
  assert.equal(output.results[0].messageError, "fetch failed");
  assert.equal(exitCodeForOutput(output), 1);
});

test("argument parsing accepts a page cap and rejects invalid values", () => {
  assert.equal(parseArgs(["--max-pages", "4"]).maxPages, 4);
  assert.throws(() => parseArgs(["--max-pages", "0"]), /--max-pages must be an integer >= 1/);
});
