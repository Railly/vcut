/**
 * `vcut commit <media> --output <master.mp4> --campaign <id>` — build the EDL from a session's
 * cached detect and accumulated proposals, then render it.
 *
 * The build side calls straight through `runBuild` (build-edl.ts), the same seam
 * `buildEdlCommand` uses: this produces the identical draft EDL `vcut edl build --detect
 * <cached> --semantic <path>` would from the equivalent detect report and proposals file. There
 * is no second implementation of the merge/clamp/invert pipeline here, so there is nothing in
 * this file that could drift from what the standalone command does.
 *
 * The EDL is written to the CURRENT DIRECTORY by default (`./edl.json`), not inside the
 * session: the session is disposable cache and the EDL is the artefact a human approves, per
 * the shape's B6 note and the spike's B2-Q2 answer ("the EDL a human approves lives where they
 * wrote it, not inside a session directory session gc can clear").
 *
 * Rendering defaults to `--audio-only`, matching the manual's own stance that a round renders
 * audio and the picture renders once at the end. `--video` renders the preview instead.
 * **Master mode never happens here.** Approval is a human edit to the EDL followed by the
 * existing `vcut render --mode master` — this command does not touch that boundary, and the
 * help text says so rather than leaving it implicit.
 *
 * `rounds/round-N/` records the EDL copy and the build report inside the session, so a session
 * carries its own history of what was proposed and what was built from it. Renders and wavs
 * stay out of the session (B2-Q2: cheap to regenerate, expensive to store).
 *
 * Takes the session's advisory lock (B-V4, B7-Q1) for the whole build+write+render, released
 * in a finally. A successful commit also marks the session `committed`, the spike's B7-Q2
 * signal that `session gc` may now consider this session a candidate — never that anything
 * deletes it automatically.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'

import { type AutoCut, type AutoCutReport, runAutoCut } from './auto-cut.ts'
import { type BuildOptions, type Crop, parseCrop, runBuild } from './build-edl.ts'
import { findSurvivingDeadAir, type SurvivingDeadAirReport } from './dead-air.ts'
import type { CliOptions as DetectOptions, DetectReport, Preset } from './detect.ts'
import { parseSrt, runDetect } from './detect.ts'
import { has } from './has.ts'
import { masterToSource, type Placement, placements, sourceToMaster } from './locate.ts'
import { type Span as AutoSpan, classifierMissing, runClassifier } from './nonspeech.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import { type Edl, type RenderOptions, runRender } from './render-edl.ts'
import { deltaSpans } from './rounds.ts'
import {
  acknowledgeSingleRound,
  evaluateRoundsGate,
  type ListenerFindings,
  type RoundsGate,
} from './rounds-gate.ts'
import {
  buildLines,
  gapsBetween,
  joinWords,
  LINE_BREAK_MS,
  type MetaSpeechSpan,
  metaSpeech,
  type Proposal,
} from './semantic.ts'
import {
  acquireLock,
  cachedDetect,
  checkSession,
  deriveRefs,
  type ListenerRecord,
  listRoundNumbers,
  markCommitted,
  nextRoundDir,
  openSession,
  pointCachedTranscriptAtSession,
  readListener,
  readProposalsFile,
  readRound,
  releaseLock,
  writeAutoCut,
  writeCachedDetect,
  writeDeadAir,
  writeListener,
  writeMetaSpeech,
  writeRound,
} from './session.ts'
import { skillsDir } from './skills-dir.ts'
import { defaultConcurrency, runVerifyWindows, type VerifyWindowsReport } from './verify.ts'

const HELP = `vcut commit - build the EDL from a session's proposals, then render it

Usage:
  vcut commit <media> --output <master path> --campaign <id> [flags]

Flags:
  --output <path>       Where the eventual master will go (required, names the master, not
                        this render)
  --campaign <id>       Campaign identifier, required, rides into the EDL
  --edl <path>          Where to write the EDL (default ./edl.json — the current directory,
                        not the session: this is the user's artefact)
  --audio-only          Render audio, .wav next to the EDL (default)
  --video               Render the preview video instead of audio-only
  --fps <n>             Passed through to edl build
  --width <n>           Passed through to edl build
  --height <n>          Passed through to edl build
  --edge-fade <ms>      Passed through to edl build (default 50)
  --crop <spec>         Passed through to edl build
  --single-round        Deliberate override for a genuine one-round edit (a trivial clip).
                        Without it, a commit that leaves the session with fewer than 2 committed
                        rounds refuses the converged framing and names the missing pass. Recorded
                        in the session, never a default.
  --json / --human      Output mode
  --help                Show this message

Builds from this session's cached detect report and its accumulated proposals.json (from
'vcut cut'), byte-identical to running 'vcut edl build --detect <cached> --semantic <path>' by
hand on the same inputs. Records the round in the session (rounds/round-N/: the EDL copy and
the build report) but never stores the render itself there.

**Fewer than 2 committed rounds refuses the converged framing.** The manual's own rule — never
stop at one round, the empty round that ends the loop must be a real propose pass against the
previous round's render, not a re-check of round 1's own output — used to be prose an agent
could read, agree with, and violate on a clean-looking first pass. This commit's own 'next'
hints and 'roundsGate.status' say 'insufficient-rounds' instead of a next step that reads like
polish, until a second committed round exists. '--single-round' is the deliberate escape hatch
for the genuine one-round case, and it is recorded in the session (single-round-ack.json), not
inferred from a good-looking run.

**Runs the 'verify --windows' listener sweep over its own render, every round, no flag.** A
whole-file transcript averages: a model reading ninety seconds collapses two attempts at the same
line into the one likelier sentence, so reading the render's transcript end to end catches
content that stopped making sense but never content that makes sense twice. The sweep re-listens
in sixteen-second windows, which return both. Every finding quotes the offending phrase, and
'roundsGate.status' holds at 'repeated-phrases-unresolved' while any of them stands, no matter
how many rounds are committed; '--single-round' does not waive it.

The sweep costs roughly 1 second per 5 seconds of render at the default concurrency. Round 1
sweeps the whole render; from round 2 on only the spans that round changed are re-transcribed,
and the previous round's findings carry forward for everything else. Re-sweep whole at any time
with 'vcut verify --windows <render> --lang <code>'. With trx not installed, the sweep reports
that it did not run ('listenerChecked': false) rather than failing the commit.

Master mode never happens here. Approving the EDL is a human edit — set approval.status and
each segment's approval to "approved" — followed by the existing
'vcut render --edl <path> --mode master'. This command only ever drafts and previews.

Takes the session's advisory lock for the build+render, released after. A session already
locked by another live process fails with an error naming its pid, verb, and age. On success
the session is marked committed, which is what 'vcut session gc' reads as a candidate to
clear — never something this command deletes itself.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const BOOLEAN_FLAGS = new Set([
  '--json',
  '--human',
  '--help',
  '--audio-only',
  '--video',
  '--single-round',
])

const positional = (args: string[]): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('--')) {
      continue
    }
    const previous = args[index - 1]
    if (previous?.startsWith('--') && !BOOLEAN_FLAGS.has(previous)) {
      continue
    }
    return arg
  }
  return undefined
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const numericFlag = (argv: string[], name: string): number | null => {
  const raw = flagValue(argv, name)
  if (raw === undefined) {
    return null
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`${name} expects a number, got ${raw}`)
  }
  return value
}

const DEFAULT_EDGE_FADE_MS = 50

// The same width and stride `verify --windows` itself defaults to (DEFAULT_WINDOW_S, and #58's
// half-window stride), not a second set of numbers commit picks for itself: a sweep run here and
// a sweep a caller runs by hand with `vcut verify --windows <render>` have to be able to find the
// same things, and two different window geometries over the same audio do not.
const SWEEP_WINDOW_MS = 16_000
const SWEEP_STRIDE_MS = 8_000

type Segment = Edl['segments'][number]

type CommitArgs = {
  media: string
  outputPath: string
  campaignId: string
  edlPath: string
  audioOnly: boolean
  width: number | null
  height: number | null
  fps: number | null
  edgeFadeMs: number
  crop: Crop | null
  singleRound: boolean
}

const parseArgs = (argv: string[]): CommitArgs => {
  const media = positional(argv)
  const outputPath = flagValue(argv, '--output')
  const campaignId = flagValue(argv, '--campaign')
  if (media === undefined || outputPath === undefined || campaignId === undefined) {
    throw new UsageError(HELP)
  }
  if (argv.includes('--audio-only') && argv.includes('--video')) {
    throw new UsageError('--audio-only and --video are mutually exclusive')
  }
  const cropArg = flagValue(argv, '--crop')
  return {
    media: resolve(media),
    outputPath: resolve(outputPath),
    campaignId,
    // The current directory, not the session: the EDL is the user's artefact.
    edlPath: resolve(flagValue(argv, '--edl') ?? 'edl.json'),
    audioOnly: !argv.includes('--video'),
    width: numericFlag(argv, '--width'),
    height: numericFlag(argv, '--height'),
    fps: numericFlag(argv, '--fps'),
    edgeFadeMs: numericFlag(argv, '--edge-fade') ?? DEFAULT_EDGE_FADE_MS,
    crop: cropArg === undefined ? null : parseCrop(cropArg),
    singleRound: argv.includes('--single-round'),
  }
}

/**
 * Hints for a session that has cleared the rounds floor (>= 2 committed rounds, or an
 * acknowledged single round). This is the only case in which "approve" belongs in the list — a
 * round that has not cleared the floor gets `roundsGate.next` instead (see rounds-gate.ts),
 * which points at another propose pass, not at approval.
 */
export const commitNext = (
  edlPath: string,
  renderPath: string,
): Array<{ question: string; verb: string }> => [
  {
    question: 'hear what survived',
    verb: `trx transcribe ${renderPath} --words`,
  },
  {
    question: 'fold review findings back in',
    verb: `vcut semantic review --edl ${edlPath} --detect <detect path> --master ${renderPath} --master-transcript <the .srt trx wrote>`,
  },
  {
    question: 'approve when the transcript reads clean (human edit, not a command)',
    verb: `vcut render --edl ${edlPath} --mode master`,
  },
]

/**
 * #38: standing metaSpeech findings go first, ahead of every other hint — including the rounds
 * gate's own — because a run that reads hint[0] and stops is exactly the failure #38 exists for.
 * `commitNext`/the gate's own hints follow, unchanged, once this is non-empty or there is nothing
 * to name.
 */
export const metaSpeechNext = (
  findings: MetaSpeechSpan[],
): Array<{ question: string; verb: string }> =>
  findings.length === 0
    ? []
    : [
        {
          question: `${findings.length} metaSpeech span${findings.length === 1 ? '' : 's'} not cut; read each and cut it or name why it stays`,
          verb: 'read the metaSpeech field above, then vcut cut <media> --start-ms <n> --end-ms <n> --kind filler --reason "..." per span you are removing',
        },
      ]

/**
 * The metaSpeech pass this round: lines rebuilt from the session's own cached transcript, the
 * same way `semantic review` builds them, checked against the gaps this EDL's own segments leave
 * (`gapsBetween`) — the spans already cut by any proposal this round, silence or semantic alike.
 * `null` when the report carries no usable transcript: metaSpeech needs word-level text to find a
 * marker in, and a session opened without one has nothing to check, the same "cannot answer" the
 * rest of the pipeline already gives a report with no transcript path.
 */
export const metaSpeechForRound = (
  report: DetectReport,
  segments: Array<{ inMs: number; outMs: number }>,
): MetaSpeechSpan[] | null => {
  if (report.transcript.path === null || !existsSync(report.transcript.path)) {
    return null
  }
  const transcript = parseSrt(readFileSync(report.transcript.path, 'utf8'))
  const lines = buildLines(joinWords(transcript), report.silences, LINE_BREAK_MS)
  const cuts = gapsBetween(
    segments.map((segment) => ({ startMs: segment.inMs, endMs: segment.outMs })),
  )
  const blocks = deriveRefs(report.silences, report.durationMs)
  return metaSpeech(lines, cuts, blocks, report.lang)
}

/**
 * #43: surviving-dead-air findings go first, ahead of metaSpeech and the rounds gate. Dead air
 * is this tool's founding target, and the forensics that opened #43 are a 19.9s silence that
 * sailed through joins, audit, and nonspeech into a converged preview because none of them
 * measured the render's own audio. `metaSpeechNext`/`commitNext` follow, unchanged.
 */
export const deadAirNext = (
  report: SurvivingDeadAirReport,
): Array<{ question: string; verb: string }> =>
  report.pauses.length === 0
    ? []
    : [
        {
          question: `${report.pauses.length} pause${report.pauses.length === 1 ? '' : 's'} over ${report.minSilenceMs / 1000}s survived in the render; read each and cut it or name why it stays`,
          // `cut`'s --kind is a fixed set (false-start/repetition/tangent/filler), none of them
          // "silence". A surviving pause the fixed detect preset kept as speech is proposed the
          // same way any other manual removal is, as filler.
          verb: 'read the deadAir field above, then vcut cut <media> --start-ms <n> --end-ms <n> --kind filler --reason "..." per pause you are removing',
        },
      ]

/**
 * #44: standing repeated-phrase findings go first, ahead of dead air, metaSpeech, and the rounds
 * gate. This is the only finding class that also holds the gate at `repeated-phrases-unresolved`,
 * so a run that reads `next[0]` and stops reads the thing that is actually blocking it. The hint
 * quotes the phrases rather than counting them, for the same reason the gate's message does.
 */
export const listenerNext = (
  report: VerifyWindowsReport | null,
): Array<{ question: string; verb: string }> => {
  if (report === null || report.repeatedPhrases.length === 0) {
    return []
  }
  const count = report.repeatedPhrases.length
  const quoted = report.repeatedPhrases
    .slice(0, 3)
    .map((entry) => `"${entry.phrase}"`)
    .join(', ')
  const rest = count > 3 ? ` and ${count - 3} more` : ''
  return [
    {
      question: `${count} repeated phrase${count === 1 ? '' : 's'} still in the render: ${quoted}${rest}; cut each or name why it stays`,
      verb: 'read the listener field above, then vcut cut <media> --start-ms <n> --end-ms <n> --kind repetition --reason "..." per repeat you are removing',
    },
  ]
}

/**
 * The listener sweep for this round, and the cost decision that shapes it.
 *
 * The sweep is expensive in a way nothing else `commit` runs is: it re-transcribes the render in
 * overlapping windows, one whisper process per concurrent window. Measured on the render that
 * opened this issue (358s, 2026-08-13, this machine, concurrency 4): 44 windows, 66s wall,
 * against roughly 25s for the audio-only render of the same material. Sweeping the whole render
 * every round would roughly triple what a round costs in wall clock.
 *
 * It runs anyway, on every commit, because the alternative is the defect. Making it conditional
 * on a flag, or on the caller being "about to consult the gate", puts it back off the mandatory
 * path, and off-the-path capability is the exact thing this issue exists to fix for the fifth
 * measured time. There is also no "about to consult the gate" moment to hang it on: `commit`
 * evaluates and emits the gate on every single call.
 *
 * What is negotiable is how much audio it sweeps, and #46's delta verification already answers
 * that with the right question. From round 2 on, a render's untouched spans are byte-identical to
 * material the previous round's sweep already read; re-transcribing them buys a second identical
 * answer. So a round with a previous round to diff against sweeps only `deltaSpans` (every
 * segment whose source-time signature is new, plus the neighbours of every new join, each widened
 * by one window so a repeat straddling the edge of a change is still inside a window that holds
 * both of its occurrences), and carries the previous round's findings forward for everything
 * outside those spans. Round 1 has nothing to carry and sweeps whole.
 *
 * The carry-forward is what keeps this honest rather than a discount. A phrase found in round 1
 * and not cut in round 2 is still reported by round 2, still quoted, and still holds the gate,
 * because the delta says its audio never changed and a finding over unchanged audio does not
 * expire by being ignored for a round. What a delta sweep can be wrong about is narrow and
 * stated: a repeat whose two occurrences both sit in untouched audio that the earlier full sweep's
 * window alignment split between two windows. The full sweep every round-1 pays for, plus the
 * one-window widening here, is the answer to that; `vcut verify --windows <render>` re-sweeps
 * whole at any time and the gate's own message names that command.
 */
export const sweepForRound = async (
  renderPath: string,
  lang: string | undefined,
  previous: { round: number; segments: Segment[]; record: ListenerRecord | null } | null,
  current: Segment[],
): Promise<{ record: ListenerRecord; report: VerifyWindowsReport } | null> => {
  // The sweep is the one check `commit` runs that needs a binary vcut does not ship. Everything
  // else here shells to ffmpeg, which the tool already refuses to run without; `trx` is a
  // separate install, and a machine that has never had it would otherwise find that `commit`
  // itself stopped working the round this shipped. A missing transcriber reports "the sweep did
  // not run" (`listenerChecked: false`, and a gate that does not claim to have cleared anything)
  // rather than either failing the commit or, far worse, reporting a clean sweep that never ran.
  if ((await has('trx', ['--version'])) === false) {
    return null
  }
  const concurrency = defaultConcurrency()
  if (previous === null || previous.record === null) {
    const report = await runVerifyWindows(
      renderPath,
      SWEEP_WINDOW_MS,
      SWEEP_STRIDE_MS,
      lang,
      concurrency,
      undefined,
    )
    return { record: { scope: 'full', carriedFrom: null, report }, report }
  }

  const spans = deltaSpans(previous.segments, current).map((span) => ({
    startMs: span.masterInMs,
    endMs: span.masterOutMs,
  }))
  const swept = await runVerifyWindows(
    renderPath,
    SWEEP_WINDOW_MS,
    SWEEP_STRIDE_MS,
    lang,
    concurrency,
    undefined,
    spans,
  )
  const report = carryForward(swept, previous.record.report, spans, previous.segments, current)
  return {
    record: {
      scope: 'delta',
      carriedFrom: previous.record.scope === 'full' ? previous.round : previous.record.carriedFrom,
      report,
    },
    report,
  }
}

/**
 * Where a finding from the previous round's render lands in this round's render, or null if that
 * audio is gone.
 *
 * Two rounds' master timelines are not the same coordinate system, and this is the trap #46's own
 * header already names: "a cut anywhere shifts every later segment's master position". A finding
 * recorded at 216000ms of round N's render sits somewhere else entirely in round N+1's render if
 * anything before it was cut, so comparing round N's window timestamps against round N+1's master
 * spans directly compares two different timelines and silently misplaces every finding past the
 * first cut.
 *
 * Source time is the shared frame both rounds agree on, so the translation goes through it:
 * previous master to source (through the previous round's own placements), source to current
 * master (through this round's). A position whose source no longer survives into this round was
 * cut, which is the honest answer to "is this finding still standing" and the reason the miss is
 * reported as null rather than clamped to a neighbour.
 */
const relocate = (
  masterMs: number,
  previousMap: Placement[],
  currentMap: Placement[],
): number | null => {
  const source = masterToSource(previousMap, masterMs)
  if (source === null) {
    return null
  }
  const current = sourceToMaster(currentMap, source.sourceMs)
  return current === null ? null : current.masterMs
}

/**
 * This round's own sweep, plus everything the previous round found over audio this round did not
 * re-listen to.
 *
 * A finding whose window overlaps a swept span was re-asked this round and its fresh answer wins:
 * cut it and it is gone, leave it and this round found it again. A finding outside every swept
 * span sits over audio this round did not touch, so the previous round's answer is still the
 * current one, and dropping it would let a defect expire by being ignored for a round. Its
 * timestamps are rewritten into this round's master timeline on the way through (see `relocate`),
 * so a carried finding still points at the audio it is about rather than at wherever that
 * timestamp happens to fall now. A finding whose audio did not survive this round is dropped,
 * because it was cut, which is exactly the outcome the round was for.
 */
export const carryForward = (
  swept: VerifyWindowsReport,
  previous: VerifyWindowsReport,
  spans: Array<{ startMs: number; endMs: number }>,
  previousSegments: Segment[],
  currentSegments: Segment[],
): VerifyWindowsReport => {
  const previousMap = placements({ segments: previousSegments } as Edl)
  const currentMap = placements({ segments: currentSegments } as Edl)
  // One window of slack on each side, matching the widening `spanWindows` applies to the same
  // spans: a finding whose window merely touches the material this round re-listened to was
  // covered by that listen, and carrying it forward on top of the fresh answer would report the
  // same repeat twice.
  const inSweptSpan = (startMs: number, endMs: number): boolean =>
    spans.some(
      (span) => startMs < span.endMs + SWEEP_WINDOW_MS && span.startMs - SWEEP_WINDOW_MS < endMs,
    )

  const carry = <T extends { windowStartMs: number; windowEndMs: number }>(entries: T[]): T[] => {
    const kept: T[] = []
    for (const entry of entries) {
      const startMs = relocate(entry.windowStartMs, previousMap, currentMap)
      if (startMs === null) {
        continue
      }
      if (inSweptSpan(startMs, startMs + (entry.windowEndMs - entry.windowStartMs))) {
        continue
      }
      kept.push({
        ...entry,
        windowStartMs: startMs,
        windowEndMs: startMs + (entry.windowEndMs - entry.windowStartMs),
      })
    }
    return kept
  }

  const byWindow = <T extends { windowStartMs: number }>(left: T, right: T): number =>
    left.windowStartMs - right.windowStartMs
  return {
    ...swept,
    repeatedPhrases: [...swept.repeatedPhrases, ...carry(previous.repeatedPhrases)].sort(byWindow),
    discountedRepeats: [...swept.discountedRepeats, ...carry(previous.discountedRepeats)].sort(
      byWindow,
    ),
    truncatedEdges: [...swept.truncatedEdges, ...carry(previous.truncatedEdges)].sort(byWindow),
  }
}

/**
 * The classifier's spans for a render, or none when it cannot run.
 *
 * Same optional-by-design stance `nonspeech` itself takes: an absent classifier is a supported
 * state that costs one finding class, never a failed commit. A classifier that runs and errors is
 * treated the same way here rather than thrown, because #63's pass is additive to a commit that
 * already worked without it.
 */
const classifierSpansFor = async (renderPath: string): Promise<AutoSpan[]> => {
  try {
    const scriptPath = join(skillsDir(), 'core', 'scripts', 'non-speech.py')
    if (!existsSync(scriptPath)) {
      return []
    }
    const outcome = await runClassifier(scriptPath, renderPath)
    return 'error' in outcome ? [] : outcome.spans
  } catch {
    return []
  }
}

/**
 * #63: the deterministic pass over the round's own render, and the translation back to source time.
 *
 * Everything the pass measures is measured on the RENDER (the classifier's spans, the silence
 * sweep, the repeat windows), so every span it emits is in master time. A proposal is in source
 * time, because that is the coordinate system `build-edl` cuts against. The translation goes
 * through the round's own placements, exactly the way `relocate` above already translates a
 * carried-forward finding, and for the same reason: master and source are different coordinate
 * systems and comparing them directly misplaces every span past the first cut.
 *
 * A master span is translated PER SEGMENT, not by its two endpoints, and that distinction is
 * load-bearing rather than defensive. A master cut can straddle a join, because the material the
 * previous rounds removed is not in the master's coordinate system at all; translating its start
 * and end independently then produces a source span that also swallows everything already cut
 * between them. Measured on this render: the 2.74s master cut at 52.80s spans segment-011 to
 * segment-013 and reads back as a 43.2s source span, and the 1.05s cut at 65.74s reads back as
 * 18.3s. Both would remove material the EDL deliberately kept. Intersecting the master span with
 * each placement it touches, and emitting one proposal per intersected segment, keeps every
 * emitted span inside a single continuous stretch of source, which is the only shape a source-time
 * cut can honestly take.
 *
 * A span whose master position no longer maps into the source is dropped rather than clamped. That
 * cannot normally happen for a span measured on this very render, and dropping is the honest
 * outcome if it ever does: an untranslatable span is one this pass cannot prove the position of,
 * and #63's whole premise is that only a provable span gets cut.
 */
export const autoCutProposals = (
  cuts: AutoCut[],
  map: Placement[],
): Array<Proposal & { removedText: string; proposedAt: string }> => {
  const proposals: Array<Proposal & { removedText: string; proposedAt: string }> = []
  const proposedAt = new Date().toISOString()
  for (const cut of cuts) {
    for (const placement of map) {
      const startMs = Math.max(cut.startMs, placement.masterInMs)
      const endMs = Math.min(cut.endMs, placement.masterOutMs)
      if (endMs <= startMs) {
        continue
      }
      const sourceInMs = placement.sourceInMs + (startMs - placement.masterInMs)
      const sourceOutMs = placement.sourceInMs + (endMs - placement.masterInMs)
      if (sourceOutMs <= sourceInMs) {
        continue
      }
      proposals.push({
        startMs: sourceInMs,
        endMs: sourceOutMs,
        kind: cut.kind,
        reason: cut.reason,
        // Quoted from nothing: this pass never reads cue text (#61), and the evidence a reader
        // needs is the measurement in `reason`, not a transcript quote that would be unverified
        // here.
        removedText: '',
        proposedAt,
      })
    }
  }
  return proposals
}

/**
 * #63: one warning-style hint whenever the deterministic pass cut anything, so a run reading the
 * output knows material was removed without it asking. Unlike every other hint here this is not a
 * request for the reader to act: the cuts are already in the EDL. It names what was removed and
 * on whose evidence, which is the traceability requirement the issue makes non-negotiable.
 */
export const autoCutNext = (
  report: AutoCutReport | null,
): Array<{ question: string; verb: string }> => {
  if (report === null || report.cuts.length === 0) {
    return []
  }
  const removedMs = report.cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0)
  return [
    {
      question: `${report.cuts.length} span${report.cuts.length === 1 ? '' : 's'} (${(removedMs / 1000).toFixed(1)}s) were cut automatically on measured evidence; read autoCut to see which instrument fired on each`,
      verb: 'read the autoCut field above; every cut names its instrument and the measurement it fired on',
    },
  ]
}

/** What the gate needs from a sweep: counts, and the phrases themselves. */
export const listenerFindings = (report: VerifyWindowsReport): ListenerFindings => ({
  repeatedPhrases: report.repeatedPhrases.length,
  truncatedEdges: report.truncatedEdges.length,
  phrases: report.repeatedPhrases.map((entry) => entry.phrase),
})

const humanReport = (
  edlPath: string,
  removalPercent: number,
  semanticCuts: Array<{
    startMs: number
    endMs: number
    kind: string
    removedText: string
    literal?: true
    driftSuspect?: true
  }>,
  render: { status: string; outputPath: string; sha256?: string; duration?: string },
  gate: RoundsGate,
  deadAir: SurvivingDeadAirReport,
  metaSpeechFindings: MetaSpeechSpan[] | null,
  listener: ListenerRecord | null,
  autoCut: AutoCutReport | null,
  hints: Array<{ question: string; verb: string }>,
): string => {
  const lines = [
    heading(`committed  ${edlPath}`),
    line('removalPercent', `${removalPercent.toFixed(1)}%`),
    line('semantic cuts', String(semanticCuts.length)),
  ]
  for (const cut of semanticCuts) {
    const removedLabel =
      cut.driftSuspect === true ? 'removedText (driftSuspect, unverified)' : 'removedText'
    lines.push(
      line(
        `  ${(cut.startMs / 1000).toFixed(2)}-${(cut.endMs / 1000).toFixed(2)}s`,
        `${cut.kind}${cut.literal === true ? ' (literal)' : ''}: ${removedLabel} = "${cut.removedText || '(no transcript)'}"`,
      ),
    )
  }
  lines.push(line('render', render.status))
  lines.push(line('output', render.outputPath))
  if (render.duration !== undefined) {
    lines.push(line('duration', `${render.duration}s`))
  }
  // #63: what the deterministic pass removed, with the instrument and measurement per span. This
  // is the only block here describing material that is already gone rather than a finding awaiting
  // a decision, so each line reads as a record rather than a request, and the measurement is
  // printed rather than summarised: a span removed automatically has to be traceable to its
  // evidence by reading this alone. autoCut is null (not printed) when the pass could not run.
  if (autoCut !== null && autoCut.cuts.length > 0) {
    const removedMs = autoCut.cuts.reduce((total, cut) => total + (cut.endMs - cut.startMs), 0)
    lines.push(
      line(
        'autoCut',
        `${autoCut.cuts.length} span${autoCut.cuts.length === 1 ? '' : 's'} cut automatically (${(removedMs / 1000).toFixed(1)}s), each on measured evidence`,
      ),
    )
    for (const cut of autoCut.cuts) {
      lines.push(
        line(
          `  ${(cut.startMs / 1000).toFixed(2)}-${(cut.endMs / 1000).toFixed(2)}s`,
          `${cut.instrument}: ${cut.measurement}`,
        ),
      )
    }
  }
  // #43: one warning-style line whenever this round's own render still carries silence over the
  // calibrated threshold, the check `joins`/`audit`/`nonspeech` never ran, on the one artefact
  // where it matters. deadAir.floor is null (not printed) when the render was too short to
  // calibrate a threshold against, distinct from a floor that ran and found nothing to flag.
  if (deadAir.floor !== null && deadAir.pauses.length > 0) {
    lines.push(
      line(
        'deadAir',
        `${deadAir.pauses.length} pause${deadAir.pauses.length === 1 ? '' : 's'} survived, floor ${deadAir.floor.floorDb.toFixed(1)}dB, threshold ${deadAir.floor.thresholdDb.toFixed(1)}dB`,
      ),
    )
    for (const pause of deadAir.pauses) {
      lines.push(
        line(
          `  ${(pause.startMs / 1000).toFixed(2)}-${(pause.endMs / 1000).toFixed(2)}s`,
          `${(pause.durationMs / 1000).toFixed(2)}s of silence`,
        ),
      )
    }
  }
  // #38: one warning-style line whenever this round's transcript carried standing metaSpeech
  // spans — spoken editing markers ("rebobinando", "corta eso") sitting outside every cut this
  // round made. metaSpeechFindings is null (not printed) when the session has no transcript to
  // check yet, distinct from an empty array, which means the check ran and found nothing.
  if (metaSpeechFindings !== null && metaSpeechFindings.length > 0) {
    lines.push(
      line(
        'metaSpeech',
        `${metaSpeechFindings.length} span${metaSpeechFindings.length === 1 ? '' : 's'} not cut — read each and cut it or name why it stays`,
      ),
    )
    for (const finding of metaSpeechFindings) {
      lines.push(
        line(
          `  ${(finding.startMs / 1000).toFixed(2)}-${(finding.endMs / 1000).toFixed(2)}s`,
          `"${finding.text}"`,
        ),
      )
    }
  }
  // #44: one warning-style line whenever the window sweep over this round's own render still
  // hears a phrase said twice, with the phrase quoted rather than counted. The quote is the
  // load-bearing part: a silent count is something a run can rationalise past, and the run that
  // opened this issue said so directly about a boolean it might have argued with and a quoted
  // sentence it would not have. listener is null (not printed) when no sweep ran this round,
  // distinct from a sweep whose lists came back empty.
  if (listener !== null && listener.report.repeatedPhrases.length > 0) {
    const found = listener.report.repeatedPhrases.length
    const scope =
      listener.scope === 'full'
        ? 'full sweep'
        : `delta sweep, untouched spans carried from round ${listener.carriedFrom ?? '?'}`
    lines.push(
      line(
        'listener',
        `${found} repeated phrase${found === 1 ? '' : 's'} in the render (${scope}): cut each or name why it stays`,
      ),
    )
    for (const finding of listener.report.repeatedPhrases) {
      lines.push(
        line(
          `  ${(finding.windowStartMs / 1000).toFixed(2)}-${(finding.windowEndMs / 1000).toFixed(2)}s`,
          `x${finding.count}: "${finding.phrase}"`,
        ),
      )
    }
    for (const edge of listener.report.truncatedEdges) {
      lines.push(line(`  ${(edge.windowEndMs / 1000).toFixed(2)}s`, `truncated at "${edge.word}"`))
    }
  }
  lines.push(line('committedRounds', String(gate.committedRounds)))
  lines.push(line('roundsGate', gate.status))
  lines.push(heading(gate.message))
  if (hints.length > 0) {
    lines.push(nextStep(hints[0].verb))
  } else {
    lines.push(nextStep(`trx transcribe ${render.outputPath} --words`))
  }
  return lines.join('\n')
}

export const commitCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const args = parseArgs(argv)
  if (!existsSync(args.media)) {
    throw new Error(`input missing: ${args.media}`)
  }

  const session = await openSession(args.media)
  if (session.fresh) {
    throw new UsageError(
      `no session for ${args.media} yet. Run vcut open ${args.media} first — commit builds from a session it does not create.`,
    )
  }
  const check = await checkSession(session.dir, args.media)
  if (check.status === 'sha-changed') {
    throw new UsageError(
      `${args.media} no longer matches this session (sha ${check.previousSha256.slice(0, 12)} -> ${check.currentSha256.slice(0, 12)}). Run vcut open again; the new content belongs to ${check.newSessionDir}.`,
    )
  }

  acquireLock(session.dir, 'commit')
  try {
    let report = cachedDetect(session.dir)
    if (report === null) {
      // A session always has a detect report once open has run; this only fires if the cache
      // file itself went missing underneath the session (hand-deleted, corrupted). Re-running
      // with the session's own recorded settings is cheaper than refusing outright.
      const detectOptions: DetectOptions = {
        input: args.media,
        preset: 'noisy' as Preset,
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      }
      report = await runDetect(detectOptions)
      writeCachedDetect(session.dir, report)
      // No open call ran to point this fresh report's transcript.path at the session's own
      // copy (open.ts does that once, at cache-write time, since B-V4) — this fallback recovers
      // a cache file that went missing underneath an otherwise-normal session, so it repeats
      // that same write-back through the same helper rather than leaving a stale or null path
      // for the build below.
      report = pointCachedTranscriptAtSession(session.dir, report)
    }

    const proposals = readProposalsFile(session.dir)

    const buildOptions: BuildOptions = {
      outputPath: args.outputPath,
      edlPath: args.edlPath,
      campaignId: args.campaignId,
      width: args.width,
      height: args.height,
      fps: args.fps,
      edgeFadeMs: args.edgeFadeMs,
      crop: args.crop,
      syncOffsetMs: 0,
    }
    const { edl, summary } = await runBuild(report, proposals, buildOptions)

    writeFileSync(args.edlPath, `${JSON.stringify(edl, null, 2)}\n`)

    // #44: the round this one follows, read BEFORE nextRoundDir allocates the new one (after
    // which listRoundNumbers already counts this round as the latest). Its EDL segments and its
    // recorded sweep are what let this round sweep only the spans it actually changed; null on
    // round 1, or when the previous round predates #44 and recorded no sweep to carry forward.
    const previousRoundNumber = listRoundNumbers(session.dir).at(-1) ?? null
    const previousRound =
      previousRoundNumber === null
        ? null
        : {
            round: previousRoundNumber,
            data: readRound(session.dir, previousRoundNumber),
            record: readListener(session.dir, previousRoundNumber),
          }

    const roundDir = nextRoundDir(session.dir)
    writeRound(roundDir, edl, summary)

    // #38: the metaSpeech analysis (semantic.ts, born from #37) runs here, on every commit that
    // has a transcript to check, not only inside `semantic review` — a verb the session loop
    // never forces. It reuses the round's own EDL segments and the session's already-cached
    // transcript, so nothing gets transcribed at commit time: this is a pure pass over data
    // already on disk, the same cost class as the merge/clamp/invert build just above it.
    const edlSegments = (edl as { segments: Array<{ inMs: number; outMs: number }> }).segments
    const metaSpeechFindings = metaSpeechForRound(report, edlSegments)
    if (metaSpeechFindings !== null) {
      writeMetaSpeech(roundDir, metaSpeechFindings)
    }

    // Audio-only lands beside the EDL as a .wav unless --output already names one, matching
    // render's own rule so a caller reading the EDL's own output path is never surprised by
    // where the sound landed.
    const renderOutputPath = args.audioOnly
      ? extname(args.outputPath) === '.wav'
        ? args.outputPath
        : join(dirname(args.edlPath), `${basename(args.outputPath).replace(/\.[^./]+$/, '')}.wav`)
      : undefined

    const renderOptions: RenderOptions = {
      outputPath: renderOutputPath,
      mode: 'preview',
      dryRun: false,
      audioOnly: args.audioOnly,
    }
    const render = await runRender(edl as Edl, renderOptions)

    // #43: surviving dead air, measured on the render this call just produced, at a threshold
    // calibrated to that render's own noise floor rather than a preset built for a different
    // microphone. Runs on every commit, unconditionally, the same forced placement #38 already
    // proved: `joins`, `audit`, and `nonspeech` all verify something about the EDL's intent, and
    // none of them reads the render's own audio, which is how a 19.9s silence reached a
    // converged preview in the run that opened this issue.
    const deadAir = await findSurvivingDeadAir(render.outputPath)
    writeDeadAir(roundDir, deadAir)

    // #44: the listener-grade window sweep, over the render this call just produced, on every
    // commit. `verify --windows` existed, was installed, appeared in --help, and was still never
    // run by the agnostic run that shipped a render carrying 18 repeated phrases it had called
    // clean: capability off the mandatory path is capability that does not exist, and this is the
    // fifth measured instance of that same pattern. See `sweepForRound` for the cost decision
    // (unconditional, but scoped to the spans this round changed from round 2 on) and why the
    // cheap alternatives were all a version of putting it back off the path.
    const sweep = await sweepForRound(
      render.outputPath,
      report.lang,
      previousRound === null || previousRound.data === null
        ? null
        : {
            round: previousRound.round,
            segments: (previousRound.data.edl as Edl).segments,
            record: previousRound.record,
          },
      (edl as Edl).segments,
    )
    if (sweep !== null) {
      writeListener(roundDir, sweep.record)
    }

    // #63: the deterministic pass, unconditional, the fourth check to take the forced placement
    // #38 proved and #43/#44 repeated. It runs LAST among the checks because it consumes what they
    // produced: the classifier's spans and the sweep's repeated phrases are both measured on this
    // round's own render, and re-running them here would be paying twice for the same answer.
    //
    // Unlike those three, this one does not report and wait. A finding an instrument can prove is
    // cut, and the EDL is rebuilt and re-rendered with those cuts folded in, because the measured
    // failure #63 exists for is not detection: all four classes were already reported and the model
    // declined to act on them six runs in a row. The proposals it produces are session proposals
    // like any other, so `rounds --diff`, `joins`, and the build report see them the same way they
    // see a hand-written `vcut cut`, and each one carries the instrument and measurement that
    // produced it in its own `reason`.
    const autoCut =
      classifierMissing() === null && sweep !== null
        ? await runAutoCut({
            renderPath: render.outputPath,
            classifierSpans: await classifierSpansFor(render.outputPath),
            repeats: sweep.report.repeatedPhrases,
            words: joinWords(
              report.transcript.path !== null && existsSync(report.transcript.path)
                ? parseSrt(readFileSync(report.transcript.path, 'utf8'))
                : { words: [], wordLevel: false },
            ),
            lang: report.lang,
            // findSurvivingDeadAir just measured this same render's floor; handing it over keeps
            // the round to one astats pass instead of two identical ones.
            knownFloor: deadAir.floor,
          })
        : null
    if (autoCut !== null) {
      writeAutoCut(roundDir, autoCut)
    }

    // The rebuild is what makes this a cutting pass rather than a reporting one. Everything the
    // pass measured was measured on the render just produced, so its spans are in master time and
    // become proposals through the round's own placements (`autoCutProposals`); the EDL is then
    // rebuilt from the session's proposals plus these, and re-rendered, so the artefact a human
    // reads is the already-clean one. `edl` and `render` are rebound so every check and report
    // below this point describes what actually shipped.
    let finalEdl = edl
    let finalRender = render
    let autoCutSummary = summary
    if (autoCut !== null && autoCut.cuts.length > 0) {
      const added = autoCutProposals(autoCut.cuts, placements(edl as Edl))
      if (added.length > 0) {
        const rebuilt = await runBuild(report, [...proposals, ...added], buildOptions)
        finalEdl = rebuilt.edl
        autoCutSummary = rebuilt.summary
        writeFileSync(args.edlPath, `${JSON.stringify(finalEdl, null, 2)}\n`)
        writeRound(roundDir, finalEdl, autoCutSummary)
        finalRender = await runRender(finalEdl as Edl, { ...renderOptions, allowExisting: true })
      }
    }

    // A successful commit marks the session as a gc candidate (B7-Q2): the round it just wrote
    // is state `session gc` may now consider clearing, never state it deletes on its own.
    markCommitted(session.dir)

    // The rounds gate (#36): evaluated AFTER writeRound, against the same committed-round count
    // `rounds` itself reads, so a caller cannot see a converged framing before the round that
    // earns it is actually on disk. `--single-round` is recorded here — a deliberate act visible
    // in the session (single-round-ack.json), never a default that silently waives the floor.
    // #44 adds the sweep's own findings as the second thing that can hold the same status back:
    // a session that ran two rounds and still repeats a sentence twice is exactly as unfinished
    // as one that ran one, and only the gate says so where a run will read it.
    const committedRounds = listRoundNumbers(session.dir).length
    if (args.singleRound) {
      acknowledgeSingleRound(session.dir, committedRounds)
    }
    const gate = evaluateRoundsGate(
      committedRounds,
      args.singleRound,
      sweep === null ? undefined : listenerFindings(sweep.report),
    )

    // Below the floor, the hints ARE the missing pass — the exact defect this gate exists for is
    // a caller reading "transcribe, review, approve" after round 1 and treating review of round
    // 1's own output as the second round. commitNext's approve-shaped hints only apply once the
    // gate has cleared, and #44 adds the second status that must not reach them: a render with a
    // standing repeated phrase gets the gate's own cut-then-recommit sequence, not approval.
    const baseHints =
      (gate.status === 'insufficient-rounds' || gate.status === 'repeated-phrases-unresolved') &&
      gate.next !== undefined
        ? gate.next
        : commitNext(args.edlPath, finalRender.outputPath)
    // #63/#44/#43/#38, in priority order. The deterministic pass goes first because it is the only
    // one describing material that is already GONE: everything below it asks the reader to act,
    // and a reader who acts without first knowing what was cut for them is working from a stale
    // picture of the render. Repeated phrases follow (the only class that also holds the gate),
    // then surviving dead air, then metaSpeech, then the gate's own hints, each unchanged.
    const hints = [
      ...autoCutNext(autoCut),
      ...listenerNext(sweep === null ? null : sweep.report),
      ...deadAirNext(deadAir),
      ...metaSpeechNext(metaSpeechFindings ?? []),
      ...baseHints,
    ]

    if (mode === 'json') {
      emitJson({
        status: 'committed',
        edlPath: args.edlPath,
        sessionDir: session.dir,
        roundDir,
        build: autoCutSummary,
        render: finalRender,
        roundsGate: gate,
        // Always present (#63), the same rule metaSpeech and listener follow: absence can never be
        // read as "not checked". Every cut names the instrument that fired and the measurement it
        // fired on, so a reader can trace any removed span back to its evidence without leaving
        // this payload. `autoCutChecked` is the separate honest signal for the case the report
        // itself cannot express: the pass never ran, because the classifier or trx is absent.
        autoCut,
        autoCutChecked: autoCut !== null,
        // Always present. floor is null only when the render was too short to calibrate a
        // threshold against (#43); pauses is [] whenever the check ran and found nothing.
        deadAir,
        // Always present, even as `[]`, so its absence can never be read as "not checked" (#38).
        // `metaSpeechChecked` is the honest separate signal for the one case an empty array
        // cannot distinguish on its own: a session with no transcript to check yet.
        metaSpeech: metaSpeechFindings ?? [],
        metaSpeechChecked: metaSpeechFindings !== null,
        // Always present (#44), the same rule metaSpeech follows: absence can never be read as
        // "not checked", because it is never absent. `scope` says which question this answered
        // (`full` swept the whole render, `delta` swept what this round changed and carried the
        // rest forward from `carriedFrom`), and every repeated phrase carries its own text, so a
        // caller reading this JSON reads the offending words rather than a count it can argue
        // with. `listenerChecked` is the separate honest signal for the one case the record
        // itself cannot express: no sweep ran at all, because trx is not installed.
        listener: sweep === null ? null : sweep.record,
        listenerChecked: sweep !== null,
        next: hints,
      })
      return
    }
    console.log(
      humanReport(
        args.edlPath,
        autoCutSummary.removalPercent,
        autoCutSummary.semanticCuts,
        finalRender,
        gate,
        deadAir,
        metaSpeechFindings,
        sweep === null ? null : sweep.record,
        autoCut,
        hints,
      ),
    )
  } finally {
    releaseLock(session.dir)
  }
}
