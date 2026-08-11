import { describe, expect, test } from 'bun:test'
import { UsageError } from '../src/output.ts'
import { resolveRef, spanFromAt, viewsDisagree } from '../src/peek.ts'

describe('resolveRef', () => {
  const refs = {
    gen: 2,
    blocks: [
      { ref: 'b001', startMs: 0, endMs: 2000, durationMs: 2000 },
      { ref: 'b002', startMs: 2500, endMs: 6000, durationMs: 3500 },
    ],
  }

  test('a known ref resolves to its block', () => {
    expect(resolveRef('b002', refs)).toEqual(refs.blocks[1])
  })

  test('an unknown ref throws a usage error naming the ref and the current gen', () => {
    expect(() => resolveRef('b042', refs)).toThrow(UsageError)
    try {
      resolveRef('b042', refs)
      throw new Error('expected resolveRef to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError)
      const message = (error as Error).message
      expect(message).toContain('b042')
      expect(message).toContain('gen 2')
    }
  })

  test('no refs at all throws a usage error telling the caller to open first', () => {
    expect(() => resolveRef('b001', null)).toThrow(UsageError)
    try {
      resolveRef('b001', null)
      throw new Error('expected resolveRef to throw')
    } catch (error) {
      expect((error as Error).message).toContain('vcut open')
    }
  })
})

describe('spanFromAt', () => {
  test('centres the window on the position', () => {
    expect(spanFromAt(10_000, 4000)).toEqual({ startMs: 8000, endMs: 12_000 })
  })

  test('never starts before zero, and keeps the requested width', () => {
    expect(spanFromAt(1000, 4000)).toEqual({ startMs: 0, endMs: 4000 })
  })
})

describe('viewsDisagree', () => {
  test('aligned when transcript and heard carry the same words', () => {
    const result = viewsDisagree(
      'pero espero que les guste mucho',
      'Pero espero que les guste mucho.',
      false,
    )
    expect(result).toEqual({ disagree: false, kind: 'aligned' })
  })

  test('transcript-claims-more: transcript has carrying words heard lacks (fabrication/fusion)', () => {
    const result = viewsDisagree(
      'me ha gustado mucho la comunidad crafter station',
      'la comunidad',
      false,
    )
    expect(result.disagree).toBe(true)
    expect(result.kind).toBe('transcript-claims-more')
  })

  test('heard-more: heard has carrying words transcript lacks (omission)', () => {
    const result = viewsDisagree('', 'lo que decia es que el mundo ha cambiado', false)
    expect(result.disagree).toBe(true)
    expect(result.kind).toBe('heard-more')
  })

  test('soft-speech-below-threshold: blocks read silence over the whole span but heard carries words', () => {
    const result = viewsDisagree('', 'me siento muy', true)
    expect(result).toEqual({ disagree: true, kind: 'soft-speech-below-threshold' })
  })

  test('soft-speech-below-threshold takes priority even when transcript also has words', () => {
    // Constructed case: blocks say silence, but the transcript somehow claimed something too.
    // The manual's honest-limits stance treats "audio carries real speech under threshold" as
    // the more actionable finding, so it wins over the plain word-overlap comparison.
    const result = viewsDisagree('pero espero', 'pero espero que les guste', true)
    expect(result.kind).toBe('soft-speech-below-threshold')
  })

  test('blocksAllSilence with no words heard at all stays aligned, not soft-speech', () => {
    // Silence really is silence when nothing was heard either — soft-speech only fires when
    // heard actually carries something the blocks say should not be there.
    const result = viewsDisagree('', '', true)
    expect(result).toEqual({ disagree: false, kind: 'aligned' })
  })

  test('short words alone (below the 4-letter carrying threshold) do not trigger disagreement', () => {
    const result = viewsDisagree('y no sé', 'y no fue', false)
    expect(result).toEqual({ disagree: false, kind: 'aligned' })
  })
})
