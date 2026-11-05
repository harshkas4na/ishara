// Records the mic. Lives in an offscreen document because a content script's getUserMedia
// would ask for permission once per website; here the permission belongs to the extension
// origin and is granted once on setup.html.
import { encodeWav, toBase64 } from "./wav.js";

let session = null;
let starting = null; // getUserMedia in flight; stop() waits for it so a quick tap cannot leave the mic on

function start() {
  if (session) return Promise.resolve({});
  if (!starting) starting = open().finally(() => { starting = null; });
  return starting;
}

async function open() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    return { error: "microphone not allowed: open the Ishara toolbar button once and allow it (" + e.name + ")" };
  }
  // Asking for 16 kHz lets the browser resample, so no resampler code of ours to get wrong.
  const ctx = new AudioContext({ sampleRate: 16000 });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const chunks = [];
  const rec = { maxRms: 0 };
  proc.onaudioprocess = (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(data);
    // Loudness of this ~128 ms slice. Sent live so the page can show that the mic is really hearing you.
    let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    rec.maxRms = Math.max(rec.maxRms, rms);
    chrome.runtime.sendMessage({ type: "level", rms }).catch(() => {});
  };
  // The processor only runs when connected onward; a zero-gain node keeps it silent.
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  session = { stream, ctx, proc, chunks, rate: ctx.sampleRate, rec };
  return {};
}

async function stop() {
  if (starting) await starting;
  if (!session) return { error: "not recording" };
  const { stream, ctx, proc, chunks, rate, rec } = session;
  session = null;
  proc.disconnect();
  stream.getTracks().forEach((t) => t.stop()); // turns the browser's recording dot off
  await ctx.close();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  return { wavBase64: toBase64(encodeWav(all, rate)), samples: total, rate, maxRms: rec.maxRms };
}

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.target !== "offscreen") return;
  (msg.cmd === "start" ? start() : stop()).then(send);
  return true;
});
