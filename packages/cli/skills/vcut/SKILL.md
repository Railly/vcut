---
name: vcut
description: Cut silences, filler words, and dead air out of a recording and render a clean master, reproducibly. Use when the user has a raw screen or camera recording, mentions cutting silences or filler words or dead air, asks to clean up a take before publishing, wants an edit decision list from a video, or asks to trim pauses out of a talking-head recording. Also use when a recording needs a technical pass for clipping, black frames, or frozen frames before it ships. Do not use for story ideation, caption styling, subtitle translation, or publishing to a platform.
allowed-tools: Bash(vcut:*), Bash(npx @crafter/vcut:*)
---

# vcut

Cut dead air out of a recording, reproducibly. Agent-first CLI over ffmpeg: it proposes cuts as data and renders only what a human approved.

Install: `npm install -g @crafter/vcut` (needs `ffmpeg` and `ffprobe` on PATH)

## Start here

This file is a discovery stub, not the usage guide. Before running any `vcut` command, load the real workflow content from the CLI:

```bash
vcut skills get core        # the pipeline, presets, thresholds, approval boundary
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skills get core`.

Run `vcut skills list` to see everything available on the installed version.

## The shape of the work

Three commands, and the middle one is not optional plumbing:

```bash
vcut detect recording.mp4 > detect.json     # candidates, decides nothing
vcut edl build --detect detect.json \
  --output master.mp4 --campaign my-video   # draft EDL, every segment proposed
vcut render --edl edl.json --mode preview   # watch it before approving
```

The EDL exists so a human can read and disagree with the edit before any file is written.

## Two rules that matter before you run anything

**Nothing self-approves.** `vcut edl build` writes every segment as `proposed` and the EDL as `draft`. `vcut render --mode master` refuses until a human changes that. There is no `--yes`. Never mark segments approved on the human's behalf.

**Zero fillers is not always a clean result.** Filler detection needs a word-level transcript. When one is missing, vcut reports zero and emits a warning. Read the warning before reporting success.

## Introspecting the contract

```bash
vcut schema             # which commands have a contract
vcut schema detect      # the field-by-field output shape, versioned
vcut doctor             # check ffmpeg and ffprobe before transforming anything
```

JSON is emitted automatically when stdout is not a TTY, so you never need `--json`. Data goes to stdout, diagnostics to stderr. Exit code 2 means the invocation was wrong, 1 means the run failed.

## Full documentation

https://vcut.crafter.run/docs
