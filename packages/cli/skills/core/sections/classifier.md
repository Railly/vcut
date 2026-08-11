### Non-verbal sound needs a classifier, not a statistic

A breath, a mic bump, a lip smack: audible, meaningless, and invisible to both
instruments. The silence pass hears energy and calls it speech. The transcript has no word
for it, and the model stretches a neighbouring cue over it, so it ends up inside a word's
span rather than beside it.

`vcut nonspeech` runs `skills/core/scripts/non-speech.py` against the render and reports the
spans it finds. It runs on the **rendered preview**, not the source: on raw footage every pause
scores as non-speech, correctly and uselessly, while on a finished cut only real intrusions
are left.

```bash
vcut setup classifier                          # once, ~320MB into ~/.vcut/panns
vcut nonspeech master.wav --verify --lang es > non-speech.json   # the audio-only render
# read each vocalization-suspect span's text, then map timings back through the EDL and feed
# the real ones in as proposals
```

**Always add `--verify`.** Without it you only get the classifier's raw spans, which puts the
closing question back on the whole-file transcript — see `--section invariants` for
why that is circular for this class of sound. `--verify` re-transcribes a short window around
each span with `trx` and reports a `reading`: `vocalization-suspect`, `words-around`, or
`empty`. `vcut schema nonspeech` has the full contract.

The classifier script itself stays outside the CLI as a subprocess `vcut nonspeech` shells
out to, because it needs Python and a 300MB torch checkpoint, and vcut otherwise runs
anywhere ffmpeg does. Anything emitting the same span schema works in its place; that script
is the reference. `--verify`, the reading, and the windowed re-transcription live in the CLI
itself and need no Python beyond what the classifier already needed.

**Four energy statistics were tried first and all four failed**, which is worth knowing
before reaching for a fifth:

| Attempt | Why it cannot work |
| --- | --- |
| Sound with no word covering it | The cue stretches over the noise, so it is never uncovered |
| Gaps between consecutive words | The largest gap in a tight edit is a fraction of a second |
| Energy swing inside one word | A word holding a breath swung *less* than an ordinary word |
| Median level inside one word | Ranks unstressed function words first, which is a different question |

Periodicity gets closer, since voiced speech has vibrating folds and a breath is turbulence,
but unvoiced consonants are turbulence too: every sibilant becomes a false positive.

The pattern is that each measures a **proxy** for non-speech, and every proxy is dominated
by ordinary variation in speech. Separating a breath from a syllable asks what a sound *is*,
so it takes something trained on that question. A general VAD is not enough either: one
scored a breath at 0.87 voice, indistinguishable from words. What worked was an AudioSet
classifier, keyed on the *absence of speech* rather than the presence of breathing.
