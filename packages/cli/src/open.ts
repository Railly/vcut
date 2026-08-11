/**
 * `vcut open <media>` — the session-backed map: run detection once, cache it, derive stable
 * block refs from it, and report counts rather than content.
 *
 * This is agent-browser's `open`/snapshot for a recording: a ref like `b042` is the thing a
 * later verb (`peek`, `cut` — B-V2/B-V3) points at instead of a raw millisecond pair, the same
 * way a browser snapshot hands out element refs instead of coordinates. The map itself answers
 * "what is here" without ever printing "what does it say" — durations, counts, a top-10 slice
 * of suspects with the ref nearest each one. Reading actual content is a later verb's job.
 *
 * Re-running `open` on unchanged media is meant to be visibly cheap: the session's cached
 * detect report is reused rather than re-run, and the report says so (`cached: true`). Running
 * it again with a different `--preset` re-detects on purpose — the cache is keyed by content,
 * not by every combination of flags a caller might pass, and a preset change is exactly the
 * case `checkSession`'s sha comparison was never meant to catch.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import type { CliOptions, DetectReport, Lang, Preset } from './detect.ts'
import { PRESET_DB, runDetect } from './detect.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import {
  cachedDetect,
  cachedTranscriptPath,
  deriveRefs,
  openSession,
  pointCachedTranscriptAtSession,
  writeCachedDetect,
  writeRefs,
} from './session.ts'
import { findSuspects, type Suspect } from './suspects.ts'

const HELP = `vcut open - open or resume a session for a recording, and map its blocks

Usage:
  vcut open <media> [--preset <name>] [--lang <code>] [--transcript <path>]

Flags:
  --preset <name>       noisy (-20dB, default) | clean (-30dB) | podcast (-35dB)
  --lang <code>         Recording language, free-form (default es)
  --transcript <path>   SRT to cache into the session, word-level for best results
  --json                Force JSON (default when stdout is not a TTY)
  --human               Force the human summary
  --help                Show this message

Sessions live under ~/.vcut/sessions/<sha256-16 of the source>/. The same content opened
twice reuses the cached detect report; a re-open with a different --preset re-detects and
bumps the session's ref generation. Nothing here reads or prints spoken content: this is the
map, not the text. Blocks are the speech spans between the detect's own silences, numbered
b001, b002, ... in time order.`

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

type CliArgs = {
  media: string
  preset: Preset
  lang: Lang
  transcriptPath: string | null
}

const parseArgs = (argv: string[]): CliArgs => {
  const value = (flag: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const media = positional(argv)
  if (media === undefined) {
    throw new UsageError(HELP)
  }
  const preset = (value('--preset') ?? 'noisy') as Preset
  if (PRESET_DB[preset] === undefined) {
    throw new UsageError('preset must be noisy, clean, or podcast')
  }
  return {
    media: resolve(media),
    preset,
    lang: value('--lang') ?? 'es',
    transcriptPath:
      value('--transcript') === undefined ? null : resolve(value('--transcript') as string),
  }
}

export type OpenSuspect = Suspect & { nearestRef: string | null }

/** The ref whose span contains atMs, or the closest one when it falls in a silence gap. */
export const nearestRef = (
  atMs: number,
  blocks: Array<{ ref: string; startMs: number; endMs: number }>,
): string | null => {
  if (blocks.length === 0) {
    return null
  }
  const containing = blocks.find((block) => atMs >= block.startMs && atMs < block.endMs)
  if (containing !== undefined) {
    return containing.ref
  }
  let closest = blocks[0]
  let closestDistance = Number.POSITIVE_INFINITY
  for (const block of blocks) {
    const distance = Math.min(Math.abs(atMs - block.startMs), Math.abs(atMs - block.endMs))
    if (distance < closestDistance) {
      closest = block
      closestDistance = distance
    }
  }
  return closest.ref
}

export type OpenReport = {
  version: 1
  sessionDir: string
  input: string
  durationMs: number
  preset: Preset
  lang: Lang
  gen: number
  cached: boolean
  silenceCount: number
  blockCount: number
  transcriptPresent: boolean
  suspects: OpenSuspect[]
  fresh: boolean
}

const SUSPECT_LIMIT = 10

export const openNext = (report: OpenReport): Array<{ question: string; verb: string }> => {
  const hints: Array<{ question: string; verb: string }> = []
  if (!report.transcriptPresent) {
    hints.push({
      question: 'get a word-level transcript for the semantic pass',
      verb: `trx transcribe ${report.input} --words --language ${report.lang}`,
    })
  }
  if (report.suspects.length > 0) {
    const top = report.suspects[0]
    hints.push({
      question: 'what is said at the top suspect',
      verb: `vcut say ${report.input} --transcribe --at ${(top.atMs / 1000).toFixed(2)} --window 4`,
    })
  }
  hints.push({
    question: 're-tune and re-detect with a different preset',
    verb: `vcut open ${report.input} --preset <noisy|clean|podcast>`,
  })
  return hints
}

const human = (report: OpenReport): string => {
  const lines = [
    heading(`${report.input.split('/').pop()}  ${(report.durationMs / 1000).toFixed(1)}s`),
    line('session', report.sessionDir),
    line('cached', report.cached ? 'yes (detect reused)' : 'no (detect just ran)'),
    line('preset', `${report.preset} gen ${report.gen}`),
    line('silences', String(report.silenceCount)),
    line('blocks', String(report.blockCount)),
    line('transcript', report.transcriptPresent ? 'present' : 'none cached'),
    line('suspects', String(report.suspects.length)),
  ]
  for (const suspect of report.suspects.slice(0, SUSPECT_LIMIT)) {
    lines.push(
      line(
        `${(suspect.atMs / 1000).toFixed(2)}s`,
        `gap ${Math.round(suspect.gapMs)}ms  near ${suspect.nearestRef ?? 'n/a'}`,
      ),
    )
  }
  if (!report.transcriptPresent) {
    lines.push(nextStep('the semantic pass needs a transcript: trx transcribe --words'))
  }
  return lines.join('\n')
}

export const openCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const args = parseArgs(argv)
  if (!existsSync(args.media)) {
    throw new Error(`input missing: ${args.media}`)
  }
  if (args.transcriptPath !== null && !existsSync(args.transcriptPath)) {
    throw new Error(`transcript missing: ${args.transcriptPath}`)
  }

  const session = await openSession(args.media)
  const cachedReport = cachedDetect(session.dir)
  const cached = cachedReport !== null && cachedReport.preset === args.preset

  const detectOptions: CliOptions = {
    input: args.media,
    preset: args.preset,
    minSilenceMs: 300,
    marginMs: 100,
    lang: args.lang,
    transcriptPath: args.transcriptPath,
    audioPath: null,
    skipVideoScan: true,
  }

  let report: DetectReport
  if (cached && cachedReport !== null) {
    report = cachedReport
  } else {
    report = await runDetect(detectOptions)
    writeCachedDetect(session.dir, report)
  }

  if (args.transcriptPath !== null) {
    mkdirSync(session.dir, { recursive: true })
    copyFileSync(args.transcriptPath, cachedTranscriptPath(session.dir))
  }
  const transcriptPresent =
    args.transcriptPath !== null || existsSync(cachedTranscriptPath(session.dir))

  // Point the cached detect.json's transcript.path at the session's own copy, once, here —
  // see pointCachedTranscriptAtSession's own doc for why this replaces per-reader patching.
  report = pointCachedTranscriptAtSession(session.dir, report)

  const blocks = deriveRefs(report.silences, report.durationMs)
  const refs = writeRefs(session.dir, args.preset, blocks)

  const found = findSuspects(report.silences, report.minSilenceMs, 0.4)
  const suspects: OpenSuspect[] = found.suspects
    .slice(0, SUSPECT_LIMIT)
    .map((suspect) => ({ ...suspect, nearestRef: nearestRef(suspect.atMs, refs.blocks) }))

  const openReport: OpenReport = {
    version: 1,
    sessionDir: session.dir,
    input: args.media,
    durationMs: report.durationMs,
    preset: args.preset,
    lang: args.lang,
    gen: refs.gen,
    cached,
    silenceCount: report.silences.length,
    blockCount: refs.blocks.length,
    transcriptPresent,
    suspects,
    fresh: session.fresh,
  }

  if (mode === 'json') {
    emitJson({ ...openReport, next: openNext(openReport) })
    return
  }
  console.log(human(openReport))
}
