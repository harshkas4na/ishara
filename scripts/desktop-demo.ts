// Try the desktop adapter on whatever app is in front.
//   node scripts/desktop-demo.ts "where is the save button"      real 0G calls, draws the answer
//   node scripts/desktop-demo.ts --outline-only [--app Name]     only the outline, no 0G, nothing drawn
// Click the app you want to ask about, then run this; the terminal gets focus back only if you click it,
// so use `sleep 3; node scripts/desktop-demo.ts ...` to leave time to switch windows.
import { desktopAsk, desktopOutline, overlay } from "../helper/src/desktop.ts";

const argv = process.argv.slice(2);
const outlineOnly = argv.includes("--outline-only");
const ai = argv.indexOf("--app");
const app = ai >= 0 ? argv[ai + 1] : undefined;
const question = argv.filter((a, i) => !a.startsWith("--") && i !== ai + 1).join(" ");

try {
  if (outlineOnly || !question) {
    const o = await desktopOutline({ app });
    console.log(`${o.url}  ${o.viewport.w}x${o.viewport.h}  elements: ${o.elements.length}`);
    console.log(o.text.split("\n").slice(0, 15).join("\n"));
    console.log(o.timing ?? "");
  } else {
    const { decide } = await import("../helper/src/decide.ts"); // loaded only here: it reads the 0G key
    const r = await desktopAsk(question, decide);
    console.log(`outcome: ${r.decision.outcome}  say: ${r.decision.say}`);
    console.log(`overlay: ${JSON.stringify(r.overlay)}`);
    console.log(`ms: outline ${r.ms.outline}, decide ${r.ms.decide}, total ${r.ms.total}`);
    await new Promise((res) => setTimeout(res, 4000)); // let the overlay draw before this process ends it
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  overlay.stop();
}
