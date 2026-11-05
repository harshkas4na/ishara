# Plan: from "find this field" to a screen tutor (6 Nov 2026)

## Why
Harsh tested the real thing and said it is not near what a screen tutor should be. The audits confirmed it:
- Product (docs/audit/product-gap.md): of 20 real questions on 4 pages, 7 pointed, 13 got "which step do you mean?" or
  "this one or that one?", 0 explained anything. Causes: the model never sees page text (controls and headings only), the
  prompt forces one short sentence plus one pointer, there is no conversation memory, and the gate has no "answer without a
  pointer" outcome. With page text, 0GM-1.0 explains well (4-5 of 5, first token 1.7 to 4.9 s).
- Desktop (docs/audit/desktop.md): the browser extension also fired on the desktop chord (it ignored Control), the push-to-talk
  daemon crashed on the first key press (audio format mismatch), bubbles sat over the tabs and menu bar. The macOS input-source
  shortcut guess was wrong on this Mac.
- Voice (docs/audit/voice-hinglish.md, in progress): English works; Hinglish is heard as noise.

## Target
Ask anything about what is on the screen, in English, Hindi or Hinglish, by voice or typing. Ishara explains, judges, walks you
through steps (Next/Back), answers follow-ups, points at things, and speaks the answer back. Keep what makes it ours: every
decision from sealed 0G models with a receipt, laya checks every pointer, and it refuses instead of guessing when 0G is down.

## Principles
1. The measured pointing path stays untouched (`/decide`, `gate.ts`): 11/12 clear, 0 wrong points, 6/6 vague must not regress.
2. New behaviour goes in a new route (`POST /tutor`, streaming) with a frozen contract: docs/TUTOR-INTERFACE.md.
3. Privacy: redact secrets before anything leaves the tab; page text is untrusted data (fenced, markers neutralized); the model
   has no tools and can only speak and request a pointer. Screenshots only as an explicit opt-in (decision pending).
4. Honest evaluation: a frozen per-class eval on the real router, never one blended number, test-router results never quoted.

## Work packages and status
| WP | What | Status |
|---|---|---|
| speech | Kokoro spoken answers, local, mute, interrupt | agent running |
| 1 | page reader: text blocks, control state, errors, redaction | agent running |
| 2+3 | tutor core: prompt, stream parser, conversation, walk, router | agent running |
| 4+5 | pointer gate (laya per pointer) + `/tutor` SSE route + logging | agent running |
| 6 | extension UI: streaming bubble, steps, chat panel | agent running |
| 7 | evals + fixtures | agent running |
| voice | Hinglish speech input | audit running, fix next |
| 8 | desktop: Right-Option push-to-talk, daemon crash, text blocks, tutor parity, spoken answers | next |
| 9 | screenshot opt-in (0GM E2EE) | decision pending |
| 10 | docs and claims (README, DECISIONS, SPEC, DESKTOP) | last |
Deferred by Harsh: tool calling and web search (0GM supports tools in Private mode; verified).

## Order
Frozen contract (done) -> parallel build (now) -> integration on the real helper -> real eval per class -> fix prompts from the eval
-> Hinglish voice and desktop -> Opus audit 3 -> demo video. Feature freeze Fri 21:00 IST, submit Sat 08:00.
