# SPEC (written after kickoff, Thu 5 Nov 2026, 21:30 IST)

Goal: a tutor that moves a pointer to the right element on a page, using sealed 0G models, with a receipt
for every decision, and that refuses instead of guessing.

## The loop (one question)
1. Hold the key, speak. Local Whisper turns audio into text. The page is compiled into a text outline
   (ids, labels, positions). Nothing but those two texts leaves the laptop.
2. The local helper sends the question and outline to the 0G Private Computer Router with the trust-mode
   header `private`, in two steps:
   - 0GM-1.0 reads the whole outline and answers one short sentence plus `[POINT:id]`. Thinking is off and the
     reply is read as it streams.
   - laya (a separate sealed decision model) is then asked a yes/no about that one element: "is this control
     what the user asked for?"
3. The gate decides: point only if 0GM named an element and laya's P(yes) is at least 0.4. Otherwise ask the
   user. Timeout (laya 4 s, 0GM 8 s), 503 or offline from 0GM -> safe-stop, never a guess. If laya alone is
   unreachable, ask: never point on 0GM alone.
   Why not "both choose, and agree": measured on the mock verify page, laya choosing among shortlisted elements
   vetoed 4 of 12 correct answers when the other candidates were plausible. The yes/no check got 11 of 12 correct
   with 0 wrong points and 6 of 6 vague questions asked (`scripts/eval.ts`).
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
