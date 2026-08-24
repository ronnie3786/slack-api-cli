#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const COMMANDS = {
  setup: {
    script: "slack-api-setup.cjs",
    summary: "Configure workspace and browser auth.",
    aliases: ["init", "configure"],
  },
  auth: {
    script: "slack-api-auth.cjs",
    summary: "Validate or refresh cached browser credentials.",
  },
  doctor: {
    script: "slack-api-doctor.cjs",
    summary: "Audit installation, configuration, auth, Slack APIs, and agent-session readiness.",
    aliases: ["diagnose", "healthcheck"],
  },
  me: {
    script: "slack-api-me.cjs",
    summary: "Show the signed-in Slack user.",
    aliases: ["whoami", "self"],
  },
  search: {
    script: "slack-api-search.cjs",
    summary: "Search Slack messages.",
    aliases: ["query"],
  },
  bookmarks: {
    script: "slack-api-bookmark.cjs",
    summary: "List your bookmarked messages.",
    aliases: ["saved", "starred"],
  },
  read: {
    script: "slack-api-read.cjs",
    summary: "Read a Slack message or thread.",
    aliases: ["message", "thread"],
  },
  channel: {
    script: "slack-api-channel.cjs",
    summary: "Search channels, inspect info, read history, and list members.",
    aliases: ["channels"],
  },
  dm: {
    script: "slack-api-dm.cjs",
    summary: "Read 1:1 DM history with a user.",
    aliases: ["im", "direct-message"],
  },
  user: {
    script: "slack-api-user.cjs",
    summary: "Search users and read user profiles.",
    aliases: ["users"],
  },
  file: {
    script: "slack-api-file.cjs",
    summary: "Search, read/download, or upload Slack files.",
    aliases: ["files"],
  },
  send: {
    script: "slack-api-send.cjs",
    summary: "Dry-run or post a top-level Slack message.",
    aliases: ["post"],
  },
  draft: {
    script: "slack-api-draft.cjs",
    summary: "Dry-run, create, inspect, or delete Slack drafts.",
    aliases: ["drafts"],
  },
  emoji: {
    script: "slack-api-emoji.cjs",
    summary: "List workspace custom emoji.",
    aliases: ["emojis"],
  },
  reply: {
    script: "slack-api-reply.cjs",
    summary: "Dry-run or post a Slack thread reply.",
    aliases: ["comment"],
  },
  react: {
    script: "slack-api-react.cjs",
    summary: "Dry-run, add, or remove an emoji reaction.",
    aliases: ["reaction"],
  },
  "mark-read": {
    script: "slack-api-mark-read.cjs",
    summary: "Scan unread messages, filter muted conversations, or mark one channel exactly.",
    aliases: ["mark", "unread"],
  },
  session: {
    script: "slack-api-session.cjs",
    summary: "Bridge one Slack thread to a local agent session.",
    aliases: ["sessions", "agent-session"],
  },
};

const ALIASES = Object.fromEntries(
  Object.entries(COMMANDS).flatMap(([command, config]) => (
    [command, ...(config.aliases || [])].map((alias) => [alias, command])
  )),
);

function cliName() {
  const invoked = path.basename(process.argv[1] || "");
  if (!invoked || invoked === "node") return "slack-api";
  if (invoked === "slack-api.cjs") return "./slack-api.cjs";
  return invoked;
}

function printHelp() {
  printShortHelp();
}

function printShortHelp() {
  const cli = cliName();
  console.log(`
Slack API CLI

Usage:
  ${cli} <command> [options]

Commands:
  setup      ${COMMANDS.setup.summary}
  auth       ${COMMANDS.auth.summary}
  doctor     ${COMMANDS.doctor.summary}
  whoami     ${COMMANDS.me.summary} Alias: me
  search     ${COMMANDS.search.summary}
  bookmarks  ${COMMANDS.bookmarks.summary}
  read       ${COMMANDS.read.summary} Alias: thread
  channel    ${COMMANDS.channel.summary}
  dm         ${COMMANDS.dm.summary} Alias: im
  user       ${COMMANDS.user.summary}
  file       ${COMMANDS.file.summary}
  send       ${COMMANDS.send.summary}
  draft      ${COMMANDS.draft.summary}
  emoji      ${COMMANDS.emoji.summary}
  reply      ${COMMANDS.reply.summary}
  react      ${COMMANDS.react.summary}
  mark-read  ${COMMANDS["mark-read"].summary}
  session    ${COMMANDS.session.summary}

Help:
  ${cli} --help
  ${cli} help <command>
  ${cli} <command> --help
  ${cli} agent-help

Examples:
  ${cli} setup
  ${cli} whoami
  ${cli} doctor
  ${cli} doctor --json
  ${cli} search --query "customer escalation" --since 5m
  ${cli} bookmarks --limit 50 --include-text
  ${cli} dm history --user "Alice Smith" --include-text
  ${cli} read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639'
  ${cli} send --channel '#general' --message 'Thanks'
  ${cli} session doctor

Run '${cli} help <command>' for command-specific options and examples.
Run '${cli} agent-help' for agent-oriented operational context.
`);
}

function printAgentHelp() {
  const cli = cliName();
  console.log(`
Agent Help: Direct Slack API CLI

Primary command:
  ${cli} <command> [options]

NPM equivalent:
  npm run api -- <command> [options]

Credential model:
  - This CLI does not use an official Slack app token or OAuth token.
  - Run ${cli} setup once to save your Slack workspace URL and extract Slack's browser API token plus cookies from a signed-in browser session.
  - Normal whoami/search/bookmarks/read/channel/dm/user/file/send/draft create/draft info/emoji/react/reply/session commands use the private auth cache and do not launch Chromium.
  - If the user asks for conversation history with a person, prefer ${cli} dm history --user "Full Name" --include-text.
  - draft delete intentionally launches Chromium to drive Slack's Drafts & sent UI because direct drafts.delete returns team_is_restricted.
  - It does not print token or cookie values.
  - Treat the configured browser profile directory and auth cache file as sensitive session material.
  - If Slack needs login during refresh, rerun ${cli} auth --refresh --headed and complete login.
  - Run ${cli} doctor --json for a read-only, machine-readable installation and API audit before debugging commands individually.

Commands:
  setup
    Configure the Slack workspace URL, browser profile, auth cache, and team id.
    Launches a headed browser by default so the user can sign in.
    Examples:
      ${cli} setup
      ${cli} setup --workspace https://example.slack.com

  auth
    Validate cached browser credentials. Use --refresh to rebuild the cache from the browser profile.
    Example:
      ${cli} auth
      ${cli} auth --refresh

  doctor
    Run a read-only audit of Node/runtime compatibility, installed command files,
    config and credential permissions, browser refresh readiness, cached Slack auth,
    Enterprise routing, account restrictions, unread/mute APIs, conversation listing,
    and local agent-session readiness.
    Default output is concise for humans. Add --json for a stable agent-readable report.
    Add --offline to inspect only local state or --strict to fail on warnings.
    Add --deep for a metadata-only audit of unread conversation coverage.
    Examples:
      ${cli} doctor
      ${cli} doctor --json
      ${cli} doctor --offline --strict
      ${cli} doctor --deep --strict --json

  whoami
    Print the current Slack user's profile plus agent-friendly identifiers.
    Alias: me
    Use search.fromUserId for "me" filters, e.g. from:<@U123456>.
    Examples:
      ${cli} whoami
      ${cli} me --include-raw

  search
    Search Slack messages. Requires --query and defaults to from:me.
    Use --any-author to search all visible authors.
    Message text is redacted by default. Use --include-snippets for full message text.
    Slack's --after/--before date filters are day-level and effectively exclusive.
    For exact recent windows, use local timestamp filtering: --since 30s, --since 5m, --since 12h, or --since-ts / --until-ts.
    Examples:
      ${cli} search --query "customer escalation" --count 50 --since 30s
      ${cli} search --query "incident review" --any-author --count 50 --since 5m --include-snippets
      ${cli} search --raw-query 'from:<@U123456> "customer escalation"' --include-snippets
      ${cli} search --query deploy --count 50 --after 2026-05-13 --before 2026-05-15

  bookmarks
    List your personal bookmarked messages. Message text is redacted by default.
    Archived messages are excluded by default; add --include-archived to show them.
    Examples:
      ${cli} bookmarks
      ${cli} saved --limit 50 --include-text

  read
    Read a message or thread. Prefer --link with a Slack permalink.
    Thread replies are cursor-paginated; incomplete reads return complete: false and exit nonzero.
    Use --max-pages to cap pagination. The default is 20 pages.
    Message text is redacted by default. Use --include-text for full text.
    Alias: thread
    Example:
      ${cli} read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639'
      ${cli} thread --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --include-text

  channel
    Search channels, resolve metadata, read parent-only history or a full thread, and list members.
    channel history does not expand thread replies, even when replyCount is present.
    Use channel replies with --thread-ts for a full thread.
    Once an agent session is bound, prefer read --link with its permalink.
    Examples:
      ${cli} channel search --query platform --limit 10
      ${cli} channel info --channel '#general'
      ${cli} channel history --channel '#general' --since 30m --limit 50 --include-text
      ${cli} channel replies --channel '#general' --thread-ts 1778748406.056539 --include-text
      ${cli} channel members --channel '#general' --limit 100

  dm
    Resolve a user and read your 1:1 DM history with them.
    Uses conversations.open to resolve the DM channel, then conversations.history. It never sends a message.
    Examples:
      ${cli} dm history --user "Alice Smith" --include-text
      ${cli} dm history --email someone@example.com --since 7d --limit 50
      ${cli} dm info --user U123456

  user
    Search users and read profiles.
    Examples:
      ${cli} user search --query alice --limit 10
      ${cli} user profile --name "Alice Smith"
      ${cli} user profile --email someone@example.com
      ${cli} user profile --user U123456

  file
    Search Slack files, read/download file metadata or content, and upload/share local files.
    File upload uses Slack's external upload API, not the retired files.upload endpoint.
    Examples:
      ${cli} file search --query 'budget type:pdfs' --count 20
      ${cli} file read --file F123456
      ${cli} file read --file F123456 --include-content
      ${cli} file upload --channel '#general' --file /tmp/report.pdf --initial-comment 'Report'
      ${cli} file upload --channel '#general' --file /tmp/report.pdf --initial-comment 'Report' --send

  send
    Validate or post a top-level Slack message, optionally with local file attachments.
    Dry-run is default and does not mutate Slack.
    Repeat --attach for multiple files. Per-file --file-title, --file-alt-text, and --snippet-type follow attachment order.
    Add --send to actually post.
    Example:
      ${cli} send --channel '#general' --message 'Testing direct Slack API send'
      ${cli} send --channel '#general' --message 'Testing direct Slack API send' --send
      ${cli} send --channel '#general' --message 'See attached' --attach /tmp/report.pdf
      ${cli} send --channel '#general' --message 'See attached' --attach /tmp/report.pdf --send

  draft
    Validate, create, inspect, or delete Slack draft messages.
    Create/info use Slack's private browser API. Delete drives Slack's Drafts & sent UI because direct drafts.delete returns team_is_restricted.
    Dry-run is default for create/delete and does not mutate Slack.
    Add --create to actually create a draft; add --delete to actually delete a visible draft.
    Example:
      ${cli} draft --channel '#general' --message 'Draft text'
      ${cli} draft --channel '#general' --message 'Draft text' --create
      ${cli} draft info --draft-id D123456
      ${cli} draft delete --channel '#general' --match-text 'Draft text'
      ${cli} draft delete --channel '#general' --match-text 'Draft text' --delete
    Draft deletion launches Chromium with the configured Slack browser profile.

  emoji
    List workspace custom emoji.
    Example:
      ${cli} emoji list --query party --limit 20
      ${cli} emoji list --names-only

  react
    Validate, add, or remove an emoji reaction on a message or thread reply.
    Dry-run is default and does not mutate Slack.
    Add --add to actually add the reaction.
    Add --remove to remove your reaction.
    Example dry-run:
      ${cli} react --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --emoji eyes
    Example add:
      ${cli} react --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --emoji eyes --add
    Example remove:
      ${cli} react --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --emoji eyes --remove

  reply
    Validate or post a thread reply, optionally with local file attachments.
    Dry-run is default and does not mutate Slack.
    Repeat --attach for multiple files. File replies are thread-only because Slack's external upload API does not support reply_broadcast.
    Add --send to actually post.
    Use --message-file for longer content.
    Replies are thread-only by default. Add --also-send-to-channel to broadcast text-only replies.
    File attachment replies use Slack's external upload API and cannot be broadcast with --also-send-to-channel.
    Example dry-run:
      ${cli} reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'API reply dry run'
      ${cli} reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'See attached' --attach /tmp/report.pdf
    Example mutating:
      ${cli} reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'Testing direct Slack API reply' --send
      ${cli} reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'See attached' --attach /tmp/report.pdf --send

  mark-read
    Completely scan unread conversation history without mutating Slack.
    The default all-scan uses users.counts and fetches history only for positive conversation/DM unread counts.
    Add --exclude-muted to read notification preferences once and skip muted conversations before history is fetched.
    Add repeatable --priority ID|NAME values to include selected muted channels anyway.
    Use --scan-all-conversations for a slower read-only diagnostic scan of every joined conversation.
    Output coverage explicitly excludes Slack Activity and thread notifications.
    A scan returns complete: false and exits nonzero if any page or channel could not be read.
    Marking is a separate single-channel operation and requires an exact --through-ts target.
    Use --if-last-read to reject the mark if Slack's cursor changed after the scan.
    A permalink may supply both the channel and exact target timestamp.
    Time filters are display-only and cannot be combined with --mark.
    Example scan (all channels):
      ${cli} mark-read
      ${cli} mark-read --since 30m --include-text
      ${cli} unread --since 7d --exclude-muted --priority '#design,#product'
    Example scan (single channel):
      ${cli} mark-read channel --channel '#general' --include-text
    Example exact mark after a stored/classified scan:
      ${cli} mark-read channel --channel C0123456789 --through-ts 1778784641.394639 --if-last-read 1778784500.000001 --mark
    Example exact mark via permalink:
      ${cli} mark-read channel --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --mark

  session
    Bind a new self-DM Slack thread to a local tmux, cmux, or Herdr agent session.
    A configured profile can launch the listener in a standalone Herdr/cmux pane.
    Sessions are owner-only by default and collaborator input is approval-gated.
    Saved defaults control response delivery; --no-send-responses is a per-run opt-out.
    Session responses use Slack mrkdwn and accept --message, --message-file, or --stdin.
    Examples:
      ${cli} session doctor
      ${cli} session defaults set --channel me --send-responses --provider auto --poll-seconds 3 --headless --host auto
      ${cli} session start
      ${cli} session show --id sess_EXAMPLE --verbose
      ${cli} session restart --id sess_EXAMPLE
      ${cli} session respond --id sess_EXAMPLE --event evt_EXAMPLE --message 'Work complete.' --send

Operational notes:
  - Quote Slack links containing ? or &.
  - Search result ts values are Slack/Unix timestamps in seconds with fractional precision.
  - For "last N seconds/minutes", use search --since rather than Slack date filters.
  - For mutating actions, run the dry-run first unless the user explicitly asked to post/react.
  - Browser refresh may require elevated execution in Codex on macOS due Chromium sandbox/session restrictions.
  - Slack API network calls may also need elevated execution in Codex. Approve the broad slack-api prefix so all subcommands work.
  - If cached auth is missing or rejected, run ${cli} setup or ${cli} auth --refresh --headed once outside the sandbox, then retry.
  - Existing lower-level scripts still work: npm run api:auth, api:me, api:search, api:bookmarks, api:read, api:channel, api:dm, api:user, api:file, api:send, api:draft, api:emoji, api:reply, api:react, api:session.
`);
}

function commandHelp(command) {
  const canonical = ALIASES[command];
  if (!canonical) {
    throw new Error(`Unknown command for help: ${command}`);
  }

  runScript(COMMANDS[canonical].script, ["--help"]);
}

function runScript(script, args) {
  const scriptPath = path.join(__dirname, script);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: __dirname,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exitCode = result.status === null ? 1 : result.status;
}

function main(argv) {
  const [rawCommand, ...args] = argv;
  const command = rawCommand || "help";

  if (command === "help") {
    if (args[0]) commandHelp(args[0]);
    else printShortHelp();
    return;
  }

  if (command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "agent-help" || command === "agent" || command === "context") {
    printAgentHelp();
    return;
  }

  const canonical = ALIASES[command];
  if (!canonical) {
    console.error(`Unknown command: ${command}`);
    printShortHelp();
    process.exitCode = 1;
    return;
  }

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    commandHelp(canonical);
    return;
  }

  runScript(COMMANDS[canonical].script, args);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
