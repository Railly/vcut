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

Every edit ends at the same artifact: an EDL a human reads and can disagree with before any
file is written. `vcut edl build` writes it as `draft`, every segment `proposed`; `vcut render`
previews it freely and refuses a master until a human approves it.

How you get from a raw recording to that EDL has more than one path — a single-pass
`detect` -> `edl build` -> `render`, or a session opened with `vcut open` that a longer edit
runs several rounds inside — and which one applies changes across releases faster than this
stub does. `vcut skills get core` carries the current shape of the work, verb by verb; do not
treat the command list in an old copy of this stub as current.

## Two rules that matter before you run anything

**Nothing self-approves.** `vcut edl build` writes every segment as `proposed` and the EDL as `draft`. `vcut render --mode master` refuses until a human changes that. There is no `--yes`. Never mark segments approved on the human's behalf.

**detect finds silence, not filler words.** A word list cannot tell filler from ordinary use and never survives a new language, so filler words are proposed by a model through `vcut semantic`, like every other judgement call.

## Introspecting the contract

```bash
vcut schema             # which commands have a contract
vcut schema detect      # the field-by-field output shape, versioned
vcut doctor             # check ffmpeg and ffprobe before transforming anything
```

JSON is emitted automatically when stdout is not a TTY, so you never need `--json`. Data goes to stdout, diagnostics to stderr. Exit code 2 means the invocation was wrong, 1 means the run failed.

## Full documentation

https://vcut.crafter.run/docs

**Cutting is a loop, not a command.** Silence removal is the first round of several: each
class of defect only becomes visible once the one before it is gone. `vcut skills get core`
carries the procedure, the invariants that say when it is done, and what has already been
tried and failed.
