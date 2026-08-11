## nonspeech

```bash
vcut nonspeech cut.wav                          # spans only, the classifier's own output
vcut nonspeech cut.wav --verify --lang es        # each span read back through a window
```

Runs `skills/core/scripts/non-speech.py` against a rendered preview and reports audible sound
that is not language: a breath, a mic bump, a stretched hesitation the transcript cleaned
away even with a verbatim preset. Run it on the render, never on the source: on raw footage
every pause scores as non-speech, correctly and uselessly.

**The render can be the `--audio-only` `.wav`.** The classifier and `--verify` both classify
and re-transcribe audio only; neither reads a frame, so there is no reason to hold this for a
video render. Use `vcut render --edl edl.json --audio-only` for every round.

**Always run it with `--verify`.** Without it you get positions and nothing else, and the
instinct is to check each one against the whole-file transcript with `vcut say`, which is
circular for this class of sound: the transcript is exactly the instrument that could not see
it. `--verify` cuts a window of the span plus 1.2s of context on each side and re-transcribes
it with `trx`, attaching `text`, `peakDb`, `meanDb`, and a `reading`:

- `vocalization-suspect` — the window's transcript names a hesitation sound (eh, ehm, mmm, aah,
  tolerant of a stretched vowel), or the span carries real level with no words inside it.
- `words-around` — the window transcribes to ordinary words sitting either side of the span:
  a breath in a pause.
- `empty` — no words and no real level.

`words-around` needs no ear. `empty` at real level is still a question for a listener: neither
a hesitation token nor the transcript explains what the classifier heard there, and that is
exactly the case no amount of re-reading settles.

Measured on a real 7.5-minute run: 18 spans closed by reading the whole-file transcript were
all read as breaths, four spot-checked and cleared, and seven turned out to be audible "eeeh"
fillers the listener caught on the first playback. `--verify` against the same render read the
same spans and named the fillers by their text.

The classifier is optional — `python3`, `panns-inference`/`scipy`/`numpy`, and a ~320MB model
under `~/.vcut/panns` fetched by `vcut setup classifier`. Its absence is a supported state:
`nonspeech` says so and exits 0, the same policy `vcut doctor` already applies, and invariant 7
falls back to a human ear. `--verify` additionally needs `trx` on PATH, the same as
`say --transcribe`. vcut calls no model of its own either way: `python3` and `trx` are binaries
on the caller's PATH, exactly like `ffmpeg`.
