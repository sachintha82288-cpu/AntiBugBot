# Changelog

All notable changes to AntiBugBot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project speaks
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.0.0 — 2026-10-21

First complete build. The repository was a stub with a README; this is the bot.

### Added

* **Detection core** (`src/core/guard.js`, `measure.js`) — grapheme- and UTF-16-aware
  length counting with a 2,000-character trigger, plus eight payload heuristics:
  invisible-character inflation, Unicode tag blocks, control characters, bidi
  override spam, ZWJ/variation-selector bombs, stacked combining marks, line floods
  and malformed UTF-16. Contact-card (`vcard`) bombs are measured even with no text.
* **Enforcement pipeline** (`src/actions/enforce.js`) — delete-for-me → block →
  report escalation → owner brief, per-number serialised, idempotent, rate limited,
  with a circuit breaker that pauses enforcement under flood.
* **Delete for me** (`delete-for-me.js`) — the real device-side `deleteForMe` app
  patch, plus `revoke-if-able` which tries "delete for everyone" first and falls back.
* **Blocking** (`block.js`) — `updateBlockStatus` deduped against the live WhatsApp
  blocklist, with retries and a skip when the number is already blocked.
* **Report engine** (`report.js`) — capability probe at connect, then `native` /
  `iq` / `bridge` / `evidence` transports; 30 paced submissions; honest accounting;
  machine- and human-readable evidence packets in `data/reports/`.
* **Owner brief** (`core/brief.js`, `actions/notify.js`) — a bilingual (English +
  සිංහල) incident report to your own number with sender, size, signals, timing,
  per-action outcomes, repeat-offender history and the undo command; retries plus an
  `data/outbox/` fallback so no brief is ever lost.
* **Terminal UI** (`src/ui/`) — dependency-free ANSI: banner, config panel, boxed
  inverted QR, pairing-code panel, incident cards, per-action checkmarks, spinners,
  a live status strip, a `CANNOT REACH WHATSAPP` diagnostic and a `NEST CLOSED`
  shutdown summary. Colour auto-detects and honours `NO_COLOR` / `--no-color`;
  a closed pipe can never crash it.
* **CLI** — `start · pair · status · history · blocked · unblock · whitelist · logout
  · selftest`, plus in-WhatsApp commands (`!status`, `!threshold`, `!whitelist`,
  `!unblock`, `!test`).
* **Persistence** (`core/store.js`) — atomic JSON state, append-only `incidents.jsonl`
  ledger, corrupt-file quarantine and recovery, bounded history.
* **Config** (`config.js`) — `.env` + environment + CLI merged with typed validation
  and human-readable errors; local numbers expanded via `COUNTRY_CODE`.
* **Tests** — 97 tests (`node --test`): unit, integration against a fake socket and a
  real HTTP bridge, persistence, config, and CLI subprocess coverage.
* **Tooling** — `npm run check` (syntax + module graph), GitHub Actions matrix on
  Node 20/22 running tests, selftest, observe-mode and config-validation checks.
* **Docs** — README (bilingual quick start, detection table, disk layout, service
  units, troubleshooting), `.env.example`, `SECURITY.md`, `CHANGELOG.md`, MIT licence.
