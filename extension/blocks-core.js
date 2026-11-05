// Page-reader core: the parts that decide what may leave the tab, with NO DOM access, so node can test them.
// Classic script (content scripts cannot be ES modules). In the browser it publishes globalThis.IsharaBlocks;
// under node (helper/test/blocks.test.ts evaluates this file in a vm context) the same object is module.exports.
// Contract: docs/TUTOR-INTERFACE.md sections 1 and 5.
(function (root) {
  "use strict";

  const REDACTED = "[redacted]";
  const BLOCK_MAX = 400;

  // ---- redaction ------------------------------------------------------------------------------------------------
  // WHY a field-name rule AND a shape rule: the name catches a secret the user typed into a box called "Recovery
  // phrase"; the shape catches a secret that sits in a box or paragraph with an innocent name (a copy button's
  // text, a "your key" card). Either one alone leaks.
  const SECRET_FIELD = /seed|mnemonic|recovery phrase|private key|secret|token|cvv|cvc|pin\b|password|passphrase|api[-_ ]?key/i;
  const SECRET_AUTOCOMPLETE = /^(cc-|one-time-code|new-password|current-password)/i;

  // True when a control must never be read at all. `f` = { type, autocomplete, text } where text is the
  // name / id / label / placeholder / aria-label joined by the caller.
  function isSecretField(f) {
    if (!f) return false;
    if (String(f.type || "").toLowerCase() === "password") return true;
    const ac = String(f.autocomplete || "").toLowerCase().split(/\s+/);
    if (ac.some((a) => SECRET_AUTOCOMPLETE.test(a))) return true;
    return SECRET_FIELD.test(String(f.text || ""));
  }

  const SHAPES = [
    /\b0x[0-9a-fA-F]{64}\b/g,                                   // private key / tx hash with 0x
    /\b[0-9a-fA-F]{64}\b/g,                                     // 32 raw bytes in hex
    /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g,                       // JWT
    /\bsk-[A-Za-z0-9_-]{8,}/g, /\bsk_live_\w{6,}/g, /\bsk_test_\w{6,}/g,
    /\bghp_\w{16,}/g, /\bgithub_pat_\w{16,}/g,
    /\bAKIA[0-9A-Z]{12,}/g, /\bxox[bp]-[\w-]{8,}/g,
  ];
  // Long base64/hex runs. A 40-hex run (a bare address) and 0x + 40 hex are public and kept. '-' and '_' are left out of
  // the class on purpose: URL slugs and kebab-case names are long and harmless.
  const LONG_RUN = /[A-Za-z0-9+/=]{40,}/g;
  const PUBLIC_ADDR = /^(0x)?[0-9a-fA-F]{40}$/;

  function isPhrase(s) {
    const w = s.trim().split(/\s+/).filter((t) => !/^\d{1,2}[.):]?$/.test(t)); // "1. word 2. word" numbered grids
    return [12, 15, 18, 21, 24].includes(w.length) && w.every((t) => /^[a-z]{3,10}$/.test(t));
  }

  // Replace secret-shaped substrings. A whole-text mnemonic is redacted whole; a mnemonic after "label:" keeps the label.
  function redactShapes(text) {
    let s = text;
    if (isPhrase(s)) return REDACTED;
    const i = s.lastIndexOf(":");
    if (i > -1 && isPhrase(s.slice(i + 1))) s = s.slice(0, i + 1) + " " + REDACTED;
    for (const re of SHAPES) s = s.replace(re, REDACTED);
    s = s.replace(LONG_RUN, (m) => (PUBLIC_ADDR.test(m) || !/\d/.test(m) || !/[A-Za-z]/.test(m) ? m : REDACTED));
    return s;
  }

  // redact(text, ctx): the one gate every string passes before it leaves the tab. ctx is optional and describes the
  // FIELD the text came from: { type, autocomplete, text }. A secret field gives "[redacted]" whatever its value is.
  function redact(text, ctx) {
    const s = String(text == null ? "" : text);
    if (ctx && isSecretField(ctx)) return REDACTED;
    return redactShapes(s);
  }

  // ---- injection neutralizer ------------------------------------------------------------------------------------
  // The helper parses [POINT:id], [STEP n/m] and [WAIT] out of what the model writes, and fences page data with
  // <<..>> and ``` (section 5). Page text must never be able to spell any of them. Invisible characters are removed
  // FIRST so "[PO<zero-width>INT:" cannot slip through. Idempotent: running it twice changes nothing more.
  function neutralize(text) {
    return String(text == null ? "" : text)
      .replace(/[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g, "")
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .replace(/\[\s*POINT\s*:/gi, "[ POINT :")
      .replace(/\[\s*STEP/gi, "[ STEP")
      .replace(/\[\s*WAIT\s*\]/gi, "[ WAIT ]")
      .replace(/<<+/g, "< <").replace(/>>+/g, "> >")
      .replace(/`{3,}/g, "` ` `");
  }

  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  // The text pipeline for anything that becomes block text, selection or a state value.
  const safeText = (s, max = BLOCK_MAX, ctx) => clip(clean(redact(neutralize(s), ctx)), max);

  // ---- tokens ---------------------------------------------------------------------------------------------------
  const estimateTokens = (s) => Math.ceil(String(s || "").length / 4);
  const blockTokens = (b) => estimateTokens(b.text) + 3; // + id and kind markers in the prompt

  // ---- blocks from text records ---------------------------------------------------------------------------------
  // The DOM layer (blocks.js) walks the page and emits one record per visible text node:
  //   { key, tag, cell, text, rect, inView, boiler, errorish }
  // key = the container element (records with the same key form one block), tag = its lowercase tag name, cell = the
  // td/th it sits in (rows only), boiler = inside nav/footer/aside, errorish = looks like an error message.
  // Everything after that is pure and lives here.
  function kindOf(tag) {
    if (/^h[1-6]$/.test(tag)) return "h";
    if (tag === "li") return "li";
    if (tag === "pre") return "code";
    if (tag === "tr") return "cell";
    if (tag === "figcaption" || tag === "caption") return "caption";
    if (["p", "blockquote", "dd", "dt", "summary"].includes(tag)) return "p";
    return "text";
  }

  function buildBlocks(records, opts) {
    const skip = new Set(((opts && opts.controlLabels) || []).map((l) => clean(l).toLowerCase()).filter(Boolean));
    const groups = new Map();
    for (const r of records) {
      let g = groups.get(r.key);
      if (!g) groups.set(r.key, (g = { tag: r.tag, rect: r.rect, inView: r.inView, boiler: !!r.boiler, errorish: !!r.errorish, parts: [], cells: [] }));
      if (r.tag === "tr") {
        const last = g.cells[g.cells.length - 1];
        if (last && last.key === r.cell) last.parts.push(r.text); else g.cells.push({ key: r.cell, parts: [r.text] });
      } else g.parts.push(r.text);
    }
    const out = [];
    for (const g of groups.values()) {
      let kind = kindOf(g.tag);
      let raw;
      if (g.tag === "tr") raw = "row: " + g.cells.map((c) => clean(c.parts.join(" "))).filter(Boolean).join(" | ");
      else if (kind === "code") raw = g.parts.join("\n");
      else raw = g.parts.join(" ");
      let text = kind === "code"
        ? clip(redact(neutralize(raw)).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(), BLOCK_MAX)
        : safeText(raw);
      if (g.errorish && kind !== "h") kind = "error";
      if (text.length < 2 || (kind === "text" && text.length < 3)) continue;
      out.push({ kind, text, inView: !!g.inView, rect: g.rect || undefined, boiler: g.boiler });
    }
    // Dedupe. A heading wins over any other block with the same words (a card title repeated in its link), and a
    // plain text/list block that only repeats a control's label adds nothing: the controls list already has it.
    const headings = new Set(out.filter((b) => b.kind === "h").map((b) => b.text.toLowerCase()));
    const seen = new Set();
    return out.filter((b) => {
      const k = b.text.toLowerCase();
      if (b.kind !== "h" && headings.has(k)) return false;
      if ((b.kind === "text" || b.kind === "li") && skip.has(k)) return false;
      if (b.kind !== "error" && seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ---- budget ---------------------------------------------------------------------------------------------------
  // Order of keep: headings (the page map, capped at half the budget, on-screen first), errors, in-view blocks,
  // then the rest in reading order. Nav/footer boilerplate is only used if room is left over. Result keeps reading order.
  function trim(blocks, budgetTokens) {
    const all = blocks.map((b, i) => ({ b, i }));
    let left = budgetTokens;
    const keep = new Set();
    const take = (x) => { const c = blockTokens(x.b); if (c > left) return false; left -= c; keep.add(x.i); return true; };
    const heads = all.filter((x) => x.b.kind === "h");
    let headBudget = Math.floor(budgetTokens / 2);
    for (const x of [...heads.filter((x) => x.b.inView), ...heads.filter((x) => !x.b.inView)]) {
      const c = blockTokens(x.b);
      if (c > headBudget) continue;
      headBudget -= c; take(x);
    }
    const rest = all.filter((x) => x.b.kind !== "h");
    for (const x of rest.filter((x) => x.b.kind === "error")) take(x);
    const tiers = [
      rest.filter((x) => x.b.kind !== "error" && x.b.inView && !x.b.boiler),
      rest.filter((x) => x.b.kind !== "error" && !x.b.inView && !x.b.boiler),
      rest.filter((x) => x.b.kind !== "error" && x.b.boiler),
    ];
    for (const tier of tiers) for (const x of tier) { if (left < 8) break; take(x); }
    const kept = all.filter((x) => keep.has(x.i)).map((x) => x.b);
    return { blocks: kept, dropped: blocks.length - kept.length };
  }

  // Number the blocks "t0".. in their final order and drop the helper-only fields.
  function number(blocks) {
    return blocks.map((b, i) => {
      const o = { id: "t" + i, kind: b.kind, text: b.text, inView: b.inView };
      if (b.rect) o.rect = b.rect;
      return o;
    });
  }

  // Sanity-check a block that arrived from ANOTHER frame: its page is untrusted, so retype everything.
  const KINDS = new Set(["p", "h", "li", "code", "cell", "error", "caption", "text"]);
  function sanitizeForeign(b) {
    if (!b || typeof b !== "object") return null;
    const text = safeText(String(b.text == null ? "" : b.text));
    if (text.length < 2) return null;
    return { kind: KINDS.has(b.kind) ? b.kind : "text", text, inView: !!b.inView, boiler: !!b.boiler };
  }

  // ---- whole-context tokens -------------------------------------------------------------------------------------
  function contextTokens(ctx) {
    let n = estimateTokens(ctx.url) + estimateTokens(ctx.title) + estimateTokens(ctx.selection || "");
    for (const b of ctx.blocks) n += blockTokens(b);
    for (const c of ctx.controls) {
      n += estimateTokens(c.label) + 6;
      if (c.state) n += estimateTokens(JSON.stringify(c.state)) ;
      if (c.errorText) n += estimateTokens(c.errorText);
    }
    return n;
  }

  const api = { REDACTED, BLOCK_MAX, isSecretField, redact, redactShapes, neutralize, safeText, estimateTokens, blockTokens, buildBlocks, trim, number, sanitizeForeign, contextTokens, clean, clip };
  root.IsharaBlocks = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
