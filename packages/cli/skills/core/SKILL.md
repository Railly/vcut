---
name: core
description: Core vcut usage guide. Read this before running any vcut command. Covers the detect to EDL to render pipeline, presets and thresholds, the word-level transcript requirement for filler cutting, the approval boundary, and what each command refuses to do.
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

**Filler cutting needs word-level timestamps**, meaning one cue per word. A sentence-level SRT produces zero fillers and a warning rather than a guess. Generate a usable transcript with either:

```bash
trx transcribe recording.mp4 --words --language es -m large-v3-turbo
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav --max-len 1 --output-srt
```

**Ask for a large model.** One cue per word means one cue per *token*, and what counts as a
token depends on the model. Measured on the same three minutes of Spanish: `small` returns
26% of its cues as word fragments, splitting "Crafter" into `Cra` + `fter`, while
`large-v3-turbo` returns 0% and costs 13 seconds. Fragments break filler matching, which
compares whole tokens, and they weaken the word clamping that keeps cuts off speech.

Do not report zero fillers as a clean result when the warning is present. Regenerate the transcript and run detect again.

**A filler list matches tokens, not intent.** Spanish `este` is a filler in "y este, entonces" and an ordinary demonstrative in "en este caso"; the detector cannot tell them apart, and cutting the second one mutilates the sentence. Read the filler hits before approving them. This is why they land as `proposed`.

`review` entries (clipping, black frames, frozen frames) are candidates for a human to look at. They are never cut automatically.

## edl build

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

Inverts the cut intervals into the spans worth keeping, so the EDL always describes surviving material. Boundaries are snapped to whole frames; unsnapped boundaries accumulate rounding error and make the renderer reject the result with a frame count mismatch.

Flags: `--edl <path>` (default `./edl.json`), `--width`, `--height`, `--fps`, `--no-fillers` to cut silences only.

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
| filler word cuts | authenticity |
| review candidates | semantic changes |
| crop options | acceptable jump cuts |
| | which mistakes stay human |

Never mark segments approved on the human's behalf. Never render a master without explicit approval. Never overwrite source media.

## Workflow for an agent

1. `vcut doctor` if anything looks wrong with the environment.
2. `vcut detect <input>` with the preset that matches the recording condition.
3. Read the warnings. If the transcript is not word-level, say so rather than reporting zero fillers as a clean result.
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

## Limits

- Semantic cutting is proposal-only. vcut supplies the transcript and folds in the spans; the judgement is yours and the approval is the human's.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). This is not a crossfade: the two sides are not overlapped, because overlapping would shorten the render against concatenated video and drift the audio out of sync. A joint under a fully continuous sentence can still be heard as a dip.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
