// Records 3 s from the default mic and prints its RMS, on the same 0..1 scale as the loudness floor
// (ISHARA_MIN_RMS, default 0.006). The audit could not measure a real voice, so run this once: stay silent for the
// first run, then speak at your normal volume for the second, and set the floor between the two.
//   node scripts/mic-level.ts            (needs ffmpeg; macOS asks Terminal for Microphone access the first time)
//   node scripts/mic-level.ts -d 1       pick another avfoundation audio device (list with: ffmpeg -f avfoundation -list_devices true -i "")
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWav, rms } from "../helper/src/chunk-audio.ts";
import { minRms } from "../helper/src/transcript-guard.ts";

const dev = process.argv.includes("-d") ? process.argv[process.argv.indexOf("-d") + 1] : "0";
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
  console.log("ffmpeg not found. Instead: hold Option+Space in Chrome and watch the level blocks in the Ishara overlay;\nif they stay empty while you speak normally, the mic is below the floor.");
  process.exit(1);
}
const out = join(mkdtempSync(join(tmpdir(), "mic-")), "m.wav");
console.log("recording 3 s... speak now (or stay silent to measure the room)");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-i", `:${dev}`, "-t", "3", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", out], { stdio: "inherit" });
const pcm = parseWav(readFileSync(out))!;
const win = 2048; let peak = 0; // the extension's maxRms is the loudest ~128 ms slice, so report that too
for (let i = 0; i + win <= pcm.samples.length; i += win) peak = Math.max(peak, rms(pcm.samples.subarray(i, i + win)));
const floor = minRms();
console.log(`overall RMS ${rms(pcm.samples).toFixed(4)}   loudest slice (what the floor compares) ${peak.toFixed(4)}   floor ${floor}`);
console.log(peak < floor ? "BELOW the floor: this would be refused as silence. Raise the mic input volume, or lower ISHARA_MIN_RMS." : "above the floor: would be sent to whisper.");
console.log("Set a floor with ISHARA_MIN_RMS=0.003 (helper and desktop path); the browser extension keeps 0.006 in extension/background.js.");
