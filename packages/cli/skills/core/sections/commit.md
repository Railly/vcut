## commit

```bash
vcut commit recording.mp4 --output master.mp4 --campaign my-video
vcut commit recording.mp4 --output master.mp4 --campaign my-video --video
```

Builds the EDL from a session's cached detect report and its accumulated proposals, then
renders it — the whole loop's build-and-listen step in one call, once a session has proposals
worth building.

**The build is byte-identical to running `edl build` by hand.** `commit` calls the exact same
seam `edl build` itself calls internally rather than a second implementation of the
merge/clamp/invert pipeline, so there is nothing here that can drift from what the standalone
command does on the same detect report and proposals. A session's cached detect report keeps
its own transcript path patched to the session's own cached copy before the build runs — the
same thing `peek` already does, and for the same reason: the path a detect report remembers can
move or vanish, and the session's own copy is the one guaranteed to still be there.

**The EDL is written to the current directory by default (`./edl.json`), never only inside the
session.** The session is disposable cache; the EDL is the artefact a human approves, and it
lives where they wrote it, exactly as `open`'s own manual entry already says about everything
else the session holds.

**`--audio-only` is the default render**, matching the core manual's own per-round rule:
every round's question is about sound, and rendering the picture for it costs far more wall
clock than anything a round needs. `--video` renders the preview instead, for the one call at
the end of a loop. Output lands beside the EDL as `<name>.wav` unless `--output` already names
one.

**Batch verified cuts into one commit. Never commit per find.** Every `commit` re-renders the
whole cut from scratch, so what it costs is set by how much audio the cut keeps, not by how
much changed since the last one. Two commits five minutes apart on the same source cost the
same each, and the second re-renders every second the first already rendered.

The math this rule comes from: six commits in one session on a 700-second source, ~9 to 9.5
minutes each, over 50 minutes of foreground ffmpeg — most of a session spent waiting rather
than deciding. Another run paid eight commits on a 1145-second source at similar cost apiece.
At today's ~1s per 14s of kept audio, a 490-second cut is ~35 seconds per commit, so the same
six commits cost about 3.5 minutes instead of 50 — but five of those six are still avoidable.

Propose every cut the evidence supports (`vcut cut` accumulates into the session and renders
nothing), then commit once and verify the whole batch against that one render:

```bash
vcut cut recording.mp4 --start-ms 12000 --end-ms 13400 --kind filler --reason "eh"
vcut cut recording.mp4 --start-ms 48200 --end-ms 51100 --kind tangent --reason "aside"
vcut cut recording.mp4 --start-ms 92700 --end-ms 94050 --kind filler --reason "o sea"
vcut commit recording.mp4 --output master.mp4 --campaign my-video   # one render, all three
```

This is about how many commits a round costs, never about how many rounds a cut gets. The
rounds gate still requires a real second pass against the previous round's render, and
batching does not buy a way around it.

**On a session opened from an audio-only source (#42), `--video` still renders audio.** There is
no picture to render, so the render step's own implied-`--audio-only` behaviour (see `--section
render`) applies underneath `commit` the same as it would to a bare `render` call — a stderr
note, not an error, and the session's flow otherwise proceeds exactly the same.

```
committed  ./edl.json
  removalPercent          14.2%
  semantic cuts           2
    660.24-671.83s        tangent: "Y así creo que va a ser mucho mejor. Quiero estornudar.
                          ¡Wow! Ah, perdón, estorné. Eso sí, borra la profa. Bueno, lo que"
    0.00-13.76s           tangent: "Hola, ¿qué tal? Eh, bueno, vengo a comentarles..."
  render                  rendered
  output                  ./master.wav
```

`build` in the JSON output is the same `BuildSummary` shape `edl build` emits — `removalPercent`,
`semanticCuts` with `removedText`, `boundariesInSilence`, warnings, all of it. `render` is the
same shape `render` emits. Nothing about reading either output changes because it came from
`commit` instead of the two commands run by hand.

Pulling only what a round needs to check, from the same call that already built and rendered:

```bash
vcut commit recording.mp4 --output master.mp4 --campaign my-video \
  --fields build.removalPercent,build.semanticCuts.removedText
```

**Records the round in the session** (`rounds/round-N/`: the EDL copy and the build report),
so a session carries its own history of what was proposed and what got built from it. Renders
and wavs stay out of the session, matching everything else the session holds: cheap to
regenerate, expensive to store.

**Runs `metaSpeech` on every round that has a transcript, no verb required (#38).** `semantic
review`'s own `metaSpeech` field (#37) only ever appeared inside a verb the session loop never
forces to run — an agnostic run committed four gated rounds without invoking `review` once, and
shipped the same spoken rewind marker two runs had already caught. `commit` closes that gap
directly: whenever the session's cached transcript is present, it rebuilds the same lines
`review` would from that transcript and checks them against this round's own EDL, the identical
pure pass `metaSpeech()` in `semantic.ts` already runs, over data already on disk. Nothing gets
transcribed here — the transcript is the session's cached copy, and the cost is the same
merge/clamp/invert-adjacent pass the build just above it already pays, not a second one.

The result rides in the same JSON `commit` already emits: `metaSpeech` (an array, `[]` when
clean) and `metaSpeechChecked` (`true`/`false`, whether the session had a transcript to check
this round). Both fields are always present — `metaSpeech`'s absence can never be read as "not
checked," because it is never absent; `metaSpeechChecked: false` is the honest, separate signal
for the one case an empty array cannot distinguish on its own: a session with no transcript yet.

```
committed  ./edl.json
  removalPercent          14.2%
  semantic cuts           2
  render                  rendered
  output                  ./master.wav
  metaSpeech              1 span not cut — read each and cut it or name why it stays
    1.40-1.90s            "ah, ok, otra, rebobinando desde el inicio"
  committedRounds         1
  roundsGate              insufficient-rounds
```

**Standing metaSpeech findings are named first, ahead of every other hint — including the
rounds gate's own.** `next[0]` reads `"N metaSpeech spans not cut; read each and cut it or name
why it stays"` whenever the round leaves any standing, before the rounds gate's missing-pass
hints and before `commitNext`'s transcribe/review/approve sequence. This is the retro's rank-2
fix, chosen because `commit`'s own output is the one artefact a run reads in full every round,
unprompted — a finding-class folded into a hint list only the caller reads on request is exactly
as skippable as one folded into a verb the caller can decline to run.

The test this exists for: a span that can be deleted without a listener learning anything less,
the same deletion rule `REVIEW_INSTRUCTIONS` already states for `filler` and every other
`metaSpeech` candidate. It is not a search for directive verbs — "corta eso" and "rebobinando"
narrated mid-sentence both pass the same test, and the run this fixes missed the second because
it read like narration rather than an instruction, not because it lacked a verb worth grepping
for.

**The human decision boundary is unchanged: `metaSpeech` never auto-cuts and never blocks a
render.** It names findings the same way `repeated` and `unreviewed` already do — a candidate
list, not a verdict, answered by a human proposing a cut or saying in a reason why the span
stays.

**Recorded per round, so `vcut rounds --diff` reports addressed vs. standing (#38).**
`rounds/round-N/metaspeech.json` holds exactly what this round's `metaSpeech` field carried.
`rounds --diff` compares round N's file against round N+1's by span identity: a finding present
in round N and absent from round N+1 was cut (`addressed`); a finding present in both is
`standing`. A round with no transcript to check writes no `metaspeech.json` at all, and the diff
says so explicitly (`null`) rather than reading a missing file as a clean round.

The rounds gate itself (`roundsGate` in this same output, #36) is untouched by this — it stays a
pure function of committed-round count, no metaSpeech state threaded through it. Folding a
mention in there would mean the gate's own message compares round N's standing count against
round N+1's, which needs the previous round's recorded findings passed into what is currently a
two-argument pure function; the commit-level hint above already puts the same information first
in the one place every round reads, so the added coupling did not pay for itself and the gate
was left alone.

**Runs the `verify --windows` listener sweep over its own render, every round, no flag (#44).**
Reading the render's transcript end to end catches content that stopped making sense; it cannot
catch content that makes sense twice, because a model reading ninety seconds collapses two
attempts at the same line into the one likelier sentence. The same audio cut to sixteen seconds
returns both. The run that made this mandatory shipped a render it had verified as clean, after
running `audit` (91/91 correlate), `joins`, `nonspeech --verify` twice, and a full
re-transcription of the render; `verify --windows` on that file returns 18 repeated phrases, one
of them a duplicated sentence a human had flagged by ear before the run began. That run had the
verb installed and never reached for it, because it had read the whole manual and `verify`
appeared only in the `--help` command table. This is the fifth measured instance of the same
pattern: capability off the mandatory path is capability that does not exist.

```
committed  ./edl.json
  removalPercent          14.2%
  semantic cuts           2
  render                  rendered
  output                  ./master.wav
  listener                2 repeated phrases in the render (full sweep): cut each or name why it stays
    216.00-232.00s        x2: "reciben un poema mio"
    224.00-240.00s        x2: "y bueno"
  committedRounds         2
  roundsGate              repeated-phrases-unresolved
```

**Every finding quotes the offending text.** This is as load-bearing as the gate itself. Asked
directly whether it would have overridden a gate, the agent that shipped the defect answered that
a silent boolean (`verified: false`) it might have rationalised past, but the phrase quoted
verbatim in front of it, no. "Trust me, something is wrong" is arguable; the quote is not.
`metaSpeech` already set this precedent, and the JSON follows it: `listener.report.repeatedPhrases`
carries `phrase`, `count`, and the window span for each one.

**The cost, and where it is spent.** The sweep re-transcribes the render in overlapping windows,
which is not free: roughly **1 second per 5 seconds of render** at the default concurrency
(measured 2026-08-13: a 358-second render, 44 windows, 66 seconds, concurrency 4, ~1.16GB resident
per concurrent whisper process). It runs anyway, unconditionally, because a flag would put it back
off the mandatory path and that is the entire defect. What is negotiable is how much audio it
sweeps, and #46's delta verification already answers that: round 1 sweeps the whole render, and
from round 2 on only the spans that round actually changed are re-transcribed (every segment whose
source-time signature is new, plus the neighbours of every new join, each widened by one window),
with the previous round's findings carried forward for everything outside those spans. A finding
does not expire by being ignored for a round: the audio under it did not change, so round N's
answer is still the current one and round N+1 reports it again, still quoted, still holding the
gate. `listener.scope` says which question a round answered (`full` or `delta`) and
`listener.carriedFrom` names the round whose full sweep the untouched material was last cleared by.

Re-sweep the whole render at any time, and the gate's own message names this command:

```bash
vcut verify --windows master.wav --lang es
```

`listener` is always present in the JSON, and `listenerChecked` is the separate honest signal for
the one case the record cannot express: no sweep ran at all, because `trx` is not installed. A
missing transcriber reports that it did not run rather than failing the commit or, far worse,
reporting a clean sweep that never happened.

**The gate refuses `converged-pending-review` while a repeated phrase stands (#44).** The rounds
floor answers "did enough passes run"; it cannot answer "did the passes find anything", and a
session that ran two rounds and still repeats a sentence twice is exactly as unfinished as one
that ran one. `roundsGate.status` reads `repeated-phrases-unresolved`, the message quotes the
phrases and names `vcut verify --windows`, and `next` points at cutting them, never at approval.
`insufficient-rounds` still wins over it: a missing pass is the first problem. `--single-round`
does *not* waive it, because that override acknowledges a one-round edit (a trivial clip needing
no second propose pass) and was never a declaration that a duplicated sentence in the render is
acceptable. Those are different claims.

**Recorded per round as `rounds/round-N/listener.json`**, beside the EDL, build report,
`metaspeech.json`, and `dead-air.json`, so a caller can read what a round's render actually said
without re-transcribing it.

**Carries the rounds gate in `roundsGate` and shapes `next` around it (#36).** Below 2
committed rounds, `roundsGate.status` is `'insufficient-rounds'` and `next` is the missing
pass — render, transcribe, `semantic review` against THIS render, read, `cut`, `commit` again —
never the approve-shaped hints, because those are exactly what let a run mistake round 1's own
verification for a second round. `--single-round` acknowledges a genuine one-round edit
explicitly, recording `single-round-ack.json` in the session so the override shows up in the
record rather than living only in the caller's head; a session already acknowledged reports
`'acknowledged-single-round'` instead of refusing. At 2 or more committed rounds without an
override, `roundsGate.status` is `'converged-pending-review'` — the floor is cleared, but
convergence still means the most recent round proposed nothing, which this field does not
itself verify.

**Master mode never happens here, and the human decision boundary the core manual states is
untouched.**
Approval is a human edit to the EDL — `approval.status` to `"approved"`, each segment's own
`approval` to `"approved"` — followed by the existing `vcut render --edl <path> --mode master`.
`commit` only ever drafts and previews; it does not write approval and it does not accept
`--mode master`. If you find yourself wanting `commit` to finish a master, that want is the
approval step arriving early, and the answer is still the same: hand the EDL to a human.

**Takes the session's advisory lock for the whole build+render**, released after (or on error —
a `finally`, not a happy-path-only release). A session already locked by another live process
refuses with the same holder-naming error `cut` gives. **On success, the session is marked
`committed`** — the spike's B7-Q2 rule: a successful commit is the signal `session gc` reads as
a candidate to clear, never a signal that triggers deletion by itself.
