// ishara-overlay: draws Ishara's pointer ring and answer bubble on top of ANY app.
// Reads one JSON command per line on stdin:
//   {"cmd":"point","x":..,"y":..,"text":".."}   ring glides to the screen point, bubble beside it
//   {"cmd":"ask","text":".."}                   bubble only
//   {"cmd":"stop","text":"..","sub":".."}       red bubble (safe-stop)
//   {"cmd":"clear"}                             hide everything
// x,y are SCREEN POINTS with a top-left origin (what the Accessibility API reports and what ishara-ax emits).
// Look mirrors extension/overlay.js: purple ring #6d28d9, bubble #1f1147, stop bubble #7f1d1d.
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

// ---- pointer ring: a purple ring with a centre dot, white halo, like .ptr in extension/overlay.js ----
let ringSize: CGFloat = 44
let ring = CALayer()
ring.bounds = CGRect(x: 0, y: 0, width: ringSize, height: ringSize)
ring.cornerRadius = ringSize / 2
ring.borderWidth = 3
ring.borderColor = rgb(0x6d28d9).cgColor
ring.backgroundColor = rgb(0x6d28d9, 0.18).cgColor
ring.isHidden = true
let halo = CALayer()
halo.frame = ring.bounds.insetBy(dx: -4, dy: -4)
halo.cornerRadius = (ringSize + 8) / 2
halo.borderWidth = 4
halo.borderColor = NSColor.white.withAlphaComponent(0.7).cgColor
ring.addSublayer(halo)
let dot = CALayer()
dot.bounds = CGRect(x: 0, y: 0, width: 8, height: 8)
dot.cornerRadius = 4
dot.position = CGPoint(x: ringSize / 2, y: ringSize / 2)
dot.backgroundColor = rgb(0x6d28d9).cgColor
ring.addSublayer(dot)
canvas.layer!.addSublayer(ring)

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
// Auto-hide so a stale pointer never lingers over someone's work; any new command re-arms it.
func armHide() {
    hideTimer?.invalidate()
    hideTimer = Timer.scheduledTimer(withTimeInterval: 12, repeats: false) { _ in clearAll() }
}

func clearAll() {
    hideTimer?.invalidate()
    ring.isHidden = true
    bubble.isHidden = true
}

func showBubble(_ text: String, sub: String?, stop: Bool, near: CGPoint?) {
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
        // Below the ring unless there is no room, same flip rule as placeBubble() in the browser overlay.
        y = p.y + 40 + bh < union.height ? p.y + 40 : max(8, p.y - 40 - bh)
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
        let wasHidden = ring.isHidden
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if wasHidden { // first appearance: start from the screen centre so it visibly glides in
            ring.position = CGPoint(x: union.width / 2, y: union.height / 2)
        }
        ring.isHidden = false
        CATransaction.commit()
        CATransaction.begin()
        CATransaction.setAnimationDuration(0.55)
        CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1))
        ring.position = p
        CATransaction.commit()
        showBubble(text, sub: obj["sub"] as? String, stop: false, near: p)
        armHide()
    case "ask":
        ring.isHidden = true
        showBubble(text, sub: obj["sub"] as? String, stop: false, near: nil)
        armHide()
    case "stop":
        ring.isHidden = true
        showBubble(text, sub: obj["sub"] as? String, stop: true, near: nil)
        armHide()
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
