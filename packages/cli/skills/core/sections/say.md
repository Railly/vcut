## say

```bash
vcut say cut.mp4 --transcript cut.srt --at 50.2
vcut say cut.mp4 --transcript cut.srt --at 50.2 --edl edl.json --window 3
vcut say cut.mp4 --transcribe --positions 19.5,30.0,41.9 --window 4
vcut say source.mp4 --transcribe --words --at 550.0 --through 553.0 --lang es
```

Reads back what is spoken at a position, with the level there and, with `--edl`, which
segment it falls in.

```
at 50.200               la verdad. Venimos construyendo bien duro y
level                   peak -1.2 dB, mean -16.5 dB
segment                 segment-020, source 84.239
```

**Reading is the default. `--transcribe` is for the case reading cannot answer.** Without
`--transcribe`, `say` reads the transcript that already exists — cheap, and correct whenever the
transcript is trustworthy at that position. The trap is answering a doubt about it by cutting a
short slice and transcribing that instead: a window shorter than a couple of seconds comes back
as noise no matter what the audio holds, so a nonsense result proves nothing — it looks exactly
the same whether the audio is speech or a mic bump. In one session that mistake produced a
confident diagnosis of a model hallucination that was not there, and about four minutes went
into the wrong branch.

`--transcribe`, used properly (a window of four seconds or more, not a slice), is the right tool
when the whole-file transcript may have averaged the passage away — a fused retake, a filler a
verbatim preset still cleaned, a stretch a listener flagged that the transcript does not show.
It costs one transcriber call and reads the audio directly rather than trusting a pass that had
reason to be wrong. Measured on one recording: reading at 57.5s gave "la que conocemos, ya
llegamos a", transcribing the same window with `--transcribe` gave "Y a la que conocemos, ya
llegue. Y a la que conocemos" — a repetition four runs failed to find because the text they read
did not contain it.

### `--words` is the arbiter when the two modes above disagree

**Reach for it the moment you catch yourself about to bisect a boundary by hand.** Reading and
transcribing answer different questions and can contradict each other about where a word is,
and neither of them can settle it: `--transcript` returns timings a whole-file pass averaged,
`--transcribe` returns prose with no timings at all. `--transcribe --words` extracts exactly
`--at`..`--through`, re-transcribes that span asking for word-level cues, and offsets every one
back to absolute source milliseconds, so the answer comes back as numbers you can hand straight
to `vcut cut --start-ms/--end-ms`.

```bash
vcut say source.mp4 --transcribe --words --at 550.0 --through 553.0 --lang es
```

```
at 550.000              Y a la que conocemos, ya llegamos a mil miembros
words                   measured now, absolute source ms
551412-551690           conocemos
551690-551980           ya
```

The measured case it exists for (2026-08-10 run, second agnostic pass): inside a fused region
the whole-file transcript placed a keeper's start at 550740ms when the true boundary sat at
roughly 551300-551600ms — a 600-900ms error, and large enough to ship a defect. `--transcribe`
at two-second windows made it worse rather than better, returning hallucinations ("Fíjole.",
"Me siento muerto.") for real speech. The run settled it by hand: six to eight `--transcribe`
calls at shrinking windows, then raw `ffmpeg -ss/-t` plus a fresh transcription to build its own
ground truth. That bisection cost about a third of a 218k-token run and produced one number.
This is that procedure as one call.

**It costs one real transcription per call**, the same price as `--transcribe` and for the same
reason: it is a transcription. That is the whole cost model — a boundary question is one call,
not one call per candidate offset. `--words` needs `--transcribe`; without it, `say` already
returns the transcript's own words, which are exactly the numbers `--words` exists to doubt.

`wordsFrom: "fresh-transcription"` marks the array as measured rather than read, so two
contradictory numbers for the same word are always distinguishable. The `transcript is not
word-level` warning never fires alongside it: those cues did not come from that transcript.

The window rules still hold. Ask for the span you doubt, not a slice — a fragment under a couple
of seconds transcribes as noise here exactly as it does everywhere else, and word timings over
noise are noise with decimal places.

A window with **no words but real level** is the case worth stopping on. Something is audible
that the transcript never saw, which is what `vcut nonspeech` exists to find — see
`--section muletillas`.

**`--positions` sweeps several windows in one call.** Comma-separated seconds, one object per
position, same shape a single `--at` returns, in the order given. Works with `--transcript` and
`--transcribe` alike. Mutually exclusive with `--at`/`--through`: combine them and it is a
usage error rather than one silently winning. It exists because sweeping several spans was a
shell loop of individual `--at` calls — one session swept 18 classifier spans exactly that way
— and `locate --sources` already answers a list for the same reason. With `--transcribe`,
positions transcribe strictly sequentially, never concurrently: each call loads a Whisper model
into memory, and racing several is the load that chokes a machine already carrying a video
editor.
