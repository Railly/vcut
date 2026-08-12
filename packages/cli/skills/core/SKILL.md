---
name: core
description: Core vcut usage guide. Read this before running any vcut command. Carries the session flow that runs an edit, the round methodology, the approval boundary, presets, and a verb table. Per-command deep dives load on demand through vcut skills get core --section <name>.
allowed-tools: Bash(vcut:*), Bash(npx @crafter/vcut:*)
---

# vcut core

Find what is worth cutting, propose it, and let a human approve before anything is rendered.

This document is the part every edit needs. The reasoning behind each command — why a
threshold is what it is, what eleven runs taught, how a fused retake defeats a window loop —
lives in sections you load when the question comes up:

```bash
vcut skills list                          # every section, with what it answers
vcut skills get core --section cut        # one section, on its own
```

Loading this file is not loading the manual. It is loading the workflow and the index to the
rest, which is roughly a fifth of what the whole document costs. A two-minute clip should not
pay for the eleven-runs appendix.

## The session is the workflow

**Open a session, then work in refs.** Everything below is one flow, and it is the one to
reach for unless you know why you are not:

```bash
vcut open recording.mp4 --preset clean --lang es --transcript words.srt   # once
vcut peek recording.mp4 --ref b042                                        # what is really there
vcut cut recording.mp4 --refs b042..b044 --kind repetition --reason "..." # per finding
vcut commit recording.mp4 --output master.mp4 --campaign my-video         # builds + renders
vcut rounds recording.mp4 --diff                                          # what the round changed
```

`open` runs `detect` once, caches it, and numbers the speech blocks between the silences it
measured as **refs** — `b001`, `b002`, and so on, in time order. A ref names a block the way a
browser snapshot names an element: something later verbs point at instead of a raw millisecond
pair you retyped from another output. That is the whole reason the session exists. A cut named
by ref cannot land on the wrong words, because the span comes from a block the session already
measured rather than a number copied while looking at a different command's output.

`commit` builds the EDL and renders it in one call, `--audio-only` by default, and records the
round in the session so `rounds --diff` can answer "what changed" without you diffing two
transcripts by hand.

### Every finding reaches the session, whatever coordinate system it arrived in

This is the part that used to be missing, and its absence is why an agent with the whole manual
in context still built EDLs by hand: a finding born in milliseconds had no path into refs, so
the stateless pipeline won by default. It has one now, and there is no finding that cannot enter
a session.

| The finding came from | It carries | Feed it to |
|---|---|---|
| `semantic export` (a transcript line) | `nearestRef` on every line | `vcut cut <media> --refs <nearestRef>` |
| `say`, `silences`, `peek` (a raw position) | `atMs`, `startMs`, `endMs` | `vcut cut <media> --start-ms <n> --end-ms <n>` |
| `open` / `suspects` (a ranked position) | `nearestRef` per suspect | `vcut cut <media> --refs <ref>` |
| `nonspeech --verify` (a classifier span) | master-time `startMs`/`endMs` | map through the EDL, then `--start-ms`/`--end-ms` |
| a boundary no ref's edges reach | seconds you measured | `vcut cut <media> --span <startS>..<endS>` |

`--start-ms`/`--end-ms` takes the same milliseconds `say`, `silences`, and `semantic export`
already emit — no seconds conversion, no arithmetic. It is not a lesser input than `--refs`: a
cut proposed either way accumulates in the same `proposals.json`, shows up the same in
`rounds --diff`, and gets its `removedText` quoted back the same at propose time.

So the choice of workflow is never decided by which coordinate system a finding happens to be
in. Every one of them ends at `vcut cut`.

Pick the grain by the defect, not by preference: refs are block-grain, right when the cut is a
whole silence-bounded block (dead air, a fumble between pauses); `--start-ms/--end-ms` is
word-grain, right when the cut lives inside a block (a retake mid-sentence, a filler between
words). Both are first-class. A run whose defects are mostly mid-block retakes will correctly
use ms for nearly every cut, and that is the design working, not the session flow failing.

### Do not read `~/.vcut/sessions/` directly

The session directory is not an interface. Reading `detect.json`, `refs.json`, or
`proposals.json` out of it and working from the raw contents is unsupported, and it costs you
the thing the session is for: the verbs check `gen`, resolve stale refs by name, take the
advisory lock, patch the cached transcript path to one that still resolves, and quote
`removedText` from the session's own transcript. A hand-read of those files does none of that,
and the layout is free to change between releases precisely because the verbs are the contract.

If a verb does not answer a question you have about a session, that is worth an issue, not a
`cat`.

## The escape hatch: the stateless pipeline

**When you actually need this:** a one-off cut with no second round, or a script driving vcut
with no long-lived working directory.

```bash
vcut detect recording.mp4 --preset clean --lang es --transcript words.srt
vcut semantic export --detect detect.json          # write proposals.json yourself
vcut edl build --detect detect.json --semantic proposals.json --output cut-1.mp4 --campaign x
vcut render --edl edl.json --audio-only --output cut-1.wav
```

It is the layer underneath the session verbs, not a separate procedure — `cut`/`commit` call
the exact same build seam. What it costs you is everything the session tracks: you number
`edl-$N.json`/`cut-$N.wav` by hand, retype `--detect`/`--semantic` per round, hand-edit a
proposals file, and get no `rounds --diff`. On a multi-round edit that adds up to the friction
the session verbs exist to remove, which is why this is the exception and not the default.

Full detail: `vcut skills get core --section workflow`.

## The round, and why one is never enough

A round is: propose, build, render `--audio-only`, transcribe that render, `semantic review`,
read, propose again. Anything short of the full sequence does not count as one, because the
reading is the part that finds things.

**Never stop at one round.** Each class of defect only becomes visible once the one before it
is gone, so the empty round has to come *after* a round that found something — it reads a text
the previous round produced and nobody has seen. Four runs on one recording separate cleanly on
this and nothing else: the three that stopped at one shipped a repetition, and the shortest of
them cut 33.78% while declaring itself done, against 44.04% for the run made to keep going.
That run found the largest cut in the file, a three-attempt retake, in round two, on material
round one had already declared clean.

Stop when a round proposes nothing, not when the removal percentage looks respectable and not
when the rounds start finding less. Diminishing returns is what convergence looks like from the
inside, one round before the end, every time.

The exception is the empty round that ends the loop, and only when the round before it proposed
nothing either: an unchanged file re-rendered and re-transcribed to confirm it is unchanged
buys nothing.

**This is enforced, not just stated (#36).** Below two committed rounds, `commit`'s `next`
hints and `rounds`'s summary refuse the converged framing and name the missing pass instead of
suggesting approval — `roundsGate.status: 'insufficient-rounds'` in both. **The second
committed round must contain a real propose pass against this round's render transcript;
verification of round 1's own output does not count.** `--single-round` on `commit` is the
deliberate override for a genuine one-round edit (a trivial clip), recorded in the session, not
inferred from a clean-looking run. Preview renders and the human approval boundary are
untouched by this — it is a framing gate on what the CLI calls "done," not a lock on rendering.

**`commit` also checks for standing spoken edit markers, without waiting for `semantic review`
(#38).** A finding class that only lives inside a verb the loop never forces to run is optional
by construction: a run committed four gated rounds through `open`/`cut`/`commit` and never
invoked `review` once, and shipped the same spoken rewind marker two prior runs had already
caught. `commit` now runs the same `metaSpeech` check itself, on every round that has a cached
transcript, and folds the result into its own JSON (`metaSpeech`, always present, `[]` when
clean) and `--human` output — the one artefact a run reads in full every round, unprompted. A
round with standing findings gets a hint naming them first, ahead of every other next step. It
never auto-cuts and never blocks a render; the human decision boundary is unchanged. Detail:
`vcut skills get core --section commit`, `--section semantic`.

Method, invariants, and the full stopping condition:
`vcut skills get core --section rounds-methodology`, `--section invariants`.

## Four facts that save a round each

**Verify on the audio-only render; mux video once, at the end.** `commit` defaults to
`--audio-only` and `render --audio-only` is the standalone equivalent. `audit` correlates
waveforms and `nonspeech --verify` classifies audio — neither reads a frame, so both take the
`.wav` directly, same as `joins`. Measured on one 22-segment EDL: 0.25s against 31.8s for the
same cuts. One run spent 69 of its 105 seconds of tool time on two video renders, the second
purely to feed checks that never needed a frame.

```bash
vcut render --edl edl.json --audio-only          # rounds 1..n
vcut audit --edl edl.json --render cut.wav
vcut nonspeech cut.wav --verify
vcut joins --edl edl.json --render cut.wav --report report.json
```

**`render` blocks, so never write a poll loop.** It runs in the foreground until ffmpeg exits
and prints a progress line to stderr per report. There is nothing to poll a file for and
nothing to grep a process table for; when the command returns, the render is done. `--quiet`
drops the progress lines and renders the same file.

Know the cost before you call it: a video render runs roughly real time per minute of source
— a 10-minute source is a multi-minute foreground call — while `--audio-only` is near instant.
If your harness caps tool calls at a default timeout, raise the timeout for that one call
instead of backgrounding it. One run read this exact rule, hit a 180-second default timeout on
a 9-minute render, and spiraled into the poll-loop behavior the rule forbids; a 600-second
timeout on the same call finishes in the foreground with no ceremony.

**`--jq <expr>` filters and reshapes, so never reach for `python3 -c`.** `--fields` projects to
dot paths; `--jq` does the structural work — filter a `nonspeech` list to the
`vocalization-suspect` spans, sort by `startMs`, pull the spans past a position. Both imply
`--json` and are mutually exclusive. `vcut --help` carries the supported subset.

The habit this exists to break, measured: one run wrote `python3 -c` forty-five times and used
`--jq` once, and its own retro found no missing operation — pure habit. The rule: if the JSON
came out of a vcut command, the filter goes on that same command as `--jq`, not on a file you
saved and re-parsed. Piping to a file first is how vcut output stops looking like vcut output.
Python is for what genuinely is not vcut JSON (an SRT is text, not JSON), nothing else.

```bash
vcut nonspeech cut.wav --verify --jq '.spans[] | select(.reading == "vocalization-suspect")'
```

**`say --transcribe --words` measures a word boundary, so never bisect one by hand.** When the
transcript and a re-transcribed window disagree about where a word starts — a fused region, a
retake's near edge, any boundary worth doubting — that is the arbiter: it extracts exactly
`--at`..`--through`, re-transcribes it with word-level cues, and returns every word in absolute
source milliseconds, one transcription for the whole span. The alternative is what a run
actually did: six to eight `--transcribe` calls at shrinking windows, then raw `ffmpeg -ss/-t`
plus a fresh transcription to build its own ground truth, about a third of its budget for one
number. Shrinking a window does not converge on the answer, because a short window reads like a
clean start wherever you open it.

```bash
vcut say source.mp4 --transcribe --words --at 550.0 --through 553.0 --lang es
```

**`semantic merge` combines proposal files, so never merge JSON by hand.** Two rounds of
proposals, re-sorted by `startMs`, in one call:

```bash
vcut semantic merge round-1.json round-2.json --out proposals.json
```

**One `edl build` emits both formats.** `--report-json <path>` writes the full JSON report to
disk regardless of stdout mode, so `--human` on stdout and the report `joins --report` wants
come from the same run rather than a second build.

```bash
vcut edl build --detect detect.json --semantic proposals.json \
  --output cut.mp4 --campaign x --human --report-json report.json
```

## Human decision boundary

vcut proposes. The human decides.

| vcut may propose | The human decides |
| --- | --- |
| silence cuts | delivery quality |
| review candidates | semantic changes |
| crop options | acceptable jump cuts |
| | which mistakes stay human |

**There is no approve command, and that is the design.** Approval means editing the EDL: set
`approval.status` to `"approved"` and each segment's `approval` to `"approved"`. No CLI verb
does this, because a verb would be a thing an agent can call, and this is the one step that must
not be automatable. **Never make that edit on the human's behalf**, not even when they say the
preview looks good: hand them the path and let them do it, or ask them to say explicitly that
they want you to write it. Everything before this point is reversible; this is what makes a
master.

`commit` only ever drafts and previews — it does not write approval and does not accept
`--mode master`. Never render a master without explicit approval. Never overwrite source media.
`session gc` never runs on its own, and `--apply` is required even then.

## Presets

Presets carry thresholds proven in production. Do not invent new ones.

| Preset | Threshold | Use |
| --- | --- | --- |
| `noisy` (default) | -20 dB | Events, ambient noise |
| `clean` | -30 dB | Studio, talking head |
| `podcast` | -35 dB | Intentional pauses |

When the recording matches a row, use it. When it does not, **start at `clean`** and let the
numbers move you: most speech recorded on purpose sits closer to a room than to an event, and
being one step too conservative costs a round while being too aggressive costs syllables. Read
the removal percentage against the target for the content type, then change the preset rather
than `--min-silence` or `--margin`, and rebuild.

| Content | Expected removal |
| --- | --- |
| Event or interview | 30-45% |
| Tutorial or screencast | 15-25% |
| Scripted talking head | 10-20% |

**Word clamping needs word-level timestamps**, one cue per word, from a large model, asked for
a verbatim transcript. A sentence-level SRT turns clamping off. Getting this wrong is not an
error, it is a worse cut:

```bash
trx transcribe <input> --words --language es --preset verbatim -m large-v3-turbo
```

Why each of those flags is load-bearing, and the two warnings `detect` prints about transcript
drift: `vcut skills get core --section detect`.

**`detect` does not look for filler words, and that is deliberate.** A word list cannot tell
filler from ordinary use and never survives a new language. Fillers are the model's job, through
`vcut semantic`, with `kind: "filler"` in the proposal schema.

## Output contract

Every command writes data to stdout and diagnostics to stderr. JSON is emitted automatically
when stdout is not a TTY, so an agent never needs `--json`. Exit code 2 means the invocation was
wrong, 1 means the run failed.

**Positions are seconds, everywhere.** `--at`, `--from`, `--source`, `--master` all take
seconds; the JSON that comes back speaks milliseconds. The one deliberate exception is
`cut --start-ms/--end-ms`, which takes the milliseconds those JSON outputs emit so a finding
needs no conversion to become a proposal.

**Four resolutions on the same run, never four truths.** `--human` reads in a few lines what the
JSON answers in a few hundred. `--fields <a.b,c,d>` projects to exactly the dot paths you name.
`--jq <expr>` filters and reshapes. Full JSON when you need everything.

**Ask about several positions at once.** `locate --sources 20,53.86,61.2`,
`say --positions 19.5,30.0,41.9`, and `say --at X --through Y` each answer in one call what was
being built out of shell loops with a JSON parser inside.

**Every JSON output carries `vcutVersion`.** The manual is read once and cached in an agent's
context while the CLI can change underneath it. A version you do not recognise is a reason to
run `vcut --help` again rather than trust what you read earlier in the session.

**Selected outputs carry `next`**: a short array of `{question, verb}` with real values filled
in. A hint, not an instruction.

Run `vcut schema <name>` for the field-by-field contract instead of parsing `--help`.

## Which instrument answers which question

| Question | Verb |
|---|---|
| What is the map of this recording, cached across calls? | `open <media>` |
| What is really at a position — transcript, audio, blocks, level, aligned? | `peek <media> (--ref <ref> \| --at <s>)` |
| Propose a cut against a session and see what it removes? | `cut <media> --refs\|--start-ms/--end-ms\|--span` |
| Build and render everything a session has accumulated? | `commit <media> --output <path> --campaign <id>` |
| What changed between two committed rounds? | `rounds <media> --diff` |
| Where should I look first in a long file? | `suspects --detect detect.json` |
| What in this file is worth cutting? | `detect <input>` |
| What is said at a position, from the existing transcript? | `say --transcript ... --at <s>` |
| What is actually said there, when the transcript may have averaged it away? | `say --transcribe --at <s>` |
| Where exactly does a word start, when those two disagree? | `say --transcribe --words --at <a> --through <b>` |
| Where exactly, at sub-second resolution, does a boundary belong? | `silences <media> --from <s> --to <s> --min 0.08` |
| Where does a retake's boundary really fall? | `converge --phrase "..." --from <s>` |
| Where does the telling I am keeping start (a retake's near edge)? | `say --transcribe --words` over `converge`'s two edges |
| What audible sound does the transcript not see at all? | `nonspeech <render> --verify` |
| What text is a semantic span about to remove? | `cut` at propose time, or `edl build` → `semanticCuts[].removedText` |
| Did every semantic cut's join land clean, in one call? | `joins --edl <path> --render <path>` |
| Did the render carry the wrong material at a join? | `audit --edl <path> --render <path>` |
| Where in the master does a source position land, or the reverse? | `locate --master <s>` / `locate --source <s>` |
| Did a proposed cut survive into the render? | `semantic review`, then `semantic check --review` |
| Combine two rounds of proposals into one file? | `semantic merge a.json b.json --out <path>` |
| What sessions exist, how big are they, which are stale? | `session list`, `session gc` |
| Is the cut ready to watch or ship? | `render --mode preview`, `--mode master` only after approval |
| Is this machine ready to run vcut at all? | `doctor`, or `init` on a new machine |
| What is the field-by-field shape of a command's output? | `schema <name>` |

## Sections

Load one when the question comes up. `vcut skills list` prints this table from the installed
version.

| Section | Read it when |
|---|---|
| `workflow` | running a whole edit end to end, including the stateless path in full |
| `rounds-methodology` | working a round: what to read, how to widen a span, when a boundary lies |
| `invariants` | deciding whether the edit is done |
| `how-hard-to-cut` | deciding whether a cut is worth making |
| `semantic` | writing proposals against the exported lines |
| `muletillas` | a filler is audible in the render and invisible in every transcript |
| `classifier` | wondering why non-speech needs a model and not a statistic |
| `eleven-runs` | about to run this for the first time — 7 habits, four failures |
| `detect` | picking a preset, or reading a drift warning |
| `open` | refs, `gen`, and what a session caches |
| `peek` | four views of a position and `viewsDisagree` |
| `cut` | ref ranges, `--start-ms`, `--span`, `--list`/`--drop`, `--literal` for a verified boundary |
| `commit` | what a commit builds, renders, and records |
| `rounds` | comparing two committed rounds |
| `session` | the store, `gc`, and the advisory lock |
| `edl-build` | `removedText`, `driftSuspect`, boundary warnings, `--crop` |
| `render` | audio-only, progress, loudness, reproducibility |
| `silences` | placing a boundary at sub-second resolution |
| `suspects` | where to look first in a long file |
| `say` | reading versus re-transcribing a position |
| `converge` | finding where a repeated phrase stops coming back |
| `joins` | verifying every semantic join after a render |
| `audit` | checking a render carried the material the EDL named |
| `locate` | translating between master time and source time |
| `nonspeech` | the classifier, `--verify`, and its readings |
| `limits` | what vcut refuses to do |

## When something comes out wrong

```bash
vcut skills get debug
```

Read it before diagnosing a render that sounds off, a word that seems cut in half, dead air that
survived a cut, or a transcript whose positions do not match the audio. Every method in it is
cheap; none of them is the obvious one. It exists because for each of those questions there is a
more rigorous-looking instrument that cannot tell the hypotheses apart, and reaching for it is
how confident wrong answers get written down.
