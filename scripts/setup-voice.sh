#!/usr/bin/env bash
# Sets up Ishara's local voice: Kokoro-82M (public weights, MIT-style licence) on onnxruntime.
# Everything lands in voice/ (gitignored): voice/.venv (~200 MB of Python packages) and voice/models/
# (kokoro-v1.0.int8.onnx 92 MB + voices-v1.0.bin 28 MB). Run once; it needs the network once, and after
# that the voice never touches it. Safe to re-run: finished steps are skipped.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n== %s\n' "$*"; }
command -v uv >/dev/null || { echo "uv is required (brew install uv); it fetches Python 3.12, which onnxruntime has wheels for."; exit 1; }

say "1/3 Python 3.12 environment in voice/.venv"
[ -x voice/.venv/bin/python ] || uv venv --python 3.12 voice/.venv

say "2/3 Packages: kokoro-onnx, soundfile, numpy (onnxruntime comes with kokoro-onnx)"
uv pip install --python voice/.venv/bin/python kokoro-onnx soundfile numpy

say "3/3 Model weights (120 MB total) from the kokoro-onnx GitHub release"
mkdir -p voice/models
B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
get() { # name size sha256
  if [ -f "voice/models/$1" ] && [ "$(shasum -a 256 "voice/models/$1" | cut -d' ' -f1)" = "$3" ]; then echo "have $1"; return; fi
  echo "downloading $1 ($2)"; curl -fL --progress-bar -o "voice/models/$1" "$B/$1"
  [ "$(shasum -a 256 "voice/models/$1" | cut -d' ' -f1)" = "$3" ] || { echo "checksum mismatch for $1"; rm -f "voice/models/$1"; exit 1; }
}
get kokoro-v1.0.int8.onnx 92MB 6e742170d309016e5891a994e1ce1559c702a2ccd0075e67ef7157974f6406cb
get voices-v1.0.bin 28MB bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d

say "Smoke test (English, then Hindi: voices-v1.0.bin carries hf_alpha, hf_beta, hm_omega, hm_psi; espeak-ng comes with kokoro-onnx)"
echo '{"id":1,"text":"Ishara can speak now.","out":"/tmp/ishara-voice-test.wav"}' | voice/.venv/bin/python voice/kokoro_server.py 2>/dev/null
echo '{"id":2,"text":"यह बॉक्स है।","out":"/tmp/ishara-voice-test-hi.wav","voice":"hf_alpha","lang":"hi"}' | voice/.venv/bin/python voice/kokoro_server.py 2>/dev/null | grep -q '"ok": true' || echo "WARNING: the Hindi voice did not synthesise; Hindi sentences will fail"
echo "Wrote /tmp/ishara-voice-test.wav. Play it: afplay /tmp/ishara-voice-test.wav"
echo "Done. Restart the helper; GET http://127.0.0.1:7777/speech should say engine \"kokoro\"."
