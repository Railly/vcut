/**
 * The four views of one position, aligned in one call, with their disagreement made explicit.
 *
 * A review question at a position was always answered by juggling four instruments by hand:
 * what the whole-file transcript claims is there, what the audio actually says when asked
 * again over a short window, the speech/silence shape at a resolution fine enough to see a
 * filler's edges, and the level. On a real 11.7-minute run (2026-08-10, testing-10m.mp4),
 * about six calls went to nothing but settling disagreements between the first two views —
 * `removedText` or the whole-file transcript crying wolf, each wolf costing a separate
 * `say --transcribe` to confirm — plus a soft trailing "Me siento muy..." that neither
 * `silences` nor `detect` catches because it sits under both thresholds, but a transcriber
 * hears it plainly. `peek` puts all four views in one payload and names the disagreement
 * itself, rather than leaving an agent to notice it across four separate outputs.
 *
 * vcut still calls no model of its own here: `heard` runs the transcriber already on the
 * caller's PATH through `transcribeWindow`, the same way `say --transcribe` and `converge` do.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { normalise } from './converge.ts'
import { type Preset, parseSilenceLog, parseSrt, runDetect, type Word } from './detect.ts'
import { run } from './exec.ts'
import { emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import { measureLevel, wordsInWindow } from './say.ts'
import {
  cachedDetect,
  cachedTranscriptPath,
  checkSession,
  deriveRefs,
  openSession,
  type RefBlock,
  readRefs,
  writeCachedDetect,
  writeRefs,
} from './session.ts'
import { type Block, toBlocks } from './silences.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut peek - the four views of a position, aligned, with their disagreement named

Usage:
  vcut peek <media> --ref <ref> [--window <sec>] [--lang <code>] [flags]
  vcut peek <media> --at <sec> [--window <sec>] [--lang <code>] [flags]

Flags:
  --ref <ref>       A block ref from this session's refs.json (from vcut open)
  --at <sec>        A position in seconds, instead of a ref
  --window <sec>    Width of the span when using --at (default 4, centred on --at)
  --lang <code>     Language passed to the transcriber
  --json / --human  Output mode
  --help            Show this message

Resolves the session for <media> the way \`open\` does, then reports four views of the same
span: what the cached transcript claims (transcript), what the audio says when re-transcribed
just now (heard), the speech/silence shape at fine resolution (blocks), and the level
(level). viewsDisagree compares transcript against heard and names the kind of disagreement,
including the soft-speech class neither silences nor a level threshold alone can see. A
disagreement is a place to look, not a verdict: a short window transcribes noisily.`

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

const DEFAULT_WINDOW_S = 4

// --- Span resolution --------------------------------------------------------------------

export type Span = { startMs: number; endMs: number }

/**
 * The ref whose name resolves against this session's refs.json, or an error naming the ref
 * and the session's current gen. A ref from an old gen is a boundary the session no longer
 * has, and a typo'd ref is a boundary that never existed — both are usage errors, not a span
 * to guess at.
 */
export const resolveRef = (
  ref: string,
  refs: { gen: number; blocks: RefBlock[] } | null,
): RefBlock => {
  if (refs === null) {
    throw new UsageError(`no refs for this session yet. Run vcut open first.`)
  }
  const block = refs.blocks.find((candidate) => candidate.ref === ref)
  if (block === undefined) {
    throw new UsageError(
      `${ref} is not a known ref. The session is at gen ${refs.gen} with ${refs.blocks.length} blocks (b001..${refs.blocks.at(-1)?.ref ?? 'none'}). If ${ref} is from an earlier open with a different preset, it is a different gen and its boundaries no longer apply — run vcut open again to see current refs.`,
    )
  }
  return block
}

/** A span centred on `atMs`, `windowMs` wide, never starting before zero. */
export const spanFromAt = (atMs: number, windowMs: number): Span => {
  const half = windowMs / 2
  const startMs = Math.max(0, atMs - half)
  return { startMs, endMs: startMs + windowMs }
}

// --- Disagreement classification --------------------------------------------------------

export type DisagreeKind =
  | 'transcript-claims-more'
  | 'heard-more'
  | 'aligned'
  | 'soft-speech-below-threshold'

export type ViewsDisagree = {
  disagree: boolean
  kind: DisagreeKind
}

const CARRIES_MEANING = 4

const carryingWords = (text: string): string[] =>
  normalise(text)
    .split(' ')
    .filter((word) => word.length >= CARRIES_MEANING)

/**
 * Compares `transcript` (what the cached SRT claims inside the span) against `heard` (what a
 * fresh transcription of the same span says), on carrying words only — the same comparison
 * `converge` uses for the same reason: short words are grammar and drift between two
 * transcriptions of the same audio, so comparing them reports noise instead of disagreement.
 *
 * This is honestly limited. A short-window transcription is itself noisy, so a disagreement
 * here is a place to look, not a verdict — the same stance the manual takes on `audit`'s
 * correlation score and `edl build`'s removedText warning: a number that says "check this"
 * is doing its job even when the thing it points at turns out fine.
 *
 * `blocksAllSilence` narrows one case further: when the fine-resolution blocks say silence
 * for the whole span but `heard` still carries words, that is soft speech under the level
 * threshold — the "Me siento muy" class neither `silences` nor `detect` can see because both
 * work from the same volume floor a transcriber does not need.
 */
export const viewsDisagree = (
  transcriptText: string,
  heardText: string,
  blocksAllSilence: boolean,
): ViewsDisagree => {
  const transcriptCarrying = new Set(carryingWords(transcriptText))
  const heardCarrying = new Set(carryingWords(heardText))

  const transcriptOnly = [...transcriptCarrying].filter((word) => !heardCarrying.has(word))
  const heardOnly = [...heardCarrying].filter((word) => !transcriptCarrying.has(word))

  if (blocksAllSilence && heardCarrying.size > 0) {
    return { disagree: true, kind: 'soft-speech-below-threshold' }
  }
  if (transcriptOnly.length > 0 && heardOnly.length === 0) {
    return { disagree: true, kind: 'transcript-claims-more' }
  }
  if (heardOnly.length > 0) {
    return { disagree: true, kind: 'heard-more' }
  }
  return { disagree: false, kind: 'aligned' }
}

// --- next hints --------------------------------------------------------------------------

export const peekNext = (
  input: string,
  atMs: number,
  windowMs: number,
  disagree: ViewsDisagree,
): Array<{ question: string; verb: string }> => {
  if (!disagree.disagree) {
    return []
  }
  const wider = Math.round((windowMs / 1000) * 1.5)
  return [
    {
      question: 'settle the disagreement with a wider window',
      verb: `vcut say ${input} --transcribe --at ${(atMs / 1000).toFixed(2)} --window ${wider}`,
    },
    {
      question: 'place a boundary at fine resolution around this span',
      verb: `vcut silences ${input} --from ${(atMs / 1000 - windowMs / 2000).toFixed(2)} --to ${(atMs / 1000 + windowMs / 2000).toFixed(2)} --noise -33 --min 0.08`,
    },
  ]
}

// --- Command ------------------------------------------------------------------------------

export type PeekReport = {
  version: 1
  input: string
  sessionDir: string
  ref: string | null
  atMs: number
  spanStartMs: number
  spanEndMs: number
  transcript: { words: Array<{ text: string; startMs: number; endMs: number }>; note?: string }
  heard: { text: string }
  blocks: Block[]
  level: { peakDb: number | null; meanDb: number | null }
  viewsDisagree: ViewsDisagree
}

const humanReport = (report: PeekReport): string => {
  const lines = [
    heading(
      `${report.input.split('/').pop()}  ${(report.spanStartMs / 1000).toFixed(2)}-${(report.spanEndMs / 1000).toFixed(2)}s${report.ref === null ? '' : `  (${report.ref})`}`,
    ),
    line(
      'transcript',
      report.transcript.words.length === 0
        ? `(no words) ${report.transcript.note ?? ''}`.trim()
        : report.transcript.words.map((word) => word.text).join(' '),
    ),
    line('heard', report.heard.text === '' ? '(no words)' : report.heard.text),
    line(
      'level',
      report.level.peakDb === null
        ? 'not measured'
        : `peak ${report.level.peakDb} dB${report.level.meanDb === null ? '' : `, mean ${report.level.meanDb} dB`}`,
    ),
  ]
  for (const block of report.blocks) {
    lines.push(
      line(
        `${(block.startMs / 1000).toFixed(2)}-${(block.endMs / 1000).toFixed(2)}s`,
        `${block.kind}  (${block.durationMs}ms)`,
      ),
    )
  }
  lines.push(
    line(
      'viewsDisagree',
      report.viewsDisagree.disagree ? `yes: ${report.viewsDisagree.kind}` : 'no: aligned',
    ),
  )
  return lines.join('\n')
}

export const peekCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const media = positional(argv)
  if (media === undefined) {
    throw new UsageError(HELP)
  }
  const resolvedMedia = resolve(media)
  if (!existsSync(resolvedMedia)) {
    throw new Error(`input missing: ${resolvedMedia}`)
  }

  const refArg = flagValue(argv, '--ref')
  const atArg = numericFlag(argv, '--at')
  if (refArg === undefined && atArg === undefined) {
    throw new UsageError('peek needs --ref <ref> or --at <sec>')
  }
  if (refArg !== undefined && atArg !== undefined) {
    throw new UsageError('--ref and --at are mutually exclusive')
  }

  const windowSeconds = numericFlag(argv, '--window') ?? DEFAULT_WINDOW_S
  const windowMs = windowSeconds * 1000
  const lang = flagValue(argv, '--lang')

  // Resolve the session the way `open` does: create it if missing, use checkSession's cheap
  // path when it already exists. openSession itself already takes that cheap path (it hashes
  // once and compares against meta), so a plain call here is exactly the pattern the session
  // module was designed for; a re-hash only happens on the rare disagreement checkSession
  // would also re-hash for.
  const session = await openSession(resolvedMedia)
  if (!session.fresh) {
    const check = await checkSession(session.dir, resolvedMedia)
    if (check.status === 'sha-changed') {
      throw new UsageError(
        `${resolvedMedia} no longer matches this session (sha ${check.previousSha256.slice(0, 12)} -> ${check.currentSha256.slice(0, 12)}). Run vcut open again; the new content belongs to ${check.newSessionDir}.`,
      )
    }
  }

  let report = cachedDetect(session.dir)
  if (report === null) {
    const detectOptions = {
      input: resolvedMedia,
      preset: 'noisy' as Preset,
      minSilenceMs: 300,
      marginMs: 100,
      lang: lang ?? 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: true,
    }
    report = await runDetect(detectOptions)
    writeCachedDetect(session.dir, report)
  }

  let refs = readRefs(session.dir)
  if (refs === null) {
    const blocks = deriveRefs(report.silences, report.durationMs)
    refs = writeRefs(session.dir, report.preset, blocks)
  }

  let ref: string | null = null
  let span: Span
  if (refArg !== undefined) {
    const block = resolveRef(refArg, refs)
    ref = block.ref
    span = { startMs: block.startMs, endMs: block.endMs }
  } else {
    span = spanFromAt((atArg as number) * 1000, windowMs)
  }
  const atMs = Math.round((span.startMs + span.endMs) / 2)

  // View 1: transcript. Words the session's cached SRT claims inside the span.
  const transcriptPath = cachedTranscriptPath(session.dir)
  const transcriptView: PeekReport['transcript'] =
    existsSync(transcriptPath) === false
      ? { words: [], note: 'no transcript cached in this session' }
      : (() => {
          const parsed: { words: Word[] } = parseSrt(readFileSync(transcriptPath, 'utf8'))
          const words = wordsInWindow(parsed.words, span.startMs, span.endMs)
          return {
            words: words.map((word) => ({
              text: word.text,
              startMs: word.startMs,
              endMs: word.endMs,
            })),
          }
        })()

  // View 2: heard. Re-transcribe the span, the instrument that settles wolves.
  const heardText = await transcribeWindow(
    resolvedMedia,
    span.startMs,
    span.endMs,
    lang,
    'vcut-peek',
  )

  // View 3: blocks. Fine-resolution speech/silence over span ± 1s, the same threshold and
  // minimum `silences`' own manual entry names for placing a boundary around a filler.
  const fineFromMs = Math.max(0, span.startMs - 1000)
  const fineToMs = span.endMs + 1000
  const { stderr: fineLog, exitCode: fineExit } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-ss',
    (fineFromMs / 1000).toFixed(3),
    '-t',
    ((fineToMs - fineFromMs) / 1000).toFixed(3),
    '-i',
    resolvedMedia,
    '-af',
    'silencedetect=noise=-33dB:d=0.08',
    '-f',
    'null',
    '-',
  ])
  if (fineExit !== 0) {
    throw new Error(fineLog.trim() || 'ffmpeg could not measure fine-resolution blocks')
  }
  const fineDurationMs = fineToMs - fineFromMs
  const relative = parseSilenceLog(fineLog, fineDurationMs)
  const fineSilences = relative.map((silence) => ({
    kind: 'silence' as const,
    startMs: silence.startMs + fineFromMs,
    endMs: silence.endMs + fineFromMs,
    durationMs: silence.durationMs,
  }))
  const blocks = toBlocks(fineSilences, fineFromMs, fineToMs)

  // View 4: level, over the span itself (not the padded fine-resolution range).
  const level = await measureLevel(resolvedMedia, span.startMs, span.endMs)

  const blocksOverSpan = blocks.filter(
    (block) => block.endMs > span.startMs && block.startMs < span.endMs,
  )
  const blocksAllSilence =
    blocksOverSpan.length > 0 && blocksOverSpan.every((block) => block.kind === 'silence')

  const transcriptText = transcriptView.words.map((word) => word.text).join(' ')
  const disagree = viewsDisagree(transcriptText, heardText, blocksAllSilence)

  const peekReport: PeekReport = {
    version: 1,
    input: resolvedMedia,
    sessionDir: session.dir,
    ref,
    atMs,
    spanStartMs: span.startMs,
    spanEndMs: span.endMs,
    transcript: transcriptView,
    heard: { text: heardText },
    blocks,
    level,
    viewsDisagree: disagree,
  }

  if (mode === 'json') {
    emitJson({ ...peekReport, next: peekNext(resolvedMedia, atMs, windowMs, disagree) })
    return
  }
  console.log(humanReport(peekReport))
}
