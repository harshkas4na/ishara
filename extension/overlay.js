// Overlay: pointer, marks, the pill, type box, debug panel. Everything lives in one shadow root
// so page CSS cannot restyle it and our CSS cannot leak. The drawing layer is
// pointer-events:none so the user can still click the thing we point at.
(() => {
  const NS = (globalThis.Ishara = globalThis.Ishara || {});
  let host, root, layer, pill, pointer, rings = [], follow = null, typeBox, panel, mark = null, arriveTimer = 0, pollTimer = 0;
  let convoPanel, dimMarks = [], classicOn = false; // conversation panel, dimmed marks of earlier pointers

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
  /* Marks (docs/UI-PILL.md). CONTROLS get a blue boundary drawn like a pen stroke; TEXT gets a translucent highlighter band
     per line. Both sit on the click-through layer, so the band stays translucent (it is drawn over the text, not behind it). */
  .mk{position:fixed;inset:0;pointer-events:none;transition:opacity .3s}
  .mk.dim{opacity:.3}
  .mk svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
  .mk rect.bd{fill:none;stroke:#3b82f6;stroke-width:2.5;stroke-linejoin:round;filter:drop-shadow(0 0 4px rgba(59,130,246,.6));
              stroke-dasharray:1;stroke-dashoffset:1;animation:draw .5s ease-out forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  .mk .hl{position:absolute;background:rgba(253,224,71,.35);border-radius:3px;transform-origin:left center;animation:hl .4s ease-out both}
  @keyframes hl{from{transform:scaleX(0)}to{transform:none}}
  @media (prefers-reduced-motion:reduce){.mk rect.bd{animation:none;stroke-dashoffset:0}.mk .hl{animation:none}}
  .ring{position:fixed;border:3px solid #d97706;border-radius:6px;box-shadow:0 0 0 3px rgba(255,255,255,.8);display:none}
  /* The pill: the only thing the tutor puts on screen besides the marks. Always dark, so it reads on light and dark pages.
     Click-through; only its buttons and the receipt link take the pointer. */
  .pill{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:none;align-items:center;gap:12px;width:max-content;
        max-width:min(520px,calc(100vw - 24px));padding:10px 14px;background:rgba(31,17,71,.92);color:#fff;border-radius:16px;
        font-size:15px;line-height:1.35;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none}
  .pill.top{bottom:auto;top:24px}
  .pill.stop{background:rgba(127,29,29,.95)}
  .pill .ind{flex:none;display:flex;align-items:center;justify-content:center;gap:3px;width:26px;height:22px}
  .pill .ind i{display:block;flex:none;width:4px;height:4px;border-radius:2px;background:#a78bfa;transform-origin:center}
  .pill .ind i:nth-child(n+2){display:none}
  .pill .ind i:first-child{width:9px;height:9px;border-radius:50%}
  .pill.s-preparing .ind i:first-child{width:12px;height:12px;background:#f59e0b;animation:pp 1s ease-in-out infinite}
  @keyframes pp{50%{opacity:.35;transform:scale(.7)}}
  .pill.s-listening .ind i{display:block;background:#60a5fa;width:4px;height:4px;border-radius:2px;transition:height .08s}
  .pill.s-thinking .ind i{display:block;width:6px;height:6px;border-radius:50%;animation:dn 1s ease-in-out infinite}
  .pill.s-thinking .ind i:nth-child(n+4){display:none}
  .pill.s-thinking .ind i:nth-child(2){animation-delay:.15s}.pill.s-thinking .ind i:nth-child(3){animation-delay:.3s}
  @keyframes dn{0%,100%{transform:translateY(0);opacity:.5}40%{transform:translateY(-5px);opacity:1}}
  .pill.s-speaking .ind i{display:block;width:3px;height:16px;border-radius:2px;background:#c4b5fd;animation:sw .8s ease-in-out infinite}
  .pill.s-speaking .ind i:nth-child(5){display:none}
  .pill.s-speaking .ind i:nth-child(2){animation-delay:.12s}.pill.s-speaking .ind i:nth-child(3){animation-delay:.24s}.pill.s-speaking .ind i:nth-child(4){animation-delay:.36s}
  @keyframes sw{0%,100%{transform:scaleY(.25)}50%{transform:scaleY(1)}}
  .pill.s-refused .ind i:first-child{background:#fca5a5}
  .pill.s-idle .ind i:first-child{background:#6d5bc0}
  .pill .pb{min-width:0;flex:1}
  .pill .pt{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere;white-space:pre-line}
  .pill .pt.fi{animation:fi .3s ease-out}
  @keyframes fi{from{opacity:.2;transform:translateY(3px)}to{opacity:1;transform:none}}
  .pill .ps{display:none;gap:8px;align-items:center;flex-wrap:wrap;margin-top:3px;font-size:12px;line-height:1.3;color:#cfc8ee}
  .pill .ps .mut{padding:1px 8px;border-radius:99px;background:rgba(255,255,255,.12)}
  .pill .ps .mut.nudge{background:rgba(245,158,11,.22);color:#fcd34d}
  .pill .ps .tr{padding:1px 8px;border-radius:99px;background:#f59e0b;color:#1c1100;font-weight:700}
  .pill .ps a.rc{pointer-events:auto;color:#c4b5fd;text-decoration:underline;cursor:pointer}
  .pill .pctl{flex:none;display:none;align-items:center;gap:6px}
  .pill .pctl .chip{font-size:12px;font-weight:700;padding:2px 9px;border-radius:99px;background:#f59e0b;color:#1c1100;white-space:nowrap}
  .pill .pctl button{pointer-events:auto;cursor:pointer;width:32px;height:32px;padding:0;border-radius:10px;border:1px solid #6d5bc0;background:#34226f;color:#fff;font:600 18px/1 system-ui,sans-serif}
  .pill .pctl button:hover:not(:disabled){background:#4a33a0}
  .pill .pctl button:disabled{opacity:.35;cursor:default}
  @media (prefers-reduced-motion:reduce){.pill .ind i{animation:none!important;transition:none}.pill .pt.fi{animation:none}}
  .cv{position:fixed;left:12px;bottom:12px;width:340px;max-height:62vh;overflow:auto;pointer-events:auto;display:none;
      background:#0f172a;color:#e2e8f0;border-radius:12px;font-size:13px;line-height:1.4;box-shadow:0 8px 30px rgba(0,0,0,.45)}
  .cv .hd{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:12px}
  .cv .hd b{color:#fff;font-size:13px}
  .cv .meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 14px 0;font-size:11.5px;color:#94a3b8}
  .cv .md{background:#1e3a8a;color:#bfdbfe;font-weight:600;padding:1px 8px;border-radius:99px}
  .cv .turn{padding:8px 14px;border-bottom:1px solid #1e293b}.cv .turn:last-child{border-bottom:0}
  .cv .who{font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#64748b}
  .cv .who.i{color:#a78bfa}.cv .tx{white-space:pre-wrap;overflow-wrap:anywhere;color:#e2e8f0}
  .cv .empty{padding:14px;color:#64748b}.cv a{color:#7dd3fc;cursor:pointer;text-decoration:underline}
  .cv .foot{padding:8px 14px 12px;border-top:1px solid #1e293b}
  .cv .tr{margin:8px 14px 0;padding:6px 10px;border-radius:8px;background:#f59e0b;color:#1c1100;font-weight:700;font-size:12px}
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
  .dbg .verdict.explain{background:#0b2545;border-color:#1d4ed8}.dbg .explain .tag{color:#60a5fa}
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
<div class="layer"></div><div class="tb"><input placeholder="Ask where something is, then Enter"><div>Esc to close</div></div><div class="dbg"></div><div class="pill"><span class="ind"><i></i><i></i><i></i><i></i><i></i></span><div class="pb"><div class="pt"></div><div class="ps"><span class="pc"></span><span class="pa"></span></div></div><div class="pctl"></div></div><div class="cv"></div>`;
    layer = root.querySelector(".layer");
    typeBox = root.querySelector(".tb");
    panel = root.querySelector(".dbg");
    pill = root.querySelector(".pill"); convoPanel = root.querySelector(".cv");
    pointer = document.createElement("div"); pointer.className = "ptr";
    pointer.innerHTML = `<div class="fx"><div class="fy"><i class="rip"></i>
      <svg viewBox="0 0 36 36" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs>
      <path d="M4 3 L4 27 L10.2 21.4 L14.6 31.2 L19.2 29.1 L14.8 19.6 L23.2 19.2 Z" fill="url(#g)" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="4" cy="3" r="3.6" fill="#f59e0b" stroke="#fff" stroke-width="1.5"/></svg></div></div>`;
    layer.append(pointer);
    document.documentElement.append(host);
  }

  const raf2 = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // clearStage: pointer, rings and marks. clear() (Esc, new voice question) also hides the pill. point() calls clearStage
  // only, so moving to a new target never wipes the sentence being read.
  function clear() { clearStage(); hidePill(); }
  function clearStage() {
    build();
    follow = null; clearInterval(pollTimer);
    clearTimeout(arriveTimer); removeMark(); dimMarks.forEach((d) => d.box.remove()); dimMarks = [];
    pointer.className = "ptr"; pointer.style.display = "none";
    rings.forEach((r) => r.remove()); rings = [];
    tut.rect = null;
  }

  // ---- The pill ----
  // One state at a time: preparing | listening | thinking | speaking | refused | info | idle. Every string reaches it through
  // textContent only (model output from an untrusted page).
  const P = { listen: null };
  const pillPart = (c) => pill.querySelector("." + c);
  const BAR_W = [0.5, 0.8, 1, 0.8, 0.5];
  function setPillState(state) {
    pill.className = pill.className.replace(/\bs-\w+/g, "").replace(/\s+/g, " ").trim() + " s-" + state;
    if (state !== "listening") pill.querySelectorAll(".ind i").forEach((i) => { i.style.height = ""; });
  }
  function setPillText(text) {
    const t = pillPart("pt"); t.textContent = text;
    t.classList.remove("fi"); void t.offsetWidth; t.classList.add("fi"); // restart the small fade for each new sentence
  }
  // keepCtl: the guide chip and buttons survive a state change inside the same walk.
  function showPill(state, text, o = {}) {
    build();
    clearTimeout(tut.linger);
    pill.classList.toggle("stop", !!o.stop);
    setPillState(state); setPillText(text);
    pillPart("pc").textContent = ""; pillPart("pa").textContent = ""; pillPart("ps").style.display = "none";
    if (!o.keepCtl) pillPart("pctl").style.display = "none";
    pill.style.display = "flex"; placePill();
  }
  function hidePill() {
    if (!pill) return;
    clearTimeout(tut.linger); clearTimeout(tut.pump); clearTimeout(tut.safety); clearTimeout(tut.safetyFb); tut.pump = 0;
    pill.style.display = "none"; pill.classList.remove("stop", "top");
    tut.rect = null; tut.active = false;
  }
  // The pill sits bottom-centre; if the pointed target is under it, it hops to the top edge.
  function placePill() {
    if (!pill || pill.style.display !== "flex") return;
    pill.classList.remove("top");
    const r = tut.rect; if (!r) return;
    const b = pill.getBoundingClientRect(), pad = 16;
    if (r.x < b.right + pad && r.x + r.w > b.left - pad && r.y < b.bottom + pad && r.y + r.h > b.top - pad) pill.classList.add("top");
  }
  function pillNote(text, cls) { // short chip on the pill's second line
    const n = document.createElement("span"); n.className = cls || "mut"; n.textContent = text; pillPart("pc").append(n);
    pillPart("ps").style.display = "flex"; placePill();
  }
  function pillLink(href, label) {
    const a = document.createElement("a"); a.className = "rc"; a.textContent = label; a.href = href; a.target = "_blank"; a.rel = "noopener";
    const pa = pillPart("pa"); pa.textContent = ""; pa.append(a); pillPart("ps").style.display = "flex"; placePill();
  }
  // Mic level, 0..10: five bars. Only drawn while the pill is listening.
  function setLevel(n) {
    if (!pill || !pill.classList.contains("s-listening")) return;
    const lvl = Math.max(0, Math.min(10, n)) / 10;
    pill.querySelectorAll(".ind i").forEach((i, k) => { i.style.height = Math.round(4 + lvl * 18 * BAR_W[k]) + "px"; });
  }
  // A listening agent (push-to-talk) calls this: "preparing" = recorder warming up, "listening" = the mic is live, null = done.
  function setListening(s) {
    build();
    if (!s) { P.listen = null; if (/\bs-(preparing|listening)\b/.test(pill.className)) hidePill(); return; }
    hidePill(); P.listen = s;
    showPill(s === "preparing" ? "preparing" : "listening", s === "preparing" ? "Getting ready…" : "Speak now");
    if (s === "listening") setLevel(0);
  }

  // Everything that is not a tutor sentence: chord messages, "Listening…", "Transcribing…", classic answers, errors.
  function say(text, opts = {}) {
    build(); // a chord can say something before any answer has built the overlay (Option+Shift+P / M)
    // A refusal or a question means the cursor has nothing to point at: stop the thinking dance and hide it.
    if (opts.stop || opts.hidePointer) { clearTimeout(arriveTimer); pointer.className = "ptr"; pointer.style.display = "none"; }
    // The older level feed sends "Listening… release to send\n▮▮▮▯▯…": turn it into the bars instead of text.
    if (/[▮▯]/.test(text)) {
      setLevel((text.match(/▮/g) || []).length);
      if (P.listen || (pill.style.display === "flex" && pill.classList.contains("s-listening"))) return;
      text = text.split("\n")[0];
    }
    if (P.listen && /^Listening/.test(text)) return; // the listening agent owns the pill while it is recording
    if (opts.near) tut.rect = opts.near;
    tut.active = false;
    const state = opts.stop ? "refused" : /^Listening/.test(text) ? "listening" : /^Transcribing/.test(text) ? "thinking" : "info";
    showPill(state, text, { stop: !!opts.stop });
    if (opts.sub) pillNote(opts.sub);
    // DEV ONLY: the helper marks decisions that came from the local fake router; never let one read as a real 0G answer.
    if (last && last.decision && last.decision.testRouter) pillNote("test router", "tr");
    // The receipt is the product, so it is one click from the answer: opens the proof page for this request.
    if (opts.receipt) pillLink(`http://127.0.0.1:7777/app/proof.html?id=${encodeURIComponent(opts.receipt)}`, "How do I know? ↗");
    if (state === "info" || state === "refused") { clearTimeout(tut.linger); tut.linger = setTimeout(() => { if (!tut.active) hidePill(); }, state === "refused" ? 15000 : 12000); }
  }

  function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }

  // ---- Marks ----
  const CONTROL = 'input,select,textarea,button,a[href],summary,label,[role=button],[role=checkbox],[role=radio],[role=link],[role=tab],[role=menuitem],[role=switch],[role=combobox],[role=textbox],[role=option],[contenteditable=""],[contenteditable=true]';
  const isControlEl = (el) => { try { return typeof el.matches === "function" && el.matches(CONTROL); } catch { return false; } };
  // One rect per line of text: the Range over the element's text, merged by line (a line wrapped around inline elements
  // comes back as many fragments), with ~2 px of vertical padding. No text (an image, a frame proxy) falls back to the box.
  function lineRects(el) {
    let rects = [];
    try {
      if (typeof el.getBoundingClientRect === "function" && el.nodeType === 1) {
        const rg = document.createRange(); rg.selectNodeContents(el);
        rects = Array.from(rg.getClientRects()).filter((r) => r.width > 1 && r.height > 1);
      }
    } catch { rects = []; }
    if (!rects.length) { const r = rectOf(el); return r.w > 0 ? [{ x: r.x, y: r.y - 2, w: r.w, h: r.h + 4 }] : []; }
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rects) {
      const l = lines.find((q) => Math.abs((q.t + q.b) / 2 - (r.top + r.bottom) / 2) < Math.min(q.b - q.t, r.height) * 0.5 && r.left <= q.r + 6);
      if (l) { l.l = Math.min(l.l, r.left); l.r = Math.max(l.r, r.right); l.t = Math.min(l.t, r.top); l.b = Math.max(l.b, r.bottom); }
      else lines.push({ l: r.left, r: r.right, t: r.top, b: r.bottom });
    }
    return lines.slice(0, 30).map((q) => ({ x: q.l - 2, y: q.t - 2, w: q.r - q.l + 4, h: q.b - q.t + 4 }));
  }
  function makeMark(el, kind) {
    const k = kind || (isControlEl(el) ? "control" : "text");
    const box = document.createElement("div"); box.className = "mk";
    const m = { kind: k, el, box, nodes: [] };
    if (k === "control") {
      const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), rc = document.createElementNS(ns, "rect");
      rc.setAttribute("class", "bd"); rc.setAttribute("pathLength", "1"); svg.append(rc); box.append(svg); m.nodes = [rc];
    }
    layer.append(box); layoutMark(m);
    return m;
  }
  // Re-run on every scroll/resize so the mark stays on its element.
  function layoutMark(m) {
    if (m.kind === "control") {
      const r = rectOf(m.el), pad = 4, rc = m.nodes[0];
      rc.setAttribute("x", r.x - pad); rc.setAttribute("y", r.y - pad); rc.setAttribute("width", r.w + pad * 2); rc.setAttribute("height", r.h + pad * 2);
      rc.setAttribute("rx", 8); rc.setAttribute("ry", 8);
      return;
    }
    const rs = lineRects(m.el);
    while (m.nodes.length < rs.length) { const d = document.createElement("div"); d.className = "hl"; d.style.animationDelay = m.nodes.length * 0.12 + "s"; m.box.append(d); m.nodes.push(d); }
    while (m.nodes.length > rs.length) m.nodes.pop().remove();
    rs.forEach((r, i) => Object.assign(m.nodes[i].style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }));
  }
  function removeMark() { if (mark) { mark.box.remove(); mark = null; } }
  function dimMark() { if (mark) { mark.box.classList.add("dim"); dimMarks.push(mark); mark = null; } }

  // A comet trail while the cursor glides: sample where the CSS transition has got to and leave a fading dot there.
  function trailFor(ms) {
    if (reduced()) return;
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
  // opts (tutor): quiet = the caller owns the pill; keep = a second pointer in one answer (the first mark stays, dimmed);
  // glide = move on from the current target (next step) instead of flying in again; kind = "text" forces the highlighter.
  async function point(el, text, receiptId, opts = {}) {
    build();
    // If the cursor was already dancing while 0G thought, glide from where it is instead of from off-screen.
    const wasThinking = pointer.style.display === "block" && (pointer.classList.contains("think") || opts.keep || opts.glide);
    if (opts.keep) dimMark();
    if (wasThinking) { clearTimeout(arriveTimer); removeMark(); rings.forEach((x) => x.remove()); rings = []; } else clearStage();
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await raf2();
    const place = () => {
      const r = rectOf(el);
      pointer.style.transform = `translate(${r.x + r.w / 2}px,${r.y + r.h / 2}px)`;
      if (mark) layoutMark(mark);
      tut.rect = r; placePill(); // the pill hops away if it would cover the target
    };
    if (!wasThinking) {
      pointer.style.transition = "none"; pointer.style.transform = `translate(${innerWidth / 2}px,${innerHeight + 40}px)`;
      pointer.style.display = "block";
      await raf2();
    }
    pointer.className = "ptr"; pointer.style.transition = "";
    place();
    trailFor(750);
    if (!opts.quiet) say(text, { near: rectOf(el), receipt: receiptId });
    follow = place; // keep tracking if the user scrolls or the layout shifts
    // On landing: ripple, mark the target, then bob gently while the user reads.
    arriveTimer = setTimeout(() => { pointer.classList.add("arrive", "bob"); removeMark(); mark = makeMark(el, opts.kind); }, 650);
  }

  // A control inside an iframe. `entry` is the proxy outline.js put in the map ({frameWindow, childId, iframeEl, ...}).
  // The child scrolls it to its centre and reports where it is; after that the proxy is a normal-enough element for
  // point(). A child scrolling by itself cannot reach us, so while this pointer lives we re-ask (without scrolling).
  async function pointAtFrameElement(entry, text, receiptId, opts = {}) {
    build();
    const r = await NS.frames.locate(entry);
    if (!r) return say("The element is gone. Ask again.", { stop: true });
    await point(entry, text, receiptId, opts);
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
    say(`Ishara sees ${outline.elements.length} controls on this page` + (extra.dropped ? ` (${extra.dropped} more did not fit)` : "") + (extra.ms != null ? `, read in ${extra.ms.toFixed(0)} ms` : "") + (extra.reader ? `. Page reader: ${extra.reader}` : "") + `. Option+Shift+O hides this.`);
  }

  const tick = () => { if (follow) follow(); dimMarks.forEach((d) => { try { layoutMark(d); } catch { /* element gone */ } }); };
  addEventListener("scroll", tick, true);
  addEventListener("resize", tick);

  function thinking(text = "Thinking…") {
    build(); clear();
    showPill("thinking", text.replace(/\s*…thinking$/, "")); // the dots already say it is thinking
    pointer.style.transition = "none"; pointer.style.transform = `translate(${innerWidth / 2}px,${Math.round(innerHeight * 0.55)}px)`;
    pointer.className = "ptr think"; pointer.style.display = "block";
  }

  function openTypeBox(onSubmit) {
    build(); hidePill(); // the type box sits where the pill does
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
    const hd = el("div", "hd"); el("b", "", "Ishara", hd); el("span", "", (classicOn ? "CLASSIC MODE (pointing only)  " : "") + "Alt+Shift+D hides this", hd);
    if (!last) { el("div", "sec", "Nothing asked yet"); return; }
    if (last.decision && last.decision.testRouter) {
      const tb = el("div", "", "TEST ROUTER: not a real 0G answer");
      tb.style.cssText = "margin:10px 14px 0;padding:8px 12px;border-radius:8px;background:#f59e0b;color:#1c1100;font-weight:700;font-size:13px;letter-spacing:.02em";
    }
    const { decision: d, question, error, proposedLabel, targetLabel, outlineMs } = last;

    // 1. The verdict, in one look.
    const kind = error ? "err" : !d ? "err" : d.outcome === "point" ? "point" : d.outcome === "explain" ? "explain" : d.outcome === "safe_stop" ? "stop" : "ask";
    const tagText = { point: "POINTED", explain: "EXPLAINED", ask: "ASKED YOU", stop: "REFUSED TO GUESS", err: "PROBLEM" }[kind];
    const v = el("div", "verdict " + kind);
    el("div", "tag", tagText, v);
    el("div", "q", question ? "“" + question + "”" : "", v);
    if (error || !d) el("div", "a", error || "No answer came back.", v);
    else if (d.outcome === "point") el("div", "a", `Pointed at “${targetLabel || d.targetId}”. ${d.say}`, v);
    else if (d.outcome === "explain") el("div", "a", "Explained by 0GM-1.0, not independently checked. " + (d.say || ""), v);
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
    if (last.tutor) { // /tutor turn: what streamed, and what laya said about each pointer
      const t = last.tutor;
      row("ok", `0GM answered (${t.mode || "explain"}), ${t.sentences} sentence${t.sentences === 1 ? "" : "s"}`, "sealed model on 0G", secs(d.ms?.brain));
      if (!t.points.length) row("na", "No pointer requested", "explained by 0GM-1.0, not independently checked", "");
      for (const p of t.points) {
        const ok = p.status === "confirmed";
        row(ok ? "ok" : "no", ok ? `laya is ${Math.round((p.layaP ?? 0) * 100)}% sure about “${p.label}”` : p.status === "suppressed" ? "laya could not be reached, so no pointer" : `laya did not confirm “${p.label}”`, p.reason || "", "");
      }
      el("div", "total", "Total " + secs(d.ms?.total) + (t.firstSayMs != null ? ", first sentence " + secs(t.firstSayMs) : ""), panel);
      return tail();
    }
    if (d.proposedId) row("ok", `0GM proposed “${proposedLabel || d.proposedId}”`, "sealed model on 0G read the page", secs(d.ms?.brain));
    else if (d.safeStopCause) row("no", "0GM did not answer", "cause: " + d.safeStopCause, "");
    else row("no", "0GM found nothing that fits", "", secs(d.ms?.brain));
    if (d.layaP != null) {
      const sure = Math.round(d.layaP * 100);
      row(d.outcome === "point" ? "ok" : "no", `laya is ${sure}% sure it is right`, d.outcome === "point" ? "needed at least 40%" : "needed at least 40%, so I asked", secs(d.ms?.laya));
    } else row("na", "laya was not asked", d.proposedId ? "could not be reached" : "nothing to check", "");
    row(d.outcome === "point" ? "ok" : d.outcome === "safe_stop" ? "no" : "na", d.outcome === "point" ? "Pointer moved" : d.outcome === "safe_stop" ? "Stopped instead of guessing" : "Asked you instead of pointing", "", "");
    el("div", "total", "Total " + secs(d.ms?.total), panel);
    return tail();

    // 3. Receipts onwards, shared by the classic and the tutor verdicts (a hoisted function: it can sit after the return).
    function tail() {
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
  }

  // ---- Tutor: the pill, steps, conversation panel (events from /tutor, docs/TUTOR-INTERFACE.md, docs/UI-PILL.md) ----
  // Every string here came from a model reading an untrusted page, so it only ever goes in through textContent.
  const WHY = { // same wording the classic refusal uses
    unavailable: "0G's private model is not reachable right now.",
    timeout: "0G took too long to answer.",
    offline: "There is no connection to 0G.",
  };
  const CHIP = {
    rejected: "not sure which control, so I won't point",
    suppressed: "I can explain it, but I can't confirm which control",
  };
  const FALLBACK_AFTER = 1000, MIN_SHOW = 1500; // no `speaking` event within 1 s of the first `say`: show each sentence >= 1.5 s
  // rect: where the pointed target is now (null = none), so the pill can hop to the top edge.
  // active: a turn is in progress on THIS tab. Events (say, speaking) are ignored without one, so a pill can never show
  // someone else's stream: the relay port is per tab and per turn, and this is the second guard.
  const tut = { rect: null, mode: null, guide: false, walkActive: false, step: null, sentences: [], seqText: new Map(), shown: -1, shownAt: 0,
    speakingSeen: false, speakingIdle: false, fallback: false, doneFlag: false, pump: 0, linger: 0, safety: 0, busy: false, active: false,
    chips: new Set(), pointed: 0, pointedThisStep: false, points: [], pq: Promise.resolve(), lastPointAt: 0, t0: 0, firstSayMs: null,
    entry: null, handlers: {}, resolveBlock: null };
  const convo = []; // last 10 turns, text only, this tab's memory only; cleared on navigation
  let convoPath = location.pathname, convoShown = false, cvIds = null;

  const node = (tag, cls, text, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; };
  const hideAnswer = hidePill;

  const isWalkWord = (q) => /^\s*(ok(ay)?[, ]+)?(next( step)?|back|previous|go back|repeat|again|say that again|stop|done|finished|where am i|agla|aage|peeche|dobara|ruko)\s*[.!?]*\s*$/i.test(q);

  // A new turn. A walk command (next/back/repeat) leaves the step sentence and chip up until the new step arrives.
  function tutorBegin({ mode, question, voice } = {}) {
    build();
    const walkCmd = tut.walkActive && isWalkWord(question || "");
    const newTopic = !walkCmd && mode && mode !== "follow-up";
    if (newTopic && tut.walkActive) endWalk();
    if (!walkCmd) tut.step = null;
    tut.mode = mode || tut.mode; tut.guide = tut.mode === "guide" || tut.walkActive;
    clearTimeout(tut.pump); clearTimeout(tut.safety); clearTimeout(tut.safetyFb); tut.pump = 0;
    Object.assign(tut, { sentences: [], seqText: new Map(), shown: -1, shownAt: 0, speakingSeen: false, speakingIdle: false, fallback: false, doneFlag: false, active: true,
      pointed: 0, pointedThisStep: false, points: [], pq: Promise.resolve(), lastPointAt: 0, t0: performance.now(), firstSayMs: null });
    tut.chips.clear();
    // While thinking the pill shows what was heard, so a wrong voice transcript is visible before anything else.
    const heard = question ? (voice ? "I heard: “" + question + "”" : "You: " + question) : "Thinking…";
    const keep = walkCmd ? pillPart("pt").textContent : heard;
    showPill("thinking", keep, { keepCtl: walkCmd });
    if (walkCmd) setWalkUI(); else tut.rect = null;
    // Conversation record. A navigation to another path starts a fresh conversation (the helper does the same).
    if (convoPath !== location.pathname) { convo.length = 0; convoPath = location.pathname; }
    tut.entry = { q: question || "", a: "", mode: tut.mode, ids: null, ms: {}, testRouter: false, outcome: null };
    convo.push(tut.entry); while (convo.length > 10) convo.shift();
    placePill(); renderConvo();
  }

  // The sentence on the pill. Called when playback of it starts (`speaking`), or by the fallback timer when there is no voice.
  function showSentence(i) {
    tut.shown = i; tut.shownAt = Date.now();
    clearTimeout(tut.linger);
    setPillText(tut.sentences[i]); setPillState("speaking"); placePill();
  }
  // No voice (muted, off, or an older helper): walk the sentences ourselves, each on screen for at least 1.5 s.
  function pumpFallback() {
    if (!tut.active || !tut.fallback || tut.pump) return;
    const next = tut.shown + 1;
    if (next >= tut.sentences.length) return settle();
    const wait = MIN_SHOW - (Date.now() - tut.shownAt);
    if (tut.shown >= 0 && wait > 0) { tut.pump = setTimeout(() => { tut.pump = 0; pumpFallback(); }, wait); return; }
    showSentence(next);
    tut.pump = setTimeout(() => { tut.pump = 0; pumpFallback(); }, MIN_SHOW);
  }
  // The answer is over and the voice is quiet: the dot calms down and, outside a guide, the pill fades out after a while.
  function settle() {
    if (!tut.active || !tut.doneFlag) return;
    if (tut.fallback && (tut.shown + 1 < tut.sentences.length || tut.pump)) return;
    if (tut.speakingSeen && !tut.speakingIdle) return;
    if (!/\bs-(refused|info)\b/.test(pill.className)) setPillState("idle");
    clearTimeout(tut.linger);
    if (!tut.walkActive) tut.linger = setTimeout(() => { if (tut.active) hidePill(); }, 12000);
  }

  function tutorSay(seq, text) {
    if (!tut.active || typeof text !== "string" || !text) return;
    const first = tut.sentences.length === 0;
    tut.sentences.push(text); tut.seqText.set(seq, tut.sentences.length - 1);
    if (first) { tut.firstSayMs = Math.round(performance.now() - tut.t0); if (pointer.classList.contains("think")) { pointer.className = "ptr"; pointer.style.display = "none"; } }
    tut.entry && (tut.entry.a = tut.sentences.join(" "));
    renderConvo();
    if (first) { // the first sentence shows at once; the voice (or the fallback) takes over from the second
      showSentence(0);
      tut.safetyFb = setTimeout(() => { if (tut.active && !tut.speakingSeen) { tut.fallback = true; pumpFallback(); } }, FALLBACK_AFTER);
    } else if (tut.fallback) pumpFallback();
  }

  // The helper STARTED playing sentence `seq` (karaoke). seq null = the voice has gone quiet.
  function tutorSpeaking(ev) {
    if (!tut.active || !ev) return;
    if (ev.seq == null) { tut.speakingIdle = true; return settle(); }
    const i = tut.seqText.get(ev.seq);
    if (i === undefined) return; // not a sentence of this turn on this tab: never show it
    tut.speakingSeen = true; tut.fallback = false; clearTimeout(tut.pump); tut.pump = 0; clearTimeout(tut.safetyFb);
    showSentence(i);
  }

  // A pointer after the laya check. Only `confirmed` moves anything.
  function tutorPoint(ev, el) {
    const label = ev.label || ev.targetId;
    tut.points.push({ status: ev.status, layaP: ev.layaP, reason: ev.reason, targetId: ev.targetId, label });
    if (ev.status !== "confirmed") { tutorChip(CHIP[ev.status] || CHIP.rejected); return Promise.resolve(); } // no mark at all
    if (!el) { if (ev.kind !== "block") tutorChip("that control moved, so I won't point"); return Promise.resolve(); } // an unresolvable block: text only, no mark
    const second = tut.pointed > 0 && !tut.guide;
    tut.pointed++; tut.pointedThisStep = true;
    const kind = el.frame ? "control" : ev.kind === "block" ? "text" : undefined; // undefined: decided from the element
    // Two pointers in one answer: the second waits until 1.5 s after the first, so both can be seen. The first stays, dimmed.
    tut.pq = tut.pq.then(async () => {
      if (second) { const wait = 1500 - (Date.now() - tut.lastPointAt); if (wait > 0) await new Promise((r) => setTimeout(r, wait)); }
      tut.lastPointAt = Date.now();
      if (el.frame) await pointAtFrameElement(el, "", null, { quiet: true, keep: second, glide: tut.guide, kind });
      else await point(el, "", null, { quiet: true, keep: second, glide: tut.guide, kind });
    }).catch(() => {});
    return tut.pq;
  }

  function tutorChip(text, cls) {
    if (!pill || tut.chips.has(text)) return;
    tut.chips.add(text);
    pillNote(text, "mut" + (cls ? " " + cls : ""));
  }

  // Step chip "2/6" and the buttons. Only the buttons take the pointer; the rest of the pill and the host stay click-through.
  function setWalkUI() {
    const ctl = pillPart("pctl"), { n, m } = tut.step || {};
    ctl.textContent = "";
    if (!n) { ctl.style.display = "none"; return; }
    ctl.style.display = "flex";
    node("span", "chip", `${n}/${m}`, ctl);
    const btn = (label, cmd, title) => {
      const b = node("button", "", label, ctl); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
      b.onmousedown = (e) => e.preventDefault(); // do not pull focus out of the page's own field
      b.onclick = () => { if (tut.handlers.walk) tut.handlers.walk(cmd); };
      return b;
    };
    btn("‹", "back", "Previous step (Option+Shift+Left)").disabled = n <= 1 || tut.busy;
    btn("›", "next", n >= m ? "Finish (Option+Shift+Right)" : "Next step (Option+Shift+Right)").disabled = tut.busy;
    btn("✕", "stop", "Stop the walkthrough (Option+Shift+Esc)");
    placePill();
  }
  // content.js: a stream is in flight, so Next/Back would race it (the helper starts the walk only when the stream ends).
  function setBusy(b) { tut.busy = !!b; if (tut.step) setWalkUI(); }

  function tutorStep(ev) {
    if (!tut.active || !ev || !ev.n) return;
    tut.walkActive = true; tut.guide = true; tut.step = { n: ev.n, m: ev.m || ev.n };
    if (!tut.sentences.length && typeof ev.say === "string" && ev.say) { tut.sentences.push(ev.say); showSentence(0); }
    // (chips are NOT cleared here: for a walk step the `point` event, and its chip, come BEFORE `step`; begin() clears them per turn)
    if (!tut.pointedThisStep) clearPointersOnly(); // this step has nothing to point at (or laya said no): do not leave the old mark up
    tut.pointedThisStep = false;
    setWalkUI(); placePill(); renderConvo();
  }

  // Hide pointer and marks but leave the pill.
  function clearPointersOnly() {
    follow = null; clearInterval(pollTimer); clearTimeout(arriveTimer); removeMark();
    dimMarks.forEach((d) => d.box.remove()); dimMarks = [];
    pointer.className = "ptr"; pointer.style.display = "none"; rings.forEach((r) => r.remove()); rings = [];
    tut.rect = null; tut.pointed = 0; placePill();
  }

  function endWalk() { tut.walkActive = false; tut.step = null; tut.guide = false; if (pill) pillPart("pctl").style.display = "none"; }

  function tutorNudge() { if (tut.walkActive && tut.active && pill.style.display === "flex") tutorChip("Done? Say next, or press ›", "nudge"); }

  function tutorDone(ev, question) {
    if (!tut.active) return;
    if (ev.outcome === "cutoff") tutorChip("(cut off, ask again)");
    if (ev.testRouter) pillNote("test router", "tr");
    // The model's plan is only in `done.plan` when no `step` event came (steps 2.. are held by the helper): still a walk.
    if (ev.mode === "guide" && Array.isArray(ev.plan) && ev.plan.length && !tut.step && ev.outcome !== "cutoff") {
      tut.walkActive = true; tut.guide = true; tut.step = { n: 1, m: ev.plan.length }; setWalkUI();
    }
    const ids = ev.requestIds || {};
    if (ids.brain) pillLink(`http://127.0.0.1:7777/app/proof.html?id=${encodeURIComponent(ids.brain)}`, "How do I know? ↗");
    if (tut.entry) Object.assign(tut.entry, { ids, ms: { ...(ev.ms || {}), firstSay: tut.firstSayMs }, testRouter: !!ev.testRouter, outcome: ev.outcome, mode: ev.mode || tut.entry.mode, a: tut.sentences.join(" ") });
    if (ev.mode && ev.mode !== "follow-up") tut.mode = ev.mode;
    tut.doneFlag = true;
    // The voice normally ends with `speaking {seq:null}`; if that never comes, do not wait for it forever.
    clearTimeout(tut.safety); tut.safety = setTimeout(() => { tut.speakingIdle = true; settle(); }, 45000);
    placePill(); renderConvo(); settle();
    // The debug panel (Option+Shift+D) is fed from the same events.
    const conf = tut.points.find((p) => p.status === "confirmed");
    const pts = tut.points;
    setDebug({
      question, tutor: { mode: ev.mode, points: pts, firstSayMs: tut.firstSayMs, sentences: tut.sentences.length },
      outlineMs: tut.outlineMs, targetLabel: conf && conf.label,
      decision: { outcome: conf ? "point" : "explain", targetId: conf && conf.targetId, layaP: (conf || pts[0] || {}).layaP, say: tut.sentences.join(" "),
        requestIds: ids, ms: { total: (ev.ms || {}).total, brain: (ev.ms || {}).firstToken }, testRouter: !!ev.testRouter },
    });
  }

  function tutorRefused(ev, question) {
    build();
    if (!tut.active) tutorBegin({ mode: "explain", question });
    clearPointersOnly(); endWalk();
    clearTimeout(tut.pump); tut.pump = 0; clearTimeout(tut.safetyFb);
    showPill("refused", "I can't answer right now. " + (WHY[ev.cause] || ""), { stop: true });
    tut.active = false; // nothing else may overwrite the refusal
    tut.linger = setTimeout(hidePill, 15000);
    if (tut.entry) { tut.entry.a = "(could not answer: " + (ev.cause || "unavailable") + ")"; tut.entry.outcome = "refused"; }
    renderConvo();
    setDebug({ question, decision: { outcome: "safe_stop", safeStopCause: ev.cause, requestIds: {}, ms: {} } });
  }

  // ---- conversation panel (Option+Shift+C): every sentence, since the pill only shows the one being spoken ----
  function renderConvo() {
    if (!convoPanel || !convoShown) return;
    convoPanel.textContent = "";
    const hd = node("div", "hd", null, convoPanel); node("b", "", "Conversation", hd); node("span", "", (classicOn ? "CLASSIC MODE  " : "") + "Alt+Shift+C hides this", hd);
    const last = convo[convo.length - 1];
    if (last && last.testRouter) node("div", "tr", "TEST ROUTER: not a real 0G answer", convoPanel);
    if (last) {
      const meta = node("div", "meta", null, convoPanel);
      if (last.mode) node("span", "md", last.mode, meta);
      const t = last.ms || {};
      const s = (ms) => (ms / 1000).toFixed(1) + " s";
      if (t.firstSay != null) node("span", "", "first sentence " + s(t.firstSay), meta);
      if (t.total != null) node("span", "", "total " + s(t.total), meta);
    }
    if (!convo.length) node("div", "empty", "Nothing asked yet on this page.", convoPanel);
    for (const c of convo) {
      const turn = node("div", "turn", null, convoPanel);
      node("div", "who", "You", turn); node("div", "tx", c.q, turn);
      node("div", "who i", "Ishara", turn); node("div", "tx", c.a || "…", turn);
    }
    const id = last && last.ids && last.ids.brain;
    if (id) {
      const foot = node("div", "foot", null, convoPanel);
      const a = node("a", "", "How do I know?", foot); a.href = `http://127.0.0.1:7777/app/proof.html?id=${encodeURIComponent(id)}`; a.target = "_blank"; a.rel = "noopener";
    }
    convoPanel.scrollTop = convoPanel.scrollHeight;
  }
  function toggleConvo() { build(); convoShown = !convoShown; convoPanel.style.display = convoShown ? "block" : "none"; renderConvo(); }

  const tutor = {
    begin: tutorBegin, say: tutorSay, speaking: tutorSpeaking, setBusy, point: tutorPoint, step: tutorStep, done: tutorDone, refused: tutorRefused, nudge: tutorNudge,
    toggleConvo, endWalk, isWalkWord, hide: hideAnswer, clearPointers: clearPointersOnly,
    setClassic: (v) => { classicOn = !!v; if (panel && panel.style.display === "block") renderDebug(); renderConvo(); },
    walkActive: () => tut.walkActive,
    setHandlers: (h) => Object.assign(tut.handlers, h),
    setOutlineMs: (ms) => { tut.outlineMs = ms; },
    // test hooks for test-pages/tutor-preview.html
    _pill: () => pill ? { state: (pill.className.match(/s-(\w+)/) || [])[1], text: pillPart("pt").textContent, top: pill.classList.contains("top"), visible: pill.style.display === "flex", chip: pillPart("pctl").style.display === "flex" ? pillPart("pctl").textContent : "" } : null,
    _state: () => ({ sentences: tut.sentences.slice(), points: tut.points.slice(), step: tut.step, walkActive: tut.walkActive, convo: convo.length }),
  };

  NS.overlay = { tutor, clear, say, point, pointAtFrameElement, ringBoth, thinking, openTypeBox, setDebug, toggleDebug, showOutline, setListening, setLevel };
})();
