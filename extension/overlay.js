// Overlay: pointer, rings, bubble, type box, debug panel. Everything lives in one shadow root
// so page CSS cannot restyle it and our CSS cannot leak. The drawing layer is
// pointer-events:none so the user can still click the thing we point at.
(() => {
  const NS = (globalThis.Ishara = globalThis.Ishara || {});
  let host, root, layer, bubble, pointer, rings = [], follow = null, typeBox, panel, ink = null, arriveTimer = 0, pollTimer = 0;

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
  /* The cursor: a needle with a saffron tip. It glides, ripples when it lands, bobs while it waits, and
     traces a figure-eight while 0G is thinking. Hotspot (the tip) is the element's centre. */
  .ptr{position:fixed;left:0;top:0;width:0;height:0;display:none;transition:transform .75s cubic-bezier(.22,.9,.2,1)}
  .fx,.fy{position:absolute;left:0;top:0}
  .ptr svg{position:absolute;left:-4px;top:-3px;width:36px;height:36px;overflow:visible;filter:drop-shadow(0 3px 5px rgba(30,20,90,.45))}
  .ptr .rip{position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;border:2.5px solid #f59e0b;opacity:0}
  .ptr.arrive .rip{animation:rip .9s ease-out 2}
  @keyframes rip{0%{transform:scale(.3);opacity:.9}100%{transform:scale(3.2);opacity:0}}
  .ptr.bob .fy{animation:bob 1.8s ease-in-out infinite}
  @keyframes bob{0%,100%{transform:translate(0,0) rotate(0)}50%{transform:translate(2px,5px) rotate(-3deg)}}
  .ptr.think{transition:none}
  .ptr.think .fx{animation:fx 3.6s ease-in-out infinite alternate}
  .ptr.think .fy{animation:fy 1.8s ease-in-out infinite}
  @keyframes fx{from{transform:translateX(-46px)}to{transform:translateX(46px)}}
  @keyframes fy{0%,100%{transform:translateY(0)}25%{transform:translateY(-22px)}75%{transform:translateY(22px)}}
  .ptr.arrive.bob .fy{animation:land .35s ease-out,bob 1.8s ease-in-out .35s infinite}
  @keyframes land{0%{transform:scale(1.3)}60%{transform:scale(.9)}100%{transform:scale(1)}}
  .trail{position:fixed;width:11px;height:11px;margin:-5px 0 0 -5px;border-radius:50%;pointer-events:none;
         background:radial-gradient(circle,#f59e0b 0%,#7c3aed 70%);opacity:.75;animation:tr .55s ease-out forwards}
  @keyframes tr{to{opacity:0;transform:scale(.15)}}
  @media (prefers-reduced-motion:reduce){.ptr .fx,.ptr .fy,.ptr .rip,.trail{animation:none!important}.trail{display:none}}
  .ink{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
  .ink path{fill:none;stroke:#f59e0b;stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;opacity:.92;filter:drop-shadow(0 0 2px rgba(255,255,255,.85))}
  .ring{position:fixed;border:3px solid #d97706;border-radius:6px;box-shadow:0 0 0 3px rgba(255,255,255,.8);display:none}
  .bub{position:fixed;max-width:320px;padding:8px 12px;background:#1f1147;color:#fff;border-radius:10px;
       font-size:14px;line-height:1.35;display:none;white-space:pre-line;box-shadow:0 4px 18px rgba(0,0,0,.3)}
  .bub.stop{background:#7f1d1d}.bub small{display:block;opacity:.75;margin-top:4px}
  .bub a.rc{display:block;margin-top:6px;font-size:12px;color:#c4b5fd;pointer-events:auto;text-decoration:underline;cursor:pointer}
  .ol{position:fixed;border:1.5px solid #0ea5e9;background:rgba(14,165,233,.08);display:none;border-radius:3px}
  .ol span{position:absolute;left:-1px;top:-15px;background:#0ea5e9;color:#fff;font:10px ui-monospace,Menlo,monospace;padding:1px 4px;border-radius:3px 3px 0 0}
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
    pointer = document.createElement("div"); pointer.className = "ptr";
    pointer.innerHTML = `<div class="fx"><div class="fy"><i class="rip"></i>
      <svg viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
      <path d="M4 3 L4 27 L10.2 21.4 L14.6 31.2 L19.2 29.1 L14.8 19.6 L23.2 19.2 Z" fill="url(#g)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="4" cy="3" r="3.6" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/></svg></div></div>`;
    layer.append(pointer);
    document.documentElement.append(host);
  }

  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  function clear() {
    build();
    follow = null; clearInterval(pollTimer);
    clearTimeout(arriveTimer); removeInk();
    pointer.className = "ptr"; pointer.style.display = "none";
    rings.forEach((r) => r.remove()); rings = [];
    bubble.style.display = "none";
  }

  function say(text, opts = {}) {
    // A refusal or a question means the cursor has nothing to point at: stop the thinking dance and hide it.
    if (opts.stop || opts.hidePointer) { clearTimeout(arriveTimer); pointer.className = "ptr"; pointer.style.display = "none"; }
    bubble.className = "bub" + (opts.stop ? " stop" : "");
    // DEV ONLY: the helper marks decisions that came from the local fake router; never let one read as a real 0G answer.
    bubble.textContent = last && last.decision && last.decision.testRouter ? text + " (test router)" : text;
    if (opts.sub) { const s = document.createElement("small"); s.textContent = opts.sub; bubble.append(s); }
    // The receipt is the product, so it is one click from the answer: opens the proof page for this request.
    if (opts.receipt) {
      const a = document.createElement("a"); a.className = "rc"; a.textContent = "How do I know? ↗";
      a.href = `http://127.0.0.1:7777/app/proof.html?id=${encodeURIComponent(opts.receipt)}`; a.target = "_blank"; a.rel = "noopener";
      bubble.append(a);
    }
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

  // The marker: a hand-drawn loop around small targets, an underline under wide ones (a loop around a full-width
  // text box looks wrong). Deterministic wobble so it does not jitter when the page scrolls.
  function inkPath(r) {
    const wide = r.w > 420 || r.h > 150;
    if (wide) {
      const y = r.y + r.h + 6, x0 = r.x + 4, x1 = r.x + r.w - 4, n = 14;
      let d = `M${x0} ${y}`;
      for (let i = 1; i <= n; i++) d += ` L${(x0 + (x1 - x0) * i / n).toFixed(1)} ${(y + Math.sin(i * 1.9) * 2.2).toFixed(1)}`;
      return d;
    }
    const pad = 9, cx = r.x + r.w / 2, cy = r.y + r.h / 2, rx = r.w / 2 + pad + 8, ry = r.h / 2 + pad, N = 28, over = 0.16;
    const pts = [];
    for (let i = 0; i <= Math.round(N * (1 + over)); i++) {
      const a = -Math.PI * 0.78 + (i / N) * Math.PI * 2, w = 1 + Math.sin(i * 1.7) * 0.022 + (i / N) * 0.035;
      pts.push([cx + Math.cos(a) * rx * w, cy + Math.sin(a) * ry * w]);
    }
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
    }
    return d;
  }
  function drawInk(r) {
    removeInk();
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "ink");
    const path = document.createElementNS(ns, "path"); path.setAttribute("d", inkPath(r)); svg.append(path);
    layer.append(svg); ink = { svg, path };
    const len = path.getTotalLength();
    // Draw it stroke by stroke, like a pen, unless the user prefers less motion.
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
      path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
      requestAnimationFrame(() => { path.style.transition = "stroke-dashoffset .6s ease-out"; path.style.strokeDashoffset = 0; });
    }
  }
  function removeInk() { if (ink) { ink.svg.remove(); ink = null; } }

  // A comet trail while the cursor glides: sample where the CSS transition has got to and leave a fading dot there.
  function trailFor(ms) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now(); let last = 0;
    const step = (now) => {
      if (now - t0 > ms || pointer.style.display !== "block") return;
      if (now - last > 26) {
        last = now;
        const m = new DOMMatrixReadOnly(getComputedStyle(pointer).transform);
        const d = document.createElement("i"); d.className = "trail";
        d.style.left = m.m41 + "px"; d.style.top = m.m42 + "px";
        layer.append(d); setTimeout(() => d.remove(), 600);
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // Scroll first, then read the rect, so the pointer lands where the element really is now,
  // not where the outline saw it before the page moved.
  async function point(el, text, receiptId) {
    build();
    // If the cursor was already dancing while 0G thought, glide from where it is instead of from off-screen.
    const wasThinking = pointer.classList.contains("think") && pointer.style.display === "block";
    if (wasThinking) { clearTimeout(arriveTimer); removeInk(); rings.forEach((x) => x.remove()); rings = []; } else clear();
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await raf2();
    const place = () => {
      const r = rectOf(el);
      pointer.style.transform = `translate(${r.x + r.w / 2}px,${r.y + r.h / 2}px)`;
      if (ink) ink.path.setAttribute("d", inkPath(r));
      if (bubble.style.display === "block") placeBubble(r);
    };
    if (!wasThinking) {
      pointer.style.transition = "none"; pointer.style.transform = `translate(${innerWidth / 2}px,${innerHeight + 40}px)`;
      pointer.style.display = "block";
      await raf2();
    }
    pointer.className = "ptr"; pointer.style.transition = "";
    place();
    trailFor(750);
    say(text, { near: rectOf(el), receipt: receiptId });
    follow = place; // keep tracking if the user scrolls or the layout shifts
    // On landing: ripple, loop the target with the marker, then bob gently while the user reads.
    arriveTimer = setTimeout(() => { pointer.classList.add("arrive", "bob"); drawInk(rectOf(el)); }, 650);
  }

  // A control inside an iframe. `entry` is the proxy outline.js put in the map ({frameWindow, childId, iframeEl, ...}).
  // The child scrolls it to its centre and reports where it is; after that the proxy is a normal-enough element for
  // point(). A child scrolling by itself cannot reach us, so while this pointer lives we re-ask (without scrolling).
  async function pointAtFrameElement(entry, text, receiptId) {
    build();
    const r = await NS.frames.locate(entry);
    if (!r) return say("The element is gone. Ask again.", { stop: true });
    await point(entry, text, receiptId);
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!follow || !entry.isConnected) return clearInterval(pollTimer);
      if (await NS.frames.locate(entry, { scroll: false })) follow();
    }, 500);
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
    // Put the bubble below BOTH candidates (their union), so it never covers one of the things being offered.
    const rs = els.map(rectOf), x0 = Math.min(...rs.map((r) => r.x)), y0 = Math.min(...rs.map((r) => r.y));
    const x1 = Math.max(...rs.map((r) => r.x + r.w)), y1 = Math.max(...rs.map((r) => r.y + r.h));
    say(text, { near: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }

  // Shows what Ishara sees on this page: a numbered box on every control the outline compiler kept. Anything the
  // user expects to be pointable but has no box is invisible to the tutor (iframes, canvas, closed shadow DOM).
  function showOutline(outline, map, extra = {}) {
    build(); clear();
    const boxes = outline.elements.map((e) => {
      const d = document.createElement("div"); d.className = "ol";
      const t = document.createElement("span"); t.textContent = e.id; d.append(t);
      layer.append(d); rings.push(d);
      return [d, map.get(e.id)];
    });
    follow = () => boxes.forEach(([d, el]) => {
      if (!el || !el.isConnected) { d.style.display = "none"; return; }
      const r = rectOf(el);
      Object.assign(d.style, { display: "block", left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" });
    });
    follow();
    say(`Ishara sees ${outline.elements.length} controls on this page` + (extra.dropped ? ` (${extra.dropped} more did not fit)` : "") + (extra.ms != null ? `, read in ${extra.ms.toFixed(0)} ms` : "") + `. Option+Shift+O hides this.`);
  }

  const tick = () => { if (follow) follow(); };
  addEventListener("scroll", tick, true);
  addEventListener("resize", tick);

  function thinking(text = "Thinking…") {
    build(); clear(); say(text);
    pointer.style.transition = "none"; pointer.style.transform = `translate(${innerWidth / 2}px,${Math.round(innerHeight * 0.55)}px)`;
    pointer.className = "ptr think"; pointer.style.display = "block";
  }

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
    if (last.decision && last.decision.testRouter) {
      const tb = el("div", "", "TEST ROUTER: not a real 0G answer");
      tb.style.cssText = "margin:10px 14px 0;padding:8px 12px;border-radius:8px;background:#f59e0b;color:#1c1100;font-weight:700;font-size:13px;letter-spacing:.02em";
    }
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

    // Spoken answers: a Mute/Unmute button (same flag as Option+Shift+M).
    if (NS._dbgHandlers.speech) {
      const mb = el("button", "", "Voice…", btns);
      const show = (r) => { mb.textContent = !r.data ? "Voice unavailable" : r.data.muted ? "Unmute voice" : r.data.ready ? "Mute voice" : "Voice off (" + (r.data.reason || "not ready") + ")"; };
      NS._dbgHandlers.speech(false).then(show);
      mb.onclick = () => NS._dbgHandlers.speech(true).then(() => NS._dbgHandlers.speech(false)).then(show);
    }

    // 4. End the session: encrypt the log, store it on 0G, record its root on the chain.
    el("div", "sec", "Save this session", panel);
    const btns2 = el("div", "btns");
    const end = el("button", "", "Save to 0G Storage", btns2);
    const res = el("div", "res", "", panel);
    end.onclick = async () => {
      res.textContent = "Collecting receipts, encrypting and uploading. This can take up to 40 s…";
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

  NS.overlay = { clear, say, point, pointAtFrameElement, ringBoth, thinking, openTypeBox, setDebug, toggleDebug, showOutline };
})();
