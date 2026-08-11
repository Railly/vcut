import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditPlan, compareBoundary, correlate, envelope } from '../src/audit.ts'
import { run } from '../src/exec.ts'

const tone = (length: number, period: number, amplitude = 1): Float32Array => {
  const samples = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    samples[index] = Math.sin((index / period) * Math.PI * 2) * amplitude
  }
  return samples
}

describe('envelope', () => {
  test('reduces samples to one value per window', () => {
    expect(envelope(new Float32Array(1600), 160)).toHaveLength(10)
  })

  test('measures level rather than sign', () => {
    const loud = envelope(tone(1600, 40, 1), 160)
    const quiet = envelope(tone(1600, 40, 0.25), 160)
    expect(loud[0]).toBeGreaterThan(quiet[0] as number)
    expect(quiet.every((value) => value >= 0)).toBe(true)
  })

  test('drops a trailing partial window instead of scoring it short', () => {
    expect(envelope(new Float32Array(1750), 160)).toHaveLength(10)
  })
})

describe('correlate', () => {
  test('a signal matches itself', () => {
    const shape = envelope(tone(4800, 400), 160)
    expect(correlate(shape, shape)).toBeCloseTo(1, 5)
  })

  // Loudness normalisation raises quiet passages, and the comparison has to survive that or
  // it would report every normalised segment as wrong. Pearson is already gain invariant;
  // this is the test that keeps it that way.
  test('gain does not change the score', () => {
    const quiet = envelope(tone(4800, 400, 0.2), 160)
    const loud = envelope(tone(4800, 400, 0.9), 160)
    expect(correlate(quiet, loud)).toBeCloseTo(1, 5)
  })

  test('unrelated shapes score low', () => {
    const rising = [0, 1, 2, 3, 4, 5, 6, 7]
    const falling = [7, 6, 5, 4, 3, 2, 1, 0]
    expect(correlate(rising, falling)).toBeCloseTo(-1, 5)
  })

  // Silence has no shape to compare. Returning 0 rather than NaN keeps a flat window from
  // poisoning a report with a value nothing can order.
  test('a flat window claims nothing instead of returning NaN', () => {
    expect(correlate([0, 0, 0, 0], [1, 2, 3, 4])).toBe(0)
    expect(Number.isNaN(correlate([0, 0], [0, 0]))).toBe(false)
  })

  test('an empty envelope scores zero', () => {
    expect(correlate([], [1, 2, 3])).toBe(0)
  })
})

describe('auditPlan', () => {
  const placement = (id: string, masterInMs: number, masterOutMs: number, sourceInMs: number) => ({
    id,
    masterInMs,
    masterOutMs,
    sourceInMs,
  })

  test('compares each segment against the source the EDL points at', () => {
    const plan = auditPlan([placement('segment-001', 0, 3000, 10_000)])
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ id: 'segment-001', masterMs: 100, sourceMs: 10_100 })
  })

  // A quarter second of audio correlates with almost anything, so scoring a short segment
  // would add noise to the report rather than coverage.
  test('skips a segment too short to score meaningfully', () => {
    expect(auditPlan([placement('segment-001', 0, 300, 5000)])).toEqual([])
  })

  test('caps the window so a long segment does not decode more than it needs', () => {
    const plan = auditPlan([placement('segment-001', 0, 60_000, 0)])
    expect(plan[0]?.windowMs).toBe(1500)
  })

  test('uses most of a short-but-usable segment', () => {
    const plan = auditPlan([placement('segment-001', 0, 1000, 0)])
    expect(plan[0]?.windowMs).toBe(800)
  })
})

// compareBoundary's own ffmpeg calls already pass -vn on both sides (why: this file's own
// header), so nothing about them cares whether renderPath carries a picture. This is the test
// that proves it against a real file rather than reading the flag: an audio-only render (what
// `vcut render --audio-only` writes) scores the same as a video render of the identical cut.
// Where ffmpeg is absent the behaviour under test cannot exist, so this skips rather than
// fails, the same convention semantic.test.ts's renderedGaps and build-edl.test.ts's
// avmismatch suite already use.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('compareBoundary against an audio-only render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-audit-audio-only-'))
  const sourcePath = join(dir, 'source.mp4')
  const audioOnlyRenderPath = join(dir, 'render.wav')
  const videoRenderPath = join(dir, 'render.mp4')

  beforeAll(async () => {
    const built = await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=rate=30:size=320x240:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=3',
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-y',
      sourcePath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(built.stderr)
    }

    // Both renders carry the identical audio for the same 0-3s window: the audio-only one
    // with -vn, the video one with the picture alongside it, so the two are directly
    // comparable and only the presence of a video stream differs between them.
    const audioOnly = await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-vn',
      '-c:a',
      'pcm_s16le',
      '-y',
      audioOnlyRenderPath,
    ])
    if (audioOnly.exitCode !== 0) {
      throw new Error(audioOnly.stderr)
    }

    const video = await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      sourcePath,
      '-c',
      'copy',
      '-y',
      videoRenderPath,
    ])
    if (video.exitCode !== 0) {
      throw new Error(video.stderr)
    }
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('scores a boundary against a .wav render the same as against the video render', async () => {
    const entry = { id: 'segment-001', masterMs: 100, sourceMs: 100, windowMs: 1500 }

    const audioOnlyCheck = await compareBoundary(
      audioOnlyRenderPath,
      sourcePath,
      entry,
      join(dir, 'scratch-audio-only'),
    )
    const videoCheck = await compareBoundary(
      videoRenderPath,
      sourcePath,
      entry,
      join(dir, 'scratch-video'),
    )

    expect(audioOnlyCheck).not.toBeNull()
    expect(videoCheck).not.toBeNull()
    expect(audioOnlyCheck?.correlation).toBeCloseTo(videoCheck?.correlation as number, 5)
    expect(audioOnlyCheck?.correlation).toBeGreaterThan(0.9)
  })
})
