// Personal memory: redaction, cap, distill, recall, pause/forget, accepted/missed with a fake clock, routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Memory, redact, distill, recall, hostOf, memoryRoute, CONTEXT_MAX_CHARS, type MemEvent } from "../src/memory.ts";
import { refuse } from "../src/http-guard.ts";
import { decide } from "../src/decide.ts";

const fresh = (max?: number) => {
  const clock = { t: 1_000_000 };
  const m = new Memory(mkdtempSync(join(tmpdir(), "mem-")), () => clock.t, max);
  return { m, clock };
};
const ev = (kind: MemEvent["kind"], question: string, label?: string, host = "scan.example"): MemEvent =>
  ({ t: 1, kind, host, question, ...(kind === "ask" ? { outcome: "point" as const } : {}), ...(label ? { label } : {}) });

test("redact: keys, tokens, addresses, emails, long numbers, seed phrases", () => {
  const addr = "0x" + "ab12".repeat(10);
  assert.equal(redact(`verify ${addr} please`), "verify [redacted] please");
  assert.match(redact("my key is sk-abcdef1234567890XYZ ok"), /\[redacted\]/);
  assert.doesNotMatch(redact("my key is sk-abcdef1234567890XYZ ok"), /abcdef/);
  assert.doesNotMatch(redact("token ghp_abcdefghijklmnop1234"), /ghp_/);
  assert.doesNotMatch(redact("mail me at a.b@example.com"), /example/);
  assert.doesNotMatch(redact("card 4111 1111 1111 1111"), /4111/);
  assert.doesNotMatch(redact("Bearer abcdef0123456789abcdef"), /abcdef0123/);
  assert.doesNotMatch(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc"), /eyJ/);
  const seed = "witch collapse practice feed shame open despair creek road again ice least";
  assert.equal(redact(seed), "[redacted]");
  assert.equal(redact("where do I put the contract address"), "where do I put the contract address"); // ordinary text untouched
  assert.equal(redact("how do I get the thing to work on this page when it is open right now"), "how do I get the thing to work on this page when it is open right now");
});

test("hostOf keeps the host only", () => {
  assert.equal(hostOf("https://Etherscan.io/verifyContract?a=0xabc&token=secret#x"), "etherscan.io");
  assert.equal(hostOf("not a url"), "unknown");
  assert.equal(hostOf("app://Notes/window1"), "notes");
});

test("events are stored redacted, one JSON per line, without outline text", () => {
  const { m } = fresh();
  m.recordAsk("s", "scan.example", "check 0x" + "f".repeat(40), "point", "Contract address");
  const lines = readFileSync(join(m.dir, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const e = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(e).sort(), ["host", "kind", "label", "outcome", "question", "t"]);
  assert.equal(e.question, "check [redacted]");
});

test("cap: the oldest events are dropped, the newest kept", () => {
  const { m, clock } = fresh(5);
  for (let i = 0; i < 9; i++) { clock.t += 100_000; m.recordAsk("s" + i, "h", "question number " + i, "ask"); }
  const lines = readFileSync(join(m.dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.equal(lines[0].question, "question number 4");
  assert.equal(lines[4].question, "question number 8");
});

test("distill: aliases need >= 2 sightings of the same word and label", () => {
  const once = distill([ev("ask", "where is the wallet box"), ev("accepted", "where is the wallet box", "Contract address")]);
  assert.deepEqual(once.hosts["scan.example"].aliases, []);
  const twice = distill([
    ev("accepted", "where is the wallet box", "Contract address"),
    ev("accepted", "put wallet here", "Contract address"),
  ]);
  const a = twice.hosts["scan.example"].aliases;
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].word, a[0].label, a[0].count], ["wallet", "Contract address", 2]);
});

test("distill: topics (stemmed, stop words out), counts, last 5 distinct, typical length", () => {
  const evs = [
    ev("ask", "how do I verify"), ev("ask", "verifying the contract"), ev("ask", "verify again"),
    ev("ask", "how do I verify"), ev("ask", "pick a compiler"), ev("ask", "set the license please"), ev("ask", "upload the file"),
    ev("missed", "pick a compiler"), ev("accepted", "set the license please", "License"),
  ];
  const p = distill(evs);
  const h = p.hosts["scan.example"];
  assert.equal(h.asked, 7); assert.equal(h.missed, 1); assert.equal(h.accepted, 1);
  assert.equal(h.topics[0].count, 4); // verify / verifying / verify / verify share one stem
  assert.ok(!h.topics.some((t) => ["the", "how", "please"].includes(t.word)));
  assert.equal(h.lastQuestions.length, 5);
  assert.equal(new Set(h.lastQuestions).size, 5);
  assert.equal(h.lastQuestions[0], "upload the file"); // newest first
  assert.equal(typeof p.typicalQuestionWords, "number");
  assert.equal(p.typicalQuestionWords, 3);
});

test("recall: empty with no evidence, small, own words only, never another host", () => {
  const evs = [
    ev("ask", "where is the wallet box", undefined, "a.example"), ev("accepted", "wallet box", "Contract address", "a.example"),
    ev("accepted", "wallet field", "Contract address", "a.example"),
    ev("ask", "secret question on other site", undefined, "b.example"),
  ];
  const p = distill(evs);
  assert.equal(recall(p, "nowhere.example"), "");
  const a = recall(p, "a.example");
  assert.match(a, /wallet/);
  assert.match(a, /Contract address/);
  assert.doesNotMatch(a, /secret question/);
  assert.doesNotMatch(recall(p, "b.example"), /wallet/);
  // a huge history still fits the budget
  const big = distill(Array.from({ length: 50 }, (_, i) => ev("ask", "a very long question about the thing number " + i + " ".repeat(1) + "x".repeat(60), undefined, "c.example")));
  assert.ok(recall(big, "c.example").length <= CONTEXT_MAX_CHARS);
});

test("pause stops recording and recall; resume restarts; forget deletes files", () => {
  const { m } = fresh();
  m.recordAsk("s", "h.example", "first question", "ask");
  assert.ok(existsSync(join(m.dir, "events.jsonl")) && existsSync(join(m.dir, "profile.json")));
  assert.match(m.context("h.example"), /first question/);
  m.pause();
  m.recordAsk("s2", "h.example", "while paused", "ask");
  assert.equal(m.context("h.example"), "");
  assert.equal(m.view().counts.events, 1);
  m.resume();
  m.recordAsk("s3", "h.example", "after resume", "ask");
  assert.equal(m.view().counts.events, 2);
  m.forget();
  assert.ok(!existsSync(join(m.dir, "events.jsonl")) && !existsSync(join(m.dir, "profile.json")));
  assert.equal(m.view().counts.events, 0);
  assert.equal(m.context("h.example"), "");
  // and a new Memory over the same dir sees nothing
  assert.equal(new Memory(m.dir).view().counts.events, 0);
});

test("accepted: only within 20 s, only for the latest point, only once", () => {
  const { m, clock } = fresh();
  m.recordAsk("s", "h", "where is the address box", "point", "Contract address");
  clock.t += 10_000;
  assert.equal(m.recordAccepted("s", "h", "where is the address box"), true);
  assert.equal(m.recordAccepted("s", "h", "where is the address box"), false); // once
  clock.t += 100_000;
  m.recordAsk("s", "h", "and the license", "point", "License");
  clock.t += 40_000;
  assert.equal(m.recordAccepted("s", "h", "and the license"), false); // too late
  m.recordAsk("s", "h", "where is x", "ask");
  assert.equal(m.recordAccepted("s", "h", "where is x"), false); // an "ask" was not pointed at anything
  const kinds = m.view().counts;
  assert.equal(kinds.accepted, 1);
});

test("accepted for an older question is ignored", () => {
  const { m, clock } = fresh();
  m.recordAsk("s", "h", "first", "point", "A");
  clock.t += 2000;
  m.recordAsk("s", "h", "second", "point", "B"); // also logs "missed" for "first"
  assert.equal(m.recordAccepted("s", "h", "first"), false);
  assert.equal(m.recordAccepted("s", "h", "second"), true);
});

test("missed: a new ask on the same page within 30 s after an unaccepted answer", () => {
  const { m, clock } = fresh();
  m.recordAsk("s", "h", "where is it", "ask");
  clock.t += 20_000;
  m.recordAsk("s", "h", "where is the address box", "point", "Contract address");
  assert.equal(m.view().counts.missed, 1);
  assert.equal(m.getProfile().hosts["h"].missed, 1);
  clock.t += 5_000;
  m.recordAccepted("s", "h", "where is the address box");
  clock.t += 5_000;
  m.recordAsk("s", "h", "next thing", "ask"); // the previous was accepted: not missed
  assert.equal(m.view().counts.missed, 1);
});

test("missed: not after 30 s, not across sessions or hosts, not after a safe_stop", () => {
  const { m, clock } = fresh();
  m.recordAsk("s", "h", "q1", "ask");
  clock.t += 31_000;
  m.recordAsk("s", "h", "q2", "ask");
  m.recordAsk("other", "h", "q3", "ask");
  m.recordAsk("s", "h2", "q4", "ask");
  assert.equal(m.view().counts.missed, 0);
  clock.t += 31_000;
  m.recordAsk("s", "h", "q5", "safe_stop");
  clock.t += 1000;
  m.recordAsk("s", "h", "q6", "ask");
  assert.equal(m.view().counts.missed, 0);
});

test("routes: view, pause, resume, feedback, forget; unknown paths return null", () => {
  const { m, clock } = fresh();
  m.recordAsk("s", "h", "where is the address box", "point", "Contract address");
  clock.t += 1000;
  const view = memoryRoute(m, "GET", "/memory", "")!;
  assert.equal(view.status, 200);
  const body: any = view.body;
  assert.equal(body.counts.asked, 1);
  assert.equal(body.recent.length, 1);
  assert.ok(!JSON.stringify(body).includes("outline"));
  const fb: any = memoryRoute(m, "POST", "/memory/feedback", JSON.stringify({ sessionId: "s", host: "h", question: "where is the address box", kind: "accepted" }))!.body;
  assert.equal(fb.recorded, true);
  assert.equal(memoryRoute(m, "POST", "/memory/feedback", "{bad")!.status, 400);
  assert.equal(memoryRoute(m, "POST", "/memory/feedback", JSON.stringify({ kind: "other" }))!.status, 400);
  assert.equal((memoryRoute(m, "POST", "/memory/pause", "")!.body as any).paused, true);
  assert.equal((memoryRoute(m, "GET", "/memory", "")!.body as any).paused, true);
  memoryRoute(m, "POST", "/memory/resume", "");
  assert.equal(memoryRoute(m, "DELETE", "/memory", "")!.status, 200);
  assert.equal((memoryRoute(m, "GET", "/memory", "")!.body as any).counts.events, 0);
  assert.equal(memoryRoute(m, "PUT", "/memory", ""), null);
  assert.equal(memoryRoute(m, "GET", "/memory/other", ""), null);
});

test("route guard: the memory routes sit behind refuse() (foreign Host or Origin)", () => {
  // server.ts runs refuse() before any route; this pins the behaviour those routes rely on, including DELETE /memory.
  assert.equal(refuse("evil.example:7777", undefined), true);          // DNS rebinding
  assert.equal(refuse("127.0.0.1:7777", "https://evil.example"), true); // cross-site page
  assert.equal(refuse("127.0.0.1:7777", "http://127.0.0.1:7777"), false); // memory.html itself
  assert.equal(refuse("127.0.0.1:7777", undefined), false);            // curl
});

test("decide records the ask with the pointed label and host, and never the outline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-dec-"));
  process.env.ISHARA_MEMORY_DIR = dir; // memory() is created lazily, so this selects the throwaway store
  const { memory } = await import("../src/memory.ts");
  // the shared instance may already exist from another test file in this process; skip if it points elsewhere
  if (memory().dir !== dir) return;
  const outline = { url: "https://scan.example/verify?token=SECRET", viewport: { w: 1, h: 1 }, text: "[b1] input \"Contract address\"\nDO NOT STORE THIS", elements: [{ id: "b1", label: "Contract address", role: "input", rect: { x: 0, y: 0, w: 1, h: 1 } }] };
  await decide("sess", "where is the address", outline, { brain: async () => ({ ok: true, targetId: "b1", ms: 1 }), verify: async () => ({ ok: true, p: 0.9, ms: 1 }) });
  const raw = readFileSync(join(dir, "events.jsonl"), "utf8");
  assert.match(raw, /"host":"scan.example"/);
  assert.match(raw, /"label":"Contract address"/);
  assert.ok(!raw.includes("SECRET") && !raw.includes("DO NOT STORE"));
});

test("memory context reaches the brain only when ISHARA_MEMORY=1", async () => {
  const seen: (string | undefined)[] = [];
  const outline = { url: "https://ctx.example/", viewport: { w: 1, h: 1 }, text: "t", elements: [{ id: "b1", label: "Go", role: "button", rect: { x: 0, y: 0, w: 1, h: 1 } }] };
  const deps = { brain: async (_q: string, _t: string, c?: string) => { seen.push(c); return { ok: true as const, targetId: null, ms: 1 }; }, verify: async () => ({ ok: true as const, p: 0, ms: 1 }) };
  const { memory } = await import("../src/memory.ts");
  memory().recordAsk("pre", "ctx.example", "an earlier question here", "ask");
  delete process.env.ISHARA_MEMORY;
  await decide("x1", "q", outline, deps);
  process.env.ISHARA_MEMORY = "1";
  try { await decide("x2", "q", outline, deps); } finally { delete process.env.ISHARA_MEMORY; }
  assert.equal(seen[0], "");
  assert.match(seen[1] ?? "", /an earlier question here/);
});
