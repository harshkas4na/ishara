// Outline compiler. Classic script (content scripts cannot be ES modules); shares the
// isolated-world global through globalThis.Ishara. Output format: docs/INTERFACES.md.
(() => {
  const NS = (globalThis.Ishara = globalThis.Ishara || {});

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]",
    "[role=menuitem]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[onclick]",
    "h1", "h2", "h3",
  ].join(",");

  // A cap keeps the prompt small on huge pages; the model only needs the relevant region.
  const MAX_ELEMENTS = 150;
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s) => (s.length > 80 ? s.slice(0, 79) + "…" : s);

  function roleOf(el) {
    const tag = el.tagName.toLowerCase();
    const aria = el.getAttribute("role");
    if (tag === "a") return "link";
    if (tag === "button" || aria === "button" || aria === "tab" || aria === "menuitem" || tag === "summary") return "button";
    if (tag === "select" || aria === "combobox") return "select";
    if (tag === "textarea") return "input";
    if (tag === "input") {
      const t = (el.type || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") return t;
      if (["button", "submit", "reset", "image"].includes(t)) return "button";
      return "input";
    }
    if (aria === "checkbox" || aria === "switch") return "checkbox";
    if (aria === "radio") return "radio";
    if (aria === "link") return "link";
    if (aria === "textbox") return "input";
    if (/^h[1-3]$/.test(tag)) return "text";
    return "button"; // [onclick] elements behave like buttons for the user
  }

  // Text of a <label> without the controls nested in it (a wrapping label would otherwise
  // swallow every <option> of its <select>).
  function labelText(label) {
    const c = label.cloneNode(true);
    c.querySelectorAll("select,textarea,input,option").forEach((n) => n.remove());
    return clean(c.textContent);
  }

  function labelOf(el) {
    const aria = clean(el.getAttribute("aria-label"));
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const root = el.getRootNode(); // inside a shadow root the ids live there, not in document
      const t = clean(by.split(/\s+/).map((id) => (root.getElementById?.(id) || document.getElementById(id))?.textContent || "").join(" "));
      if (t) return t;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") {
      // el.labels covers both for= and wrapping labels in one lookup.
      const l = el.labels && [...el.labels].map(labelText).join(" ").trim();
      if (l) return l;
      const t = (el.type || "").toLowerCase();
      if (["button", "submit", "reset"].includes(t) && el.value) return clean(el.value);
      if (el.placeholder) return clean(el.placeholder);
      if (el.title) return clean(el.title);
      return clean(el.name);
    }
    if (/^h[1-3]$/.test(tag)) return clean(el.textContent);
    return clean(el.innerText || el.textContent) || clean(el.getAttribute("title")) || clean(el.querySelector("img[alt]")?.alt);
  }

  function isVisible(el, rect) {
    if (rect.width < 2 || rect.height < 2) return false;
    if (typeof el.checkVisibility === "function" &&
        !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return true;
  }

  // Hit-test at the centre: an element covered by a modal or sticky header is not something
  // the user can click, so pointing at it would be wrong. Only possible inside the viewport;
  // below-the-fold elements are kept (we scroll to them) and cannot be tested.
  function notOccluded(el, rect) {
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return true;
    let hit = document.elementFromPoint(cx, cy);
    if (!hit) return true;
    // Our own panel or type box is not the page: what lies under it is still clickable once it closes.
    if (hit.closest("[data-ishara-root]")) return true;
    // Inside open shadow roots the hit is retargeted to the host; walk down to the real element.
    while (hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(cx, cy); if (!inner || inner === hit) break; hit = inner; }
    return el === hit || el.contains(hit) || hit.contains(el) ||
      (!!hit.closest("label") && el.labels && [...el.labels].includes(hit.closest("label")));
  }

  // The page's controls, then those inside open shadow roots (web components; closed roots cannot be read).
  function* candidates(root = document, depth = 0) {
    yield* root.querySelectorAll(SELECTOR);
    if (depth > 4) return;
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot && !host.hasAttribute("data-ishara-root")) yield* candidates(host.shadowRoot, depth + 1);
  }

  // How many candidates we are willing to test for visibility and occlusion (each costs an elementFromPoint).
  const SCAN_LIMIT = 800;
  // The same label over and over ("hide", "comments" on every row of a list) tells the model nothing new and
  // fills the cap. Keep a few copies of each.
  const MAX_SAME = 3;

  // Gather the controls of THIS document (not its frames) into `found`; `counts` collapses repeated labels
  // and is shared with the frame merge so repeats are collapsed across the whole page, not per frame.
  function scan(counts) {
    const seen = new Set();
    const found = [];
    let scanned = 0;
    for (const el of candidates()) {
      if (++scanned > SCAN_LIMIT) break;
      if (seen.has(el) || el.closest("[data-ishara-root]")) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect) || !notOccluded(el, rect)) continue;
      const label = clip(labelOf(el));
      const role = roleOf(el);
      const control = role === "input" || role === "select" || role === "checkbox";
      // Unlabelled elements give the model nothing to match on, except form controls.
      if (!label && !control) continue;
      const key = role + "|" + label.toLowerCase();
      const n = (counts.get(key) || 0) + 1; counts.set(key, n);
      if (n > (control ? MAX_SAME * 2 : MAX_SAME)) continue;
      const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      const _type = el.tagName === "INPUT" ? (el.type || "text") : el.tagName === "TEXTAREA" ? "textarea" : "";
      found.push({ el, rect, label, role, inView, _type, order: found.length });
    }
    return found;
  }

  // Cap, order and number `found` (page controls plus frame controls) into the outline the helper receives.
  function finish(found, t0) {
    // On a long page the cap must not cut off what the user is looking at: keep what is on screen first, then fill
    // from the rest of the page, then restore reading order so ids follow the page from top to bottom.
    let kept = found;
    if (found.length > MAX_ELEMENTS) {
      kept = [...found.filter((f) => f.inView), ...found.filter((f) => !f.inView)].slice(0, MAX_ELEMENTS).sort((a, b) => a.order - b.order);
    }
    const elements = [];
    const map = new Map();
    for (const f of kept) {
      const id = "b" + elements.length;
      elements.push({
        id, label: f.label, role: f.role,
        rect: { x: Math.round(f.rect.left), y: Math.round(f.rect.top), w: Math.round(f.rect.width), h: Math.round(f.rect.height) },
        _type: f._type,
      });
      // A frame control is stored as its proxy (see makeProxy), a page control as the element itself.
      map.set(id, f.entry || f.el);
    }
    // `(text)` suffix mirrors the interface example; headings and links don't need one.
    const text = elements.map((e) => {
      const suffix = e._type && (e.role === "input" || e.role === "checkbox") ? ` (${e._type})` : "";
      return `[${e.id}] ${e.role} "${e.label}"${suffix}`;
    }).join("\n");
    const types = new Map(elements.map((e) => [e.id, e._type]));
    const out = elements.map(({ _type, ...e }) => e);
    return {
      outline: { url: location.href, viewport: { w: innerWidth, h: innerHeight }, elements: out, text },
      map,
      types, // id -> input type; only the frame protocol needs it, to hand the parent the same "(type)" suffix
      ms: performance.now() - t0,
      dropped: found.length - elements.length, // controls that did not fit the cap (shown by the inspector)
    };
  }

  function compile() {
    const t0 = performance.now();
    return finish(scan(new Map()), t0);
  }

  // ---- iframes -------------------------------------------------------------------------------------------------
  // A content script runs in every frame (manifest all_frames). Cross-origin frames cannot be read from the parent,
  // so each frame compiles its OWN document and the parent asks over window.postMessage, which works across origins.
  // Trust model: everything a frame sends back is untrusted data. Requests go down by postMessage, but REPLIES come back
  // through the extension's service worker (chrome.runtime), which a page's own scripts cannot use: a reply posted on
  // the window could be forged by the child page itself (it sees the request id too), so an ad frame could offer fake
  // controls. The worker broadcasts the reply to the tab's frames; only the frame holding that random request id uses
  // it. Text is clipped and typed, then only ever shown or sent to the helper as a label, never executed. Known limit: postMessage is visible to the
  // pages involved, so a hostile PARENT page that embeds a victim frame could ask it for its control labels (never
  // field values). The fix would be to relay through the service worker; not done within this build.
  const pending = new Map(); // req -> { win, resolve }
  let lastMap = new Map();   // child side: the ids handed out in the most recent outline reply
  const ROLES = new Set(["button", "link", "input", "select", "checkbox", "radio", "text"]);
  const rid = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const num = (v) => (Number.isFinite(v) ? v : 0);

  function call(win, msg, ms) {
    return new Promise((resolve) => {
      const req = rid();
      const done = (r) => { clearTimeout(t); pending.delete(req); resolve(r); };
      const t = setTimeout(() => done(null), ms); // a frame that does not answer is skipped, never waited for
      pending.set(req, { win, resolve: done });
      try { win.postMessage({ ...msg, req }, "*"); } catch { done(null); }
    });
  }

  function* iframesOf(root = document, depth = 0) {
    yield* root.querySelectorAll("iframe");
    if (depth > 4) return;
    for (const host of root.querySelectorAll("*")) if (host.shadowRoot && !host.hasAttribute("data-ishara-root")) yield* iframesOf(host.shadowRoot, depth + 1);
  }
  // Replies from our own content script in a child frame, relayed by background.js ("frame-reply").
  const reply = (data) => { try { chrome.runtime.sendMessage({ type: "frame-reply", data }).catch(() => {}); } catch { /* extension reloaded */ } };
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== "frame-reply" || !m.data || typeof m.data.req !== "string") return;
    const p = pending.get(m.data.req);
    if (p) p.resolve(m.data);
  });
  const isChild = (win) => !!win && [...iframesOf()].some((f) => f.contentWindow === win);

  // Where the frame's own viewport sits in THIS viewport: origin, plus a scale for CSS-transformed frames.
  function frameBox(f) {
    const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
    const k = f.offsetWidth ? r.width / f.offsetWidth : 1;
    return {
      x: r.left + (f.clientLeft + (parseFloat(cs.paddingLeft) || 0)) * k,
      y: r.top + (f.clientTop + (parseFloat(cs.paddingTop) || 0)) * k,
      k,
    };
  }

  // Stand-in for an element that lives in another frame. It answers the few DOM calls overlay.js makes, so the
  // inspector, rings and pointer need no special case: the rect is the child's last known rect translated through
  // the iframe's CURRENT position, so it follows a scrolling parent for free.
  function makeProxy(iframeEl, childId, childRect, childSize) {
    const p = {
      frame: true, frameWindow: iframeEl.contentWindow, iframeEl, childId, childRect, childSize,
      get isConnected() { return iframeEl.isConnected; },
      getBoundingClientRect() {
        const b = frameBox(iframeEl), c = p.childRect;
        const left = b.x + c.x * b.k, top = b.y + c.y * b.k, width = c.w * b.k, height = c.h * b.k;
        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
      },
      scrollIntoView() {}, // done by locate(), which has to wait for the child
    };
    return p;
  }

  // Ask the owning frame to scroll the element to its centre and return where it is now; then, if the iframe itself
  // is off screen, scroll this document so it is visible. Returns the rect in this viewport, or null.
  async function locate(entry, opts = {}) {
    const scroll = opts.scroll !== false;
    const r = await call(entry.frameWindow, { ishara: "locate", id: entry.childId, scroll }, 500);
    if (!r || !r.rect) return null;
    entry.childRect = { x: num(r.rect.x), y: num(r.rect.y), w: num(r.rect.w), h: num(r.rect.h) };
    let b = entry.getBoundingClientRect();
    if (scroll) {
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cy < 0 || cy > innerHeight || cx < 0 || cx > innerWidth) {
        scrollBy({ top: cy < 0 || cy > innerHeight ? cy - innerHeight / 2 : 0, left: cx < 0 || cx > innerWidth ? cx - innerWidth / 2 : 0, behavior: "instant" });
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        b = entry.getBoundingClientRect();
      }
    }
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  }

  // Own document plus every visible iframe's controls, merged under the same cap and repeat-collapse.
  async function compileAsync(budget = 250) {
    const t0 = performance.now();
    const counts = new Map();
    const found = scan(counts);
    const frames = [...iframesOf()].filter((f) => {
      if (f.closest("[data-ishara-root]")) return false;
      const r = f.getBoundingClientRect();
      return isVisible(f, r) && r.width >= 20 && r.height >= 20 && notOccluded(f, r);
    }).slice(0, 8);
    const replies = await Promise.all(frames.map((f) => call(f.contentWindow, { ishara: "outline?", budget: Math.max(60, budget - 130) }, budget)));
    frames.forEach((f, i) => {
      const rep = replies[i];
      if (!rep || !Array.isArray(rep.elements) || !rep.size) return;
      const size = { w: num(rep.size.w), h: num(rep.size.h) };
      for (const c of rep.elements.slice(0, MAX_ELEMENTS)) {
        if (!c || !/^b\d{1,4}$/.test(c.id) || !c.rect) continue;
        const label = clip(clean(String(c.label ?? "")));
        const role = ROLES.has(c.role) ? c.role : "button";
        const cr = { x: num(c.rect.x), y: num(c.rect.y), w: num(c.rect.w), h: num(c.rect.h) };
        // Only what is inside the frame's own visible viewport: a child control scrolled out of the frame is not
        // something the user can see, and its translated rect would land on the parent page.
        if (cr.w < 2 || cr.h < 2 || cr.x + cr.w <= 0 || cr.y + cr.h <= 0 || cr.x >= size.w || cr.y >= size.h) continue;
        const control = role === "input" || role === "select" || role === "checkbox";
        if (!label && !control) continue;
        const key = role + "|" + label.toLowerCase();
        const n = (counts.get(key) || 0) + 1; counts.set(key, n);
        if (n > (control ? MAX_SAME * 2 : MAX_SAME)) continue;
        const entry = makeProxy(f, c.id, cr, size);
        const rect = entry.getBoundingClientRect();
        const inView = rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
        found.push({ entry, rect, label, role, inView, _type: String(c._type || "").slice(0, 20), order: found.length });
      }
    });
    return finish(found, t0);
  }

  // Every frame (not the top) answers its parent. A frame never answers anyone but its own parent.
  addEventListener("message", async (e) => {
    const d = e.data;
    if (!d || typeof d !== "object" || typeof d.ishara !== "string") return;
    if (window === window.top || e.source !== window.parent || typeof d.req !== "string") return;
    if (d.ishara === "outline?") {
      const c = await compileAsync(Number(d.budget) > 0 ? Math.min(Number(d.budget), 250) : 120);
      lastMap = c.map;
      reply({
        ishara: "outline", req: d.req, size: { w: innerWidth, h: innerHeight },
        elements: c.outline.elements.map((x) => ({ ...x, _type: c.types.get(x.id) || "" })),
      });
    } else if (d.ishara === "locate") {
      const entry = lastMap.get(d.id);
      let rect = null;
      if (entry && entry.isConnected) {
        if (entry.frame) rect = await locate(entry, { scroll: d.scroll !== false });
        else {
          if (d.scroll !== false) {
            entry.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
            await new Promise((res) => { requestAnimationFrame(() => requestAnimationFrame(res)); setTimeout(res, 120); });
          }
          const r = entry.getBoundingClientRect(); rect = { x: r.left, y: r.top, w: r.width, h: r.height };
        }
      }
      reply({ ishara: "located", req: d.req, rect });
    }
  });

  NS.compileOutline = compile;
  NS.compileOutlineAsync = compileAsync;
  NS.frames = { locate, isChild };
})();
