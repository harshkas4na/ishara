// Page reader: turns the live DOM into the PageContext of docs/TUTOR-INTERFACE.md section 1. Classic script, loaded
// after outline.js (it reuses the outline's controls and ids) and before content.js. The decisions about WHAT may leave
// the tab (redaction, injection neutralizer, budget) live in blocks-core.js, which has no DOM and is unit-tested.
(() => {
  const NS = (globalThis.Ishara = globalThis.Ishara || {});
  const B = globalThis.IsharaBlocks;
  if (!B || !NS.compileOutline) return;

  // Never read text under these: code, form values (reported as state instead), our own UI.
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "TEXTAREA", "SELECT", "OPTION", "INPUT", "BUTTON", "HEAD"]);
  const BLOCK_SEL = "h1,h2,h3,h4,h5,h6,p,li,tr,pre,figcaption,caption,blockquote,dd,dt,summary";
  const FALLBACK_SEL = "div,section,article,main,aside,header,footer,nav,form,fieldset,body";
  const BOILER_SEL = "nav,footer,aside,[role=navigation],[role=contentinfo],[role=complementary],[role=banner]";
  const ERR_RE = /error|invalid|warning|alert|danger/i;
  const MAX_TEXT_NODES = 6000; // cap the scan so a huge page stays well under the time target
  const clean = B.clean;

  // ---- control state --------------------------------------------------------------------------------------------
  const fieldText = (el) => [el.getAttribute("name"), el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("title"),
    el.labels && [...el.labels].map((l) => l.textContent).join(" ")].filter(Boolean).join(" ");
  const secretField = (el) => B.isSecretField({ type: el.type, autocomplete: el.getAttribute("autocomplete"), text: fieldText(el) });
  const visibleText = (e) => {
    if (!e || (typeof e.checkVisibility === "function" && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) return "";
    return B.safeText(e.textContent, 200);
  };
  const byIds = (el, attr) => (el.getAttribute(attr) || "").split(/\s+/).filter(Boolean)
    .map((id) => (el.getRootNode().getElementById?.(id) || document.getElementById(id))).filter(Boolean);

  // The visible message tied to a control: aria-errormessage / aria-describedby first, then an error-looking sibling.
  function errorElFor(el) {
    for (const e of [...byIds(el, "aria-errormessage"), ...byIds(el, "aria-describedby")]) {
      if (visibleText(e) && (el.getAttribute("aria-invalid") === "true" || ERR_RE.test(e.className + " " + e.id) || e.getAttribute("role") === "alert")) return e;
    }
    let n = el;
    for (let up = 0; up < 3 && n && n.parentElement && n !== document.body; up++, n = n.parentElement) {
      for (let s = n.nextElementSibling, k = 0; s && k < 2; s = s.nextElementSibling, k++) {
        if ((ERR_RE.test(s.className + " " + s.id) || s.getAttribute("role") === "alert") && !s.querySelector("input,select,textarea") && visibleText(s)) return s;
      }
      if (up === 0 && n.parentElement) {
        const inner = n.parentElement.querySelector("[role=alert],[class*=error i],[class*=invalid i],[id*=error i]");
        if (inner && !inner.contains(el) && !inner.querySelector("input,select,textarea") && visibleText(inner)) return inner;
      }
    }
    return null;
  }

  function controlExtras(el) {
    if (!el || !el.tagName) return {};
    const tag = el.tagName.toLowerCase(), type = (el.type || "").toLowerCase();
    const st = {};
    if (el.disabled || el.getAttribute("aria-disabled") === "true") st.disabled = true;
    if (el.required || el.getAttribute("aria-required") === "true") st.required = true;
    if (type === "checkbox" || type === "radio") st.checked = !!el.checked;
    else if (/^(checkbox|switch|radio)$/.test(el.getAttribute("role") || "")) st.checked = el.getAttribute("aria-checked") === "true";
    else if (tag === "select") {
      const o = el.selectedOptions && el.selectedOptions[0];
      if (o) st.selectedOption = B.safeText(o.textContent, 80, { type: el.type, text: fieldText(el) });
    } else if (tag === "textarea" || (tag === "input" && !["button", "submit", "reset", "image", "file", "hidden"].includes(type)) || el.getAttribute("role") === "textbox") {
      // A secret field is never read for content; "empty" is the only thing we ask of it.
      const secret = secretField(el);
      const v = "value" in el ? el.value : el.textContent || "";
      st.empty = v.length === 0;
      if (!secret && v.length) {
        st.filledChars = v.length;
        const red = B.redact(v);
        if (v.length <= 40 && red === v && tag !== "textarea") st.value = B.safeText(v, 40);
        else if (red !== v) st.value = B.REDACTED;
      }
    }
    const errEl = errorElFor(el);
    const bad = el.getAttribute("aria-invalid") === "true" || !!errEl || (!!el.value && el.validity && !el.validity.valid);
    if (bad) st.invalid = true;
    const out = { state: st };
    if (errEl) { out.errorText = visibleText(errEl); out._errEl = errEl; }
    return out;
  }

  // Frame protocol helpers: what a child sends for one control, and how the parent retypes it (the child page is untrusted).
  NS.controlExtrasFor = (el) => {
    if (!el || el.frame) return undefined;
    const x = controlExtras(el);
    return { state: x.state, errorText: x.errorText };
  };
  NS.sanitizeExtras = (x) => {
    if (!x || typeof x !== "object") return undefined;
    const o = {}, s = x.state && typeof x.state === "object" ? x.state : {}, st = {};
    for (const k of ["checked", "disabled", "empty", "required", "invalid"]) if (typeof s[k] === "boolean") st[k] = s[k];
    if (Number.isFinite(s.filledChars)) st.filledChars = s.filledChars;
    for (const k of ["value", "selectedOption"]) if (typeof s[k] === "string") st[k] = B.safeText(s[k], 80);
    if (Object.keys(st).length) o.state = st;
    if (typeof x.errorText === "string") o.errorText = B.safeText(x.errorText, 200);
    return o;
  };

  // ---- text records from the DOM --------------------------------------------------------------------------------
  const errorEls = new Set();
  const isErrorish = (container) => {
    let n = container;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++, n = n.parentElement) {
      if (errorEls.has(n) || n.getAttribute("role") === "alert") return true;
      const cls = (n.className && n.className.baseVal === undefined ? n.className : "") + " " + n.id;
      if (ERR_RE.test(cls) && !n.querySelector("input,select,textarea,h1,h2,h3,table")) return true;
    }
    return false;
  };

  function collectLocal(controlEls) {
    errorEls.clear();
    for (const e of controlEls) { const x = controlExtras(e); if (x._errEl) errorEls.add(x._errEl); }
    const records = [];
    const visCache = new Map(); // element -> boolean (checkVisibility); hidden subtrees are cheap to skip repeatedly
    const boxCache = new Map(); // container -> { rect, inView } or null when invisible
    let nodes = 0, capped = false;
    const vis = (el) => {
      let v = visCache.get(el);
      if (v === undefined) {
        v = typeof el.checkVisibility !== "function" || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        visCache.set(el, v);
      }
      return v;
    };
    const box = (c) => {
      if (boxCache.has(c)) return boxCache.get(c);
      const r = c.getBoundingClientRect();
      let res = null;
      if (r.width >= 2 && r.height >= 2) {
        res = {
          rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
          inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
          boiler: !!c.closest(BOILER_SEL),
          errorish: isErrorish(c),
        };
      }
      boxCache.set(c, res);
      return res;
    };
    const walkRoot = (root, depth) => {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
          if (SKIP_TAGS.has(n.tagName.toUpperCase()) || n.hidden || n.getAttribute("aria-hidden") === "true" || n.hasAttribute("data-ishara-root") || n.hasAttribute("inert")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        },
      });
      const shadows = [];
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (++nodes > MAX_TEXT_NODES) { capped = true; break; }
        const t = n.nodeValue;
        if (!t || !/\S/.test(t)) continue;
        const p = n.parentElement;
        if (!p || !vis(p)) continue;
        if (p.closest("button,[role=button],[role=tab],[role=menuitem],[contenteditable=true],[aria-hidden=true],[hidden]")) continue;
        // A label that belongs to a control is already the control's label in the outline: reading it again as page text
        // only glues "Email Password Recovery phrase ..." into one useless block.
        const lab = p.closest("label");
        if (lab && lab.control) continue;
        const c = p.closest(BLOCK_SEL) || p.closest(FALLBACK_SEL) || p;
        if (c !== p && !vis(c)) continue;
        const b = box(c);
        if (!b) continue;
        records.push({ key: c, tag: c.tagName.toLowerCase(), cell: c.tagName === "TR" ? p.closest("td,th") : null, text: t, rect: b.rect, inView: b.inView, boiler: b.boiler, errorish: b.errorish });
      }
      // Open shadow roots, after the light DOM (their position in reading order is approximate).
      if (depth < 3) for (const h of root.querySelectorAll ? root.querySelectorAll("*") : []) if (h.shadowRoot && !h.hasAttribute("data-ishara-root")) shadows.push(h.shadowRoot);
      for (const s of shadows) walkRoot(s, depth + 1);
    };
    walkRoot(document.body || document.documentElement, 0);
    return { records, capped };
  }

  // This document's blocks (no ids yet), frames excluded.
  function localBlocks(controlEls, controlLabels) {
    const { records } = collectLocal(controlEls);
    return B.buildBlocks(records, { controlLabels });
  }

  // ---- frames ---------------------------------------------------------------------------------------------------
  const I = () => NS.internals;
  const num = (v) => (Number.isFinite(v) ? v : 0);

  // Blocks of this document plus its visible child frames, rects expressed in THIS viewport. Used by the top frame and,
  // for the "blocks?" request, by every child (so nested frames work the same way).
  async function blocksAsync(controlEls, controlLabels, ms) {
    const mine = localBlocks(controlEls, controlLabels);
    const all = [...mine];
    const x = I();
    if (!x) return all;
    const frames = [...x.iframesOf()].filter((f) => {
      if (f.closest("[data-ishara-root]")) return false;
      const r = f.getBoundingClientRect();
      return x.isVisible(f, r) && r.width >= 20 && r.height >= 20;
    }).slice(0, 8);
    const replies = await Promise.all(frames.map((f) => x.call(f.contentWindow, { ishara: "blocks?" }, ms)));
    frames.forEach((f, i) => {
      const rep = replies[i];
      if (!rep || !Array.isArray(rep.blocks) || !rep.size) return;
      const bx = x.frameBox(f), size = { w: num(rep.size.w), h: num(rep.size.h) };
      for (const raw of rep.blocks.slice(0, 200)) {
        const b = B.sanitizeForeign(raw);
        if (!b || !raw.rect) continue;
        const c = { x: num(raw.rect.x), y: num(raw.rect.y), w: num(raw.rect.w), h: num(raw.rect.h) };
        const left = bx.x + c.x * bx.k, top = bx.y + c.y * bx.k, w = c.w * bx.k, h = c.h * bx.k;
        const inChild = c.x + c.w > 0 && c.y + c.h > 0 && c.x < size.w && c.y < size.h;
        b.rect = { x: Math.round(left), y: Math.round(top), w: Math.round(w), h: Math.round(h) };
        b.inView = inChild && !!raw.inView && top + h > 0 && top < innerHeight && left + w > 0 && left < innerWidth;
        all.push(b); // frame content is appended after the page's own (order within a frame is kept)
      }
    });
    return all;
  }

  // Child side of the frame protocol (outline.js forwards the "blocks?" message here).
  NS.blocksForFrame = async () => {
    const c = NS.compileOutline();
    const els = [...c.map.values()].filter((e) => e && !e.frame);
    const raw = await blocksAsync(els, c.outline.elements.map((e) => e.label), 150);
    return { size: { w: innerWidth, h: innerHeight }, blocks: B.trim(raw, 1500).blocks.map((b) => ({ kind: b.kind, text: b.text, inView: b.inView, rect: b.rect, boiler: b.boiler })) };
  };

  // ---- assembling the PageContext -------------------------------------------------------------------------------
  function activeControlId(map) {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    if (!a || a === document.body) return undefined;
    for (const [id, el] of map) if (el === a) return id;
    return undefined;
  }

  function selectionText() {
    const a = document.activeElement;
    // A selection inside a secret box must not travel: read it only when the focused field is not secret.
    if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && secretField(a)) return "";
    return B.safeText(String(getSelection() || ""), 400);
  }

  function assemble(c, rawBlocks, budgetTokens, t0) {
    const { outline, map } = c;
    const meta = c.meta || new Map();
    const trimmed = B.trim(rawBlocks, budgetTokens);
    const blocks = B.number(trimmed.blocks);
    const controls = outline.elements.map((e) => {
      const el = map.get(e.id);
      let x;
      if (el && el.frame) x = meta.get(e.id) || {}; // computed by the owning frame, redacted there
      else { x = controlExtras(el); delete x._errEl; }
      const o = { ...e };
      if (x.state && Object.keys(x.state).length) o.state = x.state;
      if (x.errorText) o.errorText = x.errorText;
      return o;
    });
    const ctx = {
      source: "browser", url: location.href, title: B.safeText(document.title, 160),
      viewport: { w: innerWidth, h: innerHeight },
      blocks, controls,
      errors: blocks.filter((b) => b.kind === "error").map((b) => b.id),
    };
    const sel = selectionText(); if (sel) ctx.selection = sel;
    const f = activeControlId(map); if (f) ctx.focused = f;
    if (trimmed.dropped || c.dropped) ctx.truncated = { blocks: trimmed.dropped, controls: c.dropped || 0 };
    const meta2 = { ms: Math.round(performance.now() - t0), tokens: B.contextTokens(ctx), blockTokens: ctx.blocks.reduce((n, b) => n + B.blockTokens(b), 0), errors: ctx.errors.length };
    NS.lastPageContext = { context: ctx, meta: meta2 };
    return ctx;
  }

  // Sync: this document only (no frames). Same ids "b0".. as compileOutline, because it calls it.
  NS.compilePageContext = ({ budgetTokens = 3000 } = {}) => {
    const t0 = performance.now();
    const c = NS.compileOutline();
    const els = [...c.map.values()].filter((e) => e && !e.frame);
    return assemble(c, localBlocks(els, c.outline.elements.map((e) => e.label)), budgetTokens, t0);
  };

  // Async: with child frames. `outline` may be a compileOutlineAsync() result the caller already has (the inspector
  // passes its own so the page is compiled once and the ids it shows are the ids in the context).
  NS.compilePageContextAsync = async ({ budgetTokens = 3000, outline } = {}) => {
    const t0 = performance.now();
    const c = outline || (await NS.compileOutlineAsync());
    const els = [...c.map.values()].filter((e) => e && !e.frame);
    const raw = await blocksAsync(els, c.outline.elements.map((e) => e.label), 150);
    return assemble(c, raw, budgetTokens, t0);
  };

  NS.pageContextSummary = (ctx = NS.lastPageContext && NS.lastPageContext.context) => {
    const m = NS.lastPageContext && NS.lastPageContext.meta;
    if (!ctx || !m) return "";
    return `${ctx.blocks.length} text blocks, ${ctx.controls.length} controls, ${ctx.errors.length} errors, ~${m.tokens} tokens`;
  };

  // Dev-only: on the local test pages, leave the last context in a data attribute so a browser test can read it (the
  // content script's isolated world is invisible to the page). Never on real sites: a page must not be able to read it.
  NS.publishContext = () => {
    try {
      if (!location.href.startsWith("http://127.0.0.1:7777/test/") || !NS.lastPageContext) return;
      const o = { context: { ...NS.lastPageContext.context }, meta: { ...NS.lastPageContext.meta, at: Date.now() } };
      let s = JSON.stringify(o);
      while (s.length > 200000 && o.context.blocks.length) { o.context.blocks = o.context.blocks.slice(0, Math.floor(o.context.blocks.length * 0.8)); o.meta.cut = true; s = JSON.stringify(o); }
      document.documentElement.dataset.isharaContext = s;
    } catch { /* dev aid only */ }
  };
})();
