# Common Commands

## Diagnose

Audit the full CLI installation and its safe read-only Slack API dependencies:

```sh
slack-api doctor
slack-api doctor --json
slack-api doctor --offline --strict
slack-api doctor --deep --strict --json
```

Human-readable output is the default. `--json` returns a versioned report with
stable check IDs, statuses, remediation, safety guarantees, and exit semantics
for coding agents. `--deep` performs a metadata-only coverage audit of positive
unread conversations. It does not fetch message history or mutate Slack.

## Search

Search your own messages from the last five minutes:

```sh
slack-api search --query "customer escalation" --since 5m
```

Search all visible authors and include message text:

```sh
slack-api search --query "incident review" --any-author --count 20 --include-snippets
```

Pass Slack-native search modifiers through directly:

```sh
slack-api search --raw-query 'from:<@U123456> "customer escalation"' --include-snippets
```

## Read

Read a message or thread by permalink:

```sh
slack-api read --link 'https://example.slack.com/archives/C0123456789/p1778784641394639'
slack-api thread --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --include-text
```

`slack-api read --link` is the canonical way to inspect a bound agent-session
thread.

## Bookmarks

List your bookmarked messages. Message text is redacted by default:

```sh
slack-api bookmarks
slack-api saved --limit 50 --include-text
slack-api bookmarks --include-archived
```

## Direct Messages

Read your 1:1 DM history with a user:

```sh
slack-api dm history --user "Alice Smith" --include-text
slack-api dm history --email alice@example.com --since 7d --limit 50
```

Resolve the DM channel without reading messages:

```sh
slack-api dm info --user U123456
```

## Unread Conversations

Scan unread conversation and DM timelines while skipping muted conversations:

```sh
slack-api unread --since 7d --exclude-muted
```

Always include selected muted channels by name or ID:

```sh
slack-api unread --since 7d --exclude-muted \
  --priority '#design,#product' \
  --priority C0123456789
```

Muted conversations are included unless `--exclude-muted` is present. These
read-only scans cover conversation and DM timeline unread state, not Slack
Activity or thread notifications. An exclude-muted scan fails closed before
history if Slack does not return a recognized mute-preference source.

## Channels

Resolve channels and read recent history:

```sh
slack-api channel search --query general
slack-api channel info --channel '#general'
slack-api channel history --channel '#general' --since 30m --limit 50
```

Channel history contains parent/channel-history messages only. It can report a
parent's `replyCount`, but it does not expand the replies. Fetch the complete
thread with:

```sh
slack-api channel replies --channel '#general' --thread-ts 1778748406.056539 --include-text
```

## Users

Search users and read profiles:

```sh
slack-api user search --query alice --limit 10
slack-api user profile --name "Alice Smith"
slack-api user profile --email someone@example.com
```

## Messages

Validate or post a message:

```sh
slack-api send --channel '#general' --message 'Thanks'
slack-api send --channel '#general' --message 'Thanks' --send
```

Validate or post a thread reply:

```sh
slack-api reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'Thanks'
slack-api reply --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --message 'Thanks' --send
```

## Reactions

Validate or add a reaction:

```sh
slack-api react --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --emoji eyes
slack-api react --link 'https://example.slack.com/archives/C0123456789/p1778784641394639' --emoji eyes --add
```

## Files

Search, read, and upload files:

```sh
slack-api file search --query 'budget type:pdfs' --count 20
slack-api file read --file F123456
slack-api file upload --channel '#general' --file /tmp/report.pdf --initial-comment 'Report'
slack-api file upload --channel '#general' --file /tmp/report.pdf --initial-comment 'Report' --send
```

## Emoji

List custom emoji:

```sh
slack-api emoji list --query party --limit 20
slack-api emoji list --names-only
```

## Agent Sessions

Configure the recommended self-DM and standalone-host profile once:

```sh
slack-api session defaults set \
  --channel me \
  --send-responses \
  --provider auto \
  --poll-seconds 3 \
  --headless \
  --host auto
slack-api session defaults show
```

Check provider/host readiness and start the bridge:

```sh
slack-api session doctor
slack-api session start
```

The bare start uses the saved self-DM destination and `host=auto`. The explicit
hosted equivalent is `slack-api session start --host auto`; `--self`, `--channel`,
and `--link` are destination overrides. Start output includes the channel, direct
permalink, root timestamp, owner/author, effective defaults, provider target,
attached worktree/agent session, standalone host, phase timings, and a Slack
refresh hint.

Each actionable reply arrives as one physical
`# [SLACK_AGENT_SESSION_EVENT v1]` line with a shell-safety prefix, an
event/correlation ID, and response routing metadata. Quick work transitions from
`:eyes:` to
`:white_check_mark:`. Work open after 30 seconds, or explicitly marked in progress,
transitions through `:hourglass_flowing_sand:`. The expected
`outbound_delivery_observed` record quarantines the agent's own reply and requires
no action.

If `show` or `events` reports an inbound injection as `claimed` or `uncertain`,
do not replay, re-approve, rewind, or respond to that event. Inspect its redacted
attempt metadata, then stop the Slack session and restart the coding-agent session
before asking for a fresh Slack message when the terminal outcome is unclear.

Response delivery to a running listener first authenticates the exact runtime PID,
instance, and loopback bridge with a credential-free nonce challenge. A stale or
reused port receives no token or response body; restart the session after a failed
preflight rather than forcing a direct retry.

Inspect and control it:

```sh
slack-api session list
slack-api session list --active
slack-api session show --id sess_EXAMPLE --verbose
slack-api session events --id sess_EXAMPLE --limit 200
slack-api session pause --id sess_EXAMPLE
slack-api session resume --id sess_EXAMPLE
slack-api session stop --id sess_EXAMPLE
slack-api session restart --id sess_EXAMPLE
```

`session list` exposes active worktrees, attached agent sessions, injection
providers, host panes, and redacted last-sent/last-received metadata. Verbose show
separates listener cursor progress from successful injection and includes startup,
acknowledgment, and first-response timings. Stop closes only the host owned by the
session; `stop --keep-host` deliberately leaves that pane open. Restart preserves
the Slack and agent binding. Use `restart --host auto|herdr|cmux|process` to replace
the saved host policy, or `restart --keep-host` to reuse the exact verified open
Herdr/cmux pane.

Run the Slack-free end-to-end simulation:

```sh
npm run session:demo
```
