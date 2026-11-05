# AI use

This project is built by Harsh Kasana with AI coding assistance (Claude Code). The plan (`SPEC.md`) was
written after kickoff by Harsh and the assistant together, from planning notes made before the event.

- The assistant wrote scaffolding, the outline compiler, the overlay, the local helper and tests, under
  Harsh's direction, in small commits.
- `helper/src/gate.ts` (the point / ask / stop decision) and `helper/src/episode-log.ts` (signature fetch,
  signer recovery, encrypted log) are the two files whose logic Harsh reviews and can explain line by line.
- Models used inside the product are the 0G models named in the README. Models used to write the code are
  not part of the running product.
- Prompts and the plan are kept in the repository history (`SPEC.md`, `docs/`).
