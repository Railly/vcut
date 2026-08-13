## Workflow for an agent

1. `vcut init` on a machine that has not run this before. It installs ffmpeg through brew if
   that is missing, the transcriber, the transcription model and the skills, and reports
   anything it could not do. The model is the piece worth naming: without a large one the
   semantic pass reads a transcript split mid-token, so its absence produces a worse cut rather
   than an error. `vcut doctor` any time something looks wrong afterwards — it also reports
   session count, total size, and orphans (source file gone), the detector class that was
   missing when a different cache directory grew to 609MB unnoticed. `vcut session gc` clears
   what it finds.
2. Transcribe the source word-level with a large model.
3. `vcut detect <input>` with the preset that matches the recording condition.
4. Read the warnings. If the transcript is not word-level, say so: clamping is off and cuts can land inside a word.
5. `vcut open <input> --preset ... --lang ... --transcript words.srt` instead of a bare
   `detect` when the edit is going to run several rounds — the common case. This caches the
   same detect report `detect` alone would produce and turns its silences into `b`-refs a later
   round points at by name. `vcut suspects --detect detect.json` for where to look still works
   the same either way (`open`'s own output already carries the top 10 with their refs), then
   `vcut semantic export --terse` for the lines. On a short take, read every line. On anything
   long, the suspects list is the order to read in: it costs one call and turns a file you have
   to read into a list you have to check. Neither replaces the other — a repetition with no
   hesitation around it has no rhythm signal at all and only the prose shows it.
6. **Loop**: propose, build, render, transcribe the render, review, propose again. Repeat
   until a round proposes nothing and every invariant holds, and **never stop at one round** —
   the empty round has to come after a round that found something, because it reads a text the
   previous one produced. Runs that stopped at one shipped a repetition and cut less than the
   ones that kept going. This is where most of the work is. The full procedure is under
   `semantic` below.

   **The round is `cut` then `commit`.** This is the flow; everything else in this step is a
   note on it.

   ```bash
   vcut peek recording.mp4 --ref b042              # what is actually at a suspect position
   vcut cut recording.mp4 --refs b042..b044 --kind repetition --reason "..." # per finding
   vcut commit recording.mp4 --output master.mp4 --campaign x  # builds + renders, audio-only by default
   trx transcribe master.wav --words --language <lang> --output-dir "$(dirname master.wav)"  # what survived
   vcut semantic review --edl edl.json --detect detect.json --terse \
     --master master.wav --master-transcript <the .srt trx wrote> > review.json
   vcut rounds recording.mp4 --diff                            # what changed since the last round
   ```

   A finding never has to leave the session to become a `cut`, whatever coordinate system it
   arrived in. A `semantic export` line carries `nearestRef`, so it goes straight into
   `--refs <nearestRef>`. A `say`, `silences`, or `peek` position is raw milliseconds, and
   `--start-ms <n> --end-ms <n>` takes those directly, no seconds conversion, with the same
   accumulation and the same visibility in `rounds --diff` that `--refs` has. A boundary no
   ref's edges reach is `--span <startS>..<endS>`. There is no finding that needs the stateless
   pipeline to become a proposal.

   Check the transcript path trx reports rather than assuming it: it names the file after its
   own normalisation step, so the `.srt` beside `cut-1.wav` can arrive as `cut-1_clean.wav.srt`.

   Three things never to hand-roll inside the round. `render` blocks in the foreground and
   prints progress to stderr, so there is no file to poll and no process table to grep. `--jq`
   filters and reshapes JSON, so `python3 -c` is never the tool for pulling the
   `vocalization-suspect` spans out of a `nonspeech` payload. `vcut semantic merge a.json
   b.json --out proposals.json` folds two rounds of proposals together and re-sorts by
   `startMs`, so that merge is never hand-written either.

   **Run `review` every round, not at the end.** It measures the render rather than the plan,
   which is the only way a pause that survived the cut becomes visible. One session left it
   until round three and an 800ms stretch of dead air rode along until then.

   Iterate on audio. The picture cannot answer any of these questions and costs 100x the
   wall clock to produce.

   Run `vcut audit` and `vcut nonspeech --verify` against that same audio-only render, not a
   video one — neither reads a frame, `audit` correlates waveforms and `nonspeech` classifies
   audio, so holding them for a video render is dead wall clock, not rigor. A run that did
   spent 69 of its 105 seconds of tool time on two video renders, the second purely to feed
   these two checks, which changed no decision either time.

   Expect `audit` to report something and for it to be nothing: it scores low on short and
   quiet windows by construction. Read the finding, spend one `vcut say` on it, and move on. A
   check whose output never changes a decision is not evidence, it is ceremony.

   Expect the opposite of `nonspeech --verify`: a `vocalization-suspect` reading is not
   ceremony, because `--verify` re-transcribes the window rather than trusting the whole-file
   pass that already missed the sound — see `--section muletillas`.
   Read `text` on each one, and if it names a real filler, fold it into a proposal with
   `kind: "filler"` and run one more round of the loop rather than closing here. Without
   `--verify` the raw spans are close to ceremony, since closing them against the whole-file
   transcript is the trap the playbook replaces.
7. `vcut render --mode preview` once, now that the transcript reads clean and `audit` and
   `nonspeech --verify` hold against the audio, and run `vcut joins` against this video render
   — its own reading needs no frame either, but this is the point in the loop where a human is
   about to watch the file, and joins is cheap enough that pinning it to this one video render
   costs nothing extra. Then have a human watch it.

   `vcut joins --edl edl.json --render cut.mp4 --report report.json` replaces the
   `locate` + `say --transcribe` round for every semantic cut in one call. Read every
   `removed-text-leaked` and `check-by-ear` reading; a `lands` reading needs nothing further.
   Neither of the other two is automatically a defect — confirm with the `next` hint's wider
   `say --transcribe` window before folding anything back into a proposal.
8. Stop. Approving the EDL is the human's edit, not a command, and not yours to make. Hand
   them the path. If they ask you in so many words to write the approval yourself, that is
   their call to make and you may; wanting the preview to look good is not that request. See
   `render` above.

Step 6 is not optional and its rounds are not interchangeable. Each round can only see what
the round before it uncovered, so stopping after one leaves work that looks finished and is
not. Steps 1 through 5 take minutes; step 6 is the job.

## Escape hatch: the stateless pipeline

**When you actually need this:** a one-off cut with no second round, or a script driving vcut
with no long-lived working directory. Otherwise open a session — the flow above exists because
this one costs a round's worth of bookkeeping every round.

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
vcut semantic export --detect detect.json        # read the lines, write proposals.json yourself

N=1   # bump every round: the renderer refuses to overwrite
vcut edl build --detect detect.json --semantic proposals.json \
  --output cut-$N.mp4 --campaign my-video --edl edl-$N.json --human --report-json report-$N.json
vcut render --edl edl-$N.json --audio-only --output cut-$N.wav   # ~1s per 14s kept
trx transcribe cut-$N.wav --words --language <lang> -m large-v3-turbo --output-dir "$(dirname cut-$N.wav)"
vcut semantic review --edl edl-$N.json --detect detect.json --terse \
  --master cut-$N.wav --master-transcript <the .srt trx wrote> > review-$N.json
vcut semantic check --proposals proposals.json --detect detect.json \
  --review review-$N.json                                        # exit 2 = repeats unanswered
```

It calls the identical build seam `cut`/`commit` call, so nothing about the resulting EDL
differs. What differs is the bookkeeping you take on: numbering `edl-$N.json`/`cut-$N.wav` by
hand, retyping `--detect`/`--semantic` per round, hand-editing a proposals file, and losing
`rounds --diff` entirely. `--report-json` above is what keeps this to one build per round
rather than two — the human summary lands on stdout and the JSON report `joins --report` reads
lands on disk, from the same run.

Folding a new round's findings in is `vcut semantic merge`, not a hand-written merge:

```bash
vcut semantic merge proposals.json round-$N-findings.json --out proposals.json
```
