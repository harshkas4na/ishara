// ishara-ax: turn the frontmost window of ANY macOS app into the same Outline the browser path produces
// (docs/INTERFACES.md), so the gate and both sealed 0G calls work unchanged.
//   ishara-ax outline   the old pointing outline (controls and text lines, ids b0..)
//   ishara-ax context   the tutor's raw material: controls with state, text blocks, selection, focus, alerts. The helper
//                       (helper/src/desktop.ts) redacts, neutralizes and trims it into a PageContext; this program
//                       only reads, it decides nothing about what may leave the machine.
//   ishara-ax front     just the frontmost app's name and bundle id (no permission, no walk): the browser guard.
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
if command == "front" { // cheap and permission-free: lets the helper refuse browsers BEFORE anything reads a window
    let f = NSWorkspace.shared.frontmostApplication
    let o: [String: Any] = ["app": f?.localizedName ?? "", "bundleId": f?.bundleIdentifier ?? ""]
    FileHandle.standardOutput.write((try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])) + "\n".data(using: .utf8)!)
    exit(0)
}
guard command == "outline" || command == "context" else { die(1, "usage: ishara-ax outline|context|front [--ocr auto|always|never] [--ocr-level accurate|fast] [--app Name | --pid N]") }
let ctxMode = command == "context"

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
struct El {
    var role: String; var label: String; var x: Double; var y: Double; var w: Double; var h: Double; var ctl: String = ""
    var axRole: String = ""               // context mode: the raw AX role, for the selector ishara-act re-finds the control by
    var elem: AXUIElement? = nil          // context mode: to match the focused element
    var state: [String: Any] = [:]        // context mode: checked / value / selectedOption / disabled / filledChars / empty / invalid
}
// A text block for the tutor (context mode). cells is set for table rows ("row: a | b" is built by the reader core).
struct Blk { var kind: String; var text: String; var cells: [String] = []; var x = 0.0, y = 0.0, w = 0.0, h = 0.0; var hasRect = false; var inView = true; var error = false }
var blocks: [Blk] = []
final class RowAcc { var parts: [String] = []; var cellOpen: Int? = nil }
var rowStack: [RowAcc] = []
struct WalkCtx { var alert = false; var heading = false }
var focusedEl: AXUIElement? = nil

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

func isSecure(_ role: String, _ sub: String) -> Bool { role == "AXSecureTextField" || sub == "AXSecureTextField" }

// ---- context mode helpers ----
// Text area content as paragraph blocks. In-view paragraphs (AXVisibleCharacterRange) come with a screen rect from
// AXBoundsForRange, so "point at this paragraph" can land. A huge buffer (Terminal scrollback) is cut to the visible
// part plus a margin before it is even split.
func textAreaBlocks(_ e: AXUIElement, _ area: CGRect) {
    guard let v = axAttr(e, kAXValueAttribute) as? String, !v.isEmpty else { return }
    let ns = v as NSString
    var vis = NSRange(location: 0, length: ns.length)
    if let rv = axAttr(e, "AXVisibleCharacterRange"), CFGetTypeID(rv) == AXValueGetTypeID() {
        var r = CFRange(); if AXValueGetValue(rv as! AXValue, .cfRange, &r), r.length > 0 { vis = NSRange(location: r.location, length: r.length) }
    }
    let lo = max(0, vis.location - 2000), hi = min(ns.length, vis.location + vis.length + 2000)
    var made = 0
    ns.enumerateSubstrings(in: NSRange(location: lo, length: hi - lo), options: [.byParagraphs]) { sub, range, _, stop in
        guard let sub = sub else { return }
        let t = clean(sub)
        if t.count < 2 { return }
        if made >= 80 { stop.pointee = true; return }
        let inV = NSIntersectionRange(range, vis).length > 0
        var b = Blk(kind: "p", text: t, inView: inV)
        if inV {
            var cr = CFRange(location: range.location, length: min(range.length, 400))
            if let arg = AXValueCreate(.cfRange, &cr) {
                var out: CFTypeRef?
                if AXUIElementCopyParameterizedAttributeValue(e, "AXBoundsForRange" as CFString, arg, &out) == .success, let o = out, CFGetTypeID(o) == AXValueGetTypeID() {
                    var r = CGRect.zero
                    if AXValueGetValue(o as! AXValue, .cgRect, &r), r.width > 1, r.height > 1, visibleWin.intersects(r) { b.x = r.minX; b.y = r.minY; b.w = r.width; b.h = r.height; b.hasRect = true }
                }
            }
            if !b.hasRect { b.inView = false } // visible per AX but no usable box: do not claim it can be pointed at
        }
        blocks.append(b); made += 1
    }
}

func controlState(_ e: AXUIElement, role: String, sub: String, mapped: String) -> [String: Any] {
    var st: [String: Any] = [:]
    if let en = axAttr(e, kAXEnabledAttribute) as? Bool, !en { st["disabled"] = true }
    if let inv = axAttr(e, "AXInvalid") as? Bool, inv { st["invalid"] = true }
    // A secure field is NEVER read: not its value, not even through a different attribute. Only how many characters
    // it holds (AXNumberOfCharacters is a count, not content) so "filled" can be said.
    if isSecure(role, sub) {
        if let n = (axAttr(e, "AXNumberOfCharacters") as? NSNumber)?.intValue { st["filledChars"] = n; st["empty"] = n == 0 }
        return st
    }
    switch mapped {
    case "checkbox", "radio":
        if let n = axAttr(e, kAXValueAttribute) as? NSNumber { st["checked"] = n.intValue != 0 }
    case "select":
        let v = clean(axStr(e, kAXValueAttribute)); if !v.isEmpty { st["selectedOption"] = clip(v) }
    case "input":
        let isArea = role == "AXTextArea"
        if let n = (axAttr(e, "AXNumberOfCharacters") as? NSNumber)?.intValue ?? (axAttr(e, kAXValueAttribute) as? String)?.count {
            st["filledChars"] = n; st["empty"] = n == 0
            if !isArea, n > 0, n <= 120 { st["value"] = clean(axStr(e, kAXValueAttribute)) }
        }
    case "button":
        if let sel = axAttr(e, kAXSelectedAttribute) as? Bool, sel { st["checked"] = true }
        else if role == "AXRadioButton" || role == "AXTab", let n = axAttr(e, kAXValueAttribute) as? NSNumber, n.intValue != 0 { st["checked"] = true }
    default: break
    }
    return st
}

func walk(_ e: AXUIElement, _ depth: Int, _ c: WalkCtx = WalkCtx()) {
    if depth > maxDepth || visited > maxNodes || Date() > deadline { return }
    visited += 1
    let role = axStr(e, kAXRoleAttribute), sub = axStr(e, kAXSubroleAttribute)
    // Menus that are closed report frames far away or no frame; descending them was what made the
    // menu bar take 1.4 s in the lab. We never enter AXMenuBar, and skip AXMenu unless it is open on screen.
    if role == "AXMenuBar" { return }
    if let h = axAttr(e, "AXHidden") as? Bool, h { return }
    var c = c
    if ctxMode {
        if role == "AXSheet" || role == "AXAlert" || sub == "AXSystemDialog" || sub == "AXDialog" { c.alert = true }
        if role == "AXHeading" { c.heading = true }
    }
    let fr = frame(e)
    var row: RowAcc? = nil
    if ctxMode && role == "AXRow" { row = RowAcc(); rowStack.append(row!) }
    if ctxMode && role == "AXCell", let r = rowStack.last { r.cellOpen = r.parts.count; r.parts.append("") }
    if let mapped = mapRole(role, sub), let fr = fr, fr.width >= 2, fr.height >= 2, visibleWin.intersects(fr) {
        let cpt = CGPoint(x: fr.midX, y: fr.midY)
        if visibleWin.contains(cpt) { // centre must be inside the on-screen part: a half-scrolled-off row is not clickable
            let title = clean(axStr(e, kAXTitleAttribute)), desc = clean(axStr(e, kAXDescriptionAttribute))
            let ph = clean(axStr(e, "AXPlaceholderValue")), help = clean(axStr(e, kAXHelpAttribute))
            // Never read the value of a secure field, not even to use it as a label.
            let secure = isSecure(role, sub)
            let val = secure ? "" : clean(axStr(e, kAXValueAttribute))
            var label = title.isEmpty ? (desc.isEmpty ? ph : desc) : title
            // A text field's value is what the user typed, not its name; only use value as a label for static text and short control values.
            if label.isEmpty && (mapped == "text" || mapped == "select" || mapped == "checkbox") && !val.isEmpty { label = val }
            if label.isEmpty && !help.isEmpty { label = help }
            let ctl = secure ? "password" : (role == "AXSearchField" ? "search" : (mapped == "input" ? "text" : ""))
            var el = El(role: mapped, label: clip(label), x: fr.minX, y: fr.minY, w: fr.width, h: fr.height, ctl: ctl)
            el.axRole = role
            if mapped == "text" {
                if !el.label.isEmpty { statics.append(el) }
                if ctxMode && !val.isEmpty || ctxMode && !el.label.isEmpty {
                    let full = val.isEmpty ? label : val
                    if let r = rowStack.last {
                        if let ci = r.cellOpen { r.parts[ci] += (r.parts[ci].isEmpty ? "" : " ") + full } else { r.parts.append(full) }
                    } else if full.count >= 2 {
                        blocks.append(Blk(kind: c.alert ? "error" : (c.heading ? "h" : (full.count > 80 ? "p" : "text")), text: full, x: fr.minX, y: fr.minY, w: fr.width, h: fr.height, hasRect: true, inView: true, error: c.alert))
                    }
                }
            } else {
                if ctxMode { el.elem = e; el.state = controlState(e, role: role, sub: sub, mapped: mapped) }
                found.append(el)
                if ctxMode && role == "AXTextArea" { textAreaBlocks(e, fr) }
            }
        }
    }
    // Do not recurse into the value of text areas (their children are every line of a document).
    if role != "AXTextArea", let kids = axAttr(e, kAXChildrenAttribute) as? [AXUIElement] { for k in kids { walk(k, depth + 1, c) } }
    if ctxMode && role == "AXCell", let r = rowStack.last { r.cellOpen = nil }
    if let r = row {
        rowStack.removeLast()
        let parts = r.parts.map { clean($0) }.filter { !$0.isEmpty }
        if let fr = fr, !parts.isEmpty, visibleWin.contains(CGPoint(x: fr.midX, y: fr.midY)) {
            if parts.count == 1 { blocks.append(Blk(kind: c.alert ? "error" : "li", text: parts[0], x: fr.minX, y: fr.minY, w: fr.width, h: fr.height, hasRect: true, inView: true, error: c.alert)) }
            else { blocks.append(Blk(kind: "cell", text: parts.joined(separator: " | "), cells: parts, x: fr.minX, y: fr.minY, w: fr.width, h: fr.height, hasRect: true, inView: true, error: c.alert)) }
        }
    }
}
walk(window, 0, WalkCtx(alert: ctxMode && (axStr(window, kAXSubroleAttribute) == "AXSystemDialog" || axStr(window, kAXSubroleAttribute) == "AXDialog")))
if ctxMode { focusedEl = axAttr(axApp, kAXFocusedUIElementAttribute).map { $0 as! AXUIElement } }
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
let axLabelled = found.filter { !$0.label.isEmpty }.count + statics.count + blocks.count
var ocrEls: [El] = []
var ocrNote = "skipped"

// Why a WINDOW capture and not a display crop: cropping the display to the window's rectangle also photographs whatever
// is drawn over it (another app's window, a notification, a floating panel), and that text would be read and sent as if
// it were this app's. A desktop-independent window filter captures only this app's window, even when it is partly
// covered, and ishara-overlay's own windows can never appear in it.
var capRect = CGRect.zero // the screen rect (AX space) the captured image covers
func overlapArea(_ a: CGRect, _ b: CGRect) -> Double { let i = a.intersection(b); return i.isNull ? 0 : Double(i.width * i.height) }
func captureWindow() -> CGImage? {
    guard CGPreflightScreenCaptureAccess() else {
        err("ishara-ax: OCR skipped, Screen Recording permission is missing. Grant it to the app that launched this (System Settings > Privacy & Security > Screen & System Audio Recording).")
        ocrNote = "no-screen-recording-permission"
        return nil
    }
    var out: CGImage?
    let sem = DispatchSemaphore(value: 0)
    let pid = app.processIdentifier
    Task {
        defer { sem.signal() }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let mine = content.windows.filter { $0.owningApplication?.processID == pid && $0.frame.width > 50 }
            guard let w = mine.max(by: { overlapArea($0.frame, winFrame) < overlapArea($1.frame, winFrame) }),
                  overlapArea(w.frame, winFrame) > 0.5 * Double(winFrame.width * winFrame.height) else { ocrNote = "no-window"; return }
            let filter = SCContentFilter(desktopIndependentWindow: w)
            let cfg = SCStreamConfiguration()
            let scale = Double(filter.pointPixelScale)
            cfg.width = Int(w.frame.width * scale); cfg.height = Int(w.frame.height * scale)
            cfg.showsCursor = false
            capRect = w.frame
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
        // covers capRect (the window) exactly, so flip y and scale to screen points (top-left, same as AX).
        let b = o.boundingBox
        let x = capRect.minX + Double(b.minX) * capRect.width
        let y = capRect.minY + Double(1 - b.maxY) * capRect.height
        let el = El(role: "text", label: clip(text), x: x, y: y, w: Double(b.width) * capRect.width, h: Double(b.height) * capRect.height)
        if visibleWin.contains(CGPoint(x: el.x + el.w / 2, y: el.y + el.h / 2)) { ocrEls.append(el) } // part of the window that is off every screen is not "in view"
    }
    ocrNote = "ran:\(ocrLevel):\(ocrEls.count)"
}
// Context mode also reads the pixels when the tree gave almost no PROSE (System Settings: dozens of labelled buttons but
// the description text lives in one opaque field): a tutor that only knows control names cannot explain a window.
let axProse = blocks.reduce(0) { $0 + $1.text.count }
if ocrMode == "always" || (ocrMode == "auto" && (axLabelled < 25 || (ctxMode && axProse < 300))) { runOCR() }
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
// Context mode: AX text blocks count as "already seen" too, so OCR does not repeat a paragraph the tree gave us.
let blockEls: [El] = ctxMode ? blocks.filter { $0.hasRect }.map { El(role: "text", label: $0.text, x: $0.x, y: $0.y, w: $0.w, h: $0.h) } : []
var all = found + statics + blockEls
let baseCount = all.count
for o in ocrEls {
    let n = norm(o.label)
    let dup = all.contains { a in
        let an = norm(a.label)
        let same = !an.isEmpty && (an.contains(n) || n.contains(an))
        return (overlap(a, o) > 0.5 && (same || a.label.isEmpty || a.role == "text")) || (same && abs(a.y - o.y) < max(a.h, o.h) && abs(a.x - o.x) < 40)
    }
    if !dup && !n.isEmpty { all.append(o) }
}

// ---------- context mode: emit controls with state, blocks, selection, focus ----------
func byReading(_ a: (x: Double, y: Double), _ b: (x: Double, y: Double)) -> Bool {
    let ra = Int(a.y / 8), rb = Int(b.y / 8)
    return ra != rb ? ra < rb : a.x < b.x
}
if ctxMode {
    var ctls = found.sorted { byReading(($0.x, $0.y), ($1.x, $1.y)) }
    if ctls.count > 150 { ctls = Array(ctls.prefix(150)) }
    var controlsJSON: [[String: Any]] = []
    var focusedId: String? = nil
    var sameSoFar: [String: Int] = [:] // (mapped role, label) -> how many earlier controls share it, in reading order
    for (i, e) in ctls.enumerated() {
        let id = "b\(i)"
        var o: [String: Any] = ["id": id, "label": e.label, "role": e.role,
                                "rect": ["x": Int(e.x.rounded()), "y": Int(e.y.rounded()), "w": Int(e.w.rounded()), "h": Int(e.h.rounded())]]
        if !e.ctl.isEmpty { o["ctl"] = e.ctl }
        if !e.state.isEmpty { o["state"] = e.state }
        // The STABLE selector for ishara-act (agent mode): a pointer dies with this process, so the executor re-finds the
        // control by role + label + its index among same-labelled controls (the same reading order and filters as here).
        let key = e.role + "|" + norm(e.label)
        let idx = sameSoFar[key] ?? 0; sameSoFar[key] = idx + 1
        o["selector"] = ["role": e.role, "axRole": e.axRole, "label": e.label, "index": idx, "secure": e.ctl == "password"] as [String: Any]
        controlsJSON.append(o)
        if let f = focusedEl, let ee = e.elem, CFEqual(f, ee) { focusedId = id }
    }
    for o in all[baseCount...] where !o.label.isEmpty { // OCR survivors: plain text lines
        blocks.append(Blk(kind: "text", text: o.label, x: o.x, y: o.y, w: o.w, h: o.h, hasRect: true, inView: true))
    }
    let withRect = blocks.filter { $0.hasRect }.sorted { byReading(($0.x, $0.y), ($1.x, $1.y)) }
    let ordered = withRect + blocks.filter { !$0.hasRect }
    var blocksJSON: [[String: Any]] = []
    for b in ordered.prefix(500) {
        var o: [String: Any] = ["kind": b.kind, "text": b.text, "inView": b.inView]
        if !b.cells.isEmpty { o["cells"] = b.cells }
        if b.error { o["error"] = true }
        if b.hasRect { o["rect"] = ["x": Int(b.x.rounded()), "y": Int(b.y.rounded()), "w": Int(b.w.rounded()), "h": Int(b.h.rounded())] }
        blocksJSON.append(o)
    }
    var selection = ""
    if let f = focusedEl, !isSecure(axStr(f, kAXRoleAttribute), axStr(f, kAXSubroleAttribute)) {
        selection = clean(axStr(f, kAXSelectedTextAttribute))
    }
    let mid = CGPoint(x: visibleWin.midX, y: visibleWin.midY)
    let disp = screenRects.first { $0.contains(mid) } ?? screenRects.first ?? winFrame
    var out: [String: Any] = [
        "mode": "context",
        "app": app.localizedName ?? "app", "bundleId": app.bundleIdentifier ?? "",
        "title": clean(axStr(window, kAXTitleAttribute)),
        "viewport": ["w": Int(winFrame.width.rounded()), "h": Int(winFrame.height.rounded())],
        "origin": ["x": Int(winFrame.minX.rounded()), "y": Int(winFrame.minY.rounded())],
        "display": ["x": Int(disp.minX.rounded()), "y": Int(disp.minY.rounded()), "w": Int(disp.width.rounded()), "h": Int(disp.height.rounded())],
        "controls": controlsJSON, "blocks": blocksJSON, "ocr": ocrNote, "axNodes": visited,
    ]
    if !selection.isEmpty { out["selection"] = selection }
    if let f = focusedId { out["focused"] = f }
    err("ishara-ax: \(app.localizedName ?? "app") | context | \(controlsJSON.count) controls, \(blocksJSON.count) blocks | ax \(axMs) ms | ocr \(ocrNote) (+\(ocrMs - axMs) ms) | total \(ms()) ms")
    let data = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
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
