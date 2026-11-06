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
        // Root cause of the 6 Nov report is still unknown (audit 4, section 3): log who asked, so the next repro names it.
        console.debug("[ishara] rec-start from tab", tabId, "frame", sender?.frameId, "active", act && act.id, "window", sender?.tab?.windowId, "recTab", recTab);
        // No active tab found (a DevTools or popup window has focus) is a refusal too, not a pass.
        if (!act || tabId == null || act.id !== tabId) { console.debug("[ishara] rec-start refused: tab", tabId, "is not the active tab", act && act.id); return { error: "not the active tab" }; }
      } catch { return { error: "could not tell which tab is active" }; }
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
      if (msg.path === "/act/approve") return { error: "approvals go through the Ishara window" }; // never from a page (audit 4, 1.8)
      if (msg.path === "/act/stop" && msg.body && typeof msg.body.actId === "string") for (const [k, a] of approvals) if (a.actId === msg.body.actId) finishApproval(k, { yes: false, accepted: false, closed: true });
      return helper(msg.path, json(msg.body || {}), 20000);
    }
    case "act-state": return actState(msg, sender);
    case "act-approval": return askApproval(msg, sender);       // the content script waits here for the person's answer
    case "approval-info": { const a = approvals.get(msg.token); return a ? { words: a.words, why: a.why, risk: a.risk, site: a.site } : { error: "this request is over" }; }
    case "approval-answer": { // from approve.html only (an extension page: no sender.tab)
      // Only the extension's own approve.html may answer; a content script's sender.url is the web page, so it cannot pass this.
      if (sender?.id !== chrome.runtime.id || !String(sender?.url || "").startsWith(chrome.runtime.getURL("approve.html"))) return { error: "not from the approval window" };
      if (msg.stop) { const a = approvals.get(msg.token); await answerApproval(msg.token, false); if (a) disarmAll("stop button"); return { ok: true }; }
      await answerApproval(msg.token, msg.yes === true); return { ok: true };
    }
    case "act-stop-all": await disarmAll(msg.why || "stop"); return { ok: true };
    case "session-id": { const t = sender?.tab?.id; if (t == null) return { id: null }; const s = await sessionFor(t, false); return { id: s.id }; }
    case "session-rotate": { const t = sender?.tab?.id; if (t == null) return { id: null }; const s = await sessionFor(t, true); return { id: s.id }; }
    case "session-touch": { const t = sender?.tab?.id; if (t == null) return {}; const s = await sessionFor(t, false); if (s.id === msg.sessionId) await chrome.storage.session.set({ [sessKey(t)]: { ...s, last: Date.now(), used: true } }); return {}; }
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
const ARM_IDLE_MS = 10 * 60 * 1000;      // Agent mode disarms itself after 10 minutes without a task (audit 4, 1.7)
const stateKey = (tabId) => "act:" + tabId;
const armKey = (tabId) => "agent:" + tabId;

// Agent mode is armed PER TAB, not for the whole browser, and only for 10 idle minutes. A task that moves to another tab carries
// its arming with it (copyTask). Turning it off anywhere turns it off everywhere and stops every task (disarmAll).
async function isArmed(tabId) {
  if (tabId == null) return false;
  const r = (await chrome.storage.session.get(armKey(tabId)))[armKey(tabId)];
  if (!r || !r.on) return false;
  if (Date.now() - (r.at || 0) > ARM_IDLE_MS) { await chrome.storage.session.remove(armKey(tabId)); return false; }
  return true;
}
async function allKeys(prefix) { const all = await chrome.storage.session.get(null); return Object.keys(all).filter((k) => k.startsWith(prefix)); }
async function disarmAll(why) {
  const keys = [...(await allKeys("agent:")), ...(await allKeys("act:"))].filter((k) => k !== "act:stopAt");
  await chrome.storage.session.remove(keys);
  await chrome.storage.session.set({ "act:stopAt": Date.now() });
  helper("/act/stop", json({ all: true }), 3000).catch(() => {});
  closeApprovals(false);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, { type: "act-stop-cmd", why }).catch(() => {});
}
// Move a running task (and its arming) to another tab.
async function copyTask(fromId, toId) {
  const r = await chrome.storage.session.get([stateKey(fromId), armKey(fromId)]);
  const st = r[stateKey(fromId)];
  if (!st) return false;
  await chrome.storage.session.set({ [stateKey(toId)]: { ...st, awaiting: true, savedAt: Date.now() }, ...(r[armKey(fromId)] ? { [armKey(toId)]: { on: true, at: Date.now() } } : {}) });
  await chrome.storage.session.remove(stateKey(fromId));
  return true;
}

async function actState(msg, sender) {
  const tabId = sender?.tab?.id;
  if (msg.op === "agent-get") return { on: await isArmed(tabId) };
  if (msg.op === "agent-set") {
    if (msg.on) { if (tabId == null) return { error: "no tab" }; await chrome.storage.session.set({ [armKey(tabId)]: { on: true, at: Date.now() } }); return { ok: true }; }
    await disarmAll("agent off"); return { ok: true };
  }
  if (msg.op === "agent-touch") { if (await isArmed(tabId)) await chrome.storage.session.set({ [armKey(tabId)]: { on: true, at: Date.now() } }); return { ok: true }; }
  if (tabId == null) return { error: "no tab" };
  const key = stateKey(tabId);
  if (msg.op === "get") {
    const r = await chrome.storage.session.get([key, "act:stopAt"]), s = r[key];
    // A Stop (shortcut, Agent mode off) made after the state was saved wins over a page load that would resume it (audit 4, 1.7).
    if (s && (Date.now() - (s.startedAt || 0) > STATE_TTL || (r["act:stopAt"] || 0) >= (s.savedAt || 0) || !(await isArmed(tabId)))) { await chrome.storage.session.remove(key); return { state: null }; }
    return { state: s || null };
  }
  if (msg.op === "set") {
    const s = msg.state;
    if (!s || typeof s !== "object" || typeof s.task !== "string" || typeof s.actId !== "string") return { error: "bad state" };
    await chrome.storage.session.set({ [key]: { actId: s.actId.slice(0, 64), taskId: String(s.taskId || s.actId).slice(0, 64), task: s.task.slice(0, 2000), startedAt: Number(s.startedAt) || Date.now(), savedAt: Date.now(), history: (Array.isArray(s.history) ? s.history : []).slice(-12).map((h) => String(h).slice(0, 100)), done: Number(s.done) || 0, awaiting: !!s.awaiting } });
    return { ok: true };
  }
  if (msg.op === "clear") { await chrome.storage.session.remove(key); return { ok: true }; }
  return { error: "unknown op" };
}
chrome.tabs.onRemoved.addListener((tabId) => { chrome.storage.session.remove([stateKey(tabId), armKey(tabId)]).catch(() => {}); });

// ---- Stop that a page cannot swallow (audit 4, 1.8): a browser command, handled here, with no content script in the way. ----
chrome.commands?.onCommand.addListener((cmd) => { if (cmd === "stop-agent") disarmAll("shortcut"); });

// ---- Approve / Deny in an extension window, never in the page (audit 4, 1.8). The page cannot see, hide, cover or click it. ----
// The worker itself posts the answer to the helper and tells the tab only what the HELPER accepted (audit 4, 1.9).
const approvals = new Map(); // token -> { tabId, actId, n, words, why, risk, winId, done(result) }
const APPROVAL_MS = 60000;
function closeApprovals(yes) { for (const [k, a] of approvals) finishApproval(k, { yes: !!yes, accepted: false, closed: true }); }
async function finishApproval(token, result) {
  const a = approvals.get(token);
  if (!a) return;
  approvals.delete(token);
  clearTimeout(a.timer);
  if (a.winId != null) chrome.windows.remove(a.winId).catch(() => {});
  a.done(result);
}
async function askApproval(msg, sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || typeof msg.actId !== "string" || !Number.isInteger(msg.n)) return { yes: false, accepted: false, error: "bad request" };
  const token = crypto.randomUUID();
  return new Promise(async (done) => {
    const a = { tabId, actId: msg.actId, n: msg.n, words: String(msg.words || "").slice(0, 160), why: String(msg.why || "").slice(0, 200), risk: String(msg.risk || "high"), site: sender.tab.url ? new URL(sender.tab.url).host : "", winId: null, done, timer: 0 };
    approvals.set(token, a);
    a.timer = setTimeout(() => answerApproval(token, false), APPROVAL_MS); // silence is a no
    try {
      const w = await chrome.windows.create({ url: chrome.runtime.getURL("approve.html#" + token), type: "popup", width: 460, height: 300, focused: true });
      a.winId = w.id;
    } catch (e) { answerApproval(token, false); }
  });
}
async function answerApproval(token, yes) {
  const a = approvals.get(token);
  if (!a) return;
  const r = await helper("/act/approve", json({ actId: a.actId, n: a.n, approve: !!yes }), 5000);
  finishApproval(token, { yes: !!yes, accepted: !!(r.data && r.data.accepted === true) });
}
chrome.windows.onRemoved.addListener((winId) => { for (const [k, a] of approvals) if (a.winId === winId) answerApproval(k, false); }); // closing the window is a no

// ---- Sessions: one per tab (not per page load), saved to 0G when the tab closes or after 15 idle minutes (audit 4, section 5) ----
const SESSION_IDLE_MS = 15 * 60 * 1000;
const sessKey = (tabId) => "sess:" + tabId;
async function sessionFor(tabId, rotate) {
  const k = sessKey(tabId);
  let s = (await chrome.storage.session.get(k))[k];
  if (!s || rotate) { s = { id: crypto.randomUUID(), last: Date.now(), used: false }; await chrome.storage.session.set({ [k]: s }); }
  return s;
}
async function endSession(tabId, s) {
  if (!s || !s.used) return;                                     // nothing was asked: nothing to store
  await chrome.storage.session.remove(sessKey(tabId));
  helper("/session/end", json({ sessionId: s.id }), 90000).catch(() => {});
}
chrome.tabs.onRemoved.addListener(async (tabId) => { const k = sessKey(tabId); const s = (await chrome.storage.session.get(k))[k]; endSession(tabId, s); });
chrome.alarms.create("session-idle", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (al) => {
  if (al.name !== "session-idle") return;
  const all = await chrome.storage.session.get(null);
  for (const [k, s] of Object.entries(all)) if (k.startsWith("sess:") && s && s.used && Date.now() - (s.last || 0) > SESSION_IDLE_MS) endSession(Number(k.slice(5)), s);
});

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
        const moved = nt.id != null && (await copyTask(tab.id, nt.id));
        return { ok: true, moved };
      }
      // After `tab new`: the blank tab is where this page should load, so the task carries on there.
      const blankKey = "act:blank:" + tab.id;
      const blank = (await chrome.storage.session.get(blankKey))[blankKey];
      if (blank != null) {
        await chrome.storage.session.remove(blankKey);
        const bt = await chrome.tabs.get(blank).catch(() => null);
        if (bt) {
          await copyTask(tab.id, bt.id);
          await chrome.tabs.update(bt.id, { url: u.href, active: true });
          return { ok: true, moved: true };
        }
      }
      await chrome.tabs.update(tab.id, { url: u.href });
      return { ok: true };
    }
    case "tab_op": return actTabOp(msg, tab);
    case "new_tab": { const nt = await chrome.tabs.create({ active: true }); return nt ? { ok: true, detail: "opened a new tab" } : { ok: false, detail: "could not open a tab" }; }
    // The tab Ishara works in is never closed by a task, whatever the approval (docs/AGENT-MODE.md; audit 4, section 2).
    case "close_tab": return { ok: false, detail: "refused: that would close the tab I am working in" };
    case "reload": await chrome.tabs.reload(tab.id); return { ok: true, detail: "reloading" };
    // Back / forward: report whether the address actually changed (a single-page app changes it without a page load), instead of
    // the page sleeping blind for 8 seconds (audit 4, section 2).
    case "back": case "forward": {
      const before = tab.url;
      const changed = waitForChange(tab.id, before, 4000);
      try { await (msg.cmd === "back" ? chrome.tabs.goBack(tab.id) : chrome.tabs.goForward(tab.id)); }
      catch { return { ok: false, detail: msg.cmd === "back" ? "there is no page to go back to" : "there is no page to go forward to" }; }
      const c = await changed;
      return c ? { ok: true, changed: true, detail: msg.cmd === "back" ? "went back" : "went forward" } : { ok: false, detail: "the page did not change" };
    }
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

// Resolves true when the tab starts loading or its address changes (same-document history included), false after `ms`.
function waitForChange(tabId, beforeUrl, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(on); resolve(false); }, ms);
    function on(id, info) {
      if (id !== tabId) return;
      if (info.status === "loading" || (info.url && info.url !== beforeUrl)) { clearTimeout(t); chrome.tabs.onUpdated.removeListener(on); resolve(true); }
    }
    chrome.tabs.onUpdated.addListener(on);
  });
}

// Agent mode tab actions: switch / close by match, and new. `tab` is the tab the task runs in (sender.tab).
function tabsMatching(all, selfId, match) {
  const m = String(match || "").toLowerCase();
  return all.filter((t) => t.id !== selfId && ((t.title || "").toLowerCase().includes(m) || (t.url || "").toLowerCase().includes(m)));
}
const tabName = (t) => "“" + String(t.title || t.url || "untitled").replace(/\s+/g, " ").slice(0, 40) + "”";
async function actTabOp(msg, tab) {
  const op = msg.op, match = typeof msg.match === "string" ? msg.match.trim() : "";
  if (op === "new") {
    const nt = await chrome.tabs.create({ active: true });
    if (!nt) return { ok: false, detail: "could not open a tab" };
    await chrome.storage.session.set({ ["act:blank:" + tab.id]: nt.id });
    return { ok: true, detail: "opened a new blank tab; use search or open_url next and it will load there" };
  }
  if (op !== "switch" && op !== "close") return { error: "unknown tab op" };
  if (op === "close" && !match) return { ok: false, detail: "refused: that would close the tab I am working in; say which other tab to close" };
  const all = await chrome.tabs.query({ windowId: tab.windowId });
  const mine = all.find((t) => t.id === tab.id);
  // Closing the tab Ishara is running in is refused, by id and also when the match can only mean it.
  const hits = tabsMatching(all, tab.id, match);
  if (op === "close" && mine && !hits.length && ((mine.title || "").toLowerCase().includes(match.toLowerCase()) || (mine.url || "").toLowerCase().includes(match.toLowerCase()))) {
    return { ok: false, detail: "refused: that is the tab I am working in, and I do not close it" };
  }
  if (!hits.length) return { ok: false, detail: "no other tab matches “" + match.slice(0, 40) + "”" };
  if (hits.length > 1) return { ok: false, detail: hits.length + " tabs match “" + match.slice(0, 40) + "”: " + hits.slice(0, 3).map(tabName).join(", ") + ". Use a more specific word." };
  const target = hits[0];
  if (op === "close") { await chrome.tabs.remove(target.id); return { ok: true, detail: "closed the tab " + tabName(target) }; }
  await chrome.tabs.update(target.id, { active: true });
  await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
  // The task moves with the person's attention: copy its state to the target tab and wake that tab's script.
  const moved = await copyTask(tab.id, target.id);
  if (moved) setTimeout(() => chrome.tabs.sendMessage(target.id, { type: "act-resume" }).catch(() => {}), 400);
  return { ok: true, moved, detail: "switched to the tab " + tabName(target) };
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
