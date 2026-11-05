// Small helpers shared by the pages. No framework: every value from the helper is put into the page with
// textContent, never innerHTML, because the question text and error strings are not ours to trust.
const $ = (s, r = document) => r.querySelector(s);
function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
}
// Middle ellipsis: the start and end of a hash are what people compare; the middle is noise on a phone.
function shorten(s, head = 10, tail = 8) { s = String(s ?? ""); return s.length <= head + tail + 3 ? s : s.slice(0, head) + "…" + s.slice(-tail); }
// Hash with a copy button. Shows the shortened form; the full value is in the title and is what gets copied.
function hashView(value, { full = false } = {}) {
  if (!value) return el("span", { class: "muted", text: "not available" });
  const code = el("code", { title: value, text: full ? value : shorten(value) });
  const btn = el("button", { class: "copy", type: "button", text: "Copy", "aria-label": "Copy " + value });
  btn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(value); btn.textContent = "Copied"; }
    catch { // clipboard can be blocked on http pages: fall back to selecting the text so the user can copy by hand
      const r = document.createRange(); r.selectNodeContents(code); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); btn.textContent = "Selected";
    }
    setTimeout(() => (btn.textContent = "Copy"), 1500);
  });
  return el("span", { class: "hash" }, code, btn);
}
const fmtTime = (iso) => { const d = new Date(iso); return isNaN(d) ? String(iso ?? "") : d.toLocaleString(); };
// Where to fetch from. `?fixture=name` is a test switch: when present, read web/test-fixtures/<kind>-<name>.json
// instead of the helper, so every status can be shown without the 0G router. Absent in normal use.
async function getJson(path, kind) {
  const fx = new URLSearchParams(location.search).get("fixture");
  const url = fx ? `test-fixtures/${kind}-${encodeURIComponent(fx)}.json` : path;
  const r = await fetch(url, { cache: "no-store" });
  return r.json();
}
function header(sub) {
  return el("header", { class: "top" }, el("a", { class: "brand", href: "./", text: "Ishara" }), el("span", { class: "tag", text: sub }));
}
function explainer(...paras) {
  return el("details", { class: "explain" }, el("summary", { text: "What is this page?" }), paras.map((p) => el("p", { text: p })));
}
