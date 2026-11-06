// router.ts: the deterministic pre-router. Regex plus state, no model call. The mode it returns is only a HINT in the
// prompt: the model always gets the whole context, so a wrong guess costs a tone, never a refusal.
import type { TutorMode, WalkCmd } from "./types.ts";
import { isFollowUp } from "./convo.ts";

const norm = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

// Whole-utterance matches only: "next to the button, where?" must not count as "next".
const WALK: Array<[WalkCmd, RegExp]> = [
  ["next", /^(next|next step|continue|go on|go ahead|done|i m done|im done|finished|did it|skip|skip it|skip this|agla|agle|aage|aage badho|ho gaya|hogaya|kar liya|chalo)$/],
  ["back", /^(back|go back|previous|previous step|last step|peeche|pichla|pichhe|wapas)$/],
  ["repeat", /^(repeat|repeat that|again|say again|say that again|once more|dobara|phir se|fir se|dubara|repeat karo)$/],
  ["stop", /^(stop|cancel|quit|exit|end|enough|that s enough|ruko|band karo|bas|rehne do|ruk jao)$/],
  ["where", /^(where am i|where are we|which step|what step|what step is this|how many steps|kaun sa step|kahan tak)$/],
];
export function parseWalkCommand(question: string): WalkCmd | null {
  const q = norm(question).replace(/^(ok|okay|alright|haan|theek hai|ji)\s+/, "").replace(/\s+(please|ji|now)$/, "");
  for (const [cmd, re] of WALK) if (re.test(q)) return cmd;
  return null;
}

const GUIDE = /(walk me through|step by step|step-by-step|guide me|what do i do next|what should i do next|what do i do to|what s next|how (do|can|should) i (fill|complete|set up|run|connect|fix|use|start|try|install|deploy|verify|get started|begin|do this)|how to (run|connect|use|start|fix|fill)|help me (fill|complete|set|fix|start|get)|kaise karu|kaise karun|kaise bhar|kaise kare|kaise karte|kya karu|kya karun|aage kya|samjhate hue|step by step batao|ek ek karke)/;
const POINT = /how (do|can) i (choose|pick|select|submit|paste|put|enter|accept|click|press|upload|add)|(^|\s)(where|kahan|kaha|show me|dikhao|dikha do|find|locate|point|which (button|field|link|one|input|box|option))(\s|$)|where s |where is |kidhar|kaun ?sa|kon ?sa|konsa|konsi|kaun ?si/;

// Too little to act on ("help", "I am stuck"): the model is told to ask ONE short question instead of lecturing.
const VAGUE = /^(help|help me|help karo|help karo na|madad|madad karo|i m stuck|im stuck|i am stuck|stuck|what now|now what|what should i do|i need help|i dont know|i don t know|kuch samajh nahi aa raha|fas gaya|atak gaya)$/;
export const isVague = (q: string): boolean => VAGUE.test(norm(q));

export type Route = { kind: "walk"; cmd: WalkCmd } | { kind: "ask"; mode: TutorMode; vague?: true };

export function routeQuestion(o: { question: string; requested?: "auto" | "point" | "explain" | "guide"; hasHistory: boolean; walkActive: boolean }): Route {
  if (o.walkActive) { const cmd = parseWalkCommand(o.question); if (cmd) return { kind: "walk", cmd }; }
  // An explicit mode from the UI (a button) wins; the regexes only decide for "auto".
  if (o.requested && o.requested !== "auto") return { kind: "ask", mode: o.requested };
  const q = norm(o.question);
  if (isVague(o.question) && !o.hasHistory) return { kind: "ask", mode: "explain", vague: true };
  if (GUIDE.test(q)) return { kind: "ask", mode: "guide" };
  if (o.hasHistory && isFollowUp(o.question)) return { kind: "ask", mode: "follow-up" };
  if (POINT.test(q)) return { kind: "ask", mode: "point" };
  return { kind: "ask", mode: "explain" };
}
