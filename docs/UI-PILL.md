# On-screen design v2: the pill (frozen 2026-11-06)

Why: Harsh found the streaming bubble "renders the whole text as a paragraph in front of me and covers the screen". His
screen tutor Buddy shows one pill at the bottom with what is being spoken, while the cursor and marker do the pointing.

## The pill (browser overlay and desktop overlay look and behave the same)
- One compact pill, bottom-centre, 24 px above the bottom edge (desktop: ~120 pt above the Dock area). Auto width up to 520 px
  (desktop 520 pt), at most 2 lines of 15 px text. Dark, 92% opaque (#1f1147), rounded 16 px, soft shadow. Never covers the
  pointed target (if the pointed target is under the pill, the pill hops to the top edge).
- A state dot on the left: PREPARING (pulsing amber, "Getting ready…"), LISTENING (blue, with the level meter bars,
  "Speak now"), THINKING (three dancing dots, shows what was heard), SPEAKING (sound-wave bars), REFUSED (red).
- The text is the sentence being SPOKEN right now (karaoke style: it changes when playback of the next sentence starts; the
  helper sends `speaking {seq}` events). If speech is muted or unavailable, each sentence shows for at least 1.5 s as it arrives.
  While thinking it shows what was heard: “...”. The whole answer is NOT shown on screen by default; it lives in the
  conversation panel (browser: Option+Shift+C) so nothing important is lost.
- Guide mode: a step chip "2/6" and ‹ › buttons and ✕ inside the pill (clickable; everything else stays click-through).
  Voice commands (next, back, repeat, stop, Hinglish agla / peeche / dobara / ruko) work as today.
- Refusal: the pill turns red with the plain-language cause. A "How do I know?" link appears after an answer (browser).

## Pointing
- Cursor and the pen are kept: the needle cursor glides to the target, ripples, then marks it.
- CONTROLS get a rounded-rectangle boundary hugging the element (2.5 px, blue #3b82f6 with a soft glow), drawn like a pen stroke.
- TEXT (a paragraph, a line, an error message) gets a HIGHLIGHTER: a translucent band (#fde047 at 35%) over the text lines of the
  block (browser: one rect per line from Range.getClientRects; desktop: the block's rect).
- Two pointers in one answer: the first stays dimmed while the second is drawn.

## Listening feedback (so the first words are not lost)
Recording starts at the key-down, not after a delay; the pill goes PREPARING -> LISTENING ("Speak now") the moment the
microphone is really live, with a short soft tick sound. Releasing before the hold threshold discards the take.
