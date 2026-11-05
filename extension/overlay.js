// Overlay: pointer, rings, bubble, type box, debug panel. Everything lives in one shadow root
// so page CSS cannot restyle it and our CSS cannot leak. The drawing layer is
// pointer-events:none so the user can still click the thing we point at.
(() => {
  const NS = (globalThis.Ishara = globalThis.Ishara || {});
  let host, root, layer, bubble, pointer, rings = [], follow = null, typeBox, panel;

  function build() {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute("data-ishara-root", ""); // outline compiler skips anything under this
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
<style>
  *{box-sizing:border-box;font-family:system-ui,sans-serif}
  .layer{position:fixed;inset:0;pointer-events:none}
  .ptr{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
       border:3px solid #6d28d9;background:rgba(109,40,217,.18);box-shadow:0 0 0 4px rgba(255,255,255,.7);
       transition:transform .55s cubic-bezier(.2,.8,.2,1);display:none}
  .ptr::after{content:"";position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px;border-radius:50%;background:#6d28d9}
  .ring{position:fixed;border:3px solid #d97706;border-radius:6px;box-shadow:0 0 0 3px rgba(255,255,255,.8);display:none}
  .bub{position:fixed;max-width:320px;padding:8px 12px;background:#1f1147;color:#fff;border-radius:10px;
       font-size:14px;line-height:1.35;display:none;white-space:pre-line;box-shadow:0 4px 18px rgba(0,0,0,.3)}
  .bub.stop{background:#7f1d1d}.bub small{display:block;opacity:.75;margin-top:4px}
  .tb{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);pointer-events:auto;display:none;
      background:#fff;border:2px solid #6d28d9;border-radius:10px;padding:8px;box-shadow:0 6px 24px rgba(0,0,0,.3)}
  .tb input{width:min(480px,80vw);font-size:16px;padding:8px;border:1px solid #ccc;border-radius:6px;color:#000;background:#fff}
  .tb div{font-size:11px;color:#555;margin-top:4px}
  .dbg{position:fixed;right:12px;top:12px;width:372px;max-height:86vh;overflow:auto;pointer-events:auto;display:none;
       background:#0f172a;color:#e2e8f0;border-radius:12px;padding:0;font-size:13px;line-height:1.4;box-shadow:0 8px 30px rgba(0,0,0,.45)}
  .dbg .hd{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px}
  .dbg .hd b{color:#fff;font-size:13px;letter-spacing:.02em}
  .dbg .verdict{margin:12px 14px 0;padding:12px 14px;border-radius:10px;border:1px solid}
  .dbg .verdict.point{background:#052e1a;border-color:#15803d}.dbg .verdict.ask{background:#3a2a05;border-color:#b45309}
  .dbg .verdict.stop{background:#3b0d0d;border-color:#b91c1c}.dbg .verdict.err{background:#3b0d0d;border-color:#b91c1c}
  .dbg .tag{font-size:11px;font-weight:700;letter-spacing:.08em}
  .dbg .point .tag{color:#4ade80}.dbg .ask .tag{color:#fbbf24}.dbg .stop .tag,.dbg .err .tag{color:#f87171}
  .dbg .q{font-size:15px;color:#fff;margin-top:4px}.dbg .a{margin-top:6px;color:#cbd5e1}
  .dbg .steps{margin:10px 14px 0;display:flex;flex-direction:column;gap:2px}
  .dbg .row{display:grid;grid-template-columns:20px 1fr auto;gap:8px;align-items:baseline;padding:7px 0;border-bottom:1px solid #1e293b}
  .dbg .row:last-child{border-bottom:0}
  .dbg .ic{font-weight:700;text-align:center}.dbg .ok .ic{color:#4ade80}.dbg .no .ic{color:#f87171}.dbg .na .ic{color:#64748b}
  .dbg .na{color:#64748b}.dbg .what b{color:#fff;font-weight:600}.dbg .why{color:#94a3b8;font-size:12px}
  .dbg .ms{color:#94a3b8;font-variant-numeric:tabular-nums;white-space:nowrap}
  .dbg .total{margin:4px 14px 0;color:#94a3b8;font-size:12px}
  .dbg .sec{margin:14px 14px 6px;color:#64748b;font-size:11px;letter-spacing:.08em;text-transform:uppercase}
  .dbg .btns{margin:0 14px;display:flex;gap:8px;flex-wrap:wrap}
  .dbg button{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;cursor:pointer}
  .dbg button:hover{background:#334155}.dbg button.main{background:#2563eb;border-color:#2563eb;color:#fff}
  .dbg .res{margin:8px 14px 14px;font-size:12px;color:#cbd5e1}.dbg .res a{color:#7dd3fc}
  .dbg .id{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#94a3b8}
</style>
<div class="layer"></div><div class="bub"></div><div class="tb"><input placeholder="Ask where something is, then Enter"><div>Esc to close</div></div><div class="dbg"></div>`;
    layer = root.querySelector(".layer");
    bubble = root.querySelector(".bub");
    typeBox = root.querySelector(".tb");
    panel = root.querySelector(".dbg");
    pointer = document.createElement("div"); pointer.className = "ptr"; layer.append(pointer);
    document.documentElement.append(host);
  }

  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function clear() {
    build();
    follow = null;
    pointer.style.display = "none";
    rings.forEach((r) => r.remove()); rings = [];
    bubble.style.display = "none";
  }

  function say(text, opts = {}) {
    bubble.className = "bub" + (opts.stop ? " stop" : "");
    bubble.textContent = text;
    if (opts.sub) { const s = document.createElement("small"); s.textContent = opts.sub; bubble.append(s); }
    bubble.style.display = "block";
    placeBubble(opts.near);
  }

  // Put the bubble beside the target, flipping above/below to stay on screen.
  function placeBubble(rect) {
    const bw = bubble.offsetWidth, bh = bubble.offsetHeight;
    let x = innerWidth / 2 - bw / 2, y = 24;
    if (rect) {
      x = Math.min(Math.max(8, rect.x), innerWidth - bw - 8);
      y = rect.y + rect.h + 34 + bh < innerHeight ? rect.y + rect.h + 34 : Math.max(8, rect.y - bh - 34);
    }
    bubble.style.left = x + "px"; bubble.style.top = y + "px";
  }

  function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }

  // Scroll first, then read the rect, so the pointer lands where the element really is now,
  // not where the outline saw it before the page moved.
  async function point(el, text) {
    build(); clear();
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await raf2();
    const place = () => {
      const r = rectOf(el);
      pointer.style.transform = `translate(${r.x + r.w / 2}px,${r.y + r.h / 2}px)`;
      if (bubble.style.display === "block") placeBubble(r);
    };
    pointer.style.transition = "none"; pointer.style.transform = `translate(${innerWidth / 2}px,${innerHeight + 40}px)`;
    pointer.style.display = "block";
    await raf2();
    pointer.style.transition = "";
    place();
    say(text, { near: rectOf(el) });
    follow = place; // keep tracking if the user scrolls or the layout shifts
  }

  function ringBoth(els, text) {
    build(); clear();
    els[0].scrollIntoView({ block: "center", behavior: "instant" });
    const make = (el) => { const d = document.createElement("div"); d.className = "ring"; layer.append(d); rings.push(d); return [d, el]; };
    const pairs = els.map(make);
    follow = () => pairs.forEach(([d, el]) => {
      const r = rectOf(el);
      Object.assign(d.style, { display: "block", left: r.x - 4 + "px", top: r.y - 4 + "px", width: r.w + 8 + "px", height: r.h + 8 + "px" });
    });
    follow();
    say(text, { near: rectOf(els[0]) });
  }

  const tick = () => { if (follow) follow(); };
  addEventListener("scroll", tick, true);
  addEventListener("resize", tick);

  function thinking(text = "Thinking…") { build(); clear(); say(text); }

  function openTypeBox(onSubmit) {
    build();
    typeBox.style.display = "block";
    const input = typeBox.querySelector("input");
    input.value = ""; input.focus();
    const close = () => { typeBox.style.display = "none"; input.onkeydown = null; };
    // stopPropagation: the page's own shortcuts must not see what the user types here.
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Escape") close();
      else if (e.key === "Enter" && input.value.trim()) { const q = input.value.trim(); close(); onSubmit(q); }
    };
    input.onkeyup = input.onkeypress = (e) => e.stopPropagation();
  }

  // ---- debug panel ----
  let last = null;
  function setDebug(d) { last = d; if (panel && panel.style.display === "block") renderDebug(); }
  function toggleDebug(handlers) {
    build();
    NS._dbgHandlers = handlers || NS._dbgHandlers;
    panel.style.display = panel.style.display === "block" ? "none" : "block";
    renderDebug();
  }
  // The panel is for a glance: one verdict, then the three steps that led to it, then the receipts.
  const HELPER = "http://127.0.0.1:7777";
  const secs = (ms) => (ms == null ? "" : (ms / 1000).toFixed(1) + " s");
  function renderDebug() {
    panel.textContent = "";
    const el = (tag, cls, text, parent = panel) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; parent.append(n); return n; };
    const hd = el("div", "hd"); el("b", "", "Ishara", hd); el("span", "", "Alt+Shift+D hides this", hd);
    if (!last) { el("div", "sec", "Nothing asked yet"); return; }
    const { decision: d, question, error, proposedLabel, targetLabel, outlineMs } = last;

    // 1. The verdict, in one look.
    const kind = error ? "err" : !d ? "err" : d.outcome === "point" ? "point" : d.outcome === "safe_stop" ? "stop" : "ask";
    const tagText = { point: "POINTED", ask: "ASKED YOU", stop: "REFUSED TO GUESS", err: "PROBLEM" }[kind];
    const v = el("div", "verdict " + kind);
    el("div", "tag", tagText, v);
    el("div", "q", question ? "“" + question + "”" : "", v);
    if (error || !d) el("div", "a", error || "No answer came back.", v);
    else if (d.outcome === "point") el("div", "a", `Pointed at “${targetLabel || d.targetId}”. ${d.say}`, v);
    else if (d.outcome === "safe_stop") el("div", "a", "0G could not answer, so nothing moved. This is on purpose.", v);
    else el("div", "a", "I was not sure enough to point, so I asked.", v);
    if (error || !d) return;

    // 2. The steps. A tick means it worked, a cross means it failed, a dash means it was not needed.
    const steps = el("div", "steps");
    const row = (state, what, why, ms) => {
      const r = el("div", "row " + state, null, steps);
      el("span", "ic", state === "ok" ? "✓" : state === "no" ? "✗" : "–", r);
      const w = el("span", "what", null, r); w.innerHTML = ""; const bb = el("b", "", what, w);
      if (why) { w.append(document.createElement("br")); el("span", "why", why, w); }
      el("span", "ms", ms, r); void bb;
    };
    row("ok", "I heard you", outlineMs != null ? `page read in ${outlineMs.toFixed(0)} ms` : "", "");
    if (d.proposedId) row("ok", `0GM proposed “${proposedLabel || d.proposedId}”`, "sealed model on 0G read the page", secs(d.ms?.brain));
    else if (d.safeStopCause) row("no", "0GM did not answer", "cause: " + d.safeStopCause, "");
    else row("no", "0GM found nothing that fits", "", secs(d.ms?.brain));
    if (d.layaP != null) {
      const sure = Math.round(d.layaP * 100);
      row(d.outcome === "point" ? "ok" : "no", `laya is ${sure}% sure it is right`, d.outcome === "point" ? "needed at least 40%" : "needed at least 40%, so I asked", secs(d.ms?.laya));
    } else row("na", "laya was not asked", d.proposedId ? "could not be reached" : "nothing to check", "");
    row(d.outcome === "point" ? "ok" : d.outcome === "safe_stop" ? "no" : "na", d.outcome === "point" ? "Pointer moved" : d.outcome === "safe_stop" ? "Stopped instead of guessing" : "Asked you instead of pointing", "", "");
    el("div", "total", "Total " + secs(d.ms?.total), panel);

    // 3. Receipts.
    el("div", "sec", "Proof this came from 0G", panel);
    const btns = el("div", "btns");
    const ids = d.requestIds || {};
    if (ids.brain) { const b = el("button", "main", "How do I know?", btns); b.onclick = () => window.open(`${HELPER}/app/proof.html?id=${encodeURIComponent(ids.brain)}`, "_blank"); }
    if (ids.laya) { const b = el("button", "", "laya's receipt", btns); b.onclick = () => window.open(`${HELPER}/app/proof.html?id=${encodeURIComponent(ids.laya)}`, "_blank"); }
    if (!ids.brain && !ids.laya) el("div", "res", "No answer, so no receipt for this question.");
    else el("div", "res id", "request " + (ids.brain || ids.laya).slice(0, 8) + "…");

    // 4. End the session: encrypt the log, store it on 0G, record its root on the chain.
    el("div", "sec", "Save this session", panel);
    const btns2 = el("div", "btns");
    const end = el("button", "", "Save to 0G Storage", btns2);
    const res = el("div", "res", "", panel);
    end.onclick = async () => {
      res.textContent = "Encrypting and uploading, about 15 s…";
      const r = await NS._dbgHandlers.endSession();
      res.textContent = "";
      const data = r.data;
      if (r.error || !data) { res.textContent = "Failed: " + (r.error || "no answer"); return; }
      const line = (ok, text) => { const n = el("div", "", (ok ? "✓ " : "✗ ") + text, res); n.style.color = ok ? "#4ade80" : "#f87171"; };
      if (data.root) line(true, `Stored on 0G Storage (${secs(data.storage?.ms)})`);
      else line(false, data.error || "Not stored");
      if (data.contract) line(true, "Root recorded on the Galileo contract");
      else if (data.root) line(false, "Contract write failed");
      if (data.root) { const a = el("a", "", "Open the replay", res); a.href = `${HELPER}/app/replay.html?session=${encodeURIComponent(NS._dbgHandlers.sessionId)}`; a.target = "_blank"; }
    };
  }

  NS.overlay = { clear, say, point, ringBoth, thinking, openTypeBox, setDebug, toggleDebug };
})();
