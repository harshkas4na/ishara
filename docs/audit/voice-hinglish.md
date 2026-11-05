# Audit: Hinglish voice input

Complaint: "English plus Hindi voice is not working at all, it hears it as noise." Plain English works.
Labels: **[measured]** run on this Mac on 2026-11-06, **[inferred]** reasoned from code or docs, **[unknown]** not testable here.

## Headline

The product pins Whisper to English (`-l en`, `helper/src/whisper.ts`). Under that flag a Hindi or Hinglish sentence is
forced through the English decoder and comes out as plausible but wrong English. "ye error ka matlab kya hai" became
"Why error command lags?" and "constructor arguments kahan bharne hain" became "Constructor arguments can burn hen."
[measured] The model is not hearing noise, it is mis-hearing words, and 0GM then gets nonsense. Three smaller guard
problems sit on top. The fix is a one-line model swap plus one flag, and it fits the latency budget.

**Caveat, stated plainly:** every clip below is macOS text-to-speech (Lekha for Hindi-voiced text, Rishi for
English-voiced text). Synthetic voices are an imperfect proxy: they are clean, evenly paced and loud, and Lekha reads
English words with a Hindi accent, which is actually the hard case. Real accents, room noise and a MacBook mic will
move every number. Treat the table as a ranking of configurations, not as Harsh's accuracy. Section 8 is the script for
him to record so the table can be re-run on his real voice.

## 1. How voice works today [read from code]

- `extension/offscreen.js`: `getUserMedia({channelCount:1, echoCancellation:true, noiseSuppression:true})`, an
  `AudioContext` at 16 kHz, per-buffer RMS tracked as `maxRms`, WAV encoded at 16 kHz mono.
- `extension/background.js` `rec-stop`: refuses under 4000 samples (0.25 s) and `maxRms < 0.006`, then POSTs the WAV to
  the helper `/transcribe` with the page labels in `x-prompt`.
- `helper/src/whisper.ts`: `whisper-server -m ggml-small.bin -l en --port 7778 -nt`, multilingual small (488 MB),
  `temperature=0`, prompt passed per request. Language is hard-pinned to English.
- `extension/content.js` line 114/145 and `helper/src/desktop-ptt.ts` line 18/71: `NOISE = /^(you|thank you|thanks|
  thanks for watching|bye|okay|ok|the|uh|um|hmm|\.+)\W*$/i`, and `text.length < 3` is "probably noise".
- `docs/DECISIONS.md` decision 1: local whisper.cpp, 0.3 to 1.2 s, nothing leaves the machine, primed with page labels
  (fixed "Etherscan"). That decision is correct; only the model and language choice need to change.

## 2. Models on this Mac [measured]

| Path | File | Size |
|---|---|---|
| `~/.cache/whisper-models/` | ggml-small.bin (multilingual, in use), ggml-small.en.bin, ggml-base.bin | 488 / 488 / 148 MB |
| `~/.cache/meeting-recorder/models/` | ggml-large-v3-turbo.bin | 1.62 GB (f16) |
| same | ggml-hindi2hinglish-apex-q8_0.bin | 874 MB |
| same | ggml-hindi2hinglish-apex-f16.bin | 1.62 GB |
| `~/.medit/models/` | ggml-base.en.bin, ggml-small.en.bin | English only, useless here |

meeting-recorder (`README.md`) runs Apex (Oriserve Whisper-Hindi2Hinglish-Apex, a large-v3-turbo fine-tune) for its
Hindi lane. It outputs **romanized Hinglish**, which is why it is the Hindi default there, and notes `-l hi` is for
Devanagari from stock turbo. It passes a vocabulary prompt to whisper. It also documents Apex as slow (0.73x realtime,
q8 costs speed on Metal), which matches what I saw until the `-ac` flag below. Design only used here, no code copied.

Useful flags (`whisper-server --help`): `-l auto|hi|en`, `--prompt` (and per-request `prompt` field), `-tr` translate,
`-ac N` audio context (default 0 = 1500 frames = 30 s), `-nth` no-speech threshold, `-sns` suppress non-speech tokens.

## 3. Test set

23 clips, 16 kHz mono WAV (`say -o x.aiff`, `afconvert -f WAVE -d LEI16@16000 -c 1`):

- 10 Roman Hinglish (h01 to h10), spoken by Lekha, e.g. "yeh contract address kahan daalna hai",
  "is page pe compiler version kaise choose karte hain", "ye error ka matlab kya hai", "verify and publish ka button
  kahan hai", "license type mein kaunsa option select karun", "terms of service wala checkbox kahan hai".
- 4 Devanagari Hindi (d01 to d04), e.g. "यह कॉन्ट्रैक्ट एड्रेस कहाँ डालना है", "इस एरर का मतलब क्या है".
- 3 mixed with Rishi (m01 to m03): "where do I paste the contract address", "yeh compiler version wala dropdown kahan
  hai", "which license should I choose for this contract".
- 3 English controls (e01 to e03), 3 short answers: "haan", "kya", "ok".

**Scoring.** Word error rate on a normalised skeleton so spelling variation and script do not count as errors:
lowercase, strip punctuation, map Devanagari letters to Latin, then reduce every word to its consonant skeleton (drop
vowels and `h`, `ph->f`, `c/q->k`, `w->v`, `z->j`, collapse doubles). "kahan", "kahaan" and "कहाँ" all become `k`.
So the score measures "did it hear the right word", not "did it pick Harsh's spelling". It is lenient on vowels, so
treat it as a ranking. Columns: Hinglish = h01 to h10 plus m02; Deva = d01 to d04 (reference in Devanagari);
English = e01 to e03, m01, m03; Short = the three short clips. `Deva out` = clips that came out in Devanagari or other
non-Latin script. Seconds = mean warm per clip.

## 4. Results (23 clips, WER on skeleton, lower is better)

Latency here is from the main run, taken while the machine was heavily loaded (load average 8 to 11, 170 MB free),
so large models look worse than they are. The "clean" column re-times 8 clips at load ~3 and is the number to use.

| Config | prompt | Hinglish | Deva | English | Deva out | s/clip loaded | s/clip clean | Memory |
|---|---|---|---|---|---|---|---|---|
| small `-l en` (TODAY) | no | 66% | 100% | 0% | 0/23 | 0.66 | 0.55 to 0.9 | ~600 MB RSS |
| small `-l en` | yes | 60% | 90% | 0% | 0/23 | 0.65 | same | same |
| small `-l auto` | no | 53% | 19% | 0% | 11/23 | 1.95 | n/a | same |
| small `-l auto` | yes | 62% | 38% | 0% | 6/23 | 2.11 | n/a | same |
| small `-l hi` | no | 67% | 19% | 68% | 23/23 | 3.57 | n/a | same |
| small `-l hi` | yes | 53% | 38% | 0% | 6/23 | 1.39 | n/a | same |
| turbo `-l auto` | no | 37% | 10% | 0% | 14/23 | 5.8 | 2.3 to 2.9 | ~1.85 GB RSS |
| turbo `-l auto` | yes | 26% | 52% | 0% | 9/23 | 5.9 | same | same |
| turbo `-l hi` | no | 37% | 10% | 79% | 22/23 | 2.9 | same | same |
| apex q8 `-l auto` | no | 36% | 48% | 0% | 0/23 | 5.0 | n/a | file 874 MB |
| apex q8 `-l auto` | yes | 34% | 48% | 0% | 0/23 | 5.3 | n/a | same |
| apex q8 `-l hi` | no | 40% | 48% | 53% | 1/23 | 2.8 | n/a | same |
| apex q8 `-l en` | no | 36% | 48% | 0% | 0/23 | 2.6 | 2.6 to 2.9 | same |
| apex q8 `-l en` | yes | 34% | 48% | 0% | 0/23 | 2.6 | same | same |
| **apex q8 `-l en -ac 512`** | no | 32% | 48% | 0% | 0/23 | 0.68 | 0.62 to 1.04 | same |
| **apex q8 `-l en -ac 512`** | **yes** | **29%** | 48% | **0%** | 0/23 | **0.82** | 0.6 to 1.0 | same |
| apex q8 `-l en -ac 768` | yes | 29% | 48% | 0% | 0/23 | 1.09 | n/a | same |
| turbo `-l hi -ac 512` | yes | 42% | 52% | 0% | 9/23 | 0.99 | n/a | same |
| small `-l en -ac 512` | yes | 64% | 86% | 0% | 0/23 | 0.22 | 0.13 to 0.26 | same |

Reading it:

1. **`-l en` is the bug.** Hinglish 60 to 66% word errors and Devanagari input 90 to 100% (the English decoder cannot
   output Hindi, it invents English). Examples [measured]: "Verify and publish button is on." for "verify and
   publish ka button kahan hai", "The Storm's observance is a check box." for the terms-of-service line. This reads as
   noise to the user and as nonsense to 0GM.
2. **Auto-detect and `-l hi` on small are worse in a different way.** Small `auto` picked Urdu script for h08 and
   Devanagari for many Hinglish clips; `-l hi` turns English into Devanagari transliteration (English WER 68%, short
   clips 100 to 267%). Turbo does the same (`-l hi` English 79%). Plain English only survives because the clips are
   long enough for the detector to choose English. A bilingual speaker mixing languages per sentence needs one fixed
   setting that handles both.
3. **Apex is the only model that keeps both worlds in one script.** It outputs Roman Hinglish for Hindi and normal
   English for English, **0 of 23 clips in Devanagari** (with `-l en` or `auto`), and English control WER stays 0%.
   Forcing `-l en` on Apex does not break it, because the model was tuned to emit Roman text; it removes the
   language-detect pass and the Devanagari/Urdu risk. `-l hi` on Apex still misrenders English (53% without prompt).
4. **`-ac 512` is the latency fix.** whisper.cpp encodes a fixed 30 s window per request; `-ac 512` (10.24 s) cuts
   Apex from ~2.7 s to ~0.7 to 0.8 s with no accuracy loss on these clips (29 to 32% vs 34 to 36%).
5. **The vocabulary prompt helps** slightly on Apex (36 to 34, 32 to 29) and on turbo auto (37 to 26), and helped
   English terms ("Verify and publish ka button kahan hai" was correct only with the prompt under `-ac 512`).
6. The 48% in the Deva column for Apex is partly a scoring artifact: the reference is Devanagari, Apex answers in
   Roman, and my transliteration is rough. Hearing quality for d01, d03 is fine ("Yah contract address kahaan
   daalna hai?", "Is error ka matlab kya hai?") but "कंपाइलर वर्शन" lost a word and "वेरिफाई बटन" became "Virikhai
   button". Small residual error, mostly on English words said with a Hindi accent.

Remaining Apex errors [measured]: "ye error" -> "Y e error ka matlab ki high", "kitne runs rakhne" -> "Kitten raghan",
"terms of service" -> "Storms of service", "constructor arguments kahan bharne hain" -> truncated to "Constructor
arguments". The last one is a dropped tail on a 2.7 s clip; unknown whether it is the TTS or `-ac`.

## 5. What 0GM-1.0 and laya do with Hinglish [measured, 12 real router calls]

Request shape copied from `helper/src/zg.ts` (`0gm-1.0-35b-a3b`, `enable_thinking:false`, private trust mode), outline
`helper/.data/outlines/http_127_0_0_1_7777_test_etherscan_verify_html.json`.

| Question | Wanted | 0GM pointed at | ms |
|---|---|---|---|
| yeh contract address kahan daalna hai | b6 | b6, OK | 3064 (cold) |
| is page pe compiler version kaise choose karte hain | b8 | b8, OK | 2154 |
| verify and publish ka button kahan hai | b17 | b17, OK | 1269 |
| यह कॉन्ट्रैक्ट एड्रेस कहाँ डालना है | b6 | b6, OK | 1161 |
| कंपाइलर वर्शन कैसे चुनते हैं | b8 | b8, OK | 1212 |
| मुझे sign in ka link nahi mil raha | b4 | b4, OK | 1171 |

**6 of 6.** 0GM understands Roman Hinglish and Devanagari and even answers in Hinglish ("Contract address [b6] mein
daalein."). The brain is not the problem. Note the visible sentence will then be Hinglish, which is good for this user.

laya yes/no (`/decisions`, threshold `VERIFY_MIN_P = 0.4` in `helper/src/config.ts`):

| Question | Proposed control | p | Result |
|---|---|---|---|
| yeh contract address kahan daalna hai | Contract Address (right) | 0.84 | pass |
| same | Verify and Publish (wrong) | 0.0004 | veto, correct |
| where do I paste the contract address (English control) | Contract Address | 0.71 | pass |
| same | Verify and Publish | 0.05 | veto |
| कंपाइलर वर्शन कैसे चुनते हैं | Compiler Version (right) | **0.22** | **vetoed wrongly (below 0.4)** |
| same | License Type (wrong) | 0.215 | veto |

**Roman Hinglish is fine for laya. A Devanagari question is not**: the right control scored p=0.22, no better than a
wrong one, so the gate would say "I won't guess" on a correct answer. One sample, so [measured, n=1] but it matches
the pattern, so treat Devanagari to laya as unsafe. Another reason to want Roman output from the transcriber.

## 6. Guards, false positives [measured + read from code]

- `text.length < 3`: "ok" (2) is dropped, "haan" (4), "kya" (3), "Han" (3) pass. [read]
- NOISE regex drops "ok", "okay", "Ok.", "Okay." (Apex heard clip s03 as "Ok." and small as "Okay.") and
  "thanks". A lone "ok" is not a question to a one-shot pointer, so dropping it is defensible, but the user sees
  "probably noise", which is the same wording as the complaint. [read + measured]
- **Gaps in the other direction:** `[BLANK_AUDIO]` (small `-l en` output for "kya") passes the regex and goes to
  0GM; Apex returned "nan" and "and" for the 0.38 s "kya" clip; turbo returned "和" and "Пока" for short clips;
  Whisper's Hindi hallucinations ("धन्यवाद", "शुक्रिया", "Dhanyavaad", "subtitles by") are not in the list. [measured for
  the first three, inferred for the Hindi stock phrases]
- **Loudness floor 0.006** (about -44 dBFS): the synthetic clips measured windowed max RMS 0.18 to 0.25, which is
  not representative (TTS is normalised loud). Normal speech on a MacBook mic is typically about 0.02 to 0.1 and soft
  speech about 0.01 to 0.03 [inferred, not measured on a person]. The floor is roughly 3 to 10 times below even quiet
  speech, so it should not drop a quiet voice unless Chrome's `noiseSuppression` flattens soft speech or the mic is
  muted/far [unknown: needs a real recording]. The user saw "probably noise", not "I could not hear any sound", which
  also points away from the floor and toward the transcript/NOISE path.
- Quiet-voice gain: the clips go to Whisper unnormalised. [unknown] whether peak-normalising soft recordings helps.

## 7. Recommendation

1. **Model: Apex q8** (`ggml-hindi2hinglish-apex-q8_0.bin`, 874 MB) as primary; keep `ggml-small.bin` as the fallback
   when the Apex file is absent. [measured: 29% vs 60% Hinglish WER, equal on English, 0 Devanagari out, 0.82 vs 0.65 s]
2. **Flags:** `-l en -ac 512 -nt` plus the per-request page-label prompt (unchanged). Keep `-l en` rather than `auto`:
   auto adds ~2 s on this Mac and gave Urdu/Devanagari on small; on Apex `-l en` and `auto` scored the same [measured].
   Do not use `-l hi`. Add `-sns` (suppress non-speech tokens) to cut `[BLANK_AUDIO]` [inferred, untested].
3. **Prime:** keep the labels prompt. Add a few Hinglish function words so the decoder is not surprised, e.g.
   "kahan, kaise, kya, matlab, daalna, chunna, button, dropdown" [unknown: untested, test with Harsh's recording].
4. **Script normalisation:** none needed if Apex is used (Roman out). For the small fallback only, a Devanagari
   output must not reach laya: either pass 0GM's own English gloss to laya, or skip laya's veto when the question has
   Devanagari [inferred from the n=1 result]. 0GM handles Devanagari fine.
5. **Clip length cap:** `-ac 512` means about 10 s. Cap the hold-to-talk recording at 9 s in `extension/offscreen.js`
   (and the desktop recorder) and say so in the overlay. Behaviour on a longer clip is [unknown].
6. **Guards:** in `extension/content.js` and `helper/src/desktop-ptt.ts` (they duplicate the regex; share one):
   (a) lower the length rule to `< 2` or remove it; (b) show "I heard 'ok', ask a full question" rather than "probably
   noise" for ok/okay; (c) add to NOISE: `\[.*\]` (BLANK_AUDIO, MUSIC), `nan`, `and` as sole word, `dhanyavaad`,
   `shukriya`, `धन्यवाद`, `शुक्रिया`; (d) reject text whose letters are not mostly Latin or Devanagari (turbo "和", "Пока").
   Log `maxRms` of every take to the helper so a real quiet voice can be measured; keep 0.006 for now.
7. **Code changes:** `helper/src/whisper.ts` (`MODEL` choice with `existsSync` fallback; args
   `["-m", MODEL, "-l", "en", "-ac", "512", "-sns", ...]`; `-ac` only for Apex since small is already fast and `-ac 512`
   cut small accuracy slightly on Hinglish, 60 to 64%); `extension/content.js` and `helper/src/desktop-ptt.ts` (guards
   above); optionally `extension/offscreen.js` (9 s cap). Public repo: the Apex file is not in the repo and lives
   outside it, so `README` must give the download/convert step (Oriserve/Whisper-Hindi2Hinglish-Apex via
   meeting-recorder's `meeting.mjs apex`) and the fallback must be silent and honest ("English-only voice").
8. **Latency budget (target 1.2 s warm, voice step only):** Apex q8 `-ac 512` with prompt measured 0.6 to 1.04 s per
   2 to 3 s clip at load 3 to 5 [measured]; 0.82 s mean at the full-set run. Fits, with limited headroom; on a loaded
   machine plus memory pressure (this Mac had 170 MB free) it can slip. Warm the server at helper start as today.
   Model load 0.6 to 0.9 s [measured]. Memory: Apex q8 about 0.9 to 1.1 GB resident [inferred from file size; turbo f16
   measured 1.85 GB RSS], versus ~0.6 GB for small today.

## 8. Script for Harsh to record (8 lines)

Record each as a separate take on the MacBook mic in the normal room, holding Option+Space as usual, at your normal
speaking volume, once at normal volume and once quietly. Say exactly this:

1. yeh contract address kahan daalna hai
2. is page pe compiler version kaise choose karte hain
3. ye error ka matlab kya hai
4. verify and publish ka button kahan hai
5. license type mein kaunsa option select karun
6. where is the constructor arguments box
7. mujhe sign in ka link nahi mil raha
8. haan

Then the follow-up re-runs the same table (small `-l en` vs Apex `-l en -ac 512`, with and without the prompt) on
these 16 takes and reads the real `maxRms` values.

## 9. Not tested / unknown

Real voice; real room noise; Chrome `noiseSuppression` on soft speech; recordings over 10 s with `-ac 512`;
`-sns`; Hinglish priming words; Apex RSS; helper integration (no product code was changed, the running helper on
7777 and its whisper on 7778 were not touched; tests used ports 7851 and 7852).
