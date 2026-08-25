# Changelog

## [Unreleased]

### New: Bookmarks (`bookmarks`)

- List, save, or unsave messages from Slack Later.
- Message text is redacted by default; `--include-text` opts in.
- Active items are listed by default; `--include-archived` also reads completed and archived Later buckets.
- `bookmarks add <permalink>` saves a message to Later; `bookmarks remove <permalink>` unsaves it. Both accept a permalink positionally or via `--link` (or `--channel` + `--ts`), and `--dry-run` previews without changing anything. Idempotent: re-saving and removing a never-saved item both succeed.
- Aliases: `saved`, `starred`.
- On Enterprise Grid, saved-* calls route through the organization host (`<team>.enterprise.slack.com`) using the enterprise session token captured by `slack-api auth --refresh`, so bookmarks works with an organization-scoped session.

### New: Slack unread scanning (`mark-read`)

- Fully scan unread conversation and DM history without mutating Slack.
- `--exclude-muted` skips muted conversations (reads notification preferences once before history is fetched).
- Repeatable `--priority` keeps selected muted channels in the scan.
- `--mark` marks a single channel as read through an exact `--through-ts` timestamp, optionally guarded by `--if-last-read`.
- `--scan-all-conversations` is a slower read-only diagnostic scan of every joined conversation.
- Incomplete scans exit nonzero with `complete: false`.

### New: CLI Doctor (`doctor`)

- Read-only audit of Node/runtime compatibility, installed command files, config and credential permissions, browser refresh readiness, cached Slack auth, Enterprise routing, account restrictions, unread/mute APIs, conversation listing, and agent-session readiness.
- `--json` for a stable agent-readable report; `--offline` to inspect only local state; `--strict` to fail on warnings; `--deep` for a metadata-only audit of unread conversation coverage.

### New: Agent Sessions (`session`, beta)

- Bridge one Slack thread to a local coding-agent session (tmux, cmux, or Herdr).
- Standalone hosted listener keeps polling and logs in its own pane.
- Owner-only by default; collaborator input is approval-gated.
- Saved defaults control response delivery; `--no-send-responses` opts out per run.
- Ships with a portable agent skill under `.agents/skills/slack-agent-session/`.

### New: Full thread inspection

- `channel replies --channel ID --thread-ts TS` reads a full thread (previously parent-only history).

### Improved: read pagination

- `read --link` now cursor-paginates thread replies with a `--max-pages` cap (default 20).
- Incomplete reads report `complete: false` and exit nonzero.

### Improved: security

- Browser profile directory and auth cache permissions tightened.

## [0.1.1] - 2026-05-27

- Fix Slack browser auth setup flow error handling.
- Normalize npm bin path across installs.
- Ignore generated npm tarballs.

## [0.1.0] - 2026-05-27

- Initial open source release: browser-session auth, search, read, channel, DM, user, file, send (dry-run), draft, emoji, reply, react.
