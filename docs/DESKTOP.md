# Desktop adapter

Lets the tutor work on any macOS app, not only the browser. `ishara-ax` turns the frontmost window into the
same Outline the extension produces (`{url, viewport, elements, text}`, ids `b0..`), so the gate and both sealed
0G calls are unchanged. `ishara-overlay` then draws the tutor on screen: the same needle cursor, ripple and hand-drawn marker as
the browser overlay (`extension/overlay.js`), so it feels the same in every app.

Nothing but the question and the outline text leaves the machine. No screenshot is ever sent or written to disk:
when the Accessibility tree is thin, the window is captured in memory, read by Apple's on-device Vision OCR, and
the pixels are dropped; only the recognised text goes into the outline.

## Build
```
swiftc -O -swift-version 5 desktop/ishara-ax.swift -o desktop/ishara-ax
swiftc -O -swift-version 5 desktop/ishara-overlay.swift -o desktop/ishara-overlay
swiftc -O -swift-version 5 desktop/ishara-ptt.swift -o desktop/ishara-ptt
```
(`npm run desktop:build` does all three.)
No dependencies. The binaries are gitignored. `helper/src/desktop.ts` exports `desktopOutline()`,
`overlay.send(cmd)`, `desktopAsk(question, decideFn)` (pass the same `decide` the browser route uses) and
`warmDesktop()`.

## Permissions (grant to the app that launches it, e.g. Terminal, iTerm, VS Code; or to the binary if you run it directly)
- **Accessibility** (System Settings > Privacy & Security > Accessibility): required. Without it `ishara-ax`
  exits 2 and prints which permission and where; `desktopOutline()` throws that as a readable message.
- **Screen & System Audio Recording**: only for the OCR fallback. Without it OCR is skipped with a warning and
  the outline is AX only.
- **Input Monitoring** (Privacy & Security > Input Monitoring): required for push-to-talk, so the key tap can see
  the chord. The tap is listen-only; it can not change or swallow a key.
- **Microphone** (Privacy & Security > Microphone): required for push-to-talk. Without either, `ishara-ptt` prints
  `{"ev":"error","code":"input-monitoring"|"microphone",...}` naming the permission, the overlay shows it once, and it
  is not restarted. Grant it to the app that launched node, then restart the helper.
The overlay needs no permission.

## Push-to-talk (any app)
Hold **Control+Option+Space**, speak, release. The overlay shows "Listening…" with a level meter while you hold,
then "Transcribing…", then "I heard: “…” …thinking", then the answer (cursor, marker, or bubble). The browser
extension keeps Option+Space, so the two never collide. Change the chord with `ISHARA_PTT_KEY=ctrl+opt+k`
(modifiers ctrl/opt/cmd/shift plus one key; at least one modifier is required).
```
npm run desktop:build
npm run helper:desktop        # ISHARA_DESKTOP=1 ISHARA_DEV=1; starts the key daemon only in this mode
curl 127.0.0.1:7777/desktop/ptt   # {"running":true,"chord":"ctrl+opt+space"} or lastError
```
Same refusals as the browser: under 0.25 s is "too short", a take quieter than RMS 0.006 is "I could not hear any
sound", and Whisper's stock noise phrases (you, thanks, ok, dots, under 3 characters) are shown, not sent to 0G.
Audio lives in memory only, goes to the local Whisper server, and is never written to disk. `ISHARA_PTT_DEBUG=1`
logs every key event to stderr.

Limits: the tap can not swallow keys, so the focused app still sees Control+Option+Space (most apps ignore it; a
few may insert a space). Releasing a modifier first ends the take. A second question while one is running is not
queued. Built-in mics pick up room noise: speak close, and expect a speaker-to-mic test to transcribe poorly.

## Try it
```
node scripts/desktop-demo.ts --outline-only --app "System Settings"   # outline, no 0G
sleep 3; node scripts/desktop-demo.ts "where is the search box"       # real decide(), draws the answer
echo '{"cmd":"point","x":700,"y":400,"text":"Here.","rect":{"x":640,"y":385,"w":120,"h":30}}' | desktop/ishara-overlay
```
Overlay commands (one JSON per line on stdin; coordinates are screen points, top-left origin):
- `point{x,y,text,rect?}`: the cursor glides (0.75 s ease-out, from wherever it is) to x,y, two saffron ripples,
  then, if `rect{x,y,w,h}` is given, a hand-drawn saffron marker is inked like a pen (0.6 s): a wobbly loop for
  small targets, a wavy underline for wide ones (w > 420 or h > 150). The cursor then bobs. No `rect`: cursor and
  ripple only. `decisionToOverlay` always sends the element's rect.
- `think{text}`: bubble plus the cursor tracing a figure-eight at 55% of the screen height, centred, on the screen
  the active window is on. `desktopAsk` sends it before reading the outline, so it dances while 0G answers.
  The next `point` glides from the cursor's current spot. Auto-hides after 30 s if nothing follows.
- `ask{text}`: bubble only. `stop{text,sub}`: red bubble (safe-stop). `clear`: hide everything.

Look: needle cursor (indigo to violet, white stroke, saffron tip dot is the hotspot), saffron ripples and ink,
bubble #1f1147 (stop #7f1d1d). Answers hide after 12 s; it is click-through and never takes focus.
With Reduce Motion on (System Settings > Accessibility > Display) there is no dance, glide, ripple, pen
stroke or bob: the final state just appears.

## Measured (M-series, macOS 27, 1470x956 points)
- AX walk: System Settings 33 labelled controls in 0.49 s. Finder with no window open: 0 (desktop only).
- OCR (accurate): 0.4-0.5 s warm, 23-31 lines on a full-screen terminal. **First call after boot: 56 s** (model
  load; the lab saw 12.7 s). Call `warmDesktop()` at helper start or the first question will hit the 6 s timeout.
- OCR is used when AX yields fewer than 25 labelled elements (`--ocr always|never` overrides).
- Overlay point (old ring) landed within 2-3 points of the requested position on a Retina screen (screenshot checked).

## Known limits
- Apps with no AX tree (some Electron/canvas/games) fall back to OCR: only text, role `text`, no knowledge of
  what is clickable. The model can still point at a label next to a control.
- Several displays: the overlay spans all screens; OCR captures the display holding the window centre only.
  Not tested with two monitors.
- Full-screen apps and other Spaces: the overlay joins all Spaces; not tested over every full-screen app.
- Elements outside the visible window, scrolled-off rows and the menu bar are skipped on purpose.
- Rects are screen points, not window-relative; `viewport` is the window size.
- Password fields are labelled `(password)` and their value is never read.
