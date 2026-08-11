/**
 * Speech/silence blocks at a caller-chosen threshold and minimum, over a sub-range of a
 * recording, in absolute milliseconds.
 *
 * `detect` already answers "where is silence", but at one threshold and one minimum: the
 * preset floor, with a 0.3s minimum. That is the right answer for deciding what to cut. It is
 * the wrong resolution for deciding exactly where a boundary goes. On a real 7.5-minute run
 * (2026-08-10), every semantic boundary was placed by running raw ffmpeg `silencedetect` about
 * ten times at -33dB/0.08s, with the offset arithmetic from `--ss` back to absolute media time
 * done by hand each call, because the gaps separating a filler ("eh") from the next word
 * measure 80-150ms — well under what the preset's 0.3s minimum can even see.
 *
 * This is the placing instrument. `detect` remains the cutting instrument: its silence list is
 * still what `edl build` cuts against, at the threshold proven in production. `silences` never
 * writes an EDL and never changes what gets cut; it exists so the question "what does the
 * audio do between 327.3 and 330.5 seconds, at a resolution fine enough to see a filler's
 * edges" can be answered in one call instead of an ffmpeg invocation and offset math repeated
 * by hand.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseSilenceLog, probeDurationMs, type SilenceCandidate } from './detect.ts'
import { run } from './exec.ts'
import { duration, emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'

const HELP = `vcut silences - speech and silence blocks over a range, at a resolution you choose

Usage:
  vcut silences <media> [--from <sec> --to <sec>] [--noise <dB>] [--min <sec>]

Flags:
  --from <sec>     Start of the range to measure (default: 0)
  --to <sec>       End of the range to measure (default: end of media)
  --noise <dB>     Silence threshold (default -30, detect's clean preset)
  --min <sec>      Minimum silence duration to report (default 0.25)
  --json           Force JSON (default when stdout is not a TTY)
  --human          Force the human summary
  --help           Show this message

Answers the placing question detect cannot: speech/silence blocks at a threshold and minimum
you choose, over a sub-range, in absolute milliseconds. detect's silence list stays the one
edl build cuts against; this is for finding exactly where a boundary goes, at whatever
resolution the boundary needs. Positions on flags are seconds; the JSON speaks milliseconds.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const DEFAULT_NOISE_DB = -30
const DEFAULT_MIN_SILENCE_S = 0.25

export type Block = {
  kind: 'speech' | 'silence'
  startMs: number
  endMs: number
  durationMs: number
}

/**
 * Silence blocks plus the speech that fills the gaps between them, covering the whole
 * requested range. `silences` are already offset into absolute media time and clamped to the
 * range; this only fills in what they leave out.
 */
export const toBlocks = (
  silences: SilenceCandidate[],
  rangeStartMs: number,
  rangeEndMs: number,
): Block[] => {
  const blocks: Block[] = []
  let cursor = rangeStartMs

  const sorted = [...silences].sort((left, right) => left.startMs - right.startMs)

  for (const silence of sorted) {
    const startMs = Math.max(rangeStartMs, silence.startMs)
    const endMs = Math.min(rangeEndMs, silence.endMs)
    if (endMs <= startMs) {
      continue
    }
    if (startMs > cursor) {
      blocks.push({ kind: 'speech', startMs: cursor, endMs: startMs, durationMs: startMs - cursor })
    }
    blocks.push({ kind: 'silence', startMs, endMs, durationMs: endMs - startMs })
    cursor = Math.max(cursor, endMs)
  }

  if (cursor < rangeEndMs) {
    blocks.push({
      kind: 'speech',
      startMs: cursor,
      endMs: rangeEndMs,
      durationMs: rangeEndMs - cursor,
    })
  }

  return blocks
}

export type SilencesReport = {
  version: 1
  input: string
  rangeStartMs: number
  rangeEndMs: number
  thresholdDb: number
  minSilenceMs: number
  blocks: Block[]
}

export const humanReport = (report: SilencesReport): string => {
  const lines = [
    heading(
      `${report.input.split('/').pop()}  ${duration(report.rangeStartMs)} - ${duration(report.rangeEndMs)}`,
    ),
    line('threshold', `${report.thresholdDb} dB, min ${report.minSilenceMs}ms`),
  ]
  for (const block of report.blocks) {
    lines.push(
      line(
        `${(block.startMs / 1000).toFixed(2)}-${(block.endMs / 1000).toFixed(2)}s`,
        `${block.kind}  (${block.durationMs}ms)`,
      ),
    )
  }
  return lines.join('\n')
}

type CliOptions = {
  input: string
  fromS: number | null
  toS: number | null
  noiseDb: number
  minSilenceS: number
}

const BOOLEAN_FLAGS = new Set(['--json', '--human', '--help'])

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

const parseCli = (args: string[]): CliOptions => {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const input = positional(args)
  if (input === undefined) {
    throw new UsageError(HELP)
  }
  const numeric = (flag: string, fallback: number | null): number | null => {
    const raw = value(flag)
    if (raw === undefined) {
      return fallback
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      throw new UsageError(`${flag} needs a number of seconds`)
    }
    return parsed
  }
  return {
    input: resolve(input),
    fromS: numeric('--from', null),
    toS: numeric('--to', null),
    noiseDb: numeric('--noise', DEFAULT_NOISE_DB) as number,
    minSilenceS: numeric('--min', DEFAULT_MIN_SILENCE_S) as number,
  }
}

export const silencesCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const options = parseCli(argv)
  if (!existsSync(options.input)) {
    throw new Error(`input missing: ${options.input}`)
  }

  const durationMs = await probeDurationMs(options.input)
  const rangeStartMs = Math.max(0, Math.round((options.fromS ?? 0) * 1000))
  const rangeEndMs = Math.min(durationMs, Math.round((options.toS ?? durationMs / 1000) * 1000))
  if (rangeEndMs <= rangeStartMs) {
    throw new UsageError('--to must be after --from, and both must fall inside the media')
  }
  const rangeDurationS = ((rangeEndMs - rangeStartMs) / 1000).toFixed(3)

  // -ss before -i seeks the demuxer rather than decoding and discarding, which is why offset
  // arithmetic is needed at all: silencedetect only ever sees the range asked for, and every
  // timestamp it reports is relative to that seek, not to the file.
  const { stderr, exitCode } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-ss',
    (rangeStartMs / 1000).toFixed(3),
    '-t',
    rangeDurationS,
    '-i',
    options.input,
    '-af',
    `silencedetect=noise=${options.noiseDb}dB:d=${options.minSilenceS}`,
    '-f',
    'null',
    '-',
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with ${exitCode}`)
  }

  const rangeDurationMs = rangeEndMs - rangeStartMs
  // parseSilenceLog closes a dangling silence_start against the duration it is given, which
  // here is the range's own duration, not the file's — the seek already cut the tail off.
  const relative = parseSilenceLog(stderr, rangeDurationMs)
  const silences: SilenceCandidate[] = relative.map((silence) => ({
    kind: 'silence',
    startMs: silence.startMs + rangeStartMs,
    endMs: silence.endMs + rangeStartMs,
    durationMs: silence.durationMs,
  }))

  const report: SilencesReport = {
    version: 1,
    input: options.input,
    rangeStartMs,
    rangeEndMs,
    thresholdDb: options.noiseDb,
    minSilenceMs: Math.round(options.minSilenceS * 1000),
    blocks: toBlocks(silences, rangeStartMs, rangeEndMs),
  }

  if (mode === 'json') {
    emitJson(report)
    return
  }
  console.log(humanReport(report))
}
