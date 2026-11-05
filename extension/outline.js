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

  function compile() {
    const t0 = performance.now();
    const seen = new Set();
    const counts = new Map();
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
      found.push({ el, rect, label, role, inView, order: found.length });
    }
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
        _type: f.el.tagName === "INPUT" ? (f.el.type || "text") : f.el.tagName === "TEXTAREA" ? "textarea" : "",
      });
      map.set(id, f.el);
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
      dropped: found.length - elements.length, // controls that did not fit the cap (shown by the inspector)
    };
  }

  NS.compileOutline = compile;
})();
