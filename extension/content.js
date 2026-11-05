// Input handling and the ask flow. Chords (event.code, because Option+key types a different
// character on macOS):
//   hold Alt+Space        push-to-talk
//   Alt+Shift+Space       type-instead box
//   Alt+Shift+D           debug panel
(() => {
  const NS = globalThis.Ishara;
  // One id per page load: the helper keys its log and the 0G session root on it. A new one after "End session",
  // because the contract takes one root per session and later answers would otherwise never be stored.
  let sessionId = crypto.randomUUID();
  let recording = false, busy = false, pending = null; // pending: outline compiled at key-down
  let startP = null, transcribing = false;

  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => {
    res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r);
  }));

  function showError(text, question) {
    NS.overlay.say(text, { stop: true });
    NS.overlay.setDebug({ question, error: text });
  }

  async function ask(question, compiled) {
    if (busy) return;
    busy = true;
    try {
      // Show what we understood so a wrong transcript is visible at once (voice errors look like wrong answers otherwise).
      NS.overlay.thinking(`I heard: “${question}” …thinking`);
      const { outline, map, ms } = compiled || NS.compileOutline();
      const r = await send({ type: "decide", body: { sessionId, question, outline } });
      if (r.error) return showError("Ishara helper problem: " + r.error, question);
      const d = r.data;
      const labelOf = (id) => (outline.elements.find((e) => e.id === id) || {}).label;
      NS.overlay.setDebug({ question, decision: d, outlineMs: ms, proposedLabel: labelOf(d.proposedId), targetLabel: labelOf(d.targetId) });
      // The element may have been removed since compile; refuse to point rather than guess.
      const el = d.targetId && current(map.get(d.targetId), outline.elements.find((e) => e.id === d.targetId));
      if (d.outcome === "point" && el) await NS.overlay.point(el, d.say);
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
      } else NS.overlay.say(d.say); // "ask": words only, never a pointer
    } finally { busy = false; }
  }

  // Pages that re-render (React, GitHub) swap the node between the outline and the answer. Find it again only if
  // exactly one visible element has the same role and label as the one laya confirmed; otherwise refuse.
  function current(el, seen) {
    if (el && el.isConnected) return el;
    if (!seen) return null;
    const now = NS.compileOutline();
    const same = now.outline.elements.filter((e) => e.role === seen.role && e.label === seen.label);
    return same.length === 1 ? now.map.get(same[0].id) : null;
  }

  // Live mic level while the key is held: a row of blocks that grows with your voice. Silence stays empty,
  // which is how you can tell the mic is not hearing you before you let go.
  chrome.runtime.onMessage.addListener((m) => {
    if (m.type !== "level" || !recording) return;
    const n = Math.min(10, Math.round(Math.sqrt(m.rms) * 28));
    NS.overlay.say("Listening… release to send\n" + "▮".repeat(n) + "▯".repeat(10 - n));
  });

  // Whisper turns noise into stock phrases. If that is all we got, say so instead of asking 0G about it.
  const NOISE = /^(you|thank you|thanks|thanks for watching|bye|okay|ok|the|uh|um|hmm|\.+)\W*$/i;

  async function startTalking() {
    if (recording || busy || transcribing) return;
    recording = true;
    NS.overlay.clear();
    // Compile now, in parallel with the speech, so the outline is ready the moment we have text.
    pending = NS.compileOutline();
    NS.overlay.say("Listening… release to send");
    startP = send({ type: "rec-start" });
    const r = await startP;
    if (r && r.error) { recording = false; showError(r.error); if (/microphone/.test(r.error)) send({ type: "open-setup" }); }
  }

  async function stopTalking() {
    if (!recording) return;
    recording = false;
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
    if (text.length < 3 || NOISE.test(text)) return showError(`I heard “${text}”, which is probably noise. Try again.`);
    ask(text, compiled);
  }

  addEventListener("keydown", (e) => {
    if (e.altKey && e.code === "Space" && !e.shiftKey) {
      e.preventDefault(); e.stopPropagation();
      if (!e.repeat) startTalking();
    } else if (e.altKey && e.shiftKey && e.code === "Space") {
      e.preventDefault(); e.stopPropagation();
      NS.overlay.openTypeBox((q) => ask(q));
    } else if (e.altKey && e.shiftKey && e.code === "KeyD") {
      e.preventDefault();
      NS.overlay.toggleDebug({
        sessionId,
        proof: (id) => send({ type: "proof", requestId: id }),
        endSession: async () => {
          const r = await send({ type: "session-end", sessionId });
          if (r.data && r.data.root) sessionId = crypto.randomUUID();
          return r;
        },
      });
    } else if (e.key === "Escape") NS.overlay.clear();
  }, true);

  // Release of either key ends the recording; blur covers Option+Tab away mid-hold.
  addEventListener("keyup", (e) => { if (e.code === "Space" || e.code.startsWith("Alt")) stopTalking(); }, true);
  addEventListener("blur", () => stopTalking());
})();
