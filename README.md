<h3 align="center">
  <span style="font-weight:600;font-size:20px;">vcut</span>
  <br/>
  <br/>
  <a href="https://www.npmjs.com/package/vcut" target="_blank">
    <img src="https://img.shields.io/npm/v/vcut?color=black" alt="npm"/>
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
  Finds the silences, filler words, and technical faults in a raw take, proposes an
  edit as data, and renders it only after a human approves.
</p>

```bash
npx vcut recording.mp4
```

## Why

Cutting silence out of a talking-head recording is mechanical work an agent should do. What an agent should *not* do is decide which of your mistakes stay in, or overwrite your only copy of a take.

vcut splits those. It proposes cuts as data, and every destructive step is gated. The thresholds are not invented: they come from a pipeline that ran in production on real published video.

## Quick Start

```bash
npm install -g vcut     # or: bun add -g vcut
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

Filler detection needs word-level timestamps. A normal SRT has one cue per sentence, which is not enough to cut a single word without guessing. vcut tells you when this is the case instead of silently reporting zero.

```bash
whisper-cli --max-len 1 --split-on-word -f audio.wav
vcut detect recording.mp4 --transcript words.srt --lang es
```

Lists ship for `es`, `en`, and `pt`.

## For agents

```bash
vcut schema detect     # the JSON contract, versioned
vcut skills get vcut   # the full agent manual
```

JSON is emitted automatically when stdout is not a TTY, so an agent never needs `--json`. Data goes to stdout, diagnostics to stderr. Exit code 2 means the invocation was wrong, 1 means the run failed.

## Guarantees

- **Source media is never modified.** Sources are hashed; a changed hash aborts a master render.
- **Nothing is approved automatically.** Segments are born `proposed`, the EDL `draft`. There is no `--yes`.
- **Renders are reproducible.** The same EDL produces a byte-identical file, verified by the `sha256` in the output.
- **The renderer checks its own work** against the EDL: dimensions, pixel format, colour metadata, frame count, audio contract. A mismatch fails the run rather than shipping a bad file.

## Limits

- No semantic cutting. Repeated lines and false starts need a human or an LLM reading the transcript.
- No crossfade at the joins yet; segments concatenate directly.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.

## Design

Why it is shaped this way: [docs/design-notes.md](docs/design-notes.md).

## License

MIT
