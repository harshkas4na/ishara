# SPEC (written after kickoff, Thu 5 Nov 2026, 21:30 IST)

Goal: a tutor that moves a pointer to the right element on a page, using sealed 0G models, with a receipt
for every decision, and that refuses instead of guessing.

## The loop (one question)
1. Hold the key, speak. Local Whisper turns audio into text. The page is compiled into a text outline
   (ids, labels, positions). Nothing but those two texts leaves the laptop.
2. The local helper sends the question and outline to the 0G Private Computer Router with the trust-mode
   header `private`. Two calls run at the same time:
   - 0GM-1.0 reads the whole outline and answers `[POINT:id]`. Thinking is off.
   - laya chooses among 3 shortlisted ids (local keyword match) or `none`.
3. The gate decides: point only if laya's choice is not `none`, its probability is at least 0.45, and 0GM
   named the same id. Disagree -> ask which. `none` or low probability -> ask. Timeout (laya 4 s, 0GM 8 s),
   503 or offline -> safe-stop, never a guess.
4. After each answer the provider signature is fetched, the signer is recovered and compared to the
   on-chain signer, and a log entry is written with the request id.
5. At session end the log is encrypted and uploaded to 0G Storage; its root goes to a small contract on
   Galileo. A replay page reads it back and checks the hash.

## Core (done first)
Extension (push-to-talk, outline compiler, pointer overlay, type-instead fallback), local helper (Whisper,
0G calls, gate), safe-stop, request id shown in the UI, a way to test it without 0G (never used as a
fallback in the product).

## Strong
"How do I know?" proof sheet, encrypted log on 0G Storage, session-root contract, replay page, eval table.

## Stretch
Desktop adapter (accessibility tree + local OCR) into the same outline. One follow-up turn. Local speech out.

## Not building
Screenshots, wallets or payments, raw coordinates from a model, a chat UI.

## Hand-written logic
`helper/src/gate.ts` and `helper/src/episode-log.ts`.

Interfaces between parts: `docs/INTERFACES.md`.
