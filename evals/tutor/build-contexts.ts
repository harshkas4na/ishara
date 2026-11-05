// Builds evals/tutor/contexts/*.json (PageContext, docs/TUTOR-INTERFACE.md section 1) so the fixtures are
// reproducible and hand-checkable. WHY a builder instead of only hand-edited JSON: a frozen context must match
// the page it claims to be, and the simple pages in test-pages/ are parsed from the very HTML a human can open.
//   - mock verify page: controls are the REAL outline captured through the extension (helper/.data/outlines), so
//     ids b6..b19 are exactly what scripts/eval.ts points at; blocks are parsed from test-pages/etherscan-verify.html.
//   - wikipedia / github / docs: controls are the real captured outlines (first N); text blocks were read off the
//     live pages with Claude in Chrome and trimmed to the visible lead (the repo README block is the repo's own words).
//   - the other pages are parsed from test-pages/*.html.
// Run: node evals/tutor/build-contexts.ts     (writes only json fixtures; never touches the network)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

type Rect = { x: number; y: number; w: number; h: number };
type Block = { id: string; kind: string; text: string; inView: boolean; rect: Rect };
type Control = { id: string; label: string; role: string; rect: Rect; state?: Record<string, unknown>; errorText?: string };
const VIEW = { w: 1470, h: 835 };
const clean = (s: string) => s.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

function fromHtml(file: string): { blocks: Block[]; controls: Control[]; title: string } {
  const html = readFileSync(file, "utf8");
  const title = clean(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "");
  const body = html.replace(/<head>[\s\S]*?<\/head>/i, "").replace(/<(script|style)[\s\S]*?<\/\1>/gi, "");
  const labelFor = new Map<string, string>();
  for (const m of body.matchAll(/<label for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)) labelFor.set(m[1], clean(m[2].replace(/<[^>]+>/g, "")));
  const blocks: Block[] = []; const controls: Control[] = [];
  let y = 80;
  let cur: { kind: string; text: string } | null = null; // the open text block
  let ctl: Control | null = null;                         // a link/button whose label is still being read
  let row: string[] | null = null; let cell: string | null = null;
  let inSelect = false;
  let wrapCheckbox: Control | null = null;                // checkbox inside a <label>: label text comes after it
  const push = (kind: string, text: string) => {
    text = clean(text); if (!text) return null;
    const b: Block = { id: "t" + blocks.length, kind, text: text.slice(0, 400), inView: y < VIEW.h, rect: { x: 360, y, w: 760, h: 28 } };
    blocks.push(b); y += 44; return b;
  };
  const add = (label: string, role: string, state?: Record<string, unknown>) => {
    const c: Control = { id: "b" + controls.length, label: clean(label), role, rect: { x: 360, y: (y += 4), w: 220, h: 32 } };
    if (state) c.state = state; controls.push(c); return c;
  };
  for (const m of body.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (m[4] !== undefined) {
      const t = m[4];
      if (inSelect) continue; // option texts are state of the select, not page text
      if (cell !== null) cell += t;
      if (cur) cur.text += t;
      if (ctl) ctl.label += t;
      continue;
    }
    const closing = m[1] === "/", tag = m[2].toLowerCase(), attrs = m[3] ?? "";
    const attr = (n: string) => attrs.match(new RegExp("\\b" + n + '="([^"]*)"'))?.[1];
    if (!closing) {
      if (/^h[1-3]$/.test(tag)) cur = { kind: "h", text: "" };
      else if (tag === "p") cur = { kind: "p", text: "" };
      else if (tag === "li") cur = { kind: "li", text: "" };
      else if (tag === "figcaption") cur = { kind: "caption", text: "" };
      else if (tag === "div" && /class="err"/.test(attrs)) cur = { kind: "error", text: "" };
      else if (tag === "label" && !cur) cur = { kind: "text", text: "" };
      else if (tag === "tr") row = [];
      else if (tag === "td" || tag === "th") cell = "";
      else if (tag === "a") ctl = add("", "link");
      else if (tag === "button") ctl = add("", "button");
      else if (tag === "input") {
        const type = attr("type") ?? "text"; const v = attr("value");
        const lab = labelFor.get(attr("id") ?? "") ?? attr("placeholder") ?? "";
        if (type === "checkbox") { const c = add(lab, "checkbox", { checked: /\bchecked\b/.test(attrs) }); if (!lab) wrapCheckbox = c; }
        // password fields: the contract's redaction rule, report state only, never the value
        else if (type === "password") add(lab || "Password", "input", { empty: true, filledChars: 0 });
        else add(lab, "input", v ? { filledChars: v.length, value: v } : { empty: true });
      } else if (tag === "select") {
        inSelect = true;
        const opt = clean(body.slice(m.index!).match(/<option[^>]*>([^<]*)<\/option>/)?.[1] ?? "");
        const lab = labelFor.get(attr("id") ?? "") ?? (cur?.kind === "text" ? clean(cur.text) : "select");
        add(lab, "select", { selectedOption: opt });
      } else if (tag === "textarea") add(labelFor.get(attr("id") ?? "") ?? "textarea", "input", { empty: true });
    } else {
      if (tag === "select") inSelect = false;
      else if (tag === "a" || tag === "button") { if (ctl) ctl.label = clean(ctl.label); ctl = null; }
      else if (tag === "td" || tag === "th") { row?.push(clean(cell ?? "")); cell = null; }
      else if (tag === "tr") { if (row) push("cell", row.join(" | ")); row = null; }
      else if ((/^h[1-3]$/.test(tag) || ["p", "li", "figcaption", "div", "label"].includes(tag)) && cur) {
        if (tag === "label" && cur.kind !== "text") continue;
        if (tag === "div" && cur.kind !== "error") continue;
        if (wrapCheckbox && tag === "label") { wrapCheckbox.label = clean(cur.text); wrapCheckbox = null; }
        else {
          const b = push(cur.kind, cur.text);
          // an error block belongs to the nearest earlier text input: mark it invalid and attach the message
          if (b && cur.kind === "error") {
            const inp = [...controls].reverse().find((c) => c.role === "input" && !c.errorText);
            if (inp) { inp.errorText = b.text; inp.state = { ...(inp.state ?? {}), invalid: true }; }
          }
        }
        cur = null;
      }
    }
  }
  return { blocks, controls, title };
}

function build(name: string, url: string, title: string, blocks: Block[], controls: Control[]) {
  const ctx = { source: "browser", url, title, viewport: VIEW, blocks, controls, errors: blocks.filter((b) => b.kind === "error").map((b) => b.id) };
  mkdirSync("evals/tutor/contexts", { recursive: true });
  writeFileSync(`evals/tutor/contexts/${name}.json`, JSON.stringify(ctx, null, 1) + "\n");
  console.log(name.padEnd(20), String(blocks.length).padStart(3), "blocks", String(controls.length).padStart(3), "controls");
}
function authored(rows: [string, string][]): Block[] {
  return rows.map(([kind, text], i) => ({ id: "t" + i, kind, text, inView: i < 9, rect: { x: 360, y: 90 + i * 70, w: 760, h: 44 } }));
}
function outlineControls(file: string, max: number): Control[] {
  const o = JSON.parse(readFileSync(file, "utf8"));
  return o.elements.filter((e: any) => e.role !== "text").slice(0, max).map((e: any) => ({ id: e.id, label: e.label, role: e.role, rect: e.rect }));
}

const LOCAL = "http://127.0.0.1:7777/test/";
{
  const h = fromHtml("test-pages/etherscan-verify.html");
  build("mock-verify", LOCAL + "etherscan-verify.html", h.title, h.blocks, outlineControls("helper/.data/outlines/http_127_0_0_1_7777_test_etherscan_verify_html.json", 40));
}
build("wikipedia-ethereum", "https://en.wikipedia.org/wiki/Ethereum", "Ethereum - Wikipedia", authored([
  ["h", "Ethereum"],
  ["p", "Ethereum is a decentralized blockchain with smart contract functionality. Ether (ETH) is the native cryptocurrency of the platform. Among cryptocurrencies, ether is second only to bitcoin in market capitalization."],
  ["p", "In 2022, Ethereum transitioned its consensus mechanism from proof-of-work (PoW) to proof-of-stake (PoS) in an update known as the Merge, which reduced Ethereum's energy usage by 99%."],
  ["p", "The idea of Ethereum was proposed by Vitalik Buterin in late 2013. Development was crowdfunded in 2014, and the network went live on 30 July 2015."],
  ["h", "History"],
  ["p", "Ethereum was conceived in 2013 by programmer Vitalik Buterin. Additional founders of Ethereum included Gavin Wood, Charles Hoskinson, Anthony Di Iorio and Joseph Lubin."],
  ["p", "In 2016, a smart contract called The DAO was exploited, and about 3.6 million ether was drained. The community chose a hard fork to reverse it, which created Ethereum Classic from the chain that did not fork."],
  ["h", "Design"],
  ["p", "Ethereum's code is run on the Ethereum Virtual Machine (EVM), and smart contracts are mostly written in Solidity. Users pay gas, denominated in gwei, to run transactions."],
  ["p", "Staking requires 32 ETH per validator. Validators propose and attest to blocks and can be penalised (slashed) for misbehaviour."],
  ["h", "Applications"],
  ["p", "Applications on Ethereum include decentralized finance (DeFi), non-fungible tokens (NFTs) and stablecoins."],
]), outlineControls("helper/.data/outlines/https_en_wikipedia_org_wiki_Ethereum.json", 45));
build("github-ishara", "https://github.com/harshkas4na/ishara", "GitHub - harshkas4na/ishara", authored([
  ["h", "ishara"],
  ["p", "Sealed screen tutor on 0G. A voice and a ring that point at the thing on your screen you asked about."],
  ["h", "Ishara"],
  ["p", "Ishara answers a spoken or typed question about the page you are on and rings the control you asked about. The decision runs on a sealed model on 0G Compute, and a second sealed model confirms the control before the ring moves."],
  ["h", "Run it"],
  ["code", "npm install"],
  ["code", "npm run helper"],
  ["li", "Load the extension folder unpacked from chrome://extensions with Developer mode on."],
  ["li", "Press the chord shown in the popup to ask a question."],
  ["h", "Known limits"],
  ["li", "If the sealed model is unreachable, Ishara says so and stops. It never answers from a local model."],
  ["li", "Voice is transcribed on the laptop; audio is never sent to the router."],
  ["li", "No screenshots, ever, by default."],
]), outlineControls("helper/.data/outlines/https_github_com_harshkas4na_ishara.json", 45));
build("solidity-docs", "https://docs.soliditylang.org/en/latest/", "Solidity — Solidity 0.8.39-develop documentation", authored([
  ["h", "Solidity"],
  ["p", "Solidity is an object-oriented, high-level language for implementing smart contracts. Smart contracts are programs that govern the behavior of accounts within the Ethereum state."],
  ["p", "Solidity is a curly-bracket language designed to target the Ethereum Virtual Machine (EVM). It is influenced by C++, Python, and JavaScript."],
  ["p", "Solidity is statically typed, supports inheritance, libraries, and complex user-defined types, among other features."],
  ["p", "With Solidity, you can create contracts for uses such as voting, crowdfunding, blind auctions, and multi-signature wallets."],
  ["p", "When deploying contracts, you should use the latest released version of Solidity. Apart from exceptional cases, only the latest version receives security fixes."],
  ["p", "Warning: The Solidity 0.8.x release introduced a lot of breaking changes. Make sure you read the full list."],
  ["p", "Ideas for improving Solidity or this documentation are always welcome, read our contributors guide for more details."],
  ["p", "Hint: You can download this documentation as PDF, HTML or Epub by clicking on the versions flyout menu in the bottom-left corner and selecting the preferred download format."],
]), outlineControls("helper/.data/outlines/https_docs_soliditylang_org_en_latest_.json", 50));
for (const name of ["wallet-connect", "error-page", "table-demo", "validation-form", "chart-demo", "long-article", "injection-canary"]) {
  const h = fromHtml(`test-pages/${name}.html`);
  build(name, LOCAL + name + ".html", h.title, h.blocks, h.controls);
}
