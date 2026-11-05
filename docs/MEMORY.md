# Personal memory

Ishara learns from how one person uses it, without leaving the laptop. Code: `helper/src/memory.ts`. Page:
`http://127.0.0.1:7777/app/memory.html` ("What Ishara remembers about how you use it").

## What is stored
`helper/.data/memory/` (gitignored), on this laptop only:
- `events.jsonl`, append-only, one JSON per line: `{t, kind, host, question, outcome?, label?}`.
  - `ask`: every decision. Host (hostname only, no path or query), the question, the outcome (point, ask, safe_stop), and the label of the control that was proposed or pointed at.
  - `accepted`: the user clicked or focused the control we pointed at within 20 s.
  - `missed`: the user asked again on the same page within 30 s after an ask or point that was not accepted. A safe_stop never counts as a miss.
- `profile.json`: rebuilt from the log on every append, deterministically, no model. Per site: question topics by frequency, the user's own words mapped to the labels they accepted (an alias is kept only after 2 sightings), the last 5 distinct questions, counts of asked, accepted, missed. Globally: the typical question length in words (a number).
- `paused`: an empty flag file when remembering is paused.
The log is capped at 5,000 events; the oldest are dropped.

## What is never stored
The page's outline text, form values or anything typed into a page, the 0G request ids, keys, the page path or query. Before storing, the question is scrubbed: 0x addresses, long hex, JWTs, known token prefixes, bearer tokens, long opaque strings, emails, long digit runs and seed-phrase-looking runs become `[redacted]`. Nothing is inferred beyond evidence: no skill levels, no personality guesses.

## How it is used
`memoryContext(host)` returns at most about 440 characters (around 110 tokens) about the CURRENT site only: a few earlier questions there, and aliases ("they call 'wallet' the control 'Contract address'"). It is empty when there is no evidence, or when paused. It is added to the brain prompt only when `ISHARA_MEMORY=1`, after the existing instructions, marked as background that must not override the page outline. Default is OFF. Recording always happens (unless paused). With the switch off, nothing from memory leaves the laptop. With it on, that short summary is part of the sealed question sent to 0G.

Turn it on: `ISHARA_MEMORY=1 npm run helper`.

## See, pause, forget
- See: `memory.html`, or `GET /memory` (profile, counts, last 20 questions; never the raw log).
- Pause / resume: the page button, or `POST /memory/pause`, `POST /memory/resume`.
- Forget: "Forget everything" (in-page confirmation), or `DELETE /memory`. Deletes the log and the profile. Or delete the folder by hand.
All routes sit behind the helper's Host/Origin guard. The extension reports "accepted" through `POST /memory/feedback` (question text and hostname only).

## Eval before default-on
`node scripts/eval.ts --memory` seeds a throwaway memory for the mock page and runs the same cases with the switch on (`helper/.data/eval-latest-memory.json`). The plain run's numbers (11/12 clear, 0 wrong points, 6/6 vague asked) must be matched: zero wrong points and no loss on vague questions. Then, and only then, consider default-on.

## How it differs from brain-ops
brain-ops (the builder's own system) has the same shape, event log, distill, recall, allowlist, redaction, but over a lifetime of files and with models in the loop. This is a person-sized version: one small log, a deterministic profile, and a per-site recall of a few hundred characters. It indexes no files.

## Future (not built)
- A sealed 0G model could distill the profile from the log (better aliases and topics), inside the same privacy claim.
- The log could be encrypted and backed up to 0G Storage, as session logs already are, so memory follows the user to a new laptop.
