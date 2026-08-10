---
name: core
description: Core vcut usage guide. Read this before running any vcut command. Covers the detect to EDL to render pipeline, presets and thresholds, the word-level transcript requirement for word clamping, the approval boundary, and what each command refuses to do.
allowed-tools: Bash(vcut:*), Bash(npx @crafter/vcut:*)
---

# vcut core

Find what is worth cutting, propose it, and let a human approve before anything is rendered.

The pipeline is three commands and never skips the middle one:

```
vcut detect <input>  ->  detect.json   (candidates, nothing decided)
vcut edl build       ->  edl.json      (draft, every segment proposed)
vcut render          ->  master.mp4    (preview renders freely; master needs approval)
```

`vcut semantic` is optional and sits beside `edl build`: it hands you the transcript as lines
and folds your proposals back in. It never calls a model on its own.

Silence removal is one round of several, and the rounds after it are where most of the work is.
Read **semantic** before starting a real edit — the commands above will produce a render either
way, and a first pass that stops there ships a recording with its retakes in it.

## Which instrument answers which question

The table below routes a question to a **verb**. The one after it, "What to read", routes a
situation to a **manual section**. Use this one mid-run, when you know what you are asking and
need the command; use the next one when you need the reasoning behind a command you already
ran.

| Question | Verb |
|---|---|
| What in this file is worth cutting? | `detect` |
| Where should I look first in a long file? | `suspects --detect detect.json` |
| What is said at a position — cheap, from an existing transcript? | `say --transcript ... --at <s>` |
| What is actually said there, when the transcript may have averaged it away? | `say --transcribe --at <s>` |
| What is said at several positions at once? | `say --positions <s1,s2,...>` or `locate --sources <s1,s2,...>` |
| Where does a retake's boundary really fall? | `converge --phrase "..." --from <s>` |
| Where exactly, at sub-second resolution, does a boundary belong? | `silences <media> --from <s> --to <s> --min 0.08` — the **placing** instrument, not `detect`'s **cutting** one |
| What audible sound does the transcript not see at all? | `nonspeech <render> --verify` |
| What text is a semantic span about to remove, before I render anything? | `edl build` → read `semanticCuts[].removedText` |
| Did a proposed cut survive into the render? | `semantic review` (what remains), then `semantic check --review` (exit 2 if a named repeat is unanswered) |
| Where in the master does a source position land, or the reverse? | `locate --master <s>` / `locate --source <s>` |
| Did the render carry the wrong material at a join? | `audit --edl <path> --render <path>` |
| Is the cut ready to watch or ship? | `render --mode preview` for every round, `render --mode master` only after human approval |
| Is this machine ready to run vcut at all? | `doctor`, or `init` on a machine that has not run it before |
| What is the field-by-field shape of a command's output? | `schema <name>` |
| What else does this manual cover? | `skills list`, `skills get <name>` |

## What to read

| If you are | Read |
|---|---|
| running the whole edit | **Workflow for an agent**, then **semantic** |
| deciding where to look in a long file | **suspects** |
| asking what is spoken somewhere | **say** |
| checking a breath or a filler the transcript cannot see | **Non-verbal sound needs a classifier, not a statistic**, **The muletillas playbook** |
| placing a boundary at sub-second resolution | **silences** |
| deciding whether a cut is worth making | **semantic → How hard to cut** |
| trying to stop the loop | **semantic → Before calling it done** |
| looking at a render that came out wrong | **When something comes out wrong** |
| wondering what vcut refuses to do | **Human decision boundary**, **Limits** |
| about to run this for the first time | **What eleven runs taught** — 7 habits, and four of the eleven shipped a defect without them |

## Output contract

Every command writes data to stdout and diagnostics to stderr. JSON is emitted automatically when stdout is not a TTY, so an agent never needs `--json`, though passing it is harmless. Exit code 2 means the invocation was wrong, 1 means the run failed.

**Positions are seconds, everywhere.** `--at`, `--from`, `--source`, `--master` all take
seconds; the JSON that comes back speaks milliseconds. Mixing them up used to answer as if the
question made sense — a run asked `locate` about nine positions in milliseconds, got
`removed: true` for all nine, and read that as nine spans it had cut. Those flags now refuse a
position past the end of the file and say which unit they expected.

**Ask about several positions at once.** `locate --sources 20,53.86,61.2` answers a list,
`say --at X --through Y` reads a range rather than a window around a point, and
`say --positions 19.5,30.0,41.9` answers several windows in one call, one object per position
in the order given. All three exist because a run built them out of shell loops with a JSON
parser inside: one wrote thirty lines of its own SRT parser to read a span this command
already had loaded, another swept 18 classifier spans as 18 individual `say` invocations.
`--positions` transcribes strictly sequentially with `--transcribe`, never concurrently: each
call loads a Whisper model into memory, and racing several is the load that chokes a machine
already carrying a video editor.

**`--human` when you are reading rather than parsing.** Every command takes it, and it answers
in a few lines what the JSON answers in a few hundred. A run spent nine separate `python3`
invocations pulling two or three fields out of objects it had just received, and every one of
those fields is in the human summary already: removal percentage, silence count, whether word
clamping engaged and over how many words, what the review candidates are. Parse the JSON when a
later command needs a value from it; read the summary when you need to know what happened.

**Every JSON output carries `vcutVersion`.** The manual is read once and cached in an agent's
context while the CLI can change underneath it: a session upgraded mid-run and kept hand-rolling
an 18-call window loop for a question `converge`, shipped an hour earlier, already answered in
one call — nothing in the output said the tool had moved. `vcutVersion` is the version that
produced this exact output, stamped once in `emitJson` rather than per command, so no command
can forget it. A version you do not recognize is a reason to run `vcut --help` again rather than
trust what you read earlier in the session.

**Selected outputs carry `next`.** A short array of `{question, verb}`, the same idea as
`converge`'s `means` field: `question` is what you likely want to know next, `verb` is the
literal command to run, with real values from this output filled in where that is cheap. It is
a hint, not an instruction — read it, do not execute it blind, and it is absent wherever there
is nothing to point at (an empty `suspects` list, a `nonspeech` pass with no spans). Present on
`suspects`, `detect`, `edl build`, `semantic review`, `nonspeech` without `--verify`, and
`render --audio-only`.

Run `vcut schema detect|edl|render` for the field-by-field contract instead of parsing `--help`.

## detect

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
```

Presets carry thresholds proven in production. Do not invent new ones.

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Intentional pauses |

`--lang` is the language of the recording, free-form and passed through to the semantic
export so a model knows what it is reading. Nothing parses it. Take it from the speaker, not
from a default: if you do not know, listen to a few seconds or ask, because the transcription
model needs the same answer and guessing wrong there costs the whole transcript.

**Picking one, and knowing when it was wrong.** When the recording matches a row, use it.
When it does not, **start at `clean`** and let the numbers move you: most speech recorded on
purpose sits closer to a room than to an event, and being one step too conservative costs a
round while being too aggressive costs syllables.

Then read the removal percentage `edl build` reports against the target for the content type: far under target usually means the threshold is too low for this room, far over
means it is too high and speech is being cut as silence. Change the preset, not
`--min-silence` or `--margin`, and rebuild.

The symptom of a threshold set too high is specific and worth recognising, because it reads
as a transcription error rather than a cut: a word loses its opening sound. A soft consonant
sits under the threshold, so the detector calls it a pause and cuts it while leaving the vowel
after it. If words come back missing their first syllable, lower the threshold rather than
widening the margin, which only pads around a cut that should not have been there.

**`--audio <path>` when the sound was recorded separately.** Silence is then measured on that
file rather than on the camera track, which matters because the camera track is the one being
thrown away: cutting against a waveform nobody will hear puts the cuts in the wrong places.
`edl build` reads the path from the report and writes both sources into the EDL, so it is only
named once.

```bash
vcut detect screen.mp4 --audio mic.wav --preset clean
vcut edl build --detect detect.json ...        # two sources, no extra flag
```

Two recordings started by the same app share a clock, so they need no correction. For two
separate recorders, `--audio-offset <ms>` on `edl build` shifts the window the audio is read
from; positive means the audio file is ahead of the picture.

Other flags: `--min-silence` (seconds, default 0.3), `--margin` (seconds, default 0.10), `--skip-video-scan` to skip black and frozen frame detection on long sources.

**Word clamping needs word-level timestamps**, meaning one cue per word. A sentence-level SRT turns clamping off, with a warning rather than a guess. Generate a usable transcript with either:

```bash
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav -l es \
  --max-len 1 --split-on-word --output-srt
```

`trx transcribe <input> --words --language es -m large-v3-turbo` produces word-level cues from
`trx@0.7.1` on. Earlier versions passed `--max-len` without `--split-on-word`, which is worth
knowing because of what that produces.

**Ask it for a verbatim transcript, or it is not equivalent to the invocation above.** Without
a prompt a transcriber cleans, and the hesitations this manual tells you to keep never reach
the transcript. On one recording the prompted run recovered a three-attempt retake that the
unprompted run collapsed into a single phrase, which was the largest cut available in that
take: a semantic round is blind to what it never sees.

```bash
trx transcribe <input> --words --language es --preset verbatim
```

`--preset verbatim` carries the prompt for the language being transcribed. On a `trx` too old
to have it, drive `whisper-cli` directly with the `--prompt` above.

One more thing about feeding `trx` a file: hand it the recording, not a `.wav` you extracted
yourself. Measured on a 90.5s source, the `.mp4` produced 410 cues and a pre-extracted mono
16kHz `.wav` produced 5, with `"success": true` and no warning either way.

**`--split-on-word` is not optional.** Without it `--max-len 1` cuts at token boundaries, so a
multi-token word arrives split and the transcript looks word-level while being useless for
clamping: measured on one recording, 26% of cues were fragments without the flag and 0% with
it. `detect` reports `wordLevel: true` either way, because it counts cues rather than judging
them.

`detect` now warns when more than a tenth of the cues continue a word instead of starting one.
**Read that warning**: it is the difference between a transcript that constrains cuts and one
that only appears to. You can check it yourself the same way, since a leading space is how the
model marks where a word begins:

```bash
grep -c '^ ' words.srt      # should be close to the cue count, not a fraction of it
```

**Word timings drift toward silence, and detect now says so.** A model stretches a cue
backwards into the pause before the word, so the cue claims speech where the waveform has
none. Clamping trusts that claim and holds a boundary open around it, which is how room tone
survives a cut that was detected correctly:

```
warning   60 transcript cues claim a word starts inside measured silence. The largest is
          "honor?" at 75.64s, where the audio stays silent for another 1318ms.
```

**Read that as a transcript problem, not a threshold one.** Dead air in the render looks
exactly like a threshold set too low, so the reflex is to change the preset. One session did
that: the more conservative preset moved the boundary by 12ms and explained nothing, because
the detector had been right and the transcript was wrong. Check the named position with
`vcut say` before touching anything.

The count is usually not small — 60 of 217 cues on one recording — because the drift is
systematic rather than exceptional. There is no threshold to filter it: measured on that same
recording it ran from 1318ms down to a median of 246ms with no gap anywhere. That is why the
warning names the worst case with its position instead of pretending a cut-off exists.

**A word can also run long for the opposite reason, and that one is not benign.** Drift stretches
a cue over *silence*. A transcript that fused several attempts at the same line stretches a cue
over *speech*: the model heard the phrase three times, wrote it once, and the surviving word
carries the time all three occupied. Both surface as an unusually long cue, which is why the
warning above cannot tell you which you have, and why reading it as drift and moving on is the
trap. One run did exactly that and lost a round to it.

Tell them apart by what the audio does inside the cue's own span. Drift is speech at the start
and silence for the rest; fusion holds voice across the whole span. Measure with `vcut say`
around the word rather than trusting either reading:

```bash
vcut say <media> --transcript words.srt --at <the position the warning names> --window 4
vcut say <media> --transcribe --lang es --at <position> --window 4   # ask the audio instead
```

`--transcribe` cuts the window and runs the transcriber over it rather than reading the
whole-file transcript, which is the only way to see what a fused region actually contains. On
one recording, reading gave "la que conocemos, ya llegamos a" at a position where transcribing
the same window gave "Y a la que conocemos, ya llegue. Y a la que conocemos" — the repetition
that four runs failed to find. It needs the media, not a transcript, and costs one transcriber
call.

Normalise duration per character before comparing anything, or long words look pathological on
their length alone: on one recording `emprendedores,` ran 980ms and came to 70ms per character,
ordinary, while `conocemos,` ran 2590ms at 259ms per character against a file median of 79.

**When the audio holds voice through a long cue, re-transcribe that window on its own before
cutting anything near it.** A whole-file pass is what averaged the repetitions away, so asking
it again changes nothing; a 4 to 8 second window returns them. Two windows of different lengths
that disagree on the word count for the same overlap is the signature. On one recording the
90-second transcript wrote "Y a la que conocemos, ya llegamos" once, and short windows over the
same span returned it three times with an "ah, otra vez" between them — a retake the loop cannot
cut because nothing downstream knows it was said.

**Ask the model to keep the hesitations.** A transcriber cleans by default: it writes what it
believes was meant, so a stretched vowel or a tag question is dropped as noise. Those are
exactly the spans worth cutting, and one that never reaches the transcript cannot be proposed.

```bash
whisper-cli -m ggml-large-v3-turbo.bin -f audio.wav --max-len 1 --output-srt \
  --prompt "Transcripción literal. Incluí muletillas, dudas y sonidos: eh, mmm, o sea."
```

Write the prompt in the language being transcribed and name the sounds that language actually
uses; a list written for one language is noise in another. It recovers some of them, not all,
which is why the classifier still has a job.

**Ask for a large model too.** Model size and the split flag are separate causes of the same
symptom. Measured on three minutes of Spanish: `small` returned 26% of its cues as fragments,
splitting "Crafter" into `Cra` + `fter`, where `large-v3-turbo` returned 0% and cost 13
seconds. Fragments weaken the word clamping that keeps cuts off speech, and they make the
semantic export unreadable.

**detect does not look for filler words, and that is deliberate.** It used to carry a list of six tokens per language. Measured on one Spanish recording, that list caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that happened to carry no meaning in that one sentence, which is most of them and is why no list would have helped.

A list also cannot tell filler from real use. Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso"; `claro` is filler in "y claro, entonces" and an answer on its own. Extending the list makes it worse, not better: the same token is filler or content depending on the clause around it, and a list has no clauses in it. And every new language would need one written from scratch.

**Fillers are the model's job, through `vcut semantic`.** Read the exported lines, mark the discourse markers that carry nothing *in that sentence*, and leave the ones doing work. `kind: "filler"` exists in the proposal schema for exactly this.

`review` entries (clipping, black frames, frozen frames) are candidates for a human to look at. They are never cut automatically.

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

## edl build

```bash
vcut edl build --detect detect.json --output master.mp4 --campaign my-video
```

`--campaign` is a required free-form label that rides along in the EDL so a later reader can
tell which piece of work it belongs to. Nothing parses it; any stable string works.

Inverts the cut intervals into the spans worth keeping, so the EDL always describes surviving material. Boundaries are snapped to whole frames; unsnapped boundaries accumulate rounding error and make the renderer reject the result with a frame count mismatch.

Flags: `--edl <path>` (default `./edl.json`), `--width`, `--height`, `--fps`, `--edge-fade <ms>` (default 50), `--semantic <path>`, `--crop <spec>`.

**`--crop` frames the whole edit at once**, which is the reason it lives here and not in the
renderer's per-segment field. A traditional editor makes you set the frame per clip, so
remembering the menu bar after cutting means redoing every segment by hand. Here the crop is
one decision applied to all of them, and changing it never touches a cut boundary.

```bash
vcut edl build --detect detect.json --crop top:0.06 ...   # shave 6% off the top
vcut edl build --detect detect.json --crop 0.1,0,0.8,1 ...  # arbitrary window
```

Fractions, not pixels, so the same EDL survives a source at another resolution.

Every segment is written as `proposed` and the EDL as `draft`. **This command never approves its own work.**

**Read the boundary warnings.** When a segment opens right after a semantic cut, the build says so:

```
warning   segment-020 opens right after a semantic cut of 5.83s (18 words). A tail of removed
          speech surviving that join reads as a real sentence, so check it once rendered.
```

That is where the tail of removed speech leaks into the render, and it does not arrive looking
like a defect: it arrives as a plausible sentence with the wrong meaning, which reads as a
transcription error rather than a cut. Checking one is two commands — `vcut locate` for the
master position, `vcut say` to hear what landed there.

Only semantic cuts raise this. Silence cuts do not, and that is deliberate: with word clamping
every silence cut brushes the margin around a word, so keying the warning on "words were
removed" fired on 23 of 24 boundaries on a real EDL and would have trained you to skip it.

**Read `semanticCuts[].removedText` before rendering.** Every accepted semantic proposal gets
its own entry in the build report: the transcript words that fall inside its final span, and
whether each boundary lands inside a silence `detect` measured.

```
semantic cuts   2
  323.63-328.70s  repetition: "luego, no sé, puede pasar muchas cosas y cada uno está..."
  333.85-335.99s  repetition: "o sea, todos estamos en nuestro"
```

This is the corrective for a specific, already-shipped mistake: a repetition cut once removed
"todos estamos" instead of the stutter "en nuestra propia" because measured blocks were
mis-assigned to words. The mistake was invisible until a render and a windowed
re-transcription caught it. `removedText` makes the actual span legible at build time, before
any of that — read it and ask whether it matches what the `reason` describes.

`edl build` now asks that question for you where it can. A span whose `removedText` shares
fewer than half its carrying words (4+ letters, same comparison `converge` uses) with its own
`reason`, and has 4 or more carrying words itself, gets a warning:

```
warning   semantic cut 323.63-328.70s removes "luego, no sé, puede pasar muchas cosas y cada
          uno está en su propio ritmo,", which the reason does not mention ("'y cada uno esta
          en su propio ritmo, en su propia carrera' repite..."). Read removedText before
          rendering: a span can drift onto the wrong words when measured blocks are
          mis-assigned.
```

A short span (a lone filler, a couple of words) never fires this: it does not carry enough
signal to call disjoint, and firing there would train a reader to skip it, the same reasoning
behind not keying the boundary warning on "words were removed." `boundariesInSilence` is
reported alongside but not gated on — a semantic boundary landing in speech rather than
silence is common and not itself wrong, since the model chose it by meaning, not by pause.

Compare the reported `removalPercent` against the target for the content type:

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

A number far below target usually means the source was already edited.

## render

```bash
vcut render --edl edl.json --mode preview --dry-run
vcut render --edl edl.json --mode preview
```

Preview mode accepts proposed segments. Master mode requires an approved EDL, approved segments, matching source hashes, and a free output path; it refuses to overwrite.

**Render `--audio-only` for every round. Render video once, at the end, and not before.** This
is the default, not an optimisation to remember: every question a round asks is about sound —
whether a filler survived, whether a boundary clipped a word, whether an idea is still said
twice. Answering those through the video path re-encodes every frame for nothing. Measured on
one 22-segment EDL: **0.25s against 31.8s** for the same cuts.

```bash
vcut render --edl edl.json --audio-only          # rounds 1..n
vcut render --edl edl.json                        # once, at the end
```

The pull toward a video render is a check that wants a picture — `audit`, the non-speech pass,
a look at the frames. Those belong to the final render, after the transcript reads clean; run
them per round and they cost more than the cutting does. One run spent 69 of its 105 seconds of
tool time on two video renders, the second of them purely to feed checks that changed no
decision, while the repetition it was supposed to catch survived to the master.

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

## locate

```bash
vcut locate --edl edl.json --master 50.2 --explain
vcut locate --edl edl.json --source 80.07
vcut locate --edl edl.json --all
```

Translates between a position in the master and the source it came from. Reviewing a cut
means asking this constantly, and there is a trap in answering it by hand.

**Do not derive the mapping yourself.** Accumulating `outMs - inMs` across segments gives a
total that can match the rendered file to the millisecond while individual positions land
seconds away from where they really came from. The sum agreeing with the container is not
evidence that any single position is right, and there is nothing in that agreement to warn
you. `locate` does the same arithmetic, but `--explain` reports the neighbourhood a position
sits in, and `--render <path>` measures the file instead of trusting the EDL.

```
master 50.200           -> source 84.239  (segment-020)
segment                 source 83.942-85.308, 0.297 in
previous                segment-019 ends master 49.903
cut before it           0.367 of source removed
```

`cut before it` is worth reading. A boundary with a large cut behind it is where the tail of
removed speech survives into the render.

Asking `--source` about material that was cut is a normal question: it reports the span as
removed and names the next surviving segment, rather than failing.

The EDL records intent. Only the render says what happened, which is why the two can disagree
and why `--render` exists.

## audit

```bash
vcut audit --edl edl.json --render cut.mp4
```

Every check the renderer runs on itself is an aggregate: dimensions, frame count, duration.
A render whose segments carried the wrong material passes all of them, because the durations
are right whatever ended up inside them. This compares the audio itself, segment by segment,
against the source span the EDL points at.

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
that the transcript never saw, which is what `vcut nonspeech` exists to find — see "The
muletillas playbook" below `semantic`.

**`--positions` sweeps several windows in one call.** Comma-separated seconds, one object per
position, same shape a single `--at` returns, in the order given. Works with `--transcript` and
`--transcribe` alike. Mutually exclusive with `--at`/`--through`: combine them and it is a
usage error rather than one silently winning. It exists because sweeping several spans was a
shell loop of individual `--at` calls — one session swept 18 classifier spans exactly that way
— and `locate --sources` already answers a list for the same reason. With `--transcribe`,
positions transcribe strictly sequentially, never concurrently: each call loads a Whisper model
into memory, and racing several is the load that chokes a machine already carrying a video
editor.

## converge

```bash
vcut converge <media> --phrase "the wording that keeps recurring" --from <sec> --lang es
```

Where a repeated phrase stops coming back, which is the boundary of a retake. Steps a window
forward from `--from`, transcribing each one, and reports the first that no longer carries the
phrase along with every window it read getting there.

It exists because that judgement went wrong more often than any other: three runs cut the same
retake at 61000, 61020 and 61192ms, all about 1772ms short, and each had verified its number.
Every attempt at a retake says the same words, so a window opened anywhere inside one comes
back complete and convincing.

Matching is on the carrying words rather than the phrase as typed. A short window transcribes
without the context the rest of the file gives, so the same audio came back as "a la que
conocemos" in one window and "ahora que conocemos" in the next; comparing words of four letters
or more survives that, and separated cleanly on the case measured — 1.00 inside the retake,
0.00 past it.

`--to` bounds the search and defaults to twelve seconds past `--from`. A null `boundaryMs` with
exit 1 means the phrase was still recurring at the end of that span, which is a reason to widen
it rather than evidence there is nothing to cut.

**The boundary it reports is where the repetition ends, which is not where the telling you are
keeping begins.** Those differ, and cutting to the first is how you lose the opening of the
last attempt. On the recording above it answered 62000ms — past that the audio reads "ya
llegamos a mil miembros" — while the surviving segment starts at 61192ms and carries "Y a la
que conocemos, ya llegamos a mil miembros", the whole line. The last attempt begins before the
previous one has finished being recognisable.

So read the boundary as the far edge of what is safe to remove, then walk back to the start of
the final telling and end the cut there. `edl build` clamps to measured silence, which usually
lands it correctly, but the span you propose should already name the line you mean to keep
rather than the point where the words stopped repeating.

Both cuts were rendered and listened to. Ending at 61192ms keeps "Y a la que conocemos, ya
llegamos a mil miembros". Ending at 62000ms buys 0.7 seconds and leaves "Conocemos, ya llegamos
a mil miembros" — the line beheaded, and audibly wrong. Neither transcript reads as broken; the
difference only shows up in the ear, which is the reason the approval step is a human's.

## nonspeech

```bash
vcut nonspeech master.mp4                      # spans only, the classifier's own output
vcut nonspeech master.mp4 --verify --lang es    # each span read back through a window
```

Runs `skills/core/scripts/non-speech.py` against a rendered preview and reports audible sound
that is not language: a breath, a mic bump, a stretched hesitation the transcript cleaned
away even with a verbatim preset. Run it on the render, never on the source: on raw footage
every pause scores as non-speech, correctly and uselessly.

**Always run it with `--verify`.** Without it you get positions and nothing else, and the
instinct is to check each one against the whole-file transcript with `vcut say`, which is
circular for this class of sound: the transcript is exactly the instrument that could not see
it. `--verify` cuts a window of the span plus 1.2s of context on each side and re-transcribes
it with `trx`, attaching `text`, `peakDb`, `meanDb`, and a `reading`:

- `vocalization-suspect` — the window's transcript names a hesitation sound (eh, ehm, mmm, aah,
  tolerant of a stretched vowel), or the span carries real level with no words inside it.
- `words-around` — the window transcribes to ordinary words sitting either side of the span:
  a breath in a pause.
- `empty` — no words and no real level.

`words-around` needs no ear. `empty` at real level is still a question for a listener: neither
a hesitation token nor the transcript explains what the classifier heard there, and that is
exactly the case no amount of re-reading settles.

Measured on a real 7.5-minute run: 18 spans closed by reading the whole-file transcript were
all read as breaths, four spot-checked and cleared, and seven turned out to be audible "eeeh"
fillers the listener caught on the first playback. `--verify` against the same render read the
same spans and named the fillers by their text.

The classifier is optional — `python3`, `panns-inference`/`scipy`/`numpy`, and a ~320MB model
under `~/.vcut/panns` fetched by `vcut setup classifier`. Its absence is a supported state:
`nonspeech` says so and exits 0, the same policy `vcut doctor` already applies, and invariant 7
falls back to a human ear. `--verify` additionally needs `trx` on PATH, the same as
`say --transcribe`. vcut calls no model of its own either way: `python3` and `trx` are binaries
on the caller's PATH, exactly like `ffmpeg`.

## When something comes out wrong

```bash
vcut skills get debug
```

Read it before diagnosing a render that sounds off, a word that seems cut in half, dead air
that survived a cut, or a transcript whose positions do not match the audio. Every method in
it is cheap; none of them is the obvious one. It exists because for each of those questions
there is a more rigorous-looking instrument that cannot tell the hypotheses apart, and reaching
for it is how confident wrong answers get written down.

## Human decision boundary

vcut proposes. The human decides.

| vcut may propose | The human decides |
| --- | --- |
| silence cuts | delivery quality |
| review candidates | semantic changes |
| crop options | acceptable jump cuts |
| | which mistakes stay human |

Never mark segments approved on the human's behalf. Never render a master without explicit approval. Never overwrite source media.

## Workflow for an agent

1. `vcut init` on a machine that has not run this before. It installs ffmpeg through brew if
   that is missing, the transcriber, the transcription model and the skills, and reports
   anything it could not do. The model is the piece worth naming: without a large one the
   semantic pass reads a transcript split mid-token, so its absence produces a worse cut rather
   than an error. `vcut doctor` any time something looks wrong afterwards.
2. Transcribe the source word-level with a large model.
3. `vcut detect <input>` with the preset that matches the recording condition.
4. Read the warnings. If the transcript is not word-level, say so: clamping is off and cuts can land inside a word.
5. `vcut suspects --detect detect.json` for where to look, then `vcut semantic export --terse`
   for the lines. On a short take, read every line. On anything long, the suspects list is the
   order to read in: it costs one call and turns a file you have to read into a list you have
   to check. Neither replaces the other — a repetition with no hesitation around it has no
   rhythm signal at all and only the prose shows it.
6. **Loop**: build, render, transcribe the render, review, fold findings back in. Repeat
   until a round proposes nothing and every invariant holds, and **never stop at one round** —
   the empty round has to come after a round that found something, because it reads a text the
   previous one produced. Runs that stopped at one shipped a repetition and cut less than the
   ones that kept going. This is where most of the work is. The full procedure is under
   `semantic` below.

   ```bash
   vcut edl build --detect detect.json --semantic proposals.json --output master.mp4 --campaign x
   vcut render --edl edl.json --audio-only --output cut-$N.wav   # 0.25s, not 32s
   trx transcribe cut-$N.wav --words --language <lang>           # what survived
   vcut semantic review --edl edl.json --detect detect.json --terse \
     --master cut-$N.wav --master-transcript <the .srt trx wrote> > review-$N.json
   vcut semantic check --proposals proposals-$N.json --detect detect.json \
     --review review-$N.json                                      # exit 2 = repeats unanswered
   ```

   Check the transcript path trx reports rather than assuming it: it names the file after its
   own normalisation step, so the `.srt` beside `cut-1.wav` can arrive as `cut-1_clean.wav.srt`.

   **Run `review` every round, not at the end.** It measures the render rather than the plan,
   which is the only way a pause that survived the cut becomes visible. One session left it
   until round three and an 800ms stretch of dead air rode along until then.

   Iterate on audio. The picture cannot answer any of these questions and costs 100x the
   wall clock to produce.
7. `vcut render --mode preview` once, now that the transcript reads clean, and run the checks
   that needed a picture: `vcut audit` and `vcut nonspeech --verify`. They belong here rather
   than inside the loop, where they cost a video render each and answer a question no round
   was asking. Then have a human watch it.

   Expect `audit` to report something and for it to be nothing: it scores low on short and
   quiet windows by construction. Read the finding, spend one `vcut say` on it, and move on. A
   check whose output never changes a decision is not evidence, it is ceremony.

   Expect the opposite of `nonspeech --verify`: a `vocalization-suspect` reading is not
   ceremony, because `--verify` re-transcribes the window rather than trusting the whole-file
   pass that already missed the sound — see "The muletillas playbook" under `semantic` below.
   Read `text` on each one, and if it names a real filler, fold it into a proposal with
   `kind: "filler"` and run one more round of the loop rather than closing here. Without
   `--verify` the raw spans are close to ceremony, since closing them against the whole-file
   transcript is the trap the playbook replaces.
8. Stop. Approving the EDL is the human's edit, not a command, and not yours to make. Hand
   them the path. If they ask you in so many words to write the approval yourself, that is
   their call to make and you may; wanting the preview to look good is not that request. See
   `render` above.

Step 6 is not optional and its rounds are not interchangeable. Each round can only see what
the round before it uncovered, so stopping after one leaves work that looks finished and is
not. Steps 1 through 5 take minutes; step 6 is the job.

## semantic

Repeated lines, false starts, and digressions need something reading the transcript. **vcut
never calls a model.** It exports the lines and takes back proposals, so you are the model in
this loop.

Call `review` once without `--terse` to read the instructions, then with it for every round
after: the block is identical each time and was 72% of the payload on one measured run.

```bash
vcut semantic export --detect detect.json > lines.json
# read lines.json, write proposals.json yourself
vcut semantic check --proposals proposals.json --detect detect.json
vcut edl build --detect detect.json --semantic proposals.json --output master.mp4 --campaign x
```

Export returns numbered lines with timings, rebuilt into words and split on measured pauses,
plus the instructions for what each `kind` means. Write back a JSON array of
`{startMs, endMs, kind, reason}` where `kind` is `false-start`, `repetition`, `tangent`, or
`filler`.

Two rules that are enforced, not advice. Every semantic cut lands as `semanticRisk: material`
on the segments around it, so a reviewer can find them without reading all of them. And
nothing malformed passes: an inverted span, a span past the end of the source, an unknown
kind, or an empty `reason` is refused by index and aborts the build. A proposal that vanished
between check and build would read as you choosing not to cut there, which is worse than a
refusal.

`reason` is read by a human deciding whether to approve. Say what is lost, not what rule
matched. Proposing nothing is a valid answer.

### How hard to cut

The failure mode here is not cutting something precious. It is being polite: reading the
transcript as an argument to preserve rather than a recording to edit, and leaving the work
undone while reporting it finished.

The shape it takes: a speaker returns to the same point across a recording, each time in
different words and far enough apart that each reads as a separate beat of the argument. Cut
one, leave the rest. Then the edit plays back at speed, the distance collapses, and a listener
hears the repetition immediately.

Hold this bar:

- **Count the idea, not the sentence.** Before proposing, list what the recording actually
  says. If one idea appears three times across the transcript, that is one idea and two cuts,
  however far apart they sit. Distance between them is not evidence they differ.
- **Keep the best telling, not the first.** The clearest version is often the last one, after
  the speaker has worked out how to say it. Cut the rehearsals.
- **A whole paragraph is a normal proposal.** False starts and restatements run for ten or
  fifteen seconds. A span that only ever covers a few hundred milliseconds means fillers were
  found and redundancy was not.
- **Cut to the end of the clause.** Half a sentence surviving its own cut is worse than
  leaving the passage whole.
- **Check the target range, and do not edit toward it.** `edl build` prints what the removal
  percentage is in range for. Raw speech landing in "scripted talking head" usually means the
  semantic pass was timid, not that the recording was already tight — that direction is worth
  acting on. The other direction is not: landing above the range you picked is not a reason to
  put anything back. Nothing classifies the recording for you, so the range you compare against
  came from your own reading of what the material is, and a number that disagrees with a
  judgement you made is not evidence. Four runs on one recording removed between 19.1 and 31.0
  seconds of the same 90, all four correct on every defect and differing only on the passages
  where cutting was a matter of taste. Say which content type you compared against and move on.

The counterweight is real and it is the human's, not yours: it is their voice, and a cut that
strips the thinking out of a reflection makes it sound like a script. Propose the cut, say
what is lost in `reason`, and let them refuse it. Under-proposing takes that decision away
from them just as much as over-cutting does, only silently.

### One pass is never the answer

**Cut, render, transcribe the render, read it again, cut again. Until a pass proposes
nothing.** A single pass cannot be enough, because most of what needs cutting is invisible
until the surrounding noise is gone.

Each class of defect only becomes visible once the one above it is gone, which is why the
order is fixed and why stopping early leaves work that looks like polish and is not:

| Round | Only visible now because |
| --- | --- |
| 1 | Nothing hides long silence or an obvious stammer |
| 2 | A pause two adjoining segments create together did not exist in either of them before |
| 3 | A join reads as broken only once both sides are adjacent, and a surviving redundancy only once the passage is short enough to hold in your head |
| 4 | A discourse marker is inaudible inside loose speech and obvious inside tight speech |

#### The round, in order

Run every step every round. Skipping one is how a defect survives several of them, and the way
it fails is quiet: the round still produces a shorter file, so it looks like it worked.

The step most often skipped is 3, because step 2 already produced a transcript and reading it
feels like reviewing. It is not. The transcript says what was said; `review` says where nobody
looked. A round that transcribed but did not run `review` has checked only one of the eight
invariants.

**A listener finding something you did not is evidence about the pass, not just about the
edit.** Before fixing what they named, ask which step would have caught it. If the answer is
a step that ran, the step needs strengthening; if it is a step that did not, that is the
finding.

Give each round its own output path, or delete the previous one first. The renderer refuses
to overwrite, so a second round pointed at the same file fails with `output already exists`
before it renders anything. Numbering them also leaves the earlier cuts on disk to compare
against, which is the only way to tell whether a round improved the edit or just shortened
it.

```bash
N=1   # bump every round: the renderer refuses to overwrite

# 1. Build and render from the current proposals, audio only
#    edl build validates the proposals itself and aborts on a malformed one, so a separate
#    `semantic check` is only worth running to see the errors without building.
vcut edl build --detect detect.json --semantic proposals.json \
  --output cut-$N.mp4 --campaign my-video --edl edl-$N.json
vcut render --edl edl-$N.json --audio-only --output cut-$N.wav   # 0.25s, not 32s

# 2. Transcribe the RENDER, never reuse the previous transcript
trx transcribe cut-$N.wav --words --language <lang> -m large-v3-turbo

# 3. Read the result and where nobody looked
vcut semantic review --edl edl-$N.json --detect detect.json \
  --master cut-$N.wav --master-transcript <the .srt trx wrote>

# 4. Fold findings back into proposals.json, bump N, repeat from 1
```

The classifier's non-speech pass needs a picture and answers a question no round above is
asking, so it runs once, on the final `--mode preview` render, not inside this loop — see
"The muletillas playbook" above and step 7 of "Workflow for an agent". Running the video path
every round to feed it costs a render each and finds nothing the loop's audio steps could not,
which is the same ceremony trap `audit` falls into below.

```bash
vcut nonspeech cut-final.mp4 --verify --lang <lang> > non-speech.json
```

**Always run with `--verify`.** Without it you get the classifier's raw spans and nothing
else, which puts you back where the manual used to leave you: closing each hit by reading the
whole-file transcript, which is circular for this class of sound (see "Non-verbal sound needs
a classifier" below for why). `--verify` re-transcribes a short window around each span with
`trx` and attaches a `reading`: `vocalization-suspect` for a hesitation sound or unexplained
level, `words-around` for a breath sitting between ordinary words, `empty` for nothing at real
level. Read `text` on every `vocalization-suspect` span before folding it into a proposal, and
treat an `empty` span at real level as a question for a listener, not a false positive to wave
off — it means neither the transcript nor a hesitation token explains what the classifier
heard, which is exactly the case a human ear has to settle.

Its timings are the **master** timeline, so map them back through the EDL before adding a
finding as a proposal, and a master span can cross a cut, which means one span maps to
several source spans and taking only its endpoints yields a range covering everything between.

`vcut doctor` reports whether the classifier is installed and `vcut setup classifier` fetches
it, around 320MB into `~/.vcut/panns`. It also needs `pip install panns-inference scipy
numpy`, and `--verify` needs `trx` on PATH, same as `say --transcribe`.

If the classifier is not installed, `vcut nonspeech` says so and exits 0 rather than failing:
absence is a supported state, the same policy `vcut doctor` already applies elsewhere.
Invariant 7 still holds, and without the classifier the only instrument left for it is a
human ear: say that in the handoff rather than reporting the edit as verified. It is the one
check that cannot be read off any text.

Folding a real `vocalization-suspect` finding back in reopens the loop: propose it with
`kind: "filler"`, quoting the recovered `text` in the reason, and run another round of the
three audio steps above so the fresh cut gets read back before the next picture render.

#### Working a round

**A whole-file transcript averages. Re-transcribe the passage.** A model reading ninety
seconds collapses three attempts at the same line into one, because one line is the likelier
sentence. The same audio cut to twelve seconds returns all three. When a listener reports
something the transcript does not show, transcribe just that stretch before concluding the
transcript is right.

**A mapping between timelines is a claim, not a fact.** Every proposal is written against
source timings and every finding arrives in master timings, so the two are converted
constantly and a converted number looks exactly as confident as a measured one. When a
finding contradicts the mapping, check the mapping first: it is the newer of the two claims.
Cheapest test is to convert a known landmark and see whether it lands where the audio says it
does.

**Read `unreviewed` before anything else, and read each span against its neighbours.** A pass
reads what it went looking for, so cuts land where the attention was and the stretches between
two cuts are where nothing was ever read. They look reviewed because their neighbours are.
`review` lists them with their text; apply the deletion test to every span in that list before
scanning anywhere else. A marker that survives several rounds is almost always sitting in one.

The deletion test asks whether a span repeats something already said, not whether it stands up
alone. Every line stands up alone — that is why a round can read all of `unreviewed`, judge
each entry sound, and still ship a repetition. Print each `unreviewed` span with the line
before and after it, then read `lines` concatenated as continuous prose. A repeated idea lives
*between* two lines and is invisible to any pass that evaluates them one at a time.

The shape to look for: a sentence ends on a phrase, and the next line opens by restating that
same phrase to get moving again. Speakers do this to bridge a pause, and both halves parse as
ordinary grammar, so nothing reads as broken. Two rounds on the same recording cleared one of
these. The first never compared the two lines; the second compared them, decided the second
mention "connects to what came before", and kept it. Connecting to what came before is what a
restatement does — the question is whether the sentence still lands with the phrase deleted. If
it does, the phrase is a bridge, and the bridge goes.

**A phrase can recur because the speaker restarted or because the writing came back to it, and
only one of those is a cut.** The difference is not in how the repetition reads — both read
fine — but in what follows it. A retake is followed by another attempt at the same sentence,
and usually by the speaker marking the discard out loud. A callback recurs while the sentence
around it carries the idea somewhere new: "a forma muy distinta a la que conocemos hoy en día.
Y a la que conocemos, ya llegamos a mil miembros" repeats four words and the second clause says
something the first did not. Cutting that flattens the writing.

One recording carries both twelve seconds apart, which is why a rule keyed on the wording alone
gets one of them wrong every time. Ask what the second occurrence does, not whether it repeats.

Two tests settle it. **The discard marker**: a retake carries a spoken tag between the attempts
— "otra vez", "no, así no" — and its absence is evidence, not a missing detail. **What depends
on each occurrence**: in a retake both attempts serve the same clause, so deleting the first
loses nothing. In a callback each occurrence is the antecedent for different material, and
deleting either leaves a sentence without its subject.

**A speaker judging their own take is always a cut, however good it sounds.** "otra vez", "no,
así no", "eso quedó mal", "espera", "de nuevo" — these are stage directions that ended up in the
audio. They are not a register choice, and the fact that a line reads as deliberate on the page
is not evidence it was: a discard delivered with conviction sounds exactly like a rhetorical
turn, which is the whole difficulty.

The test is structural rather than tonal. A self-critique is followed by another attempt at the
same line. If the phrase after it restates the phrase before it, everything from the first
attempt through the last discard goes, and only the final telling survives. One run cut
"y a la que conocemos / ah, otra vez / y a la que conocemos" correctly and kept
"¿Es un honor? / No, no, no, otra vez / Es un honor / No, eso es muy fake / Es un honor la
verdad" in the same master, calling the second a rhetorical beat. Both are the same shape and
the same word marks both. When it doubted itself later, what settled it was reading the words
rather than hearing the delivery.

Both readings, in that order, and neither replaces the other. A round that only reads the prose
misses a repetition whose two tellings sit either side of a cut, because the removed span hides
how close they are. A round that only reads `unreviewed` misses one that sits entirely between
two lines nothing ever marked, because their neighbours were cut and they look reviewed.

No script substitutes for that reading. Lexical similarity does not separate a repetition from
two sentences sharing prepositions: on the run above the repeated pair scored 0.150 against
0.114 for a healthy neighbouring pair, so any threshold catching one catches the other. This
is the same reason `detect` does not carry a filler word list.

**Transcribe the render every round, and read that.** Not the previous transcript, not the
source transcript projected forward. Every cut shifts everything after it, so the two
timelines diverge by the whole removed duration, and a span written against stale timings
lands somewhere nobody chose. The fresh transcript is also the only place a mangled join is
visible as text: the source describes what was said, only the render describes what is left.

**Widen existing spans before adding new ones.** When a proposal fails to remove what it
named, the usual cause is a boundary set too tight, not a wrong call. A restart is only
obvious once you see the attempt that follows it, so the earliest attempts read as content
while you are looking at them and as preamble once the last one is in view. Extending an
existing span usually removes more than any new cut placed beside it.

**Inside a fused region the transcript keeps the right words on the wrong clock, so read the
boundary off the audio.** Three independent runs cut the same retake at 61000, 61020 and
61192ms, each about 1772ms short of the boundary that removed it, and none of them misread
anything: the whole-file transcript placed "ya llegamos a mil miembros" starting at 58540ms,
across two measured silences of 980ms and 691ms, while the audio there says "conocemos... ah,
otra vez" and the surviving line does not begin until 62.7s. Every one of them cut where the
transcript pointed.

Convergence between runs is not evidence a boundary is right — three agents agreeing usually
means they read the same wrong number.

**When to bother with any of this.** Not every retake is fused, and the window loop is not free.
A run cut one retake correctly from the source timestamps alone because its words carried
separate, well-spaced ranges, and said afterwards it had no way to tell a clean region from one
that merely looked clean — it got the material it got. There is a signal, and it is the same
ms-per-character measure used above: on one recording the fused region peaked at 6.7x the file
median inside its worst word, the unfused retake at 2.5x, and ordinary content at 3.8 to 4.0x.
A region whose worst word sits near the ordinary range is telling its own timings straight; one
that spikes well above it is where the loop earns its cost. Run the loop when the numbers are
high or when you cannot tell, and say which it was.

Re-transcribing a window does not settle it either, and this is the part that catches everyone:
every attempt at a retake says the same words, so a window opened anywhere inside the run comes
back grammatically complete and reads like the telling you meant to keep. Opened at 59.0, 60.0,
61.0 and 62.0 seconds, the same passage returned "Ah, otra vez. Y a la que conocemos", then
"Y a la que conocemos, ya llegamos a mil miembros", then finally "Ya llegamos a mil miembros".
Three of those look like a clean start. A window whose start you chose from a hypothesis will
confirm the hypothesis, which is how three runs each verified a boundary and each was wrong.

The test that does settle it is the phrase, not the timestamp: **step the window forward until
the repeated wording stops coming back at all.** That is one command:

```bash
vcut converge source.mp4 --phrase "a la que conocemos" --from 59 --lang es
```

It reports the first offset whose transcript no longer carries the phrase, and every window it
read on the way, so the answer arrives with its evidence. Measured on the retake three runs cut
short: 8.9 seconds, one call, and a boundary on the correct side of it.

Read the trace rather than only the answer. On that recording the window at 60.5s came back
reading like the line worth keeping, while the audio under it was still an earlier attempt at
saying it: a short window transcribes what it hears into the sentence it expects. The wording
alone cannot tell you which attempt you are standing in, which is why a window you chose from a
hypothesis cannot settle this and stepping until the phrase leaves can.

Do not anchor the search on a segment boundary `edl build` already snapped to: one run did, got
the right answer, and said afterwards it would have inherited the error had the snap been wrong.
The snap comes from the same transcript being questioned. The boundary is where the transcript of the
window no longer contains the phrase being cut, not where a window happens to begin with
something that parses.

**End a retake cut at the first word of the telling you are keeping, not at the last word the
transcript shows.** Inside a fused region the cue timings are the averaged ones, so a boundary
drawn from them lands mid-repetition and leaves the final attempt whole — the cut looks right in
the EDL and the render still says the line twice. Two runs cut the same retake: one ended at
62792 and removed it, the other ended at 60820 and left "ah, otra vez. Y a la que conocemos"
audible, a difference of under two seconds that decided whether the defect shipped. Find the
anchor by re-transcribing a short window and taking the timestamp of the surviving line's first
word, then end the cut there.

**A proposal's boundaries do not have to dodge the drift warning.** `edl build` clamps every
boundary to measured silence before it writes the EDL, so a cut named at a position a drifting
cue claims is speech still lands in the pause the detector found. Checked on one run's three
semantic cuts: all six boundaries sat inside a measured silence span, none of them chosen with
that in mind. Worth knowing because the alternative is a round spent cross-checking every
boundary against a fifty-entry drift warning that has no bearing on where the cut ends up.

**A span that maps to an implausible range crossed a cut.** Mapping between timelines
silently produces nonsense when the endpoints land in different segments: a half-second of
speech comes back as a range tens of seconds long. Check the duration of what you mapped
before proposing it.

#### Before calling it done

Stop when a round proposes nothing, not when the removal percentage looks respectable, and
not when the rounds start finding less. A round that finds three things instead of ten is
still a round that found something, and what it found was invisible until the previous one
ran. Diminishing returns is what convergence looks like from the inside, one round before the
end, every time.

**The empty round cannot be the first one.** Round two runs even when round one looks perfect,
because it reads a different text: the transcript of what round one produced, which nobody has
read before. Four runs on the same recording separate cleanly on this and nothing else. The
three that stopped at one round shipped a repetition, and the shortest of them cut *less* while
declaring itself done sooner: 33.78% removed against 44.04% for the run that was made to keep
going. That run found the largest cut in the file — a three-attempt retake — in round two, on
material round one had already declared clean.

A round is: build, render `--audio-only`, transcribe that render, `semantic review`, read,
propose. Anything short of the full sequence does not count as one, because the reading is the
part that finds things.

The exception is the empty round that ends the loop, and only when the round before it proposed
nothing either. A round that proposed cuts changed the file, so the next one has new text to
read and has to run in full. A round that proposed nothing did not, so re-rendering and
re-transcribing an unchanged file to confirm it is still unchanged buys nothing: the empty
`review` you already read is the confirmation. Rebuild and re-read only when something moved.

Spend saved effort here rather than on verification. Cutting a round to save time is the one
economy that costs output: the same four runs show auditing more never found a defect, and
reading more found every one of them.

Verify against the transcript of the render, not against the plan:

- Every invariant below holds.
- `semantic check --review <the review JSON>` exits 0. It fails with exit 2 on two counts: a
  phrase in `repeated` that no proposal reason mentions, and a phrase still present in the
  render's own lines as often as review found it — reported as `survivingRepeats`, which does
  **not** fail the check. A phrase still in the render is the right answer for a callback and
  the wrong one for a retake, and nothing counting words can tell those apart, so naming closes
  the loop and presence-after-naming does not reopen it. Read the list before finishing; do not
  cut until it falls silent. An earlier version gated on it, and the only move that changed the
  exit code was cutting further: six runs of one recording, and the line it pushed toward
  removing was one the author wanted kept. When repeats are named and kept, `check` reports
  `valid-with-kept-repeats` and exits 0 — a finished round, not a pending one. Note that a
  reason has to ride on a real proposal: there is no reason-only entry and a zero-length span
  is rejected, so a round that cuts nothing reports its kept repeats in its answer instead. Those two are cleared differently: a reason
  clears the first, only a cut clears the second. A round that decides a surviving repeat is
  deliberate has not finished — it has a question for whoever approves the EDL, and saying so
  is the honest end. Reporting the result clean while this exits 2 is the failure six runs
  made, three of them after naming the phrase correctly. The second is the one a reason cannot talk
  its way past — a run quoted the repeated line in an honest reason, cut a boundary 1772ms
  short of where the repetition ended, and passed a check that only looked at reasons while
  the render still said it twice. Naming is the bar, not agreeing: keeping a repeat is often right,
  and writing why in a reason is what leaves the decision where a human approving the EDL can
  find it.
- `repeated` is empty, or every entry in it has an answer naming which telling survives and why
  the others are not the same thing. It lists wording that occurs more than once in the render,
  which is not a verdict — a name, a term the piece is about, and a deliberate echo all repeat
  legitimately — but it is where a claim of intent has to be about a specific phrase instead of
  an impression of the whole. On one recording it separated cleanly: four entries on a master
  that shipped a retake, one on a master that was clean, and that one was the project's name.
- `unreviewed` is empty, or every stretch in it has been read **with the line before and after
  it in view**, which is the only way a repetition between two lines becomes visible.
- `lines` has been read once as continuous prose, end to end, not as a numbered list.
- The non-speech pass reports nothing, or every span was run through `vcut nonspeech --verify`
  and each `vocalization-suspect` reading has been read and, where it is real, folded into a
  proposal. **The closing rule is `nonspeech --verify`, not reading the whole-file transcript
  with `vcut say`.** That used to be the rule and it is circular for this class of sound: the
  whole-file transcript is exactly the instrument that cannot see a vocalization, so checking a
  classifier hit against it answers "does the pass that already missed this still miss it,"
  which is always yes. Measured on a real 7.5-minute run: 18 classifier spans were closed that
  way, every one read as "breath" against the transcript, and seven of them were audible "eeeh"
  fillers the listener caught on the first playback. `--verify` re-transcribes a short window
  around each span instead, which is what recovers what the whole-file pass dropped.
  `words-around` needs no ear: it means the window's own transcript sits on both sides of the
  span with nothing unusual in the span itself, the non-speech equivalent of a breath between
  words. `empty` at real level is still a question for a listener — the window carried no words
  and no hesitation token, but something with real level is there and only an ear settles what.
  Do not re-transcribe a span shorter than the window `--verify` already used to try to settle
  either case further: a slice that short returns noise whatever it contains, which is the
  entire reason `--verify` reads a window rather than the bare span.
- The last line lands.

`deadAir: []` is not evidence of any of this. It measures pauses the cuts left in the audio and
says nothing about repeated content; a round has read `[]` there and called the result clean
while a sentence appeared twice in the same transcript.

**A word missing from the transcript is not proof of a bad cut.** Transcription models drop
and mangle words, especially at a join. Before reporting one, check whether the EDL still
covers that span and what the audio measures there. If it does and the level is normal, the
transcript is wrong and the audio is fine.

**When `audit` says a segment is fine and the render's transcript says it is not, both are
right and neither answers the question.** They ask different things: `audit` asks whether a
segment carries the material the EDL points at, and a cut whose span was drawn too narrow
carries exactly what it was told to, correctly, while leaving the rest of the defect behind it.
A run hit this with 0.94 correlation on a segment whose transcript still read the phrase it had
just cut, and spent fifteen commands reconciling the two before realising they were not in
conflict.

Resolve it on the **source**, not the master: the master already inherited whatever the cut
left, so re-reading it only repeats the answer. Re-transcribe a short window of the source
around the boundary and compare against what the whole-file transcript claims is there. Where
they disagree, the whole-file pass is the one that is wrong, and the cut needs widening rather
than moving.

### Invariants

Hard rules: each is a defect if it survives a pass, not a matter of taste. What makes them
rules is that they are stated about the **render** rather than about the plan, so they can be
checked after the fact instead of argued before it.

Being a rule is not the same as being mechanical, and pretending otherwise is how a checklist
gets ticked without being run. Only rule 8 is machine-decidable: `review` prints the list and
either it is empty or it is not. Rule 7 is decidable when the classifier is installed and a
listening task when it is not. Rules 1 through 6 are read by judgement, and their value is in
naming a defect precisely enough that you can tell whether you looked for it, not in removing
the judgement.

The right question at the end of a round is not "does this pass" but "did I check each of
these, and against what". A rule you did not look for reports the same as a rule that held.

1. **No idea is stated twice.** If two passages make the same point, one of them is a cut.
   Distance between them is not evidence they differ: the edit removes that distance.
2. **No sentence begins and does not land.** Every start has its ending in the edit, or the
   whole attempt goes.
3. **No pronoun outlives its antecedent.** If "that" or "eso" refers to something cut, the
   sentence goes with it.
4. **No fragment survives alone.** A clause that only made sense as part of a passage that
   was removed is not content, it is a leftover.
5. **Nothing survives that can be deleted without changing what the sentence says.** Delete
   the candidate, read what remains, and ask whether a listener learns anything less. If not,
   it goes.

   The test is a deletion, never a vocabulary. A word list only finds what someone already
   thought to write down, misses the same function expressed differently, and has to be
   rewritten for every language. The deletion test needs none of that: it asks what a span
   *does* in its sentence, so it works on a construction nobody named and in a language
   nobody wrote a list for.

   Sweep the transcript span by span rather than scanning for shapes you recognise. What you
   recognise is gone by the second pass; what stays is what did not look like filler, usually
   because it sits mid-clause and reads as ordinary grammar.

   Two things fail this test and must stay anyway: a word carrying emphasis the speaker
   meant, and a beat that gives a listener room before a heavy point. Removing those is what
   makes an edit sound like a script.
6. **The last line lands.** A video ending on an abandoned start is worse than one four
   seconds shorter.
7. **Nothing audible is left that is not language.** A breath, a mic bump, a lip smack. Both
   instruments are blind to these, so this one is not checkable by reading: it needs the
   classifier, and without it the check is a human ear.
8. **Every stretch has been read at least once.** Not a property of the edit but of the pass
   that made it, and the one that lets all the others survive: an unread stretch violates
   nothing visibly, because nobody looked. `review` reports these as `unreviewed`.

If the transcript of the render violates one of these, the edit is not done, whatever the
removal percentage says.

Rules 1 through 6 are read off the transcript. Rule 7 needs the audio. Rule 8 needs the EDL
and is the only one that says where to look rather than what to look for.

**`--crop` is not on this list.** Framing is taste and the document has no rule for it: pick
a crop when the source carries something the viewer should not see, leave it alone otherwise,
and let the human refuse it like any other proposal.

### Non-verbal sound needs a classifier, not a statistic

A breath, a mic bump, a lip smack: audible, meaningless, and invisible to both
instruments. The silence pass hears energy and calls it speech. The transcript has no word
for it, and the model stretches a neighbouring cue over it, so it ends up inside a word's
span rather than beside it.

`vcut nonspeech` runs `skills/core/scripts/non-speech.py` against the render and reports the
spans it finds. It runs on the **rendered preview**, not the source: on raw footage every pause
scores as non-speech, correctly and uselessly, while on a finished cut only real intrusions
are left.

```bash
vcut setup classifier                          # once, ~320MB into ~/.vcut/panns
vcut nonspeech master.mp4 --verify --lang es > non-speech.json
# read each vocalization-suspect span's text, then map timings back through the EDL and feed
# the real ones in as proposals
```

**Always add `--verify`.** Without it you only get the classifier's raw spans, which puts the
closing question back on the whole-file transcript — see "Before calling it done" above for
why that is circular for this class of sound. `--verify` re-transcribes a short window around
each span with `trx` and reports a `reading`: `vocalization-suspect`, `words-around`, or
`empty`. `vcut schema nonspeech` has the full contract.

The classifier script itself stays outside the CLI as a subprocess `vcut nonspeech` shells
out to, because it needs Python and a 300MB torch checkpoint, and vcut otherwise runs
anywhere ffmpeg does. Anything emitting the same span schema works in its place; that script
is the reference. `--verify`, the reading, and the windowed re-transcription live in the CLI
itself and need no Python beyond what the classifier already needed.

**Four energy statistics were tried first and all four failed**, which is worth knowing
before reaching for a fifth:

| Attempt | Why it cannot work |
| --- | --- |
| Sound with no word covering it | The cue stretches over the noise, so it is never uncovered |
| Gaps between consecutive words | The largest gap in a tight edit is a fraction of a second |
| Energy swing inside one word | A word holding a breath swung *less* than an ordinary word |
| Median level inside one word | Ranks unstressed function words first, which is a different question |

Periodicity gets closer, since voiced speech has vibrating folds and a breath is turbulence,
but unvoiced consonants are turbulence too: every sibilant becomes a false positive.

The pattern is that each measures a **proxy** for non-speech, and every proxy is dominated
by ordinary variation in speech. Separating a breath from a syllable asks what a sound *is*,
so it takes something trained on that question. A general VAD is not enough either: one
scored a breath at 0.87 voice, indistinguishable from words. What worked was an AudioSet
classifier, keyed on the *absence of speech* rather than the presence of breathing.

### The muletillas playbook

A vocalized filler — "eeeh", "mmm" — is a defect class that is audible and invisible to every
instrument that reads a transcript, `detect` included. A model cleans them even with a verbatim
preset: measured on a real 7.5-minute run (2026-08-10), the source transcript carried 0 "eh"
cues out of 1024, the master's transcript carried 0, and the render carried roughly seven
audible ones, all found by a human listener on the first playback and none by the five rounds
of the loop before it.

**Why the old closing rule was circular, stated plainly.** The manual used to close a `nonspeech`
hit by reading the whole-file transcript with `vcut say`. That verifies the finding of the one
instrument that hears the filler against the one instrument that structurally cannot: whisper
already cleaned it out, so the transcript will read "breath" or nothing every time, whatever the
audio actually holds. The check always passes and never means anything. `--verify` on `nonspeech`
replaces it, because it does not ask the transcript — it re-transcribes a fresh, narrow window
around the span, which is where the cleaning has not happened yet.

**The playbook:**

1. Run `vcut nonspeech <render> --verify` on the rendered preview, never the source (raw footage
   scores every pause as non-speech).
2. Read every `vocalization-suspect` reading. Each one carries the windowed transcript that
   recovered the filler's text — read `text`, not just the span's timing.
3. Place the cut boundaries with `vcut silences <media> --from <s> --to <s> --min 0.08` at fine
   resolution. The gaps around a filler measure 80-150ms, well under `detect`'s 0.3s default
   minimum, which is why `detect`'s silence list cannot place this boundary on its own.
4. Propose the cut with `kind: "filler"`, quoting the recovered text from `text` in the `reason`
   so whoever approves the EDL can read what is being removed rather than trust a classifier
   score.

This is where the playbook sits in the round: "The round, in order" already runs the non-speech
pass once, on the final preview, after the audio-only loop reads clean. With `--verify` that
pass stops being ceremony — a check whose output never changes a decision — and its
`vocalization-suspect` findings become a real proposal round instead of a formality cleared and
forgotten.

## What eleven runs taught

Eleven agents edited the same recording with nothing but this manual. Four shipped a defect a
listener caught immediately. What separates the runs that worked is not effort — every run read
the transcript, every run ran the checks — so these are the habits worth carrying, each with
what it cost to learn.

**Never let the empty round be the first.** Four of the five failures reported nothing after one
pass. The round that finds the largest cut is usually the second, because it reads a text the
first round produced and nobody had seen. The shortest run cut 33.78% and called itself done;
the one required to continue cut 44.04% and was right.

**Read the result, not the plan.** Every failure was a run that read its own proposals and
called them the outcome. The render's transcript is the only description of what a viewer hears.

**A number is not a verdict.** A repeated phrase, a low correlation, a classifier hit, a removal
percentage outside its range: each is a place to look. Three of them fired on runs whose masters
were perfect, and one detector was hardened into a gate that pushed toward deleting a line the
author wanted. Anything counting words cannot tell a callback from a retake.

**Say what you decided, in a reason.** Keeping a repeat is often right and leaves no trace on its
own, which makes it indistinguishable from missing it. A reason is the difference between a
judgement someone can review and one nobody can find.

**Distrust a boundary you verified.** Every attempt at a retake says the same words, so a window
opened anywhere inside one comes back complete and convincing. Three runs each verified a
boundary and each was wrong by about 1772ms. Step the window forward until the phrase stops
coming back; agreement between runs means they read the same wrong number.

**Spend on reading, save on auditing.** The run that cut fastest also cut worst. `audit` and the
non-speech pass never changed a decision across eleven runs — they are cheap insurance, run once
at the end, not a source of findings. The transcript is where the defects are. That held before
`--verify` existed: a raw non-speech span closed against the whole-file transcript really was
ceremony, because the transcript could not see what the classifier saw. `--verify` changes what
the pass finds, not this rule about when to run it — still once, at the end, still audio-only in
every round before it. See "The muletillas playbook" under `semantic`.

**Check the input before reporting a bug.** Two bug reports in this project were filed against
the wrong project, both after a premise nobody measured. `ffprobe` on the file you passed costs
less than an issue.

## Limits

- Semantic cutting is proposal-only. vcut supplies the transcript and folds in the spans; the judgement is yours and the approval is the human's.
- Audio ramps 50ms at each segment edge (`--edge-fade 0` disables it). This is not a crossfade: the two sides are not overlapped, because overlapping would shorten the render against concatenated video and drift the audio out of sync. A joint under a fully continuous sentence can still be heard as a dip.
- Noise reduction is not offered. Measured on one recording: the background floor already sat
  at -54 dB, and a denoiser at a default setting pushed a weak syllable from -45 dB to -57,
  which is the same defect as a threshold set too high. There is no safe default because the
  right amount depends on the room, and unlike a cut it cannot be undone by editing the EDL.
  Loudness normalisation is the part that is safe to automate, and that is on by default.
- No face tracking or automatic zoom.
- A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. If a word loses its opening sound, the fix is the recording or a lower threshold, not a larger margin.
