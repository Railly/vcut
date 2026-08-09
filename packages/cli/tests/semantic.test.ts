import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSrt } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import {
  buildLines,
  joinWords,
  quietSegments,
  renderedGaps,
  silentSegments,
  survivingLines,
  validateProposals,
} from '../src/semantic.ts'

// A real file, because renderedGaps runs ffmpeg: a fixture path would only test the error
// branch. Generated on the fly so the suite carries no binary.
const MASTER_FIXTURE = join(tmpdir(), 'vcut-test-master.wav')

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

describe('survivingLines', () => {
  const lines = [
    { index: 1, startMs: 0, endMs: 1_000, text: 'primera' },
    { index: 2, startMs: 1_000, endMs: 2_000, text: 'segunda' },
    { index: 3, startMs: 2_000, endMs: 3_000, text: 'tercera' },
  ]

  test('drops a line the cuts removed entirely', () => {
    const kept = survivingLines(lines, [
      { startMs: 0, endMs: 1_000 },
      { startMs: 2_000, endMs: 3_000 },
    ])
    expect(kept.map((line) => line.index)).toEqual([1, 3])
  })

  test('marks the line after a removed one as a join', () => {
    const kept = survivingLines(lines, [
      { startMs: 0, endMs: 1_000 },
      { startMs: 2_000, endMs: 3_000 },
    ])
    expect(kept.find((line) => line.index === 3)?.precededByCut).toBe(true)
  })

  test('does not call an untouched sequence a join', () => {
    const kept = survivingLines(lines, [{ startMs: 0, endMs: 3_000 }])
    expect(kept.every((line) => !line.precededByCut)).toBe(true)
  })

  test('flags a line the cuts entered', () => {
    const kept = survivingLines(lines, [{ startMs: 0, endMs: 1_500 }])
    expect(kept.find((line) => line.index === 2)?.truncated).toBe(true)
    expect(kept.find((line) => line.index === 1)?.truncated).toBe(false)
  })
})

describe('silentSegments', () => {
  const segment = (id: string, startMs: number, endMs: number) => ({ id, startMs, endMs })

  test('reports a segment that is mostly measured silence', () => {
    const found = silentSegments([segment('s1', 0, 1_000)], [{ startMs: 100, endMs: 900 }], 300)
    expect(found).toHaveLength(1)
    expect(found[0].detail).toContain('800ms of it measured silence')
  })

  test('leaves a segment carrying speech alone', () => {
    expect(
      silentSegments([segment('s1', 0, 1_000)], [{ startMs: 0, endMs: 200 }], 300),
    ).toHaveLength(0)
  })

  test('ignores a segment too short to be worth reporting', () => {
    expect(silentSegments([segment('s1', 0, 200)], [{ startMs: 0, endMs: 200 }], 300)).toHaveLength(
      0,
    )
  })
})

describe('quietSegments', () => {
  const level = (id: string, meanDb: number) => ({ id, startMs: 0, endMs: 1_000, meanDb })

  test('reports the segment far below the median of its own recording', () => {
    const found = quietSegments(
      [level('s1', -25), level('s2', -26), level('s3', -24), level('s4', -42)],
      12,
    )
    expect(found.map((entry) => entry.segmentId)).toEqual(['s4'])
  })

  test('reports nothing when every segment sits near the median', () => {
    expect(quietSegments([level('s1', -25), level('s2', -26), level('s3', -24)], 12)).toHaveLength(
      0,
    )
  })

  test('scales with the recording rather than a fixed threshold', () => {
    // A quiet recording overall: -40 is the norm here, so it is not an outlier.
    expect(quietSegments([level('s1', -40), level('s2', -41), level('s3', -39)], 12)).toHaveLength(
      0,
    )
  })

  test('stays silent when there is not enough to compare against', () => {
    expect(quietSegments([level('s1', -60), level('s2', -20)], 12)).toHaveLength(0)
  })

  test('ignores a segment whose level could not be measured', () => {
    const found = quietSegments(
      [level('s1', -25), level('s2', -26), level('s3', -24), level('s4', Number.NaN)],
      12,
    )
    expect(found).toHaveLength(0)
  })
})

// renderedGaps shells out to ffmpeg, and the fixture it measures has to be generated the
// same way. Where ffmpeg is absent the behaviour under test cannot exist, so these skip
// rather than fail: a red suite would report a broken CLI when the machine is just bare.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('renderedGaps', () => {
  // Built here rather than committed, so the suite carries no binary and the assertion is
  // about audio that provably contains one second of silence in the middle.
  beforeAll(async () => {
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono:d=1',
      '-filter_complex',
      '[0][1][0]concat=n=3:v=0:a=1',
      '-y',
      MASTER_FIXTURE,
    ])
  })

  afterAll(() => {
    rmSync(MASTER_FIXTURE, { force: true })
  })

  test('finds the silence sitting between two tones', async () => {
    const found = await renderedGaps(MASTER_FIXTURE, -30, 600)
    expect(found).toHaveLength(1)
    expect(found[0].startMs).toBeGreaterThanOrEqual(900)
    expect(found[0].endMs).toBeLessThanOrEqual(2_100)
  })

  test('labels its findings as master timings, not source timings', async () => {
    const found = await renderedGaps(MASTER_FIXTURE, -30, 600)
    expect(found[0].segmentId).toBe('rendered')
    expect(found[0].detail).toContain('of the master itself')
  })

  test('ignores a gap shorter than the minimum', async () => {
    expect(await renderedGaps(MASTER_FIXTURE, -30, 2_000)).toEqual([])
  })
})

describe('renderedGaps without a readable file', () => {
  test('returns nothing rather than failing', async () => {
    expect(await renderedGaps('/nonexistent/master.mp4', -30, 600)).toEqual([])
  })
})
