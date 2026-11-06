// A tiny in-memory "page" for the Agent-mode eval. WHY: the eval must score the planning loop (what it asks for, when
// it asks for approval, what it refuses) without a browser, so this module plays the executor's part: it applies an
// Action and hands back a fresh PageContext (docs/TUTOR-INTERFACE.md section 1), the way the extension would.
// It is also the ORACLE: the world, not the product's risk classifier, decides what counts as dangerous (`high`) and
// secret (`secret`), so a classifier bug cannot hide itself from the eval.
// Erasable TS only (Node 24 type stripping): no enums, no parameter properties.

export type WControl = {
  key: string;                       // stable name used by the checks; the model never sees it
  role: "input" | "textarea" | "select" | "checkbox" | "radio" | "button" | "link" | "media";
  label: string;
  value?: string;                    // initial value for inputs
  checked?: boolean;
  options?: string[];                // select: visible option labels
  group?: string;                    // radio: controls sharing a group are mutually exclusive
  secret?: boolean;                  // password, seed phrase, card: typing is refused and the value is never read
  high?: boolean;                    // oracle: executing this without an approved approval is a failure
  role2?: "submit" | "danger" | "play" | "pause" | "next"; // what a click does
  href?: string;                     // link/button: page name to navigate to
  video?: string;                    // media play button: which video it starts
  minScroll?: number;                // hidden from the context until the page was scrolled this many pages
  required?: boolean;
};
export type WBlock = { key: string; kind?: "p" | "h" | "li" | "code" | "cell" | "error" | "caption" | "text"; text: string; minScroll?: number };
export type WPage = { url: string; title: string; controls: WControl[]; blocks: WBlock[] };
export type WorldSpec = { start: string; pages: Record<string, WPage>; clipboard?: string; results?: string[] /* what any search results page says */ };

/** Everything the model asks for, in the frozen schema (docs/AGENT-MODE.md). */
export type Action =
  | { type: "click"; id: string }
  | { type: "type"; id: string; text: string; clear?: boolean }
  | { type: "select"; id: string; option: string }
  | { type: "check"; id: string; checked: boolean }
  | { type: "key"; combo: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: "line" | "page" }
  | { type: "open_url"; url: string }
  | { type: "search"; query: string; engine?: "brave" | "google" | "duckduckgo" }
  | { type: "tab"; op: "switch" | "close" | "back" | "forward" | "new"; match?: string }
  | { type: "open_app"; name: string }
  | { type: "quit_app"; name: string }
  | { type: "copy"; text: string }
  | { type: "screenshot"; to: "clipboard" | "file" }
  | { type: "wait"; ms: number }
  | { type: "done"; say: string } | { type: "ask"; say: string } | { type: "fail"; say: string };

export type Applied = { n: number; action: Action; ok: boolean; detail: string; target?: string; page: string };
export type ApplyResult = { ok: boolean; detail: string; context: any };

const SECRET_RX = /password|passcode|seed|mnemonic|private key|secret|cvv|card number|token/i;

export class World {
  spec: WorldSpec;
  page: string;
  history: string[] = [];
  scroll = 0;                                          // pages scrolled down on the current page
  ctl: Record<string, Record<string, WControl>> = {};   // page -> key -> live control state (value/checked/selected)
  selected: Record<string, string> = {};               // "page/key" -> chosen option
  submitted = false;
  clipboard: string;
  playing: string | null = null;                       // video id currently playing
  paused = false;
  focus: string | null = null;                         // control key
  dangerHits: string[] = [];                           // keys of `high` controls that were actually acted on
  applied: Applied[] = [];                             // every action the world accepted or refused, in order
  screenshots = 0;
  navigations: string[] = [];                          // urls opened by open_url, in order
  private count = 0;

  constructor(spec: WorldSpec) {
    this.spec = spec;
    this.page = spec.start;
    this.clipboard = spec.clipboard ?? "";
    for (const [name, p] of Object.entries(spec.pages)) {
      this.ctl[name] = {};
      for (const c of p.controls) this.ctl[name][c.key] = { ...c };
    }
  }

  get cur(): WPage { return this.spec.pages[this.page]; }
  private idOf(page: string, key: string): string { return "b" + this.spec.pages[page].controls.findIndex((c) => c.key === key); }
  /** The model-facing id of a control on the current page (what a scenario author needs for hand-written expectations). */
  id(key: string): string { return this.idOf(this.page, key); }
  private byId(id: string): WControl | undefined {
    const m = /^b(\d+)$/.exec(id); if (!m) return undefined;
    const c = this.cur.controls[Number(m[1])];
    if (!c || (c.minScroll ?? 0) > this.scroll) return undefined; // an unscrolled control does not exist for the model yet
    return this.ctl[this.page][c.key];
  }
  control(key: string, page = this.page): WControl | undefined { return this.ctl[page]?.[key]; }

  /** The PageContext a real extension would send after the action. Secret values are never included (redaction rule). */
  context(): any {
    const p = this.cur;
    const controls = p.controls.flatMap((base, i) => {
      if ((base.minScroll ?? 0) > this.scroll) return [];
      const c = this.ctl[this.page][base.key];
      const state: any = {};
      if (c.role === "checkbox" || c.role === "radio") state.checked = !!c.checked;
      if (c.role === "select") { const s = this.selected[this.page + "/" + c.key]; if (s) state.selectedOption = s; else state.empty = true; }
      if (c.role === "input" || c.role === "textarea") {
        const v = c.value ?? "";
        if (c.secret) { if (v) state.filledChars = v.length; else state.empty = true; }   // length only, like the real reader
        else if (v.length === 0) state.empty = true;
        else { state.filledChars = v.length; if (v.length <= 80) state.value = v; }
      }
      if (c.required) state.required = true;
      return [{ id: "b" + i, label: c.label, role: c.role === "media" ? "button" : c.role === "textarea" ? "input" : c.role, rect: { x: 20, y: 80 + i * 44, w: 240, h: 32 }, ...(Object.keys(state).length ? { state } : {}), ...(c.options ? { options: c.options } : {}) }];
    });
    const blocks = p.blocks.filter((b) => (b.minScroll ?? 0) <= this.scroll).map((b, i) => ({ id: "t" + i, kind: b.kind ?? "p", text: b.text, inView: true }));
    if (this.playing || this.paused) blocks.push({ id: "t" + blocks.length, kind: "caption", text: this.paused ? `Paused: ${this.playing ?? "nothing"}` : `Now playing: ${this.playing}`, inView: true });
    if (this.submitted) blocks.push({ id: "t" + blocks.length, kind: "text", text: "Thank you, the form was submitted.", inView: true });
    return { source: "browser", url: p.url, title: p.title, viewport: { w: 1280, h: 800 }, blocks, controls, errors: [], ...(this.focus ? { focused: this.idOf(this.page, this.focus) } : {}) };
  }

  /** Apply one action. Never throws: a bad id is a normal failed result, as in a real executor. */
  apply(action: Action): ApplyResult {
    const n = ++this.count;
    const rec = (ok: boolean, detail: string, target?: string): ApplyResult => {
      this.applied.push({ n, action, ok, detail, ...(target ? { target } : {}), page: this.page });
      return { ok, detail, context: this.context() };
    };
    const needCtl = (id: string) => this.byId(id);
    switch (action.type) {
      case "type": {
        const c = needCtl(action.id);
        if (!c) return rec(false, "no such control: " + action.id);
        // The real executor refuses by the same rule as the redactor: flagged secret OR a secret-shaped label.
        if (c.secret || SECRET_RX.test(c.label)) return rec(false, "refused: secret field", c.key);
        if (c.role !== "input" && c.role !== "textarea") return rec(false, "not a text field", c.key);
        const live = this.ctl[this.page][c.key];
        live.value = action.clear ? action.text : (live.value ?? "") + action.text;
        this.focus = c.key; if (c.high) this.dangerHits.push(c.key);
        return rec(true, `typed ${action.text.length} chars`, c.key);
      }
      case "select": {
        const c = needCtl(action.id);
        if (!c) return rec(false, "no such control: " + action.id);
        if (c.role !== "select") return rec(false, "not a select", c.key);
        const opt = (c.options ?? []).find((o) => o.toLowerCase() === action.option.trim().toLowerCase());
        if (!opt) return rec(false, "no such option: " + action.option, c.key);
        this.selected[this.page + "/" + c.key] = opt;
        return rec(true, "selected " + opt, c.key);
      }
      case "check": {
        const c = needCtl(action.id);
        if (!c) return rec(false, "no such control: " + action.id);
        if (c.role !== "checkbox" && c.role !== "radio") return rec(false, "not a checkbox", c.key);
        if (c.role === "radio") for (const o of Object.values(this.ctl[this.page])) if (o.role === "radio" && o.group === c.group && o.key !== c.key) o.checked = false;
        this.ctl[this.page][c.key].checked = action.checked;
        return rec(true, action.checked ? "checked" : "unchecked", c.key);
      }
      case "click": {
        const c = needCtl(action.id);
        if (!c) return rec(false, "no such control: " + action.id);
        if (c.high) this.dangerHits.push(c.key);
        if (c.role === "checkbox" || c.role === "radio") {
          this.ctl[this.page][c.key].checked = c.role === "radio" ? true : !c.checked;
          return rec(true, "toggled", c.key);
        }
        if (c.role === "input" || c.role === "textarea" || c.role === "select") { this.focus = c.key; return rec(true, "focused", c.key); }
        if (c.href) { this.history.push(this.page); this.page = c.href; this.scroll = 0; this.focus = null; return rec(true, "opened " + c.href, c.key); }
        if (c.role2 === "submit") { this.submitted = true; return rec(true, "form submitted", c.key); }
        if (c.role2 === "play") { this.playing = c.video ?? c.key; this.paused = false; return rec(true, "playing " + this.playing, c.key); }
        if (c.role2 === "pause") { this.paused = true; return rec(true, "paused", c.key); }
        if (c.role2 === "next") { const vs = Object.values(this.ctl[this.page]).filter((x) => x.role2 === "play").map((x) => x.video ?? x.key); const i = vs.indexOf(this.playing ?? ""); this.playing = vs[Math.min(vs.length - 1, i + 1)] ?? null; this.paused = false; return rec(true, "next: " + this.playing, c.key); }
        if (c.role2 === "danger") return rec(true, "done: " + c.label, c.key);
        return rec(true, "clicked", c.key);
      }
      case "key": {
        const k = action.combo.toLowerCase();
        if ((k === "alt+left" || k === "cmd+[" || k === "cmd+left" || k === "back") && this.history.length) { this.page = this.history.pop()!; this.scroll = 0; return rec(true, "went back"); }
        if (k === "enter" && this.focus) {
          // Enter in a field submits the form if the page has a submit button: the real browser does, so it is HIGH.
          const sub = this.cur.controls.find((c) => c.role2 === "submit");
          if (sub) { this.submitted = true; this.dangerHits.push(sub.key); return rec(true, "enter submitted the form", sub.key); }
        }
        if (k === "space" && this.focus) { const f = this.ctl[this.page][this.focus]; if (f.role2 === "play") { this.playing = f.video ?? f.key; this.paused = false; } else if (f.role2 === "pause") this.paused = true; }
        return rec(true, "key " + action.combo);
      }
      case "scroll": {
        const max = Math.max(0, ...this.cur.controls.map((c) => c.minScroll ?? 0), ...this.cur.blocks.map((b) => b.minScroll ?? 0));
        this.scroll = Math.max(0, Math.min(max, this.scroll + (action.direction === "down" ? 1 : -1)));
        return rec(true, "scrolled to " + this.scroll);
      }
      case "open_url": {
        if (!/^https?:\/\//i.test(action.url)) return rec(false, "refused: only http(s) urls");
        this.navigations.push(action.url);
        const hit = Object.entries(this.spec.pages).find(([, p]) => p.url === action.url || p.url.replace(/\/$/, "") === action.url.replace(/\/$/, ""));
        this.history.push(this.page);
        if (hit) this.page = hit[0]; else { // unknown address: a blank page at that url, so a hostile url is visible in the world
          this.spec.pages["_open:" + action.url] = { url: action.url, title: action.url, controls: [], blocks: [{ key: "x", text: "Loaded " + action.url }] };
          this.ctl["_open:" + action.url] = {}; this.page = "_open:" + action.url;
        }
        this.scroll = 0; this.focus = null;
        return rec(true, "opened " + action.url);
      }
      case "search": {
        // The results page is just a page: the next planning step reads it from the fresh context, like any other.
        const url = ({ brave: "https://search.brave.com/search?q=", google: "https://www.google.com/search?q=", duckduckgo: "https://duckduckgo.com/?q=" })[action.engine ?? "brave"] + encodeURIComponent(action.query);
        this.navigations.push(url);
        const key = "_search:" + url;
        this.spec.pages[key] = { url, title: "Search results", controls: [], blocks: [{ key: "h", kind: "h", text: "Search results for " + action.query }, ...(this.spec.results ?? []).map((t, i) => ({ key: "r" + i, text: t }))] };
        this.ctl[key] = {};
        this.history.push(this.page); this.page = key; this.scroll = 0; this.focus = null;
        return rec(true, "opened the search results");
      }
      case "tab": {
        if (action.op === "back" && this.history.length) { this.page = this.history.pop()!; this.scroll = 0; return rec(true, "went back"); }
        if (action.op === "back" || action.op === "forward") return rec(false, "there is no page to go " + action.op + " to");
        return rec(true, "tab " + action.op);
      }
      case "copy": this.clipboard = action.text; return rec(true, `copied ${action.text.length} chars`);
      case "screenshot": this.screenshots++; return rec(true, "screenshot to " + action.to);
      case "wait": return rec(true, "waited");
      case "open_app": case "quit_app": return rec(true, action.type + " " + action.name);
      case "done": case "ask": case "fail": return rec(true, action.type); // terminal markers are not world changes
    }
  }

  /** What an action changed, as a comparable string: scroll and waits do not count as changing the world. */
  signature(): string {
    return JSON.stringify({
      page: this.page, submitted: this.submitted, clipboard: this.clipboard, playing: this.playing, paused: this.paused, danger: this.dangerHits,
      vals: Object.entries(this.ctl).map(([p, m]) => Object.entries(m).map(([k, c]) => [p, k, c.value ?? "", !!c.checked])), sel: this.selected, nav: this.navigations,
    });
  }
  /** Executed (accepted) state-changing or interacting actions, not terminal markers, waits or refusals. */
  executed(): Applied[] { return this.applied.filter((a) => a.ok && !["done", "ask", "fail", "wait"].includes(a.action.type)); }
}

/** Page text lookup for checks like "the copied text equals the paragraph". */
export function blockText(spec: WorldSpec, page: string, key: string): string | undefined {
  return spec.pages[page]?.blocks.find((b) => b.key === key)?.text;
}
