## Limits

- Semantic cutting is proposal-only. vcut supplies the transcript and folds in the spans; the judgement is yours and the approval is the human's.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). This is not a crossfade: the two sides are not overlapped, because overlapping would shorten the render against concatenated video and drift the audio out of sync. A joint under a fully continuous sentence can still be heard as a dip.
- Noise reduction is not offered. Measured on one recording: the background floor already sat
  at -54 dB, and a denoiser at a default setting pushed a weak syllable from -45 dB to -57,
  which is the same defect as a threshold set too high. There is no safe default because the
  right amount depends on the room, and unlike a cut it cannot be undone by editing the EDL.
  Loudness normalisation is the part that is safe to automate, and that is on by default.
- No face tracking or automatic zoom.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
- The advisory lock (`cut`, `commit`) is a courtesy, not a kernel-level guarantee. Two writers racing the exact same instant could both pass the check before either writes `lock.json`; it protects against the real case (one writer actively working a session while a second starts later), not an adversarial simultaneous write.
- `rounds --diff` compares build reports, not renders. It cannot tell you whether a render's actual audio changed between two rounds — only what the build asked for. Confirm with `peek` or `say --transcribe` on the renders themselves.
- A source with no video stream is a legal, first-class source (#42) — it is not a limit, but it does change what a few verbs offer: `detect`'s black/frozen-frame scan and `edl build --crop` need a picture and skip cleanly (a named note, never a crash, never a faked result) rather than pretending to run. `render` offers only the audio path — `--audio-only` is implied on preview, `--mode master` produces an audio master instead of a video. Everything else (silence detection, word clamping, cut, commit, audit, joins, nonspeech) is unaffected, since none of it ever read a frame.
