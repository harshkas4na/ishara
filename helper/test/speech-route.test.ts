// The `speaking` SSE event end to end: the real /tutor route + the real speaker, with a fake synthesiser and player.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { handleTutorRoute } from "../src/tutor-route.ts";
import { createSpeaker, type Voice, type Playing } from "../src/speech.ts";

const ctx = { source: "browser", url: "http://x/", title: "t", viewport: { w: 1, h: 1 }, blocks: [], controls: [], errors: [] };
const SAYS = ["Paste the address in the box.", "Then press Send.", "ये बॉक्स है।", "Wait for the green banner"]; // last has no final stop

function build(muted = false) {
  const plays: string[] = [];
  const voice: Voice = {
    engine: "kokoro", synth: async (t) => "/f/" + t,
    play: (w): Playing => { plays.push(w); const done = new Promise<void>((r) => setTimeout(r, 15)); return { done, kill() {} }; },
  };
  const sp = createSpeaker({ start: async () => ({ voice }), stop() {}, readMuted: () => muted, writeMuted() {}, cleanup() {}, now: Date.now, enabled: true });
  async function* turn() {
    yield { event: "thinking", data: { mode: "explain" } };
    for (let i = 0; i < SAYS.length; i++) yield { event: "say", data: { seq: i, text: SAYS[i] } };
    yield { event: "done", data: { mode: "explain", outcome: "answered", requestIds: { laya: [] }, ms: { total: 1 } } };
  }
  // the same wiring as server.ts
  const deps = {
    turn, walk: turn,
    onStart: (emit: any) => { sp.interrupt(); sp.setHooks({ onSentenceStart: (seq, text) => emit("speaking", { seq, text }), onIdle: () => emit("speaking", { seq: null }) }); },
    onSay: (t: string, seq?: number) => { if (!sp.isMuted()) sp.enqueue(t, seq); },
    onEnd: () => sp.flush(),
  };
  return { sp, plays, deps };
}
function post(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const rq = request({ host: "127.0.0.1", port, method: "POST", path: "/tutor", headers: { host: "127.0.0.1:7777", "content-type": "application/json" } }, (rs) => {
      let b = ""; rs.setEncoding("utf8"); rs.on("data", (c) => (b += c)); rs.on("end", () => resolve(b));
    });
    rq.on("error", reject); rq.end(JSON.stringify({ sessionId: "s", question: "explain", context: ctx }));
  });
}
const events = (body: string) => body.split("\n\n").filter((x) => x.startsWith("event:")).map((x) => { const [e, d] = x.split("\n"); return [e.slice(7), JSON.parse(d.slice(6))] as [string, any]; });

async function run(muted: boolean) {
  const t = build(muted);
  const srv = createServer((req, res) => { handleTutorRoute(req, res, "/tutor", t.deps as any); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const body = await post((srv.address() as AddressInfo).port);
  srv.closeAllConnections(); srv.close();
  return { ...t, ev: events(body) };
}

test("speaking events arrive in order after their say, the trailing sentence is spoken, idle comes last, stream ends after idle", async () => {
  const { ev, plays, sp } = await run(false);
  const speaking = ev.filter(([n]) => n === "speaking").map(([, d]) => d);
  assert.deepEqual(speaking.map((d) => d.seq), [0, 1, 2, 3, null]);
  assert.equal(speaking[3].text, "Wait for the green banner");
  assert.equal(ev.at(-1)![0], "speaking"); assert.equal(ev.at(-1)![1].seq, null);   // after `done`, not before
  assert.ok(ev.findIndex(([n]) => n === "done") < ev.findIndex(([n, d]) => n === "speaking" && d.seq === null));
  assert.equal(plays.length, 4);
  assert.equal(sp.status().spoken, 4);   // ALL sentences, including the unpunctuated last one
});

test("muted: the answer streams, nothing is spoken, no speaking events", async () => {
  const { ev, plays } = await run(true);
  assert.equal(ev.filter(([n]) => n === "speaking").length, 0);
  assert.equal(plays.length, 0);
  assert.equal(ev.filter(([n]) => n === "say").length, 4);
});
