# Adapters

`src/core/*` is provider-agnostic and dependency-free on purpose: it is the part
that can be reviewed, fuzzed and unit-tested without a WhatsApp session.

An adapter owns exactly three things:

1. **Inbound ingest** – normalise the provider's message object into the `evt`
   shape documented in `../guard.js`.
2. **Safe handling of media** – never download above `maxMediaBytes`, and never
   decrypt/render an arbitrary document before screening (a PDF/image payload is
   a common second delivery vector for these crash bugs).
3. **Apply the decision** – map our action onto provider calls, in this order of
   preference, degrading when the bot lacks the power:

| decision   | group with admin          | group without admin      | DM                       |
|------------|---------------------------|--------------------------|--------------------------|
| `delete`   | `sendMessage(revoke)` on self | `log` + mark chat hot | delete on bot side only  |
| `restrict` | set `announce` for 10 min | `mute` (bot side)        | block + report           |
| `mute`     | mute in bot store         | n/a                      | n/a                      |
| `block`    | remove + block            | block                    | block + report           |

## Rules for every adapter

* Do **not** print `evt.text` anywhere. Use `redact()` from `../redact.js`.
* Do **not** persist raw text or media to disk (including crash dumps and `npm`
  debug logs). Quarantine stores fingerprints only.
* Do **not** implement a "send this to N numbers" path. This project screens
  inbound traffic; it has no outbound blast capability and adding one turns the
  repo into the tooling it claims to defend against.
* Screen the bot's **own** outbound acknowledgements too (a hostile group can
  reflect a payload into a reply).

## Candidate providers

* `baileys` – socket-based, works headless on Pterodactyl (no Chromium), pairs
  with `--pair-code` (see `../../pterodactyl/README.md`). Best fit.
* `whatsapp-web.js` – needs Chromium + a display server; awkward on Pterodactyl.
* `Meta WhatsApp Cloud API` – official, but only for Business accounts you own;
  cannot read arbitrary groups. Use it for the *opt-in* notification channel.
