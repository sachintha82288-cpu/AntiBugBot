# AntiBugBot

Protective WhatsApp guard for Pterodactyl (Node.js). It screens **inbound** traffic
for crash-bot / "text bomb" payloads and rate-limits the floods that carry them.

It is defensive by construction: **no sending, no forwarding, no payload
generation, no payload storage.** See [Scope](#scope-what-this-project-will-not-do).

```
inbound message ──► normalize ──► structural screen ──► decide ──► apply (delete/restrict/log)
                       │                 │                │
                       │            bounded scan      redacted audit
                       │            (≤ scanWindow)        │
                       └──────── fingerprint only ──► quarantine
```

## Status

| area | state |
|---|---|
| `src/core/detector.js` structural screen | ✅ implemented + tested (14 tests) |
| `src/core/redact.js` log redaction | ✅ implemented + `npm run selfcheck:redact` |
| `src/core/limits.js` flood/burst/strikes | ✅ implemented + tested |
| `src/core/policy.js` decision ladder | ✅ implemented + tested |
| `src/core/quarantine.js` fingerprint store | ✅ implemented + tested |
| provider adapter (Baileys) | ⬜ not written yet — see `src/core/adapters/README.md` |
| group/DM enforcement transport | ⬜ depends on adapter |
| media (doc/pdf/image) screening | ⬜ planned |

Run everything: `npm test && npm run fuzz && npm run selfcheck:redact`

## Threat model (what we are actually defending against)

Reported behaviour of the "bug bot" family circulating as free zips:

1. **Renderer exhaustion.** Strings built from large runs of combining marks,
   variation selectors and joiners. A text shaper resolves these superlinearly, so
   the victim cost is CPU/battery, and the visible artefact is WhatsApp (and on
   weak/old devices, the UI or the whole handset) freezing or force-closing.
   Repeated hard resets on cheap devices can corrupt app data — that is the real
   "phone damage", not a burned component. **Mitigation: never render, never store
   raw, delete before display.**
2. **Flood.** Thousands of messages per hour to scraped/numbered contacts.
   **Mitigation: rate limits + opt-in intake. Volume is often a stronger signal
   than content.**
3. **Reordering controls / invisible chars** used to spoof, hide, or smuggle.
4. **Media-carried variants** (crafted document/image) — the reason content-only
   filtering is not enough, and why `autoDownload` must be off.

## The load-bearing design fact

**A bot that filters after WhatsApp delivers the message does not protect the phone.**
Group-admin bots revoke messages *after* clients have already received and rendered
them. So protection is layered, and the bot is only one layer:

| layer | where | stops renderer exhaustion? |
|---|---|---|
| **1. Intake lockdown** | WhatsApp → Settings → Privacy → Groups: *Nobody*; enable *approve new participants*; Settings → Storage → **auto-download off** | **yes — the only reliable one** |
| 2. Sender trust | this bot: unknown-number DMs dropped before render | yes, for the bot's own session |
| 3. Structural screen | this bot: `analyzeText()` | protects the bot/panel and any client that reads through it |
| 4. Delete + restrict | this bot, in groups where it is admin | limits exposure of *other* members going forward |
| 5. Account hygiene | Meta: report + block; `payload@meta.com` for the sample | removes the attacker's accounts |

Layer 1 is configuration, not code — ship it as onboarding text. A guard that only
implements 3–4 and claims to save phones is selling what those bots sell.

## Why this project does not read the bots' code

The claim tested: *"without the bots' source you cannot detect their payloads."*
`npm run fuzz` measures it. A fuzzer generates thousands of payload *shapes* from
Unicode structural classes (no real sample needed), then compares two detectors
against shapes neither has seen:

```
┌──────────────────────────────────────────────┬─────────┬──────┐
│ detector                                     │ recall  │ fpr  │
├──────────────────────────────────────────────┼─────────┼──────┤
│ signature/blocklist (needs their code)       │  0.2%   │ 0.0% │
│ structural screen (this repo)                │ 93.4%   │ 0.0% │
└──────────────────────────────────────────────┴─────────┴──────┘
```

Matching exact strings copied out of someone's zip is nearly worthless here,
because these tools ship versioned and mangled on purpose (`Paxley Version 13`,
`ONESPACE_V18` — the names are the admission): every release changes the byte
sequence, never the *structural class*, since the class is what makes the phone
freeze. The ~7% the screen misses are low-intensity shapes from my own generator
that would not exhaust a shaper in the first place — tightening thresholds to
catch a synthetic tail is how you start eating legitimate Sinhala/Thai/Arabic text
(PUA and combining marks occur in real fonts and scripts). That is the honest
tradeoff, and it is why the policy escalates on **volume + trust + structure**,
not on a payload fingerprint.

## Scope: what this project will not do

- No code path that sends, forwards, or repeats attacker content — including "for
  testing". No reply ever quotes a payload.
- No storage of raw payload text or media anywhere: not in `data/`, not in stdout,
  not in git, not in test fixtures. `test/*.js` builds tiny synthetic shapes through
  `String.fromCodePoint()` and asserts quarantine files contain zero hostile chars.
- No "blast N numbers" feature, and no borrowed sender lists.
- Third-party zip samples are **escalated, not vendored**: report in WhatsApp,
  forward to `payload@meta.com`, then keep only a fingerprint.

## Modules

| file | responsibility |
|---|---|
| `src/core/unicode-ranges.js` | classify code points by structural class — no generators |
| `src/core/detector.js` | `analyzeText()`: bounded scan, weighted scores, `clean/suspect/hostile`, hard-defect ladder |
| `src/core/redact.js` | the only sanctioned way to surface content; collapses hostile runs to `⋮` markers |
| `src/core/limits.js` | `SlidingWindow`, `TokenBucket`, `Strikes` — time injected for testability |
| `src/core/policy.js` | `decide()` ladder `allow→log→warn→delete→restrict→mute→cooldown→block` |
| `src/core/guard.js` | orchestration: screen every event, never echo, never re-render |
| `src/core/quarantine.js` | fingerprint JSONL per day, 30-day purge, `summary()` for triage |
| `src/core/config.js` | defaults < `antibugbot.config.json` < `ABB_*` env (Egg-tunable) |

Two invariants worth reading before you change anything:

1. **Bounded work.** Only `scanWindow` (≤200k) code points are ever analysed, so a
   10 MB message costs the same as a 100 byte one. A defender must not be
   DoS-able by the input it inspects.
2. **No lossy normalisation before counting.** `Array.from()` rewrites lone
   surrogates into U+FFFD and erases the signal — the screen walks raw UTF-16
   units and decodes pairs itself. (Both were real bugs caught by the test suite.)

## Configuration

`antibugbot.config.json` (see `src/core/config.js` for defaults), or env:

```bash
ABB_FLOOD__MSGS_PER_MIN=6 ABB_NOTICES__LANG=si ABB_QUARANTINE__DIR=/home/egg/data/q
```

## Pterodactyl notes

- Node 22 Egg, `npm ci --omit=dev`, start `node src/index.js`. Zero runtime deps in
  `src/core`; only the adapter pulls one.
- Container is non-root, no display server → Baileys (socket) fits; Puppeteer-based
  libraries need Xvfb and eat the disk quota.
- Pair with WhatsApp **Linked devices → Link with phone number** (pair code), so no
  QR has to be rendered in a terminal.
- Persist only `data/` (auth state + quarantine) inside the 1 GB disk quota; the
  auth key file is a credential — `chmod 600`, never committed.
- `guard.maintenance()` on an interval; bounded maps matter for a process that is
  expected to live for weeks.
- Panel logs are HTML: every log line goes through `redact()` for this reason.

## Roadmap

1. Baileys adapter + `evt` normaliser, with `delete`/`restrict` degrading to `log`
   when the bot is not group admin.
2. Media structure screening (bounded, magic-byte + structural), with a corpus of
   *malformed* inputs generated locally.
3. Rule pack: hot-reloadable class-based rules so thresholds can be tuned without
   redeploying — never payload strings.
4. Onboarding card with the layer-1 settings, in si + en.
5. Report pack: one command to produce the redacted fingerprint record for Meta.
