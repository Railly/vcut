import { describe, expect, test } from 'bun:test'
import { parseSrt } from '../src/detect.ts'
import { buildLines, joinWords, validateProposals } from '../src/semantic.ts'

const srt = (entries: Array<[string, string, string]>): string =>
  entries
    .map(([start, end, text], index) => `${index + 1}\n${start} --> ${end}\n${text}`)
    .join('\n\n')

describe('joinWords', () => {
  test('rebuilds a word whisper split into BPE pieces', () => {
    const transcript = parseSrt(
      srt([
        ['00:00:00,000', '00:00:00,200', ' Cra'],
        ['00:00:00,200', '00:00:00,400', 'fter'],
        ['00:00:00,400', '00:00:00,900', ' Station'],
      ]),
    )
    expect(joinWords(transcript).map((word) => word.text)).toEqual(['Crafter', 'Station'])
  })

  test('keeps the timings of the whole word, not of its last piece', () => {
    const transcript = parseSrt(
      srt([
        ['00:00:01,000', '00:00:01,200', ' Cra'],
        ['00:00:01,200', '00:00:01,500', 'fter'],
      ]),
    )
    expect(joinWords(transcript)[0]).toMatchObject({ startMs: 1000, endMs: 1500 })
  })

  test('attaches punctuation to the word before it', () => {
    const transcript = parseSrt(
      srt([
        ['00:00:00,000', '00:00:00,300', ' todos'],
        ['00:00:00,300', '00:00:00,320', ','],
        ['00:00:00,320', '00:00:00,600', ' hoy'],
      ]),
    )
    expect(joinWords(transcript).map((word) => word.text)).toEqual(['todos,', 'hoy'])
  })

  test('does not glue two separate lowercase words', () => {
    const transcript = parseSrt(
      srt([
        ['00:00:00,000', '00:00:00,200', ' a'],
        ['00:00:00,200', '00:00:00,500', ' todos'],
      ]),
    )
    expect(joinWords(transcript).map((word) => word.text)).toEqual(['a', 'todos'])
  })
})

describe('buildLines', () => {
  const words = [
    { text: 'Hola', startMs: 0, endMs: 400 },
    { text: 'a', startMs: 400, endMs: 600 },
    { text: 'todos.', startMs: 600, endMs: 900 },
    { text: 'Bueno', startMs: 2000, endMs: 2400 },
    { text: 'esto', startMs: 2400, endMs: 2800 },
  ]

  test('ends a line on terminal punctuation', () => {
    const lines = buildLines(words, [], 700)
    expect(lines[0].text).toBe('Hola a todos.')
  })

  test('ends a line on a pause long enough to end a thought', () => {
    const lines = buildLines(
      [
        { text: 'primero', startMs: 0, endMs: 400 },
        { text: 'segundo', startMs: 2000, endMs: 2400 },
      ],
      [{ startMs: 400, endMs: 2000 }],
      700,
    )
    expect(lines).toHaveLength(2)
  })

  test('ignores a gap too short to end a thought, so clauses stay whole', () => {
    const lines = buildLines(
      [
        { text: 'no', startMs: 0, endMs: 400 },
        { text: 'se', startMs: 800, endMs: 1200 },
      ],
      [{ startMs: 400, endMs: 800 }],
      700,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe('no se')
  })

  test('numbers lines from one so a model can refer to them', () => {
    expect(buildLines(words, [], 700).map((line) => line.index)).toEqual([1, 2])
  })
})

describe('validateProposals', () => {
  const good = { startMs: 100, endMs: 900, kind: 'false-start', reason: 'restarts the sentence' }

  test('accepts a well formed proposal', () => {
    expect(validateProposals([good], 5_000)).toMatchObject({ proposals: [good], issues: [] })
  })

  test('refuses a span that runs past the source', () => {
    const { proposals, issues } = validateProposals([{ ...good, endMs: 9_000 }], 5_000)
    expect(proposals).toHaveLength(0)
    expect(issues[0].problem).toContain('past the 5000ms source')
  })

  test('refuses an inverted span', () => {
    expect(validateProposals([{ ...good, startMs: 900, endMs: 100 }], 5_000).issues).toHaveLength(1)
  })

  test('refuses an unknown kind', () => {
    expect(validateProposals([{ ...good, kind: 'vibes' }], 5_000).issues[0].problem).toContain(
      'kind must be one of',
    )
  })

  test('refuses a proposal with no reason, since a human reads it before approving', () => {
    expect(validateProposals([{ ...good, reason: '  ' }], 5_000).issues).toHaveLength(1)
  })

  test('reports the index of each bad entry instead of dropping it silently', () => {
    const { proposals, issues } = validateProposals([good, { ...good, kind: 'nope' }], 5_000)
    expect(proposals).toHaveLength(1)
    expect(issues[0].index).toBe(1)
  })

  test('refuses anything that is not an array', () => {
    expect(validateProposals({ startMs: 0 }, 5_000).issues[0].problem).toContain('JSON array')
  })

  test('an empty array is a valid answer', () => {
    expect(validateProposals([], 5_000)).toEqual({ proposals: [], issues: [] })
  })
})
