import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/exec.ts'
import { UsageError } from '../src/output.ts'
import {
  audioOnlyErrors,
  buildFfmpegArgs,
  convertsFps,
  type Edl,
  edlErrors,
  expectedFramesForConcat,
  type FfmpegProgress,
  formatProgressLine,
  makeProgressWatcher,
  outputErrors,
  renderAudioOnlyNext,
  renderCommand,
  runRender,
} from '../src/render-edl.ts'

const edl = (
  audioTrackPolicy: Edl['output']['audioTrackPolicy'],
  edgeFadeMs = 0,
  segmentSpanMs = 5_000,
): Edl => ({
  timebase: 'milliseconds',
  sources: [
    {
      id: 'src-1',
      path: '/tmp/raw.mp4',
      sha256: 'a'.repeat(64),
      durationMs: 10_000,
      hasVideo: true,
      hasAudio: true,
    },
  ],
  segments: [
    {
      id: 'seg-1',
      sourceId: 'src-1',
      inMs: 0,
      outMs: segmentSpanMs,
      approval: 'proposed',
    },
  ],
  audio: {
    speechTargetLufs: -16,
    truePeakMaxDbtp: -1,
    externalAudioSourceId: null,
    syncOffsetMs: 0,
    edgeFadeMs,
  },
  output: {
    path: '/tmp/master.mp4',
    width: 1512,
    height: 950,
    fps: 60,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    audioTrackPolicy,
    overwrite: false,
  },
  approval: {
    status: 'draft',
    approvedAt: null,
    approvedBy: null,
  },
})

const probe = (channels: number): Parameters<typeof outputErrors>[1] => ({
  streams: [
    {
      codec_type: 'video',
      width: 1512,
      height: 950,
      pix_fmt: 'yuv420p',
      color_range: 'tv',
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      r_frame_rate: '60/1',
      nb_read_frames: '300',
    },
    { codec_type: 'audio', sample_rate: '48000', channels },
  ],
  format: { duration: '5.000000' },
})

describe('buildFfmpegArgs audio contract', () => {
  test('normalises a mono source to the stereo layout the validator requires', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('aformat=channel_layouts=stereo')
    expect(graph).toContain('-ac 2')
  })

  test('renders what outputErrors accepts, so a mono source does not fail its own render', () => {
    const args = buildFfmpegArgs(edl('required'), '/tmp/master.mp4')
    expect(args).toContain('-ac')
    expect(outputErrors(edl('required'), probe(2))).toEqual([])
  })

  test('a mono render is still rejected, so the guard keeps its teeth', () => {
    expect(outputErrors(edl('required'), probe(1))).toContain(
      'render audio contract differs from EDL',
    )
  })

  test('explicit silence stays stereo', () => {
    const graph = buildFfmpegArgs(edl('explicit-silence'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('anullsrc=r=48000:cl=stereo')
  })

  test('a forbidden audio track adds no channel flags', () => {
    const graph = buildFfmpegArgs(edl('forbidden'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('-an')
    expect(graph).not.toContain('-ac 2')
  })
})

describe('buildFfmpegArgs --audio-only', () => {
  // The promise of the flag: what you hear while iterating is what the finished render
  // will sound like. That only holds if the audio half of the graph is untouched, so it
  // is compared filter for filter against the video path rather than merely inspected.
  //
  // The trailing trim is the one exception, and it is a length rather than a sound: the
  // two renders are measured by different clocks downstream, so audio-only cuts by sample
  // count and the video path by time. Everything that shapes the sound is still compared.
  test('builds the same audio chain as the video render, apart from the trailing trim', () => {
    // The concat line legitimately differs (v=0 against v=1); everything that shapes how
    // the audio sounds must not.
    const audioFilters = (args: string[]): string[] => {
      const graph = args[args.indexOf('-filter_complex') + 1] as string
      return graph
        .split(';')
        .filter((filter) => /\[a\d+\]$|\[a\]$/.test(filter) && !filter.includes('concat='))
        .map((filter) => filter.replace(/atrim=end(_sample)?=[\d.]+/, 'atrim=<tail>'))
    }
    expect(
      audioFilters(buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true })),
    ).toEqual(audioFilters(buildFfmpegArgs(edl('required'), '/tmp/master.mp4')))
  })

  // The trim that differs has to be the *only* thing that differs, and it has to be the
  // sample-count form: a time trim here is what cut 98ms off a valid render.
  test('trims the audio-only tail by sample count, not by time', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true }).join(' ')
    expect(graph).toContain('atrim=end_sample=')
    expect(graph).not.toContain('atrim=end=')
    const video = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(video).toContain('atrim=end=')
    expect(video).not.toContain('atrim=end_sample=')
  })

  // The gap that the old 60ms tolerance let through as an error: a 98ms shortfall on a real
  // 58.702s cut. The message has to carry both numbers, because from outside the process
  // there is no other way to tell a near miss from a broken render.
  test('reports the measured gap when the duration is wrong', () => {
    const audioProbe = (durationSeconds: string): Parameters<typeof audioOnlyErrors>[1] => ({
      streams: [{ codec_type: 'audio', sample_rate: '48000', channels: 2 }],
      format: { duration: durationSeconds },
    })
    const target = edl('required')
    const expectedMs = target.segments.reduce(
      (total, segment) => total + segment.outMs - segment.inMs,
      0,
    )
    const short = (expectedMs - 98) / 1000
    const errors = audioOnlyErrors(target, audioProbe(short.toFixed(6)))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`expected ${expectedMs}ms`)
    expect(errors[0]).toContain(`got ${Math.round(short * 1000)}ms`)
  })

  test('accepts a render that lands on the segment sum', () => {
    const target = edl('required')
    const expectedMs = target.segments.reduce(
      (total, segment) => total + segment.outMs - segment.inMs,
      0,
    )
    expect(
      audioOnlyErrors(target, {
        streams: [{ codec_type: 'audio', sample_rate: '48000', channels: 2 }],
        format: { duration: (expectedMs / 1000).toFixed(6) },
      }),
    ).toEqual([])
  })

  test('drops the picture entirely', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true }).join(' ')
    expect(graph).toContain('-vn')
    expect(graph).not.toContain('libx264')
    expect(graph).not.toContain(':v]trim=')
    expect(graph).not.toContain('scale=')
  })

  test('concatenates audio streams only', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true }).join(' ')
    expect(graph).toContain('concat=n=1:v=0:a=1[acat]')
  })

  // A codec artifact heard while iterating reads as a defect in the cut, which is the
  // one question this file exists to answer.
  test('writes lossless audio', () => {
    const args = buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true })
    expect(args).toContain('pcm_s16le')
    expect(args).not.toContain('aac')
  })

  test('refuses an EDL that carries no audio to render', () => {
    expect(() => buildFfmpegArgs(edl('forbidden'), '/tmp/cut.wav', { audioOnly: true })).toThrow(
      /audio/,
    )
  })

  test('the video path is unchanged when the flag is absent', () => {
    expect(buildFfmpegArgs(edl('required'), '/tmp/master.mp4')).toEqual(
      buildFfmpegArgs(edl('required'), '/tmp/master.mp4', {}),
    )
  })
})

// #41: a many-segment audio render cost minutes because every segment referenced [0:a]
// directly and ffmpeg inserted the fan-out itself, once per extra consumer. The fix names
// that fan-out with one asplit. Asserted as graph shape rather than as seconds: the timing
// this came from (293s to 43s on a 180-segment, 700s source) is real but machine-dependent,
// while "one split, N branches, the raw input read once" is the mechanism that produced it.
describe('buildFfmpegArgs fans a source out once (#41)', () => {
  const manySegments = (count: number): Edl => {
    const base = edl('required')
    return {
      ...base,
      sources: [{ ...base.sources[0], durationMs: 10_000 * count }],
      segments: Array.from({ length: count }, (_, index) => ({
        id: `seg-${index}`,
        sourceId: 'src-1',
        inMs: index * 1_000,
        outMs: index * 1_000 + 500,
        approval: 'proposed' as const,
      })),
    }
  }
  const graphOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1] as string

  test('splits the audio once instead of reading [0:a] once per segment', () => {
    const graph = graphOf(buildFfmpegArgs(manySegments(40), '/tmp/cut.wav', { audioOnly: true }))
    expect(graph).toContain('[0:a]asplit=40')
    // The defect itself: 40 separate reads of the same decoded stream.
    expect(graph.match(/\[0:a\]/g)).toHaveLength(1)
    expect(graph.match(/asplit=/g)).toHaveLength(1)
  })

  test('gives every segment its own branch off that one split', () => {
    const graph = graphOf(buildFfmpegArgs(manySegments(40), '/tmp/cut.wav', { audioOnly: true }))
    for (let index = 0; index < 40; index++) {
      expect(graph).toContain(`[sa0_${index}]atrim=`)
    }
  })

  test('splits the picture once too, on the video path', () => {
    const graph = graphOf(buildFfmpegArgs(manySegments(40), '/tmp/master.mp4'))
    expect(graph).toContain('[0:v]split=40')
    expect(graph.match(/\[0:v\]/g)).toHaveLength(1)
    expect(graph.match(/\[0:a\]/g)).toHaveLength(1)
  })

  // A single-segment EDL has nothing to fan out, and every EDL already on disk that renders
  // one segment has to keep producing the exact bytes it always did.
  test('adds no split when a source feeds a single branch', () => {
    const graph = graphOf(buildFfmpegArgs(manySegments(1), '/tmp/cut.wav', { audioOnly: true }))
    expect(graph).not.toContain('asplit')
    expect(graph).toContain('[0:a]atrim=')
  })
})

describe('buildFfmpegArgs edge fade', () => {
  test('ramps both edges of the segment', () => {
    const graph = buildFfmpegArgs(edl('required', 50), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('afade=t=in:st=0:d=0.05')
    expect(graph).toContain('afade=t=out:st=4.95:d=0.05')
  })

  test('leaves the graph untouched at zero', () => {
    const graph = buildFfmpegArgs(edl('required', 0), '/tmp/master.mp4').join(' ')
    expect(graph).not.toContain('afade')
  })

  test('an EDL written before the field renders as it did then', () => {
    const legacy = edl('required', 50)
    // Reproduces an EDL written before the field existed.
    legacy.audio = { ...legacy.audio, edgeFadeMs: undefined as unknown as number }
    expect(buildFfmpegArgs(legacy, '/tmp/master.mp4').join(' ')).not.toContain('afade')
  })

  test('skips a segment too short to hold both ramps and still have audio between them', () => {
    const graph = buildFfmpegArgs(edl('required', 50, 100), '/tmp/master.mp4').join(' ')
    expect(graph).not.toContain('afade')
  })

  test('fades a segment that clears both ramps', () => {
    const graph = buildFfmpegArgs(edl('required', 50, 101), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('afade=t=in')
  })

  test('does not shorten the render, so audio stays in sync with concatenated video', () => {
    // acrossfade would overlap the joints and drift the audio ahead of the picture; the
    // duration contract in outputErrors is the check that would catch it.
    const graph = buildFfmpegArgs(edl('required', 50), '/tmp/master.mp4').join(' ')
    expect(graph).not.toContain('acrossfade')
    expect(outputErrors(edl('required', 50), probe(2))).toEqual([])
  })
})

describe('loudness normalisation', () => {
  test('normalises to the target the EDL has always declared', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('loudnorm=I=-16:TP=-1')
  })

  test('normalises the concatenated result, not each segment on its own', () => {
    // Per-segment would flatten a quiet passage to the same number as a loud one.
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph.match(/loudnorm/g)).toHaveLength(1)
  })

  test('trims back to the EDL duration, since loudnorm hands back a longer stream', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('atrim=end=5,')
  })

  test('leaves the audio alone when no target is declared', () => {
    const legacy = edl('required')
    legacy.audio = { ...legacy.audio, speechTargetLufs: undefined }
    expect(buildFfmpegArgs(legacy, '/tmp/master.mp4').join(' ')).not.toContain('loudnorm')
  })

  test('defaults the ceiling to -1 dBTP when only a target is given', () => {
    const partial = edl('required')
    partial.audio = { ...partial.audio, truePeakMaxDbtp: undefined }
    expect(buildFfmpegArgs(partial, '/tmp/master.mp4').join(' ')).toContain('TP=-1')
  })

  test('adds no audio filter chain when the track is forbidden', () => {
    expect(buildFfmpegArgs(edl('forbidden'), '/tmp/master.mp4').join(' ')).not.toContain('loudnorm')
  })
})

const withExternalAudio = (syncOffsetMs = 0): Edl => {
  const base = edl('required')
  return {
    ...base,
    sources: [
      ...base.sources,
      {
        id: 'src-1-audio',
        path: '/tmp/mic.wav',
        sha256: 'b'.repeat(64),
        durationMs: 10_000,
        hasVideo: false,
        hasAudio: true,
      },
    ],
    audio: { ...base.audio, externalAudioSourceId: 'src-1-audio', syncOffsetMs },
  }
}

describe('external audio', () => {
  test('reads the audio from the separate source, not from the picture', () => {
    const graph = buildFfmpegArgs(withExternalAudio(), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('[1:a]atrim')
    expect(graph).not.toContain('[0:a]atrim')
  })

  test('leaves a single-source EDL reading its own audio', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('[0:a]atrim')
  })

  test('slides the trim window by the offset instead of shifting the audio after', () => {
    // Shifting afterwards changes the length, and length is what the duration contract checks.
    const graph = buildFfmpegArgs(withExternalAudio(500), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('[1:a]atrim=start=0.5:end=5.5')
  })

  test('never trims before the start of the file on a negative offset', () => {
    const graph = buildFfmpegArgs(withExternalAudio(-2_000), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('atrim=start=0:')
  })

  test('refuses an id that names no source', () => {
    const broken = withExternalAudio()
    broken.audio = { ...broken.audio, externalAudioSourceId: 'nope' }
    expect(edlErrors(broken, 'preview')).toContain("external audio source 'nope' is not in sources")
  })

  test('refuses an id that names a source with no audio', () => {
    const broken = withExternalAudio()
    // Point at the picture and declare it mute, which is what a mistyped id looks like.
    broken.sources[0] = { ...broken.sources[0], hasAudio: false }
    broken.audio = { ...broken.audio, externalAudioSourceId: 'src-1' }
    expect(edlErrors(broken, 'preview')).toContain(
      "external audio source 'src-1' has no audio stream",
    )
  })

  test('accepts a mute video when the sound comes from elsewhere', () => {
    // The old rule asked the segment's own source for audio, which is exactly the case a
    // separate recorder exists for.
    const mute = withExternalAudio()
    mute.sources[0] = { ...mute.sources[0], hasAudio: false }
    expect(edlErrors(mute, 'preview')).toEqual([])
  })
})

describe('renderAudioOnlyNext', () => {
  test('names a non-empty question and a non-empty verb for each entry', () => {
    const hints = renderAudioOnlyNext('/tmp/render.wav')
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.question.length).toBeGreaterThan(0)
      expect(hint.verb.length).toBeGreaterThan(0)
    }
  })

  test('the transcribe verb carries the rendered path', () => {
    const hints = renderAudioOnlyNext('/tmp/render.wav')
    expect(hints.some((hint) => hint.verb.includes('/tmp/render.wav'))).toBe(true)
  })
})

// A render that failed its own contract used to say only that it failed, with neither the
// measured numbers nor the tolerance that rejected them — three renders a night were spent
// re-deriving by hand what the validator already knew (issue #14).
describe('videoOutputErrors messages', () => {
  test('reports the expected and observed frame count on a mismatch', () => {
    const mismatched = probe(2)
    const videoStream = mismatched.streams.find((stream) => stream.codec_type === 'video')
    if (videoStream !== undefined) {
      videoStream.nb_read_frames = '294'
    }
    const errors = outputErrors(edl('required'), mismatched)
    // edl('required') defaults to a 5000ms segment at 60fps: 300 expected frames.
    expect(errors).toContain(
      'render frame count differs from EDL duration: expected 300 frames, got 294 (tolerance 1 frame)',
    )
  })

  test('reports the expected and observed duration in milliseconds on a mismatch', () => {
    const mismatched = probe(2)
    mismatched.format.duration = '4.900000'
    const errors = outputErrors(edl('required'), mismatched)
    expect(errors).toContain(
      'render duration differs from EDL: expected 5000ms, got 4900ms (tolerance 53ms)',
    )
  })

  test('names both mismatches independently, not one swallowing the other', () => {
    const mismatched = probe(2)
    const videoStream = mismatched.streams.find((stream) => stream.codec_type === 'video')
    if (videoStream !== undefined) {
      videoStream.nb_read_frames = '250'
    }
    mismatched.format.duration = '4.100000'
    const errors = outputErrors(edl('required'), mismatched)
    expect(errors.some((error) => error.startsWith('render frame count differs'))).toBe(true)
    expect(errors.some((error) => error.startsWith('render duration differs'))).toBe(true)
  })

  test('stays silent on both when the render lands inside tolerance', () => {
    expect(outputErrors(edl('required'), probe(2))).toEqual([])
  })
})

// convertsFps is the scope guard for the fps-rounding fix (#20): only a source that
// carries averageFrameRate and disagrees with output.fps switches the graph to the
// decoupled-concat-then-fps shape. Every other case, including no averageFrameRate at
// all, has to read false so an EDL already on disk keeps rendering byte-identical output.
describe('convertsFps', () => {
  const withRate = (rate: string | null | undefined, outputFps: number): Edl => {
    const base = edl('required')
    base.sources[0].averageFrameRate = rate
    base.output.fps = outputFps
    return base
  }

  test('false when no source carries averageFrameRate', () => {
    expect(convertsFps(withRate(undefined, 30))).toBe(false)
  })

  test('false when averageFrameRate is explicitly null', () => {
    expect(convertsFps(withRate(null, 30))).toBe(false)
  })

  test('false when averageFrameRate matches output.fps', () => {
    expect(convertsFps(withRate('60/1', 60))).toBe(false)
  })

  test('true when averageFrameRate differs from output.fps (downsample)', () => {
    expect(convertsFps(withRate('60/1', 30))).toBe(true)
  })

  test('true when averageFrameRate differs from output.fps (upsample)', () => {
    expect(convertsFps(withRate('30/1', 60))).toBe(true)
  })

  test('false within the 0.001 fps floating-point tolerance', () => {
    // 30000/1001 is the NTSC 29.97 rate; rendered against a nominal 30fps output this is
    // not a conversion the fix's fps= step should trigger.
    expect(convertsFps(withRate('30000/1001', 29.97))).toBe(false)
  })
})

// expectedFramesForConcat sums each segment's own frame count in ffmpeg trim's actual
// half-open semantics (start <= PTS < end against the source's own frame grid), then scales
// by outputFps/sourceFps and rounds once — the same round(near) arithmetic fps= itself
// applies to the concatenated clock. See the export's own comment for the derivation and the
// real-render numbers (16547 predicted, 16547 observed on the 176-segment fixture) that
// confirmed it.
describe('expectedFramesForConcat', () => {
  test('one segment landing exactly on frame boundaries at 60fps source, 30fps output', () => {
    // 0..5000ms at 60fps: frames 0..299 (300 frames), each 16.667ms — 5000ms lands exactly
    // on the boundary between frame 299 (16.617ms in) and frame 300 (would start at 5000ms).
    expect(expectedFramesForConcat([{ inMs: 0, outMs: 5_000 }], 60, 30)).toBe(150)
  })

  test('a segment edge that does not land on a source frame keeps the frame it falls inside', () => {
    // 0..517ms at 60fps: frame 31 starts at 516.667ms, which is < 517ms, so it survives —
    // frames 0..31 (32 frames) — trim's end is exclusive, so the 517ms edge does not need
    // to land exactly on a frame boundary for the frame it falls inside to be counted.
    expect(expectedFramesForConcat([{ inMs: 0, outMs: 517 }], 60, 60)).toBe(32)
  })

  test('gapped segments sum their own frame counts, not the naive millisecond sum', () => {
    // Two segments cut apart by a gap, each landing off the 60fps frame grid. Naive
    // round(totalMs/1000*30) would give round((483+466)/1000*30) = round(28.47) = 28.
    // The real render keeps one extra frame at each segment's boundary quantisation.
    const segments = [
      { inMs: 100, outMs: 583 },
      { inMs: 700, outMs: 1_166 },
    ]
    const naive = Math.round(
      (segments.reduce((total, segment) => total + segment.outMs - segment.inMs, 0) / 1000) * 30,
    )
    expect(expectedFramesForConcat(segments, 60, 30)).not.toBe(naive)
    expect(expectedFramesForConcat(segments, 60, 30)).toBe(29)
  })

  test('upsampling (30fps source to 60fps output) scales the source frame count up', () => {
    expect(expectedFramesForConcat([{ inMs: 0, outMs: 1_000 }], 30, 60)).toBe(60)
  })

  test('matches the real 176-segment fixture this issue was filed against', () => {
    // segment sum is 551406ms (what the EDL asks for); the source's own 60fps grid can only
    // deliver 551566.67ms of that across 176 gapped joints, which is 16547 frames at 30fps,
    // not the 16542 a plain millisecond sum predicts. Render confirmed 16547 exactly.
    const segments: Array<{ inMs: number; outMs: number }> = []
    let seed = 176 * 2654435761
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    let cursor = 0
    for (let i = 0; i < 176; i++) {
      const gap = Math.floor(rand() * 700) + 50
      const span = Math.floor(rand() * 5000) + 200
      cursor += gap
      segments.push({ inMs: cursor, outMs: cursor + span })
      cursor += span
    }
    const naive = Math.round(
      (segments.reduce((total, segment) => total + segment.outMs - segment.inMs, 0) / 1000) * 30,
    )
    const derived = expectedFramesForConcat(segments, 60, 30)
    // The exact frame count depends on this test's own synthetic segment placement, not the
    // real EDL's — what is pinned here is that the two formulas disagree at this segment
    // count (the defect this fix closes), and the ceil-based one is never smaller than what
    // a plain sum predicts, matching trim's one-sided "keep the frame you land inside" bias.
    expect(derived).toBeGreaterThanOrEqual(naive)
    expect(derived).not.toBe(naive)
  })

  test('empty segment list expects zero frames', () => {
    expect(expectedFramesForConcat([], 60, 30)).toBe(0)
  })
})

describe('buildFfmpegArgs graph shape by convertsFps', () => {
  test('native rate (no averageFrameRate) keeps the single combined concat call', () => {
    const graph = buildFfmpegArgs(edl('required'), '/tmp/master.mp4').join(' ')
    expect(graph).toContain('concat=n=1:v=1:a=1[vcat][acat]')
    expect(graph).toContain(',fps=60,format=yuv420p')
    expect(graph).not.toContain('[vcat]fps=60[v]')
  })

  test('native rate (averageFrameRate equals output.fps) keeps the single combined concat call', () => {
    const nativeEdl = edl('required')
    nativeEdl.sources[0].averageFrameRate = '60/1'
    const graph = buildFfmpegArgs(nativeEdl, '/tmp/master.mp4').join(' ')
    expect(graph).toContain('concat=n=1:v=1:a=1[vcat][acat]')
    expect(graph).toContain(',fps=60,format=yuv420p')
  })

  test('fps-converting EDL splits concat into two calls and moves fps after it', () => {
    const convertingEdl = edl('required')
    convertingEdl.sources[0].averageFrameRate = '60/1'
    convertingEdl.output.fps = 30
    const graph = buildFfmpegArgs(convertingEdl, '/tmp/master.mp4').join(' ')
    expect(graph).toContain('concat=n=1:v=1:a=0[vcat]')
    expect(graph).toContain('concat=n=1:v=0:a=1[acat]')
    expect(graph).toContain('[vcat]fps=30[v]')
    expect(graph).not.toContain(',fps=30,format=yuv420p')
    expect(graph).not.toContain('concat=n=1:v=1:a=1')
  })
})

describe('formatProgressLine', () => {
  const progress = (overrides: Partial<FfmpegProgress> = {}): FfmpegProgress => ({
    outTimeMs: null,
    speed: null,
    frame: null,
    done: false,
    ...overrides,
  })

  test('reports time rendered against the EDL total and a percent', () => {
    const line = formatProgressLine(progress({ outTimeMs: 2_500, speed: '1.02x' }), 5_000)
    expect(line).toContain('50%')
    expect(line).toContain('1.02x')
  })

  test('a block with no out_time_us yet is not a printable line', () => {
    expect(formatProgressLine(progress(), 5_000)).toBeNull()
  })

  test('clamps at 100% when ffmpeg reports past the EDL total (loudnorm tail, encoder rounding)', () => {
    const line = formatProgressLine(progress({ outTimeMs: 5_200 }), 5_000)
    expect(line).toContain('100%')
  })

  test('a zero-duration EDL does not divide by zero', () => {
    const line = formatProgressLine(progress({ outTimeMs: 0 }), 0)
    expect(line).toContain('0%')
  })
})

describe('makeProgressWatcher', () => {
  test('turns one full ffmpeg progress block into one formatted line', () => {
    const lines: string[] = []
    const watch = makeProgressWatcher(5_000, (line) => lines.push(line))
    for (const line of [
      'frame=125',
      'fps=25.00',
      'out_time_us=2500000',
      'out_time_ms=2500000',
      'speed=1.01x',
      'progress=continue',
    ]) {
      watch(line)
    }
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('50%')
  })

  test('a real ffmpeg error line (-v error, no "=") passes through untouched', () => {
    const lines: string[] = []
    const watch = makeProgressWatcher(5_000, (line) => lines.push(line))
    watch('Error opening output files: Encoder not found')
    expect(lines).toEqual(['Error opening output files: Encoder not found'])
  })

  test('several reports over one render each produce their own line', () => {
    const lines: string[] = []
    const watch = makeProgressWatcher(4_000, (line) => lines.push(line))
    const block = (outTimeMs: number) => [
      `out_time_us=${outTimeMs * 1000}`,
      'speed=1.0x',
      'progress=continue',
    ]
    for (const line of [...block(1_000), ...block(2_000), ...block(4_000)]) {
      watch(line)
    }
    expect(lines).toEqual([
      expect.stringContaining('25%'),
      expect.stringContaining('50%'),
      expect.stringContaining('100%'),
    ])
  })

  // Regression: a real render (source.mp4 through vcut's own crop/scale/pad/fps graph, 6s at
  // 640x480) produced exactly this block as its middle of three reports — out_time_us, speed
  // and bitrate all N/A while frame and fps stayed numeric in the same block. Read straight
  // through, Number('N/A') is NaN and the printed line read "NaN% (NaNs/6s) N/A" — worse than
  // the silence this feature exists to fix. The report is skipped instead: a caller sees two
  // good lines around the gap rather than one bad one between them.
  test('an ffmpeg report marked N/A (a real occurrence, not a hypothetical) is skipped, not printed as NaN', () => {
    const lines: string[] = []
    const watch = makeProgressWatcher(6_000, (line) => lines.push(line))
    for (const line of ['frame=67', 'out_time_us=2166667', 'speed=4.31x', 'progress=continue']) {
      watch(line)
    }
    for (const line of [
      'frame=142',
      'bitrate=N/A',
      'out_time_us=N/A',
      'speed=N/A',
      'progress=continue',
    ]) {
      watch(line)
    }
    for (const line of ['frame=180', 'out_time_us=5933333', 'speed=4.94x', 'progress=end']) {
      watch(line)
    }
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.includes('NaN'))).toBe(false)
    expect(lines[0]).toContain('36%')
    expect(lines[1]).toContain('99%')
  })
})

// runRender shells out to ffmpeg for the render itself, so this is the one test in the file
// that pays for a real encode. Where ffmpeg is absent the behaviour under test cannot exist,
// so it skips rather than fails, matching semantic.test.ts's renderedGaps convention.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('runRender progress streaming', () => {
  let workDir: string
  let sourcePath: string
  let sourceHash: string

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'vcut-render-wait-'))
    sourcePath = join(workDir, 'source.mp4')
    const built = await run('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      sourcePath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(`fixture generation failed: ${built.stderr}`)
    }
    sourceHash = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  // --audio-only, not a video render: what this test exercises is the progress-streaming path
  // shared by both (runRender's own non-dry-run branch), and audio-only reaches it in
  // milliseconds instead of the seconds a video encode needs, which is what keeps this fixture
  // fast enough to run on every `bun test`.
  const fixtureEdl = (outputPath: string): Edl => ({
    timebase: 'milliseconds',
    sources: [
      {
        id: 'src-1',
        path: sourcePath,
        sha256: sourceHash,
        durationMs: 2_000,
        hasVideo: true,
        hasAudio: true,
      },
    ],
    segments: [{ id: 'seg-1', sourceId: 'src-1', inMs: 0, outMs: 2_000, approval: 'proposed' }],
    audio: {
      externalAudioSourceId: null,
      syncOffsetMs: 0,
      edgeFadeMs: 0,
    },
    output: {
      path: outputPath,
      width: 320,
      height: 240,
      fps: 10,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      audioTrackPolicy: 'required',
      overwrite: false,
    },
    approval: { status: 'draft', approvedAt: null, approvedBy: null },
  })

  test('renders in the foreground and reports at least one progress line, stdout untouched', async () => {
    const outputPath = join(workDir, 'default.mp4')
    const lines: string[] = []
    const result = await runRender(fixtureEdl(outputPath), {
      mode: 'preview',
      dryRun: false,
      audioOnly: true,
      onProgressLine: (line) => lines.push(line),
    })
    expect(result.status).toBe('rendered')
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((line) => !line.startsWith('{'))).toBe(true)
  })

  test('--quiet renders the same file with no progress lines', async () => {
    const outputPath = join(workDir, 'quiet.mp4')
    const lines: string[] = []
    const result = await runRender(fixtureEdl(outputPath), {
      mode: 'preview',
      dryRun: false,
      audioOnly: true,
      quiet: true,
      onProgressLine: (line) => lines.push(line),
    })
    expect(result.status).toBe('rendered')
    expect(lines).toHaveLength(0)
  })

  // Issue #66: commit renders a round, folds its deterministic cuts into the EDL, and renders
  // again over the same path. The existing-output guard refused the second render, so master.wav
  // never carried the auto-cuts while edl.json said it did. The guard stays for every other
  // caller; only a caller that means it opts out.
  test('a second render over the same path is refused by default', async () => {
    const outputPath = join(workDir, 'twice-guarded.wav')
    const options = { mode: 'preview' as const, dryRun: false, audioOnly: true, quiet: true }
    const first = await runRender(fixtureEdl(outputPath), { ...options, outputPath })
    expect(existsSync(first.outputPath)).toBe(true)
    expect(runRender(fixtureEdl(outputPath), { ...options, outputPath })).rejects.toThrow(
      'output already exists',
    )
  })

  test('allowExisting lets the same round render again over its own output', async () => {
    const outputPath = join(workDir, 'twice-allowed.wav')
    const options = { mode: 'preview' as const, dryRun: false, audioOnly: true, quiet: true }
    await runRender(fixtureEdl(outputPath), { ...options, outputPath })
    const second = await runRender(fixtureEdl(outputPath), {
      ...options,
      outputPath,
      allowExisting: true,
    })
    expect(second.status).toBe('rendered')
    expect(existsSync(outputPath)).toBe(true)
  })

  // The reason allowExisting is safe: ffmpeg writes to a temp sibling and only a render that
  // passes probeOutput is renamed into place. A second render that fails leaves the first one
  // standing rather than a hole where the good file was.
  test('a failed second render leaves the first file intact', async () => {
    const outputPath = join(workDir, 'twice-failed.wav')
    const options = { mode: 'preview' as const, dryRun: false, audioOnly: true, quiet: true }
    await runRender(fixtureEdl(outputPath), { ...options, outputPath })
    const before = statSync(outputPath)
    const broken = fixtureEdl(outputPath)
    broken.sources[0].path = join(workDir, 'this-source-does-not-exist.mp4')
    expect(runRender(broken, { ...options, outputPath, allowExisting: true })).rejects.toThrow()
    const after = statSync(outputPath)
    expect(after.size).toBe(before.size)
    expect(readdirSync(workDir).filter((name) => name.includes('.partial-'))).toHaveLength(0)
  })
})

// Issue #31: render never called resolveMode and always emitted JSON, so --human on render was
// accepted and silently ignored. render is decided to honor --human with a real summary rather
// than reject it, since it is the command a human runs interactively more than most.
describe('renderCommand output mode', () => {
  const capture = async (argv: string[]): Promise<string> => {
    const original = console.log
    let printed = ''
    console.log = (text: string) => {
      printed = text
    }
    try {
      await renderCommand(argv)
    } finally {
      console.log = original
    }
    return printed
  }

  test('--help mentions the global output flags', async () => {
    const printed = await capture(['--help'])
    expect(printed).toContain('--json')
    expect(printed).toContain('--human')
    expect(printed).toContain('--fields')
    expect(printed).toContain('--jq')
  })

  describe('with a dry-run EDL', () => {
    let workDir: string
    let edlPath: string
    let sourcePath: string

    beforeAll(() => {
      workDir = mkdtempSync(join(tmpdir(), 'vcut-render-human-'))
      sourcePath = join(workDir, 'source.mp4')
      writeFileSync(sourcePath, 'not real media, dry-run never opens it')
      const sha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex')
      const fixture: Edl = {
        timebase: 'milliseconds',
        sources: [
          {
            id: 'src-1',
            path: sourcePath,
            sha256,
            durationMs: 5_000,
            hasVideo: true,
            hasAudio: true,
          },
        ],
        segments: [{ id: 'seg-1', sourceId: 'src-1', inMs: 0, outMs: 5_000, approval: 'proposed' }],
        audio: {
          externalAudioSourceId: null,
          syncOffsetMs: 0,
          edgeFadeMs: 0,
        },
        output: {
          path: join(workDir, 'master.mp4'),
          width: 320,
          height: 240,
          fps: 30,
          videoCodec: 'h264',
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          audioTrackPolicy: 'required',
          overwrite: false,
        },
        approval: { status: 'draft', approvedAt: null, approvedBy: null },
      }
      edlPath = join(workDir, 'edl.json')
      writeFileSync(edlPath, JSON.stringify(fixture))
    })

    afterAll(() => {
      rmSync(workDir, { recursive: true, force: true })
    })

    test('--human renders a summary rather than JSON', async () => {
      const printed = await capture(['--edl', edlPath, '--dry-run', '--human'])
      expect(printed).toContain('render')
      expect(printed).toContain('dry run')
      expect(printed).toContain(edlPath.replace(/edl\.json$/, 'master.mp4'))
      // Not JSON: a human summary never opens with a brace the way emitJson's output does.
      expect(printed.trimStart().startsWith('{')).toBe(false)
    })

    test('--json still renders JSON on the same input', async () => {
      const printed = await capture(['--edl', edlPath, '--dry-run', '--json'])
      const parsed = JSON.parse(printed) as { status: string }
      expect(parsed.status).toBe('ready')
    })

    test('--human --jq is a usage error on render too, not a silent no-op', async () => {
      await expect(
        renderCommand(['--edl', edlPath, '--dry-run', '--human', '--jq', '.status']),
      ).rejects.toThrow(UsageError)
    })
  })
})
