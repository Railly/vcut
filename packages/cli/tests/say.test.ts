import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

describe('sayCommand --words', () => {
  // --words without --transcribe would silently answer with the transcript's own cues, which
  // are exactly the numbers the flag exists to doubt. Answering a different question than the
  // one asked is the failure mode this whole primitive was built against.
  test('rejects --words without --transcribe', async () => {
    await expect(
      sayCommand(['media.mp4', '--transcript', 'x.srt', '--words', '--at', '5']),
    ).rejects.toThrow(/--transcribe/)
  })
})

// A transcript-only call is allowed to carry no media at all: there is nothing to measure a
// level on and nothing to transcribe, so the answer comes entirely from the SRT. Caught as a
// real regression while adding --words — hoisting the media resolve out of the transcribe
// branch made `say --transcript x.srt --at 10` throw on resolve(undefined) before it read a
// single cue, and nothing else in this suite passes a transcript without a media argument.
describe('sayCommand with a transcript and no media', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-say-no-media-'))
  const transcriptPath = join(dir, 'words.srt')

  beforeAll(() => {
    writeFileSync(
      transcriptPath,
      `1
00:00:10,000 --> 00:00:10,400
 uno

2
00:00:10,400 --> 00:00:10,900
 dos
`,
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('answers from the transcript rather than throwing on a media path it was never given', async () => {
    const printed: string[] = []
    const original = console.log
    console.log = (value: string) => {
      printed.push(value)
    }
    try {
      await sayCommand(['--transcript', transcriptPath, '--at', '10.2', '--json'])
    } finally {
      console.log = original
    }
    const answer = JSON.parse(printed.join('\n')) as {
      words: Array<{ text: string }>
      peakDb: number | null
    }
    expect(answer.words.map((word) => word.text)).toEqual(['uno', 'dos'])
    // No media means no level to measure, which is a null rather than a failure.
    expect(answer.peakDb).toBeNull()
  })
})

// The seam --words rides on: one transcription answers both the text and the cues, so a
// regression that transcribes twice (once for text, once for words) costs a caller double for
// one question. Structural for the same reason the sequencing test below is: observing it
// behaviourally needs a real transcriber to count calls against.
describe('--words and --transcribe share one transcription', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'say.ts'),
    'utf8',
  )

  test('reads text off the word-level call rather than making a second one', () => {
    expect(source).toContain('transcribeWindowWords')
    // The plain call is reached only when the word-level one did not already answer.
    expect(source).toMatch(/fresh !== null\s*\?\s*fresh\.text/)
  })

  test('marks fresh words as measured rather than read', () => {
    expect(source).toContain("wordsFrom: 'fresh-transcription'")
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
