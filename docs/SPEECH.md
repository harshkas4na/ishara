# Spoken answers

Ishara says its answer aloud, in a natural voice, on this laptop. Nothing is sent anywhere to do it.

## How it works

- `voice/kokoro_server.py` is a child process the helper keeps warm (like whisper-server). It loads
  Kokoro-82M (public weights, int8 ONNX, 92 MB) on onnxruntime and answers one JSON line per sentence
  by writing a 24 kHz mono 16-bit WAV to a temp file. Leading and trailing silence is trimmed.
- `helper/src/speech.ts` cleans the text, splits it into sentences (the first long sentence is also
  split at commas so sound starts sooner), synthesises two pieces ahead of playback, and plays each WAV with
  `/usr/bin/afplay`. Because playback happens in the helper, the browser extension and the desktop
  push-to-talk path both get a voice with no extra work.
- `decide()` makes one call, `speak(sayFor(decision))`, after the decision exists and never awaits it. The
  streaming `/tutor` route uses `speaker.enqueue(text)` and `speaker.flush()`.
- Why Python and not Node: Kokoro's text front-end (phonemes) and the ONNX model have maintained Python
  packages (`kokoro-onnx`); a Node port would be new, unproven code.
- MLX was tried and rejected for the judge setup: it needs `misaki`, spaCy and a second set of data files and
  failed on the espeak data path here. onnxruntime installs with one `uv pip install`.

## Setup (once, needs the network once)

```
brew install uv            # if you do not have it
scripts/setup-voice.sh     # voice/.venv (~200 MB) + voice/models (92 MB model + 28 MB voices), checksummed
npm run helper:desktop     # GET http://127.0.0.1:7777/speech  ->  "engine":"kokoro"
```

Nothing under `voice/.venv` or `voice/models` is committed.

## Using it

- Default: on. `ISHARA_SPEAK=0` turns it off entirely. `ISHARA_VOICE_EN=af_bella` picks the English Kokoro voice
  (default `af_heart`; the older `ISHARA_VOICE` still works as the same override). `ISHARA_VOICE_HI=hf_beta`
  picks the Hindi voice (default `hf_alpha`). Unknown names are ignored. `ISHARA_VOICE_ENGINE=system` forces the
  macOS voice. `ISHARA_VOICE_LEAD_MS` (default 250) is how long before a sentence ends the next one is started.
- Mute: Option+Shift+M, the "Mute voice" button in the debug panel (Option+Shift+D), or
  `POST /speech/mute {"muted":true}`. The choice is saved in `helper/.data/speech.json`.
- Stop: `POST /speech/stop`. It is called automatically when a push-to-talk key goes down, when Option+Space
  starts a recording, and when a typed question is sent, so the voice never talks over you and never
  leaks into a recording (PTT records only while the key is held).
- Routes: `GET /speech` (status), `POST /speech/mute`, `POST /speech/stop`, `POST /speech/say {"text"}`.
  `/speech/say` also takes `voice` (an installed Kokoro voice, else 400), `lang` (`en-us`, `en-gb`, `hi`) and
  `translit:false` (do not convert Roman Hinglish). That is what the sampler uses.

## Text rules

Markdown marks, URLs, element ids (`b12`, `[b12]`), emoji and meter glyphs are removed; "(test router)" is
never spoken; text with nothing speakable (a bare tag) is skipped.

**The whole answer is spoken.** There used to be a hard cap of 40 words per answer; it cut every answer after
about three sentences and was removed (2026-11-06). What is left:

- Sentence by sentence as the answer streams (`say` events), ending at `. ! ? …` or the Hindi danda `।`.
- A sentence over 30 words (`MAX_PIECE_WORDS`) is synthesised in pieces: cut at commas, and at word boundaries
  if it has none. Pieces joined are the sentence; no word is dropped.
- A sanity ceiling of 400 words per answer (`MAX_ANSWER_WORDS`), against a runaway model (the 0G reply is
  already capped near 350 tokens). The sentence that crosses it is finished; sentences after it are not
  spoken, a warning is logged and `/speech` shows `"clipped":true`.
- `flush()` at the end of the turn speaks the last sentence even without a final full stop, and resolves when
  the voice is quiet.
- Sentences that arrive faster than they are spoken wait in a queue, in order. `interrupt()` (new question,
  push-to-talk down, typed ask, mute) kills the sentence playing and drops the rest.

A safe stop is spoken as "I can't decide right now. <one-line reason>."

## Gapless playback

`afplay` keeps running 0.4 to 0.9 s after its sound has ended (measured: a 3.18 s clip takes 3.87 s from spawn
to exit). Waiting for the exit before starting the next sentence therefore left a half-second hole after every
sentence. The speaker knows each clip's length (from the WAV size), starts the next `afplay` `LEAD_MS` (250 ms)
before the sound ends, and lets the old process finish by itself. Each clip carries about 110 ms of silence at
its end (trimmed there on purpose), so even a late-starting next process cannot overlap audibly. Synthesis stays
two pieces ahead, so a long sentence after a short one is ready in time.

## Hindi and Hinglish

Kokoro-82M v1.0 ships four Hindi voices, all in the `voices-v1.0.bin` the setup script downloads: `hf_alpha`,
`hf_beta` (female), `hm_omega`, `hm_psi` (male). The voice is chosen **per sentence** (`helper/src/speech-lang.ts`):

| sentence | detected as | voice | text sent to Kokoro |
|---|---|---|---|
| English | `en` | `ISHARA_VOICE_EN` (af_heart) | unchanged |
| Devanagari (30% of letters or more) | `hi` | `ISHARA_VOICE_HI` (hf_alpha), espeak lang `hi` | unchanged |
| Roman Hinglish (2+ Hindi-only words and a fifth of the sentence) | `hinglish` | `ISHARA_VOICE_HI`, lang `hi` | Hindi words converted to Devanagari, English words left Roman |

Why the conversion: the Hindi front-end (espeak-ng `hi`) only understands Devanagari. Measured on this Mac,
"ye contract address wala box hai, yahan address daalo" in Roman letters came out as English phonemes (`hai`
read as "hi", `ye` as "jee") through every voice. After conversion ("ये contract address वाला box है, यहाँ address
डालो।") the phonemes are Hindi (`ʋˈaːlaː`, `hɛː`, `jˈʌhã`, `ɖˈaːloː`) and the English words are tagged `(en)`
by the phonemiser, the way a Hindi speaker says "contract". The converter is a table of about 300 common Hindi
words; a Hindi word that is not in the table stays Roman and is read as English. So the best input for the voice
is Devanagari from the model; Roman Hinglish works for the common words.

Switching voice between sentences adds no gap: each piece is synthesised with its own voice up to two pieces
ahead of playback. The first Hindi sentence is not slow: the Hindi front-end is warmed at start.
`scripts/voice-sampler.ts` plays the same three sentences in every Hindi voice so the choice is made by ear.

## The `speaking` event

`speaker.setHooks({ onSentenceStart(tag, text), onIdle() })`. The `/tutor` route installs hooks per question and
sends SSE `speaking {seq, text}` when playback of `say` number `seq` starts (once per sentence, even when it was
split into pieces), and `speaking {seq: null}` after `done`, when the queue has drained. The stream is held open
until that idle (at most 120 s) so the last event can be sent. Muted, disabled, or no engine: no event is sent.
An interrupted answer sends idle at once, to its own stream.

## Fallback

If Kokoro is not installed or fails to start, the macOS `say` voice is used and `/speech` reports
`"engine":"system"` with the reason. If that is missing too, `"engine":"none"` and `reason` says why.

## Privacy

Model, phonemiser and playback all run locally. The helper never sends text to a speech service. Only the
spoken text (already on screen) reaches the voice process, over a local pipe.

## Measured (M3 MacBook, warm, other apps running)

- Cold start: model load about 2.6 s inside the child, helper start to ready 1.3 s to 3 s.
- First audio after the first sentence arrives: 0.37 s (6 to 12 words).
- A 7-sentence answer (English, Devanagari, Hinglish mixed): 23.2 s wall for 23.4 s of audio, so no gap is added;
  the next sentence starts 250 ms before the previous one ends. The helper-side lateness of each start
  (`maxGapMs` in `/speech`) was 1 to 2 ms. Before the lead trick the same answer took 28.3 s.
- Synthesis is 0.34 to 0.6 s per 3 to 4 s sentence, serial inside the child. Memory about 365 MB for the voice
  process (int8). CPU spikes during a sentence.
- This is slower than Buddy's Neural Engine build (0.14 to 0.3 s) because onnxruntime runs on CPU here.

## Limits

English and Hindi (Roman Hinglish only for the words in the table). macOS only (afplay). The voice cannot be heard by the tests: they check the pipeline with
fakes, and the real run checks WAV duration, level and that afplay starts and ends.
