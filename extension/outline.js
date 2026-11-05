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
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" "));
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
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return true;
    return el === hit || el.contains(hit) || hit.contains(el) ||
      (!!hit.closest("label") && el.labels && [...el.labels].includes(hit.closest("label")));
  }

  function compile() {
    const t0 = performance.now();
    const elements = [];
    const map = new Map();
    const seen = new Set();
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (seen.has(el) || el.closest("[data-ishara-root]")) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect) || !notOccluded(el, rect)) continue;
      const label = clip(labelOf(el));
      const role = roleOf(el);
      // Unlabelled elements give the model nothing to match on, except form controls.
      if (!label && role !== "input" && role !== "select" && role !== "checkbox") continue;
      const id = "b" + elements.length;
      elements.push({
        id, label, role,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        _type: el.tagName === "INPUT" ? (el.type || "text") : el.tagName === "TEXTAREA" ? "textarea" : "",
      });
      map.set(id, el);
    }
    // `(text)` suffix mirrors the interface example; headings and links don't need one.
    const text = elements.map((e) => {
      const suffix = e._type && (e.role === "input" || e.role === "checkbox") ? ` (${e._type})` : "";
      return `[${e.id}] ${e.role} "${e.label}"${suffix}`;
    }).join("\n");
    const out = elements.map(({ _type, ...e }) => e);
    return {
      outline: { url: location.href, viewport: { w: innerWidth, h: innerHeight }, elements: out, text },
      map,
      ms: performance.now() - t0,
    };
  }

  NS.compileOutline = compile;
})();
