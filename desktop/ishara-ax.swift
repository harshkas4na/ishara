// ishara-ax: turn the frontmost window of ANY macOS app into the same Outline the browser path produces
// (docs/INTERFACES.md), so the gate and both sealed 0G calls work unchanged.
//
// Privacy contract: the only things this program emits are label text and rectangles. The OCR fallback
// screenshots the window IN MEMORY, reads it with Apple's on-device Vision framework and drops the pixels;
// the image is never written to disk and never sent anywhere.
//
// Build: swiftc -O -swift-version 5 desktop/ishara-ax.swift -o desktop/ishara-ax
import AppKit
import ApplicationServices
import Vision
import ScreenCaptureKit

// ---------- output helpers ----------
func err(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
let t0 = Date()
func ms() -> Int { Int(Date().timeIntervalSince(t0) * 1000) }

// Exit code 2 = a permission is missing. helper/src/desktop.ts keys on this to show the fix to the user.
func die(_ code: Int32, _ msg: String) -> Never { err(msg); exit(code) }

// ---------- args ----------
var ocrMode = "auto"          // auto | always | never
var ocrLevel = "accurate"     // accurate | fast (measured: fast is poor, accurate 2.1 s warm)
var forcePid: pid_t? = nil    // test aid: outline a specific app instead of the frontmost one
var args = Array(CommandLine.arguments.dropFirst())
let command = args.isEmpty ? "outline" : args.removeFirst()
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--ocr": ocrMode = args.isEmpty ? "auto" : args.removeFirst()
    case "--ocr-level": ocrLevel = args.isEmpty ? "accurate" : args.removeFirst()
    case "--pid": if let s = args.first, let p = Int32(s) { forcePid = p; args.removeFirst() }
    case "--app":
        if let n = args.first {
            args.removeFirst()
            forcePid = NSWorkspace.shared.runningApplications.first { $0.localizedName == n }?.processIdentifier
            if forcePid == nil { die(1, "ishara-ax: no running app named \(n)") }
        }
    default: break
    }
}
guard command == "outline" else { die(1, "usage: ishara-ax outline [--ocr auto|always|never] [--ocr-level accurate|fast] [--app Name | --pid N]") }

// ---------- permission ----------
// AXIsProcessTrusted is about the process that is RESPONSIBLE for us: when run from a terminal that is the
// terminal app, not this binary. Say so, because granting the wrong one is the usual failure.
guard AXIsProcessTrusted() else {
    die(2, """
    ISHARA_PERMISSION: Accessibility
    Ishara needs the Accessibility permission to read which buttons and fields are on screen.
    Open System Settings > Privacy & Security > Accessibility and switch on the app that launched this
    (Terminal, iTerm, VS Code, or the node/helper process you started it from; if you run the ishara-ax
    binary directly, add that binary). Then run the command again.
    """)
}

// ---------- model ----------
struct El { var role: String; var label: String; var x: Double; var y: Double; var w: Double; var h: Double; var ctl: String = "" }

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
// Same 80-char cap as extension/outline.js so prompts stay the same size on both paths.
func clip(_ s: String) -> String { s.count > 80 ? String(s.prefix(79)) + "…" : s }

func frame(_ e: AXUIElement) -> CGRect? {
    guard let pv = axAttr(e, kAXPositionAttribute), let sv = axAttr(e, kAXSizeAttribute) else { return nil }
    var p = CGPoint.zero, s = CGSize.zero
    guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
    return CGRect(origin: p, size: s)
}

// AX role -> the browser path's vocabulary. nil = not a pointing target by itself.
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

// ---------- the walk ----------
let target: NSRunningApplication? = {
    if let p = forcePid { return NSRunningApplication(processIdentifier: p) }
    return NSWorkspace.shared.frontmostApplication
}()
guard let app = target else { die(1, "ishara-ax: could not find the frontmost app") }
let axApp = AXUIElementCreateApplication(app.processIdentifier)
AXUIElementSetMessagingTimeout(axApp, 0.4) // one hung app must not eat the whole 6 s budget
// Electron/Chromium build their AX tree only when asked; this flips it on (harmless elsewhere).
AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)

func pickWindow() -> AXUIElement? {
    for k in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let w = axAttr(axApp, k) { return (w as! AXUIElement) }
    }
    if let ws = axAttr(axApp, kAXWindowsAttribute) as? [AXUIElement] { return ws.first }
    return nil
}
guard let window = pickWindow(), let winFrame = frame(window) else {
    die(1, "ishara-ax: \(app.localizedName ?? "the frontmost app") has no readable window (is it minimised, or full of its own custom drawing?)")
}

// Screens in AX coordinates (top-left origin of the primary display), to drop off-screen elements.
let primaryH = NSScreen.screens.first?.frame.height ?? 0
let screenRects: [CGRect] = NSScreen.screens.map { CGRect(x: $0.frame.minX, y: primaryH - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
let visibleWin = screenRects.map { $0.intersection(winFrame) }.max { $0.width * $0.height < $1.width * $1.height } ?? winFrame

var found: [El] = []
var statics: [El] = []
var visited = 0
let maxNodes = 4000, maxDepth = 14
let deadline = Date().addingTimeInterval(3.0) // AX gets 3 s; the rest of the 6 s is OCR and process start

func walk(_ e: AXUIElement, _ depth: Int) {
    if depth > maxDepth || visited > maxNodes || Date() > deadline { return }
    visited += 1
    let role = axStr(e, kAXRoleAttribute), sub = axStr(e, kAXSubroleAttribute)
    // Menus that are closed report frames far away or no frame; descending them was what made the
    // menu bar take 1.4 s in the lab. We never enter AXMenuBar, and skip AXMenu unless it is open on screen.
    if role == "AXMenuBar" { return }
    if let h = axAttr(e, "AXHidden") as? Bool, h { return }
    let fr = frame(e)
    if let mapped = mapRole(role, sub), let fr = fr, fr.width >= 2, fr.height >= 2, visibleWin.intersects(fr) {
        let c = CGPoint(x: fr.midX, y: fr.midY)
        if visibleWin.contains(c) { // centre must be inside the on-screen part: a half-scrolled-off row is not clickable
            let title = clean(axStr(e, kAXTitleAttribute)), desc = clean(axStr(e, kAXDescriptionAttribute))
            let ph = clean(axStr(e, "AXPlaceholderValue")), help = clean(axStr(e, kAXHelpAttribute))
            let val = clean(axStr(e, kAXValueAttribute))
            var label = title.isEmpty ? (desc.isEmpty ? ph : desc) : title
            // A text field's value is what the user typed, not its name; only use value as a label for static text and short control values.
            if label.isEmpty && (mapped == "text" || mapped == "select" || mapped == "checkbox") && !val.isEmpty { label = val }
            if label.isEmpty && !help.isEmpty { label = help }
            let ctl = (role == "AXSecureTextField" || sub == "AXSecureTextField") ? "password" : (role == "AXSearchField" ? "search" : (mapped == "input" ? "text" : ""))
            let el = El(role: mapped, label: clip(label), x: fr.minX, y: fr.minY, w: fr.width, h: fr.height, ctl: ctl)
            if mapped == "text" { if !el.label.isEmpty { statics.append(el) } } else { found.append(el) }
        }
    }
    // Do not recurse into the value of text areas (their children are every line of a document).
    if role == "AXTextArea" { return }
    if let kids = axAttr(e, kAXChildrenAttribute) as? [AXUIElement] { for k in kids { walk(k, depth + 1) } }
}
walk(window, 0)
let axMs = ms()

// Label controls that have none from the nearest static text to their left, or just above them.
func nearbyLabel(for el: El) -> String {
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
for i in found.indices where found[i].label.isEmpty && ["input", "select", "checkbox", "radio"].contains(found[i].role) {
    found[i].label = nearbyLabel(for: found[i])
}
// Like the browser path: an unlabelled button/link tells the model nothing; unlabelled form controls stay.
found = found.filter { !$0.label.isEmpty || ["input", "select", "checkbox"].contains($0.role) }

// ---------- OCR fallback ----------
let axLabelled = found.filter { !$0.label.isEmpty }.count + statics.count
var ocrEls: [El] = []
var ocrNote = "skipped"

func captureWindow() -> CGImage? {
    guard CGPreflightScreenCaptureAccess() else {
        err("ishara-ax: OCR skipped, Screen Recording permission is missing. Grant it to the app that launched this (System Settings > Privacy & Security > Screen & System Audio Recording).")
        ocrNote = "no-screen-recording-permission"
        return nil
    }
    var out: CGImage?
    let sem = DispatchSemaphore(value: 0)
    Task {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let mid = CGPoint(x: visibleWin.midX, y: visibleWin.midY)
            guard let disp = content.displays.first(where: { $0.frame.contains(mid) }) ?? content.displays.first else { return }
            // Never photograph our own pointer overlay: its ring would be "read" as part of the app.
            let mine = content.applications.filter { $0.applicationName.contains("ishara-overlay") }
            let filter = SCContentFilter(display: disp, excludingApplications: mine, exceptingWindows: [])
            let cfg = SCStreamConfiguration()
            let rect = visibleWin.intersection(disp.frame)
            cfg.sourceRect = CGRect(x: rect.minX - disp.frame.minX, y: rect.minY - disp.frame.minY, width: rect.width, height: rect.height)
            let scale = Double(filter.pointPixelScale)
            cfg.width = Int(rect.width * scale); cfg.height = Int(rect.height * scale)
            cfg.showsCursor = false
            out = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
        } catch { err("ishara-ax: screen capture failed: \(error.localizedDescription)"); ocrNote = "capture-failed" }
    }
    _ = sem.wait(timeout: .now() + 3)
    return out
}

func runOCR() {
    guard let img = captureWindow() else { return }
    let req = VNRecognizeTextRequest()
    req.recognitionLevel = ocrLevel == "fast" ? .fast : .accurate
    req.usesLanguageCorrection = ocrLevel != "fast"
    let h = VNImageRequestHandler(cgImage: img, options: [:])
    do { try h.perform([req]) } catch { err("ishara-ax: OCR failed: \(error.localizedDescription)"); ocrNote = "ocr-failed"; return }
    for o in (req.results ?? []) {
        guard let cand = o.topCandidates(1).first, cand.confidence >= 0.4 else { continue }
        let text = clean(cand.string)
        if text.count < 2 { continue }
        // Vision boxes are normalised with a BOTTOM-left origin inside the captured image; the image
        // covers visibleWin exactly, so flip y and scale to screen points (top-left, same as AX).
        let b = o.boundingBox
        let x = visibleWin.minX + Double(b.minX) * visibleWin.width
        let y = visibleWin.minY + Double(1 - b.maxY) * visibleWin.height
        ocrEls.append(El(role: "text", label: clip(text), x: x, y: y, w: Double(b.width) * visibleWin.width, h: Double(b.height) * visibleWin.height))
    }
    ocrNote = "ran:\(ocrLevel):\(ocrEls.count)"
}
if ocrMode == "always" || (ocrMode == "auto" && axLabelled < 25) { runOCR() }
let ocrMs = ms()

// ---------- merge ----------
func norm(_ s: String) -> String { s.lowercased().filter { $0.isLetter || $0.isNumber } }
func overlap(_ a: El, _ b: El) -> Double {
    let iw = min(a.x + a.w, b.x + b.w) - max(a.x, b.x), ih = min(a.y + a.h, b.y + b.h) - max(a.y, b.y)
    if iw <= 0 || ih <= 0 { return 0 }
    return iw * ih / max(1, min(a.w * a.h, b.w * b.h))
}
// An OCR line is a duplicate when it sits on an AX element (>50% of the smaller box) and the texts agree
// (either contains the other), or when it repeats an AX label that is within a text-height of it.
var all = found + statics
for o in ocrEls {
    let n = norm(o.label)
    let dup = all.contains { a in
        let an = norm(a.label)
        let same = !an.isEmpty && (an.contains(n) || n.contains(an))
        return (overlap(a, o) > 0.5 && (same || a.label.isEmpty || a.role == "text")) || (same && abs(a.y - o.y) < max(a.h, o.h) && abs(a.x - o.x) < 40)
    }
    if !dup && !n.isEmpty { all.append(o) }
}

// Reading order: rows top to bottom (8 pt buckets), then left to right.
all.sort { (a, b) in
    let ra = Int(a.y / 8), rb = Int(b.y / 8)
    return ra != rb ? ra < rb : a.x < b.x
}
// Cap like the browser path; when over, keep controls first and let plain text fill what is left.
let cap = 150
if all.count > cap {
    let controls = all.filter { $0.role != "text" }
    let room = max(0, cap - controls.count)
    var texts = 0
    all = all.filter { e in
        if e.role != "text" { return true }
        texts += 1; return texts <= room
    }
    if all.count > cap { all = Array(all.prefix(cap)) }
}

// ---------- emit ----------
var elementsJSON: [[String: Any]] = []
var lines: [String] = []
for (i, e) in all.enumerated() {
    let id = "b\(i)"
    elementsJSON.append(["id": id, "label": e.label, "role": e.role,
                         "rect": ["x": Int(e.x.rounded()), "y": Int(e.y.rounded()), "w": Int(e.w.rounded()), "h": Int(e.h.rounded())]])
    let suffix = (e.role == "input" || e.role == "checkbox") && !e.ctl.isEmpty ? " (\(e.ctl))" : ""
    lines.append("[\(id)] \(e.role) \"\(e.label)\"\(suffix)")
}
let name = app.localizedName ?? "app"
let title = clean(axStr(window, kAXTitleAttribute))
let outline: [String: Any] = [
    // No URL on the desktop; app://Name/Window title keeps the field a string that identifies the window.
    "url": "app://\(name)" + (title.isEmpty ? "" : "/\(title)"),
    // Viewport = the window's size in points; element rects are SCREEN points, not window-relative,
    // because the overlay draws in screen space.
    "viewport": ["w": Int(winFrame.width.rounded()), "h": Int(winFrame.height.rounded())],
    "elements": elementsJSON,
    "text": lines.joined(separator: "\n"),
    "origin": ["x": Int(winFrame.minX.rounded()), "y": Int(winFrame.minY.rounded())],
]
err("ishara-ax: \(name) | ax \(found.count + statics.count) of \(visited) nodes in \(axMs) ms | ocr \(ocrNote) (+\(ocrMs - axMs) ms) | \(all.count) elements | total \(ms()) ms")
let data = try! JSONSerialization.data(withJSONObject: outline, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write("\n".data(using: .utf8)!)
