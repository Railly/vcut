import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { run } from './exec.ts'
import {
  bar,
  duration,
  emitJson,
  heading,
  line,
  type Mode,
  nextStep,
  resolveMode,
  UsageError,
} from './output.ts'

const HELP = `vcut detect - deterministic cut candidates for a recording

Usage:
  vcut detect <input> [flags]
  vcut detect --input <path> [flags]

Flags:
  --input <path>        Source recording (also accepted positionally)
  --preset <name>       noisy (-20dB, default) | clean (-30dB) | podcast (-35dB)
  --min-silence <sec>   Minimum silence to consider a cut (default 0.3)
  --margin <sec>        Padding kept around speech (default 0.10)
  --lang <code>         es | en | pt (default es), selects the filler list
  --audio <path>        Separate audio recording; silence is measured on this
  --transcript <path>   SRT used for word clamping; must be word-level
  --skip-video-scan     Skip black and frozen frame detection
  --json                Force JSON (default when stdout is not a TTY)
  --human               Force the human summary
  --help                Show this message

Filler cutting needs word-level timestamps. Generate them with:
  whisper-cli --max-len 1 --split-on-word`

export type Preset = 'noisy' | 'clean' | 'podcast'
// Free-form, not an enum: it is passed through to the semantic export so a model knows what
// it is reading. Nothing here parses the language itself.
export type Lang = string

export type Interval = {
  startMs: number
  endMs: number
}

export type SilenceCandidate = Interval & {
  kind: 'silence'
  durationMs: number
}

export type ReviewCandidate = Interval & {
  kind: 'clipping' | 'black' | 'frozen'
  detail: string
}

export type Word = {
  text: string
  startsWord?: boolean
  startMs: number
  endMs: number
}

export type Transcript = {
  words: Word[]
  wordLevel: boolean
}

export type DetectReport = {
  version: 1
  input: string
  durationMs: number
  preset: Preset
  thresholdDb: number
  minSilenceMs: number
  marginMs: number
  lang: Lang
  transcript: {
    path: string | null
    wordLevel: boolean
    words: number
  }
  // Carried so `edl build` writes the second source without being told twice, and so the
  // report says which waveform its silences came from.
  audioPath: string | null
  silences: SilenceCandidate[]
  review: ReviewCandidate[]
  warnings: string[]
}

export const PRESET_DB: Record<Preset, number> = {
  noisy: -20,
  clean: -30,
  podcast: -35,
}

const DEFAULT_MIN_SILENCE_MS = 300
const DEFAULT_MARGIN_MS = 100

const BOOLEAN_FLAGS = new Set(['--json', '--human', '--help', '--dry-run', '--skip-video-scan'])

export const parseSilenceLog = (stderr: string, durationMs: number): SilenceCandidate[] => {
  const candidates: SilenceCandidate[] = []
  let openStart: number | null = null

  for (const line of stderr.split('\n')) {
    const start = line.match(/silence_start:\s*(-?[\d.]+)/)
    if (start !== null) {
      openStart = Math.max(0, Math.round(Number(start[1]) * 1000))
      continue
    }
    const end = line.match(/silence_end:\s*([\d.]+)/)
    if (end !== null && openStart !== null) {
      const endMs = Math.round(Number(end[1]) * 1000)
      candidates.push({
        kind: 'silence',
        startMs: openStart,
        endMs,
        durationMs: endMs - openStart,
      })
      openStart = null
    }
  }

  if (openStart !== null && durationMs > openStart) {
    candidates.push({
      kind: 'silence',
      startMs: openStart,
      endMs: durationMs,
      durationMs: durationMs - openStart,
    })
  }
  return candidates
}

const timestampMs = (stamp: string): number => {
  const match = stamp.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (match === null) {
    return 0
  }
  const [, hours, minutes, secs, millis] = match
  return (
    Number(hours) * 3600000 +
    Number(minutes) * 60000 +
    Number(secs) * 1000 +
    Number(millis.padEnd(3, '0').slice(0, 3))
  )
}

export const parseSrt = (content: string): Transcript => {
  const words: Word[] = []
  const blocks = content.replace(/\r/g, '').split(/\n\s*\n/)

  for (const block of blocks) {
    const lines = block.split('\n').filter((line) => line.trim() !== '')
    const timeIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeIndex === -1) {
      continue
    }
    const [rawStart, rawEnd] = lines[timeIndex].split('-->')
    const raw = lines.slice(timeIndex + 1).join(' ')
    const text = raw.trim()
    if (text === '') {
      continue
    }
    // Whisper marks a word boundary with a leading space, and a cue without one continues
    // the previous word ("Cra" then "fter"). Trimming loses the only evidence of where one
    // word ends, so it is recorded here; text keeps its trimmed shape for every caller that
    // matches on it.
    words.push({
      text,
      startsWord: /^\s/.test(raw),
      startMs: timestampMs(rawStart),
      endMs: timestampMs(rawEnd),
    })
  }

  const multiWordCues = words.filter((word) => word.text.trim().split(/\s+/).length > 1).length
  return { words, wordLevel: words.length > 0 && multiWordCues === 0 }
}

// A transcript can outlive the cut it was made from: trim the source afterwards and its tail
// still describes speech the video no longer contains. Reporting those as candidates would
// claim candidates at timestamps a reviewer cannot even seek to.
export const withinSource = <T extends Interval>(candidates: T[], durationMs: number): T[] =>
  candidates.filter((candidate) => candidate.endMs <= durationMs)

export const parseBlackLog = (stderr: string): ReviewCandidate[] => {
  const candidates: ReviewCandidate[] = []
  for (const line of stderr.split('\n')) {
    const match = line.match(/black_start:\s*([\d.]+)[\s\S]*?black_end:\s*([\d.]+)/)
    if (match !== null) {
      candidates.push({
        kind: 'black',
        startMs: Math.round(Number(match[1]) * 1000),
        endMs: Math.round(Number(match[2]) * 1000),
        detail: 'black frames',
      })
    }
  }
  return candidates
}

export const parseFreezeLog = (stderr: string): ReviewCandidate[] => {
  const candidates: ReviewCandidate[] = []
  let openStart: number | null = null
  for (const line of stderr.split('\n')) {
    const start = line.match(/freeze_start:\s*([\d.]+)/)
    if (start !== null) {
      openStart = Math.round(Number(start[1]) * 1000)
      continue
    }
    const end = line.match(/freeze_end:\s*([\d.]+)/)
    if (end !== null && openStart !== null) {
      candidates.push({
        kind: 'frozen',
        startMs: openStart,
        endMs: Math.round(Number(end[1]) * 1000),
        detail: 'frozen frames',
      })
      openStart = null
    }
  }
  return candidates
}

export const parseClipping = (stderr: string, durationMs: number): ReviewCandidate[] => {
  const peaks = [...stderr.matchAll(/Peak level dB:\s*(-?[\d.]+|inf)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value))
  const peak = peaks.length === 0 ? null : Math.max(...peaks)
  if (peak === null || peak < -1) {
    return []
  }
  return [
    {
      kind: 'clipping',
      startMs: 0,
      endMs: durationMs,
      detail: `peak level ${peak.toFixed(2)} dB exceeds -1 dBFS`,
    },
  ]
}

const runFfmpeg = async (args: string[]): Promise<string> => {
  const { stderr, exitCode } = await run('ffmpeg', ['-hide_banner', '-nostats', ...args])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with ${exitCode}`)
  }
  return stderr
}

export const probeDurationMs = async (path: string): Promise<number> => {
  const { stdout, stderr, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    path,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffprobe exited with ${exitCode}`)
  }
  const parsed = JSON.parse(stdout) as { format: { duration: string } }
  return Math.round(Number(parsed.format.duration) * 1000)
}

type CliOptions = {
  input: string
  preset: Preset
  minSilenceMs: number
  marginMs: number
  lang: Lang
  transcriptPath: string | null
  audioPath: string | null
  skipVideoScan: boolean
}

export const positional = (args: string[]): string | undefined => {
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
  const input = value('--input') ?? positional(args)
  if (input === undefined) {
    throw new UsageError(HELP)
  }
  const preset = (value('--preset') ?? 'noisy') as Preset
  if (PRESET_DB[preset] === undefined) {
    throw new UsageError('preset must be noisy, clean, or podcast')
  }
  const lang = value('--lang') ?? 'es'
  const minSilence = value('--min-silence')
  const margin = value('--margin')
  return {
    input: resolve(input),
    preset,
    minSilenceMs:
      minSilence === undefined ? DEFAULT_MIN_SILENCE_MS : Math.round(Number(minSilence) * 1000),
    marginMs: margin === undefined ? DEFAULT_MARGIN_MS : Math.round(Number(margin) * 1000),
    lang,
    transcriptPath:
      value('--transcript') === undefined ? null : resolve(value('--transcript') as string),
    audioPath: value('--audio') === undefined ? null : resolve(value('--audio') as string),
    skipVideoScan: args.includes('--skip-video-scan'),
  }
}

const loadTranscript = (
  path: string | null,
  warnings: string[],
): { transcript: Transcript; path: string | null } => {
  if (path === null) {
    return { transcript: { words: [], wordLevel: false }, path: null }
  }
  if (!existsSync(path)) {
    throw new Error(`transcript missing: ${path}`)
  }
  const transcript = parseSrt(readFileSync(path, 'utf8'))
  if (!transcript.wordLevel) {
    warnings.push(
      'transcript is not word-level; filler detection skipped. Regenerate with `trx transcribe <input> --words` or `whisper-cli --max-len 1 --output-srt`',
    )
  }
  return { transcript, path }
}

export const humanReport = (report: DetectReport): string => {
  const removable = report.silences.reduce((total, silence) => total + silence.durationMs, 0)
  const fraction = report.durationMs === 0 ? 0 : removable / report.durationMs
  const longest = [...report.silences].sort((left, right) => right.durationMs - left.durationMs)[0]

  const marginGiveback = report.silences.length * report.marginMs * 2
  const netMs = Math.max(0, removable - marginGiveback)
  const netFraction = report.durationMs === 0 ? 0 : netMs / report.durationMs

  const lines = [
    heading(`${report.input.split('/').pop()}  ${duration(report.durationMs)}`),
    line(
      'detected dead air',
      `${bar(fraction)}  ${(fraction * 100).toFixed(1)}%  (${duration(removable)})`,
    ),
    line(
      'net after margins',
      `${bar(netFraction)}  ${(netFraction * 100).toFixed(1)}%  (~${duration(netMs)} once ${report.marginMs}ms is kept on each side)`,
    ),
    line('silences', `${report.silences.length} spans, ${duration(removable)}`),
  ]

  if (longest !== undefined) {
    lines.push(
      line('longest silence', `${duration(longest.durationMs)} at ${duration(longest.startMs)}`),
    )
  }
  lines.push(
    line(
      'filler words',
      'not scanned; a word list cannot tell filler from ordinary use. Run vcut semantic.',
    ),
  )
  if (report.review.length > 0) {
    lines.push(line('review candidates', `${report.review.length} (never cut automatically)`))
    for (const candidate of report.review.slice(0, 3)) {
      lines.push(line('', `${candidate.kind}: ${candidate.detail}`))
    }
  }
  lines.push(line('preset', `${report.preset} (${report.thresholdDb} dB)`))

  for (const warning of report.warnings) {
    lines.push(line('warning', warning))
  }
  lines.push(nextStep(`vcut detect ${report.input} --preset ${report.preset} --json > detect.json`))
  return lines.join('\n')
}

export const detectCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const options = parseCli(argv)
  if (!existsSync(options.input)) {
    throw new Error(`input missing: ${options.input}`)
  }

  if (options.audioPath !== null && !existsSync(options.audioPath)) {
    throw new Error(`audio missing: ${options.audioPath}`)
  }

  const warnings: string[] = []
  const durationMs = await probeDurationMs(options.input)
  const thresholdDb = PRESET_DB[options.preset]
  const minSilenceSeconds = (options.minSilenceMs / 1000).toString()

  // Silence and clipping are measured on whatever audio will end up in the render. With a
  // separate recorder that is not the camera track, and measuring the wrong one would cut
  // against a waveform nobody hears.
  const audioInput = options.audioPath ?? options.input
  if (options.audioPath !== null) {
    const audioMs = await probeDurationMs(options.audioPath)
    // A drift of a frame or two is normal between two encoders; anything larger means the
    // recordings do not describe the same take and the cuts would land in the wrong place.
    if (Math.abs(audioMs - durationMs) > 1000) {
      warnings.push(
        `audio runs ${audioMs}ms against a ${durationMs}ms source; check they are the same take`,
      )
    }
  }

  const silenceLog = await runFfmpeg([
    '-i',
    audioInput,
    '-af',
    `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSeconds}`,
    '-f',
    'null',
    '-',
  ])
  const silences = parseSilenceLog(silenceLog, durationMs)

  const statsLog = await runFfmpeg([
    '-i',
    audioInput,
    '-af',
    'astats=metadata=1:reset=0',
    '-f',
    'null',
    '-',
  ])
  const review: ReviewCandidate[] = [...parseClipping(statsLog, durationMs)]

  if (!options.skipVideoScan) {
    const videoLog = await runFfmpeg([
      '-i',
      options.input,
      '-vf',
      'blackdetect=d=0.2:pix_th=0.10,freezedetect=n=-60dB:d=2',
      '-f',
      'null',
      '-',
    ])
    review.push(...parseBlackLog(videoLog), ...parseFreezeLog(videoLog))
  } else {
    warnings.push('video scan skipped; black and frozen frame candidates not collected')
  }

  const { transcript, path } = loadTranscript(options.transcriptPath, warnings)

  const report: DetectReport = {
    version: 1,
    input: options.input,
    durationMs,
    preset: options.preset,
    thresholdDb,
    minSilenceMs: options.minSilenceMs,
    marginMs: options.marginMs,
    lang: options.lang,
    transcript: { path, wordLevel: transcript.wordLevel, words: transcript.words.length },
    audioPath: options.audioPath,
    silences,
    review,
    warnings,
  }
  if (mode === 'json') {
    emitJson(report)
    return
  }
  console.log(humanReport(report))
}
