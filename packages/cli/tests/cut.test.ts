import { describe, expect, test } from 'bun:test'
import {
  parseMsRangeArgs,
  parseSpanArg,
  quoteRemovedText,
  resolveRefsRange,
  validateKind,
  validateReason,
  validateSpanBounds,
} from '../src/cut.ts'
import type { Word } from '../src/detect.ts'
import { UsageError } from '../src/output.ts'

const refs = {
  gen: 3,
  blocks: [
    { ref: 'b042', startMs: 662_400, endMs: 663_400, durationMs: 1000 },
    { ref: 'b043', startMs: 664_100, endMs: 664_500, durationMs: 400 },
    { ref: 'b044', startMs: 665_000, endMs: 670_600, durationMs: 5600 },
  ],
}

describe('resolveRefsRange', () => {
  test("a single ref resolves to that block's own span", () => {
    const result = resolveRefsRange('b042', refs)
    expect(result.span).toEqual({ startMs: 662_400, endMs: 663_400 })
    expect(result.refs).toEqual(['b042'])
  })

  test("a range spans from the first ref's start to the second ref's end", () => {
    const result = resolveRefsRange('b042..b044', refs)
    expect(result.span).toEqual({ startMs: 662_400, endMs: 670_600 })
    expect(result.refs).toEqual(['b042', 'b044'])
  })

  test('an unknown ref throws a usage error naming the ref and the current gen', () => {
    expect(() => resolveRefsRange('b099', refs)).toThrow(UsageError)
    try {
      resolveRefsRange('b099', refs)
      throw new Error('expected resolveRefsRange to throw')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('b099')
      expect(message).toContain('gen 3')
    }
  })

  test('a ref from a stale gen (not present in current refs) throws naming the current gen', () => {
    // The session moved to gen 3; a ref an agent remembers from gen 1 is not in refs.blocks at
    // all once a re-open with a different preset regenerated them, so it resolves the same way
    // an unknown ref does: peek's resolveRef does not track which gen a ref used to belong to,
    // it only knows what is in the current refs file.
    expect(() => resolveRefsRange('b001', refs)).toThrow(UsageError)
  })

  test('no refs at all throws telling the caller to open first', () => {
    expect(() => resolveRefsRange('b042', null)).toThrow(UsageError)
    try {
      resolveRefsRange('b042', null)
      throw new Error('expected resolveRefsRange to throw')
    } catch (error) {
      expect((error as Error).message).toContain('vcut open')
    }
  })

  test('a reversed range is a usage error, not a silent swap', () => {
    expect(() => resolveRefsRange('b044..b042', refs)).toThrow(UsageError)
    try {
      resolveRefsRange('b044..b042', refs)
      throw new Error('expected resolveRefsRange to throw')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('backwards')
      expect(message).toContain('b042..b044')
    }
  })

  test('malformed range syntax is a usage error', () => {
    expect(() => resolveRefsRange('b042..b043..b044', refs)).toThrow(UsageError)
    expect(() => resolveRefsRange('b042..', refs)).toThrow(UsageError)
    expect(() => resolveRefsRange('..b044', refs)).toThrow(UsageError)
  })
})

describe('parseSpanArg', () => {
  test('parses seconds to a millisecond span', () => {
    expect(parseSpanArg('0..13.25')).toEqual({ startMs: 0, endMs: 13_250 })
  })

  test('rejects a span where end is not after start', () => {
    expect(() => parseSpanArg('10..10')).toThrow(UsageError)
    expect(() => parseSpanArg('10..5')).toThrow(UsageError)
  })

  test('rejects non-numeric input', () => {
    expect(() => parseSpanArg('a..b')).toThrow(UsageError)
  })

  test('rejects malformed range syntax', () => {
    expect(() => parseSpanArg('10')).toThrow(UsageError)
    expect(() => parseSpanArg('10..20..30')).toThrow(UsageError)
  })
})

describe('parseMsRangeArgs', () => {
  test('reads raw milliseconds with no unit conversion', () => {
    expect(parseMsRangeArgs('662400', '670600')).toEqual({ startMs: 662_400, endMs: 670_600 })
  })

  test('rejects an inverted or zero-length range', () => {
    expect(() => parseMsRangeArgs('1000', '1000')).toThrow(UsageError)
    expect(() => parseMsRangeArgs('1000', '500')).toThrow(UsageError)
  })

  test('rejects a negative start', () => {
    expect(() => parseMsRangeArgs('-100', '500')).toThrow(UsageError)
  })

  test('rejects non-integer input', () => {
    expect(() => parseMsRangeArgs('a', '500')).toThrow(UsageError)
    expect(() => parseMsRangeArgs('100.5', '500')).toThrow(UsageError)
  })
})

describe('validateSpanBounds', () => {
  test('accepts a span within the source duration', () => {
    expect(() => validateSpanBounds({ startMs: 0, endMs: 5_000 }, 10_000)).not.toThrow()
  })

  test('rejects a span running past the source duration', () => {
    expect(() => validateSpanBounds({ startMs: 9_000, endMs: 11_000 }, 10_000)).toThrow(UsageError)
    try {
      validateSpanBounds({ startMs: 9_000, endMs: 11_000 }, 10_000)
      throw new Error('expected validateSpanBounds to throw')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('11000')
      expect(message).toContain('10000ms source')
    }
  })
})

describe('validateKind', () => {
  test('accepts each of the four semantic kinds', () => {
    for (const kind of ['false-start', 'repetition', 'tangent', 'filler']) {
      expect(validateKind(kind)).toBe(kind as never)
    }
  })

  test('rejects an unknown kind, and non-speech specifically (build-only, not a cut kind)', () => {
    expect(() => validateKind('non-speech')).toThrow(UsageError)
    expect(() => validateKind('bogus')).toThrow(UsageError)
  })

  test('rejects a missing kind', () => {
    expect(() => validateKind(undefined)).toThrow(UsageError)
  })
})

describe('validateReason', () => {
  test('accepts a non-empty reason', () => {
    expect(validateReason('borra el estornudo')).toBe('borra el estornudo')
  })

  test('rejects a missing or empty reason', () => {
    expect(() => validateReason(undefined)).toThrow(UsageError)
    expect(() => validateReason('')).toThrow(UsageError)
    expect(() => validateReason('   ')).toThrow(UsageError)
  })
})

describe('quoteRemovedText', () => {
  const word = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs })

  test('joins words whose span overlaps the cut span, in order', () => {
    const words = [
      word('Quiero', 662_420, 662_720),
      word('estornudar.', 662_720, 664_640),
      word('Eso', 669_040, 669_270),
      word('sí,', 669_270, 669_550),
      word('borra', 669_550, 670_000),
      word('la', 670_000, 670_000),
      word('profa.', 670_000, 670_560),
    ]
    const text = quoteRemovedText({ startMs: 662_400, endMs: 670_600 }, words)
    expect(text).toBe('Quiero estornudar. Eso sí, borra la profa.')
  })

  test('empty span or no overlapping words returns an empty string', () => {
    const words = [word('hola', 0, 500)]
    expect(quoteRemovedText({ startMs: 10_000, endMs: 20_000 }, words)).toBe('')
    expect(quoteRemovedText({ startMs: 0, endMs: 500 }, [])).toBe('')
  })
})
