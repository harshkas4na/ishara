// npm run check: one REAL round trip to 0G (micro-dollars), then the offline path against a dead URL.
import { decide, realDeps } from "../helper/src/decide.ts";
import { askBrain, askLaya } from "../helper/src/zg.ts";
import type { Outline } from "../helper/src/types.ts";

const els = [
  ["b1", "link", "Home"], ["b2", "input", "Search"], ["b3", "input", "Contract address"],
  ["b4", "select", "Compiler type"], ["b5", "checkbox", "I agree to the terms"], ["b6", "button", "Continue"],
].map(([id, role, label], i) => ({ id, role, label, rect: { x: 10, y: 10 + i * 40, w: 200, h: 30 } }));
const outline: Outline = {
  url: "http://127.0.0.1:7777/test/smoke", viewport: { w: 1280, h: 800 }, elements: els,
  text: els.map((e) => `[${e.id}] ${e.role} "${e.label}"`).join("\n"),
};
const q = "where do I enter the contract address";

const d = await decide("smoke", q, outline);
console.log("REAL  outcome:", d.outcome, "target:", d.targetId, "| say:", d.say);
console.log("      requestIds:", JSON.stringify(d.requestIds), "ms:", JSON.stringify(d.ms), "| reason:", d.reason);

// Same code path, base URL that nothing listens on: must refuse, not guess.
const dead = { baseUrl: "http://127.0.0.1:9/v1" };
const off = await decide("smoke-off", q, outline, {
  brain: (qq, t) => askBrain(qq, t, dead),
  laya: (qq, ids, e) => askLaya(qq, ids, e, dead),
});
console.log("OFFLINE outcome:", off.outcome, "cause:", off.safeStopCause);
if (d.outcome === "point" ? d.targetId !== "b3" : false) { console.error("FAIL: wrong target"); process.exit(1); }
if (off.outcome !== "safe_stop" || off.safeStopCause !== "offline") { console.error("FAIL: offline path"); process.exit(1); }
void realDeps;
