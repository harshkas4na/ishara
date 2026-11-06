// ishara-ptt: global push-to-talk for the desktop path. HOLD RIGHT OPTION ALONE (350 ms to confirm), speak, release.
// ISHARA_PTT_KEY=ctrl+opt+cmd+space (any modifiers plus one key) is the documented alternative for keyboards without a right Option.
// It is a daemon that talks JSON lines on stdout; helper/src/desktop-ptt.ts does everything else.
//   {"ev":"ready","chord":"rightoption"}
//   {"ev":"down"}                      key went down, capture is starting (the helper shows PREPARING)
//   {"ev":"live","ms":N}               the microphone is really delivering buffers, N ms after the key-down (LISTENING + tick)
//   {"ev":"confirmed"}                 the 350 ms hold passed: this is a deliberate take, not a tap or typing
//   {"ev":"cancel"}                    released (or another key/click) before 350 ms: the take was discarded, nothing recorded survives
//   {"ev":"level","rms":0.0123}  {"ev":"up","samples":N,"maxRms":x,"wavBase64":"..."}
//   {"ev":"error","code":"input-monitoring"|"microphone","message":"..."}   (permission: then exit 2)
//   {"ev":"error","code":"microphone","fatal":false,"message":"..."}          (runtime: the daemon keeps running)
// Why these choices:
// - The key tap is .listenOnly: we can observe keys but never change or swallow them, so a bug here can not
//   break the keyboard. (It needs Input Monitoring, not Accessibility.)
// - PRE-ROLL: capture starts at the KEY-DOWN, not after the hold is confirmed. Harsh starts speaking the instant he presses,
//   and the old design (engine started 350 ms later, plus ~115 ms of engine start) lost the first ~0.5 s. The 350 ms hold now
//   only decides whether the take is kept: a tap, Option+letter typing, Left Option or any other-modifier chord discards it
//   (the audio is dropped from memory, `cancel` is emitted). The cost: the mic dot flickers for those short presses.
// - Right Option alone: one key, collides with no macOS shortcut and with no extension chord (the extension owns Option+Space).
// - The audio engine is built and PREPARED (not started) in advance, so key-down only has to start it: an unstarted engine
//   does not light the mic dot (checked with CoreAudio's DeviceIsRunningSomewhere). It is rebuilt when the default input
//   device or its format changes, and after each take.
// - Audio is kept in memory and handed over as base64. It is never written to disk.
import Foundation
import AVFoundation
import CoreGraphics
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ o: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) else { return }
    print(s)
    fflush(stdout)
}
func fail(_ code: String, _ message: String) -> Never {
    emit(["ev": "error", "code": code, "fatal": true, "message": message])
    exit(2)
}

// ---------- chord parsing ----------
let keyCodes: [String: Int64] = [
    "space": 49, "return": 36, "tab": 48, "escape": 53, "esc": 53,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
func parseChord(_ s: String) -> (mods: CGEventFlags, key: Int64)? {
    var mods = CGEventFlags(); var key: Int64? = nil
    for raw in s.lowercased().split(separator: "+") {
        switch raw.trimmingCharacters(in: .whitespaces) {
        case "ctrl", "control": mods.insert(.maskControl)
        case "opt", "option", "alt": mods.insert(.maskAlternate)
        case "cmd", "command": mods.insert(.maskCommand)
        case "shift": mods.insert(.maskShift)
        case let k: guard let c = keyCodes[k], key == nil else { return nil }; key = c
        }
    }
    guard let k = key, !mods.isEmpty else { return nil } // a bare key would hijack typing; require a modifier
    return (mods, k)
}
let chordText = (ProcessInfo.processInfo.environment["ISHARA_PTT_KEY"] ?? "rightoption").trimmingCharacters(in: .whitespaces)
var chordMods = CGEventFlags(); var chordKey: Int64 = 0
// Modifier-only mode: Right Option held alone. keyCode 61 is the physical right Option; the device-dependent bit 0x40
// in the raw flags says which Option is down (0x20 is the left one), because maskAlternate alone cannot tell.
let modOnly = ["rightoption", "right-option", "ropt", "roption", "rightalt"].contains(chordText.lowercased())
let RIGHT_OPT_KEYCODE: Int64 = 61, RIGHT_OPT_BIT: UInt64 = 0x40, LEFT_OPT_BIT: UInt64 = 0x20
let HOLD_S = 0.350 // long enough that nobody triggers it while typing a symbol, short enough to feel instant
if !modOnly {
    if let c = parseChord(chordText) { chordMods = c.mods; chordKey = c.key } else {
        fail("config", "ISHARA_PTT_KEY=\"\(chordText)\" is not understood. Use \"rightoption\" or modifiers (ctrl, opt, cmd, shift) plus one key, e.g. ctrl+opt+cmd+space.")
    }
}
let debug = ProcessInfo.processInfo.environment["ISHARA_PTT_DEBUG"] == "1" // log chord-related key events to stderr
let modMask: CGEventFlags = [.maskControl, .maskAlternate, .maskCommand, .maskShift]

// ---------- recorder ----------
// Why a new AVAudioEngine per take: one engine kept for the daemon's life cached the input format, and when the input
// device changed (AirPods connect, a call app reconfigures the mic, an aggregate device at another rate) installTap threw
// an Objective-C NSException ("format mismatch, 1 ch 16000 Hz") that Swift cannot catch and that killed the daemon
// (measured, docs/audit/desktop.md section 1). Now the engine is built fresh at key-down, the tap is installed with
// format nil (= whatever the node outputs right now, so there is nothing to mismatch), and the converter is built from
// the format of the buffers that actually arrive. A device change mid-take rebuilds the engine and keeps the audio so far.
final class Recorder {
    var engine: AVAudioEngine? = nil          // the engine of the running take
    var prepared: AVAudioEngine? = nil        // built + prepare()d, NOT started: key-down only has to start it
    var preparedFmt: AVAudioFormat? = nil
    var observer: NSObjectProtocol? = nil
    let lock = NSLock()
    var pcm = [Int16]()
    var windowSumSq = 0.0, windowN = 0   // since the last level report
    var maxRms = 0.0
    var running = false
    var liveSent = false
    var conv: AVAudioConverter? = nil
    var convFrom: AVAudioFormat? = nil
    let outFmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    var onTrouble: ((String) -> Void)? = nil   // runtime failure during a take (device vanished): reported, never fatal
    var onLive: (() -> Void)? = nil            // first converted buffer of the take arrived

    // Every engine operation runs on this serial queue, never on the main thread: engine prepare/start can take 20-300 ms
    // and the main thread is the key tap's run loop (a blocked tap delays the key events themselves, measured: key-down
    // seen 500-900 ms late). start() therefore returns at once; a failure comes back through onStartFailed.
    let audioQ = DispatchQueue(label: "ishara.audio")
    var onStartFailed: ((String) -> Void)? = nil
    func start() {
        lock.lock(); pcm = []; windowSumSq = 0; windowN = 0; maxRms = 0; liveSent = false; running = true; lock.unlock()
        audioQ.async {
            if let e = self.attach() {
                self.lock.lock(); self.running = false; self.lock.unlock()
                DispatchQueue.main.async { self.onStartFailed?(e) }
            }
        }
    }
    private func consume(_ buf: AVAudioPCMBuffer) {
        lock.lock(); let on = running; lock.unlock()
        guard on else { return } // a warm engine between takes delivers buffers that belong to nobody: drop them unconverted
        let inFmt = buf.format
        if convFrom == nil || convFrom! != inFmt { conv = AVAudioConverter(from: inFmt, to: outFmt); convFrom = inFmt }
        guard let conv = conv, inFmt.sampleRate > 0 else { return }
        let cap = AVAudioFrameCount(Double(buf.frameLength) * 16000 / inFmt.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: cap) else { return }
        var fed = false
        var err: NSError?
        conv.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buf
        }
        guard err == nil, let p = out.int16ChannelData?[0] else { return }
        let n = Int(out.frameLength)
        lock.lock()
        guard running else { lock.unlock(); return } // a buffer that arrives after stop() belongs to no take
        for i in 0..<n { let v = Double(p[i]) / 32768; windowSumSq += v * v }
        windowN += n
        pcm.append(contentsOf: UnsafeBufferPointer(start: p, count: n))
        let first = !liveSent; liveSent = true
        lock.unlock()
        if first { onLive?() } // outside the lock: it prints
    }
    // A fresh engine with the tap installed on whatever the input node outputs right now (format nil: nothing to mismatch).
    private func build() -> (AVAudioEngine, AVAudioFormat)? {
        let eng = AVAudioEngine()
        let input = eng.inputNode
        let f = input.outputFormat(forBus: 0)
        guard f.sampleRate > 0, f.channelCount > 0 else { return nil }
        input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buf, _ in self?.consume(buf) }
        eng.prepare()
        return (eng, f)
    }
    // Build the next engine ahead of time, off the key-down path. Idle = prepared only, so the mic dot stays off.
    func prewarm() {
        audioQ.async {
            self.lock.lock(); let r = self.running; self.lock.unlock()
            guard !r, self.prepared == nil, self.engine == nil, let (e, f) = self.build() else { return }
            self.prepared = e; self.preparedFmt = f
        }
    }
    func dropPrepared() { audioQ.async { self.dropPreparedNow() } }
    private func dropPreparedNow() {
        if let e = prepared { e.inputNode.removeTap(onBus: 0); e.stop() }
        prepared = nil; preparedFmt = nil
    }
    // WARM: after a confirmed take the engine keeps running (its buffers dropped) for WARM_S, because starting the input
    // device costs 15-480 ms (measured, varies with the HAL's power state) and people ask follow-ups in bursts. The mic
    // dot is therefore on for WARM_S after a take, never otherwise, and never after a discarded tap.
    static let WARM_S = 8.0
    var warmItem: DispatchWorkItem? = nil
    private func cancelWarm() { warmItem?.cancel(); warmItem = nil }
    private func attach() -> String? {
        cancelWarm()
        if engine != nil { // still warm from the last take: nothing to start, the next buffer is the first sample
            conv = nil; convFrom = nil
            if debug { fputs("ptt: engine reused (warm) after \(Int(Date().timeIntervalSince(downAt) * 1000)) ms\n", stderr) }
            return nil
        }
        var eng: AVAudioEngine
        var usedPrepared = false
        // Use the prepared engine only if the input still has the format it was prepared for; otherwise build fresh.
        if let p = prepared, let pf = preparedFmt, p.inputNode.outputFormat(forBus: 0) == pf { eng = p; usedPrepared = true; prepared = nil; preparedFmt = nil }
        else {
            dropPreparedNow()
            guard let (e, _) = build() else { return "no usable microphone input (is one connected, and is it the system input?)" }
            eng = e
        }
        conv = nil; convFrom = nil
        do { try eng.start() } catch {
            eng.inputNode.removeTap(onBus: 0)
            return "could not start audio: \(error.localizedDescription)"
        }
        engine = eng
        if debug { fputs("ptt: engine started in \(Int(Date().timeIntervalSince(downAt) * 1000)) ms (prepared: \(usedPrepared))\n", stderr) }
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: eng, queue: .main) { [weak self] _ in
            // The input device or its format changed under us. Rebuild on the new default input; keep what we recorded.
            guard let self = self else { return }
            self.audioQ.async {
                guard self.running else { self.detach(); self.cancelWarm(); self.prewarm(); return } // idle + device changed: drop the warm engine

                self.detach()
                if let e = self.attach() { self.lock.lock(); self.running = false; self.lock.unlock(); DispatchQueue.main.async { self.onTrouble?(e) } }
            }
        }
        return nil
    }
    private func detach() {
        if let o = observer { NotificationCenter.default.removeObserver(o); observer = nil }
        if let e = engine { e.inputNode.removeTap(onBus: 0); e.stop() }
        engine = nil
    }
    // RMS of the audio since the previous call; the max over the whole take is kept for the silence check.
    func level() -> Double {
        lock.lock(); defer { lock.unlock() }
        guard windowN > 0 else { return 0 }
        let r = (windowSumSq / Double(windowN)).squareRoot()
        windowSumSq = 0; windowN = 0
        maxRms = max(maxRms, r)
        return r
    }
    func stop(keepWarm: Bool = false) -> (samples: [Int16], maxRms: Double) {
        lock.lock(); running = false; lock.unlock()
        audioQ.sync { // queued behind a start() still in flight, so a quick tap cannot leave the engine running
            if keepWarm && self.engine != nil {
                let item = DispatchWorkItem { [weak self] in
                    guard let self = self else { return }
                    self.lock.lock(); let r = self.running; self.lock.unlock()
                    if !r { self.detach(); self.warmItem = nil; self.prewarm() }
                }
                self.warmItem = item
                self.audioQ.asyncAfter(deadline: .now() + Recorder.WARM_S, execute: item)
            } else { self.cancelWarm(); self.detach() }
        }
        _ = level() // fold in the tail
        lock.lock(); defer { lock.unlock() }
        let s = pcm; pcm = []
        return (s, maxRms)
    }
}

// The default input device changed (AirPods, a call app): the prepared engine is bound to the old one. Drop it; the next
// key-down builds fresh, and an idle moment rebuilds a prepared one.
func watchDefaultInput(_ onChange: @escaping () -> Void) {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    AudioObjectAddPropertyListenerBlock(AudioObjectID(kAudioObjectSystemObject), &addr, DispatchQueue.main) { _, _ in onChange() }
}

func wav(_ s: [Int16]) -> Data {
    var d = Data()
    func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
    func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
    let bytes = UInt32(s.count * 2)
    d.append("RIFF".data(using: .ascii)!); u32(36 + bytes); d.append("WAVEfmt ".data(using: .ascii)!)
    u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
    d.append("data".data(using: .ascii)!); u32(bytes)
    s.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
    return d
}

// ---------- permissions ----------
// Microphone: ask once up front so a denial is reported now, not as a silent recording later.
switch AVCaptureDevice.authorizationStatus(for: .audio) {
case .authorized: break
case .notDetermined:
    let sem = DispatchSemaphore(value: 0); var ok = false
    AVCaptureDevice.requestAccess(for: .audio) { ok = $0; sem.signal() }
    sem.wait()
    if !ok { fail("microphone", "Microphone access was refused. Open System Settings > Privacy & Security > Microphone and switch on the app that started the helper (Terminal, iTerm, VS Code, or node), then restart the helper.") }
default:
    fail("microphone", "Microphone permission is missing. Open System Settings > Privacy & Security > Microphone and switch on the app that started the helper (Terminal, iTerm, VS Code, or node), then restart the helper.")
}

// ---------- the key tap ----------
let rec = Recorder()
var held = false          // a take is running (from the key-down, i.e. including the unconfirmed first 350 ms)
var confirmed = false     // the hold passed: the take is deliberate and will be kept
var tapRef: CFMachPort? = nil
var levelTimer: Timer? = nil
var downAt = Date()
let MAX_TAKE_S = 30.0 // a lost key-up (tap disabled mid-hold) must not leave the mic on and the buffer growing

var holdItem: DispatchWorkItem? = nil   // the pending 350 ms confirmation (modifier-only mode)
func cancelHoldTimer() { holdItem?.cancel(); holdItem = nil }

// Idle: rebuild the prepared engine a moment after a take, not on the release path, and again when the input device changes.
var prewarmItem: DispatchWorkItem? = nil
func schedulePrewarm(after s: Double = 0.15) {
    prewarmItem?.cancel()
    let item = DispatchWorkItem { if !held { rec.prewarm() } }
    prewarmItem = item
    DispatchQueue.main.asyncAfter(deadline: .now() + s, execute: item)
}
watchDefaultInput { rec.dropPrepared(); if !held { schedulePrewarm(after: 0.3) } }

// First audio is really arriving: tell the helper to switch PREPARING -> LISTENING. ms is measured from the key-down
// (the number the latency report is made of).
rec.onLive = {
    let ms = Int(Date().timeIntervalSince(downAt) * 1000)
    if debug { fputs("ptt: live \(ms) ms after key-down\n", stderr) }
    emit(["ev": "live", "ms": ms])
}

// The engine would not start (no input, permission revoked): the take is over, the daemon is not.
rec.onStartFailed = { e in
    guard held else { return }
    held = false; confirmed = false; cancelHoldTimer()
    levelTimer?.invalidate(); levelTimer = nil
    emit(["ev": "error", "code": "microphone", "fatal": false, "message": "Microphone failed: \(e). If this keeps happening, check System Settings > Privacy & Security > Microphone for the app that started the helper."])
    schedulePrewarm(after: 1)
}
// The mic failed while a take was running (device unplugged mid-hold): say so, end the take, keep the daemon alive.
rec.onTrouble = { msg in
    guard held else { return }
    held = false; confirmed = false
    cancelHoldTimer()
    levelTimer?.invalidate(); levelTimer = nil
    _ = rec.stop()
    emit(["ev": "error", "code": "microphone", "fatal": false, "message": "The microphone stopped: \(msg). Hold the key again."])
}

// Key-down: start capturing NOW. `needHold` = the 350 ms confirmation still has to pass (modifier-only mode).
func chordDown(needHold: Bool) {
    guard !held else { return }  // key repeat sends keyDown again; ignore it
    held = true; confirmed = !needHold
    downAt = Date()
    emit(["ev": "down"])
    rec.start()
    if needHold {
        let item = DispatchWorkItem { holdItem = nil; if held { confirmed = true; emit(["ev": "confirmed"]) } }
        holdItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + HOLD_S, execute: item)
    }
    levelTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { _ in
        if Date().timeIntervalSince(downAt) > MAX_TAKE_S { chordUp(); return }
        if confirmed || !needHold { print(String(format: "{\"ev\":\"level\",\"rms\":%.4f}", rec.level())); fflush(stdout) } // hand-formatted: JSONSerialization prints 0.0064999999999999997
    }
}
// Throw the take away before it was confirmed (tap, typing, another modifier, a click): the audio never leaves this process.
func discardTake() {
    cancelHoldTimer()
    guard held, !confirmed else { return }
    held = false
    levelTimer?.invalidate(); levelTimer = nil
    _ = rec.stop()
    emit(["ev": "cancel"])
    schedulePrewarm()
}
// Another key / click / scroll: before confirmation that voids the take; a confirmed take is left alone.
func interrupted() { if held && !confirmed { discardTake() } else { cancelHoldTimer() } }
func chordUp() {
    cancelHoldTimer()
    guard held else { return }
    if !confirmed { discardTake(); return } // released inside the 350 ms: a tap
    held = false; confirmed = false
    levelTimer?.invalidate(); levelTimer = nil
    let (s, m) = rec.stop(keepWarm: true)
    emit(["ev": "up", "samples": s.count, "maxRms": Double(String(format: "%.5f", m)) ?? m, "wavBase64": wav(s).base64EncodedString()])
    schedulePrewarm()
}

let mask: CGEventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue) | (1 << CGEventType.flagsChanged.rawValue)
    // Option-click and Option-drag are not a request to talk: any pointer press or scroll cancels a pending hold.
    | (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.scrollWheel.rawValue)
func handleKey(_ type: CGEventType, _ event: CGEvent) {
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let t = tapRef { CGEvent.tapEnable(tap: t, enable: true) } // macOS turns a slow tap off; turn it back on
        cancelHoldTimer()
        if held { chordUp() } // the key-up may have been missed while the tap was off: end the take now (a tap is discarded)
        return
    }
    if modOnly {
        switch type {
        case .keyDown, .leftMouseDown, .rightMouseDown, .scrollWheel:
            interrupted() // Option was used for typing a symbol / clicking: voids an unconfirmed take; a confirmed one is left alone
        case .flagsChanged:
            let kc = event.getIntegerValueField(.keyboardEventKeycode)
            let raw = event.flags.rawValue
            if kc == RIGHT_OPT_KEYCODE {
                let down = event.flags.contains(.maskAlternate) && (raw & RIGHT_OPT_BIT) != 0
                let clean = event.flags.intersection([.maskControl, .maskCommand, .maskShift]).isEmpty && (raw & LEFT_OPT_BIT) == 0
                if debug { fputs("ptt: right-option down=\(down) clean=\(clean)\n", stderr) }
                if down {
                    if clean && !held { chordDown(needHold: true) }
                } else { chordUp() }
            } else {
                interrupted() // another modifier changed (Left Option, Cmd, Shift, Ctrl): that is a chord or typing, not us
            }
        default: break
        }
        return
    }
    // Debug logs only the chord's own key and modifier changes, never other keys: stderr goes to the helper log,
    // and logging every keycode would turn a debug switch into a keylogger.
    if debug && (type == .flagsChanged || event.getIntegerValueField(.keyboardEventKeycode) == chordKey) {
        fputs("ptt: type=\(type.rawValue) chordKey=\(type != .flagsChanged) flags=\(event.flags.rawValue)\n", stderr)
    }
    let modsOK = event.flags.intersection(modMask) == chordMods // exactly the chord's modifiers, no extras
    switch type {
    case .keyDown:
        if event.getIntegerValueField(.keyboardEventKeycode) == chordKey && modsOK { chordDown(needHold: false) }
    case .keyUp:
        if event.getIntegerValueField(.keyboardEventKeycode) == chordKey { chordUp() }
    case .flagsChanged:
        if held && !modsOK { chordUp() } // released a modifier before the key
    default: break
    }
}
// listen-only: events always continue untouched, so the callback just returns them.
let callback: CGEventTapCallBack = { _, type, event, _ in handleKey(type, event); return Unmanaged.passUnretained(event) }
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: callback, userInfo: nil) else {
    fail("input-monitoring", "Cannot watch the keyboard: Input Monitoring permission is missing. Open System Settings > Privacy & Security > Input Monitoring and switch on the app that started the helper (Terminal, iTerm, VS Code, or node), then restart the helper.")
}
tapRef = tap
CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0), .commonModes)

var signalSources: [DispatchSourceSignal] = []
// Quit cleanly: stop the mic so the orange dot never outlives us.
signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN)
for sig in [SIGTERM, SIGINT] {
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler { if rec.running { _ = rec.stop() }; exit(0) }
    src.resume()
    signalSources.append(src)
}
// The helper is our parent. If it dies without signalling us (SIGKILL, crash), we are re-parented to launchd: quit,
// so a global key tap never outlives the app that asked for it.
let parentAtStart = getppid()
Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
    if getppid() != parentAtStart { if rec.running { _ = rec.stop() }; exit(0) }
}
schedulePrewarm(after: 0.05)
emit(["ev": "ready", "chord": modOnly ? "rightoption" : chordText, "holdMs": modOnly ? Int(HOLD_S * 1000) : 0])
CFRunLoopRun()
