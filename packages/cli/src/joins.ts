/**
 * Verify every semantic join in one call: the post-render twin of `removedText`.
 *
 * `edl build` already names what each semantic cut removes (`semanticCuts[].removedText`) and
 * which segment opens right after it (`boundariesAfterSpeech`'s own warning). What it cannot
 * answer is whether the render actually landed clean at that boundary — that needs the render
 * file itself, re-transcribed at the join. Doing that by hand is locate (find the master
 * position) plus say --transcribe (hear the window), once per semantic cut: on a real
 * 11.7-minute run (2026-08-10, testing-10m.mp4) verifying 9 joins that way cost ~14 calls, the
 * same session where 3 transcript wolves each cost a separate refutation call. `joins` collapses
 * that whole round to one.
 *
 * The join position for a semantic cut is derived the same way `build-edl.ts`'s
 * `boundariesAfterSpeech` finds it: the EDL segment that opens right after the cut's span, by
 * the *kind* of cut rather than a distance (a semantic cut is the one kind that removes speech
 * on purpose). Reused directly rather than re-derived, so a change to that boundary rule cannot
 * drift between the build-time warning and this render-time check.
 *
 * The EDL says what was asked for; only the render says what happened, the same stance
 * `locate --render` already takes. Each join's master position is checked against the render's
 * own measured duration (`checkAgainstRender`), and the window around it is re-transcribed on
 * the RENDER, not the source, sequentially — one `trx` call at a time, never `Promise.all`. Each
 * call loads a Whisper model into memory, and racing them is exactly the load
 * `nonspeech.ts`'s `verifySpansSequentially` and `say --positions --transcribe` already refuse.
 *
 * vcut still calls no model of its own: this runs the transcriber already on the caller's PATH,
 * the same way every measurement in this codebase runs ffmpeg.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Cut, SemanticCutReport } from './build-edl.ts'
import { boundariesAfterSpeech } from './build-edl.ts'
import { checkAgainstRender, placements, probeDurationMs } from './locate.ts'
import { emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import { carryingWords } from './peek.ts'
import type { Edl } from './render-edl.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut joins - verify every semantic join in one call

Usage:
  vcut joins --edl <path> --render <master path> [flags]

Flags:
  --edl <path>       Edit decision list the render came from (required)
  --render <path>    The rendered file to re-transcribe and measure (required)
  --report <path>    A build report (vcut edl build / vcut commit JSON) carrying semanticCuts.
                      Defaults to report.json next to the EDL, the shape 'vcut commit' writes
                      into rounds/round-N/. Absent is a supported state: joins still runs,
                      without removedText/reason/driftSuspect on each entry
  --lang <code>       Language passed to the transcriber
  --window <sec>      Width of the window re-transcribed around each join (default 4)
  --json / --human    Output mode
  --help              Show this message

The post-render twin of edl build's removedText: one call that verifies every semantic join
instead of N x (locate + say --transcribe). Runs on the RENDER, never the source, and checks
the EDL's master-time map against the render's own measured duration before trusting it.

reading is lands, removed-text-leaked, or check-by-ear. removed-text-leaked is a place to
look, not a verdict: a false-start's removedText can legitimately share vocabulary with the
sentence that survives it, which reads as leaked overlap without being one. Confirm with a
wider say --transcribe window before acting on it.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const DEFAULT_WINDOW_S = 4

// --- Join derivation --------------------------------------------------------------------

export type SemanticCutSpan = { startMs: number; endMs: number }

export type JoinPoint = {
  segmentId: string
  joinMasterMs: number
  cutStartMs: number
  cutEndMs: number
}

/**
 * Which EDL segment opens right after each semantic cut, and where that join lands in master
 * time. Reuses `boundariesAfterSpeech`'s own condition — a segment gap that a semantic cut's
 * span overlaps, skipping index 0 (the file's own start, which follows nothing) — rather than
 * re-deriving it, so this can never disagree with the warning `edl build` already writes about
 * the same boundary.
 *
 * A semantic cut with no following segment (it removed everything to the end of the source, or
 * `boundariesAfterSpeech`'s own index-0 rule excludes it because it opens the file) has no join
 * to verify and is silently absent from the result — there is nothing rendered to check it
 * against.
 */
export const deriveJoins = (
  segments: Edl['segments'],
  semanticCuts: SemanticCutSpan[],
): JoinPoint[] => {
  if (semanticCuts.length === 0) {
    return []
  }
  const cuts: Cut[] = semanticCuts.map((cut) => ({
    startMs: cut.startMs,
    endMs: cut.endMs,
    reason: 'semantic' as const,
  }))
  const boundaries = boundariesAfterSpeech(segments, cuts, [])
  const map = placements({ segments } as Edl)

  const points: JoinPoint[] = []
  for (const boundary of boundaries) {
    const placement = map[boundary.index]
    if (placement === undefined) {
      continue
    }
    // boundary.inMs is the segment's own (source-time) inMs and boundary.cutMs is the gap
    // width, so the gap this boundary closed ran [inMs - cutMs, inMs) in source time — the
    // same gapStart/gapEnd boundariesAfterSpeech computed internally. The owning semantic cut
    // is the one whose span overlaps that gap.
    const gapEnd = boundary.inMs
    const gapStart = gapEnd - boundary.cutMs
    const owningCut = semanticCuts.find(
      (candidate) => candidate.startMs < gapEnd && candidate.endMs > gapStart,
    )
    if (owningCut === undefined) {
      continue
    }
    points.push({
      segmentId: placement.id,
      joinMasterMs: placement.masterInMs,
      cutStartMs: owningCut.startMs,
      cutEndMs: owningCut.endMs,
    })
  }
  return points
}

// --- Reading classification --------------------------------------------------------------

export type Reading = 'lands' | 'removed-text-leaked' | 'check-by-ear'

const MAJORITY = 0.5

/**
 * Whether a join reads clean, honestly limited the same way `peek`'s `viewsDisagree` is: a
 * short window transcribes noisily, so a window with too little to judge says so rather than
 * faking a verdict either way.
 *
 * 'removed-text-leaked' fires when the window shares a majority of its carrying words with the
 * cut's own removedText — the tail of the removed speech survived into the render, the defect
 * class the boundariesAfterSpeech warning exists to catch. 'lands' is the window carrying real
 * words that are not a majority overlap with what was removed: the join connects to whatever
 * comes next rather than repeating what was cut. 'check-by-ear' is what an empty or too-short
 * window reports, the same honest-limits stance peek and nonspeech --verify already take rather
 * than reading silence as success.
 *
 * A verified false positive on real material (testing-10m.mp4, 2026-08-10): a false-start cut
 * whose removedText was the speaker stumbling on "agregar verificabilidad" three times before
 * landing it, followed by a surviving sentence that legitimately uses "agregar verificabilidad"
 * as its real content — carrying-word overlap cannot tell a leaked tail from a kept sentence
 * that happens to share vocabulary with its own discarded false starts, since both are about
 * the same words by construction. A wider `say --transcribe` window confirmed the join reads
 * clean. 'removed-text-leaked' is a place to look, not a verdict, same as every other
 * disagreement reading in this codebase.
 */
export const classifyReading = (windowText: string, removedText: string | null): Reading => {
  const windowCarrying = carryingWords(windowText)
  if (windowCarrying.length === 0) {
    return 'check-by-ear'
  }
  if (removedText === null || removedText.trim() === '') {
    return 'lands'
  }
  const removedCarrying = new Set(carryingWords(removedText))
  if (removedCarrying.size === 0) {
    return 'lands'
  }
  const shared = windowCarrying.filter((word) => removedCarrying.has(word)).length
  return shared / windowCarrying.length >= MAJORITY ? 'removed-text-leaked' : 'lands'
}

// --- next hints ----------------------------------------------------------------------------

export const joinNext = (
  renderPath: string,
  join: { joinMasterMs: number },
  reading: Reading,
): Array<{ question: string; verb: string }> => {
  if (reading === 'lands') {
    return []
  }
  const atS = (join.joinMasterMs / 1000).toFixed(2)
  return [
    {
      question: 'hear a wider window around the join',
      verb: `vcut say ${renderPath} --transcribe --at ${atS} --window 8`,
    },
  ]
}

// --- Command --------------------------------------------------------------------------------

type ReportShape = { semanticCuts?: SemanticCutReport[] }

const findReport = (
  edlPath: string,
  reportFlag: string | undefined,
): SemanticCutReport[] | null => {
  const reportPath =
    reportFlag !== undefined ? resolve(reportFlag) : join(dirname(edlPath), 'report.json')
  if (!existsSync(reportPath)) {
    return null
  }
  try {
    const parsed = JSON.parse(readFileSync(reportPath, 'utf8')) as ReportShape
    return Array.isArray(parsed.semanticCuts) ? parsed.semanticCuts : null
  } catch {
    return null
  }
}

const reportFor = (
  reports: SemanticCutReport[] | null,
  cutStartMs: number,
  cutEndMs: number,
): SemanticCutReport | null => {
  if (reports === null) {
    return null
  }
  return (
    reports.find((entry) => entry.startMs === cutStartMs && entry.endMs === cutEndMs) ??
    reports.find(
      (entry) => Math.abs(entry.startMs - cutStartMs) < 50 && Math.abs(entry.endMs - cutEndMs) < 50,
    ) ??
    null
  )
}

export type JoinResult = {
  segmentId: string
  joinMasterMs: number
  windowStartMs: number
  windowEndMs: number
  windowText: string
  removedText: string | null
  reason: string | null
  driftSuspect: boolean | null
  reading: Reading
  next: Array<{ question: string; verb: string }>
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const numericFlag = (argv: string[], name: string): number | undefined => {
  const raw = flagValue(argv, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`${name} expects a number in seconds, got ${raw}`)
  }
  return value
}

const humanReport = (
  renderPath: string,
  results: JoinResult[],
  renderCheck: ReturnType<typeof checkAgainstRender>,
): string => {
  const lines = [heading(`joins  ${renderPath}`)]
  if (!renderCheck.agrees) {
    lines.push(
      line(
        'render disagrees',
        `EDL map totals ${(renderCheck.expectedMs / 1000).toFixed(3)}s, render measures ${(renderCheck.observedMs / 1000).toFixed(3)}s (${(renderCheck.deltaMs / 1000).toFixed(3)}s off)`,
      ),
    )
  }
  for (const result of results) {
    lines.push(
      line(
        `${(result.joinMasterMs / 1000).toFixed(2)}s (${result.segmentId})`,
        `${result.reading}  "${result.windowText || '(no words)'}"`,
      ),
    )
    if (result.removedText !== null) {
      lines.push(line('  removed', `"${result.removedText}"`))
    }
  }
  return lines.join('\n')
}

export const joinsCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const edlPath = flagValue(argv, '--edl')
  const renderArg = flagValue(argv, '--render')
  if (edlPath === undefined || renderArg === undefined) {
    throw new UsageError(HELP)
  }
  const resolvedEdlPath = resolve(edlPath)
  if (!existsSync(resolvedEdlPath)) {
    throw new UsageError(`no EDL at ${resolvedEdlPath}`)
  }
  const resolvedRender = resolve(renderArg)
  if (!existsSync(resolvedRender)) {
    throw new UsageError(`no render at ${resolvedRender}`)
  }

  const edl = JSON.parse(readFileSync(resolvedEdlPath, 'utf8')) as Edl
  const reports = findReport(resolvedEdlPath, flagValue(argv, '--report'))

  const semanticCuts: SemanticCutSpan[] =
    reports === null ? [] : reports.map((entry) => ({ startMs: entry.startMs, endMs: entry.endMs }))
  const joins = deriveJoins(edl.segments, semanticCuts)

  const map = placements(edl)
  const renderCheck = checkAgainstRender(map, await probeDurationMs(resolvedRender))

  const windowMs = (numericFlag(argv, '--window') ?? DEFAULT_WINDOW_S) * 1000
  const lang = flagValue(argv, '--lang')

  // Sequential, never Promise.all: each call shells out to trx, which loads a Whisper model
  // into memory. This is the same reasoning nonspeech.ts's verifySpansSequentially and
  // say --positions --transcribe already apply, extended to joins.
  const results: JoinResult[] = []
  for (const join of joins) {
    const half = windowMs / 2
    const windowStartMs = Math.max(0, join.joinMasterMs - half)
    const windowEndMs = join.joinMasterMs + half
    const windowText = await transcribeWindow(
      resolvedRender,
      windowStartMs,
      windowEndMs,
      lang,
      'vcut-joins',
    )
    const report = reportFor(reports, join.cutStartMs, join.cutEndMs)
    const removedText = report === null ? null : report.removedText
    const reading = classifyReading(windowText, removedText)
    results.push({
      segmentId: join.segmentId,
      joinMasterMs: join.joinMasterMs,
      windowStartMs,
      windowEndMs,
      windowText,
      removedText,
      reason: report === null ? null : report.reason,
      driftSuspect: report === null ? null : (report.driftSuspect ?? false),
      reading,
      next: joinNext(resolvedRender, join, reading),
    })
  }

  if (mode === 'json') {
    emitJson({
      version: 1,
      edl: resolvedEdlPath,
      render: resolvedRender,
      renderCheck,
      joins: results,
    })
    return
  }
  console.log(humanReport(resolvedRender, results, renderCheck))
}
