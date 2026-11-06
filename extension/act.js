// Agent mode, browser side (docs/AGENT-MODE.md): the EXECUTOR (one action on the current page, by outline id) and the TASK
// CONTROLLER (the loop that follows the helper's `POST /act` events, moves the cursor first, runs the action, reports back).
//
// Classic script, UMD-style like sse.js: the pure parts (isTask, validate, parseCombo, wording) are loaded by node tests; the
// DOM parts only touch `document` when called. The controller takes a `transport` so the preview page can drive every UI state
// from scripted events with no network (test-pages/act-preview.html).
//
// Principles that shape the code (see the contract): the user's task is the only authority; secrets are never typed; the cursor
// shows the target BEFORE the action; Esc stops at once; nothing leaves the laptop but the task, the PageContext and results.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  const NS = (root.Ishara = root.Ishara || {});
  NS.act = Object.assign(NS.act || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : self, function (root) {
  "use strict";

  // =====================================================================================================================
  // 1. Pure helpers (no DOM)
  // =====================================================================================================================

  // ---- isTask: is this typed/spoken request something to DO (go to /act) rather than something to ASK (go to /tutor)? ----
  // Order matters. A question word first ("where do I click to submit?" contains "click" and "submit" but asks for help), after
  // politeness is peeled off ("can you open youtube" is a task, "can I click here" is a question).
  const POLITE = /^(?:(?:hey|hi|ok|okay|so|ishara|buddy)[\s,]+)*(?:(?:please|kindly|just|now|then|and|also|next|after that)[\s,]+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like)\s+you\s+to\s+|you\s+(?:can|should|need\s+to)\s+|zara\s+|ab\s+)?(?:(?:please|kindly|just|now|then|and|also)[\s,]+)*/;
  const QUESTION = /^(?:what|what's|whats|where|where's|why|how|which|who|whom|whose|when|is|are|was|were|am|does|did|do|can|could|would|will|should|shall|may|might|has|have|kya|kaise|kaisa|kaisi|kahan|kahaan|kyun|kyon|kaun|kab|kitna|kitne|kitni|konsa|konsi)\b/;
  const VERB = new RegExp("^(?:" + [
    "open", "go to", "goto", "go back", "go forward", "navigate", "visit", "browse to", "click", "double click", "right click", "press", "tap", "hit",
    "fill", "fill in", "fill out", "type", "enter", "write in", "scroll", "copy", "paste", "play", "pause", "resume", "search", "look up", "select", "choose",
    "pick", "tick", "untick", "check", "uncheck", "toggle", "close", "reload", "refresh", "take a screenshot", "take screenshot", "screenshot", "capture",
    "submit", "send", "download", "mute", "unmute", "dismiss", "accept", "decline", "expand", "collapse", "log in", "login", "sign in", "switch to",
    "turn on", "turn off", "do this", "do that", "do it", "do the same", "start", "stop the video", "skip", "like", "subscribe", "add to cart", "scroll down", "scroll up",
  ].join("|") + ")\\b");
  // "check if it is right" and "enter into a discussion" are not UI tasks; "check the box" is.
  const NOT_TASK_AFTER = /^(?:check\s+(?:if|whether|that|why|how|what)\b|search\s+(?:engine|results\s+mean)\b)/;
  // Hinglish: the verb comes last ("youtube kholo", "form bharo", "yahan click karo", "band karo").
  const HINGLISH = /\b(?:kholo|khol\s+do|khol\s+dijiye|karo|kar\s+do|kijiye|kar\s+dijiye|bharo|bhar\s+do|likho|likh\s+do|chalao|chala\s+do|band\s+karo|band\s+kar\s+do|dabao|daba\s+do|chuno|utha\s+lo|badlo|hatao)\b/;

  function isTask(text) {
    let t = String(text == null ? "" : text).toLowerCase().replace(/[“”"`]/g, "").replace(/\s+/g, " ").trim();
    t = t.replace(/^[\s.,!¡¿]+/, "");
    if (!t || t.length > 600) return false;
    if (/^do (?:this|that|it|the same)\b/.test(t)) return true; // "do this" is the one "do" that is an order
    const stripped = t.replace(POLITE, "");
    if (QUESTION.test(stripped)) return false;
    if (HINGLISH.test(stripped)) return true;
    if (NOT_TASK_AFTER.test(stripped)) return false;
    return VERB.test(stripped);
  }

  // ---- Action validation (the helper validates too; this is the guard at the door of the executor) ----
  const ID_RE = /^[bt]\d{1,5}$/;
  const SIMPLE = new Set(["click", "type", "select", "check", "key", "scroll", "open_url", "search", "tab", "copy", "screenshot", "wait"]);
  const NOT_BROWSER = new Set(["open_app", "quit_app", "read_file"]); // read_file is the helper's, desktop only: a page never reads the disk
  // Same three engines and addresses as the helper's searchUrl (helper/src/act.ts). https only, the query URL-encoded.
  const ENGINES = { brave: "https://search.brave.com/search?q=", google: "https://www.google.com/search?q=", duckduckgo: "https://duckduckgo.com/?q=" };
  const TAB_OPS = ["switch", "close", "back", "forward", "new"];
  function searchUrl(query, engine) { return (ENGINES[engine || "brave"] || ENGINES.brave) + encodeURIComponent(String(query).replace(/\s+/g, " ").trim()); }
  const MAX_TEXT = 2000, MAX_COPY = 20000;

  // -> { ok: true, action } | { ok: false, detail }. `action` is a clean copy holding only the known fields.
  function validate(a) {
    if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, detail: "no action" };
    const t = a.type;
    if (NOT_BROWSER.has(t)) return { ok: false, detail: "that is a desktop action, not a browser one" };
    if (!SIMPLE.has(t)) return { ok: false, detail: "unknown action " + String(t).slice(0, 20) };
    const needId = () => (typeof a.id === "string" && ID_RE.test(a.id) ? null : "missing or bad element id");
    let e;
    switch (t) {
      case "click": if ((e = needId())) return { ok: false, detail: e }; return { ok: true, action: { type: t, id: a.id } };
      case "type":
        if ((e = needId())) return { ok: false, detail: e };
        if (typeof a.text !== "string" || a.text.length > MAX_TEXT) return { ok: false, detail: "text must be a string of at most " + MAX_TEXT + " characters" };
        return { ok: true, action: { type: t, id: a.id, text: a.text, clear: a.clear === true } };
      case "select":
        if ((e = needId())) return { ok: false, detail: e };
        if (typeof a.option !== "string" || !a.option.trim() || a.option.length > 200) return { ok: false, detail: "option must be the visible label" };
        return { ok: true, action: { type: t, id: a.id, option: a.option } };
      case "check":
        if ((e = needId())) return { ok: false, detail: e };
        if (typeof a.checked !== "boolean") return { ok: false, detail: "checked must be true or false" };
        return { ok: true, action: { type: t, id: a.id, checked: a.checked } };
      case "key": {
        if (typeof a.combo !== "string" || !a.combo.trim() || a.combo.length > 40) return { ok: false, detail: "combo must be a key like Enter or cmd+t" };
        if (!parseCombo(a.combo)) return { ok: false, detail: "unknown key " + a.combo.slice(0, 20) };
        return { ok: true, action: { type: t, combo: a.combo.trim() } };
      }
      case "scroll":
        if (a.direction !== "up" && a.direction !== "down") return { ok: false, detail: "direction must be up or down" };
        if (a.amount !== undefined && a.amount !== "line" && a.amount !== "page") return { ok: false, detail: "amount must be line or page" };
        return { ok: true, action: { type: t, direction: a.direction, amount: a.amount === "line" ? "line" : "page" } };
      case "open_url": {
        let u; try { u = new URL(String(a.url)); } catch { return { ok: false, detail: "not a URL" }; }
        if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, detail: "only http and https links can be opened" };
        // newTab is NOT in the frozen schema; honoured when present so "open it in a new tab" can be expressed.
        return { ok: true, action: { type: t, url: u.href, newTab: a.newTab === true || a.new_tab === true } };
      }
      case "search": {
        const q = typeof a.query === "string" ? a.query.replace(/\s+/g, " ").trim() : "";
        if (!q || q.length > 200 || /[\u0000-\u001f\u007f]/.test(q)) return { ok: false, detail: "query must be 1 to 200 characters of plain words" };
        if (a.engine !== undefined && !Object.prototype.hasOwnProperty.call(ENGINES, a.engine)) return { ok: false, detail: "engine must be brave, google or duckduckgo" };
        return { ok: true, action: { type: t, query: q, engine: a.engine || "brave" } };
      }
      case "tab": {
        if (!TAB_OPS.includes(a.op)) return { ok: false, detail: "op must be one of " + TAB_OPS.join(", ") };
        let match = typeof a.match === "string" ? a.match.replace(/\s+/g, " ").trim() : "";
        if (match.length > 100 || /[\u0000-\u001f\u007f]/.test(match)) return { ok: false, detail: "match must be a short piece of the tab title or address" };
        if (a.op === "switch" && !match) return { ok: false, detail: "switch needs a match: part of the tab title or address" };
        if (a.op !== "switch" && a.op !== "close") match = "";
        return { ok: true, action: { type: t, op: a.op, match } };
      }
      case "copy":
        if (typeof a.text !== "string" || !a.text || a.text.length > MAX_COPY) return { ok: false, detail: "text must be a non-empty string" };
        return { ok: true, action: { type: t, text: a.text } };
      case "screenshot":
        if (a.to !== undefined && a.to !== "clipboard" && a.to !== "file") return { ok: false, detail: "to must be clipboard or file" };
        return { ok: true, action: { type: t, to: a.to === "file" ? "file" : "clipboard" } };
      case "wait": {
        const ms = Number(a.ms);
        if (!Number.isFinite(ms) || ms < 0) return { ok: false, detail: "ms must be a number" };
        return { ok: true, action: { type: t, ms: Math.min(3000, Math.round(ms)) } };
      }
    }
    return { ok: false, detail: "unknown action" };
  }

  // ---- Key combos ----
  const KEY_NAMES = { enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", space: " ", spacebar: " ", tab: "Tab", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", backspace: "Backspace", delete: "Delete", del: "Delete", home: "Home", end: "End",
    pageup: "PageUp", pagedown: "PageDown" };
  const MOD_NAMES = { cmd: "meta", command: "meta", meta: "meta", super: "meta", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift" };
  // "cmd+shift+t" -> { mods: ["meta","shift"], key: "t" }; "Enter" -> { mods: [], key: "Enter" }; null when it is not a key.
  function parseCombo(raw) {
    const parts = String(raw).trim().split(/\s*\+\s*/).filter(Boolean);
    if (!parts.length) return null;
    const last = parts.pop(), mods = [];
    for (const p of parts) { const m = MOD_NAMES[p.toLowerCase()]; if (!m) return null; if (!mods.includes(m)) mods.push(m); }
    const lk = last.toLowerCase();
    let key;
    if (KEY_NAMES[lk]) key = KEY_NAMES[lk];
    else if (/^f([1-9]|1[0-2])$/.test(lk)) key = lk.toUpperCase();
    else if (last.length === 1) key = lk; // letters are lowercase here; dispatchKey capitalises when Shift is held
    else if (MOD_NAMES[lk] && !parts.length) return null; // a lone modifier is not a key press
    else return null;
    return { mods, key };
  }
  // KeyboardEvent.code for a key, so a page that reads `code` (games, players) sees something real.
  function codeFor(key) {
    if (/^[a-z]$/i.test(key)) return "Key" + key.toUpperCase();
    if (/^[0-9]$/.test(key)) return "Digit" + key;
    if (key === " ") return "Space";
    return key; // Enter, Escape, ArrowDown, F5 ... are their own codes
  }
  // Browser-level shortcuts cannot be synthesized in a page. Map the useful ones to what the service worker (or the page) can do.
  // Returns a command name or null. Meta and Ctrl are treated alike so "ctrl+t" works on any laptop.
  function browserShortcut(p) {
    const k = p.key.toLowerCase(), m = new Set(p.mods), accel = m.has("meta") || m.has("ctrl");
    if (accel && !m.has("alt")) {
      if (k === "t" && !m.has("shift")) return "new_tab";
      if (k === "w" && !m.has("shift")) return "close_tab";
      if (k === "r") return "reload";
      if (k === "[" || p.key === "ArrowLeft") return "back";
      if (k === "]" || p.key === "ArrowRight") return "forward";
      if (k === "a") return "select_all";
      if (k === "c") return "copy_selection";
      if (["l", "n", "q", "p", "s", "d", "f", "o", "j", "h", "y", "k", "e", "g", "v", "x", "z"].includes(k) || /^[0-9]$/.test(k)) return "unsupported";
    }
    if (m.has("alt") && (p.key === "ArrowLeft")) return "back";
    if (m.has("alt") && (p.key === "ArrowRight")) return "forward";
    if (p.key === "F5") return "reload";
    if (m.size && !m.has("shift")) return "unsupported"; // any other modifier combo is a browser/OS shortcut
    if (m.size) return m.has("meta") || m.has("ctrl") || m.has("alt") ? "unsupported" : null;
    return null;
  }

  // Words for the pill ("Press Submit?"), from an action and the label of its target. Page labels are shown with textContent only.
  function describe(a, label, o = {}) {
    const q = label ? "“" + String(label).slice(0, 48) + "”" : "that control";
    const host = (u) => { try { return new URL(u).host; } catch { return "a page"; } };
    const verbs = {
      click: () => (o.question ? "Press " + q + "?" : "Pressing " + q),
      type: () => (o.question ? "Type into " + q + "?" : "Typing into " + q),
      select: () => (o.question ? "Choose “" + String(a.option).slice(0, 40) + "” in " + q + "?" : "Choosing “" + String(a.option).slice(0, 40) + "” in " + q),
      check: () => (a.checked ? (o.question ? "Tick " + q + "?" : "Ticking " + q) : (o.question ? "Untick " + q + "?" : "Unticking " + q)),
      key: () => (o.question ? "Press " + a.combo + "?" : "Pressing " + a.combo),
      scroll: () => "Scrolling " + a.direction,
      open_url: () => (o.question ? "Open " + host(a.url) + "?" : "Opening " + host(a.url)),
      search: () => (o.question ? "Search the web for “" + String(a.query).slice(0, 40) + "”?" : "Searching for “" + String(a.query).slice(0, 40) + "”"),
      tab: () => {
        const m = String(a.match || "").slice(0, 30);
        const w = { switch: ["Switching to the tab “" + m + "”", "Switch to the tab “" + m + "”?"], close: a.match ? ["Closing the tab “" + m + "”", "Close the tab “" + m + "”?"] : ["Closing a tab", "Close a tab?"],
          back: ["Going back", "Go back?"], forward: ["Going forward", "Go forward?"], new: ["Opening a new tab", "Open a new tab?"] }[a.op] || ["Changing tabs", "Change tabs?"];
        return o.question ? w[1] : w[0];
      },
      copy: () => (o.question ? "Copy text to the clipboard?" : "Copying to the clipboard"),
      screenshot: () => (o.question ? "Take a screenshot?" : "Taking a screenshot"),
      wait: () => "Waiting",
    };
    return (verbs[a && a.type] || (() => "Working"))();
  }

  // Continuation text for a task that crosses a page load: the original words, plus what already happened (our own short step
  // names, never page text).
  function continuation(task, history) {
    if (!history || !history.length) return task;
    return task + "\n\n(Already done on earlier pages: " + history.slice(-10).join("; ") + ". Carry on from the page that is open now; do not repeat finished steps.)";
  }

  const pure = { isTask, validate, searchUrl, parseCombo, codeFor, browserShortcut, describe, continuation };
  if (typeof document === "undefined") return pure; // node: the DOM parts below are not needed

  // =====================================================================================================================
  // 2. Executor (DOM)
  // =====================================================================================================================
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf2 = () => new Promise((r) => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 120); }); // rAF stalls in a background tab
  const fail = (detail) => ({ ok: false, detail });
  const ok = (detail, extra) => ({ ok: true, detail, ...(extra || {}) });
  const visibleLabel = (el) => {
    const L = root.Ishara && root.Ishara.__labelOf;
    return L ? L(el) : String(el.getAttribute?.("aria-label") || el.innerText || el.value || el.name || el.tagName).replace(/\s+/g, " ").trim().slice(0, 40);
  };

  // Wait until the page stops changing (<= max ms): DOM quiet for `quiet` ms. A navigation ends the script, so it needs no case.
  function settle(max = 1200, quiet = 250) {
    return new Promise((resolve) => {
      let last = Date.now(), done = false;
      const mo = new MutationObserver(() => { last = Date.now(); });
      try { mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch { /* no document */ }
      const t0 = Date.now();
      const tick = () => {
        if (done) return;
        const now = Date.now();
        if (now - t0 >= max || (now - last >= quiet && now - t0 >= 150)) { done = true; mo.disconnect(); resolve(); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  // Topmost element at a point, looking into open shadow roots (a web component hides its inner button from elementFromPoint).
  function deepHit(x, y) {
    let hit = document.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    return hit;
  }

  function secretReason(el) {
    const B = root.IsharaBlocks;
    const labels = el.labels ? [...el.labels].map((l) => l.textContent).join(" ") : "";
    const text = [el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("placeholder"), el.getAttribute("data-testid"), el.title, labels].filter(Boolean).join(" ");
    const type = (el.type || "").toLowerCase();
    if (type === "password") return "password field";
    if (B && B.isSecretField({ type, autocomplete: el.getAttribute("autocomplete"), text })) return "secret field";
    // Extra names the shared rule does not carry: a bare "key", card numbers, wallet seeds written differently.
    if (/\b(?:private|secret|api|license|access|recovery)[\s_-]*key\b|\bkey\b[\s_-]*(?:phrase|file)|\bcard\b|\bcredit\b|\bseed\b|\bpasswd\b|\bsecret\b/i.test(text)) return "secret field";
    return null;
  }

  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, "value");
    d.set.call(el, value); // the prototype's setter, not the element's own: a framework that wrapped `value` on the instance must see a real change
  }
  const fire = (el, type, init) => el.dispatchEvent(init && init.__input ? new InputEvent(type, init.__input) : new Event(type, { bubbles: true, cancelable: false, ...(init || {}) }));

  async function doClick(el, env) {
    if (el.frame) return fail("that control is inside a frame, which I cannot operate");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return fail("the control is disabled");
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await raf2();
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return fail("the control is not visible");
    const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
    const hit = deepHit(cx, cy);
    const mine = hit && (hit === el || el.contains(hit) || hit.contains(el) || (hit.closest("label") && el.labels && [...el.labels].includes(hit.closest("label"))));
    if (!mine) return fail("something covers the control: " + (hit ? visibleLabel(hit) || hit.tagName.toLowerCase() : "nothing there"));
    // A link that opens a new tab would be blocked as a pop-up (no user gesture) and would also leave the task behind: go in this tab.
    const a = el.closest && el.closest("a[href]");
    if (a && /^_blank$/i.test(a.target || "") && /^https?:/i.test(a.href)) return env.openUrl(a.href, false);
    const t = el.contains(hit) ? hit : el;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: cx, clientY: cy, screenX: cx, screenY: cy, button: 0 };
    const ptr = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    try {
      t.dispatchEvent(new PointerEvent("pointerdown", { ...ptr, buttons: 1 }));
      t.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1, detail: 1 }));
      if (el.focus) el.focus({ preventScroll: true });
      t.dispatchEvent(new PointerEvent("pointerup", { ...ptr, buttons: 0 }));
      t.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0, detail: 1 }));
      const proceeded = t.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0, detail: 1 }));
      // A link the page did not intercept is a real navigation: the caller waits for the unload instead of settling.
      const href = a && a.href && /^https?:/i.test(a.href) && a.href.split("#")[0] !== location.href.split("#")[0];
      return ok("clicked " + (visibleLabel(el) || el.tagName.toLowerCase()), { navigating: !!(proceeded && href) });
    } catch (e) {
      try { el.click(); return ok("clicked " + (visibleLabel(el) || el.tagName.toLowerCase())); } catch (e2) { return fail("click failed: " + (e2 && e2.message)); }
    }
  }

  function doType(el, text, clear) {
    if (el.frame) return fail("that field is inside a frame, which I cannot operate");
    const tag = el.tagName, editable = el.isContentEditable;
    const isField = (tag === "INPUT" && !/^(checkbox|radio|button|submit|reset|image|file|range|color|hidden)$/i.test(el.type)) || tag === "TEXTAREA";
    if (!isField && !editable) return fail("that is not a text field");
    // Secrets are refused BEFORE anything is typed, and nothing about the field's content is read.
    const why = isField ? secretReason(el) : (secretReason(el) || null);
    if (why) return fail("secret field");
    if (el.disabled || el.readOnly) return fail("the field is disabled or read-only");
    el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    el.focus({ preventScroll: true });
    if (editable && !isField) {
      const sel = getSelection(), rng = document.createRange();
      rng.selectNodeContents(el);
      if (!clear) rng.collapse(false);
      sel.removeAllRanges(); sel.addRange(rng);
      let done = false;
      try { done = document.execCommand("insertText", false, text); } catch { done = false; }
      if (!done) { el.textContent = (clear ? "" : el.textContent) + text; el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text })); }
      return ok("typed " + text.length + " characters");
    }
    const before = el.value, want = clear ? text : before + text;
    let viaExec = false;
    if (clear || !before) {
      try { el.select(); viaExec = document.execCommand("insertText", false, text); } catch { viaExec = false; }
      // execCommand fires real beforeinput/input events, the most faithful "typing"; check it did what it should
      if (viaExec && el.value !== want) viaExec = false;
    }
    if (!viaExec) {
      setNative(el, want);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (el.value !== want && !(el.maxLength > 0 && el.value.length === el.maxLength)) return fail("the page changed what I typed (field now holds " + el.value.length + " characters)");
    return ok("typed " + text.length + " characters");
  }

  function doSelect(el, option) {
    if (el.frame) return fail("that control is inside a frame, which I cannot operate");
    if (el.tagName !== "SELECT") return fail("this is a custom dropdown: click it, then click the option");
    const norm = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();
    const want = norm(option), opts = [...el.options].filter((o) => !o.disabled);
    let m = opts.filter((o) => norm(o.label || o.text) === want || norm(o.value) === want);
    if (!m.length) m = opts.filter((o) => norm(o.label || o.text).startsWith(want));
    if (!m.length) m = opts.filter((o) => norm(o.label || o.text).includes(want));
    if (m.length !== 1) return fail(m.length ? "more than one option matches “" + option + "”" : "no option called “" + option + "”");
    el.focus({ preventScroll: true });
    setNative(el, m[0].value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value === m[0].value ? ok("chose " + (m[0].label || m[0].text).trim()) : fail("the page did not keep that option");
  }

  async function doCheck(el, checked, env) {
    if (el.frame) return fail("that control is inside a frame, which I cannot operate");
    const native = el.tagName === "INPUT" && /^(checkbox|radio)$/i.test(el.type);
    const aria = el.getAttribute("aria-checked");
    const now = native ? el.checked : aria === "true";
    if (!native && aria == null) return fail("that is not a checkbox");
    if (now === checked) return ok(checked ? "already ticked" : "already unticked");
    if (native && el.type.toLowerCase() === "radio" && !checked) return fail("a radio button cannot be unticked, choose another one");
    const r = await doClick(el, env); // a real click toggles it and fires input/change by itself
    if (!r.ok) return r;
    await sleep(60);
    const after = native ? el.checked : el.getAttribute("aria-checked") === "true";
    return after === checked ? ok(checked ? "ticked" : "unticked") : fail("the box did not change");
  }

  // The element whose scrolling the user sees: the page, or the biggest scroll container under the middle of the viewport.
  function scroller() {
    const de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight > innerHeight + 4) return de;
    let n = deepHit(innerWidth / 2, innerHeight / 2);
    for (; n && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight + 4) return n;
    }
    return de;
  }
  async function doScroll(dir, amount) {
    const sc = scroller(), isDoc = sc === document.scrollingElement || sc === document.documentElement;
    const h = isDoc ? innerHeight : sc.clientHeight;
    const dy = (amount === "line" ? 80 : Math.round(h * 0.85)) * (dir === "up" ? -1 : 1);
    const y0 = sc.scrollTop;
    sc.scrollBy({ top: dy, behavior: "smooth" });
    await sleep(amount === "line" ? 350 : 650); // smooth scrolling takes a moment to land
    const moved = Math.abs(sc.scrollTop - y0);
    return moved > 1 ? ok("scrolled " + dir + " " + Math.round(moved) + " px") : ok("already at the " + (dir === "up" ? "top" : "bottom"), { edge: true });
  }

  function dispatchKey(target, key0, mods) {
    const key = key0.length === 1 && mods.includes("shift") ? key0.toUpperCase() : key0;
    const init = { key, code: codeFor(key), bubbles: true, cancelable: true, composed: true, view: window,
      ctrlKey: mods.includes("ctrl"), metaKey: mods.includes("meta"), altKey: mods.includes("alt"), shiftKey: mods.includes("shift"),
      keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : ({ Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 })[key] || 0 };
    const dn = target.dispatchEvent(new KeyboardEvent("keydown", init));
    let press = true;
    if (key.length === 1 || key === "Enter") press = target.dispatchEvent(new KeyboardEvent("keypress", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return dn && press; // false = the page handled it (preventDefault)
  }

  async function doKey(combo, env) {
    const p = parseCombo(combo);
    if (!p) return fail("unknown key " + combo);
    const sc = browserShortcut(p);
    if (sc === "unsupported") return fail("not possible in the browser");
    if (sc === "select_all") { document.execCommand("selectAll"); return ok("selected everything on the page"); }
    if (sc === "copy_selection") { const s = String(getSelection()); if (!s) return fail("nothing is selected"); return env.copy(s); }
    if (sc) return env.tab(sc);
    const a = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    // Prefer the focused element; a video page keeps its shortcuts on the player, so aim at it if nothing is focused.
    const target = a || document.querySelector("#movie_player, .html5-video-player, [role=application]") || document.body;
    const handled = !dispatchKey(target, p.key, p.mods);
    const field = a && ((a.tagName === "INPUT" && !/^(checkbox|radio|button|submit|reset|file)$/i.test(a.type)) || a.tagName === "TEXTAREA" || a.isContentEditable);
    if (!handled) {
      // Synthetic key events do nothing by themselves (a browser only acts on real ones). Do what the key would do, for the few that matter.
      // A modifier changes what a key means (Shift+Enter, Ctrl+Enter...): never turn it into a click or a submit (audit 4, 1.4).
      if (p.mods.length && (p.key === "Enter" || p.key === " ")) return ok("pressed " + combo + " (nothing else done)");
      if (p.key === "Enter" && a) {
        if (a.tagName === "TEXTAREA" || a.isContentEditable) { document.execCommand("insertText", false, "\n"); return ok("pressed Enter"); }
        if (a.tagName === "BUTTON" || (a.tagName === "A" && a.href) || (a.tagName === "INPUT" && /^(button|submit|reset|checkbox|radio)$/i.test(a.type))) { a.click(); return ok("pressed Enter", { navigating: a.tagName === "A" }); }
        const form = a.form || a.closest?.("form");
        if (form && field) { try { form.requestSubmit(); } catch { form.submit(); } return ok("pressed Enter and the form was submitted", { navigating: true }); }
      }
      if (p.key === " " && a && (a.tagName === "BUTTON" || (a.tagName === "INPUT" && /^(button|submit|checkbox|radio)$/i.test(a.type)))) { a.click(); return ok("pressed Space"); }
      if (field && p.key.length === 1 && !p.mods.some((m) => m === "ctrl" || m === "meta" || m === "alt")) return doType(a, p.key, false);
      if (field && p.key === "Backspace") { document.execCommand("delete"); return ok("pressed Backspace"); }
      if (!field && (p.key === " " || p.key.toLowerCase() === "k")) { // a <video> with no shortcut handler: Space and K play or pause it
        const v = document.querySelector("video");
        if (v) { if (v.paused) await v.play().catch(() => {}); else v.pause(); return ok(v.paused ? "paused the video" : "playing the video"); }
      }
      if (!field && /^Page(Up|Down)$|^Arrow(Up|Down)$|^(Home|End)$| /.test(p.key)) {
        const dir = /Up|Home/.test(p.key) ? "up" : "down"; return doScroll(dir, /Arrow/.test(p.key) ? "line" : "page");
      }
    }
    return ok("pressed " + combo + (handled ? " (the page handled it)" : ""));
  }

  // Clipboard: the page's own API first (needs focus), then the extension's right to copy without a gesture, via a hidden textarea.
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return ok("copied " + text.length + " characters to the clipboard"); } catch { /* not focused or not allowed: fall through */ }
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.setAttribute("data-ishara-root", "");
    ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.documentElement.append(ta);
    const prev = document.activeElement;
    ta.select();
    let done = false;
    try { done = document.execCommand("copy"); } catch { done = false; }
    ta.remove();
    if (prev && prev.focus) try { prev.focus({ preventScroll: true }); } catch { /* gone */ }
    return done ? ok("copied " + text.length + " characters to the clipboard") : fail("the browser did not allow copying");
  }

  const normL = (x) => String(x == null ? "" : x).normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 60);
  function sameLabel(now, want) { const a = normL(now), b = normL(want); return a === b || (b.length >= 20 && a.startsWith(b.slice(0, 40))); }

  // run(action, env): one action on THIS page. env = { resolve(id) -> element|null, tab(cmd), openUrl(url,newTab), copy(text), shot(to) }.
  // Returns { ok, detail, navigating? }. Never throws.
  async function run(raw, env) {
    const v = validate(raw);
    if (!v.ok) return fail(v.detail);
    const a = v.action;
    try {
      switch (a.type) {
        case "wait": await sleep(a.ms); return ok("waited " + a.ms + " ms");
        case "scroll": return await doScroll(a.direction, a.amount);
        case "open_url": return await env.openUrl(a.url, a.newTab);
        case "search": return await env.openUrl(searchUrl(a.query, a.engine), false); // the next planning step reads the results page
        case "tab": return a.op === "back" || a.op === "forward" ? await env.tab(a.op) : await env.tabOp(a.op, a.match);
        case "copy": return await env.copy(a.text);
        case "screenshot": return await env.shot(a.to);
        case "key": return await doKey(a.combo, env);
      }
      const el = env.resolve(a.id);
      if (!el || !el.isConnected) return fail("I can't find that control any more");
      // The risk was decided on the label the helper saw. If the page changed it since (hover, timer), do nothing (audit 4, 1.10).
      if (env.expectLabel != null && env.labelNow && !sameLabel(env.labelNow(el), env.expectLabel)) return fail("the control changed since I checked it (now “" + String(env.labelNow(el) || "").slice(0, 40) + "”), so I did not touch it");
      if (a.type === "click") return await doClick(el, env);
      if (a.type === "type") return doType(el, a.text, a.clear);
      if (a.type === "select") return doSelect(el, a.option);
      if (a.type === "check") return await doCheck(el, a.checked, env);
    } catch (e) {
      return fail("failed: " + String((e && e.message) || e).slice(0, 120));
    }
    return fail("unknown action");
  }

  // =====================================================================================================================
  // 3. Transport: the extension's real wiring (tests and the preview page pass their own)
  // =====================================================================================================================
  function chromeTransport() {
    const send = (msg) => new Promise((res) => {
      const timer = setTimeout(() => res({ error: "Ishara did not answer" }), 30000);
      try { chrome.runtime.sendMessage(msg, (r) => { clearTimeout(timer); res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : (r || { error: "no answer" })); }); }
      catch { clearTimeout(timer); res({ error: "Ishara was reloaded" }); }
    });
    return {
      open(body, onEvent) { // the SSE stream of POST /act, relayed by the service worker (background.js, port "act")
        const p = chrome.runtime.connect({ name: "act" });
        let closed = false;
        p.onMessage.addListener((m) => { if (!closed && m) onEvent(m.event, m.data || {}); });
        p.onDisconnect.addListener(() => { if (!closed) onEvent("disconnect", {}); });
        p.postMessage({ type: "start", body });
        return { close() { closed = true; try { p.disconnect(); } catch { /* gone */ } } };
      },
      post: (path, body) => send({ type: "act-post", path, body }), // /act/result | /act/stop | /speech/say
      // Approve/Deny happens in an extension window the page cannot touch; the worker answers the helper and returns what it ACCEPTED.
      approval: (m) => new Promise((res) => {
        const timer = setTimeout(() => res({ yes: false, accepted: false }), 75000);
        try { chrome.runtime.sendMessage({ type: "act-approval", ...m }, (r) => { clearTimeout(timer); res(chrome.runtime.lastError || !r ? { yes: false, accepted: false } : r); }); }
        catch { clearTimeout(timer); res({ yes: false, accepted: false }); }
      }),
      state: {
        get: () => send({ type: "act-state", op: "get" }).then((r) => r.state || null),
        set: (state) => send({ type: "act-state", op: "set", state }),
        clear: () => send({ type: "act-state", op: "clear" }),
      },
      agent: { get: () => send({ type: "act-state", op: "agent-get" }).then((r) => !!r.on), set: (on) => send({ type: "act-state", op: "agent-set", on }), touch: () => send({ type: "act-state", op: "agent-touch" }) },
      tab: (cmd) => send({ type: "act-tab", ...cmd }),
    };
  }

  // =====================================================================================================================
  // 4. Controller
  // =====================================================================================================================
  const NS = () => (root.Ishara = root.Ishara || {});
  const OV = () => NS().overlay;
  const CAP_MS = 4 * 60 * 1000, STATE_TTL = 10 * 60 * 1000, POINT_WAIT = 700;
  const uid = () => "a" + [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, "0")).join(""); // 19 chars of [a-z0-9]: valid for the helper's actId rule

  let transport = null, agentOn = false, runState = null, approvalState = null, cfg = { sessionId: "", speak: true };
  const tp = () => transport || (transport = chromeTransport());

  // Compile outline + PageContext from the SAME outline (so ids match). Returns { ctx, outline, map }.
  async function compile() {
    const N = NS();
    const c = await N.compileOutlineAsync();
    let context = null;
    try { if (N.compilePageContextAsync) context = await N.compilePageContextAsync({ outline: c }); } catch { context = null; }
    if (!context) context = { source: "browser", url: location.href, title: document.title, viewport: { w: innerWidth, h: innerHeight }, blocks: [], controls: c.outline.elements, errors: [] };
    return { ctx: context, outline: c.outline, map: c.map };
  }

  // The page may have re-rendered between the compile and the action: find the element again only when exactly one visible
  // control has the same role and label (same rule as the tutor's pointer); never guess.
  function elementFor(cur, id) {
    if (!cur) return null;
    const el = cur.map.get(id);
    if (el && el.isConnected) return el;
    if (el && el.frame) return null;
    const seen = cur.outline.elements.find((e) => e.id === id);
    if (!seen) return null;
    const now = NS().compileOutline();
    const same = now.outline.elements.filter((e) => e.role === seen.role && e.label === seen.label);
    return same.length === 1 ? now.map.get(same[0].id) : null;
  }
  const labelFor = (cur, id) => { const e = cur && cur.outline.elements.find((x) => x.id === id); return e ? e.label : ""; };

  // The label the outline gives an element now (same labeller as the context the helper classified).
  function labelNow(el) {
    try { const now = NS().compileOutline(); for (const e of now.outline.elements) if (now.map.get(e.id) === el) return e.label; } catch { /* fall through */ }
    return visibleLabel(el);
  }

  function makeEnv(cur, expectLabel) {
    const T = tp();
    return {
      resolve: (id) => elementFor(cur, id),
      expectLabel: expectLabel == null ? null : expectLabel,
      labelNow,
      openUrl: async (url, newTab) => {
        if (runState) { runState.expectNav = true; await saveState({ awaiting: true }); }
        const r = await T.tab({ cmd: "open_url", url, newTab: !!newTab });
        if (r.error) return fail(r.error);
        if (r.moved) { handoff(runState, "Carrying on in the new tab."); return ok("opened in the new tab"); }
        if (newTab) return ok("opened in a new tab");
        await sleep(8000); // the page is about to unload and take this script with it; if we are still here, the navigation did not happen
        return fail("the page did not open");
      },
      tab: async (cmd) => {
        if (cmd === "back" || cmd === "forward" || cmd === "reload") { if (runState) await saveState({ awaiting: true }); }
        const r = await T.tab({ cmd });
        if (r.error) return fail(r.error);
        if (cmd === "back" || cmd === "forward") {
          // The worker says whether the address changed. A full page load ends this script (the next page resumes); surviving 1.5 s
          // means it was a same-page history step (a single-page app), which is a success, not "the page did not change".
          if (r.ok === false || !r.changed) { if (runState) await saveState({ awaiting: false }); return fail(r.detail || "the page did not change"); }
          await sleep(1500);
          if (runState) await saveState({ awaiting: false });
          return ok(r.detail || (cmd === "back" ? "went back" : "went forward"));
        }
        if (cmd === "reload") { await sleep(8000); return fail("the page did not reload"); }
        return r.ok === false ? fail(r.detail || "not possible") : ok(r.detail || cmd);
      },
      // switch / close (by match) / new: the service worker does it with chrome.tabs. It refuses to close the tab this task runs in.
      tabOp: async (op, match) => {
        if (op === "switch" && runState) await saveState({ awaiting: false });
        const r = await T.tab({ cmd: "tab_op", op, match });
        if (r.error) return fail(r.error);
        // The task moved to the other tab: THIS tab must not act on it again (audit 4, section 2, wrong tab after a switch).
        if (r.ok !== false && r.moved) handoff(runState, "Carrying on in the other tab.");
        return r.ok === false ? fail(r.detail || "not possible") : ok(r.detail || op);
      },
      copy: async (text) => {
        const r = await copyText(text);
        if (r.ok) return r;
        // Last resort: the helper's clipboard route (pbcopy), only if the core agent provides it. Text is the user's own task text.
        const h = await T.post("/act/clipboard", { text });
        return h && !h.error && h.data && h.data.ok !== false ? ok("copied " + text.length + " characters to the clipboard") : r;
      },
      shot: async (to) => {
        // Hide our own pill and cursor from the picture, then restore. The image stays on this machine: it goes to the clipboard or
        // Downloads and is never given to the helper (the result carries a sentence only).
        const host = document.querySelector("[data-ishara-root]");
        const prev = host && host.style.visibility;
        if (host) host.style.visibility = "hidden";
        await raf2(); await sleep(80);
        let r;
        try { r = await T.tab({ cmd: "screenshot", to }); } finally { if (host) host.style.visibility = prev || ""; }
        if (r.error) return fail(r.error);
        if (!r.dataUrl) return r.ok === false ? fail(r.detail || "screenshot failed") : ok(r.detail || "screenshot saved");
        if (to === "clipboard") {
          try {
            const blob = await (await fetch(r.dataUrl)).blob();
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            return ok("screenshot copied to the clipboard");
          } catch { /* not allowed here: save the file instead */ }
        }
        const d = await T.tab({ cmd: "download", dataUrl: r.dataUrl });
        return d.error || d.ok === false ? fail(d.error || d.detail || "could not save the screenshot") : ok(to === "clipboard" ? "the clipboard refused the image, so I saved it in Downloads as " + d.filename : "saved the screenshot in Downloads as " + d.filename);
      },
    };
  }

  const saveState = (patch) => {
    if (!runState) return Promise.resolve();
    const s = { actId: runState.actId, taskId: runState.taskId, task: runState.task, startedAt: runState.startedAt, history: runState.history.slice(-12), done: runState.done, awaiting: false, ...patch };
    return tp().state.set(s);
  };

  // ---- the UI side of a run, one place so the preview and the page see the same thing ----
  const ui = {
    chip: (on) => OV() && OV().agent.chip(on),
    thinking(n) { OV().agent.pill("thinking", n > 1 ? "Looking at the page for step " + n + "…" : "Working out how to do that…", { n: Math.max(1, n || 1), live: true, buttons: [{ label: "Stop", kbd: "Esc", cls: "no", onClick: () => stop("button") }] }); },
    step(n, text) { OV().agent.pill("acting", "Step " + n + ": " + text, { n, live: true, buttons: [{ label: "Stop", kbd: "Esc", cls: "no", onClick: () => stop("button") }] }); },
    // The answer is given in the Ishara window (an extension window the page cannot touch), never here (audit 4, 1.8).
    approval(n, words, why) {
      OV().agent.pill("approval", words, { amber: true, n, why: (why ? why + " " : "") + "Approve or deny in the Ishara window.", live: false,
        buttons: [{ label: "Stop", kbd: "Esc", cls: "no", onClick: () => stop("button") }] });
    },
    end(kind, text, ms) {
      const o = OV().agent;
      o.clearMarks();
      const red = kind === "failed" || kind === "refused";
      o.pill(kind === "done" ? "idle" : "refused", (kind === "done" ? "Done. " : "") + (text || (kind === "stopped" ? "Stopped." : "That did not work.")), { red, amber: kind === "stopped", linger: ms || (red ? 15000 : 9000) });
    },
  };

  // ---- starting, following and ending a task ----
  async function start(task, o = {}) {
    if (runState) return;
    const actId = o.actId || uid();
    runState = { actId, taskId: o.taskId || actId, task, history: o.history || [], done: o.done || 0, n: 0, stopped: false, finished: false, handle: null, queue: Promise.resolve(), startedAt: o.startedAt || Date.now(), last: null, cap: 0, askBody: null };
    const R = runState;
    ui.chip(true); ui.thinking(R.done + 1);
    R.cap = setTimeout(() => { if (runState === R) stop("time limit"); }, CAP_MS);
    let cur;
    try { cur = await compile(); } catch (e) { return end(R, "failed", { say: "I could not read this page: " + ((e && e.message) || e) }); }
    if (R.stopped) return;
    R.cur = cur;
    // The task stays the person's words. What happened on earlier pages goes separately, as data (audit 4, 1.5); the taskId makes the
    // helper keep ONE 25-action / 3-minute budget for the whole task across pages (audit 4, 1.6).
    tp().agent.touch && tp().agent.touch();
    const body = { sessionId: cfg.getSessionId ? cfg.getSessionId() : cfg.sessionId, task, history: R.history.slice(-12), taskId: R.taskId, context: cur.ctx, executor: "client", armed: true, actId };
    R.body = body;
    await saveState({ awaiting: false });
    open(R, body);
  }

  function open(R, body) {
    try { R.handle = tp().open(body, (event, d) => onEvent(R, event, d)); }
    catch { end(R, "failed", { say: "Ishara was updated or reloaded. Reload this page to continue." }); }
  }

  function onEvent(R, event, d) {
    if (runState !== R || R.finished) return;
    if (R.stopped) return;
    switch (event) {
      case "thinking": if (d.actId && typeof d.actId === "string") R.actId = d.actId; if (!R.acting) ui.thinking(R.done + (d.n || 1)); return;
      case "action": R.queue = R.queue.then(() => onAction(R, d)).catch(() => {}); return;
      case "approval": R.queue = R.queue.then(() => onApproval(R, d)).catch(() => {}); return;
      case "result": return; // the helper's own executor reports here; the browser reports through POST /act/result
      case "ask": R.askBody = R.body; return onAsk(R, d);
      case "done": case "failed": case "stopped": case "refused": return end(R, event, d);
      case "noroute": return end(R, "failed", { say: "This Ishara helper does not know Agent mode yet." });
      case "disconnect": return end(R, "failed", { say: "Ishara lost its connection to the helper." });
    }
  }

  // `action` comes first, then (for a risky one) `approval`: the action must NOT run until the person says yes. So a risky action is
  // prepared here (step text, cursor on the target) and held; the approval answer runs it.
  async function onAction(R, d) {
    if (R.stopped || runState !== R) return;
    approvalState = null;
    const a = d.action || {}, n = (R.done || 0) + 1;
    R.n = d.n; R.acting = true;
    const target = a.id ? elementFor(R.cur, a.id) : null;
    const label = d.targetLabel || (a.id ? labelFor(R.cur, a.id) : "");
    const say = (d.say && String(d.say).trim()) || describe(a, label);
    const J = { d, a, n, target, label, say };
    ui.step(n, say.replace(/[.!]+$/, ""));
    if (cfg.speak && d.say) tp().post("/speech/say", { text: String(d.say).slice(0, 300) });
    if (d.point && d.point.status && d.point.status !== "confirmed" && a.id) return report(R, J, fail("the control was not confirmed as the right one"));
    if (a.id && !target) return report(R, J, fail("I can't find that control on the page"));
    if (target) {
      try { await OV().agent.point(target); } catch { /* pointing is a courtesy; the action decides */ }
      await sleep(POINT_WAIT);
    } else await sleep(a.type === "wait" ? 0 : 450);
    if (R.stopped || runState !== R) return;
    if (d.needsApproval) { R.held = J; return; } // waits for the `approval` event and the person's answer
    return execute(R, J);
  }

  async function execute(R, J) {
    if (R.stopped || runState !== R) return;
    await saveState({ awaiting: true }); // if this action navigates, the next page resumes from here
    // Controls (b-ids) are re-checked by label; text blocks (t-ids) have no control label to compare.
    const want = J.a && typeof J.a.id === "string" && J.a.id[0] === "b" ? (J.d && J.d.targetLabel != null ? J.d.targetLabel : J.label) : null;
    const res = await run(J.a, makeEnv(R.cur, want));
    if (R.stopped || runState !== R) return;
    if (res.navigating) await sleep(6000); // a real navigation unloads this script; surviving means it was blocked or in-page
    else await settle();
    return report(R, J, res);
  }

  async function report(R, J, res) {
    if (runState !== R || R.stopped) return;
    const c = await compile().catch(() => null);
    if (c) R.cur = c;
    R.history.push(J.say.replace(/[.!]+$/, "").slice(0, 80)); R.done = J.n; R.acting = false; R.held = null;
    await saveState({ awaiting: false });
    tp().post("/act/result", { actId: R.actId, n: R.n, ok: !!res.ok, detail: String(res.detail || "").slice(0, 300), context: c ? c.ctx : undefined });
  }

  async function onApproval(R, d) {
    if (R.stopped || runState !== R) return;
    const a = d.action || {}, n = (R.done || 0) + 1;
    const J = R.held && R.held.d.n === d.n ? R.held : null;
    const target = J ? J.target : (a.id ? elementFor(R.cur, a.id) : null);
    if (!J && target) { try { await OV().agent.point(target); } catch { /* optional */ } }
    const label = a.id ? labelFor(R.cur, a.id) : "";
    const words = describe(a, label, { question: true });
    const myN = d.n;
    approvalState = { n: myN };
    ui.approval(n, words, d.why && d.why !== words ? String(d.why).slice(0, 120) : "");
    // The worker opens the window, posts the answer to the helper itself, and tells us whether the helper ACCEPTED it. Only an
    // accepted yes runs: a late tap (the 60 s ran out) or a stopped task does nothing (audit 4, 1.9).
    const r = await tp().approval({ actId: R.actId, n: myN, words, why: d.why || "", risk: d.risk || "high" });
    if (!approvalState || approvalState.n !== myN || R.stopped || runState !== R) return;
    approvalState = null;
    if (r && r.yes && r.accepted) {
      ui.step(n, "approved, doing it");
      const held = R.held || { d: { n: myN, action: a }, a, n, target, label, say: words.replace(/\?$/, "") };
      R.held = null;
      R.queue = R.queue.then(() => execute(R, held)).catch(() => {});
    } else { R.held = null; R.acting = false; if (r && r.yes && !r.accepted) ui.step(n, "that approval came too late, so I did nothing"); else ui.thinking(n); }
  }

  // The task paused for an answer (event `ask`): show the question and open the type box; the reply continues the same actId.
  function onAsk(R, d) {
    const say = (d && d.say) || "I need a little more information.";
    OV().agent.clearMarks();
    OV().agent.pill("approval", say, { amber: true, n: Math.max(1, R.done + 1), live: false });
    OV().openTypeBox(async (answer) => {
      if (runState !== R || R.stopped) return;
      ui.thinking(R.done + 1);
      let cur = R.cur; try { cur = await compile(); R.cur = cur; } catch { /* keep the last */ }
      R.handle && R.handle.close();
      open(R, { ...R.body, context: cur.ctx, answer, task: R.body.task });
    });
  }

  function end(R, kind, d) {
    if (runState !== R || R.finished) return;
    R.finished = true; clearTimeout(R.cap);
    if (R.handle) R.handle.close();
    approvalState = null; runState = null;
    tp().state.clear();
    ui.end(kind, d && d.say, undefined);
    if (cfg.speak && d && d.say && kind !== "stopped") tp().post("/speech/say", { text: String(d.say).slice(0, 300) }).catch?.(() => {});
    document.dispatchEvent(new CustomEvent("ishara-act-end", { detail: { kind } })); // measurement hook for the tests
  }

  // Esc, the Stop button, the time cap: stop at once, tell the helper, cancel any approval. The stop flag is checked between every
  // step, so nothing further runs even if the helper is slow to hear it.
  function stop(why) {
    const R = runState;
    if (!R || R.finished) return false;
    R.stopped = true; clearTimeout(R.cap);
    approvalState = null;
    tp().post("/act/stop", { actId: R.actId });
    if (R.handle) R.handle.close();
    R.finished = true; runState = null;
    tp().state.clear();
    ui.end("stopped", why === "time limit" ? "Stopped: that took too long." : "Stopped.", 5000);
    document.dispatchEvent(new CustomEvent("ishara-act-end", { detail: { kind: "stopped" } }));
    return true;
  }

  // Approval is never given from the page's keyboard (a page can fake the prompt and ask you to press Y): audit 4, 1.8.
  function handleKey() { return false; }

  // ---- agent mode switch ----
  function setAgent(on, o = {}) {
    agentOn = !!on;
    ui.chip(agentOn);
    if (!agentOn) stop("agent off");
    if (!o.silent) tp().agent.set(agentOn); // off: the worker disarms every tab and stops every task
    if (!o.quiet && OV()) OV().say(agentOn ? "Agent mode on. Ask me to do something, for example “fill this form”. Esc stops me." : "Agent mode off.", { });
    return agentOn;
  }

  // A page load in the middle of a task: carry on from where the last page left off (cross-page tasks). The previous page's stream
  // ended with its unload, so this starts a new one, tells the helper the old one is over, and gives the model the history.
  async function resume() {
    let st;
    try { st = await tp().state.get(); } catch { return false; }
    if (!st || !st.awaiting || !st.task) return false;
    if (Date.now() - (st.startedAt || 0) > STATE_TTL || (st.done || 0) >= 25) { tp().state.clear(); return false; }
    // The worker returns no state when Agent mode is off for this tab, timed out, or a Stop came after the save (audit 4, 1.7).
    // Check the arming again here anyway: never act unarmed.
    let armed = false; try { armed = await tp().agent.get(); } catch { armed = false; }
    if (!armed) { tp().state.clear(); return false; }
    agentOn = true; ui.chip(true);
    tp().state.set({ ...st, awaiting: false }); // consumed: a reload of THIS page must not restart the task a second time
    if (st.actId) tp().post("/act/stop", { actId: st.actId, handoff: true }); // the earlier page's run is logged as continued, not stopped
    await sleep(500); await settle();
    // Esc during the load is checked once more: a stop that arrived while we waited wins.
    let again = null; try { again = await tp().state.get(); } catch { again = null; }
    if (!again) return false;
    start(st.task, { history: st.history || [], done: st.done || 0, startedAt: st.startedAt, taskId: st.taskId || st.actId });
    return true;
  }

  // The task moved to another tab or page: end it HERE quietly, without clearing the saved state the other side resumes from.
  function handoff(R, text) {
    if (!R || R.finished) return;
    R.stopped = true; R.finished = true; clearTimeout(R.cap);
    tp().post("/act/stop", { actId: R.actId, handoff: true });
    if (R.handle) R.handle.close();
    approvalState = null; if (runState === R) runState = null;
    ui.end("done", text, 4000);
  }

  // A page restored from the back/forward cache runs no content script again: its old, frozen task must not wake up, and the saved
  // state must be picked up as if the page had loaded (audit 4, section 2).
  if (typeof addEventListener === "function" && typeof window !== "undefined" && window === window.top) {
    addEventListener("pageshow", (ev) => {
      if (!ev.persisted) return;
      const R = runState;
      if (R) { R.stopped = true; R.finished = true; clearTimeout(R.cap); if (R.handle) R.handle.close(); runState = null; approvalState = null; }
      resume().catch(() => {});
    });
  }

  // ---- dev hook: drive the executor from a page under http://127.0.0.1:7777/test/ (never on real sites) ----
  function installDevHook() {
    if (!/^http:\/\/127\.0\.0\.1:7777\/test\//.test(location.href)) return;
    addEventListener("ishara-dev-act", async (ev) => {
      let a = ev.detail;
      if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
      const out = (o) => { document.documentElement.dataset.isharaActResult = JSON.stringify({ ...o, at: Date.now() }); };
      if (!a || typeof a !== "object") return out(fail("bad dev action"));
      const cur = await compile();
      // dev convenience: name the control by its label instead of its id
      if (!a.id && a.label) {
        const m = cur.outline.elements.filter((e) => e.label.toLowerCase() === String(a.label).toLowerCase() || e.label.toLowerCase().includes(String(a.label).toLowerCase()));
        const exact = m.filter((e) => e.label.toLowerCase() === String(a.label).toLowerCase());
        const pick = exact.length === 1 ? exact[0] : m.length === 1 ? m[0] : null;
        if (!pick) return out(fail("label matches " + m.length + " controls"));
        a = { ...a, id: pick.id };
      }
      const res = await run(a, makeEnv(cur));
      if (res.navigating) await sleep(1500); else await settle();
      document.documentElement.dataset.isharaOutline = cur.outline.text.slice(0, 6000);
      out(res);
    });
  }

  function init(o = {}) {
    if (o.transport) transport = o.transport;
    if (o.sessionId !== undefined) cfg.sessionId = o.sessionId;
    if (o.speak !== undefined) cfg.speak = !!o.speak;
    if (o.getSessionId) cfg.getSessionId = o.getSessionId;
    return api;
  }

  // A tab switch hands the task to another, already loaded tab: no page load happens there, so the worker nudges it to pick the task up.
  try {
    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage && window === window.top) {
      chrome.runtime.onMessage.addListener((m, sender) => {
        if (!m || !sender || sender.id !== chrome.runtime.id) return;
        if (m.type === "act-resume" && !runState) resume();
        // The browser-level Stop shortcut (or Agent mode off in any tab): handled by the worker, which no page can intercept.
        if (m.type === "act-stop-cmd") { stop(m.why === "shortcut" ? "shortcut" : "agent off"); agentOn = false; ui.chip(false); }
      });
    }
  } catch { /* not an extension page */ }

  const api = Object.assign({}, pure, {
    run, settle, init, start, stop, handleKey, setAgent, resume, installDevHook, secretReason, compile,
    isAgent: () => agentOn,
    isBusy: () => !!runState,
    hasApproval: () => !!approvalState,
    toggleAgent: () => setAgent(!agentOn),
    setSession: (id) => { cfg.sessionId = id; },
    // For the page-load path: ask the service worker whether agent mode was left on in this browser session.
    async restoreAgent() { try { if (await tp().agent.get()) { agentOn = true; ui.chip(true); } } catch { /* off */ } },
    _ui: ui,
  });
  return api;
});
