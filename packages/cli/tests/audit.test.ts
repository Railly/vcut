import { describe, expect, test } from 'bun:test'
import { auditPlan, correlate, envelope } from '../src/audit.ts'

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
