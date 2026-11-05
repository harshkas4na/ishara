# Demo script (rehearsed 2026-11-06)

Two versions. Version A needs 0G's sealed models up; version B works today because it only needs the parts that
do not depend on the Router. Both are about 2:30, spoken in your own voice, no speed-up.

## Version B: the refusal and the receipts (works while the sealed tier is down)
| Time | On screen | Say |
|---|---|---|
| 0:00 | Mock verify page, Ishara loaded | "This is Ishara. You ask where something is, and a pointer shows you. Every decision is made by sealed models on 0G." |
| 0:15 | Hold the key, ask "where do I put the contract address". The cursor dances, "I heard: ..." shows | "My voice is turned into text on my laptop. Only that text and a list of the page's controls leave it. No audio, no screenshot." |
| 0:35 | Red bubble: "I can't decide right now. 0G's private model is not reachable. I won't guess" | "0G's sealed models are down right now for everyone at this hackathon. Ishara does not fall back to another model and does not guess. It refuses, and says why. That is the safe-stop the track asks for." |
| 0:55 | Open the panel (Option+Shift+D): REFUSED TO GUESS, 0GM did not answer, laya was not asked | "This panel shows what happened in one look: a tick for what worked, a cross for what failed." |
| 1:10 | Option+Shift+O: the numbered boxes | "And this is what the tutor sees: a numbered box on every control it can read. Text only." |
| 1:25 | Open `/app/`, replay a stored session: Verified panel with three checks | "When it does answer, each decision is logged. The log is encrypted, stored on 0G Storage, and its root is written to a contract on Galileo. This replay reads it back from 0G Storage, decrypts it, checks the hash, and compares the root with the chain." |
| 2:00 | Open the proof page with a fixture, or a live one if available | "And for each answer, a receipt: the provider's signature checked against the signer registered on-chain. It proves a sealed provider answered, not the exact words, and the page says so." |
| 2:20 | The README CROPS section | "Censorship resistant, open source, private, secure: one or two lines each." |

Say plainly in the video that the sealed models were down during recording, with the date and time. Do not stage a
fake success.

## Version A: add when the router is back (record in that window)
Replace 0:35-0:55: ask three clear questions on the mock page (pointer lands, ink loop, bubble with the answer and
"How do I know?"), one vague question ("help") that gets a question back instead of a guess, then pull the Wi-Fi and
show the refusal. Show the panel after a point: 0GM proposed, laya 77% sure, pointer moved. Click "How do I know?"
and show the signature check.

## Checks before recording
- `npm test`, `node scripts/eval.ts` (when 0G is up), `node scripts/e2e-log.ts --storage-only`.
- Disable the screen-tutor extension. Reload Ishara. Allow the microphone once.
- `node scripts/video-check.mjs <video> --event ethglobal-mumbai --track ...` from hack-ops must pass (cap under 3:00).
