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

import { type BuildOptions, type Crop, parseCrop, runBuild } from './build-edl.ts'
import type { CliOptions as DetectOptions, DetectReport, Preset } from './detect.ts'
import { parseSrt, runDetect } from './detect.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import { type Edl, type RenderOptions, runRender } from './render-edl.ts'
import { acknowledgeSingleRound, evaluateRoundsGate, type RoundsGate } from './rounds-gate.ts'
import {
  buildLines,
  gapsBetween,
  joinWords,
  LINE_BREAK_MS,
  type MetaSpeechSpan,
  metaSpeech,
} from './semantic.ts'
import {
  acquireLock,
  cachedDetect,
  checkSession,
  deriveRefs,
  listRoundNumbers,
  markCommitted,
  nextRoundDir,
  openSession,
  pointCachedTranscriptAtSession,
  readProposalsFile,
  releaseLock,
  writeCachedDetect,
  writeMetaSpeech,
  writeRound,
} from './session.ts'

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

const humanReport = (
  edlPath: string,
  removalPercent: number,
  semanticCuts: Array<{ startMs: number; endMs: number; kind: string; removedText: string }>,
  render: { status: string; outputPath: string; sha256?: string; duration?: string },
  gate: RoundsGate,
  metaSpeechFindings: MetaSpeechSpan[] | null,
  hints: Array<{ question: string; verb: string }>,
): string => {
  const lines = [
    heading(`committed  ${edlPath}`),
    line('removalPercent', `${removalPercent.toFixed(1)}%`),
    line('semantic cuts', String(semanticCuts.length)),
  ]
  for (const cut of semanticCuts) {
    lines.push(
      line(
        `  ${(cut.startMs / 1000).toFixed(2)}-${(cut.endMs / 1000).toFixed(2)}s`,
        `${cut.kind}: "${cut.removedText || '(no transcript)'}"`,
      ),
    )
  }
  lines.push(line('render', render.status))
  lines.push(line('output', render.outputPath))
  if (render.duration !== undefined) {
    lines.push(line('duration', `${render.duration}s`))
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

    // A successful commit marks the session as a gc candidate (B7-Q2): the round it just wrote
    // is state `session gc` may now consider clearing, never state it deletes on its own.
    markCommitted(session.dir)

    // The rounds gate (#36): evaluated AFTER writeRound, against the same committed-round count
    // `rounds` itself reads, so a caller cannot see a converged framing before the round that
    // earns it is actually on disk. `--single-round` is recorded here — a deliberate act visible
    // in the session (single-round-ack.json), never a default that silently waives the floor.
    const committedRounds = listRoundNumbers(session.dir).length
    if (args.singleRound) {
      acknowledgeSingleRound(session.dir, committedRounds)
    }
    const gate = evaluateRoundsGate(committedRounds, args.singleRound)

    // Below the floor, the hints ARE the missing pass — the exact defect this gate exists for is
    // a caller reading "transcribe, review, approve" after round 1 and treating review of round
    // 1's own output as the second round. commitNext's approve-shaped hints only apply once the
    // gate has cleared.
    const baseHints =
      gate.status === 'insufficient-rounds' && gate.next !== undefined
        ? gate.next
        : commitNext(args.edlPath, render.outputPath)
    // #38: standing metaSpeech findings are named before every other hint, including the rounds
    // gate's own — the run this issue is about read hint[0] every round and stopped there.
    const hints = [...metaSpeechNext(metaSpeechFindings ?? []), ...baseHints]

    if (mode === 'json') {
      emitJson({
        status: 'committed',
        edlPath: args.edlPath,
        sessionDir: session.dir,
        roundDir,
        build: summary,
        render,
        roundsGate: gate,
        // Always present, even as `[]`, so its absence can never be read as "not checked" (#38).
        // `metaSpeechChecked` is the honest separate signal for the one case an empty array
        // cannot distinguish on its own: a session with no transcript to check yet.
        metaSpeech: metaSpeechFindings ?? [],
        metaSpeechChecked: metaSpeechFindings !== null,
        next: hints,
      })
      return
    }
    console.log(
      humanReport(
        args.edlPath,
        summary.removalPercent,
        summary.semanticCuts,
        render,
        gate,
        metaSpeechFindings,
        hints,
      ),
    )
  } finally {
    releaseLock(session.dir)
  }
}
