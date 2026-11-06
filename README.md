# Ishara (working name)

A screen tutor you can verify. Ask about anything on your screen, out loud or typed, in English, Hindi or
Hinglish. Ishara explains it, points at it, walks you through it step by step, answers your follow-ups, and
speaks the answer back. Every answer is made by sealed models on 0G with a receipt you can check, and if 0G
cannot be reached the tutor says so instead of guessing.

Built solo at ETHGlobal Mumbai, 5-7 Nov 2026. Tracks: 0G Physical AI (Agents with a Body), Build with 0G PC,
Ethereum Foundation Best CROPS App.

> Status: working end to end in the browser (Chrome extension) and on any Mac app (desktop path). The tutor numbers
> below are measured on the real 0G router. Agent mode is not measured on the real router yet. "Known limits" says what is not proven.

## What it does
- **Explain:** "what does the optimizer runs setting mean?" It reads the page, answers in plain sentences, and says
  whether something comes from the page or is general knowledge. If the thing is not on screen, it says so.
- **Point:** "where do I put the contract address?" A needle cursor glides to the control and a pen-style marker
  circles it. The ring moves only if a second sealed model agrees.
- **Walk you through:** "walk me through verifying my contract". Step 1 of 6 with Next / Back / Stop, one pointer per step.
- **Follow-ups:** "why?", "and then?". It keeps a short memory of the conversation on that page.
- **Voice in and out:** hold a key and talk (Hindi, English or both); the answer is spoken back by a local voice.
- **Any app:** the desktop path reads any Mac app through the Accessibility tree and on-device OCR. In a browser the
  Chrome extension does the reading.
- **Agent mode (off until you turn it on):** "fill this form", "open the pricing page", "search for X", "switch to my mail
  tab", "read ~/Documents/notes.txt" (desktop only). It plans one step at a time on 0GM and laya checks each target. Any step
  that might commit something (a commit word, an unknown button, Enter in a form, text you did not give it, a search or link
  carrying words you did not say) waits for your Approve in a separate Ishara window the web page cannot touch.

## How a turn works
1. You ask (Option+Space in the browser, hold Right Option on the desktop, or type with Option+Shift+Space).
2. Your voice becomes text **on your laptop** (whisper.cpp with a local Hinglish model). No audio leaves the machine.
3. The page is read into text blocks and a control list. **Secrets are removed first, in the tab:** password
   fields, seed/key/token/card fields, anything shaped like a key, a recovery phrase (also inside a sentence or spread
   over 12 elements) or a card number, in page text and in control labels alike; inputs are reported as "filled, 38
   chars", not their value. The helper applies the same redaction again before anything goes to 0G.
4. Only your question and that redacted text go to the **0G Private Computer Router**, in `private` trust mode, to
   **0GM-1.0** (sealed, end-to-end encrypted). It streams the answer sentence by sentence.
5. For every pointer the answer asks for, **laya** (a second sealed 0G model) is asked a yes/no: is this control the one
   the sentence refers to? The ring moves only if laya says yes (p at least 0.4). If laya is unreachable it still
   explains but does not point.
6. If 0GM is unreachable it **refuses** and says why. It never answers from a local model or a cache.
7. After each answer the provider's signature is fetched and checked against the signer registered and acknowledged
   on-chain. A browser session is one tab; when you close the tab (or after 15 idle minutes, or "End session" in the debug
   panel) its log is encrypted, stored on 0G Storage, and its root is written to a contract. The desktop path's session is
   saved only from the debug panel today.

## How this uses 0G
| 0G piece | What it does here | Without 0G |
|---|---|---|
| Private Computer Router, trust mode `private` | Every model call goes only to sealed providers and returns a request id. Never a non-private fallback. | A normal model API: nothing sealed, no id or signature to check. |
| 0GM-1.0 | Reads the page and streams the explanation, the steps and the pointer requests. | No sealed model for the answer. |
| laya | Independently confirms or rejects every pointer with a probability. | Nothing checks 0GM's pointers. |
| 0G Storage (Turbo, Galileo) | Holds each session's encrypted log. | A log on one laptop that nobody else can fetch. |
| SessionRoot contract on Galileo | Records the root of each session's log. Address: `0x40F8A6CB2c16e0bA04005f527B6F3893963464ac` (chain 16602). | A replayed log has nothing to be checked against. |

**What breaks if 0G is removed:** the answers lose their sealed models and their receipts, which is the point of the
project. There is no non-0G fallback by design. The "How do I know?" page (`/app/proof.html`) shows the check for one
answer, and the replay page (`/app/replay.html`) reads a whole session back from 0G Storage and verifies it.

## CROPS
Lead property: **Private**. The other three hold, and where we trade something away it is stated here.

- **C, censorship resistant.** What we control that you depend on: nothing. There is no domain, server, relayer or
  account of ours; the helper runs on your laptop and talks straight to the 0G Router. If 0G refuses or cannot be
  reached, Ishara says so and stops; it never swaps in another model or answers from a cache. **Trade-off:** the Router
  is a single path to 0G, so when it is down Ishara is down (it was, twice, during this hackathon, and failed closed).
- **O, open source.** MIT licence. You can build and run it from this repository alone (needs your own 0G Router key and
  the free local speech models, see "Run it"). The plan, audits and AI use are in the repository.
- **P, private.** Your voice becomes text on your laptop and the spoken answer is made on your laptop; no audio and no
  screenshot is ever sent (Agent mode's screenshot goes to your clipboard or Downloads only). Third parties learn this: the
  0G Router and the sealed provider see your question and the page's visible text with secrets removed (password, seed, key
  and card fields, and anything shaped like a secret: keys, seed phrases in any case or joined by hyphens, card numbers,
  Aadhaar, PAN, "my password is ..." are stripped first, in the tab and again in the helper). In Agent mode a search sends its
  words to Brave, Google or DuckDuckGo, and opening a link sends you to that site, like any browser; words you did not say
  need your Approve first. 0GM-1.0 is end-to-end encrypted; laya and 0G Storage run on sealed hardware but are not end-to-end
  encrypted. On this laptop the helper keeps your questions and the sites you asked on (`helper/.data/memory`, which you can
  view, pause and delete at `/app/memory.html`) and each session's log with its key. No analytics, trackers or third-party
  scripts anywhere in the client.
- **S, secure.** The 0G key lives only in the local helper, never in the extension, and the helper accepts only this
  extension (a foreign Host or Origin gets a 403; local programs with no Origin header can still call it). Page text is
  untrusted data (fenced, marker look-alikes neutralized). In tutor mode the model can only speak and ask for a pointer,
  and every pointer needs a second model's yes. Agent mode is off until you arm it in a tab (it disarms after 10 idle
  minutes), never types into secret fields, asks before every step it cannot show is harmless, including everything on a
  wallet or approval page, and takes the answer only in its own window, never from the page. Option+Shift+X stops it from any
  page, Esc and the Stop button too; 25 actions, 3 minutes of agent time and 10 minutes in all per task, across pages. A
  label we do not know is treated as risky, but a page can still name a dangerous button innocently ("Next") and do
  something else when clicked; read the Approve window. Answers carry a signature checked against the on-chain signer;
  session logs are AES-256-GCM encrypted before upload. **Trust assumption:** you trust 0G's sealed hardware and its
  signer registry.

## Measured (not claimed)
All on the real 0G router (6 Nov 2026), mechanical checks, no model judging itself.

| Pointing eval (`scripts/eval.ts`, mock page) | Result |
|---|---|
| 12 clear questions | 11 pointed at the right control, 0 wrong points; 1 asked instead |
| 6 vague questions | 6 of 6 asked instead of pointing |

| Tutor eval (`scripts/eval-tutor.ts`, 62 frozen cases on 11 saved pages) | Pass |
|---|---|
| explain | 14 / 15 |
| judgement | 5 / 6 |
| follow-up | 7 / 8 |
| point | 0 / 8 |
| prompt-injection canaries | 6 / 6 (also 6 / 6 in a separate injection-only run, 6 Nov 08:54 IST) |
| Hinglish questions | 2 / 6 |
| walk-through (guide) | 0 / 8 |
| asking about something not on the page | 1 / 5 |

This is the only full run saved in the repository (`helper/.data/eval-tutor-run1-full.json`, 6 Nov 03:17 IST), made BEFORE
the guide and pointing fixes of 6 Nov morning, so it understates the build. A later full run was quoted here earlier but its
file was overwritten by a filtered run; that is fixed (every full run is now saved under its date). Re-run
`node scripts/eval-tutor.ts` on the real router and quote that file. One run per class, never a blended score.

Measured once, result files not saved: latency, first spoken sentence about 1.9 s (p50), full answer about 2.9 s (p50);
local voice starts about 0.3 s after the text. Hinglish speech recognition: word error 28% on synthetic Hinglish voices (it
was 67% before we replaced the English-only model); English 0%. Live receipts: for both 0GM-1.0 and laya the signature recovers to the signer
registered on-chain. A session log uploaded to 0G Storage in about 10-15 s, its root is on the contract, and the
replay verifies the hash and the on-chain root (on the laptop that made the session: the log key stays there). Unit tests:
`npm test` (no network; the live 0G tests run with `ISHARA_LIVE=1`).

## Run it
Needs Node 24, Chrome, `brew install whisper-cpp uv`, and a 0G Router key in `~/.config/0g/key`.
```bash
npm install
scripts/setup-voice.sh      # local voice (Kokoro) once
npm run helper:desktop      # helper on http://127.0.0.1:7777 (voice, tutor, desktop key)
```
Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> the `extension/` folder; click the toolbar button once
and allow the microphone; open `http://127.0.0.1:7777/test/etherscan-verify.html`. Desktop: `npm run desktop:build`,
grant Accessibility, Microphone and Input Monitoring to your terminal, then hold **Right Option** in any non-browser app.
Details: `docs/TESTING-extension.md`, `docs/DESKTOP.md`, `docs/SPEECH.md`.

## Known limits
- **0GM-1.0 has few private providers, and they can fail.** On the night of 5 Nov the sealed models were unavailable to
  every team for about three hours (0G side). The tutor safe-stopped and said why; it did not fall back to another model.
  They came back around 01:50 IST on 6 Nov with new provider addresses, and the numbers above were re-measured.
- **The proof is limited:** it shows that a provider whose TEE signer is registered and acknowledged on-chain signed the
  record it serves for this chat id. The signed text is a pair of hashes, not the words, and it does not contain the chat id.
  The signature is only served for about 20 minutes, so it is fetched right after each answer; a helper restart within that
  window loses the ones still pending.
- **A hostile page can still make the tutor say something wrong.** In tutor mode it cannot act (no tools), and every pointer
  needs laya's yes. Agent mode can act; its limits are in the S paragraph above and in `docs/AGENT-MODE.md`. laya checks the pointer against the tutor's own sentence, so in an audit a fake transcript planted in page text got a
  confirmed pointer at "Sign in". Since then a gate rule refuses a pointer at any control that page text addressed to an
  assistant asks for, unless you named it yourself. Plain page instructions ("sign in first") are not caught by that rule
  and can still shape what the tutor says.
- **Hinglish is measured on synthetic voices.** Real-voice results are not in yet; the spoken answer is an English voice.
- **Tested on a limited set of pages:** a mock page and 11 saved contexts (some text hand-authored), plus manual runs on
  real sites. Iframes work in the browser; canvas and closed shadow DOM are not read.
- **Browsers on the desktop path are skipped on purpose** (it would only see the browser's own chrome and private tab
  titles); use the extension there. A second display and full-screen apps are not tested.
- No screenshot is sent to 0G (Agent mode can save one locally). Tool calling and web search exist only in Agent mode, which
  is not yet measured on the real router: the one saved real-router case failed. The spoken voice has not been judged by
  anyone but us.

## Prior work disclosure
Planning notes and a measurement lab were written before kickoff (design knowledge and measured numbers only). No code
from them is in this repository, and none was copied from the author's other projects. The history of this repository
starts after the 21:00 IST opening on Thu 5 Nov 2026.

## AI use
Built with AI coding assistance. See `AI_USE.md` for what was generated and which files were reviewed by hand.

## License
MIT.
