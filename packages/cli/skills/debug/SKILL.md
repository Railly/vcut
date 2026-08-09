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

## "Was a word cut in half?"

```bash
trx transcribe cut.wav --words --language <lang>
# diff against the source transcript
```

**Trap: checking SRT boundaries against cut points.** Word timings inflate toward silence, so a
naive boundary check flags words the cut never touched. On one render it reported 35 straddles
and 9 words "fully removed"; re-transcribing showed nothing had been lost — the render had
*more* words than the strict model predicted.

Re-transcribe the render and diff. The words that survived are the evidence, not the timings
that claim where they were.

## "Did the classifier flag something real?"

Check whether the span falls inside a word in the word-level transcript. Sibilants and word
onsets produce false positives, and both are inside real speech rather than intrusions on it.

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

## When a measurement disagrees with a transcript

Prefer the words. Not because transcripts are more accurate — they are the thing that drifts —
but because a word is a claim you can check by listening, and a correlation score is not. Every
false finding in this file survived because a number was easier to trust than a sentence.
