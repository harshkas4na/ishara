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

// Create the offscreen document at worker start so the first key-down does not pay for it (creating it does not touch the mic).
ensureOffscreen().catch(() => {});

// The tab that is recording, so live mic levels go back to it.
let recTab = null;
let recAt = 0; // when that take started: a tab that vanished mid-take must not block every other tab forever
chrome.tabs.onRemoved.addListener((id) => { if (id === recTab) recTab = null; });

async function handle(msg, sender) {
  switch (msg.type) {
    case "level":
      if (recTab != null) chrome.tabs.sendMessage(recTab, { type: "level", rms: msg.rms }).catch(() => {});
      return {};
    case "mic-live": // the offscreen recorder's first buffer of a take: tell the tab that is recording (PREPARING -> LISTENING)
      if (recTab != null) chrome.tabs.sendMessage(recTab, { type: "mic-live", ms: msg.ms, warm: msg.warm }).catch(() => {});
      return {};
    case "rec-start": {
      // Only the tab the user is looking at may record, and only one tab at a time. Without this, a background tab that
      // somehow got a chord (e.g. through a frame relay) could start a take and its pill and answer appeared alongside
      // the real one (reported with 3-4 tabs open on 6 Nov).
      const tabId = sender?.tab?.id ?? null;
      try {
        const [act] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (act && tabId != null && act.id !== tabId) { console.debug("[ishara] rec-start refused: tab", tabId, "is not the active tab", act.id); return { error: "not the active tab" }; }
      } catch { /* no tab info: fall through to the single-recorder rule */ }
      if (recTab != null && recTab !== tabId && Date.now() - recAt < 30000) { console.debug("[ishara] rec-start refused: tab", recTab, "is already recording"); return { error: "another tab is recording" }; }
      recTab = tabId; recAt = Date.now();
      await ensureOffscreen(); // already there after the first use or the startup call below, so this is a cheap check
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
    // ---- Agent mode (extension/act.js). Only content scripts of this extension can send these (sender.tab). ----
    case "act-post": { // plain POSTs of the act protocol, through the worker for the same reason as /tutor: Host/Origin and CORS
      if (!ACT_PATHS.has(msg.path)) return { error: "path not allowed" };
      return helper(msg.path, json(msg.body || {}), 20000);
    }
    case "act-state": return actState(msg, sender);
    case "act-tab": return actTab(msg, sender);
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

// ---- Agent mode: state, tab actions, relay ----
// Which helper paths the page may reach through the worker. /act/clipboard is the optional pbcopy route (coordinated with the helper).
const ACT_PATHS = new Set(["/act/result", "/act/approve", "/act/stop", "/act/clipboard", "/speech/say"]);
const ACT_EVENTS = ["thinking", "action", "approval", "result", "done", "failed", "stopped", "refused", "ask"];
const ACT_END = ["done", "failed", "stopped", "refused", "ask"];

// The running task of a tab, so the next page of the same tab can carry on (a link, open_url, back/forward). chrome.storage.session
// is cleared when the browser closes and is not readable by pages. Keyed by tab id; dropped when the tab closes or after 10 minutes.
// The task text lives here only for those minutes and never goes anywhere but the helper.
const STATE_TTL = 10 * 60 * 1000;
const stateKey = (tabId) => "act:" + tabId;
async function actState(msg, sender) {
  if (msg.op === "agent-get") { const r = await chrome.storage.session.get("agentOn"); return { on: !!r.agentOn }; }
  if (msg.op === "agent-set") { await chrome.storage.session.set({ agentOn: !!msg.on }); return { ok: true }; }
  const tabId = sender?.tab?.id;
  if (tabId == null) return { error: "no tab" };
  const key = stateKey(tabId);
  if (msg.op === "get") {
    const r = await chrome.storage.session.get(key), s = r[key];
    if (s && Date.now() - (s.startedAt || 0) > STATE_TTL) { await chrome.storage.session.remove(key); return { state: null }; }
    return { state: s || null };
  }
  if (msg.op === "set") {
    const s = msg.state;
    if (!s || typeof s !== "object" || typeof s.task !== "string" || typeof s.actId !== "string") return { error: "bad state" };
    await chrome.storage.session.set({ [key]: { actId: s.actId.slice(0, 64), task: s.task.slice(0, 2000), startedAt: Number(s.startedAt) || Date.now(), history: (Array.isArray(s.history) ? s.history : []).slice(-12).map((h) => String(h).slice(0, 100)), done: Number(s.done) || 0, awaiting: !!s.awaiting } });
    return { ok: true };
  }
  if (msg.op === "clear") { await chrome.storage.session.remove(key); return { ok: true }; }
  return { error: "unknown op" };
}
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove(stateKey(tabId)).catch(() => {}); });

// Tab-level actions a page cannot do for itself. open_url navigates the CURRENT tab (so the content script of the next page can
// resume the task) unless newTab is set; a new tab inherits the task state so the work carries on there.
async function actTab(msg, sender) {
  const tab = sender?.tab;
  if (!tab || tab.id == null) return { error: "no tab" };
  switch (msg.cmd) {
    case "open_url": {
      let u; try { u = new URL(String(msg.url)); } catch { return { error: "not a URL" }; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "only http and https links can be opened" };
      if (msg.newTab) {
        const nt = await chrome.tabs.create({ url: u.href, active: true });
        const r = await chrome.storage.session.get(stateKey(tab.id));
        if (r[stateKey(tab.id)] && nt.id != null) { await chrome.storage.session.set({ [stateKey(nt.id)]: { ...r[stateKey(tab.id)], awaiting: true } }); await chrome.storage.session.remove(stateKey(tab.id)); }
        return { ok: true };
      }
      await chrome.tabs.update(tab.id, { url: u.href });
      return { ok: true };
    }
    case "new_tab": { const nt = await chrome.tabs.create({ active: true }); return nt ? { ok: true, detail: "opened a new tab" } : { ok: false, detail: "could not open a tab" }; }
    case "close_tab": await chrome.storage.session.remove(stateKey(tab.id)); setTimeout(() => chrome.tabs.remove(tab.id).catch(() => {}), 300); return { ok: true, detail: "closing this tab" };
    case "reload": await chrome.tabs.reload(tab.id); return { ok: true, detail: "reloading" };
    case "back": try { await chrome.tabs.goBack(tab.id); return { ok: true, detail: "went back" }; } catch { return { ok: false, detail: "there is no page to go back to" }; }
    case "forward": try { await chrome.tabs.goForward(tab.id); return { ok: true, detail: "went forward" }; } catch { return { ok: false, detail: "there is no page to go forward to" }; }
    case "screenshot": {
      // The picture is returned to the asking page only (to place on the clipboard) and is never sent to the helper or 0G.
      try {
        // captureVisibleTab takes whatever tab is showing in the window: make sure that is the task's tab (a task may have opened another).
        if (!tab.active) { await chrome.tabs.update(tab.id, { active: true }); await new Promise((r) => setTimeout(r, 250)); }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }); return { ok: true, dataUrl }; }
      catch (e) {
        // Most likely cause: the user's Site access for this extension is "on click", which withholds <all_urls>. Say so plainly.
        const all = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => false);
        return { ok: false, detail: all ? "the browser would not take a screenshot of this page (" + String(e?.message ?? e).slice(0, 100) + ")" : "screenshots need Site access set to On all sites (chrome://extensions, Ishara, Details)" };
      }
    }
    case "download": {
      if (typeof msg.dataUrl !== "string" || !msg.dataUrl.startsWith("data:image/png;base64,")) return { error: "not a png" };
      const d = new Date(), p2 = (n) => String(n).padStart(2, "0");
      const filename = `Ishara-screenshot-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.png`;
      try { await chrome.downloads.download({ url: msg.dataUrl, filename, saveAs: false }); return { ok: true, filename }; }
      catch { return { ok: false, detail: "could not save the screenshot" }; }
    }
  }
  return { error: "unknown tab command" };
}

// The same relay as /tutor, for POST /act: the content script posts {type:"start", body}; events come back as {event, data}. The task
// text is in the body and is never logged here. A new "start" or a disconnect aborts the fetch (stopping is POST /act/stop, separate).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "act" || port.sender?.id !== chrome.runtime.id) return;
  let ctl = null, ping = 0;
  const stop = () => { if (ctl) ctl.abort(); ctl = null; clearInterval(ping); ping = 0; };
  port.onMessage.addListener((m) => {
    if (m?.type !== "start" || !m.body) return;
    stop();
    const mine = (ctl = new AbortController());
    const post = (x) => { try { port.postMessage(x); } catch { stop(); } };
    // A task runs up to 3 minutes (hard cap) plus approvals; the keep-alive ping stops the worker sleeping through the gaps.
    ping = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
    const cap = setTimeout(() => { post({ event: "failed", data: { say: "That took too long.", steps: 0, requestIds: { brain: [], laya: [] }, ms: 300000 } }); mine.abort(); }, 5 * 60 * 1000);
    globalThis.IsharaSSE.relay({
      fetchFn: fetch, url: HELPER + "/act", signal: mine.signal, post,
      known: ACT_EVENTS, terminals: ACT_END,
      offlineEvent: (cause) => ({ event: "refused", data: { cause, say: "I could not reach Ishara's helper." } }),
      cutoff: () => ({ event: "failed", data: { say: "The helper stopped answering.", steps: 0, requestIds: { brain: [], laya: [] }, ms: 0 } }),
      init: { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(m.body) },
    }).finally(() => { clearTimeout(cap); if (ctl === mine) { clearInterval(ping); ping = 0; ctl = null; } });
  });
  port.onDisconnect.addListener(stop);
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
    const cap = setTimeout(() => { post({ event: "done", data: { mode: "explain", outcome: "cutoff", requestIds: { laya: [] }, ms: { total: 90000 } } }); mine.abort(); }, 90000); // never hold a stream longer than a whole answer plus proof
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
