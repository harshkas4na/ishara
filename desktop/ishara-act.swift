// ishara-act: the desktop executor of Agent mode (docs/AGENT-MODE.md). Reads ONE JSON action on stdin, does it, prints ONE
// JSON result {ok, detail, ...} on stdout, exits 0 (exit 2 = a macOS permission is missing, with ISHARA_PERMISSION on stderr).
//
// Why it re-finds the target instead of taking a pointer: an AXUIElement dies between process runs, and the window may have
// shifted since ishara-ax read it. The helper therefore sends a STABLE selector (mapped role + label + the index among
// same-labelled siblings in reading order + the window title) with a rect only as a hint, and this program walks the front
// window with the SAME rules as `ishara-ax context` (same labels, same visibility filter, same order) so index N here is
// the control the model saw as index N there.
//
// Actions: press, setvalue, check, key, scroll, click_at, open_app, quit_app, open_url, copy, screenshot, front.
// Everything is local. Screenshots and clipboard text are never sent anywhere. Secret fields are refused outright.
//
// Build: swiftc -O -swift-version 5 desktop/ishara-act.swift -o desktop/ishara-act
import AppKit
import ApplicationServices

// ---------- output ----------
func emit(_ o: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
    FileHandle.standardOutput.write(d + "\n".data(using: .utf8)!)
}
func finish(_ ok: Bool, _ detail: String, _ extra: [String: Any] = [:]) -> Never {
    var o = extra; o["ok"] = ok; o["detail"] = detail
    emit(o); exit(0)
}
func fail(_ detail: String, _ extra: [String: Any] = [:]) -> Never { finish(false, detail, extra) }
func needPermission(_ what: String, _ fix: String) -> Never {
    FileHandle.standardError.write("ISHARA_PERMISSION: \(what)\n\(fix)\n".data(using: .utf8)!)
    emit(["ok": false, "detail": "Missing permission: \(what). \(fix)", "permission": what])
    exit(2)
}

// ---------- input ----------
let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let inp = (try? JSONSerialization.jsonObject(with: inputData)) as? [String: Any], let kind = inp["type"] as? String else {
    fail("input is not a JSON action with a \"type\"")
}
func str(_ k: String) -> String? { inp[k] as? String }
func num(_ o: [String: Any], _ k: String) -> Double? { (o[k] as? NSNumber)?.doubleValue }

// ---------- browsers belong to the extension (same list as helper/src/desktop.ts BROWSER_BUNDLE_IDS) ----------
let browserIds: Set<String> = [
    "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "org.chromium.Chromium",
    "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly", "com.apple.Safari", "com.apple.SafariTechnologyPreview",
    "company.thebrowser.Browser", "company.thebrowser.dia", "com.microsoft.edgemac", "com.microsoft.edgemac.Beta",
    "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary", "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition",
    "org.mozilla.nightly", "com.operasoftware.Opera", "com.operasoftware.OperaGX", "com.operasoftware.OperaNext",
    "com.vivaldi.Vivaldi", "com.duckduckgo.macos.browser", "app.zen-browser.zen", "com.openai.atlas",
]
let frontApp = NSWorkspace.shared.frontmostApplication
let frontBundle = frontApp?.bundleIdentifier ?? ""
let frontIsBrowser = browserIds.contains(frontBundle)

// ---------- AX helpers ----------
func axAttr(_ e: AXUIElement, _ k: String) -> CFTypeRef? {
    var v: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, k as CFString, &v) == .success ? v : nil
}
func axStr(_ e: AXUIElement, _ k: String) -> String {
    if let s = axAttr(e, k) as? String { return s }
    if let n = axAttr(e, k) as? NSNumber { return n.stringValue }
    return ""
}
func clean(_ s: String) -> String { s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ") }
func clip(_ s: String) -> String { s.count > 80 ? String(s.prefix(79)) + "…" : s }
func norm(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }
func frame(_ e: AXUIElement) -> CGRect? {
    guard let pv = axAttr(e, kAXPositionAttribute), let sv = axAttr(e, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}
func isSecureRole(_ role: String, _ sub: String) -> Bool { role == "AXSecureTextField" || sub == "AXSecureTextField" }
// A field whose NAME says it holds a secret is refused even if it is a plain text field (the helper checks this too).
let secretWords = try! NSRegularExpression(pattern: "pass(word|code|phrase)|secret|seed|mnemonic|private.?key|api.?key|token|cvv|cvc|card.?number|\\bpin\\b|\\botp\\b", options: [.caseInsensitive])
func looksSecret(_ s: String) -> Bool { secretWords.firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) != nil }

func needAX() {
    guard AXIsProcessTrusted() else {
        needPermission("Accessibility", "Open System Settings > Privacy & Security > Accessibility and switch on the app that launched this (Terminal, iTerm, VS Code, or the node/helper process, or this binary if run directly). Then run it again.")
    }
}
func refuseBrowser() -> Never { fail("use the browser extension") }

// ---------- key table ----------
let keycodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
    "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
    "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
    "enter": 36, "return": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
func parseCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
    var flags: CGEventFlags = []
    var key: CGKeyCode? = nil
    for raw in combo.lowercased().split(separator: "+", omittingEmptySubsequences: true).map({ String($0).trimmingCharacters(in: .whitespaces) }) {
        switch raw {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "ctrl", "control": flags.insert(.maskControl)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default:
            guard key == nil, let k = keycodes[raw] else { return nil }
            key = k
        }
    }
    guard let k = key else { return nil }
    return (k, flags)
}
let evSource = CGEventSource(stateID: .hidSystemState)
let typeSource = CGEventSource(stateID: .combinedSessionState)
// Spins the run loop instead of sleeping: NSWorkspace.frontmostApplication is only refreshed by a running run loop, so a
// plain usleep made "wait until it is frontmost" report a stale answer for the full 5 s.
func pause(_ ms: Int) { RunLoop.current.run(until: Date().addingTimeInterval(Double(ms) / 1000)) }
func postKey(_ code: CGKeyCode, _ flags: CGEventFlags) {
    // Modifiers are held through the event flags; a small gap between down and up keeps slow apps from dropping the press.
    guard let dn = CGEvent(keyboardEventSource: evSource, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: evSource, virtualKey: code, keyDown: false) else { return }
    dn.flags = flags; up.flags = flags
    dn.post(tap: .cghidEventTap); pause(15)
    up.post(tap: .cghidEventTap); pause(15)
}
// Typing a string: unicode events carry the character itself, so no keyboard layout assumptions. 12 UTF-16 units a time.
func typeString(_ s: String) {
    let units = Array(s.utf16)
    var i = 0
    while i < units.count {
        let chunk = Array(units[i..<min(units.count, i + 12)])
        i += chunk.count
        // Measured: events from the HID system source were dropped by TextEdit; the combined-session source, explicit empty
        // flags and the session tap are what delivered the characters.
        guard let dn = CGEvent(keyboardEventSource: typeSource, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: typeSource, virtualKey: 0, keyDown: false) else { return }
        dn.flags = []; up.flags = []
        dn.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        dn.post(tap: .cgSessionEventTap); pause(10)
        up.post(tap: .cgSessionEventTap); pause(10)
    }
}

// ---------- the non-AX actions ----------
func appURL(named name: String) -> URL? {
    if name.contains("."), let u = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return u }
    let want = name.lowercased().replacingOccurrences(of: ".app", with: "")
    for r in NSWorkspace.shared.runningApplications { if r.localizedName?.lowercased() == want, let u = r.bundleURL { return u } }
    let home = NSHomeDirectory()
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", "/System/Library/CoreServices/Applications", home + "/Applications"] {
        let fm = FileManager.default
        guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
        if let hit = items.first(where: { $0.lowercased() == want + ".app" }) { return URL(fileURLWithPath: dir + "/" + hit) }
    }
    // The Dock-style names people say ("settings") for the bundle that is called System Settings.
    let alias = ["settings": "System Settings", "system preferences": "System Settings", "preferences": "System Settings", "terminal": "Terminal", "notes": "Notes", "textedit": "TextEdit"]
    if let a = alias[want], a.lowercased() != want { return appURL(named: a) }
    return nil
}
func runningApp(_ name: String) -> NSRunningApplication? {
    let want = name.lowercased().replacingOccurrences(of: ".app", with: "")
    return NSWorkspace.shared.runningApplications.first {
        $0.activationPolicy == .regular && ($0.localizedName?.lowercased() == want || $0.bundleIdentifier?.lowercased() == want)
    }
}
func waitFront(_ app: NSRunningApplication, secs: Double) -> Bool {
    let end = Date().addingTimeInterval(secs)
    while Date() < end {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return true }
        pause(80)
    }
    return false
}

func doOpenApp() -> Never {
    guard let name = str("name") ?? str("bundleId"), !name.isEmpty else { fail("open_app needs a name") }
    if let r = runningApp(name) {
        r.activate(options: [.activateIgnoringOtherApps])
        let ok = waitFront(r, secs: 5)
        finish(ok, ok ? "\(r.localizedName ?? name) is in front" : "\(r.localizedName ?? name) is running but did not come to the front in 5 s")
    }
    guard let url = appURL(named: name) else { fail("no app called \(name) is installed") }
    let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = true
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication? = nil, openErr: String? = nil
    NSWorkspace.shared.openApplication(at: url, configuration: cfg) { a, e in launched = a; openErr = e?.localizedDescription; sem.signal() }
    _ = sem.wait(timeout: .now() + 5)
    guard let a = launched else { fail("could not open \(name): \(openErr ?? "timed out")") }
    let ok = waitFront(a, secs: 5)
    finish(ok, ok ? "opened \(a.localizedName ?? name), it is in front" : "opened \(a.localizedName ?? name) but it did not come to the front in 5 s")
}

func doQuitApp() -> Never {
    guard let name = str("name") ?? str("bundleId"), !name.isEmpty else { fail("quit_app needs a name") }
    guard let r = runningApp(name) else { finish(true, "\(name) is not running") }
    // Never force: a document with unsaved changes must get its own "Save?" sheet, not be killed.
    if r.bundleIdentifier == "com.apple.finder" { fail("Finder cannot be quit") }
    if r.processIdentifier == getpid() { fail("refusing to quit myself") }
    _ = r.terminate()
    let end = Date().addingTimeInterval(3)
    while Date() < end { if r.isTerminated { finish(true, "quit \(r.localizedName ?? name)") }; pause(100) }
    fail("asked \(r.localizedName ?? name) to quit but it is still running (it may be showing a save dialog)")
}

func doOpenURL() -> Never {
    guard let s = str("url"), let u = URL(string: s), let sc = u.scheme?.lowercased(), (sc == "http" || sc == "https"), u.host != nil else { fail("only http(s) URLs can be opened") }
    finish(NSWorkspace.shared.open(u), "opened \(u.host ?? s) in the default browser")
}

func doCopy() -> Never {
    guard let t = str("text") else { fail("copy needs text") }
    let pb = NSPasteboard.general
    pb.clearContents()
    finish(pb.setString(t, forType: .string), "copied \(t.count) characters to the clipboard")
}

func frontWindowTitle() -> String {
    guard let a = frontApp else { return "" }
    let ax = AXUIElementCreateApplication(a.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.4)
    if let w = axAttr(ax, kAXFocusedWindowAttribute) ?? axAttr(ax, kAXMainWindowAttribute) { return clean(axStr(w as! AXUIElement, kAXTitleAttribute)) }
    return ""
}

func doFront() -> Never {
    finish(true, "\(frontApp?.localizedName ?? "no app")", ["app": frontApp?.localizedName ?? "", "bundleId": frontBundle, "title": AXIsProcessTrusted() ? frontWindowTitle() : ""])
}

func doScreenshot() -> Never {
    // The pixels go to a file the user can see (Desktop) and to the clipboard, nowhere else. screencapture needs the Screen
    // Recording permission or it silently returns only the wallpaper, so check first and say which permission is missing.
    guard CGPreflightScreenCaptureAccess() else {
        needPermission("Screen Recording", "Open System Settings > Privacy & Security > Screen & System Audio Recording and switch on the app that launched this, then try again.")
    }
    let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd-HHmmss"
    let path = NSHomeDirectory() + "/Desktop/Ishara-\(f.string(from: Date())).png"
    var args = ["-x"]
    let scope = str("scope") ?? "window"
    if scope == "window", let pid = frontApp?.processIdentifier,
       let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
        if let w = mine.first, let id = w[kCGWindowNumber as String] as? Int { args += ["-o", "-l", String(id)] }
    }
    args.append(path)
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture"); p.arguments = args
    try? p.run(); p.waitUntilExit()
    guard FileManager.default.fileExists(atPath: path), let img = NSImage(contentsOfFile: path) else { fail("screencapture produced no image") }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.writeObjects([img])
    finish(true, "screenshot saved to \(path) and copied to the clipboard", ["path": path])
}

// ---------- actions that need the accessibility tree ----------
let nonAXKinds: Set<String> = ["open_app", "quit_app", "open_url", "copy", "screenshot", "front"]
switch kind {
case "open_app": doOpenApp()
case "quit_app": doQuitApp()
case "open_url": doOpenURL()
case "copy": doCopy()
case "screenshot": doScreenshot()
case "front": doFront()
default: break
}
needAX()

// key: allowed in a browser (the user asked for the combo), everything else below is not.
if kind == "key" {
    guard let combo = str("combo"), let (code, flags) = parseCombo(combo) else { fail("unknown key combination \"\(str("combo") ?? "")\"") }
    // A combo that submits or deletes is the risk classifier's business; here it is only posted, to the front app.
    postKey(code, flags)
    finish(true, "pressed \(combo) in \(frontApp?.localizedName ?? "the front app")")
}

func windowCentre() -> (CGPoint, CGRect)? {
    guard let a = frontApp else { return nil }
    let ax = AXUIElementCreateApplication(a.processIdentifier)
    AXUIElementSetMessagingTimeout(ax, 0.4)
    guard let w = axAttr(ax, kAXFocusedWindowAttribute) ?? axAttr(ax, kAXMainWindowAttribute), let fr = frame(w as! AXUIElement) else { return nil }
    return (CGPoint(x: fr.midX, y: fr.midY), fr)
}

if kind == "scroll" {
    if frontIsBrowser { refuseBrowser() }
    guard let (centre, fr) = windowCentre() else { fail("the front app has no window to scroll") }
    let down = (str("direction") ?? "down") != "up"
    let page = (str("amount") ?? "line") == "page"
    // Pixel units for a page (80% of the window, so one line of context stays), 5 lines otherwise. Positive wheel = up.
    let magnitude = page ? Int32(max(80, fr.height * 0.8)) : 5
    let delta = down ? -magnitude : magnitude
    guard let ev = CGEvent(scrollWheelEvent2Source: evSource, units: page ? .pixel : .line, wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0) else { fail("could not build a scroll event") }
    ev.location = centre
    ev.post(tap: .cghidEventTap)
    finish(true, "scrolled \(down ? "down" : "up") one \(page ? "page" : "step") in \(frontApp?.localizedName ?? "the window")")
}

if kind == "click_at" {
    if frontIsBrowser { refuseBrowser() }
    guard let x = num(inp, "x"), let y = num(inp, "y") else { fail("click_at needs x and y") }
    let pt = CGPoint(x: x, y: y)
    // Last-resort click: never into a secret field (the element under the point is asked, not trusted from the caller).
    var hit: AXUIElement?
    if AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &hit) == .success, let h = hit {
        if isSecureRole(axStr(h, kAXRoleAttribute), axStr(h, kAXSubroleAttribute)) { fail("secret field") }
    }
    guard let dn = CGEvent(mouseEventSource: evSource, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left),
          let up = CGEvent(mouseEventSource: evSource, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left) else { fail("could not build a click") }
    dn.post(tap: .cghidEventTap); pause(40); up.post(tap: .cghidEventTap)
    finish(true, "clicked at \(Int(x)),\(Int(y))")
}

// press / setvalue / check need an element. A browser's tree is only its chrome: the extension does those.
guard kind == "press" || kind == "setvalue" || kind == "check" else { fail("unknown action \"\(kind)\"") }
if frontIsBrowser { refuseBrowser() }
guard let sel = inp["selector"] as? [String: Any], let wantRole = sel["role"] as? String else { fail("\(kind) needs a selector with a role and a label") }
let wantLabel = sel["label"] as? String ?? ""
let wantIndex = (sel["index"] as? NSNumber)?.intValue ?? 0
let wantTitle = sel["title"] as? String ?? ""
if let b = sel["bundleId"] as? String, !b.isEmpty, b != frontBundle { fail("the front app changed (\(frontApp?.localizedName ?? "?")), not acting") }
if sel["secure"] as? Bool == true || (sel["axRole"] as? String) == "AXSecureTextField" { fail("secret field") }

guard let app = frontApp else { fail("no front app") }
let axApp = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(axApp, 0.5)
AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
guard let winRef = axAttr(axApp, kAXFocusedWindowAttribute) ?? axAttr(axApp, kAXMainWindowAttribute) ?? (axAttr(axApp, kAXWindowsAttribute) as? [AXUIElement])?.first,
      let winFrame = frame(winRef as! AXUIElement) else { fail("\(app.localizedName ?? "the front app") has no readable window") }
let window = winRef as! AXUIElement
let winTitle = clean(axStr(window, kAXTitleAttribute))

// ---- the walk: the same rules as ishara-ax context, minus text blocks and OCR ----
struct Cand { var e: AXUIElement; var axRole: String; var role: String; var label: String; var x: Double; var y: Double; var w: Double; var h: Double }
func mapRole(_ role: String, _ sub: String) -> String? {
    switch role {
    case "AXButton", "AXMenuButton", "AXMenuItem", "AXMenuBarItem", "AXDisclosureTriangle", "AXToolbarButton": return "button"
    case "AXTab": return "button"
    case "AXRadioButton": return sub == "AXTabButton" ? "button" : "radio"
    case "AXTextField", "AXTextArea", "AXSearchField", "AXSlider", "AXIncrementor", "AXStepper": return "input"
    case "AXComboBox", "AXPopUpButton": return "select"
    case "AXCheckBox", "AXSwitch": return "checkbox"
    case "AXLink": return "link"
    case "AXStaticText": return "text"
    default: return nil
    }
}
let primaryH = NSScreen.screens.first?.frame.height ?? 0
let screenRects: [CGRect] = NSScreen.screens.map { CGRect(x: $0.frame.minX, y: primaryH - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
let visibleWin = screenRects.map { $0.intersection(winFrame) }.max { $0.width * $0.height < $1.width * $1.height } ?? winFrame
var found: [Cand] = [], statics: [Cand] = []
var visited = 0
let deadline = Date().addingTimeInterval(2.5)
func walk(_ e: AXUIElement, _ depth: Int) {
    if depth > 14 || visited > 4000 || Date() > deadline { return }
    visited += 1
    let role = axStr(e, kAXRoleAttribute), sub = axStr(e, kAXSubroleAttribute)
    if role == "AXMenuBar" { return }
    if let h = axAttr(e, "AXHidden") as? Bool, h { return }
    if let mapped = mapRole(role, sub), let fr = frame(e), fr.width >= 2, fr.height >= 2, visibleWin.intersects(fr),
       visibleWin.contains(CGPoint(x: fr.midX, y: fr.midY)) {
        let title = clean(axStr(e, kAXTitleAttribute)), desc = clean(axStr(e, kAXDescriptionAttribute))
        let ph = clean(axStr(e, "AXPlaceholderValue")), help = clean(axStr(e, kAXHelpAttribute))
        let secure = isSecureRole(role, sub)
        let val = secure ? "" : clean(axStr(e, kAXValueAttribute))
        var label = title.isEmpty ? (desc.isEmpty ? ph : desc) : title
        if label.isEmpty && (mapped == "text" || mapped == "select" || mapped == "checkbox") && !val.isEmpty { label = val }
        if label.isEmpty && !help.isEmpty { label = help }
        let c = Cand(e: e, axRole: role, role: mapped, label: clip(label), x: fr.minX, y: fr.minY, w: fr.width, h: fr.height)
        if mapped == "text" { if !c.label.isEmpty { statics.append(c) } } else { found.append(c) }
    }
    if role != "AXTextArea", let kids = axAttr(e, kAXChildrenAttribute) as? [AXUIElement] { for k in kids { walk(k, depth + 1) } }
}
walk(window, 0)
func nearbyLabel(_ el: Cand) -> String {
    var best: (d: Double, s: String)? = nil
    for s in statics {
        let sameRow = min(s.y + s.h, el.y + el.h) - max(s.y, el.y) > min(s.h, el.h) * 0.4
        let leftOf = s.x + s.w <= el.x + 4 && el.x - (s.x + s.w) < 260
        let above = s.y + s.h <= el.y + 4 && el.y - (s.y + s.h) < 40 && abs(s.x - el.x) < 120
        var d: Double? = nil
        if sameRow && leftOf { d = el.x - (s.x + s.w) } else if above { d = (el.y - (s.y + s.h)) + 100 }
        if let d = d, best == nil || d < best!.d { best = (d, s.label) }
    }
    return best?.s ?? ""
}
for i in found.indices where found[i].label.isEmpty && ["input", "select", "checkbox", "radio"].contains(found[i].role) { found[i].label = nearbyLabel(found[i]) }
found = found.filter { !$0.label.isEmpty || ["input", "select", "checkbox"].contains($0.role) }
func byReading(_ a: Cand, _ b: Cand) -> Bool {
    let ra = Int(a.y / 8), rb = Int(b.y / 8)
    return ra != rb ? ra < rb : a.x < b.x
}
found.sort(by: byReading)

// ---- pick the target ----
let hint: CGRect? = {
    guard let r = sel["rect"] as? [String: Any], let x = num(r, "x"), let y = num(r, "y"), let w = num(r, "w"), let h = num(r, "h") else { return nil }
    return CGRect(x: x, y: y, width: w, height: h)
}()
func dist(_ c: Cand) -> Double {
    guard let h = hint else { return 0 }
    return hypot(c.x + c.w / 2 - Double(h.midX), c.y + c.h / 2 - Double(h.midY))
}
func labelsAgree(_ a: String, _ b: String) -> Bool {
    let x = norm(a), y = norm(b)
    if x.isEmpty || y.isEmpty { return x == y }
    return x == y || (min(x.count, y.count) >= 12 && (x.hasPrefix(y) || y.hasPrefix(x))) // the 80-char cap cuts long labels
}
let titleOK = wantTitle.isEmpty || clean(wantTitle) == winTitle

var target: Cand? = nil
if wantRole == "text" {
    // A block id (a sidebar row, a list line): find the static text inside the hint, or by its words.
    let near = statics.filter { s in
        let words = norm(wantLabel)
        let n = norm(s.label)
        let inside = hint.map { $0.insetBy(dx: -6, dy: -6).contains(CGPoint(x: s.x + s.w / 2, y: s.y + s.h / 2)) } ?? false
        return (!words.isEmpty && (words.contains(n) || n.contains(words)) && (hint == nil || inside || dist(s) < 120)) || (words.isEmpty && inside)
    }.sorted { dist($0) < dist($1) }
    target = near.first
    if target == nil, hint != nil {
        // The block had no static-text child with those words (a cell made of several): any element or button there.
        target = (found + statics).filter { dist($0) < 40 }.min { dist($0) < dist($1) }
    }
} else {
    let sameRole = found.filter { $0.role == wantRole }
    let matches = sameRole.filter { labelsAgree($0.label, wantLabel) }
    if matches.count == 1 { target = matches[0] }
    else if matches.count > 1 {
        guard titleOK || hint != nil else { fail("the window changed since it was read (\"\(winTitle)\"), not acting") }
        // Same name more than once: the saved index first, but if that one has moved far away from the hint while another
        // sits on it, believe the position (a list that gained a row above).
        let byIndex = wantIndex < matches.count ? matches[wantIndex] : nil
        let closest = matches.min { dist($0) < dist($1) }!
        target = (byIndex != nil && (hint == nil || dist(byIndex!) < 90 || dist(closest) > 90)) ? byIndex : closest
    } else if wantLabel.isEmpty || hint != nil {
        // No label match (an unlabelled field, or a label that changed with its value): the nearest of that role on the hint.
        target = sameRole.filter { dist($0) < 30 }.min { dist($0) < dist($1) }
    }
}
guard let t = target else { fail("could not find \"\(wantLabel)\" (\(wantRole)) in \(app.localizedName ?? "the front window"); the screen may have changed") }
if t.axRole == "AXSecureTextField" { fail("secret field") }
if kind == "setvalue" && (looksSecret(t.label) || looksSecret(wantLabel)) { fail("secret field") }
let centre = CGPoint(x: t.x + t.w / 2, y: t.y + t.h / 2)
func hintExtra(_ x: [String: Any] = [:]) -> [String: Any] {
    var o = x; o["x"] = Int(centre.x); o["y"] = Int(centre.y); o["axRole"] = t.axRole; return o
}

func parentChain(_ e: AXUIElement, _ n: Int) -> [AXUIElement] {
    var out: [AXUIElement] = [], cur = e
    for _ in 0..<n { guard let p = axAttr(cur, kAXParentAttribute) else { break }; cur = p as! AXUIElement; out.append(cur) }
    return out
}
func perform(_ e: AXUIElement, _ action: String) -> Bool { AXUIElementPerformAction(e, action as CFString) == .success }

// ---------- press ----------
if kind == "press" {
    // A popup / pull-down with an option named: open its menu, then press the item with that label.
    if let option = str("option"), !option.isEmpty {
        guard perform(t.e, kAXShowMenuAction) || perform(t.e, kAXPressAction) else { fail("could not open the menu \"\(t.label)\"", hintExtra(["fallback": "click_at"])) }
        let wantOpt = norm(option)
        var item: AXUIElement? = nil
        let end = Date().addingTimeInterval(1.5)
        func findItem(_ e: AXUIElement, _ d: Int) -> AXUIElement? {
            if d > 5 { return nil }
            if axStr(e, kAXRoleAttribute) == "AXMenuItem" { let n = norm(axStr(e, kAXTitleAttribute)); if !n.isEmpty && (n == wantOpt || n.contains(wantOpt)) { return e } }
            for k in (axAttr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { if let f = findItem(k, d + 1) { return f } }
            return nil
        }
        while item == nil && Date() < end {
            pause(100)
            item = findItem(t.e, 0) ?? findItem(axApp, 0)   // the menu is a child of the button, or of the app on some builds
        }
        guard let it = item else { _ = perform(t.e, kAXCancelAction); fail("the menu \"\(t.label)\" has no option \"\(option)\"") }
        guard perform(it, kAXPressAction) else { fail("could not choose \"\(option)\"") }
        finish(true, "chose \"\(option)\" in \"\(t.label)\"")
    }
    if perform(t.e, kAXPressAction) { finish(true, "pressed \"\(t.label)\"") }
    // AX could not press it. A text row or cell: press an ancestor, or select the row.
    for p in parentChain(t.e, 4) {
        let r = axStr(p, kAXRoleAttribute)
        if perform(p, kAXPressAction) { finish(true, "pressed \"\(t.label)\" (through its \(r))") }
        if r == "AXRow" || r == "AXCell", AXUIElementSetAttributeValue(p, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success {
            finish(true, "selected the row \"\(t.label)\"")
        }
    }
    fail("AXPress is not supported by \"\(t.label)\"", hintExtra(["fallback": "click_at"]))
}

// ---------- check ----------
if kind == "check" {
    guard let want = inp["checked"] as? Bool else { fail("check needs checked: true|false") }
    func state() -> Bool? {
        if let n = axAttr(t.e, kAXValueAttribute) as? NSNumber { return n.intValue != 0 }
        if let b = axAttr(t.e, kAXSelectedAttribute) as? Bool { return b }
        return nil
    }
    guard let now = state() else { fail("\"\(t.label)\" does not report a checked state") }
    if now == want { finish(true, "\"\(t.label)\" was already \(want ? "on" : "off")") }
    guard perform(t.e, kAXPressAction) else { fail("could not press \"\(t.label)\"", hintExtra(["fallback": "click_at"])) }
    pause(150)
    let after = state()
    finish(after == want, after == want ? "turned \"\(t.label)\" \(want ? "on" : "off")" : "pressed \"\(t.label)\" but it still reads \(after.map { $0 ? "on" : "off" } ?? "unknown")")
}

// ---------- setvalue ----------
guard t.role == "input" else { fail("\"\(t.label)\" is not a text field") }
if isSecureRole(axStr(t.e, kAXRoleAttribute), axStr(t.e, kAXSubroleAttribute)) { fail("secret field") }
guard let text = str("text") else { fail("setvalue needs text") }
let clear = (inp["clear"] as? Bool) ?? false
let before = axStr(t.e, kAXValueAttribute)
let wanted = clear || before.isEmpty ? text : before + text
var settable: DarwinBoolean = false
AXUIElementIsAttributeSettable(t.e, kAXValueAttribute as CFString, &settable)
// ISHARA_ACT_FORCE_KEYS=1 skips the AX write so tests can exercise the keyboard fallback on a field that would accept it.
if settable.boolValue, ProcessInfo.processInfo.environment["ISHARA_ACT_FORCE_KEYS"] == nil, AXUIElementSetAttributeValue(t.e, kAXValueAttribute as CFString, wanted as CFString) == .success, axStr(t.e, kAXValueAttribute) == wanted {
    finish(true, "typed \(text.count) characters into \"\(t.label)\"")
}
// AX refused (or silently ignored): focus the field, select all if replacing, and type like a keyboard would.
AXUIElementSetAttributeValue(t.e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
pause(120)
if axStr(t.e, kAXRoleAttribute) == "AXSecureTextField" { fail("secret field") }
if clear, let (c, f) = parseCombo("cmd+a") { postKey(c, f); pause(60) }
typeString(text)
pause(120)
let afterTyping = axStr(t.e, kAXValueAttribute)
finish(afterTyping != before || before.isEmpty && !afterTyping.isEmpty || afterTyping.contains(text), "typed \(text.count) characters into \"\(t.label)\" by keyboard events")
