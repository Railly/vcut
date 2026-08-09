import { describe, expect, test } from 'bun:test'
import type { Word } from '../src/detect.ts'
import { wordsInWindow } from '../src/say.ts'

const word = (text: string, startMs: number, endMs: number): Word => ({
  text,
  startsWord: true,
  startMs,
  endMs,
})

const sentence: Word[] = [
  word('uno', 1000, 1400),
  word('dos', 1400, 1900),
  word('tres', 1900, 2600),
  word('cuatro', 3000, 3600),
]

describe('wordsInWindow', () => {
  test('returns the words inside the window, in order', () => {
    expect(wordsInWindow(sentence, 1300, 2000).map((entry) => entry.text)).toEqual([
      'uno',
      'dos',
      'tres',
    ])
  })

  // A word straddling the edge is the one a boundary question is about, so touching the
  // window is enough. Requiring containment would hide exactly the word being asked about.
  test('includes a word that only overlaps the edge', () => {
    expect(wordsInWindow(sentence, 2500, 2700).map((entry) => entry.text)).toEqual(['tres'])
  })

  test('a window in a gap between words returns nothing', () => {
    expect(wordsInWindow(sentence, 2700, 2900)).toEqual([])
  })

  test('a window before any speech returns nothing', () => {
    expect(wordsInWindow(sentence, 0, 900)).toEqual([])
  })

  test('a window covering everything returns every word', () => {
    expect(wordsInWindow(sentence, 0, 10000)).toHaveLength(4)
  })

  // Touching at a single point is not overlap: a word ending exactly where the window
  // begins contributed nothing to it.
  test('a word ending exactly at the window start is not included', () => {
    expect(wordsInWindow(sentence, 1400, 1500).map((entry) => entry.text)).toEqual(['dos'])
  })
})
