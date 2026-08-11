## detect

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
```

Presets carry thresholds proven in production. Do not invent new ones.

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Intentional pauses |

`--lang` is the language of the recording, free-form and passed through to the semantic
export so a model knows what it is reading. Nothing parses it. Take it from the speaker, not
from a default: if you do not know, listen to a few seconds or ask, because the transcription
model needs the same answer and guessing wrong there costs the whole transcript.

**Picking one, and knowing when it was wrong.** When the recording matches a row, use it.
When it does not, **start at `clean`** and let the numbers move you: most speech recorded on
purpose sits closer to a room than to an event, and being one step too conservative costs a
round while being too aggressive costs syllables.

Then read the removal percentage `edl build` reports against the target for the content type: far under target usually means the threshold is too low for this room, far over
means it is too high and speech is being cut as silence. Change the preset, not
`--min-silence` or `--margin`, and rebuild.

The symptom of a threshold set too high is specific and worth recognising, because it reads
as a transcription error rather than a cut: a word loses its opening sound. A soft consonant
sits under the threshold, so the detector calls it a pause and cuts it while leaving the vowel
after it. If words come back missing their first syllable, lower the threshold rather than
widening the margin, which only pads around a cut that should not have been there.

**`--audio <path>` when the sound was recorded separately.** Silence is then measured on that
file rather than on the camera track, which matters because the camera track is the one being
thrown away: cutting against a waveform nobody will hear puts the cuts in the wrong places.
`edl build` reads the path from the report and writes both sources into the EDL, so it is only
named once.

```bash
vcut detect screen.mp4 --audio mic.wav --preset clean
vcut edl build --detect detect.json ...        # two sources, no extra flag
```

Two recordings started by the same app share a clock, so they need no correction. For two
separate recorders, `--audio-offset <ms>` on `edl build` shifts the window the audio is read
from; positive means the audio file is ahead of the picture.

Other flags: `--min-silence` (seconds, default 0.3), `--margin` (seconds, default 0.10), `--skip-video-scan` to skip black and frozen frame detection on long sources.

**Word clamping needs word-level timestamps**, meaning one cue per word. A sentence-level SRT turns clamping off, with a warning rather than a guess. Generate a usable transcript with either:

```bash
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav -l es \
  --max-len 1 --split-on-word --output-srt
```

`trx transcribe <input> --words --language es -m large-v3-turbo` produces word-level cues from
`trx@0.7.1` on. Earlier versions passed `--max-len` without `--split-on-word`, which is worth
knowing because of what that produces.

**Ask it for a verbatim transcript, or it is not equivalent to the invocation above.** Without
a prompt a transcriber cleans, and the hesitations this manual tells you to keep never reach
the transcript. On one recording the prompted run recovered a three-attempt retake that the
unprompted run collapsed into a single phrase, which was the largest cut available in that
take: a semantic round is blind to what it never sees.

```bash
trx transcribe <input> --words --language es --preset verbatim
```

`--preset verbatim` carries the prompt for the language being transcribed. On a `trx` too old
to have it, drive `whisper-cli` directly with the `--prompt` above.

One more thing about feeding `trx` a file: hand it the recording, not a `.wav` you extracted
yourself. Measured on a 90.5s source, the `.mp4` produced 410 cues and a pre-extracted mono
16kHz `.wav` produced 5, with `"success": true` and no warning either way.

**`--split-on-word` is not optional.** Without it `--max-len 1` cuts at token boundaries, so a
multi-token word arrives split and the transcript looks word-level while being useless for
clamping: measured on one recording, 26% of cues were fragments without the flag and 0% with
it. `detect` reports `wordLevel: true` either way, because it counts cues rather than judging
them.

`detect` now warns when more than a tenth of the cues continue a word instead of starting one.
**Read that warning**: it is the difference between a transcript that constrains cuts and one
that only appears to. You can check it yourself the same way, since a leading space is how the
model marks where a word begins:

```bash
grep -c '^ ' words.srt      # should be close to the cue count, not a fraction of it
```

**Word timings drift toward silence, and detect now says so.** A model stretches a cue
backwards into the pause before the word, so the cue claims speech where the waveform has
none. Clamping trusts that claim and holds a boundary open around it, which is how room tone
survives a cut that was detected correctly:

```
warning   60 transcript cues claim a word starts inside measured silence. The largest is
          "honor?" at 75.64s, where the audio stays silent for another 1318ms.
```

**Read that as a transcript problem, not a threshold one.** Dead air in the render looks
exactly like a threshold set too low, so the reflex is to change the preset. One session did
that: the more conservative preset moved the boundary by 12ms and explained nothing, because
the detector had been right and the transcript was wrong. Check the named position with
`vcut say` before touching anything.

The count is usually not small — 60 of 217 cues on one recording — because the drift is
systematic rather than exceptional. There is no threshold to filter it: measured on that same
recording it ran from 1318ms down to a median of 246ms with no gap anywhere. That is why the
warning names the worst case with its position instead of pretending a cut-off exists.

**Soft trailing speech below the level floor is the other way a level-based instrument lies, and
it is the opposite direction of the drift warning above.** Drift is a cue claiming speech where
the waveform has none — silence measured correctly, transcript wrong. This class is speech
sitting below both `silences`' and `detect`'s volume floor — level measured correctly (as
silence), speech real and audible to a transcriber and a listener. Third case in one day on real
material: a trailing first attempt ("Me siento muy...") sat glued to the previous phrase with no
gap even at -36dB/0.08s, invisible to `detect` and `silences` alike. Same-day, earlier: "pero
espero" sat below -30dB and was eaten whole by a silence cut, and the "eeeh" filler class
`whisper` cleans away is the same shape at a smaller scale — see `--section muletillas`.
`peek`'s `viewsDisagree: "soft-speech-below-threshold"` (see `--section peek`) is the
instrument that now sees this class in one call: it fires when the fine-resolution `blocks`
read silence for the whole span but `heard` — the span re-transcribed directly — still carries
words. Neither a silence list nor a level threshold alone can see it, because both work from a
volume floor a transcriber does not need.

**The honest resolution when no boundary support exists: respect the block, never force a
mid-speech boundary.** If the audio gives no measured silence to cut on, cut from the preceding
silence instead and say so in the `reason` — name what is lost rather than inventing a boundary
level never measured. `boundariesInSilence` is not gated on for a semantic cut chosen by meaning
(see "Read `semanticCuts[].removedText` before rendering" in `--section edl-build` — a boundary
landing in speech there is common and not itself wrong). This class is the other direction: a
proposal with no silence anywhere to place it against, where `boundariesInSilence: [false, ...]`
is worth reading as a caution specifically because there was nowhere quiet to land, not because
the model chose meaning over pause. Read it before building rather than after a render says the
cut clipped speech.

**A word can also run long for the opposite reason, and that one is not benign.** Drift stretches
a cue over *silence*. A transcript that fused several attempts at the same line stretches a cue
over *speech*: the model heard the phrase three times, wrote it once, and the surviving word
carries the time all three occupied. Both surface as an unusually long cue, which is why the
warning above cannot tell you which you have, and why reading it as drift and moving on is the
trap. One run did exactly that and lost a round to it.

Tell them apart by what the audio does inside the cue's own span. Drift is speech at the start
and silence for the rest; fusion holds voice across the whole span. Measure with `vcut say`
around the word rather than trusting either reading:

```bash
vcut say <media> --transcript words.srt --at <the position the warning names> --window 4
vcut say <media> --transcribe --lang es --at <position> --window 4   # ask the audio instead
```

`--transcribe` cuts the window and runs the transcriber over it rather than reading the
whole-file transcript, which is the only way to see what a fused region actually contains. On
one recording, reading gave "la que conocemos, ya llegamos a" at a position where transcribing
the same window gave "Y a la que conocemos, ya llegue. Y a la que conocemos" — the repetition
that four runs failed to find. It needs the media, not a transcript, and costs one transcriber
call.

Normalise duration per character before comparing anything, or long words look pathological on
their length alone: on one recording `emprendedores,` ran 980ms and came to 70ms per character,
ordinary, while `conocemos,` ran 2590ms at 259ms per character against a file median of 79.

**When the audio holds voice through a long cue, re-transcribe that window on its own before
cutting anything near it.** A whole-file pass is what averaged the repetitions away, so asking
it again changes nothing; a 4 to 8 second window returns them. Two windows of different lengths
that disagree on the word count for the same overlap is the signature. On one recording the
90-second transcript wrote "Y a la que conocemos, ya llegamos" once, and short windows over the
same span returned it three times with an "ah, otra vez" between them — a retake the loop cannot
cut because nothing downstream knows it was said.

**Ask the model to keep the hesitations.** A transcriber cleans by default: it writes what it
believes was meant, so a stretched vowel or a tag question is dropped as noise. Those are
exactly the spans worth cutting, and one that never reaches the transcript cannot be proposed.

```bash
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav --max-len 1 --output-srt \
  --prompt "Transcripción literal. Incluí muletillas, dudas y sonidos: eh, mmm, o sea."
```

Write the prompt in the language being transcribed and name the sounds that language actually
uses; a list written for one language is noise in another. It recovers some of them, not all,
which is why the classifier still has a job.

**Ask for a large model too.** Model size and the split flag are separate causes of the same
symptom. Measured on three minutes of Spanish: `small` returned 26% of its cues as fragments,
splitting "Crafter" into `Cra` + `fter`, where `large-v3-turbo` returned 0% and cost 13
seconds. Fragments weaken the word clamping that keeps cuts off speech, and they make the
semantic export unreadable.

**detect does not look for filler words, and that is deliberate.** It used to carry a list of six tokens per language. Measured on one Spanish recording, that list caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that happened to carry no meaning in that one sentence, which is most of them and is why no list would have helped.

A list also cannot tell filler from real use. Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso"; `claro` is filler in "y claro, entonces" and an answer on its own. Extending the list makes it worse, not better: the same token is filler or content depending on the clause around it, and a list has no clauses in it. And every new language would need one written from scratch.

**Fillers are the model's job, through `vcut semantic`.** Read the exported lines, mark the discourse markers that carry nothing *in that sentence*, and leave the ones doing work. `kind: "filler"` exists in the proposal schema for exactly this.

`review` entries (clipping, black frames, frozen frames) are candidates for a human to look at. They are never cut automatically.
