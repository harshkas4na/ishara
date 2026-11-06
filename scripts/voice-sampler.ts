// Voice sampler: speaks the same three sentences in each candidate voice, announcing the voice before each, so the
// choice of Hindi voice is made by ear. Plays through the RUNNING helper (POST /speech/say with voice + lang), so
// it is exactly what the product would sound like, with the same Kokoro and the same speakers.
//
//   node scripts/voice-sampler.ts                  every Hindi voice, 3 sentences each (about 1 minute)
//   node scripts/voice-sampler.ts hf_alpha hm_psi  only these voices
//   node scripts/voice-sampler.ts --en             also the English voices (af_heart, af_bella, am_adam)
//   node scripts/voice-sampler.ts --raw            Roman Hinglish also WITHOUT conversion (the "before" version)
//
// Then set the winner:  ISHARA_VOICE_HI=hf_beta npm run helper:desktop   (English: ISHARA_VOICE_EN=...)
// The helper must be running (it stops anything it was saying when the sampler starts).
const BASE = process.env.ISHARA_HELPER ?? "http://127.0.0.1:7777";
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const picked = args.filter((a) => !a.startsWith("--"));

const SENTENCES = {
  english: "Paste the contract address into the box, then press Send.",
  hindi: "यह कॉन्ट्रैक्ट एड्रेस वाला बॉक्स है, यहाँ एड्रेस डालिए।",
  hinglish: "ye contract address wala box hai, yahan address daalo",
};
const HINDI = ["hf_alpha", "hf_beta", "hm_omega", "hm_psi"];
const ENGLISH = ["af_heart", "af_bella", "am_adam"];
const voices = picked.length ? picked : [...HINDI, ...(flags.has("--en") ? ENGLISH : [])];

async function say(text: string, voice: string, lang: string, translit = true): Promise<void> {
  const r = await fetch(`${BASE}/speech/say`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, voice, lang, translit }) });
  if (!r.ok) throw new Error(`${voice}: ${r.status} ${await r.text()}`);
  // /speech/say returns at once; wait until the helper says the voice is quiet again before the next one.
  for (let i = 0; i < 400; i++) {
    await new Promise((res) => setTimeout(res, 150));
    const s = await (await fetch(`${BASE}/speech`)).json();
    if (!s.speaking && !s.queued) return;
  }
}

const h = await fetch(`${BASE}/speech`).then((r) => r.json()).catch(() => null);
if (!h?.ready || h.engine !== "kokoro") { console.error(`The helper at ${BASE} is not speaking with Kokoro (${JSON.stringify(h)}). Start it first.`); process.exit(1); }

for (const v of voices) {
  const lang = v.startsWith("h") ? "hi" : v.startsWith("b") ? "en-gb" : "en-us";
  console.log(`\n== ${v}`);
  await say(`Voice ${v.replace("_", " ")}.`, "af_heart", "en-us");   // the announcer is always the same English voice
  console.log("  English  ", SENTENCES.english);   await say(SENTENCES.english, v, lang);
  console.log("  Hindi    ", SENTENCES.hindi);     await say(SENTENCES.hindi, v, lang);
  console.log("  Hinglish ", SENTENCES.hinglish);  await say(SENTENCES.hinglish, v, lang);
  if (flags.has("--raw")) { console.log("  Hinglish, not converted"); await say(SENTENCES.hinglish, v, lang, false); }
}
console.log("\nDone. Pick one: ISHARA_VOICE_HI=<voice> (Hindi) and ISHARA_VOICE_EN=<voice> (English), then restart the helper.");
