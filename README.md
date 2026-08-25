# Slack API CLI

A local Slack CLI for fast terminal workflows against the Slack workspace you already use.

This project does not create a Slack app and does not use Slack OAuth. It opens a local browser profile, lets you sign in to Slack normally, extracts the browser session token and cookies, and stores them in a private local auth cache.

## What's New in v0.2.0

- **Slack unread scanning (`mark-read`)** — Fully scan unread conversation history without mutating Slack. Filter out muted conversations with `--exclude-muted`, keep priority channels with `--priority`, and mark one channel as read through an exact timestamp with `--mark`.
- **CLI Doctor (`doctor`)** — A read-only audit of installation, configuration, auth, Slack APIs, and agent-session readiness. Default output is concise for humans; add `--json` for a stable agent-readable report, `--offline` to inspect only local state, or `--strict` to fail on warnings.
- **Agent Sessions (`session`, beta)** — Bridge a Slack thread to a local coding-agent session (tmux, cmux, or Herdr). The listener runs in a standalone pane, keeps all conversation in the bound thread, and delivers responses back to Slack with mrkdwn formatting. Ships with a portable agent skill (see below).
- **Thread inspection (`channel replies`)** — Read a full thread by `--thread-ts` in addition to parent-only `channel history`.
- **Read pagination (`read --max-pages`)** — Cursor-paginated thread reads so long threads are read completely, with incomplete reads reported and exiting nonzero.
- **Secure browser profile permissions** — Tightened permissions on the configured browser profile directory and auth cache.

## Quick Start

Requirement:

- Node.js 20 or newer

Install the CLI:

```sh
npm install -g slack-api-cli
```

Check that the binary is available:

```sh
slack-api --help
```

Run first-time setup:

```sh
slack-api setup
```

When prompted, enter your Slack workspace URL and complete sign-in in the browser:

```text
Tip: In the Slack desktop app, click the workspace name in the top-left menu to find the workspace URL.
Slack workspace URL: https://example.slack.com
Opening Slack in a browser profile...
Authenticated as: alex
```

Validate the cached session:

```sh
slack-api whoami
```

Audit your installation end to end:

```sh
slack-api doctor
```

Search recent messages:

```sh
slack-api search --query "customer escalation" --since 5m
```

List, save, or unsave your bookmarked messages:

```sh
slack-api bookmarks --limit 50 --include-text
slack-api bookmarks --include-archived
slack-api bookmarks add https://example.slack.com/archives/C0123456789/p1778784641394639
slack-api bookmarks remove https://example.slack.com/archives/C0123456789/p1778784641394639
```

The default lists active Slack Later items and redacts message text. The
`--include-archived` option also reads completed and archived Later buckets.
`add` saves a message to Later and `remove` unsaves it (both accept a permalink
or `--link`). On Enterprise Grid the command routes the saved-* calls through
the organization host with the enterprise session token captured by
`slack-api auth --refresh`; run that once after setup so bookmarks is not
rejected as workspace-scoped.

Read your 1:1 DM history with a person:

```sh
slack-api dm history --user "Alice Smith" --include-text
```

Read a message or thread by permalink:

```sh
slack-api read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639'
```

Scan unread conversations, skipping muted ones:

```sh
slack-api mark-read --exclude-muted --priority '#design,#product'
```

## Privacy Defaults

Search and read commands redact message text by default. Add `--include-snippets` or `--include-text` only when you intentionally want message text in terminal output or saved JSON.

Mutating commands are dry-run by default. Commands such as `send`, `reply`, `react`, and `draft` validate what would happen, then require an explicit flag such as `--send`, `--add`, `--remove`, `--create`, or `--delete`.

## Agent Session Skill

The `session` command ships with a portable agent skill that lets a coding agent (Claude Code, Codex, OpenCode, or Pi) start, operate, and stop Slack-backed sessions. It lives in the repository:

```text
.agents/skills/slack-agent-session/
├── SKILL.md
└── agents/
    └── openai.yaml
```

To install it, copy the `slack-agent-session` folder into your agent's skills directory:

```sh
# location varies by agent:
cp -R .agents/skills/slack-agent-session ~/.claude/skills/
# or for project-scoped use:
cp -R .agents/skills/slack-agent-session /path/to/your/project/.claude/skills/
```

Once installed, an agent can respond to requests like "connect this Slack thread to the current terminal" by following `SKILL.md`, which covers recommended defaults, `session start`, `session respond`, collaboration approval, and the hosted-listener flow.

## More Docs

- [Setup and configuration](docs/setup-and-configuration.md)
- [Common commands](docs/common-commands.md)
- [Agent usage](docs/agent-usage.md)
- [Agent sessions](docs/agent-sessions.md)
- [Agent session assessment](docs/agent-session-assessment.md)

## Notes

This CLI depends on Slack's browser behavior and private web API endpoints. It may break when Slack changes its web client, and some workspace policies may restrict specific endpoints.
