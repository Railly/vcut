---
title: The cutting loop
description: Why one pass is never enough, what to check before calling an edit done, and what has already been tried and failed.
order: 3
---

## The cutting loop

Silence removal is the first round of several, not the job. Most of what needs cutting is invisible until the noise around it is gone, so the work is a loop: cut, render, transcribe the render, read it again, cut again.

### Each round sees what the last one uncovered

| Round | Only visible now because |
| --- | --- |
| 1 | Nothing hides long silence or an obvious stammer |
| 2 | A pause two adjoining segments create together did not exist in either of them before |
| 3 | A join reads as broken only once both sides are adjacent, and a surviving redundancy only once the passage is short enough to hold in your head |
| 4 | A discourse marker is inaudible inside loose speech and obvious inside tight speech |

Stopping after one round leaves work that looks like polish and is not.

### The round

```bash
N=1   # bump every round: the renderer refuses to overwrite

vcut edl build --detect detect.json --semantic proposals.json \
  --output cut-$N.mp4 --campaign my-video --edl edl-$N.json
vcut render --edl edl-$N.json --audio-only --output cut-$N.wav

trx transcribe cut-$N.wav --words --language es -m large-v3-turbo

vcut semantic review --edl edl-$N.json --detect detect.json --terse \
  --master cut-$N.wav --master-transcript <the .srt trx wrote> > review-$N.json

vcut semantic check --proposals proposals.json --detect detect.json \
  --review review-$N.json          # exit 2 while a repeated phrase goes unnamed
```

Then fold the findings into `proposals.json`, bump `N`, and run it again. Render the video once, at the end, and run `vcut audit`, `vcut joins`, and `vcut nonspeech --verify` there — they need a picture and answer a question no round is asking.

`vcut joins --edl edl-$N.json --render cut-$N.mp4 --report report-$N.json --lang es` replaces the `locate` + `say --transcribe` round for every semantic cut in one call — a real 11.7-minute run verified 9 joins that way for about 14 calls, before `joins` existed. Each `reading` of `removed-text-leaked` or `check-by-ear` is a place to look, not a verdict: confirm with the wider `say --transcribe` window `next` names before folding anything back into a proposal.

Close a `nonspeech` hit with `--verify`, not by reading the whole-file transcript. That transcript is exactly the instrument that could not see this class of sound in the first place, so checking a hit against it is circular: measured on a real 7.5-minute run, 18 spans closed that way were all read as breaths and seven were audible "eeeh" fillers a listener caught immediately. `--verify` re-transcribes a short window around each span instead and reports which are `vocalization-suspect`, `words-around`, or `empty`.

**Read `semanticCuts[].removedText` in the build's own JSON before rendering.** Every accepted proposal reports the transcript text its final span actually removes, which can drift from what the proposal asked for once it merges with a neighbouring cut. A repetition cut once removed "todos estamos" instead of the intended "en nuestra propia" this way, invisible until a render and a re-transcription caught it — `removedText` makes that visible at build time. `edl build` also warns when a span's removed text and its own `reason` share too little in common.

`--terse` drops the instructions block, which is identical every round and was 72% of one measured payload. Read it once on the first call, then leave it out.

### Where to look first

```bash
vcut suspects --detect detect.json
```

Ranked positions computed from the pauses `detect` already measured, no transcript involved. On a short take, read every line the export gives you. On anything long, this is the order to read in: measured across four recordings it fires 5.3 to 6.3 times a minute on hesitant material and 1.0 on a take read from a script, and the rate falls as sources get longer rather than rising.

When a round finds a retake, the boundary is its own question and the one that goes wrong most:

```bash
vcut converge source.mp4 --phrase "the recurring words" --from 59 --lang es
```

Three runs cut the same retake at 61000, 61020 and 61192ms, all about 1772ms short, each having
verified its number against a window that read like a clean start. What the command reports is
the far edge of what is safe to remove; the cut usually ends nearer `lastWithPhraseMs`, where
the telling being kept begins. Ending at the far edge on one recording gave "Conocemos, ya
llegamos a mil miembros" instead of "Y a la que conocemos, ya llegamos a mil miembros" — both
transcripts read fine, and only one sounds right.

It replaces neither the reading nor the loop. A repetition delivered fluently leaves no rhythmic trace and only the prose shows it. What it replaces is scanning a file you have not read to decide where to spend attention.

Once you know roughly where a boundary goes, placing it exactly can need a finer measurement than `detect` gives you:

```bash
vcut silences source.mp4 --from 327.3 --to 330.5 --noise -33 --min 0.08
```

`detect`'s silence list is the **cutting** instrument, at the preset threshold and a 0.3s minimum — the one `edl build` cuts against. `silences` is the **placing** instrument: same measurement, a threshold and minimum you choose, over the sub-range you name. The gap separating a filler from the next word can measure 80-150ms, under `detect`'s default minimum and invisible to it; answering "what does the audio do right here" used to mean running raw `silencedetect` by hand and converting its range-relative timestamps back to absolute media time yourself, once per boundary.

### Iterate on audio

Every question in the round above is about sound: whether a filler survived, whether a boundary clipped a word, whether a pause is still there. The picture cannot answer any of them, and rendering it costs about a hundred times the wall clock. Measured on one 22-segment EDL: **0.25s for the audio against 31.8s with video**, from the same cuts.

`--audio-only` uses the same audio graph the video path uses, edge fades and loudness included, so what you hear while iterating is what the finished file will sound like.

Check the transcript path `trx` reports rather than assuming it: it names the file after its own normalisation step, so the `.srt` beside `cut-1.wav` can arrive as `cut-1_clean.wav.srt`.

### Audit the render before you call it done

```bash
vcut audit --edl edl-$N.json --render cut-$N.mp4
```

Everything the renderer validates about itself is an aggregate, so a render whose segments carried the wrong material passes every one of those checks. `audit` compares the audio segment by segment against the source the EDL points at, and names what to inspect. Read the words at any position it flags before believing the number.

### Verify every semantic join in one call

```bash
vcut joins --edl edl-$N.json --render cut-$N.mp4 --report report-$N.json --lang es
```

Every accepted semantic cut has a join: the EDL segment that opens right after it, the same boundary `edl build`'s `boundariesAfterSpeech` warns about at build time. Checking each one by hand is `locate` to find the master position, `say --transcribe` to hear the window — once per cut. `joins` derives every join from the EDL itself, checks the EDL's own master-time map against the render's measured duration, and re-transcribes each window in one call: on the real recording that motivated this, 8 joins came back in about 15 seconds.

A `removed-text-leaked` reading means the window's carrying words majority-overlap the cut's `removedText` — a real signal, and also one that can misfire: a false-start whose removed text is the speaker repeating a phrase before landing it can leave a surviving sentence that legitimately reuses the same words. Confirm before folding anything back in.

### Transcribe the render every round

Not the previous transcript, not the source transcript projected forward. Every cut shifts everything after it, so the two timelines diverge by the whole removed duration and a span written against stale timings lands somewhere nobody chose.

The fresh transcript is also the only place a mangled join is visible as text: the source describes what was said, only the render describes what is left.

### Read `unreviewed` first

A pass reads what it went looking for, so cuts land where the attention was and the stretches between two cuts are where nothing was ever read. They look reviewed because their neighbours are, and that is where a marker survives round after round while both spans around it get examined closely.

`vcut semantic review` reports those stretches with their text. Work that list before scanning anywhere else.

### Widen before adding

When a proposal fails to remove what it named, the usual cause is a boundary set too tight, not a wrong call. A restart is only obvious once you see the attempt that follows it, so the earliest attempts read as content while you are looking at them and as preamble once the last one is in view.

Extending an existing span usually removes more than any new cut placed beside it.

## Invariants

Hard rules: each is a defect if it survives a pass, not a matter of taste. What makes them rules is that they are stated about the **render** rather than about the plan, so they can be checked after the fact instead of argued before it.

1. **No idea is stated twice.** Distance between two passages is not evidence they differ; the edit removes that distance.
2. **No sentence begins and does not land.**
3. **No pronoun outlives its antecedent.**
4. **No fragment survives alone.** A clause that only made sense inside a removed passage is a leftover.
5. **Nothing survives that can be deleted without changing what the sentence says.** Delete the candidate, read what remains, ask whether a listener learns anything less.
6. **The last line lands.** Ending on an abandoned start is worse than ending four seconds sooner.
7. **Nothing audible is left that is not language.** A breath, a mic bump, a lip smack.
8. **Every stretch has been read at least once.**

Being a rule is not the same as being mechanical. Only rule 8 is machine-decidable: `review` prints the list and either it is empty or it is not. Rule 7 is decidable when the classifier is installed and a listening task when it is not. Rules 1 through 6 are read by judgement, and their value is in naming a defect precisely enough that you can tell whether you looked for it.

**Stop when a round proposes nothing**, not when the removal percentage looks respectable, and not when the rounds start finding less. A round that finds three things instead of ten is still a round that found something, and what it found was invisible until the previous one ran.

## Filler words are a deletion test, not a list

vcut used to carry a list of six tokens per language. Measured on one Spanish recording, that list caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that happened to carry no meaning in that one sentence, which is most of them.

A list also cannot tell filler from real use. Spanish `este` is filler in "y este, entonces" and a demonstrative in "en este caso". Extending the list makes it worse, not better: the same token is filler or content depending on the clause around it, and a list has no clauses in it.

The test that works is a deletion. Read the line without the candidate and ask whether a listener learns anything less. That needs no vocabulary, so it works on a construction nobody named and in a language nobody wrote a list for.

Two things fail the test and must stay anyway: a word carrying emphasis the speaker meant, and a beat that gives a listener room before a heavy point. Removing those is what makes an edit sound like a script.

## What has already been tried and failed

### Non-verbal sound needs a classifier, not a statistic

A breath is audible, meaningless, and invisible to both instruments: the silence pass hears energy and calls it speech, and the transcript has no word for it.

Four energy statistics were tried and all four failed:

| Attempt | Why it cannot work |
| --- | --- |
| Sound with no word covering it | The transcript stretches every cue to the next word, so the noise lands *inside* a word's span |
| Gaps between consecutive words | The largest gap in a tight edit is a fraction of a second |
| Energy swing inside one word | A word holding a breath swung *less* than an ordinary word did |
| Median level inside one word | Ranks unstressed function words first, which is a different question |

Each measures a **proxy** for non-speech, and every proxy is dominated by ordinary variation in speech. Periodicity gets closer, since voiced speech has vibrating folds and a breath is turbulence, but unvoiced consonants are turbulence too and every sibilant becomes a false positive.

A general voice-activity detector is not enough either: one scored a breath at 0.87 voice, indistinguishable from words. What worked was an AudioSet classifier keyed on the **absence of speech** rather than the presence of breathing. `vcut nonspeech` runs that classifier (`skills/core/scripts/non-speech.py`) as a subprocess rather than a built-in dependency: it needs Python and a 300MB checkpoint, and vcut otherwise runs anywhere ffmpeg does. `--verify`, which turns a raw span into a `reading`, lives in the CLI itself and needs no Python beyond what the classifier already needed.

### Noise reduction is not offered

Measured on one recording, the background floor already sat at -54 dB and a denoiser at a default setting pushed a weak syllable from -45 dB to -57. That is the same defect as a threshold set too high, and it lands on exactly the words a silence detector already struggles with.

There is no safe default because the right amount depends on the room, and unlike a cut it cannot be undone by editing the EDL. Loudness normalisation is the part that is safe to automate, and it runs by default.

### A better transcript can mean fewer cuts

Worth knowing, because it looks like a bug the first time. `whisper --max-len 1` stretches each cue to the start of the next word, so a word's range routinely swallows the pause that follows it.

On one recording, 118 of 119 detected silences overlapped some word's range. Clamping every cut strictly inside word boundaries erased 57 of them outright, and removal collapsed from 10.5% to 2.7% purely because a better transcript was supplied.

vcut treats silence measured from audio energy as stronger evidence than a boundary inferred by a model. When clamping would shred a cut into a remainder shorter than your own `--min-silence`, that remainder is overlap residue rather than a real pause, and the measured span wins.

### Ask for a large transcription model

One cue per word means one cue per *token*, and what counts as a token depends on the model. Measured on the same three minutes of Spanish: `small` returned 26% of its cues as word fragments, splitting "Crafter" into `Cra` + `fter`, while `large-v3-turbo` returned 0% and cost 13 seconds.

Fragments weaken the word clamping that keeps cuts off speech, and they make the semantic export unreadable.

## When a word loses its opening sound

A silence detector decides by level, so a soft consonant under the threshold is cut like a pause. This reads as a transcription error rather than as a cut, which is what makes it hard to spot: the word comes back missing its first syllable.

Measured on one recording, the same word appeared six times. The three that survived intact sat at -10 dB; the three that lost their opening consonant sat at -43, -56 and -60 dB, with no overlap between the groups. `Cr` is an unvoiced stop, so it begins with 30 to 60 milliseconds of genuine silence before the burst, and at -60 dB that is indistinguishable from a pause.

The fix is a lower threshold or a better recording, not a larger margin: a margin pads around a cut that should not have been there.

Compression does not rescue it. On that recording the weak syllable sat **25 dB below the room's own noise floor**, and a compressor lifts the noise with the syllable, so the distance between them never changes. Measured: removal fell from 31% to 15% because the raised noise stopped registering as silence at all.
