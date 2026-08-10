import { describe, expect, test } from 'bun:test'
import { containsPhrase, firstClear, normalise } from '../src/converge.ts'

describe('containsPhrase', () => {
  // The case this command exists for: three runs cut the same retake about 1772ms short, each
  // having verified a boundary against a window that read like a clean start.
  test('holds through a transcription that heard the short words differently', () => {
    expect(containsPhrase('Ah, otra vez. Y ahora que conocemos...', 'a la que conocemos')).toBe(
      true,
    )
    expect(containsPhrase('Y al que conocemos, ya llegamos a mil', 'a la que conocemos')).toBe(true)
  })

  test('clears once the carrying word is gone', () => {
    expect(
      containsPhrase('Ya llegamos a mil miembros con un gran trabajo', 'a la que conocemos'),
    ).toBe(false)
  })

  test('reads through case and punctuation', () => {
    expect(containsPhrase('¿ES UN HONOR?', 'es un honor')).toBe(true)
  })

  // A phrase of nothing but short words has no carrying words to compare. Falling back to all
  // of them answers the question; falling back to none would call every window clear.
  test('falls back to every word when none is long enough to carry meaning', () => {
    expect(containsPhrase('no no no otra vez', 'no no no')).toBe(true)
    expect(containsPhrase('algo completamente distinto', 'no no no')).toBe(false)
  })

  test('an empty phrase matches nothing rather than everything', () => {
    expect(containsPhrase('cualquier cosa', '   ')).toBe(false)
  })
})

describe('firstClear', () => {
  const probe = (atMs: number, contains: boolean) => ({ atMs, text: '', contains })

  test('reports the first window the phrase left, not the last it was in', () => {
    expect(firstClear([probe(59_000, true), probe(60_000, true), probe(61_000, false)])?.atMs).toBe(
      61_000,
    )
  })

  // Null means the span searched was too short, which is a reason to widen it rather than
  // evidence there is nothing to cut.
  test('answers null while the phrase is still recurring', () => {
    expect(firstClear([probe(59_000, true), probe(60_000, true)])).toBeNull()
  })
})

describe('normalise', () => {
  test('keeps letters outside ASCII, which is most of the words this reads', () => {
    expect(normalise('¡Reflexión, sí!')).toBe('reflexión sí')
  })
})

// A retake and the telling that survives it overlap, so the point where the wording stops
// recurring sits past the start of the line worth keeping. Cutting to the far edge beheaded
// the line on the case measured: "Conocemos, ya llegamos a mil miembros" instead of "Y a la
// que conocemos, ya llegamos a mil miembros", audibly wrong and readable as fine.
describe('the two boundaries', () => {
  const probe = (atMs: number, contains: boolean, text = '') => ({ atMs, text, contains })

  test('the last window carrying the phrase is nearer the cut than the first clear one', () => {
    const probes = [
      probe(61_000, true, 'Y al que conocemos, ya llegamos a mil miembros'),
      probe(61_500, true, 'Y a la que conocemos, ya llegamos a mil miembros'),
      probe(62_000, false, 'Hacemos, ya llegamos a mil miembros'),
    ]
    const clear = firstClear(probes)
    const lastWith = [...probes].reverse().find((entry) => entry.contains)
    expect(clear?.atMs).toBe(62_000)
    expect(lastWith?.atMs).toBe(61_500)
    // The correct cut on that recording ended at 61192ms: 308ms from the last window carrying
    // the phrase, 808ms from the first clear one.
    expect(Math.abs(61_192 - (lastWith?.atMs ?? 0))).toBeLessThan(
      Math.abs(61_192 - (clear?.atMs ?? 0)),
    )
  })
})
