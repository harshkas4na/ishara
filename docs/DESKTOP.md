# Desktop adapter

Lets the tutor work on any macOS app, not only the browser: the same streaming tutor as the extension (explain, point,
guide with steps, follow-ups, Hinglish) with spoken answers. `ishara-ax context` turns the frontmost window into a
`PageContext` (docs/TUTOR-INTERFACE.md section 1: `source: "desktop"`, controls `b0..` with state, text blocks `t0..`,
selection, focus, alert text), `helper/src/desktop.ts` redacts it with the browser reader's rules and runs
`tutorTurn`, and `ishara-overlay` draws and the helper's speaker talks while the answer streams.
The old pointing-only path (`ishara-ax outline`, `desktopOutline`, `decisionToOverlay`) is kept for scripts.

Nothing but the question and the redacted context text leaves the machine. No screenshot is ever sent or written to
disk: when the Accessibility tree is thin, the window is captured in memory (that window only, never what is drawn over
it), read by Apple's on-device Vision OCR, and the pixels are dropped; only the recognised text goes into the context.

## Redaction (same rules as the browser)
Everything read from the screen passes `redact`, `neutralize` and `safeText` from `extension/blocks-core.js` before it
leaves the process. **One source of truth, not a port:** `helper/src/redact.ts` evaluates that very file in a `vm`
context (the way `helper/test/blocks.test.ts` does), so the two paths cannot drift; `desktop-tutor.test.ts` proves parity
on the same fixtures. Secure text fields (AXSecureTextField) are never read: the Swift side does not fetch their value,
and the context says only "filled, N chars". Secret-named fields (seed, private key, password, token, cvv...) report
state, not content; secret-shaped text (64 hex, 12/24-word phrases, `sk-`, `ghp_`, JWTs, long base64) becomes
`[redacted]`; `[POINT:`, `[STEP`, `[WAIT]` and the fence markers in screen text are replaced with look-alikes.
The context is trimmed to about 3,000 tokens (headings and in-view blocks first). Ids are stable across re-reads of the
same window (a signature book in `desktop.ts`), so a walkthrough's "next" finds its target by id.

## Browsers belong to the extension
A browser seen through Accessibility is only its own chrome and tab titles (private tabs included), never the page body.
When the frontmost app is one of `BROWSER_BUNDLE_IDS` (Chrome, Brave, Safari, Arc, Edge, Firefox, Opera, Vivaldi and
their variants; one tested constant in `desktop.ts`) the desktop path reads nothing, sends nothing, records nothing for
the model and shows "In the browser, use Option+Space". `ishara-ax front` (no permission, ~30 ms) answers "which app".

## Build
```
npm run desktop:build        # ishara-ax, ishara-overlay, ishara-ptt (swiftc -O -swift-version 5)
swiftc -O desktop/ptt-post.swift -o desktop/ptt-post     # optional: synthetic key poster for tests
```
No dependencies. The binaries are gitignored. `helper/src/desktop.ts` exports `desktopContext()`, `buildContext()`,
`desktopAsk(question, deps)` (browser guard, context, `tutorTurn`, overlay + speech per event), `eventToOverlay()`,
`overlay.send(cmd)` and `warmDesktop()`.

## Permissions (grant to the app that launches it, e.g. Terminal, iTerm, VS Code; or to the binary if you run it directly)
- **Accessibility** (System Settings > Privacy & Security > Accessibility): required. Without it `ishara-ax`
  exits 2 and prints which permission and where; the helper shows that as a readable message.
- **Screen & System Audio Recording**: only for the OCR fallback. Without it OCR is skipped with a warning.
- **Input Monitoring**: required for push-to-talk, so the key tap can see the key. The tap is listen-only; it can not
  change or swallow a key.
- **Microphone**: required for push-to-talk. A missing permission prints
  `{"ev":"error","code":"input-monitoring"|"microphone","fatal":true,...}`, the overlay shows it once, and the daemon is
  not restarted (grant it, then restart the helper). A runtime microphone failure (device vanished) prints
  `"fatal":false`: the overlay says so and the next hold tries again.
The overlay needs no permission.

## Push-to-talk (any app except a browser)
**Hold Right Option alone for about a second to talk, release to send.** The daemon starts a take only after Right Option
has been held 350 ms with no other key, click or scroll in between, so a tap, Option+letter (typing a symbol), Left
Option, Option-click and any chord with another modifier do nothing. At the 350 ms mark the overlay shows the Listening
bubble with a level meter; release, and it shows "Transcribing…", "I heard: “…” …thinking", then streams the answer
(cursor, marker, bubble, voice). Pressing the key again at any time cuts the voice and the running answer off.
No right Option on your keyboard? `ISHARA_PTT_KEY=ctrl+opt+cmd+space` (any modifiers plus one key; at least one
modifier). Do not use Ctrl+Option+Space: if the macOS input-source shortcuts (System Settings > Keyboard > Keyboard
Shortcuts > Input Sources) are enabled, macOS handles it first.
```
npm run desktop:build
npm run helper:desktop        # ISHARA_DESKTOP=1 ISHARA_DEV=1; starts the key daemon only in this mode
curl 127.0.0.1:7777/desktop/ptt   # {"running":true,"chord":"rightoption"} or lastError
```
Same refusals as the browser: under 0.25 s is "too short", a take quieter than RMS 0.006 is "I could not hear any
sound", and Whisper's stock noise phrases are shown, not sent. Audio lives in memory only, goes to the local Whisper
server, and is never written to disk. `ISHARA_PTT_DEBUG=1` logs key-state changes (never other keys) to stderr.

The microphone engine is built fresh for every take and installed with the input node's real format, so switching input
devices (AirPods connecting, a call app reconfiguring the mic) cannot crash the daemon; a device change during a take
rebuilds the engine and keeps the audio so far. The tap can not swallow keys, so the focused app still sees Right Option
(modifier-only: nothing visible). A walkthrough ("walk me through ...") continues with "next", "back", "repeat", "stop"
spoken as normal questions; its key is `desktop:<frontmost bundle id>`, so it survives turns in the same app and is
dropped for another app or after 10 idle minutes. A window-title change (a new page in Settings) resets follow-up memory.

## Try it
```
node scripts/desktop-demo.ts --context --app "System Settings"          # PageContext summary, no 0G
node scripts/desktop-demo.ts --outline-only --app "System Settings"     # old outline, no 0G
sleep 3; node scripts/desktop-demo.ts "where is the search box"         # real tutor turn: streams, draws, speaks
curl -s 127.0.0.1:7777/desktop/ask -d '{"question":"what is this window for"}'   # same, through the helper
echo '{"cmd":"say","text":"Hello.","append":false}' | desktop/ishara-overlay
```
Overlay commands (one JSON per line on stdin; coordinates are screen points, top-left origin):
- `point{x,y,text,rect?,keep?}`: the cursor glides (0.75 s ease-out) to x,y, two saffron ripples, then, with `rect`, a
  hand-drawn marker (loop, or wavy underline for wide targets). `keep:true` leaves the streamed bubble text alone and only
  moves the bubble next to the target.
- `think{text}`: bubble plus the cursor tracing a figure-eight at 55% of the screen height (idempotent: repeated calls,
  e.g. the Listening meter, only update the text). Auto-hides after 30 s.
- `say{text,append}`: one streamed sentence; `append:false` starts a fresh answer. The bubble keeps the newest sentences
  when it outgrows its height.
- `step{n,m}`: header "Step n of m". `done`: linger 15 s, then fade; a cursor that never pointed goes away.
- `ask{text}`: bubble. `stop{text,sub}`: red bubble (safe-stop, refused). `clear`: hide everything.

Look: needle cursor, saffron ripples and ink, bubble #1f1147 (stop #7f1d1d) with a small "Ishara" label, 420 pt wide,
wrapping. Placement: next to the pointed target (below it, above it at the screen edge, beside it for a tall target,
never over it), else bottom-centre about 120 pt above the screen bottom; on the screen that holds the target or the
frontmost window. Click-through, never takes focus. With Reduce Motion on there is no dance, glide, ripple, pen stroke
or bob: the final state just appears.

## Measured (M-series, macOS 27, 1470x956 points)
- AX walk: System Settings 39 controls in about 0.2 s; context incl. window-only OCR 0.5 s. Finder with no window: 0.
- OCR (accurate): 0.3-0.5 s warm. **First call after boot: 56 s** (model load). `warmDesktop()` runs at helper start.
- OCR runs when AX yields fewer than 25 labelled items or under 300 characters of prose.
- PTT: recorder start 100-130 ms after the 350 ms mark; ten holds in a row and input-device switches (also mid-hold)
  caused no crash.

## Known limits
- Apps with no AX tree (some Electron/canvas/games) fall back to OCR: text blocks only, no controls.
- Several displays: the bubble and cursor go on the screen with the target or the frontmost window (code path; not
  tested with two monitors). The overlay window is sized at launch: a display attached later needs an overlay restart.
- Full-screen apps and other Spaces: the overlay joins all Spaces; not tested over every full-screen app.
- Elements outside the visible window, scrolled-off rows and the menu bar are skipped on purpose (text areas keep
  their off-screen paragraphs as `inView:false` blocks).
- Rects are screen points, not window-relative; `viewport` is the window size.
