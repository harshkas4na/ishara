#!/usr/bin/env python3
"""voice/kokoro_server.py: Ishara's local voice. Kokoro-82M (public weights) on onnxruntime, kept warm
by the helper (helper/src/speech.ts) as a child process, like whisper-server.

Wire (JSON lines, one object per line):
  stdout  {"event":"ready","voice":"af_heart","sr":24000,"load_ms":2100}      once, after the model is loaded
  stdin   {"id":7,"text":"Click the blue Send button.","out":"/tmp/x.wav"}     one sentence
          optional "voice" (default ISHARA_VOICE_EN) and "lang" ("en-us" | "en-gb" | "hi"); a voice or lang that is not
          installed / not in the allowlist is an error for that sentence only. Hindi text must be Devanagari (the
          helper converts Roman Hinglish before it gets here: helper/src/speech-lang.ts).
  stdout  {"id":7,"ok":true,"ms":410,"audio_ms":1490,"rms":0.08}               the 24 kHz mono 16-bit WAV is at "out"
          {"id":7,"ok":false,"error":"..."}

Why a file path and not base64 on the pipe: the helper hands the file straight to afplay, so no audio
bytes pass through node at all, and a crash can never leave half a WAV in a pipe.
Why one sentence per request: the first sentence plays while the helper asks for the next one.
Kokoro pads each utterance with ~0.3 s of silence in front and ~0.5 s behind; both are trimmed to
30 ms / 110 ms, which is time the person would otherwise spend waiting.
Nothing here touches the network. If the model files are missing it exits with code 3 and says which.
"""
import json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.environ.get("ISHARA_KOKORO_MODEL") or os.path.join(HERE, "models", "kokoro-v1.0.int8.onnx")
VOICES = os.environ.get("ISHARA_KOKORO_VOICES") or os.path.join(HERE, "models", "voices-v1.0.bin")
# English voice: ISHARA_VOICE_EN, else the older ISHARA_VOICE override, else af_heart. Hindi sentences name their own
# voice per request (the helper picks it), so there is no Hindi default in this process.
VOICE = os.environ.get("ISHARA_VOICE_EN") or os.environ.get("ISHARA_VOICE") or "af_heart"
LANGS = {"en-us", "en-gb", "hi"}  # the espeak languages the helper may ask for; anything else is refused
SPEED = float(os.environ.get("ISHARA_VOICE_SPEED", "1.0"))
SR = 24000

OUT = sys.stdout
sys.stdout = sys.stderr  # libraries print progress; only the wire goes to the real stdout


def emit(obj):
    OUT.write(json.dumps(obj) + "\n")
    OUT.flush()


def trim(a):
    import numpy as np
    loud = np.nonzero(np.abs(a) > 0.004)[0]
    if loud.size == 0:
        return a
    lo = max(0, int(loud[0]) - int(0.03 * SR))
    hi = min(len(a), int(loud[-1]) + int(0.11 * SR))
    return a[lo:hi]


def main():
    for p in (MODEL, VOICES):
        if not os.path.exists(p):
            emit({"event": "error", "error": f"missing {p}; run scripts/setup-voice.sh"})
            sys.exit(3)
    t0 = time.time()
    import numpy as np, soundfile as sf
    from kokoro_onnx import Kokoro
    k = Kokoro(MODEL, VOICES)
    if VOICE not in k.get_voices():
        emit({"event": "error", "error": f"unknown voice {VOICE}"})
        sys.exit(3)
    k.create("Ready.", voice=VOICE, speed=SPEED, lang="en-us")  # first call compiles kernels; pay it now, not on the first answer
    # Pay the Hindi front-end and kernel cost now too: a first Hindi sentence must not be the slow one.
    if "hf_alpha" in k.get_voices():
        k.create("नमस्ते।", voice="hf_alpha", speed=SPEED, lang="hi")
    emit({"event": "ready", "voice": VOICE, "voices": sorted(k.get_voices()), "sr": SR, "load_ms": int((time.time() - t0) * 1000)})
    for line in sys.stdin:  # EOF (the helper died) ends the loop, so this process never outlives it
        try:
            r = json.loads(line)
            t = time.time()
            voice, lang = r.get("voice", VOICE), r.get("lang", "en-us")
            if voice not in k.get_voices():
                raise ValueError(f"unknown voice {voice}")
            if lang not in LANGS:
                raise ValueError(f"unsupported lang {lang}")
            a, sr = k.create(r["text"], voice=voice, speed=SPEED, lang=lang)
            a = trim(np.asarray(a, dtype=np.float32))
            sf.write(r["out"], a, sr, subtype="PCM_16")
            emit({"id": r.get("id"), "ok": True, "ms": int((time.time() - t) * 1000),
                  "audio_ms": int(len(a) / sr * 1000), "rms": round(float(np.sqrt((a ** 2).mean())) if len(a) else 0.0, 4)})
        except Exception as e:  # one bad sentence must not kill the voice
            emit({"id": (r or {}).get("id") if isinstance(locals().get("r"), dict) else None, "ok": False, "error": str(e)[:200]})


if __name__ == "__main__":
    main()
