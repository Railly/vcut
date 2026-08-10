import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Word } from '../src/detect.ts'
import { parsePositions, sayCommand, wordsInWindow } from '../src/say.ts'

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

describe('parsePositions', () => {
  test('parses a comma-separated list of seconds', () => {
    expect(parsePositions('19.5,30.0,41.9')).toEqual([19.5, 30.0, 41.9])
  })

  test('trims whitespace around entries', () => {
    expect(parsePositions(' 1, 2 , 3')).toEqual([1, 2, 3])
  })

  // Nothing to ask about is a usage error, not a silent empty result: a caller who typed
  // --positions meant to ask about something.
  test('rejects an empty list', () => {
    expect(() => parsePositions('')).toThrow()
    expect(() => parsePositions(',,')).toThrow()
  })

  test('rejects a non-numeric entry', () => {
    expect(() => parsePositions('1,abc,3')).toThrow()
  })
})

describe('sayCommand --positions', () => {
  // --positions and --at answer overlapping questions with different shapes; combining them
  // would leave one silently ignored rather than telling the caller their invocation is wrong.
  test('rejects --positions combined with --at', async () => {
    await expect(
      sayCommand(['media.mp4', '--transcript', 'x.srt', '--positions', '1,2', '--at', '5']),
    ).rejects.toThrow()
  })

  test('rejects --positions combined with --through', async () => {
    await expect(
      sayCommand(['media.mp4', '--transcript', 'x.srt', '--positions', '1,2', '--through', '5']),
    ).rejects.toThrow()
  })
})

// Structural rather than behavioural: proving --transcribe never races two trx calls needs a
// real transcriber to observe timing against, which this suite does not have. nonspeech.ts's
// verifySpansSequentially set this precedent for the identical reason (each call loads a
// Whisper model into memory). This pins the shape of the fix rather than its runtime effect:
// a for-await loop over positions, awaited one at a time, not a Promise.all/map.
describe('sayCommand --positions is sequential, not concurrent', () => {
  test('answers each position in a for-of loop with an awaited call inside, not Promise.all', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'say.ts'),
      'utf8',
    )
    const loopMatch = source.match(/for \(const at of positions\) \{[\s\S]*?\n {4}\}/)
    expect(loopMatch).not.toBeNull()
    const loopBody = loopMatch?.[0] ?? ''
    expect(loopBody).toContain('await answerPosition')
    expect(source).not.toContain('positions.map(async')
    expect(source).not.toContain('Promise.all(positions')
  })
})
