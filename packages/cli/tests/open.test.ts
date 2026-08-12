import { describe, expect, test } from 'bun:test'
import { nearestRef, type OpenReport, openNext } from '../src/open.ts'

const blocks = [
  { ref: 'b1', startMs: 0, endMs: 2000 },
  { ref: 'b2', startMs: 2500, endMs: 6000 },
  { ref: 'b3', startMs: 6300, endMs: 10_000 },
]

describe('nearestRef', () => {
  test('a position inside a block returns that block', () => {
    expect(nearestRef(1000, blocks)).toBe('b1')
    expect(nearestRef(3000, blocks)).toBe('b2')
  })

  test('a position in a silence gap returns the closer edge', () => {
    // 2200 is 200ms from b1's end, 300ms from b2's start.
    expect(nearestRef(2200, blocks)).toBe('b1')
    expect(nearestRef(2400, blocks)).toBe('b2')
  })

  test('empty blocks return null', () => {
    expect(nearestRef(500, [])).toBeNull()
  })
})

describe('openNext', () => {
  const base: OpenReport = {
    version: 1,
    sessionDir: '/tmp/session',
    input: '/tmp/media.mp4',
    durationMs: 60_000,
    preset: 'clean',
    lang: 'es',
    gen: 1,
    cached: false,
    silenceCount: 5,
    blockCount: 6,
    transcriptPresent: true,
    suspects: [],
    fresh: true,
    hasVideo: true,
  }

  test('hints a transcript when none is cached', () => {
    const hints = openNext({ ...base, transcriptPresent: false })
    expect(hints.some((hint) => hint.verb.includes('trx transcribe'))).toBe(true)
  })

  test('does not hint a transcript when one is already present', () => {
    const hints = openNext(base)
    expect(hints.some((hint) => hint.verb.includes('trx transcribe'))).toBe(false)
  })

  test('hints the top suspect when suspects exist', () => {
    const hints = openNext({
      ...base,
      suspects: [{ atMs: 12_340, gapMs: 100, ratio: 0.2, nearestRef: 'b2' }],
    })
    expect(hints.some((hint) => hint.verb.includes('--at 12.34'))).toBe(true)
  })

  test('always hints re-tuning the preset', () => {
    const hints = openNext(base)
    expect(hints.some((hint) => hint.verb.includes('--preset'))).toBe(true)
  })
})
