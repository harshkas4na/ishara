# Spoken answers

Ishara says its answer aloud, in a natural voice, on this laptop. Nothing is sent anywhere to do it.

## How it works

- `voice/kokoro_server.py` is a child process the helper keeps warm (like whisper-server). It loads
  Kokoro-82M (public weights, int8 ONNX, 92 MB) on onnxruntime and answers one JSON line per sentence
  by writing a 24 kHz mono 16-bit WAV to a temp file. Leading and trailing silence is trimmed.
- `helper/src/speech.ts` cleans the text, caps it, splits it into sentences (the first long sentence is also
  split at commas so sound starts sooner), synthesises one piece ahead of playback, and plays each WAV with
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

- Default: on. `ISHARA_SPEAK=0` turns it off entirely. `ISHARA_VOICE=af_bella` picks another Kokoro voice
  (default `af_heart`). `ISHARA_VOICE_ENGINE=system` forces the macOS voice.
- Mute: Option+Shift+M, the "Mute voice" button in the debug panel (Option+Shift+D), or
  `POST /speech/mute {"muted":true}`. The choice is saved in `helper/.data/speech.json`.
- Stop: `POST /speech/stop`. It is called automatically when a push-to-talk key goes down, when Option+Space
  starts a recording, and when a typed question is sent, so the voice never talks over you and never
  leaks into a recording (PTT records only while the key is held).
- Routes: `GET /speech` (status), `POST /speech/mute`, `POST /speech/stop`, `POST /speech/say {"text"}`.

## Text rules

Markdown marks, URLs, element ids (`b12`, `[b12]`), emoji and meter glyphs are removed; "(test router)" is
never spoken; text with nothing speakable (a bare tag) is skipped. Hard cap: 40 words per answer. The cut
falls on a sentence boundary; a single sentence over the cap is cut at its last comma inside the cap, else
at the cap, and ends with a plain full stop (no spoken ellipsis). The screen still shows the full text.
A safe stop is spoken as "I can't decide right now. <one-line reason>."

## Fallback

If Kokoro is not installed or fails to start, the macOS `say` voice is used and `/speech` reports
`"engine":"system"` with the reason. If that is missing too, `"engine":"none"` and `reason` says why.

## Privacy

Model, phonemiser and playback all run locally. The helper never sends text to a speech service. Only the
spoken text (already on screen) reaches the voice process, over a local pipe.

## Measured (M3 MacBook, warm, other apps running)

- Cold start: model load about 2.6 s inside the child, helper start to ready 1.3 s to 3 s.
- First audio after `speak()`: 6 words 0.32 s; a 30-word answer 0.76 s (first clause only).
- Full-sentence synthesis is about 0.5 to 1 s per 5 s of speech, so later sentences are ready before the
  previous one ends. Memory about 460 MB for the voice process (int8). CPU spikes during a sentence.
- This is slower than Buddy's Neural Engine build (0.14 to 0.3 s) because onnxruntime runs on CPU here.

## Limits

English only. macOS only (afplay). The voice cannot be heard by the tests: they check the pipeline with
fakes, and the real run checks WAV duration, level and that afplay starts and ends.
