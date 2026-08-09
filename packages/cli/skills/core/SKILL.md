---
name: core
description: Core vcut usage guide. Read this before running any vcut command. Covers the detect to EDL to render pipeline, presets and thresholds, the word-level transcript requirement for word clamping, the approval boundary, and what each command refuses to do.
allowed-tools: Bash(vcut:*), Bash(npx @crafter/vcut:*)
---

# vcut core

Find what is worth cutting, propose it, and let a human approve before anything is rendered.

The pipeline is three commands and never skips the middle one:

```
vcut detect <input>  ->  detect.json   (candidates, nothing decided)
vcut edl build       ->  edl.json      (draft, every segment proposed)
vcut render          ->  master.mp4    (preview first, master after approval)
```

`vcut semantic` is optional and sits beside `edl build`: it hands you the transcript as lines
and folds your proposals back in. It never calls a model on its own.

## Output contract

Every command writes data to stdout and diagnostics to stderr. JSON is emitted automatically when stdout is not a TTY, so an agent never needs `--json`, though passing it is harmless. Exit code 2 means the invocation was wrong, 1 means the run failed.

Run `vcut schema detect|edl|render` for the field-by-field contract instead of parsing `--help`.

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

Other flags: `--min-silence` (seconds, default 0.3), `--margin` (seconds, default 0.10), `--skip-video-scan` to skip black and frozen frame detection on long sources.

**Word clamping needs word-level timestamps**, meaning one cue per word. A sentence-level SRT turns clamping off, with a warning rather than a guess. Generate a usable transcript with either:

```bash
trx transcribe recording.mp4 --words --language es -m large-v3-turbo
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav --max-len 1 --output-srt
```

**Ask for a large model.** One cue per word means one cue per *token*, and what counts as a
token depends on the model. Measured on the same three minutes of Spanish: `small` returns
26% of its cues as word fragments, splitting "Crafter" into `Cra` + `fter`, while
`large-v3-turbo` returns 0% and costs 13 seconds. Fragments weaken the word clamping
that keeps cuts off speech, and they make the semantic export unreadable.

**detect does not look for filler words, and that is deliberate.** It used to carry a list of six tokens per language. Measured on one Spanish recording, that list caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that happened to carry no meaning in that one sentence, which is most of them and is why no list would have helped.

A list also cannot tell filler from real use. Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso"; `claro` is filler in "y claro, entonces" and an answer on its own. Extending the list makes it worse, not better: the same token is filler or content depending on the clause around it, and a list has no clauses in it. And every new language would need one written from scratch.

**Fillers are the model's job, through `vcut semantic`.** Read the exported lines, mark the discourse markers that carry nothing *in that sentence*, and leave the ones doing work. `kind: "filler"` exists in the proposal schema for exactly this.

`review` entries (clipping, black frames, frozen frames) are candidates for a human to look at. They are never cut automatically.

## edl build

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

Inverts the cut intervals into the spans worth keeping, so the EDL always describes surviving material. Boundaries are snapped to whole frames; unsnapped boundaries accumulate rounding error and make the renderer reject the result with a frame count mismatch.

Flags: `--edl <path>` (default `./edl.json`), `--width`, `--height`, `--fps`, `--edge-fade <ms>`, `--semantic <path>`, `--crop <spec>`.

**`--crop` frames the whole edit at once**, which is the reason it lives here and not in the
renderer's per-segment field. A traditional editor makes you set the frame per clip, so
remembering the menu bar after cutting means redoing every segment by hand. Here the crop is
one decision applied to all of them, and changing it never touches a cut boundary.

```bash
vcut edl build --detect detect.json --crop top:0.06 ...   # shave 6% off the top
vcut edl build --detect detect.json --crop 0.1,0,0.8,1 ...  # arbitrary window
```

Fractions, not pixels, so the same EDL survives a source at another resolution.

Every segment is written as `proposed` and the EDL as `draft`. **This command never approves its own work.**

Compare the reported `removalPercent` against the target for the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.

## render

```bash
vcut render --edl edl.json --mode preview --dry-run
vcut render --edl edl.json --mode preview
```

Preview mode accepts proposed segments. Master mode requires an approved EDL, approved segments, matching source hashes, and a free output path; it refuses to overwrite.

Audio is normalised to the `speechTargetLufs` the EDL declares, defaulting to -16 LUFS with a -1 dBTP ceiling. This runs on the concatenated result rather than per segment, so a quiet passage stays quieter than a loud one instead of every piece being dragged to the same number. Measured on one recording: -25.4 LUFS in, -16.5 out.

The renderer validates its own output against the EDL: dimensions, pixel format, colour metadata, frame count within one frame, and the audio contract. Identical inputs produce a byte-identical file, so the `sha256` in the result is a reproducibility check.

## Human decision boundary

vcut proposes. The human decides.

| vcut may propose | The human decides |
| --- | --- |
| silence cuts | delivery quality |
| review candidates | semantic changes |
| crop options | acceptable jump cuts |
| | which mistakes stay human |

Never mark segments approved on the human's behalf. Never render a master without explicit approval. Never overwrite source media.

## Workflow for an agent

1. `vcut doctor` if anything looks wrong with the environment.
2. `vcut detect <input>` with the preset that matches the recording condition.
3. Read the warnings. If the transcript is not word-level, say so: clamping is off and cuts can land inside a word.
4. `vcut edl build`, then check `removalPercent` against the content type.
5. `vcut render --mode preview --dry-run` to confirm the command is well formed.
6. `vcut render --mode preview` and have a human watch it.
7. Only after approval, flip the EDL to approved and render the master.

## semantic

Repeated lines, false starts, and digressions need something reading the transcript. **vcut
never calls a model.** It exports the lines and takes back proposals, so you are the model in
this loop.

```bash
vcut semantic export --detect detect.json > lines.json
# read lines.json, write proposals.json yourself
vcut semantic check --proposals proposals.json --detect detect.json
vcut edl build --detect detect.json --semantic proposals.json --output master.mp4 --campaign x
```

Export returns numbered lines with timings, rebuilt into words and split on measured pauses,
plus the instructions for what each `kind` means. Write back a JSON array of
`{startMs, endMs, kind, reason}` where `kind` is `false-start`, `repetition`, `tangent`, or
`filler`.

Two rules that are enforced, not advice. Every semantic cut lands as `semanticRisk: material`
on the segments around it, so a reviewer can find them without reading all of them. And
nothing malformed passes: an inverted span, a span past the end of the source, an unknown
kind, or an empty `reason` is refused by index and aborts the build. A proposal that vanished
between check and build would read as you choosing not to cut there, which is worse than a
refusal.

`reason` is read by a human deciding whether to approve. Say what is lost, not what rule
matched. Proposing nothing is a valid answer.

### How hard to cut

The failure mode here is not cutting something precious. It is being polite: reading the
transcript as an argument to preserve rather than a recording to edit, and leaving the work
undone while reporting it finished.

The shape it takes: a speaker returns to the same point across a recording, each time in
different words and far enough apart that each reads as a separate beat of the argument. Cut
one, leave the rest. Then the edit plays back at speed, the distance collapses, and a listener
hears the repetition immediately.

Hold this bar:

- **Count the idea, not the sentence.** Before proposing, list what the recording actually
  says. If one idea appears three times across the transcript, that is one idea and two cuts,
  however far apart they sit. Distance between them is not evidence they differ.
- **Keep the best telling, not the first.** The clearest version is often the last one, after
  the speaker has worked out how to say it. Cut the rehearsals.
- **A whole paragraph is a normal proposal.** False starts and restatements run for ten or
  fifteen seconds. A span that only ever covers a few hundred milliseconds means fillers were
  found and redundancy was not.
- **Cut to the end of the clause.** Half a sentence surviving its own cut is worse than
  leaving the passage whole.
- **Check the target range.** `edl build` prints what the removal percentage is in range for.
  Raw speech landing in "scripted talking head" usually means the semantic pass was timid,
  not that the recording was already tight.

The counterweight is real and it is the human's, not yours: it is their voice, and a cut that
strips the thinking out of a reflection makes it sound like a script. Propose the cut, say
what is lost in `reason`, and let them refuse it. Under-proposing takes that decision away
from them just as much as over-cutting does, only silently.

### One pass is never the answer

**Cut, render, transcribe the render, read it again, cut again. Until a pass proposes
nothing.** A single pass cannot be enough, because most of what needs cutting is invisible
until the surrounding noise is gone.

Each class of defect only becomes visible once the one above it is gone, which is why the
order is fixed and why stopping early leaves work that looks like polish and is not:

| Round | Only visible now because |
| --- | --- |
| 1 | Nothing hides long silence or an obvious stammer |
| 2 | A pause two adjoining segments create together did not exist in either of them before |
| 3 | A join reads as broken only once both sides are adjacent, and a surviving redundancy only once the passage is short enough to hold in your head |
| 4 | A discourse marker is inaudible inside loose speech and obvious inside tight speech |

The loop:

```bash
vcut edl build --detect detect.json --semantic proposals.json ... && vcut render --edl edl.json --mode preview
trx transcribe master.mp4 --words --language es -m large-v3-turbo
vcut detect master.mp4 --preset clean --transcript master.srt --json > master-detect.json
vcut semantic review --edl edl.json --detect detect.json --master master.mp4 --master-transcript master.srt
# widen the spans in proposals.json, then run the whole thing again
```

**Transcribe the render every round, and read that.** Not the previous transcript, not the
source transcript projected forward. Every cut shifts everything after it, so the two
timelines diverge by the whole removed duration, and a span written against stale timings
lands somewhere nobody chose. A fresh transcript is also the only place a mangled join is
visible as text: the source transcript describes what was said, and only the render's own
describes what is left.

**Widen existing spans before adding new ones.** When a proposal fails to remove what it
named, the usual cause is a boundary set too tight, not a wrong call. A restart is only
obvious once you see the attempt that follows it, so the earliest attempts read as content
while you are looking at them and as preamble once the last one is in view. Extending an
existing span usually removes more than any new cut placed beside it.

**Stop when a pass proposes nothing**, not when the removal percentage looks respectable.

### Invariants

Hard rules. Each one is a defect if it survives a pass, not a matter of taste, and each one
is checkable against the transcript of the render rather than against intent:

1. **No idea is stated twice.** If two passages make the same point, one of them is a cut.
   Distance between them is not evidence they differ: the edit removes that distance.
2. **No sentence begins and does not land.** Every start has its ending in the edit, or the
   whole attempt goes.
3. **No pronoun outlives its antecedent.** If "that" or "eso" refers to something cut, the
   sentence goes with it.
4. **No fragment survives alone.** A clause that only made sense as part of a passage that
   was removed is not content, it is a leftover.
5. **Nothing survives that can be deleted without changing what the sentence says.** Delete
   the candidate, read what remains, and ask whether a listener learns anything less. If not,
   it goes.

   The test is a deletion, never a vocabulary. A word list only finds what someone already
   thought to write down, misses the same function expressed differently, and has to be
   rewritten for every language. The deletion test needs none of that: it asks what a span
   *does* in its sentence, so it works on a construction nobody named and in a language
   nobody wrote a list for.

   Sweep the transcript span by span rather than scanning for shapes you recognise. What you
   recognise is gone by the second pass; what stays is what did not look like filler, usually
   because it sits mid-clause and reads as ordinary grammar.

   Two things fail this test and must stay anyway: a word carrying emphasis the speaker
   meant, and a beat that gives a listener room before a heavy point. Removing those is what
   makes an edit sound like a script.
6. **The last line lands.** A video ending on an abandoned start is worse than one four
   seconds shorter.

If the transcript of the render violates one of these, the edit is not done, whatever the
removal percentage says.

### Non-verbal sound needs a classifier, not a statistic

A breath, a mic bump, a lip smack: audible, meaningless, and invisible to both
instruments. The silence pass hears energy and calls it speech. The transcript has no word
for it, and the model stretches a neighbouring cue over it, so it ends up inside a word's
span rather than beside it.

`skills/non-speech.py` finds them and prints `kind: "non-speech"` proposals. It runs on the
**rendered master**, not the source: on raw footage every pause scores as non-speech,
correctly and uselessly, while on a finished cut only real intrusions are left.

```bash
python3 skills/non-speech.py master.mp4 > non-speech.json
# map the master timings back through the EDL, then feed them in
```

It lives outside the CLI because it needs a 300MB torch checkpoint, and vcut has no
dependencies worth trading for that. Anything emitting the proposal schema works; that
script is the reference.

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

## Limits

- Semantic cutting is proposal-only. vcut supplies the transcript and folds in the spans; the judgement is yours and the approval is the human's.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). This is not a crossfade: the two sides are not overlapped, because overlapping would shorten the render against concatenated video and drift the audio out of sync. A joint under a fully continuous sentence can still be heard as a dip.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
