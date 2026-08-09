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

**detect does not look for filler words, and that is deliberate.** It used to carry a list of six tokens per language. Measured on one Spanish recording, that list found 3 hits, all `o sea`, while the finished cut still carried 19 fillers in 332 words: `bueno`, `claro`, `¿no?`, `de hecho`, `entonces`, `nada`. None of them belong on a list, because they are ordinary words that happen to carry no meaning in that one sentence.

A list also cannot tell filler from real use. Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso"; `claro` is filler in "y claro, entonces" and an answer on its own. Extending the list makes it worse, not better: the same token is filler or content depending on the clause around it, and a list has no clauses in it. And every new language would need one written from scratch.

**Fillers are the model's job, through `vcut semantic`.** Read the exported lines, mark the discourse markers that carry nothing *in that sentence*, and leave the ones doing work. `kind: "filler"` exists in the proposal schema for exactly this.

`review` entries (clipping, black frames, frozen frames) are candidates for a human to look at. They are never cut automatically.

## edl build

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

Inverts the cut intervals into the spans worth keeping, so the EDL always describes surviving material. Boundaries are snapped to whole frames; unsnapped boundaries accumulate rounding error and make the renderer reject the result with a frame count mismatch.

Flags: `--edl <path>` (default `./edl.json`), `--width`, `--height`, `--fps`, `--edge-fade <ms>`, `--semantic <path>`.

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

It happened on the run this guidance came from. The speaker made one point, that Crafter
Station would have grown differently in Argentina, and made it three times, forty seconds
apart. Each telling read as a separate beat of the argument, so only one was cut. Heard back
at speed, all three said the same thing and the listener noticed immediately.

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

## Limits

- Semantic cutting is proposal-only. vcut supplies the transcript and folds in the spans; the judgement is yours and the approval is the human's.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). This is not a crossfade: the two sides are not overlapped, because overlapping would shorten the render against concatenated video and drift the audio out of sync. A joint under a fully continuous sentence can still be heard as a dip.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
