// Service worker. Two jobs: (1) own every request to the local helper, because a page's own
// fetch to 127.0.0.1 would hit CORS / mixed-content rules while the worker, holding the host
// permission, does not; (2) run the offscreen document that records the mic.
import { fromBase64 } from "./wav.js";
import "./sse.js"; // sets globalThis.IsharaSSE (parser + relay core, unit-tested in node)

const HELPER = "http://127.0.0.1:7777";

async function helper(path, init = {}, timeoutMs = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(HELPER + path, { ...init, signal: ctl.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: `helper ${res.status}: ${body?.error || res.statusText}` };
    return { data: body };
  } catch (e) {
    // Reported as an error, never turned into a decision: the product has no fallback guess.
    return { error: ctl.signal.aborted ? "helper timed out" : "helper not reachable at 127.0.0.1:7777" };
  } finally { clearTimeout(timer); }
}

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record push-to-talk audio for the question",
  });
}

const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// The tab that is recording, so live mic levels go back to it.
let recTab = null;

async function handle(msg, sender) {
  switch (msg.type) {
    case "level":
      if (recTab != null) chrome.tabs.sendMessage(recTab, { type: "level", rms: msg.rms }).catch(() => {});
      return {};
    case "rec-start": {
      recTab = sender?.tab?.id ?? null;
      await ensureOffscreen();
      return chrome.runtime.sendMessage({ target: "offscreen", cmd: "start" });
    }
    case "rec-stop": {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" });
      if (!r || r.error) return { error: r?.error || "recorder gave no answer" };
      recTab = null;
      if (r.samples < 4000) return { error: "too short, hold the key while you speak" }; // under 0.25 s
      // Silence goes to Whisper as noise and comes back as a made-up word ("you"); refuse it here instead.
      if (r.maxRms < 0.006) return { error: "I could not hear any sound from the microphone" };
      const wav = fromBase64(r.wavBase64);
      return helper("/transcribe", {
        method: "POST",
        headers: { "content-type": "audio/wav", "x-prompt": msg.prompt || "" },
        body: wav,
      });
    }
    case "decide": return helper("/decide", json(msg.body), 20000);
    case "feedback": return helper("/memory/feedback", json(msg.body), 5000); // memory: the user acted on the pointer
    case "proof": return helper("/proof/" + encodeURIComponent(msg.requestId));
    case "session-end": return helper("/session/end", json({ sessionId: msg.sessionId }), 60000);
    // Frame relays. Only content scripts (sender.tab) of THIS extension can send these; a page's own scripts cannot.
    case "chord": // a chord pressed inside an iframe -> the top frame, which owns the mic and the overlay
      if (sender?.tab?.id != null && sender.frameId !== 0) chrome.tabs.sendMessage(sender.tab.id, { type: "chord", d: msg.d }, { frameId: 0 }).catch(() => {});
      return {};
    case "frame-reply": // an iframe's outline/locate answer -> every frame of the tab; only the asker holds the request id
      if (sender?.tab?.id != null && sender.frameId !== 0) chrome.tabs.sendMessage(sender.tab.id, { type: "frame-reply", data: msg.data }).catch(() => {});
      return {};
    // Spoken answers (helper/src/speech.ts): a new question stops the voice; the Mute chord / debug button toggles it.
    case "speech-stop": return helper("/speech/stop", json({}), 3000);
    case "speech-status": return helper("/speech", {}, 3000);
    case "speech-toggle": { // read, then flip: one source of truth (the helper's persisted flag)
      const s = await helper("/speech", {}, 3000);
      if (s.error) return s;
      return helper("/speech/mute", json({ muted: !s.data.muted }), 3000);
    }
    case "open-setup": chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") }); return {};
  }
  return { error: "unknown message " + msg.type };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.target === "offscreen") return; // addressed to the offscreen document, not us
  // A thrown error (offscreen document missing, tab gone) must still answer, or the page waits on a closed port.
  handle(msg, sender).then(send, (e) => send({ error: String(e?.message ?? e) }));
  return true; // async response
});

// ---- Tutor stream relay ----
// The content script opens a port named "tutor" and posts {type:"ask", body} or {type:"walk", sessionId, cmd}. We fetch the
// helper's text/event-stream here (a page's own fetch to 127.0.0.1 hits CORS / mixed content; the worker holds the host
// permission) and post each parsed event back as {event, data}. The parsing and failure rules live in sse.js (tested in node).
// An open port with events flowing keeps the worker alive; the ping covers the gap while 0G thinks before the first token.
// The question text is never logged here.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tutor" || port.sender?.id !== chrome.runtime.id) return;
  let ctl = null, ping = 0;
  const stop = () => { if (ctl) ctl.abort(); ctl = null; clearInterval(ping); ping = 0; };
  const speechStop = () => { fetch(HELPER + "/speech/stop", { method: "POST" }).catch(() => {}); }; // fire and forget; the route may not exist
  const start = (path, body) => {
    stop(); // a new question (or walk command) ends the previous stream; the helper keeps draining 0G for the proof
    speechStop();
    const mine = (ctl = new AbortController());
    const cap = setTimeout(() => mine.abort(), 90000); // never hold a stream longer than a whole answer plus proof
    ping = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    const post = (m) => { try { port.postMessage(m); } catch { stop(); } };
    globalThis.IsharaSSE.relay({
      fetchFn: fetch, url: HELPER + path, signal: mine.signal, post,
      init: { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) },
    }).finally(() => { clearTimeout(cap); if (ctl === mine) { clearInterval(ping); ping = 0; ctl = null; } });
  };
  port.onMessage.addListener((m) => {
    if (m?.type === "ask") start("/tutor", m.body);
    else if (m?.type === "walk") start("/tutor/walk", { sessionId: m.sessionId, cmd: m.cmd });
    else if (m?.type === "cancel") { stop(); speechStop(); }
  });
  port.onDisconnect.addListener(stop);
});

// Toolbar click is the one-time microphone setup.
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") }));

// Dev auto-reload: only active when the helper runs with ISHARA_DEV=1 (it reports dev:false otherwise, so a normal
// install never reloads itself). Polls the extension files' fingerprint and reloads when it changes.
chrome.alarms.create("dev-reload", { periodInMinutes: 0.1 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== "dev-reload") return;
  const r = await helper("/dev/ext-version", {}, 3000);
  if (r.error || !r.data?.dev) return;
  const { devVersion } = await chrome.storage.local.get("devVersion");
  if (devVersion && devVersion !== r.data.version) { await chrome.storage.local.set({ devVersion: r.data.version }); chrome.runtime.reload(); }
  else if (!devVersion) await chrome.storage.local.set({ devVersion: r.data.version });
});
