// ptt-post: post SYNTHETIC key events to test ishara-ptt without a finger on a key (a test tool, not shipped logic).
//   swiftc -O desktop/ptt-post.swift -o desktop/ptt-post
//   desktop/ptt-post ropt 1500        hold Right Option 1.5 s            -> a take
//   desktop/ptt-post ropt 200         200 ms tap                         -> nothing
//   desktop/ptt-post optA 600         Option+A (typing a symbol)         -> nothing
//   desktop/ptt-post lopt 1000        Left Option                        -> nothing
//   desktop/ptt-post ropt-shift 800   Right Option with Shift            -> nothing
//   desktop/ptt-post chord 800        Ctrl+Opt+Cmd+Space (ISHARA_PTT_KEY=ctrl+opt+cmd+space)
// Real keyboards set the device bit (0x40 = right Option); a synthetic event without it is ignored, so this sets it.
import Foundation
import CoreGraphics
// usage: post ropt <ms> | lopt <ms> | optA | ropt-shift <ms> | chord <ms>
func flags(_ f: UInt64) -> CGEventFlags { CGEventFlags(rawValue: f) }
func mod(_ code: CGKeyCode, _ raw: UInt64) {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
    e.type = .flagsChanged; e.flags = flags(raw); e.post(tap: .cgSessionEventTap)
}
func key(_ code: CGKeyCode, down: Bool, raw: UInt64) {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)!
    e.flags = flags(raw); e.post(tap: .cgSessionEventTap)
}
let a = CommandLine.arguments
let ms = a.count > 2 ? Double(a[2])! : 300
let ALT: UInt64 = 0x80000, R: UInt64 = 0x40, L: UInt64 = 0x20, SHIFT: UInt64 = 0x20000
func sleepMs(_ m: Double) { Thread.sleep(forTimeInterval: m / 1000) }
switch a[1] {
case "ropt": mod(61, ALT | R | 0x100); sleepMs(ms); mod(61, 0x100)
case "lopt": mod(58, ALT | L | 0x100); sleepMs(ms); mod(58, 0x100)
case "optA": mod(61, ALT | R | 0x100); sleepMs(50); key(0, down: true, raw: ALT | R | 0x100); key(0, down: false, raw: ALT | R | 0x100); sleepMs(ms); mod(61, 0x100)
case "ropt-shift": mod(56, SHIFT | 0x100); sleepMs(30); mod(61, ALT | R | SHIFT | 0x100); sleepMs(ms); mod(61, SHIFT | 0x100); mod(56, 0x100)
case "chord": // ctrl+opt+cmd+space
    let all: UInt64 = 0x40000 | ALT | 0x100000 | 0x100
    mod(59, 0x40000 | 0x100); mod(58, 0x40000 | ALT | 0x100); mod(55, all); key(49, down: true, raw: all); sleepMs(ms); key(49, down: false, raw: all); mod(55, 0x40000 | ALT | 0x100); mod(58, 0x40000 | 0x100); mod(59, 0x100)
default: print("?")
}
