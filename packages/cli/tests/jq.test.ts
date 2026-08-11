import { describe, expect, test } from 'bun:test'
import { runJq } from '../src/jq.ts'

describe('runJq: identity and field access', () => {
  test('identity returns the root value unchanged', () => {
    expect(runJq('.', { a: 1 })).toEqual({ a: 1 })
  })

  test('reads a top-level field', () => {
    expect(runJq('.a', { a: 1, b: 2 })).toBe(1)
  })

  test('reads a nested dot path', () => {
    expect(runJq('.a.b.c', { a: { b: { c: 42 } } })).toBe(42)
  })

  test('an absent field reads as null, matching jq', () => {
    expect(runJq('.missing', { a: 1 })).toBeNull()
  })

  test('reading a field off a scalar throws, naming the path', () => {
    expect(() => runJq('.a.b', { a: 1 })).toThrow(/cannot read field/)
  })
})

describe('runJq: array iteration', () => {
  test('.[] spreads an array into its elements', () => {
    expect(runJq('.[]', [1, 2, 3])).toEqual([1, 2, 3])
  })

  test('.field[] reads a field then spreads it', () => {
    expect(runJq('.items[]', { items: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  test('a single surviving value is unwrapped rather than left in an array', () => {
    expect(runJq('.items[]', { items: ['only'] })).toBe('only')
  })

  test('iterating a non-array throws, naming what it saw instead', () => {
    expect(() => runJq('.a[]', { a: 1 })).toThrow(/cannot iterate/)
  })

  test('a path can alternate field access and iteration: .a[].b[].c', () => {
    const value = { a: [{ b: [{ c: 1 }, { c: 2 }] }, { b: [{ c: 3 }] }] }
    expect(runJq('.a[].b[].c', value)).toEqual([1, 2, 3])
  })

  test('.semanticCuts[].reason projects a field across every array element', () => {
    const value = { semanticCuts: [{ reason: 'eh' }, { reason: 'y luego' }] }
    expect(runJq('.semanticCuts[].reason', value)).toEqual(['eh', 'y luego'])
  })
})

describe('runJq: select()', () => {
  const spans = [
    { reading: 'vocalization-suspect', startMs: 100 },
    { reading: 'words-around', startMs: 200 },
    { reading: 'vocalization-suspect', startMs: 300 },
  ]

  test('filters an array by field equality', () => {
    const result = runJq('.[] | select(.reading == "vocalization-suspect")', spans) as unknown[]
    expect(result).toHaveLength(2)
    expect((result[0] as { startMs: number }).startMs).toBe(100)
  })

  test('filters by numeric equality', () => {
    expect(runJq('.[] | select(.startMs == 200)', spans)).toEqual({
      reading: 'words-around',
      startMs: 200,
    })
  })

  test('filters by inequality', () => {
    const result = runJq('.[] | select(.reading != "words-around")', spans) as unknown[]
    expect(result).toHaveLength(2)
  })

  test('filters by boolean and null literals', () => {
    const rows = [{ ok: true }, { ok: false }, { ok: null }]
    expect(runJq('.[] | select(.ok == true)', rows)).toEqual({ ok: true })
    expect(runJq('.[] | select(.ok == null)', rows)).toEqual({ ok: null })
  })

  test('numeric comparisons: <, <=, >, >=', () => {
    const rows = [{ n: 1 }, { n: 5 }, { n: 10 }]
    expect(runJq('.[] | select(.n < 5)', rows)).toEqual({ n: 1 })
    expect(runJq('.[] | select(.n >= 5)', rows)).toEqual([{ n: 5 }, { n: 10 }])
  })

  test('a comparison operator on non-numbers throws', () => {
    expect(() => runJq('.[] | select(.n < "5")', [{ n: 'x' }])).toThrow(/needs numbers/)
  })

  test('and combines two comparisons', () => {
    const rows = [
      { a: 1, b: 2 },
      { a: 1, b: 3 },
    ]
    expect(runJq('.[] | select(.a == 1 and .b == 2)', rows)).toEqual({ a: 1, b: 2 })
  })

  test('or combines two comparisons', () => {
    const rows = [{ a: 1 }, { a: 2 }, { a: 3 }]
    const result = runJq('.[] | select(.a == 1 or .a == 3)', rows) as unknown[]
    expect(result).toEqual([{ a: 1 }, { a: 3 }])
  })

  test('not() negates an expression', () => {
    const rows = [{ a: 1 }, { a: 2 }]
    expect(runJq('.[] | select(not(.a == 1))', rows)).toEqual({ a: 2 })
  })

  test('an empty selection returns an empty array, not null', () => {
    expect(runJq('.[] | select(.reading == "nope")', spans)).toEqual([])
  })
})

describe('runJq: sort_by()', () => {
  test('sorts an array ascending by a numeric field', () => {
    const value = [{ startMs: 300 }, { startMs: 100 }, { startMs: 200 }]
    expect(runJq('sort_by(.startMs)', value)).toEqual([
      { startMs: 100 },
      { startMs: 200 },
      { startMs: 300 },
    ])
  })

  test('sorts by a nested path', () => {
    const value = [{ a: { n: 3 } }, { a: { n: 1 } }]
    expect(runJq('sort_by(.a.n)', value)).toEqual([{ a: { n: 1 } }, { a: { n: 3 } }])
  })

  test('sort_by on a non-array throws', () => {
    expect(() => runJq('sort_by(.n)', { n: 1 })).toThrow(/needs an array/)
  })

  test('sort_by runs on an array already produced upstream, not per selected element', () => {
    // sort_by expects one array value flowing through the pipe, same as jq's own sort_by. A
    // preceding `.[] | select(...)` produces zero-or-more standalone elements rather than one
    // array (this subset has no `[...]` collect syntax to re-wrap them), so composing the two
    // directly is out of scope: a caller wanting "filter then sort" reaches for that on data
    // that is already an array, which is exactly what sort_by(.field) alone covers.
    const value = [{ startMs: 300 }, { startMs: 100 }, { startMs: 200 }]
    expect(runJq('. | sort_by(.startMs)', value)).toEqual([
      { startMs: 100 },
      { startMs: 200 },
      { startMs: 300 },
    ])
  })
})

describe('runJq: pipes', () => {
  test('chains steps left to right', () => {
    expect(runJq('.a | .b', { a: { b: 5 } })).toBe(5)
  })

  test('a filter then a projection', () => {
    const value = [
      { kind: 'filler', reason: 'a' },
      { kind: 'repetition', reason: 'b' },
    ]
    expect(runJq('.[] | select(.kind == "filler") | .reason', value)).toBe('a')
  })
})

describe('runJq: unsupported syntax', () => {
  test('an unknown function name throws, naming it', () => {
    expect(() => runJq('.[] | filter(.a == 1)', [{ a: 1 }])).toThrow(/unknown function 'filter'/)
  })

  test('object construction ({}) is not supported', () => {
    expect(() => runJq('{a: .b}', { b: 1 })).toThrow()
  })

  test('an unterminated string throws', () => {
    expect(() => runJq('.[] | select(.a == "unterminated', [{ a: 1 }])).toThrow(
      /unterminated string/,
    )
  })

  test('trailing garbage after a valid expression throws', () => {
    expect(() => runJq('.a extra', { a: 1 })).toThrow(/unexpected trailing input|could not parse/)
  })

  test('select() without a leading dot throws', () => {
    expect(() => runJq('.[] | select(a == 1)', [{ a: 1 }])).toThrow()
  })
})
