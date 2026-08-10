# Changelog

Notable changes to `@crafter/vcut`. Entries say what changed and, where it is not obvious, what measurement led to it.

## 0.7.2

0.7.0 reported a repeat still present in the render, and 0.7.1 told rounds to run the check.
The next run did both, read `survivingRepeats`, wrote a reason calling the phrase a deliberate
callback, and reported the result clean while the check exited 2. The contract said naming was
the bar; it is the bar for one of the two failures, and the wrong one.

### Changed

- **`unaddressedRepeats` and `survivingRepeats` are cleared differently, and the instructions now say so.** A reason clears the first. Only a cut clears the second, because the phrase is still in the file and no wording changes that. A round that judges a surviving repeat deliberate has a question for whoever approves the EDL rather than a finished result, and saying so is the honest end — reporting clean while the check exits 2 is what six runs did, three of them after naming the phrase correctly.

## 0.7.2

A repeated phrase is not a defect. 0.7.0 made presence-in-the-render fail the check, which read
every callback as a retake and left naming unable to close the loop: the only move that changed
the exit code was cutting further. Six runs of one recording chased a repetition the author
wanted kept, and the run that got it right had to deliver over a failing check to do so.

### Fixed

- **`survivingRepeats` reports, it no longer gates.** `semantic check` exits 2 only while a repeated phrase is unnamed by every proposal reason. A phrase still in the render stays in the output as a list to read before finishing, since it is the right answer for a callback and the wrong one for a retake and nothing counting words separates those.

### Changed

- **The manual names how to tell a callback from a retake**, which it had never said despite ruling on retakes throughout. Two tests, both structural rather than lexical: a retake carries a spoken discard marker between the attempts and its absence is evidence, and in a retake both attempts serve the same clause while in a callback each occurrence is the antecedent for different material. One recording carries both twelve seconds apart, which is why a rule keyed on wording gets one of them wrong every time.
- **The instruction that listed "natural anaphora" and "a deliberate echo" as the readings that kept a defect is gone.** It was written from four runs that had kept a retake, and it pushed the next run toward cutting a callback that belonged in the piece.

## 0.7.1

Six runs on one recording. The gate added in 0.6.0 and 0.7.0 catches every defect they shipped —
run it on any of their final states and it exits 2 — but it is opt-in, and the runs that shipped
a defect are exactly the ones that never ran it.

### Changed

- **`review` tells the round to verify its own empty answer.** Reporting nothing is now framed as a claim to check rather than a way to finish, with the `semantic check --review` invocation written out in the instructions the round is already reading. Every run that shipped a repetition reported nothing first.
- **The readings that keep a repeat are named.** "Natural anaphora", "a deliberate echo" and "it connects to what came before" have each been the sentence a run wrote before shipping a defect. They describe what a restatement does, so none of them separates one from a retake, and the instructions now say so next to the deletion test.
- **The boundary search is written as a loop that can be run rather than a technique to remember.** Stepping windows by hand is where runs give up and guess. The manual also says not to anchor the search on a boundary `edl build` already snapped to: one run did, got the right answer, and reported afterwards it would have inherited the error had the snap been wrong, since the snap comes from the same transcript being questioned.
- **How to close a non-speech finding without an ear.** A span carrying ordinary transcribed words at a normal level is a false positive, readable with `vcut say`, and does not need a listener: one run stalled on a 640ms span whose master transcript reads "proyectos open source, lanzarlos en Linkedin" at -17.6 dB. Re-transcribing the span alone does not settle it — that same span returns "No, eh..." because a window that short returns noise whatever it holds.

## 0.7.0

### Added

- **`semantic check --review` also fails on a repeat that survived the cut.** 0.6.0 checked that every repeated phrase was named in a reason, which a run satisfied honestly while missing the cut: its reason quoted the repeated line, its boundary landed 1772ms short of where the repetition ended, and the render still said the phrase twice. Naming and removing are different claims, and only the second is visible in the result. The check now counts each phrase in the render's own lines, which `review` already carries, so it costs no extra transcription and reports `survivingRepeats` beside `unaddressedRepeats`.

### Changed

- **The manual says why re-transcribing a window does not settle a retake boundary.** Every attempt says the same words, so a window opened anywhere inside the run comes back grammatically complete and reads like the telling worth keeping: opened at 59.0, 60.0, 61.0 and 62.0 seconds the same passage returned "Ah, otra vez. Y a la que conocemos", then "Y a la que conocemos, ya llegamos a mil miembros", then "Ya llegamos a mil miembros". Three of those look like a clean start, which is how three runs each verified a boundary and each was wrong. The test that settles it is the phrase rather than the timestamp: step the window forward until the repeated wording stops coming back.

## 0.6.1

### Changed

- **The manual says why three runs cut the same retake at the same wrong place.** They ended at 61000, 61020 and 61192ms, each about 1772ms short of the boundary that removed it, and none of them misread anything: the whole-file transcript placed "ya llegamos a mil miembros" from 58540ms across two measured silences of 980ms and 691ms, while the audio there says "conocemos... ah, otra vez" and the surviving line starts at 62.7s. Inside a fused region the words are right and the clock is not, so a boundary read off the transcript lands seconds from what it names. Agreement between runs is not evidence either — three agents converging usually means they read the same wrong number. Confirm the end of a retake cut by re-transcribing a window that starts after it and checking the first words back are the telling being kept.

A warning for this was written and reverted rather than shipped: on the recording it was built
against it fired eight times, none of them on the zone that actually mattered, and tuning it
further would have been fitting a threshold to one file. The rule is worth stating without a
detector behind it.

## 0.6.0

0.5.0 listed repeated wording so that keeping it had to be a decision about a named phrase. The
next run read its own list, decided one entry was a deliberate turn, wrote no proposal, and
shipped the repetition anyway. A field can be skipped in silence.

### Added

- **`semantic check --review <path>` exits 2 while any repeated phrase goes unanswered.** It takes the JSON a previous `review` wrote and checks each entry in `repeated` against the reasons the round's proposals carry. A phrase no reason mentions means the round read the list without answering it, and that is not a finished round. Naming is the bar rather than agreeing: keeping a repeat is often right, and writing why in a reason puts the decision where a human approving the EDL can find it. The flag is optional, since a first round has no review to check against, and `check` without it behaves exactly as before.

### Changed

- **The loop in the manual runs `check --review` every round**, and the closing checklist requires it to exit 0.

## 0.5.0

Five runs of one recording through the loop. Four shipped a repetition, and not one of them
missed seeing it: every reading that kept a defect was "I looked at this and it is deliberate".
The tool met that with the same silence it gives a correct call.

### Added

- **`semantic review` reports `repeated`**: wording that occurs more than once in the render, with the lines it occurs in. It judges nothing — a name, a term the piece is about and a deliberate echo all repeat legitimately — but it turns "this reads clean" into a decision about a named phrase. Word runs rather than a similarity score, because similarity cannot separate a restatement from two sentences sharing prepositions: on one recording the repeated pair scored 0.150 against 0.114 for a healthy neighbouring pair, while exact runs separated the same two masters four entries to one, and that one was the project's name. The review instructions now require an answer for every entry before an empty report is valid.

### Changed

- **The manual names how to recognise a retake.** It referred to retakes three times without saying what one looks like, so a run kept "¿Es un honor? No, no, no, otra vez. Es un honor. No, eso es muy fake." as a rhetorical beat while correctly cutting an identically shaped retake in the same master. Self-direction that reached the microphone — "otra vez", "no, así no", "scratch that" — is a cut whatever the delivery sounds like, and the test is structural: a self-critique is followed by another attempt at the same line.
- **A retake cut ends at the first word of the telling being kept.** Inside a fused region the cue timings are averaged, so a boundary drawn from them lands mid-repetition and leaves the final attempt whole while the EDL looks correct. Two runs cut the same retake: one ended at 62792 and removed it, the other at 60820 and left "ah, otra vez. Y a la que conocemos" audible.

## 0.4.5

Four runs of the same recording through the loop, three of which shipped a defect a listener
caught on the first play. What separated the one that worked was not tooling but three things
the manual left to the reader.

### Changed

- **A long cue has two causes and the manual only named one.** Drift stretches a cue over silence and is benign, which the manual documented. A transcript that fused several attempts at the same line stretches a cue over *speech*: the model heard a phrase three times, wrote it once, and the surviving word carries the time all three occupied. Both surface as an unusually long cue, so the existing warning cannot distinguish them, and a run read it as drift and lost a round. The manual now says to tell them apart by what the audio does inside the cue's own span, to normalise duration per character first (`emprendedores,` at 980ms is 70ms per character and ordinary; `conocemos,` at 2590ms is 259 against a file median of 79), and to re-transcribe a 4 to 8 second window before cutting nearby. On one recording the whole-file pass wrote "Y a la que conocemos, ya llegamos" once where short windows returned it three times with an "ah, otra vez" between them.
- **The empty round cannot be the first one.** The manual said one pass is never enough without saying how many are. Four runs separate on this and nothing else: the three that stopped at one round shipped a repetition, and the shortest of them cut 33.78% while declaring itself done, against 44.04% for the run required to continue, which found the largest cut in the file in round two on material round one had called clean.
- **What to do when `audit` and the render's transcript disagree.** They ask different questions, so both can be right: `audit` asks whether a segment carries what the EDL points at, and a cut drawn too narrow carries exactly that while leaving the rest of the defect behind it. One run spent fifteen commands reconciling a 0.94 correlation against a transcript that still read the phrase it had just cut. The manual now says to resolve it on the source rather than the master, which already inherited whatever the cut left.

## 0.4.4

### Changed

- **`--audio-only` is the loop's render, stated as a rule rather than an optimisation.** Two runs read the old wording as a suggestion and rendered video anyway: one spent 69 of its 105 seconds of tool time on two video renders, the second of them purely to feed checks that changed no decision, while the repetition it was meant to catch survived to the master. The manual now says to render audio every round and the picture once, at the end, and names what pulls an agent back to video early.
- **`audit` and the non-speech pass are placed after the loop, not inside it.** They need a picture, so running them per round costs a video render each to answer a question no round was asking. The workflow now says to expect both to report something and for it to be nothing — `audit` scores low on short quiet windows by construction, the classifier cannot tell a breath from an intrusion — and to spend one `vcut say` clearing each rather than a round. A check whose output never changes a decision is ceremony, and both runs spent longer on these than on cutting.
- **The `--audio-only` duration note describes 0.4.1 rather than the bug it fixed.** It still told readers to expect a render tens of milliseconds short of the segment sum, which stopped being true when the trim moved to sample counts, and which had been sending rounds back through the video path for no reason.

## 0.4.3

### Changed

- **The manual names the shape of a surviving repetition instead of quoting one.** The previous entry carried the literal sentence from the recording it was found on, and that recording is what the loop is usually run against, so the manual handed the answer and the noise together: one run reported doubting a real defect because it recognised the wording from the manual and could not tell whether the example had been drawn from its own corpus. It now describes the construction — a sentence ends on a phrase, the next line reopens with that phrase to bridge a pause, both halves parse as ordinary grammar — and gives the test that separates it from a genuine connective: delete the phrase and see whether the sentence still lands. Two rounds on one recording cleared the same repetition, the first by never comparing the lines and the second by comparing them and deciding the restatement "connects to what came before", which is what a restatement does.

## 0.4.2

### Fixed

- **`vcut --version` reported a version the binary was not.** The number lived in a constant in `cli.ts` as well as in `package.json`, and 0.4.1 shipped to npm with the constant still reading `0.4.0`: the release bumps `package.json` alone, so the second copy drifted the moment nobody looked, and `--version` stopped being evidence of what was installed. It is now read from `package.json` at startup, with a test that fails if the two ever disagree.

## 0.4.1

### Fixed

- **`render --audio-only` rejected renders that were correct.** It exited 1 with `duration differs from EDL` on EDLs the video path accepted, so the only way forward was rendering the whole video and extracting its audio, which is what the flag exists to avoid: in one loop run that workaround took 66s of 108s total tool time. Neither filter loses samples alone; the pair does. Counted over one source: concat gives 2817704 samples, concat with `loudnorm` the same 2817704, concat with `loudnorm` and `atrim=end=<seconds>` only 2813000. `loudnorm` rewrites timestamps, so a trim by time cuts against its clock rather than the one the segment sum was measured in. The shortfall bore no relation to segment count (82ms at 3 segments, 15ms at 6, 31ms at 12, 98ms at 25), which is what ruled out the accumulated-latency explanation 0.4.0 recorded above. Audio-only now trims by sample count, which nothing upstream can shift: all four scales land at 0ms drift. The video path keeps the time trim on purpose, since it is validated against the container where the picture sets the duration, and it renders byte for byte what it did before.
- **The duration tolerance drops from 60ms to 10ms.** The 60ms came from a single 31ms measurement and still rejected a valid render 98ms out on the next source. The real residue is now 0.17ms. The error reports the measured gap and the tolerance, which from outside the process was the only way to tell a near miss from a broken render.
- **A failed render no longer leaves its output on disk.** It exited 1 and left the file behind, so the next command read it as finished work. Renders now go to a sibling temp file and are renamed once they validate.
- **`--dry-run` no longer refuses to run when the output exists.** It writes nothing, and the check ran before the dry-run branch, so after a failed attempt the command could not even be inspected: exactly when it is needed.

### Changed

- **The manual says how to read `unreviewed`, not just to read it first.** A round read every entry, judged each sound, and shipped a repetition: two adjacent lines each made the same point, the second also named in `unreviewed` with its timings, and the round returned an empty array. The deletion test asks whether a span repeats something already said, not whether it stands up alone, and every line stands up alone. It now says to print each span with the line before and after it, then read `lines` as continuous prose, and why neither reading substitutes for the other. Lexical similarity does not do this instead: the repeated pair scored 0.150 against 0.114 for a healthy neighbouring pair.
- **`deadAir: []` is documented as saying nothing about repeated content.** It measures pauses the cuts left. It was read as confirmation that a result was clean while a sentence appeared twice in the same transcript.

## 0.4.0

Everything here came out of one editing session that took 28 minutes to cut 90 seconds of
video, and out of measuring where that time went. The answer was not compute: it was that
several questions an editor asks constantly had no command to ask them with, so each one was
answered by hand with ffmpeg and arithmetic, and two of those hand-rolled answers were wrong.

### Added

- **`vcut locate`** translates between a position in the master and the source it came from, in either direction. Deriving that mapping by hand is the trap it replaces: accumulating `outMs - inMs` produces a total that can match the rendered file to the millisecond while individual positions land seconds away, with nothing in the agreement to warn you. `--explain` reports the neighbourhood a position sits in; `--render <path>` measures the file rather than trusting the EDL, which records intent. Asking about material that was cut reports it as removed with the next surviving segment, rather than failing.
- **`vcut audit`** compares a render's audio against the source span the EDL points at, segment by segment. Every check the renderer runs on itself is an aggregate, so a render whose segments carried the wrong material passes all of them. It reports rather than fails and stays out of `render`: envelope correlation is weak over short and quiet windows, and a threshold built on it would block good renders. Measured on one 22-segment render: 1.5s to check, 21 segments above 0.85, and the one below was verified by transcription to hold the right words.
- **`vcut say`** reads back what is spoken at a position, with the level there and, with `--edl`, which segment it falls in. It reads an existing transcript rather than re-transcribing a slice, which removes a trap instead of warning about it: a window under about two seconds transcribes as noise whatever it contains, so a gibberish result cannot tell a real word from a model's guess. vcut still never calls a model.
- **`vcut render --audio-only`** renders the audio alone, for the rounds where every question is about sound. Measured on one 22-segment EDL: **0.25s against 31.8s** for the same cuts. The audio graph is unchanged, edge fades and loudness included, so what you hear is what the finished render will sound like: -16.4 LUFS on both paths. Writes lossless audio, because a codec artifact heard while iterating reads as a defect in the cut. Refused in master mode. The result runs a few tens of milliseconds short of the segment sum (31ms on a 54.6s cut), which is `loudnorm` latency draining trailing decay rather than missing material. (0.4.1 corrects this: the shortfall was the time trim cutting against loudnorm's rewritten clock, not latency, and it is gone.)
- **`vcut skills get debug`** documents how to investigate a cut that came out wrong: the question, the method, and the trap that makes the obvious method produce a confident wrong answer. Two of its entries were rediscovered while building the commands that replace them.

### Changed

- **`edl build` warns when a segment opens right after a semantic cut.** That is where the tail of removed speech leaks into a render, and it does not arrive looking like a defect: it arrives as a plausible sentence with the wrong meaning. The condition is the kind of cut, not a distance. Keying it on "the removed span contained words" was the first attempt and it fired on 23 of 24 boundaries, because with word clamping every silence cut brushes the margin around a word.
- **`detect` warns when a word timestamp contradicts measured energy.** Cues drift toward silence, so clamping can hold a boundary open around a pause the detector correctly found. The symptom reads as a threshold problem and the reflex is to change the preset, which does not move it. There is no filter on the warning: measured on one recording the drift ran from 1318ms down to a median of 246ms with no gap to cut at, so it names the worst case with its position instead of inventing a threshold.
- **`detect --human` says whether word clamping engaged**, and with how many words. Running with and without `--transcript` used to print the same summary while producing different cuts: 22.74% removed against 19.55% on the same recording.
- **The manual no longer claims `trx --words` is equivalent to a prompted `whisper-cli`.** It is not: without a prompt the transcript comes back cleaned and the hesitations the manual tells you to keep never reach it. It now points at `trx --preset verbatim`.
- **The loop in the manual carries its commands**, including running `semantic review` every round rather than at the end. It measures the render instead of the plan, which is the only way a pause that survived the cut becomes visible.

## 0.3.1

### Added

- **`detect` warns when the transcript was split on tokens rather than words.** `--max-len 1` caps a cue at one token, so without `--split-on-word` a multi-token word arrives as fragments and the transcript looks word-level while being useless for clamping. Measured on one recording: 26% of cues were fragments without the flag, 0% with it. `wordLevel` said `true` in both cases, because it counts cues rather than judging them, so nothing downstream could tell the difference. `parseSrt` now reports `fragmentRatio` and `detect` warns above a tenth.

### Changed

- The skill and README showed a transcription command that produced exactly the transcript they called unusable: the wrapper they recommended passed `--max-len` without `--split-on-word`. Fixed upstream in `trx@0.7.1`; the docs now show both flags and a one-line way to verify a transcript rather than trust it.
- Three method notes, each from a defect a listener found and the pass did not: ask the transcriber to keep hesitations, since it cleans by default and a hesitation that never reaches the transcript cannot be proposed; re-transcribe a passage before concluding the transcript is right, because a whole-file read collapses three attempts at one line into one; and treat a mapping between the source and master timelines as a claim rather than a fact, since a converted timestamp looks exactly as confident as a measured one.
- The round now says out loud that skipping a step fails quietly, because the round still produces a shorter file and looks like it worked.

### Fixed

- The non-word-level transcript warning still mentioned filler detection, which left the CLI in 0.2.0.

## 0.3.0

### Added

- **`vcut semantic review`** reads an EDL back and returns the transcript as it survives the cuts, so what gets judged is the result rather than the plan. `--master` measures silence on the render itself, catching the pause two adjoining segments create together that neither of them contained. `--master-transcript` returns the render's own lines, which is the only place a mangled join is visible as text.
- **`unreviewed`** in the review output: the stretches between two cuts that no proposal ever touched. They look reviewed because their neighbours are, and that is where a defect survives round after round. On the recording this was built against, a discourse marker sat in one for four rounds with a cut ending 1.7s before it and another starting 140ms after.
- **`--crop <spec>`** on `edl build`, framing the whole edit at once. A traditional editor sets the frame per clip, so remembering the menu bar after cutting means redoing every segment by hand; here it is one decision and changing it never touches a cut boundary. Accepts `top|bottom|left|right:<fraction>` or `x,y,width,height`, as fractions so the EDL survives a source at another resolution.
- **Loudness normalisation.** The EDL had carried `speechTargetLufs` since V1 and nothing read it. Applied to the concatenated result rather than per segment, so a quiet passage stays quieter than a loud one. Measured: -25.4 LUFS in, -16.5 out, true peak -0.87 against a -1 ceiling.
- **`--edge-fade <ms>`** (default 50) ramps each segment edge to zero. Not a crossfade: overlapping the sides would shorten the render against concatenated video and drift the audio out of sync, so each side fades within its own segment. Measured 18 to 20 dB less at the joint.
- **Audio recorded separately.** `detect --audio <path>` measures silence on that file rather than on the camera track, which is the one being discarded. The path travels in the report, so `edl build` writes both sources without being told twice. `--audio-offset <ms>` corrects two recorders that did not start together by sliding the window the audio is read from.
- **`kind: "non-speech"`** in the proposal schema, with `skills/core/scripts/non-speech.py` to find those spans. Keyed on the absence of speech rather than the presence of breathing: on one recording a breath scored 0.087 for Breathing, too low to use, against 0.06 for Speech where every span holding words scored 0.64 and up.
- **`vcut setup classifier`** fetches that model into `~/.vcut/panns`, and `vcut doctor` reports whether it is present. Absent is a supported state, not a broken install: the check it performs falls back to a human ear.
- **`vcut skills list`** now lists bundled scripts alongside the guides, so a caller asking what is available learns the script exists.

### Changed

- **Cutting is documented as a loop, not a command.** Each class of defect only becomes visible once the one above it is gone, so the skill now carries the round in order, eight invariants stated about the render rather than the plan, and a stopping condition: a round that proposes nothing, not a removal percentage and not diminishing returns.
- `matchTarget` said "below every target range" for any value outside a range, so a 45% removal received the opposite of the message it needed.
- Filler words are documented as a deletion test rather than a vocabulary: delete the candidate, read what remains, ask whether a listener learns anything less. A word list only finds what someone thought to write down and has to be rewritten per language.

### Removed

- **`noiseReduction` is gone from the EDL schema.** Measured on one recording, the background floor already sat at -54 dB and a denoiser at a default setting pushed a weak syllable from -45 dB to -57, which is the same defect as a threshold set too high. There is no safe default because the right amount depends on the room, and unlike a cut it cannot be undone by editing the EDL.

### Fixed

- Cuts separated by a remainder too short to hold a word are merged. Two cuts with 216ms between them do not read as two cuts: the ear hears one broken passage, and a listener flagged exactly that before any metric showed it. Six such islands became zero on the test material.
- `detect` reported filler candidates past the end of the source when the transcript outlived the cut it was made from.
- The renderer's audio contract asked the segment's own source for sound, which fails for a video recorded mute; `audioTrackPolicy` had the same shape of bug, resolving to `explicit-silence` because the picture carried no audio.
- `renderedGaps` promised an empty list when it could not measure but threw if ffmpeg was absent from PATH.

## 0.2.0

### Removed

- **Breaking: `detect` no longer looks for filler words.** The `fillers` field, `--no-fillers`, and the three-language validation of `--lang` are gone. The list held six tokens per language; measured on one Spanish recording it caught 3 spans while the finished cut still carried 19 fillers in 332 words. What it missed were ordinary words that carry no meaning in one sentence and plenty in the next, which no list can distinguish. Filler words are now proposed by a model through `vcut semantic`.
- `--lang` survives as a free-form string, passed through to the semantic export so a model knows what it is reading.

## 0.1.1

### Added

- **`vcut semantic`**: `export` hands the transcript to a model as numbered lines, `check` validates the proposals it returns. vcut never calls a model itself, which keeps it dependency-free and its output reproducible.

### Fixed

- The renderer normalised sample rate but not channels, so a mono source produced a master its own validator rejected. Only visible with a mono source, which is how a separate microphone usually records.
- Word-level transcripts lost the leading space that marks where a word begins, making `"Cra"` + `"fter"` impossible to rebuild.

## 0.1.0

First release. `detect`, `edl build`, `render`, `schema`, `skills`, `doctor`.
