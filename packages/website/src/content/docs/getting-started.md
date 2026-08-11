---
title: Getting started
description: Install vcut, check your dependencies, and cut your first recording.
order: 1
---

## Getting started

vcut turns a raw recording into a clean master in four steps, and stops at every point where a human should look.

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
vcut init                # installs everything a first run needs, ffmpeg included on a fresh machine
```

`vcut init` reports anything it could not install and exits non-zero, so it works as a
precondition check in a script. `vcut doctor` reruns the same check afterwards, any time
something looks wrong.

### The four steps

```bash
# 1. Find what is worth cutting. Writes candidates, decides nothing.
vcut detect recording.mp4 --preset clean > detect.json

# 2. Draft an edit decision list. Every segment is proposed.
vcut edl build --detect detect.json --output master.mp4 --campaign my-video

# 3. Iterate on the audio, which is where the decisions are.
vcut render --edl edl.json --audio-only --output cut.wav

# 4. Preview it, watch it, and only then render a master.
vcut render --edl edl.json --mode preview
```

The EDL from step 2 is not optional plumbing. It is the artifact you read and disagree with before anything gets rendered.

Step 3 exists because a round of edits asks audio questions, and rendering the picture to
answer them costs about a hundred times the wall clock: measured on one 22-segment EDL,
**0.25s against 31.8s** for the same cuts. See [Iterate on audio](#iterate-on-audio) in the
cutting loop for why this is where most of a round's work actually happens.

### Editing across several calls

Silence removal alone is rarely the whole edit — see [The cutting loop](#cutting-loop) for why
it takes several rounds on anything longer than a quick take. `vcut open` starts the session a
real edit runs inside instead of re-detecting and re-passing paths every round:

```bash
vcut open recording.mp4 --preset clean --lang es --transcript words.srt   # once
vcut cut recording.mp4 --refs b042..b044 --kind repetition --reason "..." # per finding
vcut commit recording.mp4 --output master.mp4 --campaign my-video         # build + render, one call
```

`open` caches the same detect pass step 1 above runs, and turns its silences into stable block
refs (`b001`, `b002`, ...) a later `cut` points at by name instead of a hand-typed millisecond
pair. The four-step quickstart above is the escape hatch: correct for a one-off cut with no
second round, or a script with no long-lived working directory. `open` is where an edit that is
going to take more than one round starts instead — see
[The stateless pipeline is an escape hatch, not an alternative](#the-stateless-pipeline-is-an-escape-hatch-not-an-alternative)
for why the session is the default and not the quickstart above.

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
