# Decisions, with the evidence

Each entry: what was decided, what was tried, the numbers. Newest last. Numbers come from real 0G calls
unless stated.

## 1. Voice is transcribed on the laptop
Whisper on 0G is sealed hardware but not end-to-end encrypted, takes 2-5 s, and the router sees the audio.
Local whisper.cpp takes 0.3-1.2 s and nothing leaves the machine. Priming Whisper with the page's own labels
fixed "Etherscan" (heard as "a Thurskine" without it). Silence comes back as a made-up word ("you"), so the
extension refuses recordings below a loudness floor and ignores stock noise phrases.

## 2. No screenshots, ever
Tried in the pre-event lab: a screenshot to 0GM-1.0 took 4-11 s and was right 5 of 6 times. It also sends pixels,
which breaks the Private claim. The page is read as a text outline instead (~235 tokens, under 10 ms to compile).

## 3. The brain reply is read as it streams
Waiting for the full reply took ~5.9 s in a first measurement. Reading the stream and answering when the
`[POINT:id]` tag completes gives 1.8-3.6 s to the tag. The rest of the stream is still read (not cancelled) so
the provider records the response the proof is fetched for.

## 4. 0GM proposes, laya confirms (replaced "both choose and agree")
First design: laya chooses among 3 locally shortlisted controls, 0GM names one, the pointer moves if they agree
and laya's probability is at least 0.45. On a page with plausible distractors this vetoed 4 of 12 correct
answers (correct picks scored p=0.31-0.35 because other candidates looked plausible) and 0GM was right every time.
Probing laya with a yes/no about 0GM's single pick separated cleanly: correct 0.29-0.87, wrong 0.00-0.25,
vague asks 0.06-0.25 (one near-synonym, "compiler version" versus "compiler type", scored 0.85).
Result with the yes/no gate at 0.4: 11 of 12 clear pointed correctly, 0 wrong points, 6 of 6 vague asked
(`scripts/eval.ts`, repeated, same). Cost: about 1 s more than running the two in parallel.

## 5. The shortlist is no longer on the decision path
It fed laya's choice. `helper/src/shortlist.ts` stays (stems, interface synonyms, controls before links,
headings never candidates) for a future "which of these?" question and for the embedding upgrade below.

## 6. Failures are shown, never hidden
0GM down or timed out: safe-stop with the cause in plain words. laya down: ask, never point on 0GM alone.
The helper logs why each 0G call failed. On 5 Nov the router returned 502 for 0GM and hung laya; the tutor
refused correctly.

## 7. Receipts are fetched immediately
The provider serves its signature for about 20 minutes only. So `episode-log.ts` fetches it right after each
answer (with retries) and stores it in the log entry. At session end the log is encrypted (AES-256-GCM), uploaded
to 0G Storage, and its root is written to the contract. Replay fetches it back, checks the plaintext hash and
compares the root with the chain.

## Approaches considered and not taken (yet)
- **Local embeddings for the shortlist** (a small public model on the laptop). Not needed since decision 4.
- **Streaming speech back (local Kokoro-82M).** Parked until the core is audited.
- **Desktop adapter** (accessibility tree + local OCR into the same outline format). Planned as a stretch.
- **Wallet, payments, raw model coordinates, a chat UI.** Out of scope.
