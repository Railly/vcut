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

## Output contract

Every command writes data to stdout and diagnostics to stderr. JSON is emitted automatically when stdout is not a TTY, so an agent never needs `--json`, though passing it is harmless. Exit code 2 means the invocation was wrong, 1 means the run failed.

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

`trx transcribe <input> --words --language es -m large-v3-turbo` does the same thing from
`trx@0.7.1` on. Earlier versions passed `--max-len` without `--split-on-word`, which is worth
knowing because of what that produces.

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

1. `vcut doctor` if anything looks wrong with the environment.
2. Transcribe the source word-level with a large model.
3. `vcut detect <input>` with the preset that matches the recording condition.
4. Read the warnings. If the transcript is not word-level, say so: clamping is off and cuts can land inside a word.
5. `vcut semantic export`, read the lines, write proposals.
6. **Loop**: build, render, transcribe the render, review, fold findings back in. Repeat
   until a round proposes nothing and every invariant holds. This is where most of the work
   is, and one pass is never the answer. The full procedure is under `semantic` below.
7. `vcut render --mode preview` and have a human watch it.
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
- **Check the target range.** `edl build` prints what the removal percentage is in range for.
  Raw speech landing in "scripted talking head" usually means the semantic pass was timid,
  not that the recording was already tight.

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

Run every step every round. Skipping one is how a defect survives four of them, and the way
it fails is quiet: the round still produces a shorter file, so it looks like it worked.

The step most often skipped is 3 and 4, because step 2 already produced a transcript and
reading it feels like reviewing. It is not. The transcript says what was said; `review` says
where nobody looked, and the classifier hears what no transcript writes. A round that
transcribed but did not run those two has checked one of the eight invariants.

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

# 1. Build and render from the current proposals
#    edl build validates the proposals itself and aborts on a malformed one, so a separate
#    `semantic check` is only worth running to see the errors without building.
vcut edl build --detect detect.json --semantic proposals.json \
  --output cut-$N.mp4 --campaign my-video --edl edl-$N.json
vcut render --edl edl-$N.json --mode preview

# 2. Transcribe the RENDER, never reuse the previous transcript
trx transcribe cut-$N.mp4 --words --language <lang> -m large-v3-turbo

# 3. Read the result and where nobody looked
vcut semantic review --edl edl-$N.json --detect detect.json \
  --master cut-$N.mp4 --master-transcript cut-$N.srt

# 4. Audible sound that is not language
python3 skills/core/scripts/non-speech.py cut-$N.mp4 > non-speech-$N.json

# 5. Fold findings back into proposals.json, bump N, repeat from 1
```

Three things about step 4. Its timings are the **master** timeline, so map them back through
the EDL before adding them, and a master span can cross a cut, which means one span maps to
several source spans and taking only its endpoints yields a range covering everything
between. Run it on the render, never on the source: on raw footage every pause scores as
non-speech, correctly and uselessly.

`vcut doctor` reports whether the classifier is installed and `vcut setup classifier` fetches
it, around 320MB into `~/.vcut/panns`. The script also needs `pip install panns-inference
scipy numpy`.

If it is not installed the script says so and exits. Invariant 7 still holds, and without the
classifier the only instrument left for it is a human ear: say that in the handoff rather
than reporting the edit as verified. It is the one check that cannot be read off any text.

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

**Read `unreviewed` before anything else.** A pass reads what it went looking for, so cuts
land where the attention was and the stretches between two cuts are where nothing was ever
read. They look reviewed because their neighbours are. `review` lists them with their text;
apply the deletion test to every span in that list before scanning anywhere else. A marker
that survives several rounds is almost always sitting in one.

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

Verify against the transcript of the render, not against the plan:

- Every invariant below holds.
- `unreviewed` is empty, or every stretch in it has been read.
- The non-speech pass reports nothing.
- The last line lands.

**A word missing from the transcript is not proof of a bad cut.** Transcription models drop
and mangle words, especially at a join. Before reporting one, check whether the EDL still
covers that span and what the audio measures there. If it does and the level is normal, the
transcript is wrong and the audio is fine.

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

`skills/core/scripts/non-speech.py` finds them and prints `kind: "non-speech"` proposals. It runs on the
**rendered preview**, not the source: on raw footage every pause scores as non-speech,
correctly and uselessly, while on a finished cut only real intrusions are left.

```bash
vcut setup classifier                          # once, ~320MB into ~/.vcut/panns
vcut skills list                               # prints where the script lives
python3 <path>/non-speech.py master.mp4 > non-speech.json
# map the master timings back through the EDL, then feed them in
```

It ships beside the guides rather than as a subcommand because it needs Python and a 300MB
torch checkpoint, and vcut otherwise runs anywhere ffmpeg does. Making it a verb would put
those dependencies behind a command that looks like every other one. Anything emitting the proposal schema works; that
script is the reference.

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
