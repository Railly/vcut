import { describe, expect, test } from 'bun:test'
import { findSuspects, suspectsNext } from '../src/suspects.ts'

// Pauses at a steady cadence, which is what fluent delivery produces.
const fluent = (count: number, everyMs = 2000): Array<{ startMs: number; endMs: number }> =>
  Array.from({ length: count }, (_, index) => ({
    startMs: index * everyMs,
    endMs: index * everyMs + 400,
  }))

describe('findSuspects', () => {
  test('says nothing about speech that pauses at an even cadence', () => {
    expect(findSuspects(fluent(10), 300, 0.4).suspects).toEqual([])
  })

  // The signal is causal: correcting yourself mid-sentence breaks delivery into pauses that
  // land close together, while thinking between sentences spaces them out.
  test('names the position where two pauses land close together', () => {
    const withCluster = [
      ...fluent(5),
      { startMs: 10_000, endMs: 10_400 },
      { startMs: 10_500, endMs: 10_900 },
      ...fluent(4, 2000).map((pause) => ({
        startMs: pause.startMs + 12_000,
        endMs: pause.endMs + 12_000,
      })),
    ]
    const found = findSuspects(withCluster, 300, 0.4)
    expect(found.suspects.map((suspect) => suspect.atMs)).toContain(10_000)
  })

  // A recording read from a script had a median gap of 8916ms against 1170ms for the same
  // speaker talking off the cuff. A fixed millisecond threshold would drown one and miss the
  // other; a fraction of the file's own median absorbs the difference.
  test('normalises against the recording rather than a fixed duration', () => {
    const slow = fluent(10, 9000)
    const fast = fluent(10, 1000)
    expect(findSuspects(slow, 300, 0.4).suspects).toEqual([])
    expect(findSuspects(fast, 300, 0.4).suspects).toEqual([])
    expect(findSuspects(slow, 300, 0.4).medianGapMs).toBeGreaterThan(
      findSuspects(fast, 300, 0.4).medianGapMs,
    )
  })

  test('reports the tightest cluster first, since that is where to spend a call', () => {
    const pauses = [
      { startMs: 0, endMs: 400 },
      { startMs: 3000, endMs: 3400 },
      { startMs: 3600, endMs: 4000 },
      { startMs: 7000, endMs: 7400 },
      { startMs: 7450, endMs: 7850 },
      { startMs: 11_000, endMs: 11_400 },
    ]
    const found = findSuspects(pauses, 300, 0.4)
    expect(found.suspects.length).toBeGreaterThan(1)
    expect(found.suspects[0].gapMs).toBeLessThanOrEqual(found.suspects[1].gapMs)
  })

  test('ignores silences shorter than the run asked for', () => {
    const pauses = [
      { startMs: 0, endMs: 400 },
      { startMs: 1000, endMs: 1050 },
      { startMs: 1100, endMs: 1150 },
      { startMs: 4000, endMs: 4400 },
      { startMs: 8000, endMs: 8400 },
    ]
    const found = findSuspects(pauses, 300, 0.4)
    expect(found.pausesConsidered).toBe(3)
  })

  test('answers nothing rather than guessing from too few pauses', () => {
    expect(findSuspects([{ startMs: 0, endMs: 400 }], 300, 0.4)).toMatchObject({
      suspects: [],
      pausesConsidered: 1,
    })
  })

  // The plateau measured on one recording: 0.3, 0.4 and 0.5 all found every defect with no
  // false positives, which is why the default sits in the middle and is a flag.
  test('widens as the ratio rises', () => {
    const pauses = [
      { startMs: 0, endMs: 400 },
      { startMs: 2000, endMs: 2400 },
      { startMs: 2900, endMs: 3300 },
      { startMs: 5000, endMs: 5400 },
      { startMs: 5600, endMs: 6000 },
      { startMs: 9000, endMs: 9400 },
    ]
    const narrow = findSuspects(pauses, 300, 0.2).suspects.length
    const wide = findSuspects(pauses, 300, 0.8).suspects.length
    expect(wide).toBeGreaterThanOrEqual(narrow)
  })
})

describe('suspectsNext', () => {
  test('is empty when there is nothing to point at', () => {
    expect(suspectsNext('/media.mp4', [])).toEqual([])
  })

  test('names a non-empty question and a non-empty verb for each entry', () => {
    const hints = suspectsNext('/media.mp4', [
      { atMs: 10_000, gapMs: 50, ratio: 0.1 },
      { atMs: 20_000, gapMs: 60, ratio: 0.2 },
    ])
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.question.length).toBeGreaterThan(0)
      expect(hint.verb.length).toBeGreaterThan(0)
    }
  })

  test('the single-position verb runs vcut say --at, the sweep verb runs --positions', () => {
    const hints = suspectsNext('/media.mp4', [{ atMs: 10_000, gapMs: 50, ratio: 0.1 }])
    expect(hints.some((hint) => hint.verb.includes('--at'))).toBe(true)
    expect(hints.some((hint) => hint.verb.includes('--positions'))).toBe(true)
  })
})
