---
title: Getting started
description: Install vcut, check your dependencies, and cut your first recording.
order: 1
---

## Getting started

vcut turns a raw recording into a clean master in three steps, and stops at every point where a human should look.

```bash
npm install -g @crafter/vcut
```

Or run it without installing:

```bash
npx @crafter/vcut recording.mp4
```

### Requirements

vcut shells out to `ffmpeg` and `ffprobe`. Both must be on your PATH.

```bash
brew install ffmpeg     # macOS
vcut setup      # what is installed, what is left to run
vcut doctor             # confirms both are visible
```

`vcut doctor` exits non-zero when something is missing, so it works as a precondition check in a script.

### The three steps

```bash
# 1. Find what is worth cutting. Writes candidates, decides nothing.
vcut detect recording.mp4 --preset clean > detect.json

# 2. Draft an edit decision list. Every segment is proposed.
vcut edl build --detect detect.json --output master.mp4 --campaign my-video

# 3. Preview it, watch it, and only then render a master.
vcut render --edl edl.json --mode preview
```

The middle step is not optional plumbing. The EDL is the artifact you read and disagree with before anything gets rendered.

### Reading the summary

In a terminal, `vcut detect` prints a summary rather than the raw candidate list:

```
recording.mp4  6m 22s
  detected dead air       ###.................  16.5%  (1m 03s)
  net after margins       ##..................  10.3%  (~39s once 100ms is kept on each side)
  silences                119 spans, 1m 03s
  longest silence         1s at 6m 20s
  filler words            not scanned; a word list cannot tell filler from ordinary use. Run vcut semantic.
  review candidates       1 (never cut automatically)
                          clipping: peak level -0.24 dB exceeds -1 dBFS
```

Two numbers appear because they answer different questions. **Detected dead air** is how much silence exists. **Net after margins** is how much actually gets removed once the padding around each cut is given back, and that second number is what `vcut edl build` should land near. A large gap between them means the margin is eating the cuts.

### Choosing a preset

The preset sets the loudness floor below which audio counts as silence.

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, rooms with ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Deliberate pauses you want to keep |

A preset that is too aggressive cuts into breath and delivery. One that is too conservative leaves the pauses in. Start with the one that matches the room, then tune `--min-silence` if the result is close but not right.

### What comes next

Nothing here approves anything. Segments are written as `proposed` and the EDL as `draft`, and `vcut render --mode master` refuses to run until a human changes that. See [Commands](#commands) for the full surface and [The EDL](#edl-format) for what you are approving.
