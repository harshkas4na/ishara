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
  .dbg{position:fixed;right:12px;top:12px;width:340px;max-height:80vh;overflow:auto;pointer-events:auto;display:none;
       background:#111827;color:#e5e7eb;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.45;box-shadow:0 6px 24px rgba(0,0,0,.4)}
  .dbg b{color:#fff}.dbg button{font:inherit;margin:4px 4px 0 0;padding:3px 8px;cursor:pointer}
  .dbg pre{white-space:pre-wrap;word-break:break-all;margin:4px 0;background:#1f2937;padding:6px;border-radius:6px}
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
  function renderDebug() {
    panel.textContent = "";
    const add = (tag, text, cls) => { const n = document.createElement(tag); n.textContent = text; panel.append(n); return n; };
    add("b", "Ishara debug (Alt+Shift+D to close)");
    if (!last) { add("div", "No question asked yet."); return; }
    const { decision: d, question, error, outlineMs } = last;
    add("div", "Question: " + (question || "-"));
    if (error) { add("div", "Error: " + error); }
    if (d) {
      add("div", `Outcome: ${d.outcome}${d.targetId ? " -> " + d.targetId : ""}${d.candidates ? " -> " + d.candidates.join(", ") : ""}`);
      add("div", "Reason: " + d.reason);
      if (d.safeStopCause) add("div", "Cause: " + d.safeStopCause);
      add("div", `ms: total ${d.ms?.total ?? "-"}, brain ${d.ms?.brain ?? "-"}, laya ${d.ms?.laya ?? "-"}`);
      if (outlineMs != null) add("div", `outline compile: ${outlineMs.toFixed(1)} ms`);
      for (const [who, id] of Object.entries(d.requestIds || {})) {
        if (!id) continue;
        add("div", `${who} request: ${id}`);
        const out = document.createElement("pre"); out.style.display = "none";
        const btn = add("button", "How do I know? (" + who + ")");
        btn.onclick = async () => {
          out.style.display = "block"; out.textContent = "Checking…";
          const r = await NS._dbgHandlers.proof(id);
          out.textContent = r.error ? "Error: " + r.error : Object.entries(r.data).map(([k, v]) => `${k}: ${v}`).join("\n");
        };
        panel.append(out);
      }
    }
    const end = add("button", "End session (encrypt + upload log)");
    const endOut = document.createElement("pre"); endOut.style.display = "none"; panel.append(endOut);
    end.onclick = async () => {
      endOut.style.display = "block"; endOut.textContent = "Uploading…";
      const r = await NS._dbgHandlers.endSession();
      endOut.textContent = r.error ? "Error: " + r.error : JSON.stringify(r.data, null, 2);
    };
  }

  NS.overlay = { clear, say, point, ringBoth, thinking, openTypeBox, setDebug, toggleDebug };
})();
