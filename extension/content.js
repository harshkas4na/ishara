// Input handling and the ask flow. Chords (event.code, because Option+key types a different
// character on macOS):
//   hold Alt+Space        push-to-talk
//   Alt+Shift+Space       type-instead box
//   Alt+Shift+D           debug panel
//   Alt+Shift+O           show what Ishara sees (a numbered box on every control it kept)
(() => {
  const NS = globalThis.Ishara;
  // Content scripts run in every frame (all_frames). Only the TOP frame owns the overlay, the helper and the chords.
  // Key events inside a focused iframe never reach the top window, so a child watches for the same chords and sends
  // them to the top frame through the service worker. Not by postMessage: any script in any frame (an ad) could post
  // the same message and switch the microphone on. And only real key presses (isTrusted), never script-made events.
  if (window !== window.top) {
    const CHORD = (e) => !e.ctrlKey && !e.metaKey && e.altKey && (e.code === "Space" || (e.shiftKey && (e.code === "KeyO" || e.code === "KeyD" || e.code === "KeyC" || e.code === "KeyP" || e.code === "KeyM" || e.code === "KeyA")));
    const up = (m) => { try { chrome.runtime.sendMessage({ type: "chord", d: m }).catch(() => {}); } catch { /* extension reloaded */ } };
    addEventListener("keydown", (e) => {
      if (!e.isTrusted) return;
      if (CHORD(e) || e.key === "Escape") {
        if (CHORD(e)) { e.preventDefault(); e.stopPropagation(); }
        up({ type: "down", code: e.code, key: e.key, altKey: e.altKey, shiftKey: e.shiftKey, repeat: e.repeat });
      }
    }, true);
    addEventListener("keyup", (e) => { if (e.isTrusted && (e.code === "Space" || e.code.startsWith("Alt"))) up({ type: "up", code: e.code }); }, true);
    addEventListener("blur", () => up({ type: "blur" })); // Option+Tab away mid-hold
    return;
  }
  // One id per page load: the helper keys its log and the 0G session root on it. A new one after "End session",
  // because the contract takes one root per session and later answers would otherwise never be stored.
  let sessionId = crypto.randomUUID();
  let recording = false, busy = false, pending = null, inspecting = false; // pending: outline compiled at key-down
  let startP = null, transcribing = false;
  // Agent mode (extension/act.js): the executor and the task loop. Off by default; Option+Shift+A turns it on for this browser session.
  if (NS.act) {
    NS.act.init({ sessionId, getSessionId: () => sessionId });
    NS.act.installDevHook(); // only answers on http://127.0.0.1:7777/test/ pages
    // A task that was mid-flight when the previous page unloaded carries on here (a link, open_url, back/forward).
    NS.act.restoreAgent().then(() => NS.act.resume()).catch(() => {});
  }

  // If the extension was reloaded or updated while this page was open, this page's script is orphaned: sendMessage
  // throws "Extension context invalidated" or never answers. Say so plainly instead of leaving "thinking" on screen.
  const send = (msg) => new Promise((res) => {
    // Saving a session waits for proofs (up to 15 s) and then uploads (about 15 s), so it gets a much longer limit.
    const limit = msg.type === "session-end" ? 100000 : 25000;
    const timer = setTimeout(() => res({ error: "Ishara did not answer. If it was just updated, reload this page." }), limit);
    try {
      chrome.runtime.sendMessage(msg, (r) => { clearTimeout(timer); res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r ?? { error: "Ishara did not answer. If it was just updated, reload this page." })); });
    } catch { clearTimeout(timer); res({ error: "Ishara was updated or reloaded. Reload this page to continue." }); }
  });

  function showError(text, question) {
    NS.overlay.say(text, { stop: true });
    NS.overlay.setDebug({ question, error: text });
  }

  // ---- Tutor ask flow (docs/TUTOR-INTERFACE.md). The classic /decide flow below stays untouched as the fallback. ----
  // classic: forced from Option+Shift+P (stored, so it survives reloads) for a pointing-only demo; also used automatically
  // when the helper has no /tutor route.
  let classic = false, turn = 0, port = null, streaming = false, last = null; // last: {outline, map} of the latest ask, for walk-step pointers
  try { chrome.storage.local.get("classic", (r) => { classic = !!(r && r.classic); NS.overlay.tutor.setClassic(classic); }); } catch { /* extension reloaded */ }

  function closePort() { if (port) { try { port.disconnect(); } catch { /* already gone */ } port = null; } streaming = false; }
  // A new question or Esc: end the old stream (the worker aborts its fetch; the helper keeps draining 0G for the proof).
  // /speech/stop is global to the helper, so a stray one from this tab would cut ANOTHER browser's answer (Esc pressed in a page
  // while a different browser is being read to). Only a tab that started a question may stop the voice on Esc.
  let ownsVoice = false;
  function cancelTurn() { turn++; closePort(); if (ownsVoice) { ownsVoice = false; send({ type: "speech-stop" }); } }

  // Block ids come from the page reader. It may hand back an Element or a Range; no resolver (or no match) means we
  // show the sentence and skip the ring, never guess a position.
  function blockEl(id) {
    try {
      const r = NS.resolveBlock && NS.resolveBlock(id);
      if (!r) return null;
      const el = r.nodeType === 1 ? r : r.startContainer ? (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement) : null;
      return el && el.isConnected ? el : null;
    } catch { return null; }
  }

  async function ask(question, compiled, voice) {
    // Agent mode ON and the request is an order ("fill the form", "open youtube"): the task loop, not an explanation. Every
    // other request, and every request while Agent mode is off, takes the normal tutor path below (the helper tells the user
    // to turn Agent mode on when it recognises a task, so the sentence comes from the router, not from here).
    if (NS.act && NS.act.isAgent() && NS.act.isTask(question)) {
      if (NS.act.isBusy()) return NS.overlay.say("I am still working on the last task. Press Esc to stop it first.");
      cancelTurn(); send({ type: "speech-stop" });
      return NS.act.start(question);
    }
    if (classic) return askClassic(question, compiled);
    const my = ++turn; closePort(); ownsVoice = true;
    inspecting = false; if (stopWatch) stopWatch();
    send({ type: "speech-stop" }); // silence the previous spoken answer at once; the worker also does it when the stream starts
    const T = NS.overlay.tutor;
    const walkCmd = T.walkActive() && T.isWalkWord(question);
    // Thinking state first, as in the classic flow, so a wrong voice transcript is visible before anything else.
    // A walk command keeps the step on screen instead.
    if (!walkCmd) NS.overlay.thinking(`I heard: “${question}” …thinking`);
    let c;
    try { c = await (compiled || NS.compileOutlineAsync()); } catch (e) { return showError("Ishara could not read this page: " + (e && e.message), question); }
    if (my !== turn) return;
    // Richer context from the page reader when it is loaded (blocks, control state); otherwise the outline alone, which
    // the helper accepts as a PageContext with no blocks. Built from THIS outline so the ids match.
    let context = null;
    try { if (NS.compilePageContextAsync) context = await NS.compilePageContextAsync({ outline: c }); } catch { context = null; }
    if (my !== turn) return;
    if (!context) context = { source: "browser", url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, blocks: [], controls: c.outline.elements, errors: [] };
    last = { outline: c.outline, map: c.map };
    T.setOutlineMs(c.ms);
    runStream(my, { type: "ask", body: { sessionId, question, context, mode: "auto", armed: !!(NS.act && NS.act.isAgent()) } }, { question, voice, compiled: c, blocks: context.blocks || [] });
  }

  // Walk buttons (Next / Back / Stop): no 0G call, the helper answers from its walk state.
  function walkButton(cmd) {
    if ((streaming && cmd !== "stop") || !last) return; // a double press must not advance two steps; Stop always works
    const my = ++turn; closePort();
    send({ type: "speech-stop" });
    runStream(my, { type: "walk", sessionId, cmd }, { question: cmd, cmd, blocks: [] });
  }

  function runStream(my, msg, ctx) {
    const T = NS.overlay.tutor;
    const q = ctx.question;
    let p;
    try { p = chrome.runtime.connect({ name: "tutor" }); } catch { return showError("Ishara was updated or reloaded. Reload this page to continue.", q); }
    port = p; streaming = true; T.setBusy(true); // Next/Back wait: the helper starts the walk only once this stream has ended
    let began = false, finished = false, stepSeen = false;
    const begin = (mode) => { if (!began) { began = true; T.begin({ mode, question: q, voice: ctx.voice }); } };
    const finish = () => { finished = true; streaming = false; T.setBusy(false); if (port === p) port = null; try { p.disconnect(); } catch { /* done */ } };
    // `speaking` events keep arriving AFTER done (the voice is still reading). So a finished answer keeps its port open until
    // the voice reports quiet (`speaking {seq:null}`), a new turn closes it, or 60 s pass; only then is it disconnected.
    let lingerT = 0;
    const lingerOpen = () => { finished = true; streaming = false; T.setBusy(false); lingerT = setTimeout(() => { if (port === p) port = null; try { p.disconnect(); } catch { /* done */ } }, 60000); };
    p.onMessage.addListener((m) => {
      if (my !== turn || !m) return;
      const d = m.data || {};
      switch (m.event) {
        case "noroute": // the helper has no /tutor: use the old path exactly as before
          finish(); return askClassic(q, Promise.resolve(ctx.compiled || last && { outline: last.outline, map: last.map, ms: 0 }));
        case "thinking": return begin(d.mode);
        case "say": begin(); return T.say(d.seq, d.text);
        case "point": {
          begin();
          const outline = last && last.outline, map = last && last.map;
          let el = null, label = null;
          if (d.kind === "block") {
            const b = (ctx.blocks || []).find((x) => x.id === d.targetId); label = b && b.text ? b.text.slice(0, 40) : d.targetId;
            if (d.status === "confirmed") el = blockEl(d.targetId);
          } else {
            const seen = outline && outline.elements.find((e) => e.id === d.targetId); label = seen && seen.label;
            if (d.status === "confirmed" && seen && map) el = current(map.get(d.targetId), seen); // the page may have re-rendered since compile
          }
          T.point({ ...d, label }, el);
          if (el && d.kind !== "block" && !el.frame) watchAccepted(el, q); // "accepted" signal for confirmed pointers, as before
          return;
        }
        case "speaking": // only this tab's own turn reaches here: the port is per tab and per turn, and `my !== turn` drops stale ones
          T.speaking(d);
          if (d.seq == null && finished) { clearTimeout(lingerT); finish(); }
          return;
        case "step": begin(); stepSeen = true; return T.step(d);
        case "done": {
          begin(); T.done(d, q);
          // A walk command that produced no new step at the end of the walk (the last "next", or "stop") ends the walk UI.
          const w = ctx.cmd || (T.isWalkWord(q) ? q.trim().toLowerCase() : "");
          if (!stepSeen && /^(next|done|stop|finished|ruko|agla|aage)/.test(w)) { T.endWalk(); T.clearPointers(); }
          return lingerOpen();
        }
        case "refused": begin(); T.refused(d, q); return finish();
      }
    });
    p.onDisconnect.addListener(() => { // the worker went away (extension reloaded) before the turn ended
      if (my === turn && !finished) { streaming = false; port = null; showError("Ishara lost its connection. If it was just updated, reload this page.", q); }
    });
    p.postMessage(msg);
  }
  NS.overlay.tutor.setHandlers({ walk: walkButton });

  async function askClassic(question, compiled) {
    if (busy) return;
    send({ type: "speech-stop" }); // a typed question also silences the previous spoken answer
    busy = true; inspecting = false; // any answer replaces the inspector boxes
    if (stopWatch) stopWatch(); // a new question ends the previous pointer's accept-watch
    try {
      // Show what we understood so a wrong transcript is visible at once (voice errors look like wrong answers otherwise).
      NS.overlay.thinking(`I heard: “${question}” …thinking`);
      const { outline, map, ms } = await (compiled || NS.compileOutlineAsync()); // compiled may be the promise started at key-down
      const r = await send({ type: "decide", body: { sessionId, question, outline } });
      if (r.error) return showError("Ishara helper problem: " + r.error, question);
      const d = r.data;
      const labelOf = (id) => (outline.elements.find((e) => e.id === id) || {}).label;
      NS.overlay.setDebug({ question, decision: d, outlineMs: ms, proposedLabel: labelOf(d.proposedId), targetLabel: labelOf(d.targetId) });
      // The element may have been removed since compile; refuse to point rather than guess.
      const el = d.targetId && current(map.get(d.targetId), outline.elements.find((e) => e.id === d.targetId));
      if (d.outcome === "point" && el && el.frame) await NS.overlay.pointAtFrameElement(el, d.say, d.requestIds && d.requestIds.brain); // no accept-watch: clicks inside a frame never reach us
      else if (d.outcome === "point" && el) { await NS.overlay.point(el, d.say, d.requestIds && d.requestIds.brain); watchAccepted(el, question); }
      else if (d.outcome === "point") NS.overlay.say("The element is gone. Ask again.", { stop: true });
      else if (d.outcome === "ask_which") {
        const els = (d.candidates || []).map((id) => map.get(id)).filter((e) => e && e.isConnected);
        els.length ? NS.overlay.ringBoth(els, d.say) : NS.overlay.say(d.say);
      } else if (d.outcome === "safe_stop") {
        // Say what is wrong in plain words. The refusal is the product working, so it must read as deliberate.
        const WHY = {
          unavailable: "0G's private model is not reachable right now.",
          timeout: "0G took too long to answer.",
          offline: "There is no connection to 0G.",
        };
        NS.overlay.say("I can't decide right now", { stop: true, sub: (WHY[d.safeStopCause] || d.reason) + " I won't guess, so nothing moved." });
      } else NS.overlay.say(d.say, { hidePointer: true }); // "ask": words only, never a pointer
    } finally { busy = false; }
  }

  // Personal memory signal (helper/src/memory.ts): did the user act on the element we pointed at? A click or focus on it
  // within 20 s counts as "accepted". Only the question text and the site's hostname go to the helper, never anything
  // typed into the page. The listeners are removed on the first hit, after 20 s, or when the next answer arrives.
  let stopWatch = null;
  function watchAccepted(el, question) {
    if (stopWatch) stopWatch();
    const off = () => { clearTimeout(timer); el.removeEventListener("click", hit, true); el.removeEventListener("focusin", hit, true); stopWatch = null; };
    const hit = () => { off(); NS.overlay.tutor.nudge(); send({ type: "feedback", body: { sessionId, question, host: location.hostname, kind: "accepted" } }); };
    const timer = setTimeout(off, 20000);
    el.addEventListener("click", hit, true); el.addEventListener("focusin", hit, true);
    stopWatch = off;
  }

  // Pages that re-render (React, GitHub) swap the node between the outline and the answer. Find it again only if
  // exactly one visible element has the same role and label as the one laya confirmed; otherwise refuse.
  function current(el, seen) {
    if (el && el.isConnected) return el;
    if (!seen || (el && el.frame)) return null; // a vanished iframe cannot be re-found by the sync (top-only) compile
    const now = NS.compileOutline();
    const same = now.outline.elements.filter((e) => e.role === seen.role && e.label === seen.label);
    return same.length === 1 ? now.map.get(same[0].id) : null;
  }

  // Listening states (docs/UI-PILL.md): PREPARING from the key-down, LISTENING ("Speak now" + a soft tick) the moment the
  // offscreen recorder delivers its first buffer (`mic-live`). The overlay's setListening owns the pill; the say() text is
  // only the fallback for an overlay without it. Everything said before "Speak now" is already being recorded (pre-roll).
  let tAt = 0, micLive = false;
  function showListening(state) {
    if (NS.overlay.setListening) NS.overlay.setListening(state);
    else if (state === "preparing") NS.overlay.say("Getting ready…");
    else if (state === "listening") NS.overlay.say("Speak now");
  }
  // The tick: 40 ms of 880 Hz, 10 ms fades, quiet. The AudioContext is created inside the key-down (a user gesture) so the
  // browser lets it play. It sounds before the user speaks and is far quieter than speech; Whisper was measured not to hear
  // it as a word (docs/TESTING-extension.md), so nothing is cut from the recording. `tickOff` in chrome.storage.local mutes it.
  let tickCtx = null, tickOff = false;
  try { chrome.storage.local.get("tickOff", (r) => { tickOff = !!(r && r.tickOff); }); chrome.storage.onChanged.addListener((c) => { if (c.tickOff) tickOff = !!c.tickOff.newValue; }); } catch { /* extension reloaded */ }
  function primeTick() { try { tickCtx = tickCtx || new AudioContext(); if (tickCtx.state === "suspended") tickCtx.resume(); } catch { tickCtx = null; } }
  function playTick() {
    if (tickOff || !tickCtx) return;
    try {
      const t = tickCtx.currentTime, o = tickCtx.createOscillator(), g = tickCtx.createGain();
      o.frequency.value = 880; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.06, t + 0.01);
      g.gain.setValueAtTime(0.06, t + 0.03); g.gain.linearRampToValueAtTime(0, t + 0.04);
      o.connect(g); g.connect(tickCtx.destination); o.start(t); o.stop(t + 0.045);
    } catch { /* a missing tick never breaks a take */ }
  }
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type === "mic-live" && !micLive && tAt) {
      micLive = true;
      const ms = Math.round(performance.now() - tAt);
      document.documentElement.dataset.isharaMicLiveMs = String(ms); // measurement hook: key-down -> mic live, in this page
      console.debug("[ishara] mic live", ms, "ms after key-down", m.warm ? "(warm)" : "(cold)");
      if (recording) { showListening("listening"); playTick(); } // a tap released before the mic went live gets neither
    } else if (m.type === "level" && micLive && recording) {
      // Live mic level: bars that grow with your voice. Silence stays empty, so you can tell the mic is not hearing you.
      const n = Math.min(10, Math.round(Math.sqrt(m.rms) * 28));
      if (NS.overlay.setLevel) NS.overlay.setLevel(n);
      else NS.overlay.say("Speak now\n" + "▮".repeat(n) + "▯".repeat(10 - n));
    }
  });

  // Noise, blank and non-Latin garbage are rejected by the helper (transcript-guard.ts), which returns text "". Not here:
  // the old regex and length<3 rule dropped valid short answers like "ok" and "ye".

  async function startTalking() {
    if (recording || busy || transcribing) return;
    recording = true; micLive = false; tAt = performance.now(); primeTick();
    // rec-start goes out FIRST: nothing below may delay the recorder, and the offscreen document buffers from its first sample.
    startP = send({ type: "rec-start" });
    send({ type: "speech-stop" }); // stop the spoken answer so it can never be recorded
    cancelTurn(); // and end a stream still being read
    NS.overlay.clear();
    showListening("preparing");
    // Compile now, in parallel with the speech, so the outline is ready the moment we have text.
    pending = NS.compileOutlineAsync(); // a promise: frames get ~250 ms to answer while the user speaks
    const r = await startP;
    if (r && r.error) { recording = false; if (NS.overlay.setListening) NS.overlay.setListening(null); showError(r.error); if (/microphone/.test(r.error)) send({ type: "open-setup" }); }
  }

  async function stopTalking() {
    if (!recording) return;
    recording = false;
    if (NS.overlay.setListening) NS.overlay.setListening(null); // the pill moves on to "Transcribing…"
    NS.overlay.say("Transcribing…");
    const compiled = pending; pending = null;
    transcribing = true;
    let t;
    try {
      // A quick tap can release before the recorder has started. Stopping then found nothing to stop, and the
      // recorder started afterwards and kept the mic on. So wait for the start to finish first.
      const started = await startP;
      if (started && started.error) return; // already shown by startTalking
      t = await send({ type: "rec-stop" });
    } finally { transcribing = false; }
    if (t.error) return showError(t.error);
    const text = (t.data?.text || "").trim();
    if (!text) return showError("I heard nothing. Try again.");
    ask(text, compiled, true);
  }

  async function onKeyDown(e) {
    // A tab the user is not looking at never reacts to a chord, however the event reached it (frame relays, forwarded
    // messages): one press must start ONE question, in the visible, focused tab.
    if (document.visibilityState !== "visible" || !document.hasFocus()) return;
    if (NS.act && NS.act.handleKey(e)) return; // Y / N answer an approval prompt
    // Ctrl or Cmd held means it is some other chord (e.g. the desktop push-to-talk Control+Option+Space): not ours.
    // Without this, one press started a browser recording AND the desktop recording at the same time.
    if (e.ctrlKey || e.metaKey) return;
    if (e.altKey && e.code === "Space" && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) startTalking();
    } else if (e.altKey && e.shiftKey && e.code === "Space") {
      e.preventDefault(); e.stopPropagation();
      NS.overlay.openTypeBox((q) => ask(q));
    } else if (e.altKey && e.shiftKey && NS.overlay.tutor.walkActive() && (e.code === "ArrowRight" || e.code === "ArrowLeft" || e.code === "Escape")) {
      // guide steps from the keyboard, the same as the pill's buttons
      e.preventDefault(); walkButton(e.code === "ArrowRight" ? "next" : e.code === "ArrowLeft" ? "back" : "stop");
    } else if (e.altKey && e.shiftKey && e.code === "KeyC") { // conversation panel
      e.preventDefault(); NS.overlay.tutor.toggleConvo();
    } else if (e.altKey && e.shiftKey && e.code === "KeyP") { // classic = pointing only (the /decide path), for a plain pointer demo
      e.preventDefault(); classic = !classic; NS.overlay.tutor.setClassic(classic);
      try { chrome.storage.local.set({ classic }); } catch { /* extension reloaded */ }
      NS.overlay.say(classic ? "Classic mode: pointing only. Option+Shift+P goes back to the tutor." : "Tutor mode: answers, steps and follow-ups.");
    } else if (e.altKey && e.shiftKey && e.code === "KeyA") { // Agent mode on / off (default off)
      e.preventDefault(); if (NS.act) NS.act.toggleAgent();
    } else if (e.altKey && e.shiftKey && e.code === "KeyM") { // mute / unmute the spoken answers
      e.preventDefault();
      send({ type: "speech-toggle" }).then((r) => NS.overlay.say(r.data ? (r.data.muted ? "Voice muted" : "Voice on") : "Voice: " + (r.error || "unavailable")));
    } else if (e.altKey && e.shiftKey && e.code === "KeyO") {
      e.preventDefault();
      if (inspecting) { inspecting = false; NS.overlay.clear(); }
      else {
        inspecting = true; const c = await NS.compileOutlineAsync();
        // Page reader (blocks.js): compile the context from THIS outline so ids match, show a one-line summary, log it.
        // Debug only: /decide still receives the outline alone.
        let reader = "";
        try { const pc = await NS.compilePageContextAsync({ outline: c }); const pm = NS.lastPageContext.meta, ph = pm.phases || {}; reader = NS.pageContextSummary(pc) + ` (${pm.ms} ms; walk ${ph.walk}, build ${ph.build}, ${ph.records} text nodes)`; console.debug("[ishara] page context", pc); NS.publishContext(); } catch (err) { reader = "page reader failed: " + err.message; }
        NS.overlay.showOutline(c.outline, c.map, { dropped: c.dropped, ms: c.ms, reader });
      }
    } else if (e.altKey && e.shiftKey && e.code === "KeyD") {
      e.preventDefault();
      NS.overlay.toggleDebug({
        sessionId,
        proof: (id) => send({ type: "proof", requestId: id }),
        agent: () => NS.act && NS.act.toggleAgent(),
        speech: (toggle) => send({ type: toggle ? "speech-toggle" : "speech-status" }), // debug panel Mute button
        endSession: async () => {
          const r = await send({ type: "session-end", sessionId });
          if (r.data && r.data.root) sessionId = crypto.randomUUID();
          return r;
        },
      });
    } else if (e.key === "Escape") {
      // Esc stops a running task at once and cancels any approval prompt (the stop flag is checked between every action).
      if (NS.act && NS.act.isBusy()) NS.act.stop("esc");
      else { cancelTurn(); NS.overlay.clear(); }
    }
  }
  // isTrusted: a page can dispatch a fake Alt+Space; it must never start the microphone or spend 0G calls.
  addEventListener("keydown", (e) => { if (e.isTrusted) onKeyDown(e); }, true);

  // Release of either key ends the recording; blur covers Option+Tab away mid-hold.
  const onKeyUp = (e) => { if (e.code === "Space" || e.code.startsWith("Alt")) stopTalking(); };
  addEventListener("keyup", (e) => { if (e.isTrusted) onKeyUp(e); }, true);
  addEventListener("blur", () => stopTalking());

  // Chords forwarded by child frames (see the top of this file), relayed by the service worker, so only our own
  // content scripts can send them.
  const noop = () => {};
  chrome.runtime.onMessage.addListener((m) => {
    const d = m && m.type === "chord" && m.d;
    if (!d) return;
    if (d.type === "down") onKeyDown({ altKey: !!d.altKey, shiftKey: !!d.shiftKey, code: String(d.code), key: String(d.key), repeat: !!d.repeat, preventDefault: noop, stopPropagation: noop });
    else if (d.type === "up") onKeyUp({ code: String(d.code) });
    else if (d.type === "blur") stopTalking();
  });
})();
