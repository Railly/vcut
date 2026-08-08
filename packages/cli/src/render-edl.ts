import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { run, runInherit } from './exec.ts'

const HELP = `vcut render - render an EDL to video

Usage:
  vcut render --edl <path> [flags]

Flags:
  --edl <path>          Edit decision list to render (required)
  --output <path>       Override the output path in the EDL
  --mode <name>         preview (default) | master
  --dry-run             Print the ffmpeg command without running it
  --help                Show this message

Preview mode accepts proposed segments. Master mode requires an approved EDL,
approved segments, matching source hashes, and a free output path.`

type Source = {
  id: string
  path: string
  sha256: string
  durationMs: number
  hasVideo: boolean
  hasAudio: boolean
}

type Segment = {
  id: string
  sourceId: string
  inMs: number
  outMs: number
  approval: 'proposed' | 'approved' | 'rejected'
  crop?: {
    x: number
    y: number
    width: number
    height: number
  } | null
}

export type Edl = {
  timebase: 'milliseconds'
  sources: Source[]
  segments: Segment[]
  audio: {
    noiseReduction: 'off' | 'light' | 'manual'
    externalAudioSourceId: string | null
    syncOffsetMs: number
  }
  output: {
    path: string
    width: number
    height: number
    fps: number
    videoCodec: 'h264' | 'hevc'
    pixelFormat: string
    colorSpace: string
    audioTrackPolicy: 'required' | 'forbidden' | 'explicit-silence'
    overwrite: false
  }
  approval: {
    status: 'draft' | 'approved' | 'rejected'
    approvedAt: string | null
    approvedBy: string | null
  }
}

type Mode = 'preview' | 'master'

type CliOptions = {
  edlPath: string
  outputPath?: string
  mode: Mode
  dryRun: boolean
}

export type OutputProbe = {
  streams: Array<{
    codec_type: 'video' | 'audio'
    width?: number
    height?: number
    pix_fmt?: string
    color_range?: string
    color_space?: string
    color_transfer?: string
    color_primaries?: string
    r_frame_rate?: string
    nb_read_frames?: string
    sample_rate?: string
    channels?: number
  }>
  format: {
    duration: string
  }
}

const seconds = (milliseconds: number): string =>
  (milliseconds / 1000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')

const cropErrors = (segment: Segment): string[] => {
  if (segment.crop === undefined || segment.crop === null) {
    return []
  }
  const crop = segment.crop
  return crop.x < 0 ||
    crop.y < 0 ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.x + crop.width > 1 ||
    crop.y + crop.height > 1
    ? [`${segment.id}: crop exceeds source bounds`]
    : []
}

const segmentErrors = (
  segment: Segment,
  sourceMap: Map<string, Source>,
  policy: Edl['output']['audioTrackPolicy'],
  mode: Mode,
): string[] => {
  const errors: string[] = []
  const source = sourceMap.get(segment.sourceId)

  if (source === undefined) {
    return [`${segment.id}: unknown source`]
  }
  if (!source.hasVideo) {
    errors.push(`${segment.id}: source lacks video`)
  }
  if (policy === 'required' && !source.hasAudio) {
    errors.push(`${segment.id}: source lacks required audio`)
  }
  if (segment.inMs < 0 || segment.outMs <= segment.inMs || segment.outMs > source.durationMs) {
    errors.push(`${segment.id}: invalid interval`)
  }
  if (mode === 'master' && segment.approval !== 'approved') {
    errors.push(`${segment.id}: master requires approved segment`)
  }
  errors.push(...cropErrors(segment))
  return errors
}

const approvalErrors = (edl: Edl, mode: Mode): string[] => {
  if (mode !== 'master') {
    return []
  }
  const errors: string[] = []
  if (edl.approval.status !== 'approved') {
    errors.push('master requires approved EDL')
  }
  if (edl.approval.approvedAt === null || edl.approval.approvedBy === null) {
    errors.push('master requires approval identity')
  }
  return errors
}

export const edlErrors = (edl: Edl, mode: Mode): string[] => {
  const sourceMap = new Map(edl.sources.map((source) => [source.id, source]))
  const segmentIds = new Set(edl.segments.map((segment) => segment.id))
  const errors = [
    ...(edl.timebase === 'milliseconds' ? [] : ['unsupported timebase']),
    ...(edl.sources.length === sourceMap.size ? [] : ['duplicate source ID']),
    ...(edl.segments.length === segmentIds.size ? [] : ['duplicate segment ID']),
    ...(edl.segments.length > 0 ? [] : ['no segments']),
    ...(edl.output.overwrite === false ? [] : ['output overwrite must be false']),
    ...(edl.output.pixelFormat === 'yuv420p' ? [] : ['unsupported V1 pixel format']),
    ...(edl.output.colorSpace === 'bt709' ? [] : ['unsupported V1 color space']),
    ...(edl.audio.externalAudioSourceId === null ? [] : ['external audio is not implemented']),
    ...(edl.audio.syncOffsetMs === 0 ? [] : ['audio sync offset is not implemented']),
    ...(edl.audio.noiseReduction === 'off' ? [] : ['noise reduction is not implemented']),
    ...approvalErrors(edl, mode),
  ]
  for (const segment of edl.segments) {
    errors.push(...segmentErrors(segment, sourceMap, edl.output.audioTrackPolicy, mode))
  }
  return errors
}

export const buildFfmpegArgs = (edl: Edl, outputPath: string): string[] => {
  const sourceIndex = new Map(edl.sources.map((source, index) => [source.id, index]))
  const filters: string[] = []
  const concatInputs: string[] = []
  const width = edl.output.width
  const height = edl.output.height
  const fps = edl.output.fps
  const policy = edl.output.audioTrackPolicy

  for (const [index, segment] of edl.segments.entries()) {
    const input = sourceIndex.get(segment.sourceId)
    if (input === undefined) {
      throw new Error(`${segment.id}: unknown source`)
    }
    const crop = segment.crop ?? { x: 0, y: 0, width: 1, height: 1 }
    const duration = seconds(segment.outMs - segment.inMs)
    filters.push(
      `[${input}:v]trim=start=${seconds(segment.inMs)}:end=${seconds(segment.outMs)},setpts=PTS-STARTPTS,crop=trunc(iw*${crop.width}/2)*2:trunc(ih*${crop.height}/2)*2:trunc(iw*${crop.x}/2)*2:trunc(ih*${crop.y}/2)*2,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=${fps},format=${edl.output.pixelFormat}[v${index}]`,
    )
    concatInputs.push(`[v${index}]`)

    if (policy === 'required') {
      filters.push(
        `[${input}:a]atrim=start=${seconds(segment.inMs)}:end=${seconds(segment.outMs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[a${index}]`,
      )
      concatInputs.push(`[a${index}]`)
    }
    if (policy === 'explicit-silence') {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${index}]`)
      concatInputs.push(`[a${index}]`)
    }
  }

  const hasAudio = policy !== 'forbidden'
  filters.push(
    `${concatInputs.join('')}concat=n=${edl.segments.length}:v=1:a=${hasAudio ? 1 : 0}[v]${hasAudio ? '[a]' : ''}`,
  )

  const codec = edl.output.videoCodec === 'h264' ? 'libx264' : 'libx265'
  const args = edl.sources.flatMap((source) => ['-i', source.path])
  args.push('-filter_complex', filters.join(';'), '-map', '[v]')
  if (hasAudio) {
    args.push('-map', '[a]', '-c:a', 'aac', '-ar', '48000', '-ac', '2')
  } else {
    args.push('-an')
  }
  args.push(
    '-c:v',
    codec,
    '-preset',
    'medium',
    '-crf',
    '18',
    '-pix_fmt',
    edl.output.pixelFormat,
    '-r',
    String(edl.output.fps),
    '-color_range',
    'tv',
    '-colorspace',
    edl.output.colorSpace,
    '-color_primaries',
    edl.output.colorSpace,
    '-color_trc',
    edl.output.colorSpace,
    '-movflags',
    '+faststart',
    '-threads',
    '1',
    '-metadata',
    'creation_time=1970-01-01T00:00:00Z',
    outputPath,
  )
  return args
}

const parseRate = (rate: string): number => {
  const [numerator, denominator] = rate.split('/').map(Number)
  return denominator === 0 ? 0 : numerator / denominator
}

const videoOutputErrors = (
  edl: Edl,
  video: OutputProbe['streams'][number],
  duration: string,
): string[] => {
  const errors: string[] = []
  const expectedDuration = edl.segments.reduce(
    (total, segment) => total + segment.outMs - segment.inMs,
    0,
  )
  const observedDuration = Number(duration) * 1000
  const toleranceMs = 2000 / edl.output.fps + 20
  const expectedFrames = Math.round((expectedDuration / 1000) * edl.output.fps)
  const observedFrames = Number(video.nb_read_frames)

  if (video.width !== edl.output.width || video.height !== edl.output.height) {
    errors.push('render dimensions differ from EDL')
  }
  if (video.pix_fmt !== edl.output.pixelFormat) {
    errors.push('render pixel format differs from EDL')
  }
  if (
    video.color_range !== 'tv' ||
    video.color_space !== edl.output.colorSpace ||
    video.color_transfer !== edl.output.colorSpace ||
    video.color_primaries !== edl.output.colorSpace
  ) {
    errors.push('render color metadata differs from EDL')
  }
  if (
    video.r_frame_rate === undefined ||
    Math.abs(parseRate(video.r_frame_rate) - edl.output.fps) > 0.001
  ) {
    errors.push('render frame rate differs from EDL')
  }
  if (!Number.isFinite(observedFrames) || Math.abs(observedFrames - expectedFrames) > 1) {
    errors.push('render frame count differs from EDL duration')
  }
  if (
    !Number.isFinite(observedDuration) ||
    Math.abs(observedDuration - expectedDuration) > toleranceMs
  ) {
    errors.push('render duration differs from EDL')
  }
  return errors
}

const audioOutputErrors = (
  policy: Edl['output']['audioTrackPolicy'],
  audio: OutputProbe['streams'][number] | undefined,
): string[] => {
  const errors: string[] = []
  if (policy === 'forbidden' && audio !== undefined) {
    errors.push('render contains forbidden audio')
  }
  if (policy !== 'forbidden' && audio === undefined) {
    errors.push('render lacks required audio track')
  }
  if (audio !== undefined && (audio.sample_rate !== '48000' || audio.channels !== 2)) {
    errors.push('render audio contract differs from EDL')
  }
  return errors
}

export const outputErrors = (edl: Edl, probe: OutputProbe): string[] => {
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  if (video === undefined) {
    return ['render lacks video']
  }
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  return [
    ...videoOutputErrors(edl, video, probe.format.duration),
    ...audioOutputErrors(edl.output.audioTrackPolicy, audio),
  ]
}

const probeOutput = async (path: string): Promise<OutputProbe> => {
  const { stdout, stderr, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames,sample_rate,channels',
    '-of',
    'json',
    path,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffprobe exited with ${exitCode}`)
  }
  return JSON.parse(stdout) as OutputProbe
}

const sha256 = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

const parseCli = (args: string[]): CliOptions => {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const edlPath = value('--edl')
  const modeValue = value('--mode') ?? 'preview'
  if (edlPath === undefined) {
    throw new Error(
      'Usage: render-edl.ts --edl <path> [--output <path>] [--mode preview|master] [--dry-run]',
    )
  }
  if (modeValue !== 'preview' && modeValue !== 'master') {
    throw new Error('mode must be preview or master')
  }
  return {
    edlPath: resolve(edlPath),
    outputPath: value('--output') === undefined ? undefined : resolve(value('--output') as string),
    mode: modeValue,
    dryRun: args.includes('--dry-run'),
  }
}

export const renderCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const options = parseCli(argv)
  const edl = JSON.parse(readFileSync(options.edlPath, 'utf8')) as Edl
  const errors = edlErrors(edl, options.mode)
  const outputPath = options.outputPath ?? edl.output.path

  for (const source of edl.sources) {
    if (!existsSync(source.path)) {
      errors.push(`${source.id}: source missing`)
      continue
    }
    const observed = await sha256(source.path)
    if (observed !== source.sha256) {
      errors.push(`${source.id}: source hash mismatch`)
    }
  }
  if (existsSync(outputPath)) {
    errors.push('output already exists')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  const args = buildFfmpegArgs(edl, outputPath)
  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          status: 'ready',
          mode: options.mode,
          sources: edl.sources.length,
          segments: edl.segments.length,
          expectedDurationMs: edl.segments.reduce(
            (total, segment) => total + segment.outMs - segment.inMs,
            0,
          ),
          outputPath,
          command: ['ffmpeg', ...args],
        },
        null,
        2,
      ),
    )
    return
  }

  const exitCode = await runInherit('ffmpeg', ['-v', 'error', ...args])
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with ${exitCode}`)
  }
  const probe = await probeOutput(outputPath)
  const validationErrors = outputErrors(edl, probe)
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join('\n'))
  }
  console.log(
    JSON.stringify({
      status: 'rendered',
      outputPath,
      sha256: await sha256(outputPath),
      duration: probe.format.duration,
      frames: probe.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames,
    }),
  )
}
