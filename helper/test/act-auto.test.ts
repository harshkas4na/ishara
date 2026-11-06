import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, autoMode, HARD_STOP } from "../src/act-risk.ts";
import { page } from "./act-helpers.ts";

// Auto mode (user asked for it 6 Nov 2026 after Approve prompts blocked "open YouTube"): a step that is only "might commit
// something" runs on the person's own order. Money, deletion, signing and wallet pages still wait for a tap.
const c = (label: string, role = "button") => classify({ type: "click", id: "b1" }, page([["b1", role, label]]), "do it");

test("auto is on by default and ISHARA_AUTO=0 turns it off", () => {
  const was = process.env.ISHARA_AUTO;
  delete process.env.ISHARA_AUTO; assert.equal(autoMode(), true);
  process.env.ISHARA_AUTO = "0"; assert.equal(autoMode(), false);
  if (was === undefined) delete process.env.ISHARA_AUTO; else process.env.ISHARA_AUTO = was;
});

test("an ordinary or unknown button is still HIGH but flagged auto", () => {
  for (const l of ["Search", "Create account", "Follow", "Apply", "Update", "Play on YouTube", "Go"]) {
    const r = c(l); if (r.risk === "high") assert.equal(r.auto, true, l);
  }
  assert.equal(c("Create account").risk, "high"); assert.equal(c("Create account").auto, true);
});

test("money, deletion, signing and wallets never auto-run", () => {
  for (const l of ["Delete account", "Buy now", "Pay", "Checkout", "Transfer funds", "Withdraw", "Swap", "Sign transaction", "Approve", "Connect wallet", "Place order", "Remove", "Log out", "Donate", "Stake", "Send message", "Post", "Publish", "Submit", "Reply"]) {
    const r = c(l); assert.equal(r.risk, "high", l); assert.notEqual(r.auto, true, l);
    assert.ok(HARD_STOP.test(l), l);
  }
});

test("Enter in a form auto-runs unless a money or delete button is on the page", () => {
  const harmless = classify({ type: "key", combo: "enter" }, page([["b1", "input", "Search"], ["b2", "button", "Go"]]), "search cats");
  assert.equal(harmless.risk, "high"); assert.equal(harmless.auto, true);
  const money = classify({ type: "key", combo: "enter" }, page([["b1", "input", "Card"], ["b2", "button", "Pay now"]]), "fill it");
  assert.equal(money.risk, "high"); assert.notEqual(money.auto, true);
});

test("things a page asked for, secrets, and addresses from the page are never auto", () => {
  const typed = classify({ type: "type", id: "b1", text: "hello world" }, page([["b1", "input", "Name"]]), "fill the form");
  assert.notEqual(typed.auto, true); // text the person never gave
  const q = classify({ type: "search", query: "something nobody said at all" }, page([]), "open youtube");
  assert.notEqual(q.auto, true);
  assert.equal(classify({ type: "quit_app", name: "Notes" }, page([]), "x").auto, undefined);
});

test("search operators the model adds are not 'words you did not say' (6 Nov: dogs site:wikipedia.org asked for approval)", () => {
  const s = classify({ type: "search", query: "dogs site:wikipedia.org", engine: "brave" }, page([]), "Open an article about dogs on Brave on Wikipedia");
  assert.equal(s.risk, "low");
  const invented = classify({ type: "search", query: "my bank statement password reset", engine: "brave" }, page([]), "open an article about dogs");
  assert.equal(invented.risk, "high"); assert.notEqual(invented.auto, true);
});

test("'close this window' and 'quit Notes' run on the person's order; unasked closing still asks", () => {
  const w = classify({ type: "key", combo: "cmd+w" }, page([]), "Can you close this window");
  assert.equal(w.risk, "high"); assert.equal(w.auto, true);
  assert.notEqual(classify({ type: "key", combo: "cmd+w" }, page([]), "summarise this page").auto, true);
  assert.notEqual(classify({ type: "key", combo: "cmd+q" }, page([]), "close this window").auto, true); // quitting needs "quit"/"exit"
  assert.equal(classify({ type: "key", combo: "cmd+q" }, page([]), "quit the app").auto, true);
  assert.equal(classify({ type: "quit_app", name: "Notes" }, page([]), "quit Notes").auto, true);
  assert.notEqual(classify({ type: "quit_app", name: "Notes" }, page([]), "open the dogs article").auto, true);
});

test("'close this window' with the front app named by the screen lets 'quit <that app>' run; another app still asks", () => {
  const calc = { ...page([]), app: "Calculator" } as any;
  assert.equal(classify({ type: "quit_app", name: "Calculator" }, calc, "close this window").auto, true);
  assert.notEqual(classify({ type: "quit_app", name: "Slack" }, calc, "close this window").auto, true); // not the app in front
  assert.notEqual(classify({ type: "quit_app", name: "Calculator" }, calc, "open the dogs article").auto, true);
});

test("levels: default runs every HIGH step; soft runs only the soft lane; 0 asks for all (6 Nov 2026: remove all approvals)", async () => {
  const { autoLevel, runsWithoutTap } = await import("../src/act-risk.ts");
  const was = process.env.ISHARA_AUTO;
  try {
    delete process.env.ISHARA_AUTO;
    assert.equal(autoLevel(), "all");
    assert.equal(runsWithoutTap({ risk: "high" }), true);              // even Delete / Buy / wallet steps
    assert.equal(runsWithoutTap({ risk: "refused" }), false);          // secrets and page-injected orders are refusals, never run
    assert.equal(runsWithoutTap({ risk: "medium" }), false);           // medium never asked in the first place
    process.env.ISHARA_AUTO = "soft";
    assert.equal(runsWithoutTap({ risk: "high" }), false); assert.equal(runsWithoutTap({ risk: "high", auto: true }), true);
    process.env.ISHARA_AUTO = "0";
    assert.equal(runsWithoutTap({ risk: "high", auto: true }), false);
  } finally { if (was === undefined) delete process.env.ISHARA_AUTO; else process.env.ISHARA_AUTO = was; }
});
