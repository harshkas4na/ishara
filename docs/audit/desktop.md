# Desktop path audit (hotkey, overlay, outline)

Date 2026-11-06, macOS 27.2, built-in Retina display (1470x956 points), one display. Labels: **measured** (I ran it), **inferred** (read from code, not run), **unknown**.
Nothing in product code was changed. The helper on :7777 and its own daemon and overlay were left running; every experiment used separate copies of the binaries.

## 1. The complaint: Control+Option+Space "overlays everything"

### Hypothesis (macOS input-source shortcut): refuted on this Mac
- measured: `AppleSymbolicHotKeys` 60 (Ctrl+Space, params 32/49/262144) and 61 (Ctrl+Opt+Space, params 32/49/786432) are both `enabled = 0`.
- measured: only one keyboard layout is enabled (U.S.), plus the Character Palette and PressAndHold input methods. There is no second language to switch to.
- measured: I posted a real Ctrl+Opt+Space (CGEvent, 3 s hold) and screenshotted the top of the screen while held. No input-source picker, no OS overlay. The only thing drawn was Ishara's own "Listening…" bubble.
- Spotlight (64) and Finder search (65) have no entry in the plist, so they are at defaults (Cmd+Space, Cmd+Opt+Space). Ctrl+Opt+Space does not match either.
- inferred: on a Mac with 2+ input sources and keys 60/61 enabled the hypothesis would be true, so the docs should warn about it. It is not what happened here.

### What the evidence does show (three independent causes, most likely first)
1. **The daemon crashes on key-down (measured, root cause of "something weird").** `/tmp/ishara-helper.log` holds a crash from my first synthetic press: `NSException com.apple.coreaudio.avfaudio: Failed to create tap due to format mismatch, <AVAudioFormat 1 ch, 16000 Hz, Float32>` in `Recorder.start` called from `chordDown` (ishara-ptt.swift). The process was replaced by the helper's restart (pid changed 30684 -> 3363). A second press worked. Cause (inferred from the stack and the code): `Recorder` keeps one `AVAudioEngine` for the life of the daemon and passes `input.outputFormat(forBus:0)` to `installTap`; when the input device or its format changes (the machine has virtual/aggregate inputs at 16/48/96 kHz and a mic that Brave, Handy, or a call app can reconfigure) the cached format no longer matches the hardware, AVFoundation throws an Objective-C exception, and Swift cannot catch it. User-visible result: the keys do nothing, then the next press works, or the bubble appears late. That is a "weird" press.
2. **The browser extension fires on the same chord (inferred from code, not run; unknown whether the extension is loaded in his browser).** `extension/content.js` treats `e.altKey && e.code === "Space"` as its push-to-talk and never checks `ctrlKey`/`metaKey`. With the extension loaded and a web page focused, Ctrl+Opt+Space starts the page overlay, the mic in the offscreen document, and the desktop daemon at the same time: two "Listening…" overlays (page + desktop), two recordings, two Whisper calls, two 0G calls. `docs/DESKTOP.md` says "the two never collide"; that is wrong, they share Option+Space. The in-frame chord detector (top of content.js, `CHORD`) has the same flaw.
3. **The desktop bubble is anchored top-centre over the menu/tab strip (measured).** "Listening…", "Transcribing…", the answer and every `ask` bubble sit at y=40 in the middle of the screen. They hide browser tabs or a terminal's tab bar while you hold the keys, which reads as "I cannot see the thing".

### Is our overlay opaque or dimming? No (measured, and read from code)
- ishara-overlay.swift: borderless window spanning all screens, `isOpaque = false`, `backgroundColor = .clear`, `ignoresMouseEvents = true`, `level = .screenSaver`, `collectionBehavior = [canJoinAllSpaces, fullScreenAuxiliary, stationary, ignoresCycle]`, activation policy `.accessory` (cannot become key or steal focus). The only drawn content is the needle cursor, ripples, ink, and a 296-320 pt wide bubble. The `think` state draws only the bubble and a figure-eight cursor; nothing covers the screen.
- measured: screenshots with the bubble up, with a `point` + ink loop (landed on the target, no offset, no dimming), and with a real `ask` answer. The rest of the screen is untouched.
- unknown / not tested: full-screen apps (needs a full-screen Space; `fullScreenAuxiliary` + `.screenSaver` level should show over them), a second display (only one attached; the code unions all screens and handles origin, but `think` centres on the active window's screen and the bubble always uses the union centre, so on two displays the bubble can land on the wrong screen or straddle the seam: inferred).
- Verdict: the "overlaid" symptom is **not** from a macOS shortcut on this machine and **not** from a dimming/opaque overlay of ours. Most probable: the crash/restart behaviour above, plus (if the extension is loaded) a second overlay from the page. I could not reproduce a full-screen cover.

### Other macOS shortcuts checked
Cmd+Space Spotlight, Cmd+Opt+Space Finder search (defaults, enabled), Ctrl+Cmd+Space emoji picker, Globe/Fn (emoji or dictation by default; `AppleFnUsageType` is unset, so the system default applies), Ctrl+Space / Ctrl+Opt+Space input sources (disabled here), Sticky Keys and Slow Keys (both off). Siri and dictation are bound to Fn or Cmd-hold by default.

## 2. Alternative triggers (tested with the real daemon)

| Trigger | Collides with | Result |
| --- | --- | --- |
| Ctrl+Opt+Space (current) | input-source shortcut when enabled; extension Option+Space (code); crashes the daemon on a format change | down/level/up arrive (measured), but see section 1 |
| Ctrl+Opt+Cmd+Space | none found (not Spotlight, not emoji) | measured: down, 18 level events, up; screenshot at the 1.2 s mark showed no OS reaction. Four-key chord is awkward to hold |
| Hold **Right Option** alone, after 350 ms | nothing on a US layout; extension only reacts to Alt+Space, and its Alt keyup just calls `stopTalking()` (harmless) | measured with a prototype (below): 200 ms tap ignored, 1.5 s hold gave down + level + up with audio, Option+A ignored, Left Option hold ignored, Ctrl+Opt+Space ignored. Screenshot during the hold: no OS reaction |
| Fn / Globe | OS emoji / dictation / input-source action by default | rejected without a full test. inferred: an event tap sees `flagsChanged` keyCode 63 with `maskSecondaryFn`, but the OS action cannot be suppressed by a listen-only tap, and synthetic Fn events are not trustworthy |
| F-keys | media/brightness defaults unless Fn held, and many apps bind F5/F8 | rejected (inferred) |

**Modifier-only is NOT supported today.** `parseChord` in ishara-ptt.swift requires one non-modifier key and at least one modifier. Prototype (kept in the scratchpad, not in the repo) was a ~15-line change:
- accept `ISHARA_PTT_KEY=ropt`;
- on `flagsChanged` with keyCode 61 and device flag `0x40` set and no ctrl/cmd/shift: arm a 350 ms `DispatchWorkItem` that calls `chordDown()`;
- on any `keyDown` cancel the pending work item (it was Option used for typing a symbol);
- on `flagsChanged` where Right Option is released: cancel and `chordUp()`.
Caveat measured while testing: a synthetic event without the `0x40` device bit is ignored, so tests must set it (real keyboards do). Mouse clicks while Option is held (Option-click, Option-drag) should also cancel the pending start: add `leftMouseDown` and `scrollWheel` to the tap mask (inferred, not run).

**Recommended default: hold Right Option (350 ms).** It is one key, comfortable with the right thumb, collides with no macOS default or extension chord, and normal Option typing (Option+key symbols) is unaffected. Keep `ctrl+opt+cmd+space` as the documented fallback for keyboards without a right Option. Remove Ctrl+Opt+Space as the default.

## 3. Whole flow with the real router (measured)
- `node scripts/desktop-demo.ts --outline-only --app "System Settings"`: 40 elements (ax 40 of 179 nodes), 1.3-1.8 s, OCR skipped.
- Real `desktopAsk`: `"where is the tab bar"` on Terminal -> `ask_which`, "This one or that one?", outline 1.9 s + decide 5.6 s = 7.6 s. `"where is the heading that says Running now"` -> `ask`, "Which step do you mean?", total 5.8 s. 0G is reachable and the bubble draws; the gate chose to ask both times because the OCR outline is a flat list of text lines. Answers are never spoken (no TTS call in desktop-ptt.ts or desktop.ts: inferred from code).
- **Bug in `scripts/desktop-demo.ts` (measured):** the question is `argv.filter((a, i) => !a.startsWith("--") && i !== ai + 1)`. With no `--app`, `ai = -1`, so index 0 is dropped and the question is empty: `node scripts/desktop-demo.ts "where is the search box"` (the command printed in docs/DESKTOP.md) silently runs outline-only. It works only with `--app X "question"`.

## 4. Outline quality on real apps (measured, `ishara-ax outline --app ...`)
| App | Elements | Source | Labels / text | Time |
| --- | --- | --- | --- | --- |
| System Settings | 40 (38 buttons, 1 input, 1 text) | AX | good control labels; page body text mostly absent (text field 1043 chars) | 1.3 s |
| Finder (no window) | 40 text | OCR of the desktop | AX 0 of 5 nodes; OCR read wallpaper/desktop text | 1.6 s |
| Terminal | 42 text | OCR (AX gives 1 node) | readable lines, each cut at 80 chars | 1.4 s |
| Brave | 37 (22 buttons, 14 selects, 1 input) | AX | **browser chrome only** (tabs, address bar, extensions, bookmarks); the web page content was not captured. The tab titles go into the outline, including private ones (an inbox subject with a login code was one of them) | 0.3 s |
| Notes | not running | n/a | skipped | n/a |

Every app returns exactly 38-42 elements, so a cap near 40 applies somewhere after the 150 cap in ishara-ax.swift (unknown where; `cap = 150` at line 264 is not it). Page body of a browser window is the biggest gap: the OCR fallback is only used when AX has fewer than 25 labelled elements, and Brave reaches 37, so OCR never runs.

Pointing check (measured): `point` with a rect at a Terminal OCR element landed the cursor tip and the hand-drawn loop exactly on the text on the Retina display (menu-bar offset and scale correct on a single display). Second display: unknown, no second display.

## 5. Other fragile or broken things
- **Daemon crash on audio format change** (section 1). Biggest bug. Helper restarts it with backoff 1 s up to 30 s, so the next press may work, but the take is lost and the user sees nothing.
- **Slow first take (measured):** first press after daemon start took ~0.7 s to produce the first level event (cold `AVAudioEngine`), later ones ~0.4 s. Speech in the first half second is lost.
- **No `up` guard if the tap is disabled** is handled (`tapDisabledByTimeout` ends the take). Good.
- **Permissions:** Input Monitoring / Microphone errors are fatal and never retried, shown once in the overlay; after granting, the helper must be restarted. A non-fatal crash (above) is retried. Not tested: revoking permission mid-run.
- **OCR cold start:** DESKTOP.md records 56 s on first OCR after boot against a 6 s `AX_TIMEOUT_MS`. server.ts calls `warmDesktop()` at start (90 s timeout), so only a question asked in the first minute after the helper starts is at risk (inferred). Today OCR ran in 0.8-1.4 s warm (measured).
- **No spoken answers, no typed question, no follow-ups on desktop** (inferred from code: only voice via ptt -> `desktopAsk`; each take is independent; `busy` rejects a second take with "Still answering").
- **Bubble placement**: always top-centre for `think`/`ask`/`stop`; the 12 s auto-hide is fine but a `Listening…` bubble can stay up to 30 s if the daemon dies mid-take (inferred from `armHide(30)`).
- **Docs say the chord never collides with the extension**: false.
- The ptt daemon logs only the chord's own events with `ISHARA_PTT_DEBUG=1`; fine.

## 6. Recommended changes (file, what, status)
1. `desktop/ishara-ptt.swift`, `Recorder`: create a fresh `AVAudioEngine` for every take, call `installTap(onBus:0, bufferSize:2048, format:nil)` or use `input.inputFormat(forBus:0)`, and bail out with an `error` event if `sampleRate == 0`; also observe `AVAudioEngineConfigurationChange` and restart the take. Removes the NSException (the crash is measured; the fix is inferred).
2. `desktop/ishara-ptt.swift`: add the Right Option modifier-only mode (`ropt`), 350 ms hold, cancel on any key down, mouse down or scroll; make it the default. Prototype behaviour measured.
3. `helper/src/desktop-ptt.ts`: nothing to parse (the chord string is passed through env); set `ISHARA_PTT_KEY` default there or in the daemon. Show "Listening…" only after `down`, as now.
4. `extension/content.js` (both `onKeyDown` and the child-frame `CHORD`): require `!e.ctrlKey && !e.metaKey` so Option+Space remains the extension's alone; this is needed even if the desktop default moves, because Ctrl+Opt+Space is documented as the fallback.
5. `desktop/ishara-overlay.swift`: place listening/answer bubbles near the cursor or the bottom of the active screen, on the active screen (not the union centre); keep it click-through. Optional: a thin top-edge "listening" dot instead of a bubble that covers the tab strip.
6. `desktop/ishara-ax.swift`: run OCR when the frontmost app is a browser (or when the AX text is under N characters) and drop tab-title buttons from the outline; find the ~40 element cap.
7. `scripts/desktop-demo.ts`: fix the question filter (`ai >= 0 ? i !== ai + 1 : true`).
8. `docs/DESKTOP.md`: document the new default, the modifier-only mode, the input-source shortcut warning (60/61), and remove "the two never collide".

## 7. Test plan
- Synthetic keys: `CGEvent` poster with the right-Option device bit (0x40) set; cases: 200 ms tap (no take), 1.5 s hold (down/level/up with samples), Option+A (no take), Left Option hold (no take), Ctrl+Opt+Space (no take), repeated holds 5x (no crash).
- Crash regression: change the default input device (or switch an aggregate device) between two holds; the daemon must stay alive and the second take must have audio.
- Extension: in a browser with the extension loaded, hold Ctrl+Opt+Space and confirm only one "Listening…" overlay appears.
- Overlay: screenshots with a full-screen Space app and with a second display attached; bubble must be on the active screen and nothing dims.
- Outline: a Brave window with a long page, Notes with a note open, Finder with a window; the elements must include page body text.
- Hands-on with Harsh: press Right Option for one second near a quiet room and say a sentence; expect the bubble and a transcript.
