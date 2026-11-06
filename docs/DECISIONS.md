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

## 8. The test router (development only, not a fallback)
While the real sealed models were down for every team at the event, `test/fake-router/server.ts` stands in for the
0G Router so the whole chain (extension, helper, gate, pointer, memory, episode log) can be exercised. It picks by
word overlap, so it tests mechanics only and says nothing about 0G's accuracy. The helper uses it only when
`ISHARA_ROUTER_URL` is set to a 127.0.0.1 or localhost address (anything else is ignored with a warning), never sends
the real key to it, and marks every result `testRouter: true`: an amber banner and "(test router)" in the extension,
a TEST ROUTER chip in the replay, `/health`, and a banner in `scripts/eval.ts`. Eval numbers may be quoted only from
a run against the real router; a test-router run writes to `helper/.data/eval-test-router.json`, not the results file.

## 9. From "find this field" to a tutor (6 Nov)
Harsh tested the real build and said it was not a tutor. The audit (`docs/audit/product-gap.md`) measured it: of 20 real
questions on 4 pages, 7 pointed, 13 got "which step do you mean?", and 0 explained anything. The model only ever saw controls
and headings, was told to write one short sentence plus exactly one pointer, and had no conversation memory.
What changed: a new streaming route `POST /tutor` (contract: `docs/TUTOR-INTERFACE.md`) with four modes (point, explain, guide,
follow-up), a page reader that sends visible text, field state and error messages, and conversation memory per page. The old
`/decide` pointing path is untouched: its eval (11/12 clear, 0 wrong points, 6/6 vague) must not regress and has not.

## 10. Page text now goes to the sealed model, with secrets removed first
Explaining a page needs its text. So the "only the question and a control list leave the laptop" claim changed to: the
question plus the page's visible text, only to sealed providers, after redaction in the tab (password fields, seed/key/token
fields, anything shaped like a secret, inputs reported as "filled, 38 chars" instead of their value). Still no audio and no
screenshot. Page text is untrusted data: fenced with a random delimiter, marker look-alikes neutralized, the model has no tools
and can only speak and request a pointer. Residual risk, stated plainly: a hostile page can still make the tutor say something
wrong. It cannot act.

## 11. laya checks each pointer against the sentence that carries it
In explain and guide the user's question is not about one control, so asking laya "is this what the user asked for?" vetoed
correct pointers (a right guide step scored p=0.32). Asking whether the highlighted control is the one the spoken sentence
refers to scored 0.91 for the right target and 0.00-0.05 for wrong ones. Cost: laya now confirms whatever the model's sentence
says, so a prompt-injected "click Sign in" depends on the model not repeating it (6/6 injection cases pass, enforced by the
prompt, not the gate). Threshold stays 0.4. Open item for review.

## 12. Hinglish voice input
Whisper was pinned to English, so Hindi mixed with English came out as plausible wrong English. A local Hinglish model with
`-l en -ac 512` cut word error on synthetic Hinglish from 67% to 28% (English stays 0%) at about 0.4 s per clip. Measured on
synthetic voices only; Harsh's own recordings are the real test (`voice-samples/README.md`).

## 13. Spoken answers are local
Kokoro-82M (voice af_heart) on the laptop, first audio about 0.3 s for a short answer, played by the helper so browser and
desktop both speak. Nothing leaves the machine. Mute with Option+Shift+M.

## 14. Still no screenshots; tool calling parked
A screenshot to the sealed end-to-end encrypted model fixed visual questions the text path got wrong (+1.2 s), but changing the
privacy claim is Harsh's call and is deferred. Tool calling and web search are parked (0GM supports tools in Private mode:
verified), because a search leaves the sealed boundary.

## 15. Agent mode, and how it was hardened (6 Nov, audit 4)
Decision 14 parked tool calling; the 0G booth asked for control, so Agent mode shipped (`docs/AGENT-MODE.md`): 0GM plans one
tool call per step, laya checks each target, local executors act. An adversarial audit (`docs/audit/AUDIT-4-2026-11-06.md`)
then broke it in ways the unit tests did not cover, and these changed:
- **Approve lives outside the page.** The pill was in the page's DOM and Y approved: a page could hide it, show a fake one and
  ask for Y. Approve/Deny is now an extension window; Option+Shift+X is a browser command no page can swallow.
- **Unknown means ask.** A deny-list of commit words missed empty labels, other languages, look-alike letters and "Cancel
  subscription". Now any button whose whole label is not a known look-around asks, on any page.
- **Only the person's words count.** Notes from earlier pages had been appended to the task and then counted as the person
  naming a control. They now travel separately, inside the fence.
- **Caps per task, not per page**, through a `taskId`; arming per tab with a 10-minute idle timeout; resume refuses when
  disarmed or stopped.
- **Data out needs a tap**: text the person did not give, and search or link words they did not say.
Cost: more Approve taps (a "Continue" with no form asks now). Not measured on the real router yet: 0G was down.
