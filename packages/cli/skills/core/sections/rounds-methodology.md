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

**With a session open, this is where `cut` and `commit` replace hand-writing
`proposals.json`.** `vcut open <media>` once, at the start; every round after that is
`vcut cut <media> --refs <ref[..ref]> --kind <kind> --reason "..."` per finding, then
`vcut commit <media> --output <path> --campaign <id>` to build and render the round in one
call. The step most often skipped below is 3 — reading the result — and the session flow does
not remove that step, it removes the ceremony around steps 1 and 4: no proposals file to open
and hand-edit, no re-typed `--detect`/`--semantic` paths per round, and `removedText` is quoted
back at propose time instead of only appearing after a build.

A finding never has to leave the session's coordinate system to become a `cut`. `semantic
export` lines carry `nearestRef`, so a proposal you write from export goes straight into
`--refs <nearestRef>`. `say` and `silences` emit raw milliseconds instead — `atMs`, `startMs`,
`endMs` — and `--start-ms <n> --end-ms <n>` takes those directly, no seconds conversion, with
the same accumulation into `proposals.json` and the same visibility in `rounds --diff` that
`--refs` and `--span` already have.

```bash
vcut open recording.mp4 --preset clean --lang es --transcript words.srt   # once
vcut cut recording.mp4 --refs b042..b044 --kind repetition --reason "..."  # per finding
vcut commit recording.mp4 --output master.mp4 --campaign my-video          # builds + renders the round
trx transcribe master.wav --words --language es -m large-v3-turbo          # step 2, same as always
vcut semantic review --edl edl.json --detect detect.json \
  --master master.wav --master-transcript <the .srt trx wrote>             # step 3, same as always
```

`commit` defaults to `--audio-only`, so this is still the cheap audio path every round, not a
video render. `vcut rounds recording.mp4 --diff` after a second `commit` answers "what changed
since the last round" — `removalPercentDelta`, `segmentCountDelta`, and each semantic cut as
`added`/`removed`/`changed`/`unchanged` — in one call instead of eyeballing two transcripts
against each other.

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
it. A session's own `rounds/round-N/` does this numbering for you when `commit` is driving the
loop.

**Escape hatch — the same round without a session.** Only when no session fits: a one-off cut,
or a script driving vcut with no long-lived working directory. It calls the exact same build
seam `cut`/`commit` call, so the EDL is identical; what you take on is the numbering by hand.

```bash
N=1   # bump every round: the renderer refuses to overwrite

# 1. Build and render from the current proposals, audio only
#    edl build validates the proposals itself and aborts on a malformed one, so a separate
#    `semantic check` is only worth running to see the errors without building.
#    --report-json keeps this to one build: human summary on stdout, the report joins wants on disk.
vcut edl build --detect detect.json --semantic proposals.json \
  --output cut-$N.mp4 --campaign my-video --edl edl-$N.json \
  --human --report-json report-$N.json
vcut render --edl edl-$N.json --audio-only --output cut-$N.wav   # 0.25s, not 32s

# 2. Transcribe the RENDER, never reuse the previous transcript
trx transcribe cut-$N.wav --words --language <lang> -m large-v3-turbo

# 3. Read the result and where nobody looked
vcut semantic review --edl edl-$N.json --detect detect.json \
  --master cut-$N.wav --master-transcript <the .srt trx wrote>

# 4. Fold findings back in with semantic merge, bump N, repeat from 1
vcut semantic merge proposals.json round-$N-findings.json --out proposals.json
```

The classifier's non-speech pass answers a question no round above is asking, so it runs once,
near the end rather than inside this loop — see `--section muletillas` and step 7 of
`--section workflow`. It reads audio only, so run it on the same `--audio-only` `.wav` every
other check in the round already uses; there is never a reason to render video to feed it.
Running it every round costs a pass each and finds nothing the loop's audio steps could not,
which is the same ceremony trap `audit` falls into below.

```bash
vcut nonspeech cut-$N.wav --verify --lang <lang> > non-speech.json   # the audio-only render
```

**Always run with `--verify`.** Without it you get the classifier's raw spans and nothing
else, which puts you back where the manual used to leave you: closing each hit by reading the
whole-file transcript, which is circular for this class of sound (see `--section classifier`
for why). `--verify` re-transcribes a short window around each span with
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
