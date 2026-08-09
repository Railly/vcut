import { describe, expect, test } from 'bun:test'
import { buildFfmpegArgs, type Edl, edlErrors, outputErrors } from '../src/render-edl.ts'

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
  test('builds the same audio chain as the video render', () => {
    // The concat line legitimately differs (v=0 against v=1); everything that shapes how
    // the audio sounds must not.
    const audioFilters = (args: string[]): string[] => {
      const graph = args[args.indexOf('-filter_complex') + 1] as string
      return graph
        .split(';')
        .filter((filter) => /\[a\d+\]$|\[a\]$/.test(filter) && !filter.includes('concat='))
    }
    expect(
      audioFilters(buildFfmpegArgs(edl('required'), '/tmp/cut.wav', { audioOnly: true })),
    ).toEqual(audioFilters(buildFfmpegArgs(edl('required'), '/tmp/master.mp4')))
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
