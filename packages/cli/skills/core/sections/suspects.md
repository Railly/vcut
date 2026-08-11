## suspects

```bash
vcut suspects --detect detect.json
```

Where to look first, ranked, computed from the silences `detect` already measured. No
transcript, no model, no second pass over the audio.

A speaker correcting themselves breaks delivery into short pauses that land close together;
fluent speech spaces them out. The threshold is a fraction of **this recording's own median
gap**, so it adapts to the speaker rather than needing a number per file: measured across four
recordings, hesitant material fires 5.3 to 6.3 times a minute and a take read from a script
fires 1.0, and a speaker whose median gap was 8916ms against another's 1170ms did not saturate
it.

It also means longer sources fire *less* per minute, not more — a long take carries more
thinking pauses, its median rises, and the bar rises with it. Measured: 6.3 a minute at three
minutes, 2.8 to 3.5 at four and six, which projects to 55-70 positions for twenty minutes
rather than the 120 a linear guess predicts.

**It says where, never what.** Telling a discarded retake from a speaker pausing to pick a
related thought lives in content, and rhythm is all this measures. Run `say --transcribe` on a
position to find out what is there.

`--pause-ratio` defaults to 0.4, the middle of a plateau where 0.3, 0.4 and 0.5 all found every
defect with no false positives. That plateau was measured on one recording, which is why it is
a flag.
