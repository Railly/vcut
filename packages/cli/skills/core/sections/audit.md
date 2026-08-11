## audit

```bash
vcut audit --edl edl.json --render cut.wav
```

Every check the renderer runs on itself is an aggregate: dimensions, frame count, duration.
A render whose segments carried the wrong material passes all of them, because the durations
are right whatever ended up inside them. This compares the audio itself, segment by segment,
against the source span the EDL points at.

**`--render` takes the `--audio-only` `.wav`.** Every comparison here decodes a waveform,
never a frame, so `vcut render --edl edl.json --audio-only` is enough for every round. Render
video only once, at the end, for the master.

```
audit  22 of 22 segments compared
  agreeing         21 at or above 0.8 correlation
  segment-022      correlation 0.330 at master 52.186 (source 86.842)
```

**A low score is a place to look, not a verdict.** Envelope correlation is weak over short or
quiet windows, and loudness normalisation lifts quiet passages by several dB, which changes
the shape being compared. On the run above, the one segment that scored low was carrying
exactly the right words — reading them with `vcut say` settled in seconds what the number
could not.

That caution is not decoration. A hand-rolled version of this measurement once produced a
confident, wrong finding: it reported a boundary leaking half a second of removed speech, and
correlating the same window against both candidate positions afterwards scored 0.975 for the
one the EDL named against 0.485 for the supposed leak. Use it to pick where to listen.
