<h3 align="center">
  <span style="font-weight:600;font-size:20px;">vcut</span>
  <br/>
  <br/>
  <a href="https://www.npmjs.com/package/@crafter/vcut" target="_blank">
    <img src="https://img.shields.io/npm/v/@crafter/vcut?color=black" alt="npm"/>
  </a>
  &nbsp;
  <a href="https://github.com/Railly/vcut/blob/main/LICENSE" target="_blank">
    <img src="https://img.shields.io/github/license/Railly/vcut?color=black" alt="License"/>
  </a>
  &nbsp;
  <a href="https://github.com/Railly/vcut/stargazers" target="_blank">
    <img src="https://img.shields.io/github/stars/Railly/vcut?style=social" alt="GitHub stars"/>
  </a>
</h3>

<p align="center">
  <strong>Cut dead air out of a recording, reproducibly.</strong>
</p>

<p align="center">
  <a href="https://vcut.crafter.run">vcut.crafter.run</a>
</p>

<p align="center">
  Finds the silences, filler words, and technical faults in a raw take, proposes an
  edit as data, and renders it only after a human approves.
</p>

```bash
npx @crafter/vcut recording.mp4
```

## Why

Cutting silence out of a talking-head recording is mechanical work an agent should do. What an agent should *not* do is decide which of your mistakes stay in, or overwrite your only copy of a take.

vcut splits those. It proposes cuts as data, and every destructive step is gated. The thresholds are not invented: they come from a pipeline that ran in production on real published video.

## Quick Start

```bash
npm install -g @crafter/vcut     # or: bun add -g @crafter/vcut
vcut doctor             # checks ffmpeg and ffprobe
```

Requires `ffmpeg` and `ffprobe` on your PATH. On macOS: `brew install ffmpeg`.

```bash
# 1. Find what is worth cutting
vcut detect recording.mp4 --preset clean > detect.json

# 2. Draft an edit decision list
vcut edl build --detect detect.json --output master.mp4 --campaign my-video

# 3. Preview it, watch it, then render the master
vcut render --edl edl.json --mode preview
```

In a terminal you get a summary:

```
recording.mp4  6m 22s
  detected dead air       ###.................  16.5%  (1m 03s)
  net after margins       ##..................  10.3%  (~39s once 100ms is kept on each side)
  silences                119 spans, 1m 03s
  longest silence         1s at 6m 20s
  fillers                 not checked (transcript is not word-level)
  review candidates       1 (never cut automatically)
                          clipping: peak level -0.24 dB exceeds -1 dBFS
```

Piped or captured, the same command emits JSON. No flag needed.

## Commands

| Command | What it does |
|---------|--------------|
| `vcut detect <input>` | Silences, filler words, clipping, black and frozen frames |
| `vcut edl build` | Turns a detect report into a draft edit decision list |
| `vcut render` | Renders an EDL; preview accepts proposals, master needs approval |
| `vcut schema [name]` | The JSON contract per command, versioned |
| `vcut skills get vcut` | The bundled agent manual, as markdown |
| `vcut doctor` | Checks external dependencies |
| `vcut <input>` | Shorthand for `vcut detect` |

## Presets

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Intentional pauses |

Tune with `--min-silence` (seconds, default 0.3) and `--margin` (seconds, default 0.10).

## Filler words

Filler detection needs word-level timestamps: one cue per word. A normal SRT has one cue per sentence, which is not enough to cut a single word without guessing. vcut tells you when this is the case instead of silently reporting zero.

```bash
# with trx, which wraps whisper and handles extraction
trx transcribe recording.mp4 --words --language es -m large-v3-turbo

# or with whisper-cli directly
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav --max-len 1 --output-srt
```

Ask for a large model. One cue per word means one cue per *token*, and what counts as a token
depends on the model. On the same three minutes of Spanish, `small` returns 26% of its cues as
word fragments, splitting "Crafter" into `Cra` + `fter`; `large-v3-turbo` returns 0% and costs
13 seconds. Fragments break filler matching, which compares whole tokens.

```bash
vcut detect recording.mp4 --transcript words.srt --lang es
```

Lists ship for `es`, `en`, and `pt`.

A filler list matches tokens, not intent. Spanish `este` is a filler in "y este, entonces" and an ordinary demonstrative in "en este caso"; the detector cannot tell them apart. That is one reason every hit lands in the EDL as `proposed`: read them before approving.

## For agents

```bash
npx skills add Railly/vcut    # install the skill for Claude Code, Cursor, or any agent
```

The installed skill is a thin stub: it points at the CLI rather than copying its
contents, so the guidance never drifts from the installed version.

```bash
vcut skills list       # what the installed version ships
vcut skills get core   # the usage guide, as raw markdown
vcut schema detect     # the JSON contract, versioned
```

JSON is emitted automatically when stdout is not a TTY, so an agent never needs `--json`. Data goes to stdout, diagnostics to stderr. Exit code 2 means the invocation was wrong, 1 means the run failed.

## Guarantees

- **Source media is never modified.** Sources are hashed; a changed hash aborts a master render.
- **Nothing is approved automatically.** Segments are born `proposed`, the EDL `draft`. There is no `--yes`.
- **Renders are reproducible.** The same EDL produces a byte-identical file, verified by the `sha256` in the output.
- **The renderer checks its own work** against the EDL: dimensions, pixel format, colour metadata, frame count, audio contract. A mismatch fails the run rather than shipping a bad file.

## Limits

- Semantic cutting is proposal-only. `vcut semantic export` hands the transcript to a model as numbered lines and `edl build --semantic` folds the proposals back in, each one marked `semanticRisk: material`. vcut never calls a model itself: no dependency, no API key, same EDL for the same proposals file.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). Not a crossfade: overlapping the two sides would shorten the render against concatenated video and drift the audio out of sync, so each side fades within its own segment. A joint under a fully continuous sentence can still be heard as a dip.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.

## Design

Why it is shaped this way: [docs/design-notes.md](docs/design-notes.md). Full documentation at [vcut.crafter.run/docs](https://vcut.crafter.run/docs).

## License

MIT
