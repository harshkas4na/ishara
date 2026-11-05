# Desktop adapter

Lets the tutor work on any macOS app, not only the browser. `ishara-ax` turns the frontmost window into the
same Outline the extension produces (`{url, viewport, elements, text}`, ids `b0..`), so the gate and both sealed
0G calls are unchanged. `ishara-overlay` then draws the pointer ring and the answer sentence on screen.

Nothing but the question and the outline text leaves the machine. No screenshot is ever sent or written to disk:
when the Accessibility tree is thin, the window is captured in memory, read by Apple's on-device Vision OCR, and
the pixels are dropped; only the recognised text goes into the outline.

## Build
```
swiftc -O -swift-version 5 desktop/ishara-ax.swift -o desktop/ishara-ax
swiftc -O -swift-version 5 desktop/ishara-overlay.swift -o desktop/ishara-overlay
```
No dependencies. The binaries are gitignored. `helper/src/desktop.ts` exports `desktopOutline()`,
`overlay.send(cmd)`, `desktopAsk(question, decideFn)` (pass the same `decide` the browser route uses) and
`warmDesktop()`.

## Permissions (grant to the app that launches it, e.g. Terminal, iTerm, VS Code; or to the binary if you run it directly)
- **Accessibility** (System Settings > Privacy & Security > Accessibility): required. Without it `ishara-ax`
  exits 2 and prints which permission and where; `desktopOutline()` throws that as a readable message.
- **Screen & System Audio Recording**: only for the OCR fallback. Without it OCR is skipped with a warning and
  the outline is AX only.
The overlay needs no permission.

## Try it
```
node scripts/desktop-demo.ts --outline-only --app "System Settings"   # outline, no 0G
sleep 3; node scripts/desktop-demo.ts "where is the search box"       # real decide(), draws the answer
echo '{"cmd":"point","x":700,"y":400,"text":"Here."}' | desktop/ishara-overlay
```
Overlay commands: `point{x,y,text}`, `ask{text}`, `stop{text,sub}`, `clear`. Coordinates are screen points,
top-left origin. It hides itself after 12 s.

## Measured (M-series, macOS 27, 1470x956 points)
- AX walk: System Settings 33 labelled controls in 0.49 s. Finder with no window open: 0 (desktop only).
- OCR (accurate): 0.4-0.5 s warm, 23-31 lines on a full-screen terminal. **First call after boot: 56 s** (model
  load; the lab saw 12.7 s). Call `warmDesktop()` at helper start or the first question will hit the 6 s timeout.
- OCR is used when AX yields fewer than 25 labelled elements (`--ocr always|never` overrides).
- Overlay point landed within 2-3 points of the requested position on a Retina screen (screenshot checked).

## Known limits
- Apps with no AX tree (some Electron/canvas/games) fall back to OCR: only text, role `text`, no knowledge of
  what is clickable. The model can still point at a label next to a control.
- Several displays: the overlay spans all screens; OCR captures the display holding the window centre only.
  Not tested with two monitors.
- Full-screen apps and other Spaces: the overlay joins all Spaces; not tested over every full-screen app.
- Elements outside the visible window, scrolled-off rows and the menu bar are skipped on purpose.
- Rects are screen points, not window-relative; `viewport` is the window size.
- Password fields are labelled `(password)` and their value is never read.
