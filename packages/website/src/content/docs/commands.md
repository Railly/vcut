---
title: Commands
description: Every vcut command, its flags, and what it refuses to do.
order: 2
---

## Commands

```
vcut <input>                       Shorthand for: vcut detect <input>
vcut detect <input> [flags]        Find silences and review candidates
vcut suspects --detect <path>      Where to look first, ranked, without reading the file
vcut edl build [flags]             Turn a detect report into a draft EDL
vcut semantic export|check|review  Hand the transcript to a model, take proposals back
vcut render --edl <path> [flags]   Render an EDL to video
vcut locate --edl <path> [flags]   Translate between master time and source time
vcut audit --edl <path> --render <path>  Check a render against the EDL it came from
vcut say <media> [flags]           Read back what is spoken at a position
vcut silences <media> [flags]      Speech/silence blocks over a range, at a chosen resolution
vcut converge <media> [flags]      Find where a repeated phrase stops coming back
vcut nonspeech <render> [--verify] Find audible sound that is not language
vcut open <media> [flags]          Open or resume a session, map its blocks with stable refs
vcut schema [name]                 Print the JSON contract for a command
vcut skills list|get [name]        Read the bundled agent manual
vcut doctor                        Check external dependencies
vcut init [--no-skills]            Install everything a first run needs
vcut setup classifier              Fetch the optional non-speech classifier
vcut version                       Print the version
```

Global flags: `--json` forces machine output, `--human` forces the summary, `--help` works on any command.

Every JSON output carries `vcutVersion`, the version of the binary that produced it, so an
agent working from a cached manual can tell the tool changed underneath it. Selected outputs
(`suspects`, `detect`, `edl build`, `semantic review`, `nonspeech`, `render --audio-only`) also
carry `next`, a short list of `{question, verb}` naming what to run next — a hint, not an
instruction.

### vcut detect

Runs the deterministic pass. Never edits media, never writes an EDL.

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--input <path>` | — | Source recording. Also accepted positionally. |
| `--preset <name>` | `noisy` | `noisy` (-20 dB), `clean` (-30 dB), `podcast` (-35 dB) |
| `--min-silence <sec>` | `0.3` | Shortest silence worth cutting |
| `--margin <sec>` | `0.10` | Padding kept on each side of speech |
| `--lang <code>` | `es` | Free-form language tag, passed through to the semantic export |
| `--audio <path>` | — | Separate audio recording; silence is measured on this |
| `--transcript <path>` | — | Word-level SRT, used to keep cuts off word edges |
| `--skip-video-scan` | off | Skip black and frozen frame detection |

It reports three kinds of finding: **silences** measured from audio energy, **review candidates** (clipping, black frames, frozen frames), and **warnings** for conditions worth reading before trusting the run.

Review candidates are never cut automatically. They exist so a human looks.

**Filler words are not detected here.** A word list matches tokens, not intent: Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso", and no list survives a language nobody wrote one for. Filler words are proposed by a model through `vcut semantic`, like every other judgement call.

**`--audio` when the sound was recorded separately.** Silence is then measured on that file rather than on the camera track, which matters because the camera track is the one being discarded: cutting against a waveform nobody will hear puts the cuts in the wrong places. The path travels in the report, so `edl build` writes both sources without being told twice.

```bash
vcut detect screen.mp4 --audio mic.wav --preset clean
```

### vcut silences

```bash
vcut silences recording.mp4 --from 327.3 --to 330.5 --noise -33 --min 0.08
```

`detect`'s silence list is the **cutting** instrument, at one threshold and one minimum — the preset proven in production, and what `edl build` cuts against. `silences` is the **placing** instrument: the same measurement, a threshold and minimum you choose, over whatever sub-range you name.

It exists because the gap separating a filler from the next word can measure 80-150ms, well under `detect`'s 0.3s default minimum. Answering "what does the audio do right here, at that resolution" used to mean running raw ffmpeg `silencedetect` by hand and converting `--ss`-relative timestamps back to absolute media time yourself, repeated once per boundary.

| Flag | Default | What it does |
| --- | --- | --- |
| `--from <sec>` | `0` | Start of the range to measure |
| `--to <sec>` | end of media | End of the range to measure |
| `--noise <dB>` | `-30` | Silence threshold |
| `--min <sec>` | `0.25` | Minimum silence duration to report |

`blocks` covers the whole requested range in absolute milliseconds, already offset — no arithmetic left for the caller. Never writes an EDL and never changes what gets cut; `edl build` still cuts against `detect.silences`.

### vcut edl build

Turns a detect report into a draft edit decision list.

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--detect <path>` | required | Report produced by `vcut detect` |
| `--output <path>` | required | Where the rendered master will go |
| `--campaign <id>` | required | Campaign identifier, stored in the EDL |
| `--edl <path>` | `./edl.json` | Where to write the EDL |
| `--width`, `--height`, `--fps` | source values | Output geometry |
| `--edge-fade <ms>` | `50` | Audio ramp at each segment edge; `0` disables |
| `--crop <spec>` | — | `top\|bottom\|left\|right:<fraction>`, or `x,y,width,height` |
| `--semantic <path>` | — | Model proposals from `vcut semantic` |
| `--audio-offset <ms>` | `0` | Shift the separate audio; positive delays it |

**`--crop` frames the whole edit at once**, which is why it lives here and not per segment. A traditional editor makes you set the frame per clip, so remembering the menu bar after cutting means redoing every segment by hand. Here the crop is one decision applied to all of them, and changing it never touches a cut boundary. Fractions, not pixels, so the same EDL survives a source at another resolution.

The command inverts the cut intervals into the spans worth **keeping**, so the EDL always describes surviving material rather than deleted material.

**The build report includes `semanticCuts`, one entry per accepted semantic proposal**: `removedText`, the transcript words that fall inside its final span, and `boundariesInSilence`, whether each edge lands inside a silence `detect` measured. Read `removedText` before rendering — it is the corrective for a span drifting onto the wrong words unnoticed, which happened on a real cut: a repetition proposal removed "todos estamos" instead of the stutter "en nuestra propia" because measured blocks were mis-assigned, invisible until a render and a windowed re-transcription caught it. A warning fires when `removedText` shares fewer than half its carrying words (4+ letters) with the proposal's `reason` and has 4 or more of them itself, the same threshold that keeps a short filler cut from firing on a reason that never repeats it word for word.

It also reports a removal percentage. Compare it against the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.

### vcut suspects

```bash
vcut suspects --detect detect.json
```

Where to look first, ranked, computed from the silences `detect` already measured. No transcript, no model, no second pass over the audio.

A speaker correcting themselves breaks delivery into short pauses that land close together; fluent speech spaces them out. The threshold is a fraction of **this recording's own median gap**, so it adapts to the speaker instead of needing a number per file. Measured across four recordings: hesitant material fires 5.3 to 6.3 times a minute, a take read from a script fires 1.0, and a speaker whose median gap was 8916ms against another's 1170ms did not saturate it.

Longer sources fire *less* per minute rather than more, because a long take carries more thinking pauses and the bar rises with the median: 6.3 a minute at three minutes, 2.8 to 3.5 at four and six.

| Flag | What it does |
| --- | --- |
| `--detect <path>` | Report produced by detect (required) |
| `--pause-ratio <n>` | How close two pauses must be, as a fraction of the file's median gap (default 0.4) |
| `--limit <n>` | Return at most this many positions, tightest first |

**It says where, never what.** Telling a discarded retake from a speaker pausing to pick a related thought lives in content, and rhythm is all this measures. Run `vcut say --transcribe` on a position to find out what is there.

### vcut open

```bash
vcut open recording.mp4 --preset clean --lang es --transcript words.srt
```

Opens or resumes a session keyed by the content of the source, not its path: `~/.vcut/sessions/<sha256-16>/`. The same bytes at two paths share a session; the same path with new content gets one of its own. Everything inside is disposable cache, not an artifact — the EDL a human approves still lives where they wrote it.

`open` runs `detect` once and caches the report. A second `open` on unchanged media at the same preset reuses that cache instead of re-running ffmpeg (`cached: true` in the output); a different `--preset` re-detects and bumps the session's `gen` counter.

Those silences become **refs**: the speech blocks between them, numbered `b001`, `b002`, ... in time order — something a later verb can point at instead of a raw millisecond pair. Refs derive from `detect`'s own silence list, never from `vcut silences`.

| Flag | What it does |
| --- | --- |
| `--preset <name>` | `noisy` (-20 dB, default) \| `clean` (-30 dB) \| `podcast` (-35 dB) |
| `--lang <code>` | Recording language, free-form (default `es`) |
| `--transcript <path>` | Caches an SRT into the session. Without it, `open` still works — refs come from silences, not words |

`open`'s output is counts, not content: duration, preset, gen, silence and block counts, whether a transcript is cached, and the top 10 suspects (same ranking as `suspects`, each with the nearest block ref). No spoken text appears anywhere in it. Reading what a ref actually says, and cutting against refs, are later verbs.

### vcut semantic

Repeated lines, false starts, digressions and filler words need something reading the transcript. **vcut never calls a model.** It exports the lines and takes proposals back, so the judgement stays with whoever is reading.

```bash
vcut semantic export --detect detect.json > lines.json
# read lines.json, write proposals.json
vcut semantic check --proposals proposals.json --detect detect.json
vcut edl build --detect detect.json --semantic proposals.json ...
```

| Subcommand | What it does |
| --- | --- |
| `export --detect <path>` | Numbered lines with timings, rebuilt into words and split on measured pauses |
| `check --proposals <path> --detect <path>` | Validates proposals without building |
| `check --review <path>` | Also fails the round while a repeated phrase goes unnamed |
| `review --edl <path> --detect <path>` | Reads an EDL back: what survives, and where nobody looked |
| `--terse` (export, review) | Omits the instructions block, identical every call and 72% of one measured payload |

A proposal is `{startMs, endMs, kind, reason}` where `kind` is `false-start`, `repetition`, `tangent`, `filler`, or `non-speech`. Every semantic cut lands as `semanticRisk: material` on the segments around it, so a reviewer can find them without reading all of them.

Nothing malformed passes: an inverted span, a span past the end of the source, an unknown kind, or an empty `reason` is refused by index and aborts the build. A proposal that vanished between check and build would read as the model choosing not to cut there, which is worse than a refusal.

**`check --review` is the gate on a round.** Hand it the JSON `review` wrote and it exits **2** while any phrase in `repeated` goes unmentioned by every proposal reason. Naming is the bar, not agreeing: keeping a repeat is often right, and saying why in a reason puts the decision where a human approving the EDL can find it. A phrase still present in the render is reported as `survivingRepeats` and does **not** fail the check, because a callback repeats on purpose and nothing counting words can tell one from a retake. When repeats are named and kept, the status reads `valid-with-kept-repeats` and the exit is 0: a finished round, not a pending one.

**`review` closes the loop.** With `--master` it measures silence on the render itself, and with `--master-transcript` it returns the lines of the render rather than the source projected forward. It also reports `unreviewed`: the stretches between two cuts that no proposal ever touched, which is where a defect survives round after round because its neighbours look worked on.

### vcut setup

```bash
vcut setup classifier
```

Fetches the AudioSet model that `skills/core/scripts/non-speech.py` uses to find breaths, mic bumps and other audible sound that is not language. Around 320MB into `~/.vcut/panns`, and idempotent.

Nothing else needs it: `detect`, `edl build` and `render` all run without it. `vcut doctor` reports whether it is installed, as optional rather than missing.

### vcut render

```bash
vcut render --edl edl.json --mode preview --dry-run
vcut render --edl edl.json --mode preview
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--edl <path>` | required | The EDL to render |
| `--output <path>` | from EDL | Override the output path |
| `--mode <name>` | `preview` | `preview` or `master` |
| `--audio-only` | off | Render the audio alone, for iterating |
| `--dry-run` | off | Print the ffmpeg command without running it |

`preview` accepts proposed segments. `master` refuses unless the EDL is approved, every segment is approved, every source hash still matches, and the output path is free. It will not overwrite.

After rendering, vcut probes the file it produced and validates it against the EDL. A mismatch fails the run instead of shipping a bad file.

**Iterate with `--audio-only`.** Nearly every question a round of edits asks is about sound, and answering it through the video path re-encodes every frame for nothing. Measured on one 22-segment EDL: **0.25s against 31.8s** for the same cuts. The audio graph is unchanged, edge fades and loudness included, so what you hear is what the finished render will sound like: -16.4 LUFS on both paths from the same EDL. It writes lossless audio, because a codec artifact heard while iterating reads as a defect in the cut. Refused in `master` mode.

The result runs a few tens of milliseconds short of the segment sum (31ms on a 54.6s cut). That is `loudnorm` latency draining trailing decay, not missing material; a video render hides it because the picture sets the container duration.

### vcut locate

```bash
vcut locate --edl edl.json --master 50.2 --explain
vcut locate --edl edl.json --source 80.07
vcut locate --edl edl.json --sources 20,53.86,61.2      # several at once
vcut locate --edl edl.json --all
```

Translates between a position in the master and the source it came from.

**Positions are seconds.** The JSON that comes back speaks milliseconds, so passing those back
in is the natural mistake, and it used to be answered as if it made sense: a run asked about
nine positions in milliseconds, got `removed: true` for all nine, and read that as nine spans it
had cut. Both flags now refuse a position past the end of the file and name the unit they
expected. `--sources` takes a comma-separated list, which is a round asking about every boundary
it proposed without a shell loop around it.

**Do not derive this by hand.** Accumulating `outMs - inMs` across segments gives a total that can match the rendered file to the millisecond while individual positions land seconds away, and nothing in that agreement warns you. `--explain` reports the neighbourhood a position sits in, and `--render <path>` measures the file rather than trusting the EDL, which records intent.

```
master 50.200           -> source 84.239  (segment-020)
segment                 source 83.942-85.308, 0.297 in
previous                segment-019 ends master 49.903
cut before it           0.367 of source removed
```

Asking `--source` about material that was cut reports it as removed with the next surviving segment, rather than failing.

### vcut audit

```bash
vcut audit --edl edl.json --render cut.mp4
```

Every check the renderer runs on itself is an aggregate: dimensions, frame count, duration. A render whose segments carried the wrong material passes all of them, because the durations are right whatever ended up inside them. This compares the audio itself, segment by segment, against the source span the EDL points at.

```
audit  22 of 22 segments compared
  agreeing         21 at or above 0.8 correlation
  segment-022      correlation 0.330 at master 52.186 (source 86.842)
```

**A low score is a place to look, not a verdict.** Envelope correlation is weak over short or quiet windows, and loudness normalisation lifts quiet passages by several dB. On the run above, the segment that scored low was carrying exactly the right words. It reports rather than fails, and stays out of `render`, for that reason.

### vcut say

```bash
vcut say cut.mp4 --transcript cut.srt --at 50.2 --edl edl.json    # read the transcript
vcut say cut.mp4 --transcribe --lang es --at 57.5 --window 4      # ask the audio
vcut say cut.mp4 --transcribe --positions 19.5,30.0,41.9          # sweep several positions
```

Reads back what is spoken at a position, with the level there and, with `--edl`, which segment it falls in.

| Flag | What it does |
| --- | --- |
| `--at <sec>` | Position to read around, or the start of a range with `--through` |
| `--through <sec>` | Read everything from `--at` to here rather than a window around it |
| `--positions <list>` | Several positions at once, comma-separated seconds. One object per position, same shape `--at` returns, in order. Mutually exclusive with `--at`/`--through` |
| `--transcript <path>` | Word-level SRT to read from (required unless `--transcribe`) |
| `--transcribe` | Cut the window and run the transcriber over it instead of reading |
| `--lang <code>` | Language passed to the transcriber (`--transcribe` only) |
| `--window <sec>` | How much context to include (default 2) |
| `--media <path>` | Media to measure level on, if not the positional argument |
| `--edl <path>` | Report which segment the position falls in |

**Reading is the default and the cheap path.** A window under about two seconds transcribes as noise regardless of what the audio holds, so a nonsense result from a slice cannot tell a real word from a guess. The existing transcript already knows.

**`--transcribe` is for the case reading cannot answer.** A whole-file pass averages: where a speaker said a line three times it can write it once, and no amount of re-reading recovers the difference. Measured on one recording, reading at 57.5s gave "la que conocemos, ya llegamos a" where transcribing the same window gave "Y a la que conocemos, ya llegue. Y a la que conocemos" — the repetition four runs failed to find. Use a window of four seconds or more, and note it costs one transcriber call. vcut still calls no model of its own: it runs the transcriber already on your PATH, the same way it runs ffmpeg.

A window with no words but real level is the case worth stopping on: something audible the transcript never saw, which is what the non-speech classifier is for.

**`--positions` answers several windows in one call**, because sweeping several spans was a shell loop of individual `--at` calls: one session swept 18 classifier spans exactly that way. With `--transcribe`, positions transcribe strictly sequentially, never concurrently — each call loads a Whisper model into memory, and racing several is the load that chokes a machine already carrying a video editor.

### vcut converge

```bash
vcut converge source.mp4 --phrase "a la que conocemos" --from 59 --lang es
```

Finds where a repeated phrase stops coming back, which is the boundary of a retake. Steps a window forward from `--from`, transcribing each one, and reports the first that no longer carries the phrase along with every window it read getting there.

| Flag | What it does |
| --- | --- |
| `--phrase <words>` | The wording that keeps recurring (required) |
| `--from <sec>` | Where to start stepping (required) |
| `--to <sec>` | Where to give up (default: 12s past `--from`) |
| `--step <sec>` | How far to move each try (default 0.5) |
| `--window <sec>` | How much audio each try transcribes (default 3.5) |
| `--lang <code>` | Language passed to the transcriber |

It exists because that judgement went wrong more often than any other: three runs cut the same retake at 61000, 61020 and 61192ms, all about 1772ms short, and each had verified its number. Every attempt at a retake says the same words, so a window opened anywhere inside one comes back complete and convincing.

**`boundaryMs` is not where to cut.** A retake and the telling that survives it overlap, so the point where the wording disappears sits past the start of the line worth keeping. Cutting to it beheads that line: on one recording, ending at the reported 62000ms gave "Conocemos, ya llegamos a mil miembros" where ending at 61192ms kept "Y a la que conocemos, ya llegamos a mil miembros". Both were rendered and listened to; neither transcript reads as broken. `lastWithPhraseMs` carries that telling in full and sat 308ms from the correct boundary against 808ms for the far edge.

Exit 1 with a null `boundaryMs` means the phrase was still recurring at `--to`, which is a reason to widen the span rather than evidence there is nothing to cut.

### vcut nonspeech

```bash
vcut nonspeech master.mp4                       # spans only, the classifier's own output
vcut nonspeech master.mp4 --verify --lang es     # each span read back through a window
```

Runs the bundled classifier (`skills/core/scripts/non-speech.py`) against a rendered preview and reports audible sound that is not language: a breath, a mic bump, a stretched hesitation the transcript cleans away even with a verbatim preset. Run it on the render, not the source: on raw footage every pause scores as non-speech, correctly and uselessly.

| Flag | What it does |
| --- | --- |
| `--verify` | Re-transcribe a window around each span with `trx` and attach a reading |
| `--lang <code>` | Language passed to the transcriber (`--verify` only) |

**`--verify` is not optional in practice.** Without it you get positions and nothing else, and closing each one against the whole-file transcript is circular: that transcript is exactly the instrument that could not see this class of sound. `--verify` cuts a window of the span plus 1.2s of context on each side and re-transcribes it, attaching `text`, `peakDb`, `meanDb`, and a `reading`:

- `vocalization-suspect` — the window names a hesitation sound (eh, ehm, mmm, aah, tolerant of a stretched vowel), or the span carries real level with no words inside it.
- `words-around` — the window transcribes to ordinary words either side of the span: a breath in a pause.
- `empty` — no words and no real level.

Measured on a real 7.5-minute run: 18 spans closed by reading the whole-file transcript were all read as breaths, and seven turned out to be audible "eeeh" fillers a listener caught on the first playback. `--verify` against the same render named them by their text instead.

The classifier is optional: `python3`, `panns-inference`/`scipy`/`numpy`, and a ~320MB model under `~/.vcut/panns` fetched by `vcut setup classifier`. Its absence is a supported state — `nonspeech` reports it and exits 0, the same policy `vcut doctor` already applies — and invariant 7 falls back to a human ear. `--verify` additionally needs `trx` on PATH. vcut still calls no model of its own: `python3` and `trx` are binaries on the caller's PATH, exactly like `ffmpeg`.

### vcut schema

```bash
vcut schema            # lists the commands with a contract
vcut schema detect     # the field-by-field contract for detect
```

Versioned, so an agent can introspect the output shape at runtime instead of parsing help text or reading source.

### vcut skills

Install the skill into Claude Code, Cursor, or any agent that reads them:

```bash
npx skills add Railly/vcut
```

What gets installed is a **thin stub**. It carries the description an agent matches against and then points at the CLI:

```bash
vcut skills list
vcut skills get core     # the usage guide, raw markdown on stdout
vcut skills path
```

The guide ships inside the npm package and is served by the CLI itself, so it always matches the installed version. A copy pasted into an agent's config would go stale the moment you upgrade; a stub that points at `skills get` cannot.

### vcut doctor

Checks that `ffmpeg` and `ffprobe` are reachable and reports their versions. Exits non-zero when either is missing.

It also reports the optional non-speech classifier, which is a supported absence rather than a failure: without it the check it performs falls back to a human ear.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | The run failed |
| `2` | The invocation was wrong |

One command overloads `2` deliberately: `semantic check --review` exits 2 when a repeated phrase in the round went unnamed by every proposal reason. The invocation was fine; the round was not finished. An agent driving the loop should treat that case as "answer the repeats and run again" rather than as a usage error.

Data always goes to stdout, diagnostics always to stderr.
