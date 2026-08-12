import { describe, expect, test } from 'bun:test'
import {
  coverage,
  foldToken,
  MERGE_GAP_MS,
  MIN_SPAN_MS,
  mergeAdjacent,
  opcodes,
  type RecoveredSpan,
  recoverCuts,
  toTokens,
} from '../src/align.ts'
import type { Word } from '../src/detect.ts'

const word = (text: string, startMs: number, endMs: number): Word => ({
  text,
  startsWord: true,
  startMs,
  endMs,
})

/** A word stream from a sentence, one word per 500ms starting at `startMs`. */
const stream = (sentence: string, startMs = 0, stepMs = 500): Word[] =>
  sentence
    .split(' ')
    .map((text, index) => word(text, startMs + index * stepMs, startMs + index * stepMs + 400))

// Two independent transcriptions of the same speech disagree about accents and punctuation
// routinely. Every one of those disagreements would read as an edit the human made if the
// comparison ran on raw text.
describe('foldToken', () => {
  test('folds diacritics so the same word from two transcriptions matches', () => {
    expect(foldToken('información')).toBe('informacion')
    expect(foldToken('INFORMACIÓN')).toBe(foldToken('informacion'))
    expect(foldToken('añadir')).toBe('anadir')
  })

  test('strips punctuation, which one pass adds and the other does not', () => {
    expect(foldToken('sí,')).toBe('si')
    expect(foldToken('¿Qué?')).toBe('que')
    expect(foldToken('"prueba".')).toBe('prueba')
  })

  test('a cue carrying only punctuation folds away to nothing', () => {
    expect(foldToken('.')).toBe('')
    expect(foldToken('¿')).toBe('')
    expect(foldToken('   ')).toBe('')
  })

  test('keeps numbers, which are words a boundary can fall on', () => {
    expect(foldToken('2026')).toBe('2026')
  })
})

describe('toTokens', () => {
  test('drops cues that fold to nothing rather than aligning on them', () => {
    const tokens = toTokens([word('hola', 0, 400), word('.', 400, 400), word('mundo', 500, 900)])
    expect(tokens.map((entry) => entry.token)).toEqual(['hola', 'mundo'])
  })

  test('carries each token own timing, which is what makes a span recoverable', () => {
    const tokens = toTokens([word('Información,', 1_000, 1_400)])
    expect(tokens[0]).toEqual({
      token: 'informacion',
      startMs: 1_000,
      endMs: 1_400,
      text: 'Información,',
    })
  })
})

// The opcodes walk is the load-bearing part, and its contract is difflib's: the tags cover both
// sequences completely and in order. These three cases were checked against
// difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes() and match it exactly, plus a
// 300-case randomised differential run at implementation time that matched on every case.
describe('opcodes', () => {
  test('a clean deletion, the shape a cut makes', () => {
    const a = 'uno dos tres cuatro cinco seis siete ocho'.split(' ')
    const b = 'uno dos siete ocho'.split(' ')
    expect(opcodes(a, b).map((op) => [op.tag, op.aStart, op.aEnd, op.bStart, op.bEnd])).toEqual([
      ['equal', 0, 2, 0, 2],
      ['delete', 2, 6, 2, 2],
      ['equal', 6, 8, 2, 4],
    ])
  })

  test('a replacement, the shape a cut landing mid-phrase makes', () => {
    const a = 'hola mundo esto es una prueba final'.split(' ')
    const b = 'hola mundo esto era una prueba final'.split(' ')
    expect(opcodes(a, b).map((op) => [op.tag, op.aStart, op.aEnd, op.bStart, op.bEnd])).toEqual([
      ['equal', 0, 3, 0, 3],
      ['replace', 3, 4, 3, 4],
      ['equal', 4, 7, 4, 7],
    ])
  })

  test('insertions on both ends, which are the transcriber and never an edit', () => {
    expect(
      opcodes('a b c'.split(' '), 'x a b c y'.split(' ')).map((op) => [
        op.tag,
        op.aStart,
        op.aEnd,
        op.bStart,
        op.bEnd,
      ]),
    ).toEqual([
      ['insert', 0, 0, 0, 1],
      ['equal', 0, 3, 1, 4],
      ['insert', 3, 3, 4, 5],
    ])
  })

  test('identical streams are one equal run and nothing else', () => {
    const a = 'uno dos tres'.split(' ')
    expect(opcodes(a, a)).toEqual([{ tag: 'equal', aStart: 0, aEnd: 3, bStart: 0, bEnd: 3 }])
  })

  test('an empty reference is one delete covering the whole source', () => {
    expect(opcodes('uno dos'.split(' '), [])).toEqual([
      { tag: 'delete', aStart: 0, aEnd: 2, bStart: 0, bEnd: 0 },
    ])
  })

  test('the tags cover both sequences completely and in order, difflib own invariant', () => {
    const a = 'a b c d e f g h i'.split(' ')
    const b = 'a x c d q f g'.split(' ')
    let aCursor = 0
    let bCursor = 0
    for (const op of opcodes(a, b)) {
      expect(op.aStart).toBe(aCursor)
      expect(op.bStart).toBe(bCursor)
      aCursor = op.aEnd
      bCursor = op.bEnd
    }
    expect(aCursor).toBe(a.length)
    expect(bCursor).toBe(b.length)
  })
})

describe('mergeAdjacent', () => {
  const span = (startMs: number, endMs: number, removedText: string): RecoveredSpan => ({
    startMs,
    endMs,
    durationMs: endMs - startMs,
    removedText,
    wordCount: removedText.split(' ').length,
  })

  // The case this exists for: a human's single cut comes back as two deletions with one
  // survivor word wedged between them that both takes transcribed identically.
  test('two deletions separated by less than the gap are one cut', () => {
    const merged = mergeAdjacent([
      span(1_000, 4_100, 'primera mitad'),
      span(4_500, 7_000, 'segunda mitad'),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.startMs).toBe(1_000)
    expect(merged[0]?.endMs).toBe(7_000)
    expect(merged[0]?.durationMs).toBe(6_000)
    expect(merged[0]?.wordCount).toBe(4)
  })

  test('the merged quote shows the join rather than reading as one continuous phrase', () => {
    const merged = mergeAdjacent([span(0, 1_000, 'primera'), span(1_200, 2_000, 'segunda')])
    expect(merged[0]?.removedText).toBe('primera · segunda')
  })

  test('a gap at or above the threshold keeps them separate', () => {
    const merged = mergeAdjacent([
      span(0, 1_000, 'primera'),
      span(1_000 + MERGE_GAP_MS, 3_000, 'segunda'),
    ])
    expect(merged).toHaveLength(2)
  })

  test('sorts before merging, so an out-of-order list does not split a real cut', () => {
    const merged = mergeAdjacent([span(4_500, 7_000, 'segunda'), span(1_000, 4_100, 'primera')])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.removedText).toBe('primera · segunda')
  })

  test('an empty list merges to an empty list', () => {
    expect(mergeAdjacent([])).toEqual([])
  })

  test('does not mutate the spans it was given', () => {
    const first = span(0, 1_000, 'primera')
    mergeAdjacent([first, span(1_200, 2_000, 'segunda')])
    expect(first.endMs).toBe(1_000)
    expect(first.removedText).toBe('primera')
  })
})

describe('recoverCuts', () => {
  // The headline case: the reference simply does not carry a run of the source's words.
  test('recovers a clean deletion with its source timing and the words it removed', () => {
    const source = stream('uno dos tres cuatro cinco seis siete ocho')
    const reference = stream('uno dos siete ocho')
    const spans = recoverCuts(source, reference)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.startMs).toBe(1_000)
    expect(spans[0]?.endMs).toBe(2_900)
    expect(spans[0]?.removedText).toBe('tres cuatro cinco seis')
    expect(spans[0]?.wordCount).toBe(4)
  })

  // A replace opcode is a cut whose boundary landed mid-phrase plus the transcriber hearing the
  // survivors differently. Its source side is still material the reference does not carry.
  test('recovers a replacement as a removed span, not as an equal run', () => {
    const source = stream('hola esto es una prueba muy larga de verdad final')
    const reference = stream('hola esto ERA distinto final')
    const spans = recoverCuts(source, reference)
    expect(spans.length).toBeGreaterThan(0)
    expect(spans[0]?.removedText).toContain('es')
  })

  // Two transcriptions of the same speech fuse and split words differently. A one-word
  // disagreement is noise, and reporting it as an edit is exactly what MIN_SPAN_MS prevents.
  test('a fused word disagreement under the minimum span is not reported as a cut', () => {
    const source = [
      word('cra', 0, 200),
      word('fter', 200, 400),
      word('station', 500, 900),
      word('construye', 1_000, 1_400),
    ]
    const reference = [
      word('crafter', 0, 400),
      word('station', 500, 900),
      word('construye', 1_000, 1_400),
    ]
    expect(recoverCuts(source, reference)).toEqual([])
  })

  test('a span shorter than the minimum is dropped as transcription noise', () => {
    const source = stream('uno dos tres cuatro', 0, 200)
    const reference = stream('uno tres cuatro', 0, 200)
    expect(recoverCuts(source, reference)).toEqual([])
    // The same disagreement over a wide enough span is a real edit and is reported.
    const wide = recoverCuts(stream('uno dos tres cuatro', 0, 900), stream('uno cuatro', 0, 900))
    expect(wide).toHaveLength(1)
    expect(wide[0]?.durationMs).toBeGreaterThanOrEqual(MIN_SPAN_MS)
  })

  test('folds diacritics and punctuation, so an accent disagreement is not an edit', () => {
    const source = [
      word('la', 0, 400),
      word('información', 500, 900),
      word('importa', 1_000, 1_400),
    ]
    const reference = [
      word('la', 0, 400),
      word('informacion,', 500, 900),
      word('importa', 1_000, 1_400),
    ]
    expect(recoverCuts(source, reference)).toEqual([])
  })

  test('identical streams recover no cuts at all', () => {
    const source = stream('uno dos tres cuatro cinco')
    expect(recoverCuts(source, source)).toEqual([])
  })

  test('two separate cuts come back as two spans, in source order', () => {
    const source = stream('uno dos tres cuatro cinco seis siete ocho nueve diez once doce')
    const reference = stream('uno dos siete ocho doce')
    const spans = recoverCuts(source, reference)
    expect(spans).toHaveLength(2)
    expect(spans[0]?.removedText).toBe('tres cuatro cinco seis')
    expect(spans[1]?.removedText).toBe('nueve diez once')
    expect(spans[0]?.startMs).toBeLessThan(spans[1]?.startMs ?? 0)
  })

  // A reference that transcribed to nothing means the whole source is "missing", which is a
  // broken transcription rather than an edit that removed everything.
  test('an empty reference stream recovers nothing rather than one span over the whole file', () => {
    expect(recoverCuts(stream('uno dos tres cuatro'), [])).toEqual([])
  })

  test('an empty source stream recovers nothing', () => {
    expect(recoverCuts([], stream('uno dos'))).toEqual([])
  })

  test('words the reference adds are ignored: an edit removes, it never records new speech', () => {
    const source = stream('uno dos tres cuatro cinco')
    const reference = [...stream('uno dos tres cuatro cinco'), word('extra', 9_000, 9_400)]
    expect(recoverCuts(source, reference)).toEqual([])
  })
})

describe('coverage', () => {
  test('a span nothing overlaps is uncovered', () => {
    expect(coverage({ startMs: 0, endMs: 1_000 }, [{ startMs: 2_000, endMs: 3_000 }])).toBe(0)
  })

  test('a span fully contained in another is fully covered', () => {
    expect(coverage({ startMs: 1_000, endMs: 2_000 }, [{ startMs: 0, endMs: 5_000 }])).toBe(1)
  })

  test('partial overlap reports the fraction', () => {
    expect(coverage({ startMs: 0, endMs: 1_000 }, [{ startMs: 500, endMs: 5_000 }])).toBe(0.5)
  })

  // Two EDL cuts reaching into the same recovered span would double-count without the union,
  // and report more than full coverage for a span neither of them covers.
  test('overlapping others are unioned rather than summed', () => {
    expect(
      coverage({ startMs: 0, endMs: 1_000 }, [
        { startMs: 0, endMs: 600 },
        { startMs: 400, endMs: 800 },
      ]),
    ).toBe(0.8)
  })

  test('several disjoint others each contribute their own overlap', () => {
    expect(
      coverage({ startMs: 0, endMs: 1_000 }, [
        { startMs: 0, endMs: 200 },
        { startMs: 800, endMs: 1_000 },
      ]),
    ).toBe(0.4)
  })

  test('a zero-width span is uncovered rather than a division by zero', () => {
    expect(coverage({ startMs: 500, endMs: 500 }, [{ startMs: 0, endMs: 1_000 }])).toBe(0)
  })

  test('no others at all is uncovered', () => {
    expect(coverage({ startMs: 0, endMs: 1_000 }, [])).toBe(0)
  })
})
