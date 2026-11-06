// ishara-overlay: draws Ishara's cursor, marks and speaking pill on top of ANY app (docs/UI-PILL.md, docs/DESKTOP.md).
// Reads one JSON command per line on stdin:
//   {"cmd":"state","state":"preparing|listening|thinking|speaking|refused|idle","text":"..","sub":".."}   the pill's state
//   {"cmd":"level","rms":0.02}                  microphone level: moves the LISTENING bars
//   {"cmd":"speaking","text":".."}              the voice STARTED this sentence: the pill shows exactly it ("" = quiet)
//   {"cmd":"steps","n":2,"m":6}                 guide mode: chip "2/6" and the clickable buttons (m <= 1 hides them)
//   {"cmd":"point","x":..,"y":..,"rect":{"x","y","w","h"}?,"kind":"control|block"?,"keep":true?,"text":".."?}
//        needle cursor glides to (x,y), ripples, then marks the rect: a control gets a pen-drawn blue boundary, a text
//        block (kind "block") a yellow highlighter band. A second point in one answer dims the first.
//   {"cmd":"say","text":"..","append":bool}     a streamed sentence: queued in the pill (>= 1.5 s each) until `speaking` takes over
//   {"cmd":"done"}                              the turn ended: let the pill linger, then fade
//   {"cmd":"clear"}                             hide everything
// Agent mode (docs/AGENT-MODE.md, docs/DESKTOP.md "Agent mode"):
//   {"cmd":"agentmode","on":true}               armed/disarmed: a small "Agent" chip rides on the pill while armed
//   {"cmd":"agent","text":"..","step":3,"risk":"low|medium|high"}   what the agent is doing now: chip "Step 3" and a stop
//                                               button; step 0 = the task ended (the buttons go, the text lingers)
//   {"cmd":"approval","text":"..","sub":".."}   a HIGH-risk action waiting: the pill says it in words, with approve / deny
// Older commands keep working: think (= state thinking; "Listening..." texts = state listening), ask (note pill),
// stop (= state refused), step (= steps).
// The pill lives in its OWN non-activating panel so buttons can be clicked; the big drawing window stays click-through.
// Button presses are printed on stdout: {"ev":"walk","cmd":"next|back|stop"}, and in agent mode
// {"ev":"approve","approve":true|false} and {"ev":"agent","cmd":"stop"}.
// x,y are SCREEN POINTS with a top-left origin (what the Accessibility API reports and what ishara-ax emits).
// Look mirrors extension/overlay.js: needle cursor, pill #1f1147, refused #7f1d1d, boundary #3b82f6, highlighter #fde047.
// Reduce Motion: final state only (no pulse, dance, pen stroke, glide).
//
// Build: swiftc -O -swift-version 5 desktop/ishara-overlay.swift -o desktop/ishara-overlay
import AppKit

// Why a flipped content view: AX gives top-left-origin coordinates, AppKit is bottom-left. One flipped view
// spanning every screen lets us place things with the AX numbers after a single translation.
final class Canvas: NSView { override var isFlipped: Bool { true } }

let app = NSApplication.shared
app.setActivationPolicy(.accessory) // no Dock icon, never becomes the active app, so it cannot steal focus

let screens = NSScreen.screens
var union = screens.first?.frame ?? .zero
for s in screens { union = union.union(s.frame) }
let primaryH = screens.first?.frame.height ?? union.height

let win = NSWindow(contentRect: union, styleMask: .borderless, backing: .buffered, defer: false)
win.isOpaque = false
win.backgroundColor = .clear
win.hasShadow = false
win.ignoresMouseEvents = true                       // clicks pass straight through to the app underneath
win.level = .screenSaver                            // above normal windows and full-screen apps' chrome
win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
let canvas = Canvas(frame: NSRect(origin: .zero, size: union.size))
canvas.wantsLayer = true
win.contentView = canvas

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: a)
}

// screen point (top-left origin, primary display) -> canvas point (flipped, union-local)
func toCanvas(_ x: Double, _ y: Double) -> CGPoint {
    CGPoint(x: x - union.minX, y: (union.maxY - primaryH) + y)
}


let saffron = rgb(0xf59e0b)
// Reduce Motion is read per command so flipping the setting takes effect without restarting the overlay.
var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

// Why a "stage" layer: one container for all drawing, under the bubble NSView. Measured on screen: the flipped
// view's backing layer is already geometry-flipped and nested layers inherit it, so everything below is y-down
// (top-left origin) with no extra flip, matching the SVG numbers copied from extension/overlay.js. Adding a
// second isGeometryFlipped here put the cursor upside down and the marker at the mirrored screen height.
let stage = CALayer()
stage.frame = CGRect(origin: .zero, size: union.size)
canvas.layer!.addSublayer(stage)

// ---- cursor: host (glides; position = the tip) > fx (dance x) > fy (dance y / bob) > needle ----
// A zero-size host/fx/fy means rotation and translation pivot on the tip, which is the hotspot, like .ptr.
let host = CALayer()
host.isHidden = true
let fx = CALayer(), fy = CALayer()
host.addSublayer(fx); fx.addSublayer(fy)

let needle = CALayer()
needle.frame = CGRect(x: -4, y: -3, width: 36, height: 36) // tip (4,3) of the 36x36 box lands on the host origin
needle.shadowColor = rgb(0x1e145a).cgColor
needle.shadowOpacity = 0.45; needle.shadowRadius = 3; needle.shadowOffset = CGSize(width: 0, height: -3)
let needlePath = CGMutablePath()
needlePath.move(to: CGPoint(x: 4, y: 3));      needlePath.addLine(to: CGPoint(x: 4, y: 27))
needlePath.addLine(to: CGPoint(x: 10.2, y: 21.4)); needlePath.addLine(to: CGPoint(x: 14.6, y: 31.2))
needlePath.addLine(to: CGPoint(x: 19.2, y: 29.1)); needlePath.addLine(to: CGPoint(x: 14.8, y: 19.6))
needlePath.addLine(to: CGPoint(x: 23.2, y: 19.2)); needlePath.closeSubpath()
let fill = CAGradientLayer()
fill.frame = needle.bounds
fill.colors = [rgb(0x6366f1).cgColor, rgb(0x7c3aed).cgColor]
fill.startPoint = CGPoint(x: 0, y: 0); fill.endPoint = CGPoint(x: 1, y: 1)
let fillMask = CAShapeLayer(); fillMask.frame = needle.bounds; fillMask.path = needlePath
fill.mask = fillMask
let outline = CAShapeLayer()
outline.frame = needle.bounds; outline.path = needlePath
outline.fillColor = nil; outline.strokeColor = NSColor.white.cgColor
outline.lineWidth = 2; outline.lineJoin = .round
let tip = CAShapeLayer() // saffron dot with a white ring marks the exact hotspot
tip.frame = needle.bounds
tip.path = CGPath(ellipseIn: CGRect(x: 4 - 3.6, y: 3 - 3.6, width: 7.2, height: 7.2), transform: nil)
tip.fillColor = saffron.cgColor; tip.strokeColor = NSColor.white.cgColor; tip.lineWidth = 1.5
needle.addSublayer(fill); needle.addSublayer(outline); needle.addSublayer(tip)
fy.addSublayer(needle)

// Two saffron rings that expand from the tip on landing (.rip: scale .3 to 3.2, fade, .9 s, twice).
let ripples: [CAShapeLayer] = (0..<2).map { _ in
    let r = CAShapeLayer()
    r.bounds = CGRect(x: 0, y: 0, width: 28, height: 28); r.position = .zero
    r.path = CGPath(ellipseIn: r.bounds.insetBy(dx: 1.25, dy: 1.25), transform: nil)
    r.fillColor = nil; r.strokeColor = saffron.cgColor; r.lineWidth = 2.5; r.opacity = 0
    host.insertSublayer(r, at: 0)
    return r
}
stage.addSublayer(host)

// Marks (boundary / highlighter) live in their own layer UNDER the cursor so the needle tip is never hidden by ink.
let markLayer = CALayer()
markLayer.frame = stage.bounds
stage.insertSublayer(markLayer, below: host)

// Where the cursor tip is drawn right now (host + dance offsets, from the presentation layers), so a new
// command glides from the real spot even mid-figure-eight.
func currentTip() -> CGPoint {
    let hp = host.presentation()?.position ?? host.position
    let ox = fx.presentation()?.value(forKeyPath: "transform.translation.x") as? CGFloat ?? 0
    let oy = fy.presentation()?.value(forKeyPath: "transform.translation.y") as? CGFloat ?? 0
    return CGPoint(x: hp.x + ox, y: hp.y + oy)
}
var thinking = false // the figure-eight is running: a repeated think (the Listening meter ticks at 8 Hz) only updates text
func stopMotion() {
    thinking = false
    fx.removeAllAnimations(); fy.removeAllAnimations()
    ripples.forEach { $0.removeAllAnimations() }
}
func setNoImplicit(_ f: () -> Void) {
    CATransaction.begin(); CATransaction.setDisableActions(true); f(); CATransaction.commit()
}

// The screen the active window is on, as a top-left-origin rect in the same space as AX coordinates.
func activeScreenRect() -> CGRect {
    var target: NSScreen? = nil
    if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
       let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
        for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
            if let b = w[kCGWindowBounds as String] as? [String: CGFloat], let x = b["X"], let y = b["Y"], let ww = b["Width"], let hh = b["Height"] {
                // CG bounds are top-left origin; NSScreen frames are bottom-left of the primary display.
                let c = CGPoint(x: x + ww / 2, y: primaryH - (y + hh / 2))
                target = screens.first { $0.frame.contains(c) }
                if target != nil { break }
            }
        }
    }
    let f = (target ?? NSScreen.main ?? screens.first)?.frame ?? union
    return CGRect(x: f.minX, y: primaryH - f.maxY, width: f.width, height: f.height)
}

// Glide the tip to p (canvas points). From where it is now, or the screen centre on first appearance.
func glide(to p: CGPoint) {
    let from = host.isHidden ? CGPoint(x: union.width / 2, y: union.height / 2) : currentTip()
    stopMotion()
    setNoImplicit { host.position = p; host.isHidden = false }
    if reduceMotion { return }
    let a = CABasicAnimation(keyPath: "position")
    a.fromValue = NSValue(point: from); a.toValue = NSValue(point: p)
    a.duration = 0.75
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.9, 0.2, 1) // the browser's cubic-bezier
    host.add(a, forKey: "glide")
}

// Landing: ripples at 0.65 s (the browser's arriveTimer), then a gentle bob. The mark is drawn by addMark at the same beat.
func arrive() {
    if reduceMotion { return } // final state only: no ripple, no bob
    let t0 = CACurrentMediaTime() + 0.65
    for r in ripples {
        let s = CABasicAnimation(keyPath: "transform.scale"); s.fromValue = 0.3; s.toValue = 3.2
        let o = CABasicAnimation(keyPath: "opacity"); o.fromValue = 0.9; o.toValue = 0.0
        let g = CAAnimationGroup(); g.animations = [s, o]; g.duration = 0.9; g.repeatCount = 2
        g.beginTime = t0; g.fillMode = .backwards
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        r.add(g, forKey: "rip")
    }
    // bob: about 2 px right, 5 px down, -3 degrees, 1.8 s ease-in-out loop
    var down = CATransform3DMakeTranslation(2, 5, 0)
    down = CATransform3DRotate(down, -3 * .pi / 180, 0, 0, 1)
    let bob = CAKeyframeAnimation(keyPath: "transform")
    bob.values = [CATransform3DIdentity, down, CATransform3DIdentity].map { NSValue(caTransform3D: $0) }
    bob.keyTimes = [0, 0.5, 1]
    bob.timingFunctions = [CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeInEaseOut)]
    bob.duration = 1.8; bob.repeatCount = .infinity; bob.beginTime = t0; bob.fillMode = .backwards
    fy.add(bob, forKey: "bob")
}

// ---- marks ----
// CONTROLS: a rounded rectangle hugging the element, 2.5 pt blue with a soft glow, drawn like a pen stroke (strokeEnd).
// TEXT (kind "block"): a translucent yellow highlighter band over the block's rect, sweeping in left to right.
// A second mark in one answer dims the first (it stays as context); at most two live at once.
let BLUE: UInt32 = 0x3b82f6, YELLOW: UInt32 = 0xfde047
var marks: [CALayer] = []
var markRectsAX: [CGRect] = []        // where marks (and the cursor tip) are, in AX space: the pill must never cover them

func clearMarks() {
    marks.forEach { $0.removeFromSuperlayer() }
    marks = []; markRectsAX = []
}
func addMark(_ r: CGRect, block: Bool) {
    // dim what is already there; drop the oldest beyond two
    for m in marks {
        if reduceMotion { m.opacity = 0.35 } else {
            let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = m.opacity; a.toValue = 0.35; a.duration = 0.3
            m.opacity = 0.35; m.add(a, forKey: "dim")
        }
    }
    while marks.count >= 2 { marks.removeFirst().removeFromSuperlayer() }
    let t0 = CACurrentMediaTime() + 0.65 // after the cursor lands, like the ripple
    let layer: CALayer
    if block {
        let band = CALayer()
        let f = r.insetBy(dx: -3, dy: -2)
        band.anchorPoint = CGPoint(x: 0, y: 0.5)  // grows from the left edge
        band.bounds = CGRect(origin: .zero, size: f.size)
        band.position = CGPoint(x: f.minX, y: f.midY)
        band.backgroundColor = rgb(YELLOW, 0.35).cgColor
        band.cornerRadius = 4
        if !reduceMotion {
            let a = CABasicAnimation(keyPath: "transform.scale.x"); a.fromValue = 0.001; a.toValue = 1
            a.duration = 0.45; a.beginTime = t0; a.fillMode = .backwards
            a.timingFunction = CAMediaTimingFunction(name: .easeOut)
            band.add(a, forKey: "sweep")
        }
        layer = band
    } else {
        let box = CAShapeLayer()
        box.path = CGPath(roundedRect: r.insetBy(dx: -5, dy: -5), cornerWidth: 8, cornerHeight: 8, transform: nil)
        box.fillColor = nil; box.strokeColor = rgb(BLUE).cgColor
        box.lineWidth = 2.5; box.lineCap = .round; box.lineJoin = .round
        box.shadowColor = rgb(BLUE).cgColor; box.shadowOpacity = 0.85; box.shadowRadius = 6; box.shadowOffset = .zero // soft glow
        if !reduceMotion {
            let a = CABasicAnimation(keyPath: "strokeEnd"); a.fromValue = 0; a.toValue = 1
            a.duration = 0.5; a.beginTime = t0; a.fillMode = .backwards
            a.timingFunction = CAMediaTimingFunction(name: .easeOut)
            box.add(a, forKey: "pen")
        }
        layer = box
    }
    markLayer.addSublayer(layer)
    marks.append(layer)
}

// Thinking: a figure-eight around 55% of the screen height on the active window's screen. x sweeps +-46 over
// 3.6 s (alternating) while y sweeps +-22 over 1.8 s, which is a Lissajous 1:2 figure-eight.
func think() {
    if thinking && !host.isHidden { return }
    let sr = activeScreenRect()
    let c = toCanvas(Double(sr.midX), Double(sr.minY + sr.height * 0.55))
    let from = host.isHidden ? c : currentTip()
    stopMotion()
    setNoImplicit { host.position = c; host.isHidden = false }
    if reduceMotion { thinking = true; return } // static cursor, no dance
    thinking = true
    if from != c { // a visible cursor eases to the dance centre instead of jumping there
        let a = CABasicAnimation(keyPath: "position")
        a.fromValue = NSValue(point: from); a.toValue = NSValue(point: c); a.duration = 0.5
        a.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.9, 0.2, 1)
        host.add(a, forKey: "glide")
    }
    let ax = CABasicAnimation(keyPath: "transform.translation.x")
    ax.fromValue = -46; ax.toValue = 46; ax.duration = 3.6; ax.autoreverses = true; ax.repeatCount = .infinity
    ax.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
    // autoreverse doubles the period, so duration 3.6 each way = 7.2 s round trip, as CSS "alternate" does.
    fx.add(ax, forKey: "fx")
    let ay = CAKeyframeAnimation(keyPath: "transform.translation.y")
    ay.values = [0, -22, 0, 22, 0]; ay.keyTimes = [0, 0.25, 0.5, 0.75, 1]
    ay.calculationMode = .cubic
    ay.duration = 1.8; ay.repeatCount = .infinity
    fy.add(ay, forKey: "fy")
}

// ---- the pill ----
// One compact pill, bottom-centre of the screen that holds the frontmost window (or the pointed target), ~120 pt above the
// bottom edge. It shows the sentence being SPOKEN, never the whole answer. It lives in its own non-activating panel so the
// guide buttons can be clicked while the big drawing window above stays click-through. The panel itself ignores the mouse
// (so a click on the pill's text goes to the app below); the buttons are a second tiny panel that covers only the
// buttons, which is the one place a click is taken.
enum Look { case preparing, listening, thinking, speaking, refused, note }

final class NonKeyPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
func makePanel(_ rect: NSRect, level: Int) -> NonKeyPanel {
    let p = NonKeyPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
    p.level = NSWindow.Level(rawValue: level)
    p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    p.becomesKeyOnlyIfNeeded = true; p.hidesOnDeactivate = false; p.isReleasedWhenClosed = false
    return p
}

let PILL_MAX_W: CGFloat = 520, PILL_MIN_W: CGFloat = 150, SHADOW_M: CGFloat = 26
let PILL_FONT = NSFont.systemFont(ofSize: 15, weight: .regular)
let BTN: CGFloat = 26, BTN_GAP: CGFloat = 4
let pillPanel = makePanel(NSRect(x: 0, y: 0, width: 300, height: 100), level: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
pillPanel.ignoresMouseEvents = true
let pillRoot = NSView(frame: NSRect(x: 0, y: 0, width: 300, height: 100))
pillPanel.contentView = pillRoot
let pillBox = NSView()
pillBox.wantsLayer = true
pillBox.layer!.cornerRadius = 16
pillBox.layer!.shadowColor = NSColor.black.cgColor
pillBox.layer!.shadowOpacity = 0.35; pillBox.layer!.shadowRadius = 12; pillBox.layer!.shadowOffset = CGSize(width: 0, height: -4)
pillRoot.addSubview(pillBox)

let pillText = NSTextField(wrappingLabelWithString: "")
pillText.font = PILL_FONT; pillText.textColor = .white
pillText.maximumNumberOfLines = 2; pillText.lineBreakMode = .byWordWrapping // (.byTruncatingTail would stop it wrapping at all)
pillText.cell?.truncatesLastVisibleLine = true
pillBox.addSubview(pillText)
let chip = NSTextField(labelWithString: "")
chip.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold); chip.textColor = NSColor(white: 1, alpha: 0.75)
chip.alignment = .center
pillBox.addSubview(chip)

// indicator: a 30x30 area at the left. A dot (preparing / refused / note), four bars (listening / speaking), three dots (thinking).
let ind = CALayer(); ind.frame = CGRect(x: 0, y: 0, width: 30, height: 30)
pillBox.layer!.addSublayer(ind)
let dot = CALayer(); dot.bounds = CGRect(x: 0, y: 0, width: 12, height: 12); dot.cornerRadius = 6; dot.position = CGPoint(x: 15, y: 15)
let bars: [CALayer] = (0..<4).map { i in
    let b = CALayer(); b.bounds = CGRect(x: 0, y: 0, width: 4, height: 6); b.cornerRadius = 2
    b.position = CGPoint(x: 4.5 + CGFloat(i) * 7, y: 15); return b
}
let tdots: [CALayer] = (0..<3).map { i in
    let b = CALayer(); b.bounds = CGRect(x: 0, y: 0, width: 7, height: 7); b.cornerRadius = 3.5
    b.position = CGPoint(x: 5 + CGFloat(i) * 10, y: 15); return b
}
ind.addSublayer(dot); bars.forEach { ind.addSublayer($0) }; tdots.forEach { ind.addSublayer($0) }

var pointedThisTurn = false
var look: Look = .note
var pillVisible = false
var stepChip = ""            // "2/6", empty = not a guide
var stepsOn = false
// Agent mode. The pill's chip and button strip were built for the guide (n/m, ‹ › ✕); the agent reuses both: a different chip
// text, and a different button set (stop, or approve / deny). nil agentBtns = the guide's buttons, shown only while stepsOn.
var agentArmed = false
var agentStep = 0
var agentBtns: [(String, String)]? = nil
var chipW: CGFloat = 38
let GUIDE_BTNS: [(String, String)] = [("‹", "back"), ("›", "next"), ("✕", "stop")]
func btnItems() -> [(String, String)] { agentBtns ?? GUIDE_BTNS }
func btnsOn() -> Bool { stepsOn || agentBtns != nil }
func btnW() -> CGFloat { let n = CGFloat(btnItems().count); return BTN * n + BTN_GAP * (n - 1) }
func chipLabel() -> String { stepsOn ? stepChip : (agentStep > 0 ? "Step \(agentStep)" : (agentArmed ? "Agent" : "")) }
// Room the chip and buttons take at the right end of the pill, so the text wraps before them.
func rightReserve() -> CGFloat {
    let label = chipLabel()
    let cw = label.isEmpty ? 0 : max(38, ceil((label as NSString).size(withAttributes: [.font: chip.font as Any]).width) + 12)
    chipW = cw == 0 ? 38 : cw
    if btnsOn() { return 8 + chipW + 8 + btnW() }
    return label.isEmpty ? 0 : 8 + chipW
}
var curText = "", curSub = ""
var micLevel: CGFloat = 0
let BAR_GAIN: [CGFloat] = [0.6, 1.0, 0.8, 0.5]

// Page the sentence: at most two lines of 15 pt fit, so a long sentence is shown in 2-line pages, paced like speech.
func textWidthAvail() -> CGFloat {
    let reserve: CGFloat = rightReserve()
    return PILL_MAX_W - 16 - 30 - 12 - 16 - reserve
}
func lineHeight() -> CGFloat { ceil(("Ag" as NSString).size(withAttributes: [.font: PILL_FONT]).height) }
// NSTextField's cell insets its text by a few points, so measuring at the full width undercounts and the label then wraps or
// truncates ("Getting read…"). Measure inside a margin and give the label that margin back.
let CELL_PAD: CGFloat = 8
func measure(_ s: String, _ w: CGFloat) -> NSSize {
    let r = (s as NSString).boundingRect(with: NSSize(width: w - CELL_PAD, height: 10000), options: [.usesLineFragmentOrigin], attributes: [.font: PILL_FONT])
    return NSSize(width: ceil(r.width), height: ceil(r.height))
}
func pages(_ text: String) -> [String] {
    let w = textWidthAvail(), maxH = lineHeight() * 2 + 2
    var out: [String] = [], cur = ""
    for word in text.split(whereSeparator: { $0 == " " || $0 == "\n" }) {
        let trial = cur.isEmpty ? String(word) : cur + " " + word
        if measure(trial, w).height <= maxH || cur.isEmpty { cur = trial } else { out.append(cur); cur = String(word) }
    }
    if !cur.isEmpty { out.append(cur) }
    return out
}
func wordCount(_ s: String) -> Int { s.split(separator: " ").count }
func pageSeconds(_ p: String) -> TimeInterval { max(1.5, Double(wordCount(p)) / 2.8) }

func setIndicator(_ l: Look) {
    ind.sublayers?.forEach { $0.removeAllAnimations() }
    dot.isHidden = true; bars.forEach { $0.isHidden = true }; tdots.forEach { $0.isHidden = true }
    switch l {
    case .preparing:
        dot.isHidden = false; dot.backgroundColor = rgb(0xf59e0b).cgColor
        if !reduceMotion {
            let o = CABasicAnimation(keyPath: "opacity"); o.fromValue = 1; o.toValue = 0.3
            let s = CABasicAnimation(keyPath: "transform.scale"); s.fromValue = 1; s.toValue = 0.7
            let g = CAAnimationGroup(); g.animations = [o, s]; g.duration = 0.7; g.autoreverses = true; g.repeatCount = .infinity
            dot.add(g, forKey: "pulse")
        }
    case .listening:
        bars.forEach { $0.isHidden = false; $0.backgroundColor = rgb(0x60a5fa).cgColor }
        setLevel(micLevel)
    case .thinking:
        tdots.forEach { $0.isHidden = false; $0.backgroundColor = rgb(0xa5b4fc).cgColor }
        if !reduceMotion {
            for (i, d) in tdots.enumerated() {
                let a = CAKeyframeAnimation(keyPath: "transform.translation.y")
                a.values = [0, 6, 0, 0]; a.keyTimes = [0, 0.25, 0.5, 1]; a.duration = 1.0; a.repeatCount = .infinity
                a.beginTime = CACurrentMediaTime() + Double(i) * 0.16; a.fillMode = .backwards
                d.add(a, forKey: "dance")
            }
        }
    case .speaking:
        bars.forEach { $0.isHidden = false; $0.backgroundColor = rgb(0xc4b5fd).cgColor }
        for (i, b) in bars.enumerated() {
            if reduceMotion { b.bounds.size.height = [10, 20, 14, 8][i]; continue }
            b.bounds.size.height = 22
            let a = CABasicAnimation(keyPath: "transform.scale.y"); a.fromValue = 0.25; a.toValue = 1
            a.duration = 0.38 + Double(i) * 0.09; a.autoreverses = true; a.repeatCount = .infinity
            a.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            b.add(a, forKey: "wave")
        }
    case .refused:
        dot.isHidden = false; dot.backgroundColor = rgb(0xf87171).cgColor
    case .note:
        dot.isHidden = false; dot.backgroundColor = rgb(0xa78bfa).cgColor
    }
}
func setLevel(_ lv: CGFloat) {
    micLevel = lv
    guard look == .listening else { return }
    CATransaction.begin(); CATransaction.setAnimationDuration(0.12)
    for (i, b) in bars.enumerated() { b.bounds.size.height = 6 + 22 * min(1, lv * BAR_GAIN[i] + (lv > 0.02 ? 0.05 : 0)) }
    CATransaction.commit()
}

// ---- buttons: their own tiny panel on top of the pill's right end ----
final class ButtonsView: NSView {
    var items: [(String, String)] { btnItems() }
    var pressed = -1
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true } // the panel is never key: the first click must count
    func cell(_ i: Int) -> NSRect { NSRect(x: CGFloat(i) * (BTN + BTN_GAP), y: 0, width: BTN, height: BTN) }
    // Anything that is not a button returns nil, so even a click in the gap between buttons is not taken by this view.
    override func hitTest(_ point: NSPoint) -> NSView? {
        let p = convert(point, from: superview)
        return items.indices.contains { cell($0).contains(p) } ? self : nil
    }
    override func draw(_ dirty: NSRect) {
        for (i, it) in items.enumerated() {
            let r = cell(i)
            NSColor(white: 1, alpha: pressed == i ? 0.34 : 0.16).setFill()
            NSBezierPath(ovalIn: r).fill()
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: (it.0 == "✕" || it.0 == "■") ? 12 : (it.0 == "✓" ? 16 : 19), weight: .medium), .foregroundColor: NSColor.white]
            let sz = (it.0 as NSString).size(withAttributes: a)
            (it.0 as NSString).draw(at: NSPoint(x: r.midX - sz.width / 2, y: r.midY - sz.height / 2 + (it.0 == "✕" || it.0 == "■" ? 0 : 1)), withAttributes: a)
        }
    }
    func index(_ e: NSEvent) -> Int { let p = convert(e.locationInWindow, from: nil); return items.indices.first { cell($0).contains(p) } ?? -1 }
    override func mouseDown(with e: NSEvent) { pressed = index(e); needsDisplay = true }
    override func mouseUp(with e: NSEvent) {
        let i = index(e); let was = pressed
        pressed = -1; needsDisplay = true
        guard i >= 0, i == was else { return }
        // The helper reads this line and runs the SAME walk command the voice words next / back / stop run.
        switch items[i].1 {
        case "approve": print("{\"ev\":\"approve\",\"approve\":true}")   // agent mode: the helper answers the waiting HIGH-risk action
        case "deny": print("{\"ev\":\"approve\",\"approve\":false}")
        case "agentstop": print("{\"ev\":\"agent\",\"cmd\":\"stop\"}")
        default: print("{\"ev\":\"walk\",\"cmd\":\"\(items[i].1)\"}")
        }
        fflush(stdout)
    }
}
let btnPanel = makePanel(NSRect(x: 0, y: 0, width: BTN * 3 + BTN_GAP * 2, height: BTN), level: Int(CGWindowLevelForKey(.screenSaverWindow)) + 2)
btnPanel.ignoresMouseEvents = false
let btnView = ButtonsView(frame: NSRect(x: 0, y: 0, width: BTN * 3 + BTN_GAP * 2, height: BTN))
btnPanel.contentView = btnView

// ---- state ----
var pageQueue: [String] = []      // pages waiting behind the one on screen
var pageTimer: Timer?             // non-nil while the page on screen is still inside its minimum time
var speakingMode = false          // `speaking` events are arriving: they own the text, `say` is ignored
var doneSeen = false
var hideTimer: Timer?
func armHide(_ secs: TimeInterval) {
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { _ in clearAll() }
}
// How long a finished answer lingers. A guide stays much longer: the person is doing the step.
func lingerSecs() -> TimeInterval { stepsOn ? 180 : (agentBtns != nil ? 60 : 7) }

func hopsToTop(_ pill: CGRect, _ scr: CGRect) -> Bool {
    markRectsAX.contains { $0.insetBy(dx: -14, dy: -14).intersects(pill) }
}

func layoutPill() {
    guard pillVisible else { return }
    let tw = textWidthAvail()
    let full = curSub.isEmpty ? curText : curText + "\n" + curSub
    pillText.stringValue = full
    let lh = lineHeight()
    let m = measure(full, tw)
    let textW = max(40, min(tw, m.width + CELL_PAD + 2)), textH = min(m.height, lh * 2)
    let reserve: CGFloat = rightReserve()
    let w = min(PILL_MAX_W, max(PILL_MIN_W, 16 + 30 + 12 + textW + 16 + reserve))
    let h = max(52, textH + 26)
    // placement in AX space (top-left origin) on the screen of the target, else of the frontmost window
    var scr = activeScreenRect()
    if let t = markRectsAX.last {
        for s in screens {
            let r = CGRect(x: s.frame.minX, y: primaryH - s.frame.maxY, width: s.frame.width, height: s.frame.height)
            if r.contains(CGPoint(x: t.midX, y: t.midY)) { scr = r }
        }
    }
    var pill = CGRect(x: scr.midX - w / 2, y: scr.maxY - 120 - h, width: w, height: h)
    if hopsToTop(pill, scr) { pill.origin.y = scr.minY + 44 }
    let cocoaY = primaryH - (pill.minY + h)
    let panelRect = NSRect(x: pill.minX - SHADOW_M, y: cocoaY - SHADOW_M, width: w + SHADOW_M * 2, height: h + SHADOW_M * 2)
    pillPanel.setFrame(panelRect, display: false)
    pillRoot.frame = NSRect(origin: .zero, size: panelRect.size)
    pillBox.frame = NSRect(x: SHADOW_M, y: SHADOW_M, width: w, height: h)
    pillBox.layer!.backgroundColor = (look == .refused ? rgb(0x7f1d1d, 0.94) : rgb(0x1f1147, 0.92)).cgColor
    ind.frame = CGRect(x: 16, y: (h - 30) / 2, width: 30, height: 30)
    pillText.preferredMaxLayoutWidth = textW
    pillText.frame = NSRect(x: 58, y: (h - textH) / 2, width: textW, height: textH)
    let label = chipLabel()
    chip.stringValue = label
    chip.isHidden = label.isEmpty
    chip.frame = NSRect(x: w - 16 - (btnsOn() ? btnW() + 8 : 0) - chipW, y: (h - 16) / 2, width: chipW, height: 16)
    if btnsOn() {
        btnView.frame = NSRect(x: 0, y: 0, width: btnW(), height: BTN); btnView.needsDisplay = true
        btnPanel.setFrame(NSRect(x: pill.maxX - 16 - btnW(), y: cocoaY + (h - BTN) / 2, width: btnW(), height: BTN), display: true)
        btnPanel.orderFrontRegardless()
    } else { btnPanel.orderOut(nil) }
    pillPanel.orderFrontRegardless()
    if btnsOn() { btnPanel.orderFrontRegardless() }
}

func showPill(_ l: Look, _ text: String, sub: String = "") {
    let changed = !pillVisible || l != look
    look = l; curText = text; curSub = sub; pillVisible = true
    if changed { setIndicator(l) }
    layoutPill()
}
func hidePill() {
    pillVisible = false
    pillPanel.orderOut(nil); btnPanel.orderOut(nil)
}
func resetPages() {
    pageTimer?.invalidate(); pageTimer = nil; pageQueue = []
}
// Show the next queued page; it holds the screen for its pace (>= 1.5 s), then the next one follows.
func advancePage() {
    pageTimer?.invalidate(); pageTimer = nil
    guard !pageQueue.isEmpty else {
        if doneSeen { armHide(lingerSecs()) } else { armHide(25) }
        return
    }
    let p = pageQueue.removeFirst()
    showPill(.speaking, p)
    pageTimer = Timer.scheduledTimer(withTimeInterval: pageSeconds(p), repeats: false) { _ in advancePage() }
    armHide(45)
}
func enqueue(_ text: String) {
    pageQueue.append(contentsOf: pages(text))
    if pageTimer == nil { advancePage() }
}

func clearAll() {
    hideTimer?.invalidate(); resetPages()
    stopMotion()
    host.removeAllAnimations(); fy.removeAllAnimations()
    host.isHidden = true
    clearMarks()
    stepsOn = false; stepChip = ""; speakingMode = false; doneSeen = false; micLevel = 0
    agentBtns = nil; agentStep = 0 // (agentArmed stays: it is the user's setting, not a turn's state)
    hidePill()
}
func clearCursor() {
    stopMotion(); host.removeAllAnimations(); fy.removeAllAnimations()
    host.isHidden = true
}

// A screen rect in canvas coordinates (flipped, union-local) from an AX-space rect.
func canvasRect(_ r: CGRect) -> CGRect { CGRect(origin: toCanvas(Double(r.minX), Double(r.minY)), size: r.size) }

// A new question starts: the old answer's marks, queue and speaking mode go; the guide chip stays (a walk turn keeps it).
func beginTurn() {
    resetPages(); clearMarks(); speakingMode = false; doneSeen = false; pointedThisTurn = false
    agentBtns = nil; agentStep = 0 // a tutor turn or a refusal ends the agent's step display and its stop / approve buttons
}

func handle(_ obj: [String: Any]) {
    let cmd = obj["cmd"] as? String ?? ""
    let text = obj["text"] as? String ?? ""
    let sub = obj["sub"] as? String ?? ""
    func num(_ k: String) -> Double? { (obj[k] as? NSNumber)?.doubleValue }
    switch cmd {
    case "state":
        switch obj["state"] as? String ?? "" {
        case "preparing":
            beginTurn(); clearCursor(); micLevel = 0
            showPill(.preparing, text.isEmpty ? "Getting ready…" : text); armHide(45)
        case "listening":
            beginTurn(); clearCursor()
            showPill(.listening, text.isEmpty ? "Speak now" : text); armHide(60)
        case "thinking":
            beginTurn(); think()
            showPill(.thinking, text.isEmpty ? "Thinking…" : text); armHide(40)
        case "speaking":
            showPill(.speaking, text); armHide(45)
        case "refused":
            beginTurn(); clearCursor(); stepsOn = false; stepChip = ""
            showPill(.refused, text, sub: sub); armHide(12)
        default: // idle
            clearAll()
        }
    case "level":
        setLevel(CGFloat(min(1, sqrt(max(0, num("rms") ?? 0)) * 2.8)))
    case "speaking":
        // The voice started this sentence: show exactly it. Empty = the voice went quiet; let the last one linger.
        if text.isEmpty { // only meaningful inside a spoken answer; a stray "quiet" must not hide a pill that is thinking
            guard speakingMode else { return }
            pageTimer?.invalidate(); pageTimer = nil; pageQueue = []; doneSeen = true; armHide(lingerSecs()); return
        }
        speakingMode = true
        resetPages()
        enqueue(text)
    case "say":
        if (obj["append"] as? Bool) != true { resetPages(); speakingMode = false; doneSeen = false }
        if speakingMode || text.isEmpty { return }
        enqueue(text)
    case "steps", "step":
        let n = (obj["n"] as? NSNumber)?.intValue ?? 0, m = (obj["m"] as? NSNumber)?.intValue ?? 0
        stepsOn = m > 1; stepChip = stepsOn ? "\(n)/\(m)" : ""
        layoutPill(); if stepsOn { armHide(lingerSecs()) }
    case "agentmode":
        agentArmed = (obj["on"] as? Bool) == true
        if !agentArmed { agentBtns = nil; agentStep = 0 }
        resetPages(); speakingMode = false
        showPill(.note, agentArmed ? "Agent mode on" : "Agent mode off", sub: agentArmed ? "Tell me what to do. Tap Right Option to stop me." : ""); armHide(5)
    case "agent":
        let st = (obj["step"] as? NSNumber)?.intValue ?? 0
        agentStep = max(0, st)
        agentBtns = st > 0 ? [("■", "agentstop")] : nil
        resetPages(); speakingMode = false
        showPill(.note, text.isEmpty ? "Working…" : text, sub: sub)
        armHide(st > 0 ? 60 : 8)
    case "approval":
        agentBtns = [("✓", "approve"), ("✕", "deny")]
        resetPages(); speakingMode = false
        showPill(.note, text, sub: sub.isEmpty ? "Say yes to approve, no to cancel." : sub); armHide(70)
    case "point":
        guard let x = num("x"), let y = num("y") else { return }
        let p = toCanvas(x, y)
        var rectAX: CGRect? = nil, rect: CGRect? = nil
        if let r = obj["rect"] as? [String: Any],
           let rx = (r["x"] as? NSNumber)?.doubleValue, let ry = (r["y"] as? NSNumber)?.doubleValue,
           let rw = (r["w"] as? NSNumber)?.doubleValue, let rh = (r["h"] as? NSNumber)?.doubleValue, rw > 0, rh > 0 {
            rectAX = CGRect(x: rx, y: ry, width: rw, height: rh)
            rect = CGRect(origin: toCanvas(rx, ry), size: CGSize(width: rw, height: rh))
        }
        // Not a continuation of a streamed answer (old callers): this point is its own answer.
        if (obj["keep"] as? Bool) != true { resetPages(); clearMarks(); speakingMode = false }
        glide(to: p)
        arrive()
        pointedThisTurn = true
        if let r = rect { addMark(r, block: (obj["kind"] as? String) == "block") }
        markRectsAX.append(rectAX ?? CGRect(x: x - 1, y: y - 1, width: 2, height: 2))
        if markRectsAX.count > 2 { markRectsAX.removeFirst() }
        if (obj["keep"] as? Bool) != true && !text.isEmpty { var t = text; if !sub.isEmpty { t += "\n" + sub }; showPill(.note, t) }
        else { layoutPill() }  // the pill may need to hop away from the new target
        armHide(25)
    case "think":
        // legacy: the old push-to-talk texts. "Listening…" plus ▮ blocks is the old level meter.
        if text.hasPrefix("Getting ready") {
            beginTurn(); clearCursor(); micLevel = 0
            showPill(.preparing, text); armHide(45)
        } else if text.hasPrefix("Listening") || text.hasPrefix("Speak now") {
            if look != .listening { beginTurn(); clearCursor() }
            micLevel = CGFloat(text.filter { $0 == "▮" }.count) / 10
            showPill(.listening, "Speak now"); setLevel(micLevel); armHide(60)
        } else {
            var t = text
            if let r = t.range(of: " …thinking") { t.removeSubrange(r) }
            if look != .thinking || !thinking { beginTurn() }
            think(); showPill(.thinking, t.isEmpty ? "Thinking…" : t); armHide(40)
        }
    case "done":
        doneSeen = true
        if !pointedThisTurn { clearCursor() } // an explanation with no pointer: the figure-eight stops with the answer
        if pageTimer == nil && pageQueue.isEmpty { armHide(lingerSecs()) }
    case "ask":
        beginTurn(); clearCursor()
        var t = text; if !sub.isEmpty { t += "\n" + sub }
        showPill(.note, t); armHide(12)
    case "stop":
        beginTurn(); clearCursor(); stepsOn = false; stepChip = "" // a refusal ends any guide
        showPill(.refused, text, sub: sub); armHide(12)
    case "clear":
        clearAll()
    default: break
    }
}

win.orderFrontRegardless() // shows without activating the app
print("{\"ready\":true}"); fflush(stdout)

// stdin on a background thread; UI work hops to main. EOF (parent died) quits so no orphan overlay stays on screen.
Thread.detachNewThread {
    while let line = readLine() {
        guard let d = line.data(using: .utf8), let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
        DispatchQueue.main.async { handle(o) }
    }
    DispatchQueue.main.async { NSApp.terminate(nil) }
}
app.run()
