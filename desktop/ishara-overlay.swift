// ishara-overlay: draws Ishara's pointer ring and answer bubble on top of ANY app.
// Reads one JSON command per line on stdin:
//   {"cmd":"point","x":..,"y":..,"text":"..","rect":{"x","y","w","h"}?}
//        needle cursor glides to (x,y), ripples, then (with rect) a hand-drawn ink loop or underline, then bobs
//   {"cmd":"think","text":".."}                 bubble + cursor traces a figure-eight until the next command
//   {"cmd":"ask","text":".."}                   bubble only
//   {"cmd":"stop","text":"..","sub":".."}       red bubble (safe-stop)
//   {"cmd":"clear"}                             hide everything
// x,y are SCREEN POINTS with a top-left origin (what the Accessibility API reports and what ishara-ax emits).
// Look mirrors extension/overlay.js (.ptr, inkPath, drawInk, thinking) so the tutor feels the same in every app:
// needle cursor, saffron ripple + marker, bubble #1f1147, stop bubble #7f1d1d. Reduce Motion: final state only.
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

// The marker. Sits under the cursor so the needle tip is never hidden by ink.
let ink = CAShapeLayer()
ink.fillColor = nil; ink.strokeColor = saffron.cgColor
ink.lineWidth = 3.5; ink.lineCap = .round; ink.lineJoin = .round
ink.shadowColor = NSColor.white.cgColor; ink.shadowOpacity = 0.9; ink.shadowRadius = 1.5; ink.shadowOffset = .zero // slight white glow
ink.isHidden = true
stage.insertSublayer(ink, below: host)

// Same construction as inkPath() in extension/overlay.js, in canvas points. Wide targets get an underline because
// a loop around a full-width box looks wrong; the wobble is deterministic so the same rect always draws alike.
func inkPath(_ r: CGRect) -> CGPath {
    let d = CGMutablePath()
    if r.width > 420 || r.height > 150 {
        let y = r.minY + r.height + 6, x0 = r.minX + 4, x1 = r.maxX - 4, n = 14
        d.move(to: CGPoint(x: x0, y: y))
        for i in 1...n {
            d.addLine(to: CGPoint(x: x0 + (x1 - x0) * CGFloat(i) / CGFloat(n), y: y + sin(Double(i) * 1.9) * 2.2))
        }
        return d
    }
    let pad: CGFloat = 9, cx = r.midX, cy = r.midY, rx = r.width / 2 + pad + 8, ry = r.height / 2 + pad
    let n = 28, over = 0.16
    var pts: [CGPoint] = []
    for i in 0...Int((Double(n) * (1 + over)).rounded()) {
        let a = -Double.pi * 0.78 + Double(i) / Double(n) * Double.pi * 2
        let w = 1 + sin(Double(i) * 1.7) * 0.022 + Double(i) / Double(n) * 0.035
        pts.append(CGPoint(x: cx + cos(a) * rx * w, y: cy + sin(a) * ry * w))
    }
    d.move(to: pts[0])
    for i in 1..<(pts.count - 1) {
        d.addQuadCurve(to: CGPoint(x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2), control: pts[i])
    }
    return d
}

// Where the cursor tip is drawn right now (host + dance offsets, from the presentation layers), so a new
// command glides from the real spot even mid-figure-eight.
func currentTip() -> CGPoint {
    let hp = host.presentation()?.position ?? host.position
    let ox = fx.presentation()?.value(forKeyPath: "transform.translation.x") as? CGFloat ?? 0
    let oy = fy.presentation()?.value(forKeyPath: "transform.translation.y") as? CGFloat ?? 0
    return CGPoint(x: hp.x + ox, y: hp.y + oy)
}
func stopMotion() {
    fx.removeAllAnimations(); fy.removeAllAnimations()
    ripples.forEach { $0.removeAllAnimations() }
    ink.removeAllAnimations()
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

// Landing: ripples at 0.65 s (the browser's arriveTimer), the marker drawn like a pen, then a gentle bob.
func arrive(rect: CGRect?) {
    ink.isHidden = true
    if let r = rect {
        ink.path = inkPath(r)
        ink.isHidden = false
    }
    if reduceMotion { return } // final state only: no ripple, no pen stroke, no bob
    let t0 = CACurrentMediaTime() + 0.65
    for r in ripples {
        let s = CABasicAnimation(keyPath: "transform.scale"); s.fromValue = 0.3; s.toValue = 3.2
        let o = CABasicAnimation(keyPath: "opacity"); o.fromValue = 0.9; o.toValue = 0.0
        let g = CAAnimationGroup(); g.animations = [s, o]; g.duration = 0.9; g.repeatCount = 2
        g.beginTime = t0; g.fillMode = .backwards
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        r.add(g, forKey: "rip")
    }
    if rect != nil {
        let pen = CABasicAnimation(keyPath: "strokeEnd"); pen.fromValue = 0; pen.toValue = 1
        pen.duration = 0.6; pen.beginTime = t0; pen.fillMode = .backwards
        pen.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ink.add(pen, forKey: "pen")
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

// Thinking: a figure-eight around 55% of the screen height on the active window's screen. x sweeps +-46 over
// 3.6 s (alternating) while y sweeps +-22 over 1.8 s, which is a Lissajous 1:2 figure-eight.
func think() {
    let sr = activeScreenRect()
    let c = toCanvas(Double(sr.midX), Double(sr.minY + sr.height * 0.55))
    let from = host.isHidden ? c : currentTip()
    stopMotion()
    ink.isHidden = true
    setNoImplicit { host.position = c; host.isHidden = false }
    if reduceMotion { return } // static cursor, no dance
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

// ---- bubble ----
let bubble = NSView()
bubble.wantsLayer = true
bubble.layer!.cornerRadius = 10
bubble.layer!.shadowOpacity = 0.3
bubble.layer!.shadowRadius = 9
bubble.layer!.shadowOffset = CGSize(width: 0, height: -3)
bubble.isHidden = true
let label = NSTextField(wrappingLabelWithString: "")
label.textColor = .white
label.font = NSFont.systemFont(ofSize: 14)
label.maximumNumberOfLines = 0
label.preferredMaxLayoutWidth = 296
bubble.addSubview(label)
canvas.addSubview(bubble)

var hideTimer: Timer?
// Auto-hide so a stale pointer never lingers over someone's work; any new command re-arms it. Thinking waits
// for the sealed models, so it gets a longer leash than an answer.
func armHide(_ secs: TimeInterval = 12) {
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: secs, repeats: false) { _ in clearAll() }
}

func clearAll() {
    hideTimer?.invalidate()
    stopMotion()
    host.removeAllAnimations(); fy.removeAllAnimations()
    host.isHidden = true
    ink.isHidden = true
    bubble.isHidden = true
}

// near: a spot to hang the bubble from. With a target rect, below it (clear of the underline), else above it.
func showBubble(_ text: String, sub: String?, stop: Bool, near: CGPoint?, rect: CGRect? = nil) {
    let full = (sub?.isEmpty == false) ? text + "\n" + sub! : text
    label.stringValue = full
    bubble.layer!.backgroundColor = (stop ? rgb(0x7f1d1d) : rgb(0x1f1147)).cgColor
    let pad: CGFloat = 12, padV: CGFloat = 8
    label.preferredMaxLayoutWidth = 296
    let sz = label.sizeThatFits(NSSize(width: 296, height: 2000))
    let bw = min(320, sz.width + pad * 2), bh = sz.height + padV * 2
    label.frame = NSRect(x: pad, y: padV, width: bw - pad * 2, height: sz.height)
    var x = union.width / 2 - bw / 2, y: CGFloat = 40
    if let p = near {
        x = min(max(8, p.x - bw / 2), union.width - bw - 8)
        let below = rect.map { $0.maxY + 36 } ?? p.y + 40
        let above = rect.map { $0.minY - 36 - bh } ?? p.y - 40 - bh
        // Below unless there is no room, same flip rule as placeBubble() in the browser overlay.
        y = below + bh < union.height ? below : max(8, above)
    }
    bubble.frame = NSRect(x: x, y: y, width: bw, height: bh)
    bubble.isHidden = false
}

func handle(_ obj: [String: Any]) {
    let cmd = obj["cmd"] as? String ?? ""
    let text = obj["text"] as? String ?? ""
    switch cmd {
    case "point":
        guard let x = (obj["x"] as? NSNumber)?.doubleValue, let y = (obj["y"] as? NSNumber)?.doubleValue else { return }
        let p = toCanvas(x, y)
        var rect: CGRect? = nil
        if let r = obj["rect"] as? [String: Any],
           let rx = (r["x"] as? NSNumber)?.doubleValue, let ry = (r["y"] as? NSNumber)?.doubleValue,
           let rw = (r["w"] as? NSNumber)?.doubleValue, let rh = (r["h"] as? NSNumber)?.doubleValue, rw > 0, rh > 0 {
            rect = CGRect(origin: toCanvas(rx, ry), size: CGSize(width: rw, height: rh))
        }
        glide(to: p)
        arrive(rect: rect)
        showBubble(text, sub: obj["sub"] as? String, stop: false, near: p, rect: rect)
        armHide()
    case "think":
        think()
        showBubble(text.isEmpty ? "Thinking…" : text, sub: nil, stop: false, near: nil)
        armHide(30)
    case "ask":
        clearCursor()
        showBubble(text, sub: obj["sub"] as? String, stop: false, near: nil)
        armHide()
    case "stop":
        clearCursor()
        showBubble(text, sub: obj["sub"] as? String, stop: true, near: nil)
        armHide()
    case "clear":
        clearAll()
    default: break
    }
}

func clearCursor() {
    stopMotion(); host.removeAllAnimations(); fy.removeAllAnimations()
    host.isHidden = true; ink.isHidden = true
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
