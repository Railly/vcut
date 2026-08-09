import { describe, expect, test } from 'bun:test'
import {
  absorbSlivers,
  type Cut,
  clampToWords,
  invertToSegments,
  matchTarget,
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

  const MIN = 300

  test('pulls a cut start out of a spoken word', () => {
    const clamped = clampToWords(silence(1000, 2000), boundaries, MIN)
    expect(clamped?.startMs).toBe(1200)
    expect(clamped?.endMs).toBe(2000)
  })

  test('pulls a cut end out of a spoken word', () => {
    const clamped = clampToWords(silence(1500, 3000), boundaries, MIN)
    expect(clamped?.startMs).toBe(1500)
    expect(clamped?.endMs).toBe(2800)
  })

  test('leaves a cut that already sits between words untouched', () => {
    const clamped = clampToWords(silence(1300, 2700), boundaries, MIN)
    expect(clamped).toEqual(silence(1300, 2700))
  })

  test('keeps a measured cut that a swallowing cue would erase', () => {
    // whisper --max-len 1 stretches a cue to the next word, so a word's range
    // routinely covers the pause after it. ffmpeg measured a real silence here.
    const swallowing = wordBoundaries({
      words: [{ text: 'trabajando', startMs: 0, endMs: 5000 }],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 2000), swallowing, MIN)).toEqual(silence(1000, 2000))
  })

  test('drops a cut that was already shorter than the detector minimum', () => {
    const swallowing = wordBoundaries({
      words: [{ text: 'larga', startMs: 0, endMs: 5000 }],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 1100), swallowing, MIN)).toBeNull()
  })

  test('drops a sliver left by clamping when the source cut was also short', () => {
    const tight = wordBoundaries({
      words: [
        { text: 'uno', startMs: 900, endMs: 1150 },
        { text: 'dos', startMs: 1200, endMs: 1500 },
      ],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 1250), tight, MIN)).toBeNull()
  })
})

describe('snapToFrame', () => {
  const frameMs = 1000 / 60

  test('lands mid-frame, away from the edge where rounding flips', () => {
    // A frame boundary is not a whole millisecond at 60fps, so the value cannot sit
    // exactly on it. Landing in the middle keeps ffmpeg's own rounding stable.
    for (const input of [1097, 4634, 333, 15_833]) {
      const snapped = snapToFrame(input, 60)
      const offset = ((snapped % frameMs) + frameMs) % frameMs
      expect(Math.abs(offset - frameMs / 2)).toBeLessThan(1)
    }
  })

  test('stays within half a frame of the requested time', () => {
    for (const input of [1097, 4634, 333, 15_833]) {
      expect(Math.abs(snapToFrame(input, 60) - input)).toBeLessThanOrEqual(frameMs)
    }
  })

  test('picks the same frame no matter how it is approached', () => {
    const target = Math.round(120 * frameMs)
    expect(snapToFrame(target - 3, 60)).toBe(snapToFrame(target + 3, 60))
  })

  test('leaves values untouched when fps is unknown', () => {
    expect(snapToFrame(1097, 0)).toBe(1097)
  })

  test('resolves each boundary to an unambiguous frame index', () => {
    const durationMs = 10_000
    const segments = invertToSegments([silence(2000, 3000)], durationMs, 'take-01', 100, 60)
    for (const segment of segments) {
      for (const boundary of [segment.inMs, segment.outMs]) {
        // The end of the source is clamped to the real duration, not snapped: a
        // segment must never claim material past the end of the file.
        if (boundary === durationMs) {
          continue
        }
        // Everywhere else, mid-frame placement puts the fractional part near 0.5,
        // so the frame ffmpeg resolves to is the same from either direction.
        expect(Math.abs(((boundary / frameMs) % 1) - 0.5)).toBeLessThan(0.1)
      }
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

describe('absorbSlivers', () => {
  const cut = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'silence' })

  test('merges two cuts across a remainder too short to be speech', () => {
    const merged = absorbSlivers([cut(0, 1_000), cut(1_200, 2_000)], 300)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 2_000 })
  })

  test('keeps two cuts apart when real speech survives between them', () => {
    expect(absorbSlivers([cut(0, 1_000), cut(2_000, 3_000)], 300)).toHaveLength(2)
  })

  test('collapses a run of stutters into one cut', () => {
    const merged = absorbSlivers([cut(0, 500), cut(700, 900), cut(1_100, 1_400)], 300)
    expect(merged).toHaveLength(1)
    expect(merged[0].endMs).toBe(1_400)
  })

  test('a merged cut reports as silence when its parts disagree', () => {
    const merged = absorbSlivers([cut(0, 500), { startMs: 600, endMs: 900, reason: 'filler' }], 300)
    expect(merged[0].reason).toBe('silence')
  })

  test('leaves a single cut alone', () => {
    expect(absorbSlivers([cut(0, 1_000)], 300)).toEqual([cut(0, 1_000)])
  })

  test('stops islands of pure margin reaching the EDL', () => {
    // Two silences 216ms apart at a 100ms margin. The remainder is margin on both sides and
    // nothing else, which is what turned one pause into three audible stutters. Without the
    // absorb step this inverts to three segments with a sliver in the middle.
    const segments = invertToSegments(
      [cut(1_000, 2_000), cut(2_216, 3_000)],
      10_000,
      'src',
      100,
      60,
    )
    expect(segments).toHaveLength(2)
  })
})

describe('matchTarget bounds', () => {
  test('says above, not below, when more was removed than any range allows', () => {
    expect(matchTarget(45.4)).toContain('above every target range')
  })

  test('still says below when the source barely moved', () => {
    expect(matchTarget(2)).toContain('below every target range')
  })

  test('names the range at its exact ceiling', () => {
    expect(matchTarget(45)).toContain('event or interview')
  })
})
