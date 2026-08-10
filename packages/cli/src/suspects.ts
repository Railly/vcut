/**
 * Where in a recording to look first, without reading the whole thing.
 *
 * A loop that reasons over a transcript pays for the whole file every round: measured across
 * nine runs on one 90-second take, editing cost 96k tokens and five minutes of work per minute
 * of video. The cost scaled with duration rather than with how much was wrong, which is what
 * makes a twenty-minute source unaffordable rather than merely slow.
 *
 * This points instead of reading. The signal is causal rather than statistical: a speaker who
 * corrects themselves breaks delivery into short pauses that land close together, while fluent
 * speech spaces its pauses out. Measured on four recordings, hesitant material fires 5.3 to 6.3
 * times a minute and a take read from a script fires 1.0.
 *
 * Acoustic similarity was tried first and does not work. Envelope correlation, a twelve-band
 * spectral fingerprint, and sliding alignment all scored unrelated content at or above a real
 * repetition, because the same speaker in the same room resembles themselves everywhere in the
 * file. What separates "said the same words" from "said different ones" lives in the phoneme
 * sequence, which those methods average away.
 *
 * It names positions and never says what is wrong with them. A detector that classified would
 * have to tell a discarded retake from a speaker pausing to pick a related thought, and that
 * distinction lives in content rather than rhythm. Rhythm is all this measures.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { DetectReport } from './detect.ts'
import { emitJson, heading, line, nextStep, resolveMode, UsageError } from './output.ts'

const HELP = `vcut suspects - where to look first, from the silences detect already measured

Usage:
  vcut suspects --detect <path> [flags]

Flags:
  --detect <path>       Report produced by detect (required)
  --pause-ratio <n>     How close two pauses must be to count, as a fraction of this
                        recording's own median gap (default 0.4)
  --limit <n>           Return at most this many positions, closest pauses first
  --json / --human      Output mode
  --help                Show this message

Positions are ranked by how tightly their pauses cluster. It reports where to listen and
says nothing about what is there: run 'vcut say' on a position to find out.

The default ratio sits in the middle of a plateau (0.3 to 0.5) where the result did not
change on the recording it was measured against. It is a flag because that was one file.`

export type Suspect = {
  atMs: number
  gapMs: number
  /** How tight this cluster is against the recording's own cadence. Lower is tighter. */
  ratio: number
}

const DEFAULT_PAUSE_RATIO = 0.4

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/**
 * The median gap is what makes this work across speakers rather than needing a number per
 * recording. One take read from a script had a median of 8916ms against 1170ms for the same
 * speaker talking off the cuff, and the detector did not saturate on either: the threshold is
 * a fraction of whatever that recording's own cadence turns out to be.
 *
 * It also explains why longer takes fire less per minute rather than more. A long recording
 * carries more thinking pauses, so its median rises, so the bar for "close together" rises
 * with it: 6.3 a minute at three minutes against 2.8 to 3.5 at four and six.
 */
export const findSuspects = (
  silences: Array<{ startMs: number; endMs: number }>,
  minSilenceMs: number,
  pauseRatio: number,
): { suspects: Suspect[]; medianGapMs: number; pausesConsidered: number } => {
  // The floor is the run's own --min-silence rather than a number invented here: anything
  // shorter was not a pause this detect call was looking for in the first place.
  const pauses = silences
    .filter((silence) => silence.endMs - silence.startMs >= minSilenceMs)
    .sort((left, right) => left.startMs - right.startMs)

  if (pauses.length < 3) {
    return { suspects: [], medianGapMs: 0, pausesConsidered: pauses.length }
  }

  const gaps = pauses.slice(0, -1).map((pause, index) => pauses[index + 1].startMs - pause.endMs)
  const medianGapMs = median(gaps)
  if (medianGapMs <= 0) {
    return { suspects: [], medianGapMs, pausesConsidered: pauses.length }
  }

  const threshold = medianGapMs * pauseRatio
  const suspects: Suspect[] = []
  for (const [index, gap] of gaps.entries()) {
    if (gap < threshold) {
      suspects.push({ atMs: pauses[index].startMs, gapMs: gap, ratio: gap / medianGapMs })
    }
  }
  // Tightest first, because that is the order worth spending calls in.
  suspects.sort((left, right) => left.ratio - right.ratio)
  return { suspects, medianGapMs, pausesConsidered: pauses.length }
}

const readReport = (path: string | undefined): DetectReport => {
  if (path === undefined) {
    throw new UsageError(HELP)
  }
  const full = resolve(path)
  if (!existsSync(full)) {
    throw new UsageError(`detect report missing: ${path}`)
  }
  try {
    return JSON.parse(readFileSync(full, 'utf8')) as DetectReport
  } catch {
    throw new UsageError(`detect report is not valid JSON: ${path}`)
  }
}

const numberFlag = (argv: string[], flag: string, fallback: number): number => {
  const index = argv.indexOf(flag)
  if (index === -1) {
    return fallback
  }
  const parsed = Number(argv[index + 1])
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${flag} needs a positive number`)
  }
  return parsed
}

const human = (
  report: DetectReport,
  found: ReturnType<typeof findSuspects>,
  ratio: number,
): void => {
  const minutes = report.durationMs / 60000
  const lines = [
    heading('suspects'),
    line('positions', String(found.suspects.length)),
    line('per minute', (found.suspects.length / minutes).toFixed(1)),
    line('cadence', `${Math.round(found.medianGapMs)}ms median gap, ratio ${ratio}`),
  ]
  for (const suspect of found.suspects.slice(0, 12)) {
    lines.push(line(`${(suspect.atMs / 1000).toFixed(2)}s`, `gap ${Math.round(suspect.gapMs)}ms`))
  }
  if (found.suspects.length > 12) {
    lines.push(line('', `... and ${found.suspects.length - 12} more`))
  }
  lines.push(nextStep('vcut say <media> --transcribe --at <the position> --window 4'))
  console.log(lines.join('\n'))
}

export const suspectsCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const value = (flag: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const report = readReport(value('--detect'))
  const ratio = numberFlag(argv, '--pause-ratio', DEFAULT_PAUSE_RATIO)
  const limit = numberFlag(argv, '--limit', Number.POSITIVE_INFINITY)

  const found = findSuspects(report.silences, report.minSilenceMs, ratio)
  const suspects = Number.isFinite(limit) ? found.suspects.slice(0, limit) : found.suspects
  const mode = resolveMode(argv, Boolean(process.stdout.isTTY))

  if (mode === 'human') {
    human(report, { ...found, suspects }, ratio)
    return
  }
  emitJson({
    input: report.input,
    durationMs: report.durationMs,
    pauseRatio: ratio,
    medianGapMs: Math.round(found.medianGapMs),
    pausesConsidered: found.pausesConsidered,
    suspects: suspects.map((suspect) => ({
      atMs: suspect.atMs,
      gapMs: Math.round(suspect.gapMs),
      ratio: Number(suspect.ratio.toFixed(3)),
    })),
  })
}
