---
name: debug
description: How to investigate a cut that came out wrong, and which measurement actually answers each question. Read this before diagnosing a render that sounds off, a word that seems cut in half, dead air that survived, or a transcript position that does not match the audio. Covers the instruments vcut gives you and the traps that make a more rigorous-looking method produce a confident wrong answer.
allowed-tools: Bash(vcut:*), Bash(npx @crafter/vcut:*)
---

# vcut debug

Every method here is cheap to run. None of them is the obvious one.

That is the whole reason this file exists: for each question below there is an instrument that
looks more rigorous and proves nothing, and reaching for it is how confident wrong answers get
written down. Each entry names the question, the method, and the trap.

## The rule under all of it

**A measurement that returns the same thing whether or not your hypothesis is true has not
tested anything.** Before running one, ask what its output would be if you were wrong. If the
answer is "the same", pick a different instrument.

Two of the traps below were rediscovered while building the commands that replace them, by
people who had already written the warning. Knowing the rule is not the same as applying it
under a confusing symptom.

## "What source does this master position come from?"

```bash
vcut locate --edl edl.json --master 50.2 --explain
```

**Trap: deriving it by hand.** Accumulating `outMs - inMs` across segments produces a total
that can match the rendered file to the millisecond while individual positions land seconds
away from where they came from. Measured on one EDL: the sum agreed with `ffprobe` exactly,
at 54569ms, and it still did not follow that any single position mapped correctly.

The agreement feels like verification, and nothing in it warns you. `--explain` reports the
neighbourhood instead of only the number, and `--render <path>` measures the file rather than
trusting the EDL, which records intent.

## "Is this odd-sounding word real, or did the model hallucinate it?"

```bash
vcut say cut.mp4 --transcript cut.srt --at 50.2
```

**Trap: transcribing a short slice.** A window under about two seconds comes back as noise
regardless of what the audio contains, so a gibberish result looks identical whether the audio
holds speech, a mic bump, or nothing. It cannot distinguish the hypotheses.

One investigation cut a 0.6s slice, got nonsense back, and concluded the transcript had
hallucinated. It had not. About four minutes went into that branch. `say` reads the transcript
that already exists rather than re-transcribing, which removes the trap instead of warning
about it.

## "Did the render carry the wrong material at a join?"

```bash
vcut audit --edl edl.json --render cut.mp4
```

**Trap: believing a low correlation.** Envelope correlation is weak over short or quiet
windows, and loudness normalisation lifts quiet passages by several dB, which changes the shape
being compared. A correct segment can score badly.

This trap produced a whole false finding: an ad-hoc correlation reported a boundary leaking
half a second of removed speech into the render. Correlating the same window against both
candidate positions afterwards scored **0.975** for the position the EDL named against
**0.485** for the supposed leak. The renderer had been right the entire time.

`audit` marks where to look. Reading the words at that position settles it in seconds.

## "Did every semantic join land clean?"

```bash
vcut joins --edl edl.json --render cut.mp4 --report report.json --lang es
```

**Trap: believing a `removed-text-leaked` reading.** It fires when the re-transcribed window
around a join shares a majority of carrying words with the cut's own `removedText` — real
signal for a leaked tail, but a false-start's removed text is often the speaker repeating the
same phrase before landing it, and the sentence that survives can legitimately reuse that
phrase as its real content. Carrying-word overlap cannot tell the two apart; both are, by
construction, about the same words.

Verified on real material: a cut removed three stumbled attempts at "agregar
verificabilidad", and the surviving sentence used "agregar verificabilidad" as its subject.
`joins` read it as leaked. `vcut say cut.mp4 --transcribe --at <s> --window 8`, the exact
command `next` names on that reading, returned "nos basamos mucho en este principio de
agregar verificabilidad a los instrumentos de los agentes, porque los agentes necesitan..." —
a clean sentence, no leaked tail.

`removed-text-leaked` and `check-by-ear` are both places to look, not verdicts. Confirm with
the wider window before folding anything back into a proposal.

## "Was a word cut in half?"

```bash
trx transcribe cut.wav --words --language <lang> --output-dir "$(dirname cut.wav)"
# diff against the source transcript
```

**Trap: checking SRT boundaries against cut points.** Word timings inflate toward silence, so a
naive boundary check flags words the cut never touched. On one render it reported 35 straddles
and 9 words "fully removed"; re-transcribing showed nothing had been lost — the render had
*more* words than the strict model predicted.

Re-transcribe the render and diff. The words that survived are the evidence, not the timings
that claim where they were.

## "Where do I even start on a file I have not read?"

```bash
vcut suspects --detect detect.json
```

Ranked positions from the pauses `detect` already measured, no transcript involved. It answers
where, never what: run `say --transcribe` on the top few.

**Trap: expecting it to find every defect.** It measures rhythm. A repetition delivered fluently
leaves no rhythmic trace and only shows up in the prose. Measured across four recordings it
fires 5.3 to 6.3 times a minute on hesitant material and 1.0 on a take read from a script, which
is a reading order rather than a defect list.

## "Did the classifier flag something real?"

```bash
vcut nonspeech master.mp4 --verify --lang <lang>
```

**Trap: checking the span against the whole-file transcript.** That transcript is exactly the
instrument that could not see the sound the classifier is asking about, so checking a hit
against it answers "does the pass that already missed this still miss it," which is always
yes. Measured on a real 7.5-minute run: 18 spans closed that way were all read as breaths and
seven of them were audible "eeeh" fillers a listener caught on the first playback.

`--verify` re-transcribes a short window around each span instead and reports a `reading`.
`words-around` (ordinary words either side of the span, nothing unusual inside it) needs no
ear — that is the sibilant-and-word-onset false positive this section used to send you toward
the transcript to rule out, and `--verify` rules it out from the window's own text. `empty` at
real level is the case worth a listener: no words, no hesitation token, and something audible
is there that neither instrument explains.

## "Dead air survived the cut. Is the threshold wrong?"

**Almost certainly not.** Read what `detect` says about the transcript first:

```
warning   60 transcript cues claim a word starts inside measured silence. The largest is
          "honor?" at 75.64s, where the audio stays silent for another 1318ms.
```

**Trap: changing the preset.** Dead air in a render looks exactly like a threshold set too low,
so the reflex is to move to a more conservative preset. One session did that and the boundary
moved by 12ms, explaining nothing, because the detector had been right and the transcript was
wrong: clamping had held the boundary open around a word whose claimed start sits inside a
measured pause.

Fixing the transcript moves it. Changing the preset does not.

## "I need to see several positions, or a whole span"

```bash
vcut locate --edl edl.json --sources 20,53.86,61.2      # a list, not a loop
vcut say <media> --transcript words.srt --at 53 --through 63
```

Both exist because runs built them by hand: two shell loops around `locate` with a JSON parser
inside each, and thirty lines of SRT parsing to read a span the command already had loaded.

**Trap: passing milliseconds to a flag that takes seconds.** Every JSON field here is
milliseconds and every position flag is seconds, so the mistake is natural and the answer used
to look real: a run asked `locate` about nine positions in milliseconds, got `removed: true` for
all nine, and read that as nine spans it had successfully cut. Those flags now refuse a position
past the end of the file, but the older habit is worth naming.

## "The transcript positions do not match the audio at all"

Check that whatever produced the transcript did not rewrite the timeline. A tool that removes
silence before transcribing yields timestamps describing a file that no longer exists, and the
error accumulates rather than being a constant offset a consumer could subtract.

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 source.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 transcribed-audio.wav
```

Measured on one 90.538s recording, the audio that reached the model ran 88.966s: **1.572s of
accumulated drift**, with nothing in the output saying the timeline had changed.

## "A listener heard something the transcript does not show"

**Believe the listener.** A whole-file pass averages: where a speaker said a line three times,
it can write it once, and nothing in the output says so. Every instrument downstream then agrees
with each other and with nothing that happened.

```bash
# ask the audio over a short span instead of reading the file-wide transcript
vcut say source.mp4 --transcribe --lang es --at <seconds> --window 4
```

Measured on one recording: reading the transcript at 57.5s gave "la que conocemos, ya llegamos
a"; transcribing that same window gave "Y a la que conocemos, ya llegue. Y a la que conocemos".
Four separate runs failed to find the repetition, not because they read badly but because the
text they read did not contain it.

**Trap: re-reading the same transcript more carefully.** It cannot recover what it never wrote.
Only a fresh pass over a shorter span can.

**Trap: trusting a boundary read off a fused region.** Inside one, cue timings are averaged, so
a cut drawn from them lands mid-repetition. Three runs cut the same retake at 61000, 61020 and
61192ms, each about 1772ms short of the boundary that removed it, and each had "verified" it.
Stepping a window forward until the repeated wording stops coming back is the check; agreement
between runs is not.

## "The cut is at the right place and the line still sounds wrong"

A retake and the telling that survives it **overlap**. The last attempt begins before the
previous one has stopped being recognisable, so the point where the repeated wording disappears
sits past the start of the line worth keeping. Cutting to the first number beheads the second.

```bash
vcut converge source.mp4 --phrase "<the recurring words>" --from <sec> --lang es
```

Measured on one recording: `converge` answered 62000ms, and cutting there produced "Conocemos,
ya llegamos a mil miembros". Ending at 61192ms instead kept "Y a la que conocemos, ya llegamos a
mil miembros" — the whole line, for 0.7 seconds more runtime.

**Trap: reading either transcript as broken.** Neither is. "Conocemos, ya llegamos a mil
miembros" parses, carries the fact, and passes every invariant in the manual. The defect is
audible and only audible, which is why the last check before approval is a person listening
rather than another measurement.

**Do not hand-bisect the near edge.** `converge` gives you the far edge; the start of the line
you are keeping is measured, in one call, over the span between its two edges:

```bash
vcut say source.mp4 --transcribe --words --at <lastWithPhraseMs/1000> --through <boundaryMs/1000> --lang es
```

Every word comes back with its absolute start and end in the source. `converge` prints this same
call with its own numbers already filled in, so there is nothing to derive. The alternative is
what one run did: six to eight `--transcribe` calls at shrinking windows, then a raw
`ffmpeg -ss/-t` extraction plus a fresh transcription for ground truth, about a third of its
budget for one boundary.

## "The transcript and a re-transcribed window disagree about where a word is"

They can both be wrong in the same direction and neither will say so. `--transcript` reports
timings a whole-file pass averaged; measured on one run, a keeper's start came back at 550740ms
when the true boundary sat at roughly 551300-551600ms. `--transcribe` at short windows made it
worse, returning outright hallucinations ("Fíjole.", "Me siento muerto.") for real speech.

```bash
vcut say source.mp4 --transcribe --words --at 550.0 --through 553.0 --lang es
```

**This is the arbiter, and it is the only one.** It extracts exactly that span, re-transcribes
it asking for word-level cues, and offsets every timing back to absolute source milliseconds.
`wordsFrom: "fresh-transcription"` marks the answer as measured rather than read, so two
contradictory numbers for one word stay distinguishable. It costs one transcription.

**Trap: shrinking the window to close in.** It does not converge. A short window transcribes
into the sentence it expects, so each smaller call reads more like a clean start and is no
closer to the truth — that is what produced the hallucinations above. Widen to the span you
doubt and ask once.

## "`converge` answered fast. Is the boundary real?"

```bash
vcut converge source.mp4 --phrase "<the recurring words>" --from <sec> --lang es
```

**Trap: trusting the first window it reports as clear.** `converge` stops at the first window
that lacks the phrase, and it has no way to tell a real end-of-retake from either of two things
that look identical to it: discard babble sitting between two attempts, or a single window whose
transcription happened to drop the phrase. Both produce a confident, fast `boundaryMs` that is
wrong.

Measured on real stumbled speech (2026-08-10): probing from 84.0s, where the phrase occurred at
84.0-84.5s and was followed by babble ("perdón, crear, ok, eso no, básicamente era, ya") before
the real keeper at 95s, `converge` stopped at the very next window and returned `boundaryMs:
84500` — an answer that looked exactly like the others and was useless. Separately, probing
"agregar verificabilidad" from 204s inside a quadruple retake, the 204.5s window's transcript
happened to omit the phrase — a transcription miss — and `converge` stopped immediately, though
the phrase recurs through 216s.

Read the trace, not just `boundaryMs`: if the window right past the answer has a gap in content
that reads like babble rather than a clean retake edge, or the phrase's disappearance looks like
a one-window fluke against everything around it, do not trust a single call. Check the shape of
the gaps with `vcut silences`, then anchor specific offsets with `vcut say --transcribe` — both
resolved on the real run above.

## "A render fails its own frame-count and duration checks with no other cause in sight"

Check whether the source is a screen recording, or anything else where the video and audio come
from separate devices. Their streams do not have to end at the same instant.

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of json source.mp4
```

**Trap: assuming `format.duration` describes the picture.** That field is the container's, which
reports the longest of its streams, audio included. On one 11.7-minute recording the video
stream ended at 700.717s and the container reported 700.8s: the audio device stayed open 83ms
after the capture stopped drawing frames. An EDL built against the container figure claims a
final segment that reaches into video that does not exist. `render`'s trim filter clamps that
silently rather than failing, so the render comes out short and fails `render frame count
differs from EDL duration` and `render duration differs from EDL` with no line in the error
pointing at the source.

`edl build` clamps the last segment to the video stream's own duration since 0.14.1; a render
that still fails these checks on a current build is a different defect; read the numbers the
error now reports (`expected` vs `got`, and the tolerance) before assuming it is this one again.

## "The tool did the wrong thing with my input"

**Check your own input first.** Before reporting that a tool mishandled a file or ignored a
flag, verify that what you handed it is what you think it is.

This trap has the worst record in this file. It was fallen into **twice while writing the very
commands above**, and both times it produced a bug report against the wrong project.

- A transcript came back with five words for what was believed to be a 90-second recording.
  The recording was fine; the intermediate `.wav` was **4.096 seconds**, because the ffmpeg
  extraction that produced it had been truncated and nobody measured it. The tool transcribed
  the four seconds it was given, correctly.
- Artifacts landed in the working directory instead of the directory named by a flag. The flag
  passed was `--output`, which selects an output *format*; the directory flag was
  `--output-dir`, one hyphen away. The tool did exactly what it was told.

```bash
ffprobe -v error -show_entries format=duration -of csv=p=0 the-file-you-passed
<tool> --help | grep -- --the-flag-you-used
```

Two commands, both faster than writing an issue. A wrong premise produces a report that is
internally consistent and completely false, and it survives review because every step after
the premise is sound.

## When a measurement disagrees with a transcript

Prefer the words. Not because transcripts are more accurate — they are the thing that drifts —
but because a word is a claim you can check by listening, and a correlation score is not. Every
false finding in this file survived because a number was easier to trust than a sentence.
