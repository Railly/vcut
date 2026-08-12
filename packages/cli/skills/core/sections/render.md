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

## Audio-only sources (#42)

A source with no video stream — a meeting-recorder mic track, a podcast export, an m4a in an
mp4 container — is a first-class source, not an error. `open`/`edl build`/`commit` already read
it fine; `render` is where that shows up as a different flag surface, not a different command.

**`--audio-only` is implied, not required, on a video-less EDL.** Passing it explicitly is
redundant, not wrong; omitting it is not a mistake either — `render` prints a note on stderr
once (`this EDL has no video source; --audio-only is implied`) and proceeds. There is nothing
to render a picture from, so refusing the call over a missing flag would be refusing the exact
source this exists for.

**`--mode master` on a video-less EDL produces an audio master, not a video.** The V1 output
contract (`h264`/`yuv420p`/`bt709`, width/height/fps) describes a picture; a video-less EDL's
`output` block carries none of those fields, only `path`/`audioTrackPolicy`/`overwrite`. The
master encodes AAC in the same container the video path already writes its own audio track
with — universally playable, a fraction of lossless size for a recording that can run well past
an hour, and the right trade for a file that gets received rather than scratch-audited. The
`--audio-only` scratch render used while iterating stays lossless `pcm_s16le` in a `.wav`, same
as always; only the finished master's codec changed.

```bash
vcut render --edl edl.json --mode preview          # scratch: implied audio-only, lossless .wav
vcut render --edl edl.json --mode master            # finished: implied audio-only, AAC master
```

Approval semantics are unchanged: still a human edit to the EDL (`approval.status` and every
segment's own `approval` to `"approved"`), still refused without it. `--audio-only` alongside
`--mode master` is still a contradiction on a video-bearing EDL — that combination stays
refused, since a scratch render and a finished video really are two different things there.

**Frame-dependent checks skip cleanly, never crash, never fake a result.** `detect`'s
black/frozen-frame scan needs a frame to scan; on a video-less source it does not run, and the
report says so directly (`no video stream on this source; black and frozen frame candidates not
collected`) rather than reading like a flag was passed. `--crop` is refused at build time with a
named reason (`--crop applies to a picture, and <source> has no video stream to crop`) instead
of being silently dropped — a crop that vanished without a word would read as a bug, not as the
flag correctly not applying.

`audit`, `joins`, and `nonspeech --verify` needed nothing to change: they already read the
waveform only, the same `.wav` the audio-only loop always fed them.
