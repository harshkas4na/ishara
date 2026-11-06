// Records the mic. Lives in an offscreen document because a content script's getUserMedia
// would ask for permission once per website; here the permission belongs to the extension
// origin and is granted once on setup.html.
//
// WARM MIC. getUserMedia + AudioContext setup costs 150-700 ms on every key-down, and Harsh starts speaking at the
// key-down, so those first words were lost. After the first recording the stream, AudioContext and processor stay alive
// and DETACHED from recording (their buffers are dropped, nothing is kept) for WARM_MS, then the tracks are stopped.
// While warm the browser's recording dot stays on; it goes off WARM_MS after the last use. A new recording just flips
// `rec` on, so audio is buffered from the first chunk that arrives and the first chunk reaches the page as `mic-live`.
import { encodeWav, toBase64 } from "./wav.js";

const WARM_MS = 10000;
// 1024 samples at 16 kHz = 64 ms per chunk. (2048 was 128 ms: the first chunk after a key-down could take that long and
// the level meter was coarse.) A warm chunk can hold up to 64 ms from just BEFORE the key-down; that is harmless.
const CHUNK = 1024;

let warm = null;      // { stream, ctx, src, proc, mute } the live graph, or null when cold
let rec = null;       // the take in progress: { chunks, maxRms, t0, live }
let starting = null;  // open() in flight; stop() waits for it so a quick tap cannot leave the mic on
let idleTimer = 0;

function start() {
  if (rec) return Promise.resolve({});
  clearTimeout(idleTimer);
  // The take exists from this instant, so no chunk delivered after it is ever dropped, even while the graph is still opening.
  rec = { chunks: [], maxRms: 0, t0: performance.now(), live: false, warm: !!warm, openMs: 0, sinceLevel: 0 };
  if (warm) return Promise.resolve({ warm: true });
  if (!starting) starting = open().finally(() => { starting = null; });
  return starting;
}

async function open() {
  const t = performance.now();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    rec = null;
    return { error: "microphone not allowed: open the Ishara toolbar button once and allow it (" + e.name + ")" };
  }
  // Asking for 16 kHz lets the browser resample, so no resampler code of ours to get wrong.
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(CHUNK, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!rec) return; // warm and idle: the buffer belongs to nobody and is not kept
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    rec.chunks.push(data);
    // Loudness of this slice. Sent live so the page can show that the mic is really hearing you.
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    rec.maxRms = Math.max(rec.maxRms, rms);
    if (!rec.live) { // the first buffer of this take: the microphone is really delivering. The page switches PREPARING -> LISTENING.
      rec.live = true; if (rec.onLive) rec.onLive();
      chrome.runtime.sendMessage({ type: "mic-live", ms: Math.round(performance.now() - rec.t0), warm: rec.warm }).catch(() => {});
    }
    // Levels go out about every 128 ms (every second 64 ms chunk): the page redraws bars, no need for more.
    if ((rec.sinceLevel = (rec.sinceLevel + 1) % 2) === 0) chrome.runtime.sendMessage({ type: "level", rms }).catch(() => {});
  };
  // The processor only runs when connected onward; a zero-gain node keeps it silent.
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  warm = { stream, ctx, src, proc, mute };
  if (rec) rec.openMs = Math.round(performance.now() - t);
  // The OS can end the track (device unplugged, permission revoked): forget the graph so the next press opens a fresh one.
  stream.getAudioTracks()[0]?.addEventListener("ended", () => { if (warm && warm.stream === stream) teardown(); });
  return { warm: false, openMs: rec ? rec.openMs : 0 };
}

async function teardown() {
  const w = warm; warm = null;
  if (!w) return;
  try { w.proc.disconnect(); w.proc.onaudioprocess = null; } catch { /* already gone */ }
  w.stream.getTracks().forEach((t) => t.stop()); // turns the browser's recording dot off
  try { await w.ctx.close(); } catch { /* already closed */ }
}

async function stop() {
  if (starting) await starting;
  if (!rec) return { error: "not recording" };
  // A tap can release before the first buffer arrives (up to 64 ms). Give it up to 400 ms so the take reports `mic-live`
  // (the latency measurement) and is never returned from a half-open graph.
  if (!rec.live) await new Promise((res) => { rec.onLive = res; setTimeout(res, 400); });
  const { chunks, maxRms } = rec;
  rec = null;
  // Keep the graph warm for the next question; close it WARM_MS after the last use.
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!rec) teardown(); }, WARM_MS);
  const rate = warm ? warm.ctx.sampleRate : 16000;
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return { wavBase64: toBase64(encodeWav(all, rate)), samples: total, rate, maxRms };
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.target !== "offscreen") return;
  if (msg.cmd === "state") { send({ warm: !!warm, recording: !!rec }); return; } // for the tests and the docs, not used by the UI
  (msg.cmd === "start" ? start() : stop()).then(send);
  return true;
});
