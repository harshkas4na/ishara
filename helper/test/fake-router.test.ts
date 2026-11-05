// Tests for the development-only fake router and the ISHARA_ROUTER_URL override. They prove the mechanics work and,
// just as important, that the override cannot change production behaviour or leak the real key.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createFakeRouter, parseOutline, pick, layaP, overlap, FAKE_PROVIDER } from "../../test/fake-router/server.ts";
import { askBrain, askVerify, routerOverride, DEFAULT_BASE } from "../src/zg.ts";
import { decide } from "../src/decide.ts";
import type { Outline } from "../src/types.ts";

process.env.ISHARA_MEMORY_DIR = mkdtempSync(join(tmpdir(), "ishara-fake-mem-"));
const TEXT = [
  '[b1] link "Home"', '[b2] input "Search"', '[b3] input "Contract address" (text)',
  '[b4] select "Compiler version"', '[b5] checkbox "Agree to terms of service"', '[b6] button "Verify and Publish"',
].join("\n");
const els = parseOutline(TEXT);
const outline: Outline = { url: "http://127.0.0.1/x", viewport: { w: 1, h: 1 }, elements: els.map((e) => ({ ...e, rect: { x: 0, y: 0, w: 1, h: 1 } })), text: TEXT };

let server: ReturnType<typeof createFakeRouter>;
let base = "";
before(async () => {
  server = createFakeRouter();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => { server.closeAllConnections(); server.close(); delete process.env.ISHARA_ROUTER_URL; delete process.env.FAKE_ROUTER_MODE; });
const use = (mode = "ok") => { process.env.ISHARA_ROUTER_URL = base; process.env.FAKE_ROUTER_MODE = mode; };

test("overlap picking chooses the best label, or none", () => {
  assert.equal(pick("where do I put the contract address", els).el?.id, "b3");
  assert.equal(pick("how do I submit this for verification", els).el?.id, "b6");
  assert.equal(pick("pick the compiler version", els).el?.id, "b4");
  assert.equal(pick("purple elephants", els).el, null);
  assert.equal(overlap("", "x"), 0);
  assert.ok(layaP(1) >= 0.85 && layaP(0) <= 0.1);
});

test("brain call through the helper's own SSE reader: tag parsed, fake ids and provider present", async () => {
  use();
  const r = await askBrain("where is the contract address", TEXT);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.targetId, "b3");
  assert.equal(r.testRouter, true);
  assert.equal(r.provider, FAKE_PROVIDER);
  assert.match(r.chatId ?? "", /^chatcmpl-fake-/);
  assert.match(r.requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.ok((r.sentence ?? "").split(/\s+/).length <= 14);
  const none = await askBrain("purple elephants", TEXT);
  assert.ok(none.ok && none.targetId === null);
});

test("laya call: strong overlap high, none low, flagged", async () => {
  use();
  const hi = await askVerify("where is the contract address", els[2]);
  const lo = await askVerify("purple elephants", els[2]);
  assert.ok(hi.ok && hi.p >= 0.85 && hi.testRouter === true);
  assert.ok(lo.ok && lo.p <= 0.1);
});

test("testRouter flag propagates to the Decision and a clear question points", async () => {
  use();
  const d = await decide("fake-s1", "where do I put the contract address", outline);
  assert.equal(d.outcome, "point");
  assert.equal(d.targetId, "b3");
  assert.equal(d.testRouter, true);
});

test("mode=down gives safe_stop through decide(), still flagged", async () => {
  use("down");
  const d = await decide("fake-s2", "where do I put the contract address", outline);
  assert.equal(d.outcome, "safe_stop");
  assert.equal(d.testRouter, true);
});

test("mode=slow triggers the timeout cause", async () => {
  use("slow");
  const r = await askBrain("where is the contract address", TEXT, { timeoutMs: 400 });
  assert.deepEqual({ ok: r.ok, cause: !r.ok ? r.cause : null }, { ok: false, cause: "timeout" });
});

test("mode=flaky fails every third call", async () => {
  use("flaky");
  const res = [];
  for (let i = 0; i < 6; i++) res.push((await askVerify("contract address", els[2])).ok);
  assert.equal(res.filter((x) => !x).length, 2);
});

test("override ignored for a non-local host, with a warning", async () => {
  process.env.ISHARA_ROUTER_URL = "https://evil.example.com/v1";
  assert.equal(routerOverride(), null);
  process.env.ISHARA_ROUTER_URL = "http://127.0.0.1.evil.com/v1";
  assert.equal(routerOverride(), null);
  process.env.ISHARA_ROUTER_URL = "http://localhost:7791/v1/";
  assert.equal(routerOverride(), "http://localhost:7791/v1");
});

test("env unset: real base URL and the real key path are used, no testRouter mark", async () => {
  delete process.env.ISHARA_ROUTER_URL;
  const realFetch = globalThis.fetch;
  const seen: { url: string; auth: string }[] = [];
  globalThis.fetch = (async (url: string, init: any) => {
    seen.push({ url: String(url), auth: init?.headers?.authorization });
    return new Response(JSON.stringify({ answers: { right: { noul: 0.5 } } }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await askVerify("q", els[2]);
    if (seen.length) { // a key file exists on this machine
      assert.equal(seen[0].url, DEFAULT_BASE + "/decisions");
      assert.match(seen[0].auth, /^Bearer /);
      assert.notEqual(seen[0].auth, "Bearer fake-router-key");
      assert.ok(r.ok && !r.testRouter);
    } else { // no key file: the production path refuses before any network call
      assert.deepEqual(r, { ok: false, cause: "unavailable" });
    }
  } finally { globalThis.fetch = realFetch; }
});

test("override on: placeholder key is sent, never a real one", async () => {
  use();
  const realFetch = globalThis.fetch;
  let auth = "";
  globalThis.fetch = (async (url: string, init: any) => { auth = init.headers.authorization; return realFetch(url, init); }) as typeof fetch;
  try { await askVerify("contract address", els[2]); } finally { globalThis.fetch = realFetch; }
  assert.equal(auth, "Bearer fake-router-key");
});

test("words that are Object.prototype keys (constructor) do not crash the picker", () => {
  assert.equal(pick("where do I add constructor arguments", [{ id: "b14", role: "input", label: "Constructor Arguments (ABI-encoded, optional)" }]).el?.id, "b14");
});
