# 🛡 AntiBugBot

**A WhatsApp crash-bug shield that eats the attack before your phone can.**

Someone sends you a 3,000-character message full of invisible characters and your
WhatsApp — or the whole phone — freezes, reboots, or force-closes. That is a
well-known "bug bot" attack. AntiBugBot sits on your account as a linked device,
inspects every incoming message **before your client has to render it**, and
neutralises the ones that match the attack profile.

```
message longer than 2,000 characters arrives
   ↓
① deleted for me      — gone from your phone and every linked device
② sender blocked      — they cannot message you again
③ 30× report escalation — real submissions where a transport exists, evidence packet always
④ brief to your own number — exactly what happened, who did it, what was done
```

---

## Quick start · ඉක්මනට පටන් ගන්න

```bash
git clone https://github.com/sachintha82288-cpu/AntiBugBot.git
cd AntiBugBot
npm install
cp .env.example .env        # optional — the defaults already do the job
npm start                   # prints a QR code
```

Scan: **WhatsApp → Settings → Linked devices → Link a device**.

No QR handy? Use a pairing code instead:

```bash
npm run pair -- --number 0771234567
```

That is it. The bot is now watching. Send yourself a 2,100-character message from
another number and watch the whole pipeline fire.

<details>
<summary><b>සිංහල — කෙටි විදිහ</b></summary>

1. `npm install` කරන්න.
2. `npm start` දුන්නාම Terminal එකේ QR එකක් එනවා.
3. ඔයාගේ ඕනෑම ෆෝන් එකකින්: **WhatsApp → Settings → Linked devices → Link a device** → QR එක scan කරන්න.
4. දැන් bot එක වැඩ කරනවා. කෙනෙක් අකුරු **2,000ට** වැඩි මැසේජ් එකක් එව්වොත්:
   * එතනම මැසේජ් එක **delete for me** වලින් ඉවත් කරනවා (ඔයාගේ ෆෝන් එකේයි linked devices වලයි),
   * ඒ අංකය **block** කරනවා,
   * **30 වතාවක් report** කරන්න උත්සාහ කරනවා (එව්වෙන්න පුළුවන් විදිහට),
   * ඔයාගේම number එකට **මොකද වුණේ කියලා සම්පූර්ණ brief එකක්** එවනවා.
5. නවත්තන්න `Ctrl + C`.
6. වැඩ කරන විදිහ පරීක්ෂා කරන්න: `npm run selftest` (ෆෝන් එකක් අවශ්‍ය නැත)

</details>

---

## What "high quality" means here

* **Nothing is faked.** If a step could not actually be performed, the terminal and
  the owner brief both say so, with the reason. `filed` only ever counts submissions
  the transport accepted.
* **The phone is protected first.** Deletion is attempted before blocking and
  reporting, because the crash happens at render time.
* **Your account never becomes the spammer.** Report submissions are paced and
  jittered, gated by an action budget, and a circuit breaker pauses enforcement if
  you are being flooded.
* **Idempotent.** A number already on your blocklist is not re-blocked; the same
  message id is never handled twice; a flood of 40 payloads from one number spends
  exactly one block.
* **Resilient.** WhatsApp disconnects are retried with backoff; a failed alert is
  written to `data/outbox/` instead of vanishing; a corrupt state file is
  quarantined and rebuilt; no action can crash the process.
* **Tested.** `npm test` runs 98 tests, including a full end-to-end pipeline test
  against a fake socket and a real HTTP bridge, and a CLI test that shells out to
  every command.

---

## The detection rule

Default trigger, and the reason it is shaped this way:

| Check | Fires when | Why it exists |
|---|---|---|
| `oversize` | counted length **>** `THRESHOLD_CHARS` (2000) | the actual crash trigger |
| `invisible-inflation` | ≥ 8 zero-width/bidi characters, hidden in the text | attackers smuggle thousands of invisible code units past naive counters |
| `unicode-tags` | ≥ 4 characters from the U+E0000 tag block | renders as nothing, crashes renderers |
| `control-chars` | ≥ 4 non-printing control codes | terminal/renderer killers |
| `bidi-override` | ≥ 3 U+202B–U+202E codes | text-direction DoS, also hides the payload |
| `zwj-bomb` | ≥ 200 joiners or ≥ 300 variation selectors | the emoji-cluster explosion |
| `combining-stack` | ≥ 60 stacked marks in a row | "zalgo" renderer stalls |
| `line-bomb` | ≥ 5,000 lines | list/virtualisation overload |
| `broken-encoding` | ≥ 2 unpaired UTF-16 surrogates | dies in encoders, SQLite and JSON writers |

`COUNT_MODE=max` counts both what the eye sees (graphemes) and what the wire carries
(UTF-16 units) and takes the larger — so a payload padded with invisible characters
cannot slip under the threshold. Contact-card bombs (`BEGIN:VCARD…`) are measured too,
even though they carry no text body at all.

Turn the extras off with `HEURISTICS=false` (or `--no-heuristics`) for pure
length-only policing.

---

## What happens on an incident

1. **Delete for me** — `chatModify({ deleteForMe })`, the real "delete for me"
   operation. It removes the payload from this device and every linked device, even
   though the sender owns the message. `DELETE_MODE=revoke-if-able` first tries
   "delete for everyone" and falls back, because a revoke of someone else's message
   is usually refused.
2. **Block** — `updateBlockStatus(jid, 'block')`, deduped against your live
   WhatsApp blocklist, with three retries and a friendly skip if it is already there.
3. **Reports** — `REPORT_ATTEMPTS` (30) submissions per incident:

   | Channel | What it is | When it is chosen |
   |---|---|---|
   | `native` | a report method on the socket (some Baileys forks expose `reportAbuse`) | if the loaded client has one |
   | `iq` | a raw report stanza, only after a startup probe proves the server accepts it | if the probe passes |
   | `bridge` | `POST ${WA_BRIDGE_URL}/report` to your own WhatsApp-Web/wppconnect bridge, which can drive the real in-app report | if `/health` answers |
   | `evidence` | always: a complete, submittable evidence packet in `data/reports/` plus the in-app steps | fallback |

   Read this honestly: **WhatsApp exposes no public "report this number 30 times"
   call on the Web socket.** Reporting is an in-app flow (it uploads the last few
   messages you received to Meta for review). AntiBugBot will not print a fake
   success counter. It probes for a real path, uses it when it exists, and otherwise
   hands you the evidence packet and the exact taps — with the packet already
   written for you. If you want genuine 30× submission, point `WA_BRIDGE_URL` at a
   bridge that can perform the in-app report and the loop will run for real, paced
   and logged per attempt.
4. **Owner brief** — a full incident report to your own number (or `OWNER_NUMBER`),
   in English **and** සිංහල: who sent it, their name in chat, jid, message id,
   received time (local + UTC), counted size, byte size, hidden-character counts,
   which rules fired, a safe preview of the payload, what was deleted/blocked/reported,
   prior incidents from that same number, and the undo command.

---

## The terminal

The UI is hand-rolled ANSI — no chalk, no ink, no spinner dependency. It degrades
cleanly when piped (`NO_COLOR`, non-TTY) and re-renders only its own lines, so logs
never tear the status strip apart.

```
╔════════════════════════════════════  ANTI-BUG SHIELD  ═════════════════════════════════════╗
║   ▄▄▄  AntiBugBot  v1.0.0                                                                  ║
║   █▀ ▀█  WhatsApp crash-bug shield                                                         ║
║   ▀█▄█▀  baileys 7.0.0-rc14 · node v22.22.3 · linux                                         ║
║   ────────────────────────────────────────────────────────                                 ║
║   trigger 2,000 chars   reports 30×   delete for-me                                        ║
║   groups  observe   owner  self chat                                                       ║
║   mode    ENFORCE block · delete for me · report · alert                                   ║
╚════════════════════════════════════════════════════════════════════════════════════════════╝
12:41:03.118 INFO   socket    auth state loaded from /home/you/AntiBugBot/auth (resuming session)
12:41:06.702 NOTICE shield    shield armed — watching for messages over 2000 characters
╔══════════════════════════════════════  INCIDENT INC-20261021-124455-a1b2  ═════════════════╗
║ 🐞 Oversized message · Bidi override spam                                                   ║
║ sender    +94770000000  “Crash Bot”                                                         ║
║ length    2,600 chars / trigger 2,000  risk HIGH 160                                        ║
║ evidence  "aaaaaaaaaa…"                                                                     ║
║ signal    Bidi override spam — 9 codes                                                      ║
╚═════════════════════════════════════════════════════════════════════════════════════════════╝
   ✔ delete for me   deleted for me (device + linked devices)
   ✔ block           blocked 94770000000@s.whatsapp.net
   · reports         0/30 filed · evidence · WhatsApp exposes no socket-side report call
12:44:56.201 NOTICE alert     ✉ brief delivered to 94771111111@s.whatsapp.net
● SHIELD ARMED · armed · 94771111111@s.whatsapp.net · up 3m 12s
  scanned 1,204   threats 2   blocked 2   deleted 2   reports 0/60   alerts 2
 ─────────────────────────────────────────────────────────────────────────────────────────────
```

That last block is a **live strip**: it redraws itself every second and re-appears
after any log line, so you always see scanned / threats / blocked / deleted /
reports / alerts and the current phase (`connecting → pairing → armed → stopping`).

Also built in:

* a boxed, inverted QR on a light background so any scanner reads it from any theme,
* a pairing-code panel (`npm run pair -- --number 0771234567`),
* `⠋ ⠙ ⠹` spinners in the strip while the report loop or capability probe runs,
* a `CANNOT REACH WHATSAPP` panel after three failed attempts, with the actual
  socket error and the four things to check,
* a `NEST CLOSED` summary on `Ctrl+C` (scanned, threats, blocked, deleted, reports,
  uptime, errors) after queued work is drained and state is flushed,
* a terminal bell on each threat (`BEEP_ON_THREAT`, off with `--no-beep`).

---

## Commands

```bash
npm start                          # link + run the shield
npm run dev                        # same, with --watch for development
npm run pair -- --number 0771234567
npm run status                     # counters and config, offline
npm run history -- --limit 20      # incident ledger (--json for raw records)
npm run blocked                    # what this shield has blocked
npm run unblock -- 94770000000     # clear a block
npm run whitelist -- add 0771234567
npm run selftest                   # full pipeline test against a fake socket
npm run logout                     # unlink the device and drop stored auth
npm test                           # the test suite
```

Flags worth knowing: `--threshold 2000`, `--count-mode max`, `--report-attempts 30`,
`--report-channel auto`, `--delete-mode for-me`, `--groups observe`, `--mode observe`
(dry run), `--owner +94771234567`, `--whitelist 077…`, `--verbose`, `--quiet`,
`--no-block`, `--no-report`, `--no-heuristics`, `--no-beep`, `--no-stats`, `--no-color`.

### WhatsApp commands (send them to your own number)

Once the shield is running, message **yourself** from the linked account:

| Command | Effect |
|---|---|
| `!status` | live counters, right in the chat |
| `!threshold 3500` | change the trigger for this session |
| `!whitelist 0771234567` | never enforce against that number |
| `!unblock 94770000000` | lift a block without touching a terminal |
| `!test` | connectivity check |

Only your own number (or a whitelisted one) is obeyed; everyone else is ignored.

---

## Running it as a service

```bash
# pm2
npm i -g pm2 && pm2 start src/index.js --name antibugbot && pm2 save && pm2 startup

# systemd
sudo tee /etc/systemd/system/antibugbot.service > /dev/null <<'UNIT'
[Unit]
Description=AntiBugBot WhatsApp crash-bug shield
After=network-online.target

[Service]
WorkingDirectory=/home/you/AntiBugBot
ExecStart=/usr/bin/node src/index.js start
Restart=always
RestartSec=5
User=you

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl enable --now antibugbot && journalctl -u antibugbot -f
```

---

## Files on disk

```
auth/                     session keys (treat like a password — never commit)
data/state.json           blocked numbers, whitelist, recent incidents, counters
data/incidents.jsonl      append-only forensic ledger, every incident forever
data/reports/INC-*.json   machine-readable evidence packets
data/reports/INC-*.txt    the same packet, readable, ready to send to WhatsApp support
data/outbox/              briefs that could not be delivered (kept, not lost)
data/logs/bot.log         full history including debug lines
```

`data/` and `auth/` are git-ignored. `npm run status` reads them without touching
WhatsApp; delete them for a clean slate.

---

## Privacy and safety

* Everything runs on your machine, over your own linked device. No third-party
  server, no telemetry, no message ever leaves except the actions you configured.
* Message bodies are **not** stored. Only the measurements (length, byte count,
  invisible-character counts, rule ids) and a 160-character sanitised preview with
  invisible characters replaced by `·`.
* Media is never downloaded to scan — captions and text bodies are read from the
  message envelope, which is also what makes the check fast enough to beat rendering.
* Enforcement is deliberately gentle on *your* account: 6 actions/minute, a 5-minute
  breaker under flood, one block per number no matter how many payloads arrive.
* Use `--mode observe` first if you want to watch what it would do before letting it
  touch your chats.

Unlinking is always one command away: `npm run logout`.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `no route to WhatsApp` / 408 repeats | network, VPN, firewall on 443, or blocked datacenter IP. Confirm `openssl s_client -connect web.whatsapp.com:443` |
| QR never appears but retries continue | the socket never opened — see above; check the system clock |
| `401 session logged out` | unlinked from the phone. `npm run logout` then `npm start` |
| pairing code rejected | the code is for the **phone that owns the account**, six characters, entered under "Link with phone number instead" |
| briefs not arriving | `OWNER_NUMBER` unset sends to your own self-chat — make sure that chat exists; failures land in `data/outbox/` |
| reports show `0/30 filed` | expected without a bridge: no socket-side report call exists. Use `--report-channel bridge --bridge-url …` or file the packet in-app |
| nothing fires on a long message | it may be from a whitelisted number, `fromMe`, a group in `observe` mode, or the count mode is set to `grapheme` while the payload is invisible characters |

---

## Requirements

* **Node.js ≥ 18.15** (20/22 recommended — the tests run on both)
* A WhatsApp account you own, able to use Linked Devices
* Two direct dependencies: `@whiskeysockets/baileys`, `qrcode-terminal`

Unofficial clients violate WhatsApp's ToS and can get the account banned. This bot
sends no bulk traffic and keeps its own footprint minimal, but the risk is yours to
accept — that is why the action budget and circuit breaker exist.

---

## Layout

```
src/
  index.js            CLI: start · pair · status · history · blocked · unblock · whitelist · logout · selftest
  bot.js              socket lifecycle, reconnect/backoff, message routing, owner commands
  config.js           .env + environment + CLI merge, validation, normalisation
  core/
    guard.js          the rule set — pure, no I/O, fully unit tested
    measure.js        grapheme/UTF-16/byte measurement, invisible-character forensics
    incident.js       builds the incident record, unwraps ephemeral/view-once/edit payloads
    brief.js          the owner-facing bilingual report + arm notice + stats reply
    store.js          atomic JSON state, append-only ledger, evidence packets
    queue.js          per-number serialisation, action budget, circuit breaker, jitter
    format.js         counts, dates, previews, masking
    jid.js            jid parsing and the "never police this" cases
  actions/
    enforce.js        the pipeline: delete → block → report → brief, with bookkeeping
    delete-for-me.js  for-me and revoke-if-able paths
    block.js          block/unblock with blocklist dedupe and retries
    report.js         report engine: capability probe, native/iq/bridge/evidence, evidence packets
    notify.js         owner delivery, retries, outbox fallback
  ui/
    theme.js          ANSI palette, box drawing, width-safe padding, wrap
    console.js        panels, threat cards, QR, spinners, live strip, log file
test/                 98 tests across unit, integration (fake socket + real HTTP bridge) and CLI
```

---

## Licence

MIT — see [LICENSE](LICENSE). Built for defending your own device.
