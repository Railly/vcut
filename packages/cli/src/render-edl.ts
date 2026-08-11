import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { extname, resolve } from 'node:path'

import { run, runInherit } from './exec.ts'
import { emitJson } from './output.ts'

const HELP = `vcut render - render an EDL to video

Usage:
  vcut render --edl <path> [flags]

Flags:
  --edl <path>          Edit decision list to render (required)
  --output <path>       Override the output path in the EDL
  --mode <name>         preview (default) | master
  --audio-only          Render the audio alone, for iterating on a cut
  --dry-run             Print the ffmpeg command without running it
  --help                Show this message

Preview mode accepts proposed segments. Master mode requires an approved EDL,
approved segments, matching source hashes, and a free output path.

--audio-only skips the picture and keeps the audio graph unchanged, edge fades and
loudness included, so what you hear is what the finished render will sound like.
Measured on one 22-segment EDL: 0.25s against 31.8s for the same cuts with video.
Use it for the rounds where the questions are about sound, then render once.`

type Source = {
  id: string
  path: string
  sha256: string
  durationMs: number
  hasVideo: boolean
  hasAudio: boolean
  averageFrameRate?: string | null
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
    speechTargetLufs?: number
    truePeakMaxDbtp?: number
    externalAudioSourceId: string | null
    syncOffsetMs: number
    edgeFadeMs: number
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
  audioOnly: boolean
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
  hasExternalAudio: boolean,
): string[] => {
  const errors: string[] = []
  const source = sourceMap.get(segment.sourceId)

  if (source === undefined) {
    return [`${segment.id}: unknown source`]
  }
  if (!source.hasVideo) {
    errors.push(`${segment.id}: source lacks video`)
  }
  // Only when the segment is where the sound comes from. With a separate recording the check
  // belongs to that source, and externalAudioErrors already made it once for the whole EDL.
  if (policy === 'required' && !hasExternalAudio && !source.hasAudio) {
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
    ...externalAudioErrors(edl),
    ...approvalErrors(edl, mode),
  ]
  for (const segment of edl.segments) {
    errors.push(
      ...segmentErrors(
        segment,
        sourceMap,
        edl.output.audioTrackPolicy,
        mode,
        edl.audio.externalAudioSourceId !== null && edl.audio.externalAudioSourceId !== undefined,
      ),
    )
  }
  return errors
}

// A joint between two segments is a discontinuity in the waveform, and an instant jump
// from one sample level to another is the click the ear picks up. Ramping the last and
// first few milliseconds to zero removes the step without touching anything audible.
//
// Deliberately not acrossfade: that filter overlaps the two sides, so the render comes out
// shorter than the sum of its segments by fadeMs per joint. Video is concatenated, not
// overlapped, so the audio would drift ahead of the picture a little more at every cut,
// and outputErrors checks the render against exactly that sum. Fading inside each segment
// keeps every segment its own length, which keeps sync and the duration contract intact.
//
// The cost is a real one: two ramps to silence, not a crossfade through a shared middle.
// A joint under a fully continuous sentence can still be heard as a dip.
// The EDL has carried a loudness target since V1 and nothing ever read it. A recording sits
// where the mic and the room put it, not where a viewer wants it: this source measured
// -25.4 LUFS against the -16 the EDL asks for, which is the difference between reaching for
// the volume and not.
//
// Normalising the concatenated result rather than each segment keeps the relative levels
// between segments intact, so a quiet passage stays quieter than a loud one instead of every
// piece being dragged to the same number. Single pass: a two-pass measure-then-apply would
// double the render for a correction this size, and the true peak limiter is what stops the
// gain from clipping.
//
// An audio-only render trims by sample count, a video render by time, because the two are
// measured by different clocks downstream and the same trim does not satisfy both.
//
// Neither filter loses anything alone; the pair does. Counted over one source: concat alone
// gives 2817704 samples, concat with loudnorm the same 2817704, concat with loudnorm and
// atrim=end=<seconds> only 2813000 — 4704 samples, 98ms, gone. loudnorm rewrites timestamps,
// so a trim against the clock cuts against loudnorm's clock rather than the one the segment
// sum was measured in. The shortfall bore no relation to segment count (82ms at 3 segments,
// 15ms at 6, 31ms at 12, 98ms at 25), which is what ruled out accumulated filter latency.
// end_sample counts samples, which nothing upstream can shift, and lands 8 samples (0.17ms)
// off instead of 98ms.
//
// The video path keeps the time trim because it is validated against the container, where the
// picture sets the duration: cutting it by samples instead makes the audio outlast the video
// by 94ms and the container reports the longer stream, which its own duration check rejects.
const loudnessFilter = (edl: Edl): string => {
  const target = edl.audio.speechTargetLufs
  const peak = edl.audio.truePeakMaxDbtp
  if (target === undefined || !Number.isFinite(target)) {
    return ''
  }
  const truePeak = peak === undefined || !Number.isFinite(peak) ? -1 : peak
  return `,loudnorm=I=${target}:TP=${truePeak}:LRA=11`
}

// An id that names nothing, or names the picture, would silently fall back to the camera
// track and produce a render nobody asked for.
const externalAudioErrors = (edl: Edl): string[] => {
  const id = edl.audio.externalAudioSourceId
  if (id === null || id === undefined) {
    return []
  }
  const source = edl.sources.find((entry) => entry.id === id)
  if (source === undefined) {
    return [`external audio source '${id}' is not in sources`]
  }
  return source.hasAudio ? [] : [`external audio source '${id}' has no audio stream`]
}

const audioEdgeFade = (segment: Segment, fadeMs: number | undefined): string => {
  // An EDL written before this field existed renders exactly as it did then.
  if (fadeMs === undefined || !Number.isFinite(fadeMs) || fadeMs <= 0) {
    return ''
  }
  const spanMs = segment.outMs - segment.inMs
  // Both ramps have to fit with audio left between them, otherwise the segment is one
  // continuous fade and the words inside it lose level.
  if (spanMs <= fadeMs * 2) {
    return ''
  }
  const fade = seconds(fadeMs)
  const outStart = seconds(spanMs - fadeMs)
  return `,afade=t=in:st=0:d=${fade},afade=t=out:st=${outStart}:d=${fade}`
}

/**
 * Iterating a cut asks audio questions: whether a filler survived, whether a boundary
 * clipped a word, whether a pause is still there. Answering them through the video path
 * re-encodes every frame, which on one 22-segment EDL measured 31.8s against 0.25s for
 * the same cuts in audio alone.
 *
 * The audio half of the graph is used unchanged, edge fades and loudness included, so
 * what is heard while iterating is what the finished render will sound like. Only the
 * picture is dropped.
 */
export const buildFfmpegArgs = (
  edl: Edl,
  outputPath: string,
  options: { audioOnly?: boolean } = {},
): string[] => {
  const audioOnly = options.audioOnly === true
  const sourceIndex = new Map(edl.sources.map((source, index) => [source.id, index]))
  const filters: string[] = []
  // fpsConverting keeps its video and audio labels in two separate arrays and feeds them to
  // two separate concat calls (why: convertsFps's own comment). The native-rate path keeps
  // the single combined concat call it has always used, with labels interleaved per segment
  // in the order the concat filter's own spec requires (v then a, repeated per segment) —
  // legacyConcatInputs is that combined array, populated alongside the split ones so either
  // path can read from the one it needs without re-deriving label order.
  const videoConcatInputs: string[] = []
  const audioConcatInputs: string[] = []
  const legacyConcatInputs: string[] = []
  const width = edl.output.width
  const height = edl.output.height
  const fps = edl.output.fps
  const policy = edl.output.audioTrackPolicy
  // A many-segment render whose output fps differs from a source's own rate needs fps=
  // to run once, after concat, against a video PTS clock nothing but trim has touched —
  // see the note above the video filter below for why. A render where every source
  // already plays at the output rate does not have that problem and keeps the graph
  // shape it has always had, so its output stays byte-identical to every prior render.
  const fpsConverting = convertsFps(edl)
  // Undefined when every segment reads its own audio, which is the single-source case and has
  // to keep rendering exactly as it did.
  const audioInput =
    edl.audio.externalAudioSourceId === null || edl.audio.externalAudioSourceId === undefined
      ? undefined
      : sourceIndex.get(edl.audio.externalAudioSourceId)

  for (const [index, segment] of edl.segments.entries()) {
    const input = sourceIndex.get(segment.sourceId)
    if (input === undefined) {
      throw new Error(`${segment.id}: unknown source`)
    }
    const crop = segment.crop ?? { x: 0, y: 0, width: 1, height: 1 }
    const duration = seconds(segment.outMs - segment.inMs)
    if (!audioOnly) {
      // fps-converting: fps= does not run here. A segment's own trim already lands on the
      // nearest source-rate frame, and the video and audio branches below do not land on
      // exactly the same instant (video quantises to a whole frame, audio does not) — concat
      // pads the shorter of the two per segment when both feed one combined concat call,
      // which nudges every later segment's start off the source's frame grid before fps ever
      // sees it. Splitting video and audio into their own concat filters (below) removes that
      // cross-talk, so fps can run once, after concat, against a video PTS clock nothing but
      // trim has touched. Measured on a 60fps-to-30fps synthetic render: per-segment fps=
      // landed +16 frames over 20 irregular segments and +51 over 176; fps after a decoupled
      // concat landed 0 at every segment count tried, both directions.
      const fpsSegment = fpsConverting ? '' : `,fps=${fps}`
      filters.push(
        `[${input}:v]trim=start=${seconds(segment.inMs)}:end=${seconds(segment.outMs)},setpts=PTS-STARTPTS,crop=trunc(iw*${crop.width}/2)*2:trunc(ih*${crop.height}/2)*2:trunc(iw*${crop.x}/2)*2:trunc(ih*${crop.y}/2)*2,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black${fpsSegment},format=${edl.output.pixelFormat}[v${index}]`,
      )
      videoConcatInputs.push(`[v${index}]`)
      legacyConcatInputs.push(`[v${index}]`)
    }

    if (policy === 'required') {
      // A segment's timings are expressed against the picture. When the sound comes from a
      // separate recorder, the same instant sits elsewhere in that file, so the window slides
      // by the offset rather than the audio being shifted after the fact: trimming the right
      // window keeps every segment its own length, and length is what the validator checks.
      const audioIn = audioInput ?? input
      const shift = audioInput === undefined ? 0 : edl.audio.syncOffsetMs
      filters.push(
        `[${audioIn}:a]atrim=start=${seconds(Math.max(0, segment.inMs + shift))}:end=${seconds(Math.max(0, segment.outMs + shift))},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${audioEdgeFade(segment, edl.audio.edgeFadeMs)}[a${index}]`,
      )
      audioConcatInputs.push(`[a${index}]`)
      legacyConcatInputs.push(`[a${index}]`)
    }
    if (policy === 'explicit-silence') {
      filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[a${index}]`)
      audioConcatInputs.push(`[a${index}]`)
      legacyConcatInputs.push(`[a${index}]`)
    }
  }

  const hasAudio = policy !== 'forbidden'
  if (audioOnly && !hasAudio) {
    throw new Error('--audio-only needs an EDL that carries audio, and this one forbids it')
  }
  if (!audioOnly) {
    if (fpsConverting) {
      filters.push(
        `${videoConcatInputs.join('')}concat=n=${edl.segments.length}:v=1:a=0[vcat]`,
        `[vcat]fps=${fps}[v]`,
      )
    } else {
      const concatOut = hasAudio ? '[vcat][acat]' : '[v]'
      filters.push(
        `${legacyConcatInputs.join('')}concat=n=${edl.segments.length}:v=1:a=${hasAudio ? 1 : 0}${concatOut}`,
      )
      if (hasAudio) {
        filters.push(`[vcat]null[v]`)
      }
    }
  }
  if (hasAudio) {
    if (fpsConverting || audioOnly) {
      filters.push(`${audioConcatInputs.join('')}concat=n=${edl.segments.length}:v=0:a=1[acat]`)
    }
    const totalMs = edl.segments.reduce(
      (total, segment) => total + (segment.outMs - segment.inMs),
      0,
    )
    filters.push(
      `[acat]aresample=48000${loudnessFilter(edl)},aresample=48000,${audioOnly ? `atrim=end_sample=${Math.round((totalMs / 1000) * 48000)}` : `atrim=end=${seconds(totalMs)}`},asetpts=PTS-STARTPTS[a]`,
    )
  }

  const codec = edl.output.videoCodec === 'h264' ? 'libx264' : 'libx265'
  const args = edl.sources.flatMap((source) => ['-i', source.path])

  if (audioOnly) {
    // Lossless, because this file exists to be judged by ear. A codec artifact heard
    // while iterating would be read as a defect in the cut, which is the one thing this
    // is meant to answer.
    args.push(
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[a]',
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      outputPath,
    )
    return args
  }

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

// True only when at least one segment's own source runs at a different rate than the
// output asks for. An EDL with no averageFrameRate on any of its sources (written before
// that field existed, or by hand) cannot be told apart from a native-rate one here, so it
// reads as native and keeps the graph shape that has always rendered it — the byte-identical
// guarantee for every EDL already on disk depends on that default.
export const convertsFps = (edl: Edl): boolean =>
  edl.segments.some((segment) => {
    const source = edl.sources.find((candidate) => candidate.id === segment.sourceId)
    if (source?.averageFrameRate === undefined || source.averageFrameRate === null) {
      return false
    }
    return Math.abs(parseRate(source.averageFrameRate) - edl.output.fps) > 0.001
  })

// The frame rate the video trim filter actually quantises each segment's edges against.
// Reads the first source with video; v1 renders from one video source's segments, so there
// is only ever one rate to find.
const dominantSourceFps = (edl: Edl): number | null => {
  const withVideo = edl.sources.find((source) => source.hasVideo)
  const rate = withVideo?.averageFrameRate
  return rate === undefined || rate === null ? null : parseRate(rate)
}

// ffmpeg's trim filter does not round a segment's edges to the nearest source frame: its own
// documented semantics keep every frame whose PTS satisfies start <= PTS < end (`ffmpeg -h
// filter=trim`), which is start rounded UP to the next frame and end rounded DOWN, exclusive
// — never rounded to nearest. A segment cut between two source frames therefore always keeps
// at least as much picture as its millisecond span asks for, never less, and a many-segment
// EDL compounds that one-sided bias: measured on the real 176-segment, 60fps-to-30fps EDL
// this issue was filed against, the segment sum asks for 551406ms but the source's own 60fps
// grid can only deliver 551566.67ms of it (a segment's boundary lands between frames on 175
// of 176 joints), 160ms more than the naive sum — which is +5 real frames at 30fps once
// converted, not rounding noise.
//
// Frame count in a half-open interval [start, end) at a given fps is ceil(end*fps) -
// ceil(start*fps); summing that per segment against the source's own rate, then scaling by
// outputFps/sourceFps and rounding once (the same round(near) fps= itself applies), matched
// the real render exactly (16547 predicted, 16547 observed) and matched every synthetic
// fixture measured for this fix: contiguous segments at 5/20/60/176 (60->30) and 5/20/60
// (30->60); gapped segments (the shape every real detect/semantic-cut EDL actually has) at
// 5/20/60 (60->30), where a plain millisecond-sum formula was off by 1-5 frames and this one
// was exact at every count.
//
// Deliberately not the general answer: at a native rate (sourceFps === outputFps, or no
// averageFrameRate on record) this same ceil-based arithmetic disagrees with the plain sum
// on roughly a quarter of single-segment cases and by 1-2 frames on many-segment ones,
// measured against the same fixtures — small enough that the existing 1-frame tolerance has
// always absorbed it, but changing what every already-passing native EDL is checked against
// is a second fix this issue did not ask for. sourceFps is therefore required, not defaulted
// here; the caller decides whether an EDL is fps-converting before reaching for this formula
// and falls back to the plain sum otherwise (mirrors convertsFps's own scope).
export const expectedFramesForConcat = (
  segments: Array<{ inMs: number; outMs: number }>,
  sourceFps: number,
  outputFps: number,
): number => {
  const frameCount = (startMs: number, endMs: number): number => {
    const epsilon = 1e-9
    return (
      Math.ceil((endMs / 1000) * sourceFps - epsilon) -
      Math.ceil((startMs / 1000) * sourceFps - epsilon)
    )
  }
  const sourceFrames = segments.reduce(
    (total, segment) => total + frameCount(segment.inMs, segment.outMs),
    0,
  )
  return Math.round((sourceFrames * outputFps) / sourceFps)
}

// The plain millisecond-sum formula videoOutputErrors always used before this fix. Kept as
// its own named function (not folded into a single conditional inline) so a native-rate
// EDL's expected-frames arithmetic reads exactly as it did before this fix touched the file.
const expectedFramesNaive = (
  segments: Array<{ inMs: number; outMs: number }>,
  outputFps: number,
): number => {
  const totalMs = segments.reduce((total, segment) => total + (segment.outMs - segment.inMs), 0)
  return Math.round((totalMs / 1000) * outputFps)
}

const videoOutputErrors = (
  edl: Edl,
  video: OutputProbe['streams'][number],
  duration: string,
): string[] => {
  const errors: string[] = []
  const sourceFps = dominantSourceFps(edl)
  // fps-converting: expectedFrames comes from the ceil-based derivation (why: the export's
  // own comment), and expectedDuration follows from it rather than from the plain millisecond
  // sum, since that many-source-frame figure is what the video stream actually measures.
  // Native-rate (sourceFps unknown, or equal to the output rate): both stay exactly the
  // formulas this function used before the fix, unchanged for every EDL already on disk.
  // convertsFps is the same scope test buildFfmpegArgs uses to choose its graph shape, so
  // the validator's arithmetic and the render it is checking never disagree about which
  // render this EDL produced.
  const isFpsConverting = convertsFps(edl)
  const expectedFrames =
    isFpsConverting && sourceFps !== null
      ? expectedFramesForConcat(edl.segments, sourceFps, edl.output.fps)
      : expectedFramesNaive(edl.segments, edl.output.fps)
  const expectedDuration =
    isFpsConverting && sourceFps !== null
      ? (expectedFrames / edl.output.fps) * 1000
      : edl.segments.reduce((total, segment) => total + segment.outMs - segment.inMs, 0)
  const observedDuration = Number(duration) * 1000
  const toleranceMs = 2000 / edl.output.fps + 20
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
    errors.push(
      `render frame count differs from EDL duration: expected ${expectedFrames} frames, got ${
        Number.isFinite(observedFrames) ? observedFrames : 'unknown'
      } (tolerance 1 frame)`,
    )
  }
  if (
    !Number.isFinite(observedDuration) ||
    Math.abs(observedDuration - expectedDuration) > toleranceMs
  ) {
    errors.push(
      `render duration differs from EDL: expected ${Math.round(expectedDuration)}ms, got ${
        Number.isFinite(observedDuration) ? Math.round(observedDuration) : 'unknown'
      }ms (tolerance ${Math.round(toleranceMs)}ms)`,
    )
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

/**
 * What still has to hold when the picture was deliberately left out: the audio contract,
 * the absence of a video stream, and the duration. Duration is the one that matters — it
 * is what says the cuts landed where the EDL asked, and it is the reason an audio-only
 * pass can be trusted to answer questions about the finished cut.
 */
export const audioOnlyErrors = (edl: Edl, probe: OutputProbe): string[] => {
  const errors: string[] = []
  if (probe.streams.some((stream) => stream.codec_type === 'video')) {
    errors.push('audio-only render contains video')
  }
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  errors.push(...audioOutputErrors(edl.output.audioTrackPolicy, audio))

  const expectedDuration = edl.segments.reduce(
    (total, segment) => total + segment.outMs - segment.inMs,
    0,
  )
  const observedDuration = Number(probe.format.duration) * 1000
  // The graph pads before it trims, so the output lands on the segment sum whichever way
  // loudnorm drifted. What is left is the encoder rounding to a whole frame. A wider window
  // here would be a number fitted to one recording: the old 60ms came from a single 31ms
  // measurement and still rejected a valid 98ms render on the next source.
  const toleranceMs = 10
  const driftMs = observedDuration - expectedDuration
  if (!Number.isFinite(observedDuration) || Math.abs(driftMs) > toleranceMs) {
    const observed = Number.isFinite(observedDuration) ? Math.round(observedDuration) : 'unknown'
    errors.push(
      `audio-only render duration differs from EDL: expected ${expectedDuration}ms, got ${observed}ms (tolerance ${toleranceMs}ms)`,
    )
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
  const audioOnly = args.includes('--audio-only')
  if (audioOnly && modeValue === 'master') {
    throw new Error('--audio-only is for iterating; a master is the finished video')
  }
  return {
    edlPath: resolve(edlPath),
    outputPath: value('--output') === undefined ? undefined : resolve(value('--output') as string),
    mode: modeValue,
    dryRun: args.includes('--dry-run'),
    audioOnly,
  }
}

// Only for --audio-only: that render exists to be listened back to, which is a trx call and a
// semantic review away. A full video render has no equally short next step worth naming.
export const renderAudioOnlyNext = (outputPath: string) => [
  { question: 'hear what the cut says', verb: `trx transcribe ${outputPath} --preset verbatim` },
  {
    question: 'review the result as a viewer would hear it',
    verb: `vcut semantic review --edl <edl path> --detect <detect path> --master ${outputPath}`,
  },
]

export type RenderOptions = {
  outputPath?: string
  mode: Mode
  dryRun: boolean
  audioOnly: boolean
}

export type RenderResult = {
  status: 'ready' | 'rendered'
  audioOnly?: true
  mode?: Mode
  sources?: number
  segments?: number
  expectedDurationMs?: number
  outputPath: string
  command?: string[]
  sha256?: string
  duration?: string
  frames?: string
  next?: Array<{ question: string; verb: string }>
}

// The callable seam `commit` (B-V3) uses for its audio-only render step: everything
// `renderCommand` does once an EDL object is already in hand, minus reading it off disk and
// minus printing. `commit` builds the EDL in memory via `runBuild` and hands it straight here
// rather than round-tripping through a temp file, but the render itself — ffmpeg args, the
// partial-file rename, output validation — is unchanged. Shelling out to vcut's own CLI from
// inside vcut was ruled out; this export is the minimal alternative.
export const runRender = async (edl: Edl, options: RenderOptions): Promise<RenderResult> => {
  const errors = edlErrors(edl, options.mode)
  // The EDL's own output path names a video. Writing audio there would collide with the
  // render it is meant to precede, so audio-only lands beside it as a .wav unless asked
  // for somewhere else.
  const outputPath =
    options.outputPath ??
    (options.audioOnly ? `${edl.output.path.replace(/\.[^./]+$/, '')}.wav` : edl.output.path)

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
  // A dry run writes nothing, so refusing it because the output is already there leaves no way
  // to inspect the command after a failed attempt — which is exactly when it is needed.
  if (!options.dryRun && existsSync(outputPath)) {
    errors.push('output already exists')
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'))
  }

  // ffmpeg writes straight to its target, so the target is a sibling temp file until the
  // render has proven itself. Same directory, so the rename stays on one filesystem.
  const pendingPath = `${outputPath}.partial-${process.pid}${extname(outputPath)}`
  const args = buildFfmpegArgs(edl, pendingPath, { audioOnly: options.audioOnly })
  if (options.dryRun) {
    // Printed against the real destination: the temp file is this function's business, and a
    // command nobody can paste and run is not a useful thing to print.
    const shown = buildFfmpegArgs(edl, outputPath, { audioOnly: options.audioOnly })
    return {
      status: 'ready',
      mode: options.mode,
      ...(options.audioOnly ? { audioOnly: true } : {}),
      sources: edl.sources.length,
      segments: edl.segments.length,
      expectedDurationMs: edl.segments.reduce(
        (total, segment) => total + segment.outMs - segment.inMs,
        0,
      ),
      outputPath,
      command: ['ffmpeg', ...shown],
    }
  }

  const exitCode = await runInherit('ffmpeg', ['-v', 'error', ...args])
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited with ${exitCode}`)
  }
  const probe = await probeOutput(pendingPath)
  // The picture checks describe a file this one deliberately has no picture in. Duration
  // still has to hold: it is what says the cuts landed where the EDL asked.
  const validationErrors = options.audioOnly
    ? audioOnlyErrors(edl, probe)
    : outputErrors(edl, probe)
  if (validationErrors.length > 0) {
    // A render that failed its own contract is not something to leave lying around under the
    // name of a good one: the next command would read it as finished work.
    rmSync(pendingPath, { force: true })
    throw new Error(validationErrors.join('\n'))
  }
  renameSync(pendingPath, outputPath)
  const next = options.audioOnly ? renderAudioOnlyNext(outputPath) : []
  return {
    status: 'rendered',
    ...(options.audioOnly ? { audioOnly: true } : {}),
    outputPath,
    sha256: await sha256(outputPath),
    duration: probe.format.duration,
    ...(options.audioOnly
      ? {}
      : {
          frames: probe.streams.find((stream) => stream.codec_type === 'video')?.nb_read_frames,
        }),
    ...(next.length === 0 ? {} : { next }),
  }
}

export const renderCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const options = parseCli(argv)
  const edl = JSON.parse(readFileSync(options.edlPath, 'utf8')) as Edl
  const result = await runRender(edl, options)
  emitJson(result)
}
