# Ishara (working name)

A screen tutor you can verify. Hold a key, ask a question out loud, and a pointer moves to the right
control on the page, with a one-line answer. Every decision is made by sealed models on 0G, each answer
has a receipt you can check, and if 0G cannot be reached the tutor says so instead of guessing.

Built solo at ETHGlobal Mumbai, 5-7 Nov 2026. Tracks: 0G Physical AI (Agents with a Body), Build with 0G PC,
Ethereum Foundation Best CROPS App.

> Status: the Core works end to end (question in, sealed decision, pointer). The proof pages and the
> replay are in. See "Known limits" for what is not done or not proven.

## What it does
1. You hold **Option+Space** and ask ("where do I put the contract address?"), or press **Option+Shift+Space** and type.
2. Your voice is turned into text **on your laptop** (whisper.cpp). The page is turned into a short text
   outline (one line per control). **Only those two texts leave your machine.** No audio, no screenshot.
3. **0GM-1.0** (sealed, end-to-end encrypted) reads the outline and proposes one control, with one sentence.
4. **laya** (a second sealed 0G model) is asked a yes/no: "is this control what the user asked for?"
5. A small gate (`helper/src/gate.ts`) moves the pointer only if laya says yes with probability at least 0.4.
   If not, it asks you. If 0GM is unreachable, it **safe-stops**: no pointer, a plain message, no guess.
6. After each answer the provider's signature is fetched and checked against the signer registered on-chain.
   At the end of a session the log is encrypted, stored on 0G Storage, and its root is written to a contract.

## How this uses 0G
| 0G piece | What it does here | Without 0G |
|---|---|---|
| Private Computer Router, trust mode `private` | Every model call goes only to sealed providers and returns a request id. Never a non-private fallback. | A normal model API: nothing sealed, no id or signature to check. |
| 0GM-1.0 | Reads the page outline and proposes the control and the answer sentence. | No sealed model for the decision. |
| laya | Confirms or rejects 0GM's proposal with a probability. | The gate has no independent second opinion. |
| 0G Storage (Turbo, Galileo) | Holds each session's encrypted log. | A log on one laptop that nobody else can fetch. |
| SessionRoot contract on Galileo | Records the root of each session's log. Address: `0x40F8A6CB2c16e0bA04005f527B6F3893963464ac` (chain 16602). | A replayed log has nothing to be checked against. |

**What breaks if 0G is removed:** the decision loses its sealed models and its receipts, which is the whole
point of the project. There is no non-0G fallback by design.

The request id for each decision is shown in the debug panel and stored in the log. The "How do I know?" page
(`/app/proof.html`) shows the check for one answer, and the replay page (`/app/replay.html`) reads a whole
session back from 0G Storage and verifies it.

## CROPS
- **Censorship resistant:** no account, server or key of ours sits between you and 0G, and the tutor never
  substitutes a different model when 0G is unreachable. The honest limit: the Router is a single path to 0G.
- **Open source:** MIT, public repository, the plan and the AI use are in the repository (`SPEC.md`, `AI_USE.md`).
- **Private:** audio stays on your laptop, no screenshot is ever sent, only the question and a text outline
  leave it, and only to sealed providers. 0GM-1.0 is end-to-end encrypted; laya and storage are sealed
  hardware but not end-to-end encrypted, and we say so.
- **Secure:** the 0G key lives only in the local helper (`~/.config/0g/key`), never in the extension. Answers
  have a signature checked against the on-chain signer. Logs are AES-256-GCM encrypted before upload, with the
  plaintext hash stored so a wrong key cannot pass silently. The extension has no third-party scripts or analytics.

## Measured (not claimed)
Replayed through the real 0G path on a mock "verify contract" page (`scripts/eval.ts`; first run 5 Nov, re-run unchanged on 6 Nov after the outage):

| Set | Result |
|---|---|
| 12 clear questions | 11 pointed at the right control, 0 wrong points; 1 asked instead (laya p=0.29, below the 0.4 line) |
| 6 vague questions ("help", "I am stuck", ...) | 6 of 6 asked instead of pointing |
| Time per question | 2.6-2.9 s warm, up to 6 s on a cold first call |
| Unit tests | 40 passing (`npm test`) |
| Live receipts (6 Nov, after the outage) | for both 0GM-1.0 and laya the signature recovers to the signer registered on-chain (`scripts/e2e-log.ts`) |
| Log on 0G Storage | uploaded in ~15 s, root recorded on the contract, replay decrypted it and matched the hash and the on-chain root |

It also pointed correctly on a real page (GitHub's sign-in form). Why laya checks instead of choosing: see `docs/DECISIONS.md`.

## Run it
Needs Node 24, Chrome, whisper.cpp (`brew install whisper-cpp`) with `ggml-small.bin`, and a 0G Router key in
`~/.config/0g/key`.
```bash
npm install
npm run helper            # local helper on http://127.0.0.1:7777
```
Chrome: `chrome://extensions` -> Developer mode -> Load unpacked -> the `extension/` folder. Click the Ishara
toolbar button once and allow the microphone. Then open `http://127.0.0.1:7777/test/etherscan-verify.html`.
Full steps: `docs/TESTING-extension.md`. Check the 0G path alone with `npm run check`.

## Known limits
- **0GM-1.0 has few private providers, and they can fail.** On the night of 5 Nov the sealed models were unavailable to every team for about three hours (0G side: Private mode returned 502/503). The tutor safe-stopped and said why; it did not fall back to another model. They came back around 01:50 IST on 6 Nov, with new provider addresses, and everything below was re-run.
  and says why; it does not fall back to another model.
- **The proof is limited.** It shows a sealed provider with this on-chain signer answered this chat id. It does
  not prove the exact words. The signature is only served for about 20 minutes, so it is fetched right after each answer.
- Real-voice Hinglish is not tested. Pages with iframes, shadow DOM or canvas are not read.
- Tested on one mock page and one real page, not a broad set.
- The desktop path (reading any app, not only the browser) is not built.

## Prior work disclosure
Planning notes and a measurement lab were written before kickoff (design knowledge and measured numbers only).
No code from them is in this repository. The history of this repository starts after the 21:00 IST opening
on Thu 5 Nov 2026.

## AI use
Built with AI coding assistance. See `AI_USE.md` for what was generated and which two files were reviewed by hand.

## License
MIT.
