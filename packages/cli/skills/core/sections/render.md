## render

```bash
vcut render --edl edl.json --mode preview --dry-run
vcut render --edl edl.json --mode preview
```

Preview mode accepts proposed segments. Master mode requires an approved EDL, approved segments, matching source hashes, and a free output path; it refuses to overwrite.

Render blocks in the foreground and streams progress to stderr; there is nothing to poll. A
video render runs roughly real time per minute of source, so budget the call accordingly: if
your harness enforces a default tool timeout shorter than the render, raise the timeout for
that call rather than backgrounding it. `--audio-only` is near instant and is the mode every
round before the last one should be using anyway.

**Render `--audio-only` for every round. Render video once, at the end, and not before.** This
is the default, not an optimisation to remember: every question a round asks is about sound —
whether a filler survived, whether a boundary clipped a word, whether an idea is still said
twice. Answering those through the video path re-encodes every frame for nothing. Measured on
one 22-segment EDL: **0.25s against 31.8s** for the same cuts.

```bash
vcut render --edl edl.json --audio-only          # rounds 1..n
vcut render --edl edl.json                        # once, at the end
```

The pull toward a video render is usually a false one. `audit` correlates waveforms and
`nonspeech` classifies audio — neither reads a frame, so both take the `--audio-only` `.wav`
directly, same as `joins`. Pass it wherever these accept `<render>`:

```bash
vcut render --edl edl.json --audio-only          # rounds 1..n
vcut audit --edl edl.json --render cut.wav
vcut nonspeech cut.wav --verify
vcut joins --edl edl.json --render cut.wav --report report.json
```

The only check that genuinely wants a picture is a black/frozen-frame scan (`detect`'s own
video pass) — that belongs to the final render, after the transcript reads clean. One run
spent 69 of its 105 seconds of tool time on two video renders, the second of them purely to
feed `audit`, `joins`, and `nonspeech --verify`, none of which needed a frame; the repetition
they were checking for survived to the master anyway.

The audio graph is the same one the video render uses, edge fades and loudness included, so
what you hear is what the finished file will sound like: measured at -16.4 LUFS on both paths
from the same EDL. It writes lossless audio, because a codec artifact heard while iterating
reads as a defect in the cut.

The result lands on the segment sum. Before 0.4.1 it came back tens of milliseconds short and
the render was rejected as broken, which sent rounds back through the video path for no reason:
the trim cut against the clock `loudnorm` rewrites rather than the one the sum was measured in.
If a version this old reports `duration differs from EDL` on an EDL the video path accepts,
that is the bug, not the cut.

**There is no approve command, and that is the design.** Approval means editing the EDL: set
`approval.status` to `"approved"` and each segment's `approval` to `"approved"`. No CLI verb
does this because a verb would be a thing an agent can call, and this is the one step that
must not be automatable. **Never make that edit on the human's behalf**, not even when they
say the preview looks good: hand them the path and let them do it, or ask them to say
explicitly that they want you to write it. Everything before this point is reversible; this
is what makes a master.

Audio is normalised to the `speechTargetLufs` the EDL declares, defaulting to -16 LUFS with a -1 dBTP ceiling. This runs on the concatenated result rather than per segment, so a quiet passage stays quieter than a loud one instead of every piece being dragged to the same number. Measured on one recording: -25.4 LUFS in, -16.5 out.

The renderer validates its own output against the EDL: dimensions, pixel format, colour metadata, frame count within one frame, and the audio contract. Identical inputs produce a byte-identical file, so the `sha256` in the result is a reproducibility check.
