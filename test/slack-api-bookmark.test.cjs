const assert = require("node:assert/strict");
const test = require("node:test");

const { parseArgs, run } = require("../slack-api-bookmark.cjs");

function response(json) {
  return {
    response: { status: 200 },
    json,
    auth: { source: "cache" },
  };
}

test("bookmarks paginates saved items and hydrates saved messages", async () => {
  const calls = [];
  const args = parseArgs(["--workspace", "https://example.slack.com", "--limit", "2"]);
  const output = await run(args, {
    slackApiCall: async (_args, method, params) => {
      if (method === "conversations.history") {
        return response({
          ok: true,
          messages: [{ ts: params.latest, user: "U123", text: params.latest === "100.000001" ? "First" : "Second" }],
        });
      }
      assert.equal(method, "saved.list");
      calls.push(params);
      if (!params.cursor) {
        return response({
          ok: true,
          saved_items: [{ item_type: "file" }, { item_type: "message", item_id: "C123", ts: "100.000001" }],
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({
        ok: true,
        saved_items: [{ item_type: "message", item_id: "C234", ts: "200.000002" }],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].limit, 2);
  assert.equal(calls[1].limit, 1);
  assert.equal(calls[1].cursor, "page-2");
  assert.equal(output.fetchedItemCount, 3);
  assert.equal(output.resultCount, 2);
  assert.equal(output.results[0].text, "[redacted; rerun with --include-text to save message text]");
  assert.equal(output.results[0].messageAvailable, true);
  assert.equal(output.results[0].permalink, "https://example.slack.com/archives/C123/p100000001");
});

test("bookmarks includes text only when requested", async () => {
  const args = parseArgs(["--workspace", "https://example.slack.com", "--include-text"]);
  const output = await run(args, {
    slackApiCall: async (_args, method) => (method === "saved.list"
      ? response({ ok: true, saved_items: [{ item_type: "message", item_id: "C123", ts: "100.000001" }] })
      : response({ ok: true, messages: [{ ts: "100.000001", text: "Saved message" }] })),
  });

  assert.equal(output.results[0].text, "Saved message");
});

test("bookmarks caps each saved-list request at Slack's 50-item maximum", async () => {
  const args = parseArgs(["--workspace", "https://example.slack.com"]);
  let params;
  await run(args, {
    slackApiCall: async (_args, method, requestParams) => {
      if (method === "saved.list") {
        params = requestParams;
        return response({ ok: true, saved_items: [] });
      }
      throw new Error("Unexpected message hydration request");
    },
  });

  assert.equal(params.limit, 50);
});

test("bookmarks excludes archived saved messages unless requested", async () => {
  const call = async (_args, method) => (method === "saved.list"
    ? response({
      ok: true,
      saved_items: [
        { item_type: "message", item_id: "C123", ts: "100.000001", state: "in_progress" },
        { item_type: "message", item_id: "C234", ts: "200.000002", state: "archived" },
      ],
    })
    : response({ ok: true, messages: [{ ts: "100.000001", text: "Current" }] }));

  const defaultOutput = await run(parseArgs(["--workspace", "https://example.slack.com"]), { slackApiCall: call });
  assert.equal(defaultOutput.resultCount, 1);
  assert.equal(defaultOutput.results[0].state, "in_progress");

  const archivedOutput = await run(parseArgs([
    "--workspace", "https://example.slack.com", "--include-archived",
  ]), { slackApiCall: call });
  assert.equal(archivedOutput.resultCount, 2);
});

test("bookmarks does not count archived messages toward --limit while paginating", async () => {
  const calls = [];
  const args = parseArgs(["--workspace", "https://example.slack.com", "--limit", "2"]);
  const output = await run(args, {
    slackApiCall: async (_args, method, params) => {
      if (method === "conversations.history") {
        return response({ ok: true, messages: [{ ts: params.latest, text: "Current" }] });
      }
      assert.equal(method, "saved.list");
      calls.push(params);
      if (!params.cursor) {
        return response({
          ok: true,
          saved_items: [
            { item_type: "message", item_id: "C123", ts: "100.000001" },
            { item_type: "message", item_id: "C234", ts: "200.000002", state: "archived" },
          ],
          response_metadata: { next_cursor: "page-2" },
        });
      }
      return response({
        ok: true,
        saved_items: [{ item_type: "message", item_id: "C345", ts: "300.000003" }],
        response_metadata: { next_cursor: "" },
      });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].limit, 2);
  assert.equal(calls[1].limit, 1);
  assert.deepEqual(output.results.map(({ ts }) => ts), ["100.000001", "300.000003"]);
});

test("bookmarks reports a network failure as a per-item error instead of failing the run", async () => {
  const args = parseArgs(["--workspace", "https://example.slack.com"]);
  const output = await run(args, {
    slackApiCall: async (_args, method, params) => {
      if (method === "saved.list") {
        return response({
          ok: true,
          saved_items: [
            { item_type: "message", item_id: "C123", ts: "100.000001" },
            { item_type: "message", item_id: "C234", ts: "200.000002" },
          ],
        });
      }
      if (params.channel === "C123") throw new Error("fetch failed");
      return response({ ok: true, messages: [{ ts: "200.000002", text: "Second" }] });
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.resultCount, 2);
  assert.equal(output.results[0].messageAvailable, false);
  assert.equal(output.results[0].messageError, "fetch failed");
  assert.equal(output.results[1].messageAvailable, true);
});

test("bookmarks hydrates saved thread replies via conversations.replies", async () => {
  const args = parseArgs(["--workspace", "https://example.slack.com", "--include-text"]);
  const output = await run(args, {
    slackApiCall: async (_args, method, params) => {
      if (method === "saved.list") {
        return response({
          ok: true,
          saved_items: [{ item_type: "message", item_id: "C123", ts: "100.000002" }],
        });
      }
      if (method === "conversations.history") {
        return response({ ok: true, messages: [{ ts: "100.000001", text: "Parent" }] });
      }
      assert.equal(method, "conversations.replies");
      assert.equal(params.ts, "100.000002");
      return response({
        ok: true,
        messages: [{ ts: "100.000002", thread_ts: "100.000001", text: "Saved reply" }],
      });
    },
  });

  assert.equal(output.resultCount, 1);
  assert.equal(output.results[0].messageAvailable, true);
  assert.equal(output.results[0].text, "Saved reply");
  assert.equal(output.results[0].threadTs, "100.000001");
});
