# Record your own voice for the Hinglish test

The audit measured synthetic voices only. These 8 takes let `scripts/eval-voice.ts` measure the real you.

1. Record each line as its own take on the MacBook mic, in your normal room, at normal volume, in your normal
   mixed Hindi/English. Optionally a second, quiet take of each (name it `03q.wav`).
2. Save as `01.wav` .. `08.wav` in this folder (`03q.wav` for the quiet take). Any format ffmpeg reads works
   (`.wav .m4a .mov .mp3`); the script converts to 16 kHz mono.
   - QuickTime: File > New Audio Recording, stop, File > Export As > Audio Only, then rename.
   - or ffmpeg, one take, Ctrl-C to stop: `ffmpeg -f avfoundation -i ":0" -ar 16000 -ac 1 voice-samples/01.wav`
3. Create `lines.txt` here with the 8 lines below, one per line, in order (line N is the text of `NN.wav`).
4. Run `node scripts/eval-voice.ts --real --spawn 7861 --verbose` (own whisper, nothing else touched) or without
   `--spawn` to go through the running helper on 7777.

The lines:

```
yeh contract address kahan daalna hai
is page pe compiler version kaise choose karte hain
ye error ka matlab kya hai
verify and publish ka button kahan hai
license type mein kaunsa option select karun
where is the constructor arguments box
mujhe sign in ka link nahi mil raha
haan
```

Recordings (`*.wav` etc.) are gitignored; `lines.txt` and this file are not.
