---
title: Commands
description: Every vcut command, its flags, and what it refuses to do.
order: 2
---

## Commands

```
vcut <input>                       Shorthand for: vcut detect <input>
vcut detect <input> [flags]        Find silences, fillers, and review candidates
vcut edl build [flags]             Turn a detect report into a draft EDL
vcut render --edl <path> [flags]   Render an EDL to video
vcut schema [name]                 Print the JSON contract for a command
vcut skills list|get [name]        Read the bundled agent manual
vcut doctor                        Check external dependencies
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
| `--lang <code>` | `es` | `es`, `en`, or `pt`; selects the filler list |
| `--transcript <path>` | — | SRT used for filler detection; must be word-level |
| `--skip-video-scan` | off | Skip black and frozen frame detection |

It reports four kinds of finding: **silences** measured from audio energy, **fillers** matched against a word list, **review candidates** (clipping, black frames, frozen frames), and **warnings** for conditions worth reading before trusting the run.

Review candidates are never cut automatically. They exist so a human looks.

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
| `--no-fillers` | off | Cut silences only, ignore filler candidates |

The command inverts the cut intervals into the spans worth **keeping**, so the EDL always describes surviving material rather than deleted material.

It also reports a removal percentage. Compare it against the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.

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

```bash
vcut skills list
vcut skills get vcut     # raw markdown on stdout
vcut skills path
```

The agent manual ships inside the npm package and is served by the CLI itself, so it is available from an install rather than only from a repo checkout.

### vcut doctor

Checks that `ffmpeg` and `ffprobe` are reachable and reports their versions. Exits non-zero when something is missing.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The run failed |
| `2` | The invocation was wrong |

Data always goes to stdout, diagnostics always to stderr.
