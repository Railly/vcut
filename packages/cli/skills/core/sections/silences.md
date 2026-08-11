## silences

```bash
vcut silences recording.mp4 --from 327.3 --to 330.5 --noise -33 --min 0.08
```

`detect`'s silence list is the **cutting** instrument: one threshold, one minimum, the preset
proven in production, and it is what `edl build` cuts against. `silences` is the **placing**
instrument: the same measurement, a threshold and minimum you choose, over whatever sub-range
you name, answering a different question — not "what should be cut" but "what does the audio
do right here, at the resolution this boundary needs."

It exists because the second question kept getting answered by hand. On a real 7.5-minute run
(2026-08-10), every semantic boundary was placed by running raw ffmpeg `silencedetect` about
ten times at -33dB/0.08s, with the offset arithmetic from `--ss` back to absolute media time
done by hand each call — because the gaps separating a filler ("eh") from the next word measure
80-150ms, well under `detect`'s 0.3s default minimum and invisible to it.

```
vcut silences recording.mp4 --from 327.3 --to 330.5 --noise -33 --min 0.08

  327.30-328.07s        silence  (770ms)
  328.07-328.63s        speech  (560ms)
  328.63-328.74s        silence  (110ms)
  328.74-329.68s        speech  (940ms)
```

Flags: `--from`/`--to` (seconds, default the whole file), `--noise` (dB, default -30),
`--min` (seconds, default 0.25). Positions on flags are seconds; the JSON speaks milliseconds,
already absolute — no offset math left for the caller, which is the whole point.

`blocks` covers the entire requested range: every silence `detect`'s own measurement would
find at that threshold, and the speech filling every gap between them. Never writes an EDL,
never changes what gets cut. `edl build` still cuts against `detect.silences`.
