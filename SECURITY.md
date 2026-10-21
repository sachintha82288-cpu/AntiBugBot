# Security policy

AntiBugBot is a defensive tool: it protects one WhatsApp account — yours — from
crash-payload messages. This page covers the bot's own security posture and how to
report a problem with it.

## What the bot touches, and where it goes

| Data | Stored | Notes |
|---|---|---|
| Session keys (`auth/`) | on disk, plaintext | equivalent to being logged in on a linked device. Treat as a password: never commit, never share, `chmod -R go-rwx auth` |
| Message bodies | **never stored** | the ledger keeps measurements plus a sanitised excerpt of at most 160 characters |
| Invisible characters | replaced | zero-width/bidi codes are rendered as `·` in every preview and packet |
| Incident briefs | WhatsApp chat + `data/` | the chat copy lives on your phone; disk copy in `data/state.json`, `data/incidents.jsonl`, `data/reports/` |
| Media | never downloaded | text and captions are read from the message envelope only |
| Network | WhatsApp servers only | no telemetry, no analytics, no third-party calls unless *you* set `WA_BRIDGE_URL` |

## Design choices that reduce risk

* **Minimal dependency surface.** Two runtime dependencies, pinned exactly, no
  postinstall scripts (`npm ci --ignore-scripts` is clean in CI).
* **Fail-open for the human, fail-closed for the account.** A bug in any single
  action (delete, block, report, alert) cannot crash the process and cannot stop the
  others. Enforcement pauses itself under flood via the circuit breaker and the
  per-minute action budget.
* **No optimistic accounting.** `filed` counts only submissions a transport accepted.
  The bot never claims a report happened when it did not.
* **Nothing inbound is trusted.** Lengths, control characters and malformed UTF-16 are
  measured, not parsed. Message text is never passed to a shell, never `eval`d, never
  used to build a path, and never written unescaped outside a JSON string.
* **State writes are atomic.** `state.json.tmp` → `rename`, so a crash mid-write
  cannot leave a corrupt ledger. A corrupt file is quarantined and rebuilt.

## If your number is the one getting flagged

Reporting at scale from an unofficial client can look like abuse *from you*. If you
see `429`/`500` disconnects, an in-app "your account may be at risk" warning, or a
ban notice:

1. Stop the bot (`Ctrl+C`) and let the cooldown pass.
2. Lower `MAX_ACTIONS_PER_MINUTE`, raise `REPORT_MIN_INTERVAL_MS`, or set
   `REPORT_CHANNEL=evidence` so no traffic is generated per incident at all.
3. Consider `SHIELD_MODE=observe`: detection and alerting only, no enforcement.
4. Keep block and delete-on-me on — those two are what actually stop the crash.

## Reporting a vulnerability

Open a [draft advisory](https://github.com/sachintha82288-cpu/AntiBugBot/security/advisories/new)
or an issue if the problem is not exploitable. Please avoid public disclosure until a
fix ships. Include the output of `node src/index.js selftest`, your Node version
(`node -v`) and the exact AntiBugBot version — and never paste a real session
credential or an `auth/` file into a report.
