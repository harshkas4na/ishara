# Ishara (working name)

A screen tutor you can verify. Ask about anything on your screen, out loud or typed, in English, Hindi or
Hinglish. Ishara explains it, points at it, walks you through it step by step, answers your follow-ups, and
speaks the answer back. Every answer is made by sealed models on 0G with a receipt you can check, and if 0G
cannot be reached the tutor says so instead of guessing.

Built solo at ETHGlobal Mumbai, 5-7 Nov 2026. Tracks: 0G Physical AI (Agents with a Body), Build with 0G PC,
Ethereum Foundation Best CROPS App.

> Status: working end to end in the browser (Chrome extension) and on any Mac app (desktop path). The numbers
> below are measured on the real 0G router. "Known limits" says what is not proven.

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

## How a turn works
1. You ask (Option+Space in the browser, hold Right Option on the desktop, or type with Option+Shift+Space).
2. Your voice becomes text **on your laptop** (whisper.cpp with a local Hinglish model). No audio leaves the machine.
3. The page is read into text blocks and a control list. **Secrets are removed first, in the tab:** password
   fields, seed/key/token fields, anything shaped like a key; inputs are reported as "filled, 38 chars", not their value.
4. Only your question and that redacted text go to the **0G Private Computer Router**, in `private` trust mode, to
   **0GM-1.0** (sealed, end-to-end encrypted). It streams the answer sentence by sentence.
5. For every pointer the answer asks for, **laya** (a second sealed 0G model) is asked a yes/no: is this control the one
   the sentence refers to? The ring moves only if laya says yes (p at least 0.4). If laya is unreachable it still
   explains but does not point.
6. If 0GM is unreachable it **refuses** and says why. It never answers from a local model or a cache.
7. After each answer the provider's signature is fetched and checked against the signer registered on-chain. At the
   end of a session the log is encrypted, stored on 0G Storage, and its root is written to a contract.

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
- **Censorship resistant:** no account, server or key of ours sits between you and 0G, and the tutor never substitutes a
  different model when 0G is unreachable. The honest limit: the Router is a single path to 0G.
- **Open source:** MIT, public repository; the plan, the audits and the AI use are in the repository.
- **Private:** audio and the voice model stay on your laptop; spoken answers are synthesised locally; no screenshot is
  ever sent. What leaves is your question and the page's visible text with secrets removed, only to sealed providers.
  0GM-1.0 is end-to-end encrypted; laya and storage are sealed hardware but not end-to-end encrypted, and we say so.
- **Secure:** the 0G key lives only in the local helper, never in the extension. Page text is treated as untrusted data
  (fenced, marker look-alikes neutralized); the model has no tools and can only speak and request a pointer. Answers
  have a signature checked against the on-chain signer. Logs are AES-256-GCM encrypted before upload. The extension
  has no third-party scripts or analytics, and the helper accepts requests only from this extension.

## Measured (not claimed)
All on the real 0G router (6 Nov 2026), mechanical checks, no model judging itself.

| Pointing eval (`scripts/eval.ts`, mock page) | Result |
|---|---|
| 12 clear questions | 11 pointed at the right control, 0 wrong points; 1 asked instead |
| 6 vague questions | 6 of 6 asked instead of pointing |

| Tutor eval (`scripts/eval-tutor.ts`, 62 frozen cases on 11 saved pages) | Pass |
|---|---|
| explain | 15 / 15 |
| judgement | 6 / 6 |
| follow-up | 8 / 8 |
| point | 8 / 8 |
| prompt-injection canaries | 6 / 6 |
| Hinglish questions | 6 / 6 |
| walk-through (guide) | 6 / 8 |
| asking about something not on the page | 4 / 5 |

Latency: first spoken sentence about 1.9 s (p50), full answer about 3 s; local voice starts about 0.3 s after the
text. Hinglish speech recognition: word error 28% on synthetic Hinglish voices (it was 67% before we replaced the
English-only model); English 0%. Live receipts: for both 0GM-1.0 and laya the signature recovers to the signer
registered on-chain. A session log uploaded to 0G Storage in about 10-15 s, its root is on the contract, and the
replay verifies the hash and the on-chain root. Unit tests: `npm test`.

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
- **The proof is limited:** it shows a sealed provider with this on-chain signer answered this chat id, not the exact
  words. The signature is only served for about 20 minutes, so it is fetched right after each answer.
- **A hostile page can still make the tutor say something wrong.** It cannot act (no tools), and every pointer needs laya's
  yes, but laya checks the pointer against the tutor's own sentence, so a prompt-injected instruction the model repeats
  depends on the model's own guard (6 of 6 canaries passed).
- **Hinglish is measured on synthetic voices.** Real-voice results are not in yet; the spoken answer is an English voice.
- **Tested on a limited set of pages:** a mock page and 11 saved contexts (some text hand-authored), plus manual runs on
  real sites. Iframes work in the browser; canvas and closed shadow DOM are not read.
- **Browsers on the desktop path are skipped on purpose** (it would only see the browser's own chrome and private tab
  titles); use the extension there. A second display and full-screen apps are not tested.
- No screenshots, no tool calling or web search (parked), and the spoken voice has not been judged by anyone but us.

## Prior work disclosure
Planning notes and a measurement lab were written before kickoff (design knowledge and measured numbers only). No code
from them is in this repository, and none was copied from the author's other projects. The history of this repository
starts after the 21:00 IST opening on Thu 5 Nov 2026.

## AI use
Built with AI coding assistance. See `AI_USE.md` for what was generated and which files were reviewed by hand.

## License
MIT.
