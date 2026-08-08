import { describe, expect, test } from 'bun:test'
import {
  type Cut,
  clampToWords,
  invertToSegments,
  mergeIntervals,
  snapToFrame,
  wordBoundaries,
} from '../src/build-edl.ts'
import type { Transcript } from '../src/detect.ts'

const silence = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'silence' })
const filler = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'filler' })

describe('mergeIntervals', () => {
  test('sorts and fuses overlapping cuts', () => {
    const merged = mergeIntervals([silence(5000, 6000), silence(1000, 2000), silence(1500, 3000)])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ startMs: 1000, endMs: 3000 })
    expect(merged[1]).toMatchObject({ startMs: 5000, endMs: 6000 })
  })

  test('keeps adjacent-but-disjoint cuts separate', () => {
    expect(mergeIntervals([silence(0, 1000), silence(1001, 2000)])).toHaveLength(2)
  })

  test('does not mutate the caller array', () => {
    const input = [silence(1000, 2000), silence(1500, 3000)]
    mergeIntervals(input)
    expect(input[0].endMs).toBe(2000)
  })

  test('degrades a fused mixed-reason cut to silence', () => {
    const merged = mergeIntervals([filler(1000, 2000), silence(1500, 3000)])
    expect(merged).toHaveLength(1)
    expect(merged[0].reason).toBe('silence')
  })
})

describe('clampToWords', () => {
  const boundaries = wordBoundaries({
    words: [
      { text: 'hola', startMs: 900, endMs: 1200 },
      { text: 'mundo', startMs: 2800, endMs: 3200 },
    ],
    wordLevel: true,
  } as Transcript)

  test('pulls a cut start out of a spoken word', () => {
    const clamped = clampToWords(silence(1000, 2000), boundaries)
    expect(clamped?.startMs).toBe(1200)
    expect(clamped?.endMs).toBe(2000)
  })

  test('pulls a cut end out of a spoken word', () => {
    const clamped = clampToWords(silence(1500, 3000), boundaries)
    expect(clamped?.startMs).toBe(1500)
    expect(clamped?.endMs).toBe(2800)
  })

  test('leaves a cut that already sits between words untouched', () => {
    const clamped = clampToWords(silence(1300, 2700), boundaries)
    expect(clamped).toEqual(silence(1300, 2700))
  })

  test('drops a cut that collapses to nothing after clamping', () => {
    const inside = wordBoundaries({
      words: [{ text: 'larga', startMs: 0, endMs: 5000 }],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 2000), inside)).toBeNull()
  })
})

describe('snapToFrame', () => {
  test('lands on a whole frame boundary at 60fps', () => {
    expect(snapToFrame(1097, 60)).toBe(1100)
    expect(snapToFrame(4634, 60)).toBe(4633)
  })

  test('leaves values untouched when fps is unknown', () => {
    expect(snapToFrame(1097, 0)).toBe(1097)
  })

  test('keeps segment durations an exact frame multiple', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 100, 60)
    const frameMs = 1000 / 60
    for (const segment of segments) {
      const frames = (segment.outMs - segment.inMs) / frameMs
      expect(Math.abs(frames - Math.round(frames))).toBeLessThan(0.02)
    }
  })
})

describe('invertToSegments', () => {
  test('keeps the spans between cuts', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ id: 'segment-001', inMs: 0, outMs: 2000 })
    expect(segments[1]).toMatchObject({ id: 'segment-002', inMs: 3000, outMs: 10_000 })
  })

  test('drops a leading cut that starts at zero without emitting an empty segment', () => {
    const segments = invertToSegments([silence(0, 1197)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 1197, outMs: 10_000 })
  })

  test('emits no margin-only sliver when a cut starts at zero', () => {
    const segments = invertToSegments([silence(0, 1197)], 10_000, 'take-01', 100)
    expect(segments).toHaveLength(1)
    expect(segments[0].inMs).toBe(1097)
    expect(segments.every((segment) => segment.outMs - segment.inMs > 100)).toBe(true)
  })

  test('drops a trailing cut that runs to the end of the source', () => {
    const segments = invertToSegments([silence(9000, 10_000)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 0, outMs: 9000 })
  })

  test('never exceeds the source duration when applying margins', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 100)
    expect(segments.every((segment) => segment.outMs <= 10_000)).toBe(true)
    expect(segments.every((segment) => segment.inMs >= 0)).toBe(true)
    expect(segments[0].outMs).toBe(2100)
    expect(segments[1].inMs).toBe(2900)
  })

  test('emits monotonic non-overlapping segments for many cuts', () => {
    const cuts = Array.from({ length: 50 }, (_, index) =>
      silence(index * 1000 + 500, index * 1000 + 800),
    )
    const segments = invertToSegments(cuts, 60_000, 'take-01', 0)
    expect(segments.every((segment) => segment.outMs > segment.inMs)).toBe(true)
    for (const [index, segment] of segments.entries()) {
      if (index > 0) {
        expect(segment.inMs).toBeGreaterThanOrEqual(segments[index - 1].outMs)
      }
    }
  })

  test('pads segment ids to the schema pattern', () => {
    const cuts = Array.from({ length: 12 }, (_, index) =>
      silence(index * 1000 + 500, index * 1000 + 800),
    )
    const segments = invertToSegments(cuts, 20_000, 'take-01', 0)
    expect(segments.every((segment) => /^segment-[0-9]{3}$/.test(segment.id))).toBe(true)
    expect(segments[9].id).toBe('segment-010')
  })

  test('marks every segment as proposed with zero semantic risk', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 100)
    expect(segments.every((segment) => segment.approval === 'proposed')).toBe(true)
    expect(segments.every((segment) => segment.semanticRisk === 'none')).toBe(true)
    expect(segments[0].handlesMs).toEqual({ before: 100, after: 100 })
  })

  test('returns the whole source when there is nothing to cut', () => {
    const segments = invertToSegments([], 10_000, 'take-01', 100)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 0, outMs: 10_000 })
  })

  test('returns nothing when a single cut covers the entire source', () => {
    expect(invertToSegments([silence(0, 10_000)], 10_000, 'take-01', 0)).toHaveLength(0)
  })
})
