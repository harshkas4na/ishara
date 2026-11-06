// Which language a sentence is in, and which Kokoro voice should read it. Pure functions, unit tested.
//
// Why this exists: Kokoro's voice af_heart is an American-English voice. Hindi read by it is wrong. Kokoro ships
// Hindi voices (hf_alpha, hf_beta, hm_omega, hm_psi) but their phonemiser (espeak-ng, lang "hi") only understands
// DEVANAGARI. Measured on this Mac: "ye contract address wala box hai" in Roman letters through lang "hi" is
// read as English (hai -> "hi", ye -> "jee"). The same sentence in Devanagari gives true Hindi phonemes. So a
// Roman Hinglish sentence is first converted word by word (hinglishToDevanagari) and then spoken by the Hindi voice.
//
// Three outcomes: "en" (English voice), "hi" (Devanagari text, Hindi voice), "hinglish" (Roman Hindi: converted
// to Devanagari, then the Hindi voice). English words inside a Hinglish sentence stay Roman: the phonemiser tags
// them as English and the Hindi voice reads them the way a Hindi speaker says "contract" or "address".

export type Lang = "en" | "hi" | "hinglish";

// Words that are Hindi and cannot be English. Deliberately excludes look-alikes (me, to, do, he, so, is, ok, in),
// because one false positive makes an English sentence sound foreign, which is worse than a missed Hinglish one.
// Value = Devanagari spelling used for synthesis.
const H: Record<string, string> = {
  hai: "है", hain: "हैं", tha: "था", thi: "थी", ho: "हो", hoga: "होगा", hogi: "होगी", honge: "होंगे", hota: "होता", hoti: "होती", hote: "होते",
  ye: "ये", yeh: "यह", yah: "यह", ya: "या", wo: "वो", woh: "वो", vo: "वो", yahan: "यहाँ", yaha: "यहाँ", wahan: "वहाँ", waha: "वहाँ", vahan: "वहाँ",
  is: "इस", iss: "इस", us: "उस", isko: "इसको", usko: "उसको", isme: "इसमें", usme: "उसमें", isse: "इससे", usse: "उससे", iska: "इसका", uska: "उसका",
  ka: "का", ki: "की", ke: "के", ko: "को", se: "से", mein: "में", main: "मैं", mai: "मैं", pe: "पे", par: "पर", tak: "तक",
  aur: "और", lekin: "लेकिन", magar: "मगर", toh: "तो", bhi: "भी", sirf: "सिर्फ़", bas: "बस", phir: "फिर", fir: "फिर", kyunki: "क्योंकि",
  nahi: "नहीं", nahin: "नहीं", mat: "मत", na: "ना", haan: "हाँ", ji: "जी", achha: "अच्छा", accha: "अच्छा", theek: "ठीक", sahi: "सही", galat: "ग़लत",
  kya: "क्या", kaise: "कैसे", kyun: "क्यों", kyu: "क्यों", kahan: "कहाँ", kaun: "कौन", kitna: "कितना", kitne: "कितने", kab: "कब", kaunsa: "कौनसा",
  aap: "आप", aapko: "आपको", aapka: "आपका", aapki: "आपकी", aapke: "आपके", tum: "तुम", tumhe: "तुम्हें", tumhara: "तुम्हारा", mujhe: "मुझे", mera: "मेरा", meri: "मेरी", mere: "मेरे",
  hum: "हम", humein: "हमें", hamare: "हमारे", unka: "उनका", unko: "उनको", apna: "अपना", apni: "अपनी", apne: "अपने", khud: "ख़ुद",
  wala: "वाला", wali: "वाली", wale: "वाले", vala: "वाला", vali: "वाली", vale: "वाले",
  ek: "एक", teen: "तीन", char: "चार", paanch: "पाँच", pehla: "पहला", pehle: "पहले", dusra: "दूसरा", doosra: "दूसरा", baad: "बाद", abhi: "अभी", ab: "अब", jab: "जब", tab: "तब", jaldi: "जल्दी",
  karo: "करो", kijiye: "कीजिए", kijie: "कीजिए", karein: "करें", karna: "करना", karne: "करने", kar: "कर", karke: "करके", kiya: "किया", kare: "करे", karenge: "करेंगे", karta: "करता", karte: "करते", karni: "करनी",
  daalo: "डालो", dalo: "डालो", daaliye: "डालिए", daliye: "डालिए", daalein: "डालें", dabao: "दबाओ", dabaiye: "दबाइए", dabayein: "दबाएँ", likho: "लिखो", likhiye: "लिखिए", likhein: "लिखें",
  dekho: "देखो", dekhiye: "देखिए", dekhein: "देखें", dekhna: "देखना", chuno: "चुनो", chuniye: "चुनिए", chunein: "चुनें", kholo: "खोलो", kholiye: "खोलिए", kholein: "खोलें", band: "बंद",
  jao: "जाओ", jaiye: "जाइए", jayein: "जाएँ", jana: "जाना", aao: "आओ", aaiye: "आइए", aana: "आना", rakho: "रखो", rakhiye: "रखिए", lo: "लो", lijiye: "लीजिए", dijiye: "दीजिए",
  chahiye: "चाहिए", sakte: "सकते", sakta: "सकता", sakti: "सकती", milega: "मिलेगा", milegi: "मिलेगी", milta: "मिलता", mil: "मिल", raha: "रहा", rahi: "रही", rahe: "रहे",
  samajh: "समझ", samjhe: "समझे", samjho: "समझो", samjhiye: "समझिए", batao: "बताओ", bataiye: "बताइए", bataya: "बताया", batata: "बताता", pata: "पता", dikh: "दिख", dikhega: "दिखेगा", dikhta: "दिखता", dikhai: "दिखाई",
  upar: "ऊपर", neeche: "नीचे", niche: "नीचे", andar: "अंदर", bahar: "बाहर", saamne: "सामने", peeche: "पीछे", agla: "अगला", agli: "अगली", agle: "अगले", dobara: "दोबारा", ruko: "रुको", rukiye: "रुकिए", shuru: "शुरू",
  sab: "सब", sabhi: "सभी", kuch: "कुछ", koi: "कोई", bahut: "बहुत", thoda: "थोड़ा", zyada: "ज़्यादा", jyada: "ज़्यादा", kam: "कम", poora: "पूरा", pura: "पूरा", naya: "नया", nayi: "नई", purana: "पुराना",
  baat: "बात", kaam: "काम", jagah: "जगह", naam: "नाम", paise: "पैसे", cheez: "चीज़", tarika: "तरीका", wajah: "वजह", matlab: "मतलब", pehchaan: "पहचान", jawab: "जवाब", sawal: "सवाल",
  rupaye: "रुपये", rupay: "रुपये", din: "दिन", raat: "रात", mehnat: "मेहनत", sach: "सच", jhooth: "झूठ", dhyan: "ध्यान", sahayata: "सहायता", madad: "मदद", suraksha: "सुरक्षा", surakshit: "सुरक्षित",
  gaya: "गया", gayi: "गई", gaye: "गए", hua: "हुआ", hui: "हुई", hue: "हुए", liya: "लिया", diya: "दिया", mila: "मिला", bana: "बना", banao: "बनाओ", banaiye: "बनाइए", chalao: "चलाओ", chalu: "चालू",
};
// Look-alikes: Hindi words that are also English words or very short. They are converted inside a sentence already
// judged Hinglish ("kar do", "is box mein"), but never count as evidence that a sentence IS Hinglish.
const LOOKALIKE = new Set(["the", "do", "is", "us", "me", "to", "so", "ho", "ok", "in", "kar", "mil", "lo", "man", "pura", "dikh", "mat", "na", "ya", "ab", "tab", "jab", "kam", "band", "bas", "char", "din", "sab", "pe", "par", "main", "tak", "mai"]);

// Words that, on their own, are enough to call a sentence Hinglish: Hindi and not English at all.
const STRONG = new Set(Object.keys(H).filter((k) => !LOOKALIKE.has(k)));

const wordsOf = (s: string) => (s.toLowerCase().match(/[a-zऀ-ॿ']+/g) ?? []);

export function detectLang(text: string): Lang {
  const deva = (text.match(/[ऀ-ॿ]/g) ?? []).length;
  const letters = (text.match(/[A-Za-zऀ-ॿ]/g) ?? []).length;
  if (deva > 0 && deva >= letters * 0.3) return "hi"; // a Devanagari sentence, even with a few English words in it
  const w = wordsOf(text).filter((x) => /^[a-z']+$/.test(x));
  if (w.length < 2) return "en";
  const hits = w.filter((x) => STRONG.has(x)).length;
  // Two Hindi-only words and at least a fifth of the sentence: "ye box hai" counts, "Click the box" never does.
  return hits >= 2 && hits / w.length >= 0.2 ? "hinglish" : "en";
}

// Roman Hinglish -> Devanagari, word by word. Hindi words come from the table; everything else (English UI words,
// names, numbers) stays as it is for the phonemiser to tag as English. Punctuation passes through untouched.
export function hinglishToDevanagari(text: string): string {
  return text.replace(/[A-Za-z']+/g, (w) => H[w.toLowerCase()] ?? w).replace(/\.(?=\s|$)/g, "।"); // । is the Hindi full stop
}

// ---------- voice choice ----------

export const INSTALLED_VOICES = new Set([
  "af_heart", "af_bella", "af_nicole", "af_sarah", "af_sky", "af_alloy", "af_aoede", "af_jessica", "af_kore", "af_nova", "af_river",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
  "hf_alpha", "hf_beta", "hm_omega", "hm_psi",
]);
export const VOICE_LANG: Record<string, string> = { h: "hi", b: "en-gb", a: "en-us" };
export const langOfVoice = (v: string) => VOICE_LANG[v[0]] ?? "en-us";

export type VoicePick = { voice: string; lang: string; text: string };
export type VoiceConfig = { en: string; hi: string };
export function voiceConfig(env: Record<string, string | undefined> = process.env): VoiceConfig {
  const ok = (v: string | undefined, fallback: string) => (v && INSTALLED_VOICES.has(v) ? v : fallback);
  // ISHARA_VOICE stays the English override it always was; ISHARA_VOICE_EN wins if both are set.
  return { en: ok(env.ISHARA_VOICE_EN, ok(env.ISHARA_VOICE, "af_heart")), hi: ok(env.ISHARA_VOICE_HI, "hf_alpha") };
}
// What to synthesise for one sentence: the text (converted for Hinglish), the voice and the espeak language code.
export function pickVoice(sentence: string, cfg: VoiceConfig = voiceConfig()): VoicePick {
  const l = detectLang(sentence);
  if (l === "en") return { voice: cfg.en, lang: langOfVoice(cfg.en), text: sentence };
  return { voice: cfg.hi, lang: "hi", text: l === "hinglish" ? hinglishToDevanagari(sentence) : sentence };
}
