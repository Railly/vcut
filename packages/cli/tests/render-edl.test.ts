import { describe, expect, test } from 'bun:test'
import { buildFfmpegArgs, type Edl, outputErrors } from '../src/render-edl.ts'

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
    noiseReduction: 'off',
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
