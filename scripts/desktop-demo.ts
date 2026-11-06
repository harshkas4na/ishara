// Try the desktop tutor on whatever app is in front.
//   node scripts/desktop-demo.ts "where is the save button"      real 0G calls: streams the answer, draws it, speaks it
//   node scripts/desktop-demo.ts --context [--app Name]          the PageContext summary (counts, tokens, first blocks); no 0G
//   node scripts/desktop-demo.ts --outline-only [--app Name]     the old pointing outline; no 0G, nothing drawn
//   --no-speak                                                    silent answer
// Click the app you want to ask about, then run this; use `sleep 3; node scripts/desktop-demo.ts ...` to leave time
// to switch windows (the terminal is the frontmost app when it starts, and the answer would be about the terminal).
import { desktopAsk, desktopContext, desktopOutline, overlay, summarizeContext } from "../helper/src/desktop.ts";

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(n);
const ai = argv.indexOf("--app");
const app = ai >= 0 ? argv[ai + 1] : undefined;
// The question is every word that is not a flag and not the value of --app. (The old filter dropped argv[0] whenever
// --app was absent, because it compared against ai + 1 = 0: the documented command silently asked nothing.)
const question = argv.filter((a, i) => !a.startsWith("--") && !(ai >= 0 && i === ai + 1)).join(" ").trim();

try {
  if (flag("--context")) {
    const c = await desktopContext({ app });
    console.log(summarizeContext(c.context, 10));
    console.log(`bundle ${c.bundleId}  ocr ${c.ocr}  ${c.timing ?? ""}`);
  } else if (flag("--outline-only") || !question) {
    const o = await desktopOutline({ app });
    console.log(`${o.url}  ${o.viewport.w}x${o.viewport.h}  elements: ${o.elements.length}`);
    console.log(o.text.split("\n").slice(0, 15).join("\n"));
    console.log(o.timing ?? "");
  } else {
    const r = await desktopAsk(question, { speak: !flag("--no-speak") });
    console.log(`outcome: ${r.outcome}  context: ${JSON.stringify(r.context)}`);
    console.log(`said: ${r.said.join(" ")}`);
    console.log(`pointed: ${r.pointed.join(", ") || "-"}  steps: ${JSON.stringify(r.steps)}`);
    console.log(`ms: context ${r.ms.context}, first sentence ${r.ms.firstSay ?? "-"}, total ${r.ms.total}`);
    await new Promise((res) => setTimeout(res, 6000)); // let the overlay draw and the voice finish before this process ends them
  }
} catch (e) {
  console.error((e as Error).message);
  process.exitCode = 1;
} finally {
  overlay.stop();
}
