# AI use

This project is built by Harsh Kasana with AI coding assistance (Claude Code). The plan (`SPEC.md`, `docs/PLAN-TUTOR.md`)
was written after kickoff by Harsh and the assistant together, from planning notes made before the event.

- The assistant wrote most of the code under Harsh's direction, in small commits: the Chrome extension, the local helper,
  the desktop path (Swift), the tutor pipeline, the page reader, the voice input and output wiring, the proof and replay
  pages, and the tests. Several assistant sessions worked in parallel on separate files, each against a written interface
  (`docs/TUTOR-INTERFACE.md`, `docs/INTERFACES.md`).
- Separate read-only audit sessions reviewed the product, the desktop path and the voice input, and wrote their findings
  to `docs/audit/`. A second review session audited the code for bugs and security.
- `helper/src/gate.ts` (the point / ask / stop rule) and `helper/src/episode-log.ts` (receipts, encrypted log, replay) are
  the two files Harsh is reviewing line by line so he can explain them; a study guide exists for that.
- The models used inside the product are the 0G models named in the README, plus a local speech-recognition model and a
  local voice model. Models used to write the code are not part of the running product.
- Evaluation numbers come from scripts in the repository run against the real 0G router (`scripts/eval.ts`,
  `scripts/eval-tutor.ts`); a development-only fake router exists and its results are never quoted.
- Prompts, plans, audits and decisions are kept in the repository history (`SPEC.md`, `docs/`).
