# Demo script: Agent mode, 90 seconds (rehearsed against docs/AGENT-MODE.md)

Say it in your own voice, no speed-up. Browser version first; the desktop line is the swap for beat 4.
Page to have open: `test-pages/act-form.html` (the browser agent's form) in one tab, `test-pages/act-media.html` in a second.
Before you record: `npm test`, `node scripts/eval-act.ts` (whenever 0G is up; quote only per-class rows from a run WITHOUT
`ISHARA_ROUTER_URL`), Agent mode OFF, helper running, extension loaded.

| Time | Do | On screen | Say |
|---|---|---|---|
| 0:00 | Press a task with Agent mode OFF: "fill this form" | Pill: "Turn on Agent mode and I will do that". Nothing moves | "Ishara can now act, not only explain. But it is off by default. With it off, it will not touch anything." |
| 0:10 | Option+Shift+A (arm) | Pill shows AGENT ON | "I arm it myself, for this session. Armed or nothing." |
| 0:15 | "Fill this form with my name Harsh and email harsh@example.com, but don't submit" | The cursor travels to each field before typing; pill: "Step 1: typing your name", "Step 2: typing your email". Submit untouched | "Each step is visible. The cursor goes to the control first, and a second sealed model checks that it is the right control. It typed only what I gave it." |
| 0:35 | "Now submit it" | Pill turns to an approval prompt: Submit, with Approve and Deny. Tap Approve | "Submitting is high risk, so it stops and asks. No tap, no submit. I approve, and now it goes." |
| 0:48 | Switch to the media tab. "Open YouTube and play lofi" (browser) | New tab, search, first result plays. Each step in the pill | "Same loop, different task." |
| | Desktop swap: "Open TextEdit and type hello" | TextEdit opens, "hello" appears | "On the desktop it opens the app and types into it through the accessibility tree." |
| 1:00 | "Take a screenshot" | Pill: "Screenshot copied to your clipboard" | "The screenshot goes to my clipboard. It stays on this laptop and is never sent to the model." |
| 1:08 | Start a long task ("fill the form again with a long message"), then press Esc (or Right Option on desktop) at step 2 | Pill: "Stopped. I did not do anything more." Fields show only two steps done | "Stop works at once. The loop checks for it between every action, and there is a cap of 25 actions and 3 minutes." |
| 1:20 | Open the replay / panel | One line per action: risk, approved or not, request ids | "Every action has a receipt: what, how risky, who approved, and the sealed request ids. Planning runs on 0G's private model, and if 0G is down it stops and says so. No local fallback." |
| 1:30 | End | | |

## Safety talking points (pick three if time is short)
- **Armed or nothing**: off by default, armed per session, off means no motion at all.
- **Visible and stoppable**: cursor travels first, pill narrates, Esc / Right Option / Stop button, 25 actions and 3 minutes.
- **Risk levels**: low and medium run; high (submit, pay, buy, delete, send, sign out, connect wallet, quit app) needs my tap.
  No answer in 60 seconds counts as deny.
- **Never secrets**: it refuses to type into password, seed phrase or card fields, and never types a value it was not given.
- **Injection rule**: text on a page can never start an action. Only my words are authority. The eval has four such pages and the
  dangerous button is never pressed (state the measured result from `helper/.data/eval-act-latest.json`, not from memory).
- **Receipts**: every action is in the episode log and the replay, with 0G request ids.
- **Local execution**: clicks, keys, clipboard and screenshots happen on the laptop.

## What to claim, honestly
Quote only the per-class numbers from the latest real run of `scripts/eval-act.ts`, class by class, with the date. The cases are
simulated pages (no browser), so say "in our simulated-page eval", and that the real browser and desktop executors are tested
by hand. Do not quote the blended total, and never a number from a test-router run.

## If something fails
- **Approval prompt does not appear or an action does something wrong**: press Esc at once, say "that is exactly why it is
  stoppable", show the replay of what it did, and continue with the next beat. Do not retry the same beat on camera more than once.
- **0G is down** (the pill says it cannot reach the private model): that IS the safety demo. Say "no local fallback, it stops and
  tells me", show the refusal and the replay line, then do the form beat from the recorded clip.
- **YouTube misbehaves** (consent page, ad, layout): switch to `act-media.html` and say "play the second video". Same loop, no network.
- **Desktop executor fails**: stay in the browser version; skip the TextEdit line.
- **Everything fails**: play the pre-recorded clip of the same script. Record it in a window when 0G is up, and say in the
  video that it is a recording.
