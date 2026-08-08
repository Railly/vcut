import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { DetectReport, Interval, Transcript } from './detect.ts'
import { parseSrt } from './detect.ts'
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

const HELP = `vcut edl build - turn a detect report into a draft edit decision list

Usage:
  vcut edl build --detect <path> --output <master path> --campaign <id> [flags]

Flags:
  --detect <path>       Report produced by detect.ts (required)
  --output <path>       Where the rendered master will go (required)
  --campaign <id>       Campaign identifier (required)
  --edl <path>          Where to write the EDL (default ./edl.json)
  --width <n>           Output width (default: source width)
  --height <n>          Output height (default: source height)
  --fps <n>             Output frame rate (default: source rate)
  --no-fillers          Cut silences only, ignore filler candidates
  --json                Force JSON (default when stdout is not a TTY)
  --human               Force the human summary
  --help                Show this message

Every segment is written as proposed and the EDL as draft. Nothing is approved here.`

type BuildSummary = {
  status: 'drafted'
  edlPath: string
  segments: number
  cuts: number
  sourceDurationMs: number
  keptDurationMs: number
  removalPercent: number
  removalTargets: Record<string, string>
  wordBoundaryClamping: boolean
  warnings: string[]
}

const TARGET_RANGES: Array<{ label: string; low: number; high: number }> = [
  { label: 'event or interview', low: 30, high: 45 },
  { label: 'tutorial or screencast', low: 15, high: 25 },
  { label: 'scripted talking head', low: 10, high: 20 },
]

export const matchTarget = (removalPercent: number): string => {
  const hits = TARGET_RANGES.filter(
    (range) => removalPercent >= range.low && removalPercent <= range.high,
  )
  return hits.length === 0
    ? 'below every target range; the source may already be edited'
    : `in range for ${hits.map((range) => range.label).join(', ')}`
}

export const humanSummary = (summary: BuildSummary): string => {
  const fraction = summary.removalPercent / 100
  const lines = [
    heading(`${summary.segments} segments drafted`),
    line(
      'removed',
      `${bar(fraction)}  ${summary.removalPercent.toFixed(1)}%  (${duration(summary.sourceDurationMs - summary.keptDurationMs)})`,
    ),
    line('kept', `${duration(summary.keptDurationMs)} of ${duration(summary.sourceDurationMs)}`),
    line('cuts applied', String(summary.cuts)),
    line('target check', matchTarget(summary.removalPercent)),
    line('word clamping', summary.wordBoundaryClamping ? 'on' : 'off (no word-level transcript)'),
    line('approval', 'draft, every segment proposed'),
  ]
  for (const warning of summary.warnings) {
    lines.push(line('warning', warning))
  }
  lines.push(nextStep(`vcut render --edl ${summary.edlPath} --mode preview --dry-run`))
  return lines.join('\n')
}

export type Cut = Interval & {
  reason: 'silence' | 'filler'
}

export type KeptSegment = {
  id: string
  sourceId: string
  inMs: number
  outMs: number
  reason: string
  handlesMs: { before: number; after: number }
  approval: 'proposed'
  semanticRisk: 'none'
  crop: null
}

const MAX_SEGMENTS = 999

export const mergeIntervals = (intervals: Cut[]): Cut[] => {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs)
  const merged: Cut[] = []

  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs)
      if (last.reason !== interval.reason) {
        last.reason = 'silence'
      }
      continue
    }
    merged.push({ ...interval })
  }
  return merged
}

export const wordBoundaries = (transcript: Transcript): Interval[] =>
  transcript.words.map((word) => ({ startMs: word.startMs, endMs: word.endMs }))

export const clampToWords = (cut: Cut, boundaries: Interval[], minCutMs: number): Cut | null => {
  let startMs = cut.startMs
  let endMs = cut.endMs

  for (const word of boundaries) {
    if (word.startMs < startMs && word.endMs > startMs) {
      startMs = word.endMs
    }
    if (word.startMs < endMs && word.endMs > endMs) {
      endMs = word.startMs
    }
  }

  // A word-level transcript stretches each cue to the start of the next word, so a
  // spoken word's range routinely swallows the pause that follows it. Silence measured
  // from audio energy is the better evidence. When clamping shreds a cut into a sliver
  // shorter than the detector's own minimum, that remainder is overlap residue rather
  // than a real pause: keep the measured span instead of dropping the cut.
  if (endMs - startMs < minCutMs) {
    return cut.endMs - cut.startMs >= minCutMs ? { ...cut } : null
  }
  return { ...cut, startMs, endMs }
}

// Frame boundaries are not whole milliseconds: at 60fps a frame is 16.666...ms, so
// rounding a frame boundary back to an integer millisecond always lands slightly off
// it. ffmpeg then rounds each trim to the nearest frame on its own, and with enough
// segments those per-segment roundings accumulate past the renderer's one-frame
// tolerance. Landing on the middle of the frame instead of its edge puts every
// boundary as far as possible from the point where ffmpeg's rounding could flip,
// so the same frame is chosen every time regardless of segment count.
export const snapToFrame = (milliseconds: number, fps: number): number => {
  if (fps <= 0) {
    return Math.round(milliseconds)
  }
  const frameMs = 1000 / fps
  const frame = Math.round(milliseconds / frameMs)
  return Math.round(frame * frameMs + frameMs / 2)
}

export const invertToSegments = (
  cuts: Cut[],
  durationMs: number,
  sourceId: string,
  marginMs: number,
  fps = 0,
): KeptSegment[] => {
  const merged = mergeIntervals(cuts)
  const kept: Array<{ inMs: number; outMs: number; reason: string }> = []
  let cursor = 0

  for (const cut of merged) {
    if (cut.startMs > cursor) {
      kept.push({
        inMs: Math.max(0, cursor - (cursor === 0 ? 0 : marginMs)),
        outMs: Math.min(durationMs, cut.startMs + marginMs),
        reason: 'approved-line',
      })
    }
    cursor = cut.endMs
  }
  if (cursor < durationMs) {
    kept.push({
      inMs: Math.max(0, cursor - (cursor === 0 ? 0 : marginMs)),
      outMs: durationMs,
      reason: 'approved-line',
    })
  }

  return kept
    .map((segment) => ({
      ...segment,
      inMs: Math.max(0, snapToFrame(segment.inMs, fps)),
      outMs: Math.min(durationMs, snapToFrame(segment.outMs, fps)),
    }))
    .filter((segment) => segment.outMs > segment.inMs)
    .map((segment, index) => ({
      id: `segment-${String(index + 1).padStart(3, '0')}`,
      sourceId,
      inMs: segment.inMs,
      outMs: segment.outMs,
      reason: segment.reason,
      handlesMs: { before: marginMs, after: marginMs },
      approval: 'proposed' as const,
      semanticRisk: 'none' as const,
      crop: null,
    }))
}

const sha256 = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

type ProbeStream = {
  codec_type: 'video' | 'audio'
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
}

const probeSource = async (
  path: string,
): Promise<{ streams: ProbeStream[]; durationMs: number }> => {
  const { stdout, stderr, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels',
    '-of',
    'json',
    path,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffprobe exited with ${exitCode}`)
  }
  const parsed = JSON.parse(stdout) as { streams: ProbeStream[]; format: { duration: string } }
  return { streams: parsed.streams, durationMs: Math.round(Number(parsed.format.duration) * 1000) }
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'source'

type CliOptions = {
  detectPath: string
  outputPath: string
  edlPath: string
  campaignId: string
  width: number | null
  height: number | null
  fps: number | null
  includeFillers: boolean
}

const parseCli = (args: string[]): CliOptions => {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const detectPath = value('--detect')
  const outputPath = value('--output')
  const campaignId = value('--campaign')
  if (detectPath === undefined || outputPath === undefined || campaignId === undefined) {
    throw new UsageError(HELP)
  }
  const numeric = (flag: string) => (value(flag) === undefined ? null : Number(value(flag)))
  return {
    detectPath: resolve(detectPath),
    outputPath: resolve(outputPath),
    edlPath: resolve(value('--edl') ?? 'edl.json'),
    campaignId,
    width: numeric('--width'),
    height: numeric('--height'),
    fps: numeric('--fps'),
    includeFillers: !args.includes('--no-fillers'),
  }
}

const assertSegmentCount = (count: number): void => {
  if (count === 0) {
    throw new Error('no segments survive; every span was marked as a cut')
  }
  if (count > MAX_SEGMENTS) {
    throw new Error(
      `${count} segments exceed the schema limit of ${MAX_SEGMENTS}; raise --min-silence to merge more spans`,
    )
  }
}

const captionPaths = (report: DetectReport) => {
  const path = report.transcript.path ?? report.input
  return {
    language: report.lang,
    rawTranscriptPath: path,
    timedTokensPath: path,
    correctedTranscriptPath: path,
    dictionaryPath: path,
    burnedDerivative: false,
  }
}

const collectCuts = (report: DetectReport, includeFillers: boolean): Cut[] => [
  ...report.silences.map((silence) => ({
    startMs: silence.startMs,
    endMs: silence.endMs,
    reason: 'silence' as const,
  })),
  ...(includeFillers
    ? report.fillers.map((filler) => ({
        startMs: filler.startMs,
        endMs: filler.endMs,
        reason: 'filler' as const,
      }))
    : []),
]

export const buildEdlCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const options = parseCli(argv)
  if (!existsSync(options.detectPath)) {
    throw new Error(`detect report missing: ${options.detectPath}`)
  }
  const report = JSON.parse(readFileSync(options.detectPath, 'utf8')) as DetectReport
  if (!existsSync(report.input)) {
    throw new Error(`source missing: ${report.input}`)
  }

  const cuts = collectCuts(report, options.includeFillers)

  const transcript =
    report.transcript.path !== null && existsSync(report.transcript.path)
      ? parseSrt(readFileSync(report.transcript.path, 'utf8'))
      : { words: [], wordLevel: false }
  const boundaries = transcript.wordLevel ? wordBoundaries(transcript) : []
  const clamped =
    boundaries.length === 0
      ? cuts
      : cuts
          .map((cut) => clampToWords(cut, boundaries, report.minSilenceMs))
          .filter((cut): cut is Cut => cut !== null)

  const probe = await probeSource(report.input)
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  if (video === undefined) {
    throw new Error('source has no video stream')
  }

  const frameRate = video.r_frame_rate ?? '30/1'
  const [numerator, denominator] = frameRate.split('/').map(Number)
  const outputFps = options.fps ?? (denominator === 0 ? 30 : numerator / denominator)

  const sourceId = slug(report.input.split('/').pop() ?? 'source')
  const segments = invertToSegments(clamped, probe.durationMs, sourceId, report.marginMs, outputFps)
  assertSegmentCount(segments.length)

  const keptMs = segments.reduce((total, segment) => total + segment.outMs - segment.inMs, 0)
  const removalPercent = ((probe.durationMs - keptMs) / probe.durationMs) * 100

  const edl = {
    version: 1,
    campaignId: options.campaignId,
    createdAt: new Date().toISOString(),
    timebase: 'milliseconds',
    sources: [
      {
        id: sourceId,
        path: report.input,
        sha256: await sha256(report.input),
        durationMs: probe.durationMs,
        hasVideo: true,
        hasAudio: audio !== undefined,
        averageFrameRate: video.avg_frame_rate ?? frameRate,
        sampleRateHz: audio?.sample_rate === undefined ? null : Number(audio.sample_rate),
        channels: audio?.channels ?? null,
      },
    ],
    segments,
    audio: {
      speechTargetLufs: -16,
      truePeakMaxDbtp: -1,
      noiseReduction: 'off',
      externalAudioSourceId: null,
      syncOffsetMs: 0,
    },
    captions: captionPaths(report),
    output: {
      path: options.outputPath,
      width: options.width ?? video.width ?? 1920,
      height: options.height ?? video.height ?? 1080,
      fps: outputFps,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      audioTrackPolicy: audio === undefined ? 'explicit-silence' : 'required',
      overwrite: false,
    },
    approval: {
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
    },
  }

  writeFileSync(options.edlPath, `${JSON.stringify(edl, null, 2)}\n`)

  const summary: BuildSummary = {
    status: 'drafted',
    edlPath: options.edlPath,
    segments: segments.length,
    cuts: clamped.length,
    sourceDurationMs: probe.durationMs,
    keptDurationMs: keptMs,
    removalPercent: Number(removalPercent.toFixed(2)),
    removalTargets: {
      'event-interview': '30-45%',
      'tutorial-screencast': '15-25%',
      'scripted-talking-head': '10-20%',
    },
    wordBoundaryClamping: boundaries.length > 0,
    warnings: report.warnings,
  }
  if (mode === 'json') {
    emitJson(summary)
    return
  }
  console.log(humanSummary(summary))
}
