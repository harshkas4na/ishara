// Service worker. Two jobs: (1) own every request to the local helper, because a page's own
// fetch to 127.0.0.1 would hit CORS / mixed-content rules while the worker, holding the host
// permission, does not; (2) run the offscreen document that records the mic.
import { fromBase64 } from "./wav.js";

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
    case "proof": return helper("/proof/" + encodeURIComponent(msg.requestId));
    case "session-end": return helper("/session/end", json({ sessionId: msg.sessionId }), 60000);
    case "open-setup": chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") }); return {};
  }
  return { error: "unknown message " + msg.type };
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg.target === "offscreen") return; // addressed to the offscreen document, not us
  handle(msg, sender).then(send);
  return true; // async response
});

// Toolbar click is the one-time microphone setup.
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL("setup.html") }));
