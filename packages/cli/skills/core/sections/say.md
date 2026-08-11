## say

```bash
vcut say cut.mp4 --transcript cut.srt --at 50.2
vcut say cut.mp4 --transcript cut.srt --at 50.2 --edl edl.json --window 3
vcut say cut.mp4 --transcribe --positions 19.5,30.0,41.9 --window 4
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
