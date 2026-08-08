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
trx transcribe recording.mp4 --words --language es   # wraps whisper, handles extraction
whisper-cli -m model.bin -f audio.wav --max-len 1 --output-srt
```

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

## Limits

- No semantic cutting. Repeated lines, false starts, and redundancy need a human or an LLM reading the transcript.
- No crossfade at the joins; segments concatenate directly.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.
