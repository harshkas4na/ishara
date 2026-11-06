import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLang, detectLangFull, hinglishToDevanagari, pickVoice, voiceConfig, langOfVoice, INSTALLED_VOICES } from "../src/speech-lang.ts";

test("language detection: English stays English, even with look-alike words", () => {
  for (const s of ["Click the blue Send button.", "Do it now, so ok.", "Paste the address into the box.", "Pass me the key", "Hello"])
    assert.equal(detectLang(s), "en", s);
});
test("language detection: Devanagari is Hindi, also with English words inside", () => {
  assert.equal(detectLangFull("यह बॉक्स है।"), "hi");
  assert.equal(detectLangFull("Send बटन दबाइए"), "hi");
  assert.equal(detectLangFull("नमस्ते"), "hi");
});
test("language detection: Roman Hinglish needs two Hindi-only words", () => {
  assert.equal(detectLangFull("ye contract address wala box hai, yahan address daalo."), "hinglish");
  assert.equal(detectLangFull("Pehle wallet connect karo, phir Send dabao."), "hinglish");
  assert.equal(detectLangFull("Ye box"), "en");              // one marker, short: not enough
  assert.equal(detectLangFull("The wala fruit"), "en");     // one marker in English
});
test("Hinglish -> Devanagari converts Hindi words, keeps English words and ends with the danda", () => {
  assert.equal(hinglishToDevanagari("ye contract address wala box hai, yahan address daalo."), "ये contract address वाला box है, यहाँ address डालो।");
  assert.equal(hinglishToDevanagari("Value is 3.5 hai"), "Value इस 3.5 है"); // a decimal point is not a full stop
});
test("voice config: defaults, ISHARA_VOICE as the English override, unknown names ignored", () => {
  assert.deepEqual(voiceConfig({}), { en: "af_heart", hi: "hf_alpha" });
  assert.deepEqual(voiceConfig({ ISHARA_VOICE: "af_bella" }), { en: "af_bella", hi: "hf_alpha" });
  assert.deepEqual(voiceConfig({ ISHARA_VOICE: "af_bella", ISHARA_VOICE_EN: "am_adam", ISHARA_VOICE_HI: "hm_omega" }), { en: "am_adam", hi: "hm_omega" });
  assert.deepEqual(voiceConfig({ ISHARA_VOICE_EN: "../../etc", ISHARA_VOICE_HI: "xx" }), { en: "af_heart", hi: "hf_alpha" });
});
test("voice selection per sentence", () => {
  const cfg = { en: "af_heart", hi: "hf_beta" };
  assert.deepEqual(pickVoice("Click Send.", cfg), { voice: "af_heart", lang: "en-us", text: "Click Send." });
  // English only (6 Nov 2026): Hindi and Hinglish sentences are also spoken by the English voice, untransliterated.
  assert.deepEqual(pickVoice("यह है।", cfg), { voice: "af_heart", lang: "en-us", text: "यह है।" });
  assert.equal(pickVoice("ye box hai", cfg).text, "ye box hai");
  assert.equal(pickVoice("ye box hai", cfg).lang, "en-us");
  assert.equal(detectLang("ye contract address wala box hai, yahan address daalo."), "en");
  assert.equal(langOfVoice("bf_emma"), "en-gb");
  assert.ok(INSTALLED_VOICES.has("hm_psi"));
});
