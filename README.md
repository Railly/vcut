# vcut

Cut dead air out of a recording, reproducibly.

`vcut` finds the silences, filler words, and technical faults in a raw take, proposes an edit, and renders it only after a human approves. It is built for an agent to operate and a human to supervise: machine-readable output by default, a human summary in a terminal, and nothing irreversible without consent.

```bash
npx vcut recording.mp4
```

## Why

Cutting silence out of a talking-head recording is mechanical work that an agent should do. What an agent should *not* do is decide which of your mistakes stay in, or overwrite your only copy of a take. `vcut` splits those: it proposes cuts as data, and every destructive step is gated.

The thresholds are not invented. They come from a pipeline that ran in production on real published video.

## Install

```bash
npm install -g vcut     # or: bun add -g vcut
vcut doctor             # checks ffmpeg and ffprobe
```

Requires `ffmpeg` and `ffprobe` on your PATH. On macOS: `brew install ffmpeg`.

## Use

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

## Presets

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Intentional pauses |

## Filler words

Filler detection needs word-level timestamps. A normal SRT has one cue per sentence, which is not enough to cut a single word without guessing. `vcut` tells you when this is the case instead of silently reporting zero.

```bash
whisper-cli --max-len 1 --split-on-word -f audio.wav
vcut detect recording.mp4 --transcript words.srt --lang es
```

Lists ship for `es`, `en`, and `pt`.

## For agents

```bash
vcut schema detect     # the JSON contract, versioned
vcut skills get vcut   # the full agent manual, as markdown
```

Data goes to stdout, diagnostics to stderr. Exit code 2 means the invocation was wrong, 1 means the run failed.

## Guarantees

- **Source media is never modified.** Sources are hashed; a changed hash aborts a master render.
- **Nothing is approved automatically.** Segments are born `proposed`, the EDL `draft`.
- **Renders are reproducible.** The same EDL produces a byte-identical file, verified by the `sha256` in the output.
- **The renderer checks its own work** against the EDL: dimensions, pixel format, colour metadata, frame count, audio contract. A mismatch fails the run rather than shipping a bad file.

## Limits

- No semantic cutting. Repeated lines and false starts need a human or an LLM reading the transcript.
- No crossfade at the joins yet; segments concatenate directly.
- External audio, sync offset, and noise reduction are rejected rather than silently ignored.
- No face tracking or automatic zoom.

## License

MIT
