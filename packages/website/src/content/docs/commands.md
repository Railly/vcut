---
title: Commands
description: Every vcut command, its flags, and what it refuses to do.
order: 2
---

## Commands

```
vcut <input>                       Shorthand for: vcut detect <input>
vcut detect <input> [flags]        Find silences and review candidates
vcut edl build [flags]             Turn a detect report into a draft EDL
vcut semantic export|check|review  Hand the transcript to a model, take back proposals
vcut render --edl <path> [flags]   Render an EDL to video
vcut schema [name]                 Print the JSON contract for a command
vcut skills list|get [name]        Read the bundled agent manual
vcut doctor                        Check external dependencies
vcut setup classifier              Fetch the optional non-speech classifier
vcut version                       Print the version
```

Global flags: `--json` forces machine output, `--human` forces the summary, `--help` works on any command.

### vcut detect

Runs the deterministic pass. Never edits media, never writes an EDL.

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--input <path>` | — | Source recording. Also accepted positionally. |
| `--preset <name>` | `noisy` | `noisy` (-20 dB), `clean` (-30 dB), `podcast` (-35 dB) |
| `--min-silence <sec>` | `0.3` | Shortest silence worth cutting |
| `--margin <sec>` | `0.10` | Padding kept on each side of speech |
| `--lang <code>` | `es` | Free-form language tag, passed through to the semantic export |
| `--audio <path>` | — | Separate audio recording; silence is measured on this |
| `--transcript <path>` | — | Word-level SRT, used to keep cuts off word edges |
| `--skip-video-scan` | off | Skip black and frozen frame detection |

It reports three kinds of finding: **silences** measured from audio energy, **review candidates** (clipping, black frames, frozen frames), and **warnings** for conditions worth reading before trusting the run.

Review candidates are never cut automatically. They exist so a human looks.

**Filler words are not detected here.** A word list matches tokens, not intent: Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso", and no list survives a language nobody wrote one for. Filler words are proposed by a model through `vcut semantic`, like every other judgement call.

**`--audio` when the sound was recorded separately.** Silence is then measured on that file rather than on the camera track, which matters because the camera track is the one being discarded: cutting against a waveform nobody will hear puts the cuts in the wrong places. The path travels in the report, so `edl build` writes both sources without being told twice.

```bash
vcut detect screen.mp4 --audio mic.wav --preset clean
```

### vcut edl build

Turns a detect report into a draft edit decision list.

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--detect <path>` | required | Report produced by `vcut detect` |
| `--output <path>` | required | Where the rendered master will go |
| `--campaign <id>` | required | Campaign identifier, stored in the EDL |
| `--edl <path>` | `./edl.json` | Where to write the EDL |
| `--width`, `--height`, `--fps` | source values | Output geometry |
| `--edge-fade <ms>` | `50` | Audio ramp at each segment edge; `0` disables |
| `--crop <spec>` | — | `top\|bottom\|left\|right:<fraction>`, or `x,y,width,height` |
| `--semantic <path>` | — | Model proposals from `vcut semantic` |
| `--audio-offset <ms>` | `0` | Shift the separate audio; positive delays it |

**`--crop` frames the whole edit at once**, which is why it lives here and not per segment. A traditional editor makes you set the frame per clip, so remembering the menu bar after cutting means redoing every segment by hand. Here the crop is one decision applied to all of them, and changing it never touches a cut boundary. Fractions, not pixels, so the same EDL survives a source at another resolution.

The command inverts the cut intervals into the spans worth **keeping**, so the EDL always describes surviving material rather than deleted material.

It also reports a removal percentage. Compare it against the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.

### vcut semantic

Repeated lines, false starts, digressions and filler words need something reading the transcript. **vcut never calls a model.** It exports the lines and takes proposals back, so the judgement stays with whoever is reading.

```bash
vcut semantic export --detect detect.json > lines.json
# read lines.json, write proposals.json
vcut semantic check --proposals proposals.json --detect detect.json
vcut edl build --detect detect.json --semantic proposals.json ...
```

| Subcommand | What it does |
| --- | --- |
| `export --detect <path>` | Numbered lines with timings, rebuilt into words and split on measured pauses |
| `check --proposals <path> --detect <path>` | Validates proposals without building |
| `review --edl <path> --detect <path>` | Reads an EDL back: what survives, and where nobody looked |

A proposal is `{startMs, endMs, kind, reason}` where `kind` is `false-start`, `repetition`, `tangent`, `filler`, or `non-speech`. Every semantic cut lands as `semanticRisk: material` on the segments around it, so a reviewer can find them without reading all of them.

Nothing malformed passes: an inverted span, a span past the end of the source, an unknown kind, or an empty `reason` is refused by index and aborts the build. A proposal that vanished between check and build would read as the model choosing not to cut there, which is worse than a refusal.

**`review` closes the loop.** With `--master` it measures silence on the render itself, and with `--master-transcript` it returns the lines of the render rather than the source projected forward. It also reports `unreviewed`: the stretches between two cuts that no proposal ever touched, which is where a defect survives round after round because its neighbours look worked on.

### vcut setup

```bash
vcut setup classifier
```

Fetches the AudioSet model that `skills/core/scripts/non-speech.py` uses to find breaths, mic bumps and other audible sound that is not language. Around 320MB into `~/.vcut/panns`, and idempotent.

Nothing else needs it: `detect`, `edl build` and `render` all run without it. `vcut doctor` reports whether it is installed, as optional rather than missing.

### vcut render

```bash
vcut render --edl edl.json --mode preview --dry-run
vcut render --edl edl.json --mode preview
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--edl <path>` | required | The EDL to render |
| `--output <path>` | from EDL | Override the output path |
| `--mode <name>` | `preview` | `preview` or `master` |
| `--dry-run` | off | Print the ffmpeg command without running it |

`preview` accepts proposed segments. `master` refuses unless the EDL is approved, every segment is approved, every source hash still matches, and the output path is free. It will not overwrite.

After rendering, vcut probes the file it produced and validates it against the EDL. A mismatch fails the run instead of shipping a bad file.

### vcut schema

```bash
vcut schema            # lists the commands with a contract
vcut schema detect     # the field-by-field contract for detect
```

Versioned, so an agent can introspect the output shape at runtime instead of parsing help text or reading source.

### vcut skills

Install the skill into Claude Code, Cursor, or any agent that reads them:

```bash
npx skills add Railly/vcut
```

What gets installed is a **thin stub**. It carries the description an agent matches against and then points at the CLI:

```bash
vcut skills list
vcut skills get core     # the usage guide, raw markdown on stdout
vcut skills path
```

The guide ships inside the npm package and is served by the CLI itself, so it always matches the installed version. A copy pasted into an agent's config would go stale the moment you upgrade; a stub that points at `skills get` cannot.

### vcut doctor

Checks that `ffmpeg` and `ffprobe` are reachable and reports their versions. Exits non-zero when either is missing.

It also reports the optional non-speech classifier, which is a supported absence rather than a failure: without it the check it performs falls back to a human ear.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The run failed |
| `2` | The invocation was wrong |

Data always goes to stdout, diagnostics always to stderr.
