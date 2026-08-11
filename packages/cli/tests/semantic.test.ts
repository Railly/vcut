import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSrt } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import {
  buildLines,
  foldDiacritics,
  gapsBetween,
  joinWords,
  mergeProposals,
  quietSegments,
  REVIEW_INSTRUCTIONS,
  renderedGaps,
  repeatedPhrases,
  semanticCommand,
  semanticReviewNext,
  silentSegments,
  survivingLines,
  survivingRepeats,
  unaddressedRepeats,
  unreviewedStretches,
  validateProposals,
  withNearestRefs,
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

// The same lookup open.ts attaches to suspects (nearestRef), reused here so an export line's
// finding carries the same block ref a session's cut --refs already resolves against, instead
// of a second "closest ref" definition that could drift from the first.
describe('withNearestRefs', () => {
  const blocks = [
    { ref: 'b1', startMs: 0, endMs: 2000 },
    { ref: 'b2', startMs: 2500, endMs: 6000 },
  ]

  test('attaches the ref whose span contains the line start', () => {
    const lines = [{ index: 1, startMs: 1000, endMs: 1800, text: 'hola' }]
    expect(withNearestRefs(lines, blocks)).toEqual([{ ...lines[0], nearestRef: 'b1' }])
  })

  test('attaches the closest ref when the line starts inside a silence gap', () => {
    const lines = [{ index: 1, startMs: 2200, endMs: 2400, text: 'entre medio' }]
    expect(withNearestRefs(lines, blocks)[0].nearestRef).toBe('b1')
  })

  test('anchors on startMs, not endMs', () => {
    // Starts inside b1 and runs into b2's territory; the ref follows where the line begins.
    const lines = [{ index: 1, startMs: 1900, endMs: 2600, text: 'cruza el silencio' }]
    expect(withNearestRefs(lines, blocks)[0].nearestRef).toBe('b1')
  })

  test('null when there are no blocks to compare against', () => {
    const lines = [{ index: 1, startMs: 500, endMs: 900, text: 'sola' }]
    expect(withNearestRefs(lines, [])[0].nearestRef).toBeNull()
  })

  test('preserves every original line field', () => {
    const lines = [{ index: 3, startMs: 3000, endMs: 3500, text: 'contenido' }]
    const [withRef] = withNearestRefs(lines, blocks)
    expect(withRef).toMatchObject(lines[0])
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

describe('unreviewedStretches', () => {
  const lines = [
    { index: 1, startMs: 0, endMs: 1_000, text: 'primera' },
    { index: 2, startMs: 4_000, endMs: 5_000, text: 'del medio' },
    { index: 3, startMs: 9_000, endMs: 10_000, text: 'ultima' },
  ]
  const cuts = [
    { startMs: 1_000, endMs: 2_000 },
    { startMs: 7_000, endMs: 8_000 },
  ]

  test('names the stretch nobody proposed anything in', () => {
    const found = unreviewedStretches(lines, cuts, 2_000)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ startMs: 2_000, endMs: 7_000, text: 'del medio' })
  })

  test('assigns a line by its middle, not by overlap', () => {
    // Overlaps the stretch but is centred inside the second cut, so it belongs to that cut's
    // edge, which a proposal already looked at.
    const straddling = [{ index: 1, startMs: 6_000, endMs: 9_000, text: 'a caballo' }]
    expect(unreviewedStretches(straddling, cuts, 2_000)).toHaveLength(0)
  })

  test('ignores a stretch too short to hide anything', () => {
    expect(unreviewedStretches(lines, cuts, 10_000)).toHaveLength(0)
  })

  test('reports nothing when there are no cuts to sit between', () => {
    expect(unreviewedStretches(lines, [], 2_000)).toEqual([])
  })

  test('skips a stretch with no line in it', () => {
    const sparse = [{ index: 1, startMs: 0, endMs: 500, text: 'solo al principio' }]
    expect(unreviewedStretches(sparse, cuts, 2_000)).toHaveLength(0)
  })
})

describe('gapsBetween', () => {
  test('returns what the segments do not cover', () => {
    const gaps = gapsBetween([
      { startMs: 0, endMs: 1_000 },
      { startMs: 3_000, endMs: 4_000 },
    ])
    expect(gaps).toEqual([{ startMs: 1_000, endMs: 3_000 }])
  })

  test('returns nothing for a contiguous run', () => {
    expect(
      gapsBetween([
        { startMs: 0, endMs: 1_000 },
        { startMs: 1_000, endMs: 2_000 },
      ]),
    ).toEqual([])
  })

  test('sorts before pairing, so segment order does not matter', () => {
    const gaps = gapsBetween([
      { startMs: 3_000, endMs: 4_000 },
      { startMs: 0, endMs: 1_000 },
    ])
    expect(gaps).toEqual([{ startMs: 1_000, endMs: 3_000 }])
  })
})

// Five runs of one recording shipped a repetition, and not one of them missed seeing it: the
// reading that kept it was always "this one is deliberate". Naming the phrase is what turns
// that into a claim about something specific rather than an impression of the whole.
describe('repeatedPhrases', () => {
  const line = (index: number, text: string) => ({
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text,
  })

  test('names wording that occurs in more than one line', () => {
    const found = repeatedPhrases([
      line(0, 'hubiera tenido una forma muy distinta a la que conocemos hoy en dia'),
      line(1, 'Y a la que conocemos, ya llegamos a mil miembros'),
    ])
    // Reported as word runs rather than as the longest repeat, so the phrase a reader has to
    // account for arrives as its overlapping parts: enough to name what recurs and where.
    expect(found.map((entry) => entry.phrase)).toContain('la que conocemos')
    const entry = found.find((item) => item.phrase === 'la que conocemos')
    expect(entry?.count).toBe(2)
    expect(entry?.lineIndexes).toEqual([0, 1])
  })

  test('catches the retake a run kept as a rhetorical beat', () => {
    const found = repeatedPhrases([
      line(0, 'Es un honor? No, no, no, otra vez.'),
      line(1, 'Es un honor.'),
      line(2, 'No, eso es muy fake.'),
      line(3, 'Es un honor la verdad.'),
    ])
    const entry = found.find((item) => item.phrase === 'es un honor')
    expect(entry?.count).toBe(3)
  })

  test('says nothing about a passage that repeats no wording', () => {
    expect(
      repeatedPhrases([
        line(0, 'Hola a todos, hoy quiero contarles una reflexion.'),
        line(1, 'Venimos construyendo bien duro y son los frutos.'),
      ]),
    ).toEqual([])
  })

  // Punctuation and case are the speaker's delivery, not their words: a run that reports
  // "es un honor" and "Es un honor?" as different phrases finds nothing worth reporting.
  test('reads through case and punctuation', () => {
    const found = repeatedPhrases([line(0, 'Es un honor?'), line(1, 'es, un honor')])
    expect(found.map((entry) => entry.phrase)).toContain('es un honor')
  })

  // A stutter the transcript kept is one line saying a thing once, badly. Counting it as a
  // repetition would put an entry in front of a reader for every hesitation in the file.
  test('does not report a line as repeating itself', () => {
    expect(repeatedPhrases([line(0, 'y a la que y a la que conocemos')])).toEqual([])
  })
})

// A field nothing points at is a field a reader skips. The list of repeated phrases only
// binds because the instructions say to answer every entry before reporting nothing, so the
// wording that makes it a requirement is part of the contract rather than a nicety.
describe('review instructions', () => {
  test('require every repeated phrase to be answered', () => {
    const text = REVIEW_INSTRUCTIONS.join('\n')
    expect(text).toContain('repeated lists wording that occurs more than once')
    expect(text).toContain('Answer every entry in repeated before reporting nothing')
    expect(text).toContain('vcut semantic check --proposals')
  })

  test('name self-direction as a cut rather than a matter of taste', () => {
    const text = REVIEW_INSTRUCTIONS.join('\n')
    expect(text).toContain('otra vez')
    expect(text).toContain('A speaker judging their own take is a cut')
    expect(text).toContain('a callback, and cutting it flattens the writing')
  })
})

// Listing repeated wording was not enough on its own: a run read its own list, decided one
// entry was a deliberate turn, wrote no proposal, and shipped the repetition. A field can be
// skipped in silence, so the answer has to be something a command can check.
describe('unaddressedRepeats', () => {
  const repeat = (phrase: string) => ({ phrase, count: 2, lineIndexes: [5, 6] })

  test('reports a repeated phrase no proposal mentions', () => {
    const found = unaddressedRepeats(
      [repeat('la que conocemos')],
      [{ reason: 'pre-roll countdown before the take' }],
    )
    expect(found).toHaveLength(1)
    expect(found[0].phrase).toBe('la que conocemos')
  })

  // Naming, not agreeing. Keeping a repeat is often right; leaving no trace of the decision
  // is what turns a judgement call into something nobody downstream can review.
  test('accepts a phrase a proposal names, whatever it decided about it', () => {
    expect(
      unaddressedRepeats(
        [repeat('la que conocemos')],
        [{ reason: 'keeping the second telling of "la que conocemos", cutting the first' }],
      ),
    ).toEqual([])
  })

  test('reads through the case a reason is written in', () => {
    expect(
      unaddressedRepeats([repeat('es un honor')], [{ reason: 'The "Es Un Honor" retake' }]),
    ).toEqual([])
  })

  test('says nothing when review found no repeats', () => {
    expect(unaddressedRepeats([], [{ reason: 'anything' }])).toEqual([])
  })

  // An empty round is the normal way to end a loop, and it is exactly the round where an
  // unanswered repeat matters most: there is nothing after it to catch one.
  test('reports every repeat when a round proposes nothing', () => {
    expect(
      unaddressedRepeats([repeat('es un honor'), repeat('la que conocemos')], []),
    ).toHaveLength(2)
  })

  test('ignores a proposal whose reason is not a string', () => {
    expect(unaddressedRepeats([repeat('es un honor')], [{ reason: 42 }])).toHaveLength(1)
  })

  // The mismatch measured on the corpus that motivated this: the repeated phrase comes off
  // the transcript with its accents, and a reason typed by hand routinely drops them. Before
  // NFD folding this failed unaddressedRepeats' includes() and cost a full build cycle.
  test('closes on a reason missing the diacritics the phrase carries', () => {
    expect(
      unaddressedRepeats(
        [repeat('así que nada')],
        [{ reason: 'cutting the retake, asi que nada stays only in the second telling' }],
      ),
    ).toEqual([])
  })

  test('an unrelated reason still fails to close a phrase missing its diacritics', () => {
    expect(
      unaddressedRepeats(
        [repeat('así que nada')],
        [{ reason: 'pre-roll countdown before the take' }],
      ),
    ).toHaveLength(1)
  })
})

describe('foldDiacritics', () => {
  test('strips combining marks after NFD decomposition', () => {
    expect(foldDiacritics('así que nada')).toBe('asi que nada')
    expect(foldDiacritics('¿Es un honor? Sí, señor')).toBe('¿Es un honor? Si, senor')
  })

  test('leaves text with no diacritics unchanged', () => {
    expect(foldDiacritics('nothing to fold here')).toBe('nothing to fold here')
  })
})

// Naming a phrase in a reason is not removing it. A run quoted the repeated line in an honest
// reason, cut a boundary 1772ms short of where the repetition ended, and passed the naming
// check while the render still said it twice.
describe('survivingRepeats', () => {
  const line = (index: number, text: string) => ({
    index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text,
  })
  const repeat = (phrase: string, count = 2) => ({ phrase, count, lineIndexes: [1, 2] })

  test('reports a phrase the render still says as often as review found it', () => {
    const found = survivingRepeats(
      [repeat('la que conocemos')],
      [
        line(1, 'una forma muy distinta a la que conocemos hoy en día'),
        line(2, 'Y a la que conocemos, ya llegamos'),
      ],
    )
    expect(found.map((entry) => entry.phrase)).toEqual(['la que conocemos'])
  })

  test('clears a phrase the cut actually removed', () => {
    expect(
      survivingRepeats(
        [repeat('la que conocemos')],
        [
          line(1, 'una forma muy distinta a la que conocemos hoy en día'),
          line(2, 'Ya llegamos a mil miembros'),
        ],
      ),
    ).toEqual([])
  })

  test('reads through the punctuation and case the render was transcribed with', () => {
    expect(
      survivingRepeats(
        [repeat('es un honor')],
        [line(1, '¿Es un honor?'), line(2, 'Es un honor.')],
      ),
    ).toHaveLength(1)
  })

  test('says nothing when review found no repeats', () => {
    expect(survivingRepeats([], [line(1, 'anything at all')])).toEqual([])
  })

  // Unlike unaddressedRepeats, both sides here come from the same transcript pass:
  // repeatedPhrases() derives entry.phrase from the render lines, and survivingRepeats is
  // handed the same lines back. There is no independently-typed reason in the middle to
  // drop an accent, so a phrase carrying diacritics already matches without folding.
  // Verified rather than assumed: this fails if that symmetry ever breaks.
  test('already matches a phrase carrying diacritics, with no folding needed', () => {
    const found = survivingRepeats(
      [repeat('así que nada')],
      [
        line(1, 'entonces decidimos cambiar el enfoque, así que nada, seguimos'),
        line(2, 'Y así que nada, terminamos publicando la version anterior'),
      ],
    )
    expect(found.map((entry) => entry.phrase)).toEqual(['así que nada'])
  })
})

// survivingRepeats reports, it does not gate. A callback repeats on purpose and reads exactly
// like a retake to anything counting words, so gating on presence left naming unable to close
// the loop and made cutting further the only move that changed the exit code.
describe('the check gate', () => {
  const repeat = (phrase: string) => ({ phrase, count: 2, lineIndexes: [5, 6] })
  const lines = [
    { index: 5, startMs: 0, endMs: 900, text: 'una forma distinta a la que conocemos hoy en día' },
    { index: 6, startMs: 1000, endMs: 1900, text: 'Y a la que conocemos, ya llegamos a mil' },
  ]

  test('a named repeat that survives is reported, not withheld', () => {
    const named = [{ reason: 'kept: "la que conocemos" closes one clause and opens the next' }]
    expect(unaddressedRepeats([repeat('la que conocemos')], named)).toEqual([])
    expect(survivingRepeats([repeat('la que conocemos')], lines)).toHaveLength(1)
  })

  test('a repeat nobody named is still unanswered', () => {
    expect(
      unaddressedRepeats([repeat('la que conocemos')], [{ reason: 'the pre-roll' }]),
    ).toHaveLength(1)
  })
})

// 'valid' with a populated survivingRepeats reads the same as a clean run, and a round told
// that only a cut clears that list can reasonably conclude work remains and cut a callback the
// author wanted. The status names the difference so the reader does not have to infer it.
describe('review instructions on kept repeats', () => {
  test('say a reason must ride on a real proposal', () => {
    const text = REVIEW_INSTRUCTIONS.join('\n')
    expect(text).toContain('there is no reason-only entry')
    expect(text).toContain('valid-with-kept-repeats')
  })
})

describe('semanticReviewNext', () => {
  test('names a non-empty question and a non-empty verb for each entry', () => {
    const hints = semanticReviewNext('/tmp/detect.json', '/tmp/master.mp4')
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.question.length).toBeGreaterThan(0)
      expect(hint.verb.length).toBeGreaterThan(0)
    }
  })

  test('points at semantic check and nonspeech --verify', () => {
    const hints = semanticReviewNext('/tmp/detect.json', '/tmp/master.mp4')
    expect(hints.some((hint) => hint.verb.includes('vcut semantic check'))).toBe(true)
    expect(hints.some((hint) => hint.verb.includes('vcut nonspeech'))).toBe(true)
    expect(hints.some((hint) => hint.verb.includes('--verify'))).toBe(true)
  })

  test('falls back to a placeholder render path without --master', () => {
    const hints = semanticReviewNext('/tmp/detect.json', undefined)
    const nonspeechHint = hints.find((hint) => hint.verb.includes('vcut nonspeech'))
    expect(nonspeechHint?.verb.length).toBeGreaterThan(0)
  })
})

const proposal = (
  startMs: number,
  endMs: number,
  kind: 'false-start' | 'repetition' | 'tangent' | 'filler' | 'non-speech' = 'filler',
  reason = 'test',
) => ({ startMs, endMs, kind, reason })

describe('mergeProposals', () => {
  test('concatenates and sorts proposals from every file by startMs', () => {
    const a = [proposal(3000, 3500), proposal(1000, 1200)]
    const b = [proposal(2000, 2200)]
    const { merged, duplicates } = mergeProposals([a, b])
    expect(merged.map((p) => p.startMs)).toEqual([1000, 2000, 3000])
    expect(duplicates).toBe(0)
  })

  test('drops a span identical on all four fields between two files', () => {
    const shared = proposal(1000, 1500, 'filler', 'same reason')
    const a = [shared]
    const b = [shared, proposal(2000, 2500)]
    const { merged, duplicates } = mergeProposals([a, b])
    expect(merged).toHaveLength(2)
    expect(duplicates).toBe(1)
  })

  test('keeps two proposals covering the same span with different reasons or kinds', () => {
    const a = [proposal(1000, 1500, 'filler', 'reason A')]
    const b = [proposal(1000, 1500, 'repetition', 'reason B')]
    const { merged, duplicates } = mergeProposals([a, b])
    expect(merged).toHaveLength(2)
    expect(duplicates).toBe(0)
  })

  test('merges more than two files', () => {
    const { merged } = mergeProposals([
      [proposal(3000, 3200)],
      [proposal(1000, 1200)],
      [proposal(2000, 2200)],
    ])
    expect(merged.map((p) => p.startMs)).toEqual([1000, 2000, 3000])
  })

  test('an empty set of files merges to an empty array', () => {
    expect(mergeProposals([])).toEqual({ merged: [], duplicates: 0 })
  })

  test('a duplicate spanning three files is only counted for the repeats, not the first', () => {
    const shared = proposal(500, 900)
    const { merged, duplicates } = mergeProposals([[shared], [shared], [shared]])
    expect(merged).toHaveLength(1)
    expect(duplicates).toBe(2)
  })
})

describe('semanticCommand merge', () => {
  let workDir: string

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'vcut-semantic-merge-'))
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const capture = async (
    argv: string[],
  ): Promise<{ output: unknown; exitCode: number | undefined }> => {
    const originalLog = console.log
    const originalExitCode = process.exitCode
    process.exitCode = undefined
    let printed = ''
    console.log = (text: string) => {
      printed = text
    }
    try {
      await semanticCommand(argv)
    } finally {
      console.log = originalLog
    }
    const exitCode = process.exitCode
    process.exitCode = originalExitCode
    return { output: JSON.parse(printed), exitCode }
  }

  test('merges two round files given positionally and prints the merged result', async () => {
    const roundOne = join(workDir, 'round1.json')
    const roundTwo = join(workDir, 'round2.json')
    writeFileSync(roundOne, JSON.stringify([proposal(1000, 1500)]))
    writeFileSync(roundTwo, JSON.stringify([proposal(500, 800)]))

    const { output } = (await capture(['merge', roundOne, roundTwo])) as {
      output: {
        status: string
        proposals: Array<{ startMs: number }>
        inputCount: number
        duplicates: number
      }
    }
    expect(output.status).toBe('merged')
    expect(output.proposals.map((p) => p.startMs)).toEqual([500, 1000])
    expect(output.inputCount).toBe(2)
    expect(output.duplicates).toBe(0)
  })

  test('merges three or more files', async () => {
    const files = [join(workDir, 'r1.json'), join(workDir, 'r2.json'), join(workDir, 'r3.json')]
    writeFileSync(files[0], JSON.stringify([proposal(3000, 3200)]))
    writeFileSync(files[1], JSON.stringify([proposal(1000, 1200)]))
    writeFileSync(files[2], JSON.stringify([proposal(2000, 2200)]))

    const { output } = (await capture(['merge', ...files])) as {
      output: { proposals: Array<{ startMs: number }> }
    }
    expect(output.proposals.map((p) => p.startMs)).toEqual([1000, 2000, 3000])
  })

  test('--out writes the merged array to a file, same shape as an input file', async () => {
    const roundOne = join(workDir, 'out-a.json')
    const roundTwo = join(workDir, 'out-b.json')
    const outPath = join(workDir, 'merged.json')
    writeFileSync(roundOne, JSON.stringify([proposal(1000, 1500)]))
    writeFileSync(roundTwo, JSON.stringify([proposal(2000, 2500)]))

    const { output } = (await capture(['merge', roundOne, roundTwo, '--out', outPath])) as {
      output: { outPath: string }
    }
    expect(output.outPath).toBe(outPath)

    const written = JSON.parse(readFileSync(outPath, 'utf8'))
    expect(Array.isArray(written)).toBe(true)
    expect(written).toEqual([proposal(1000, 1500), proposal(2000, 2500)])
  })

  test('rejects with status "rejected" and exit code 1 when a file has malformed entries', async () => {
    const good = join(workDir, 'good.json')
    const bad = join(workDir, 'bad.json')
    writeFileSync(good, JSON.stringify([proposal(1000, 1500)]))
    writeFileSync(bad, JSON.stringify([{ startMs: 1000 }]))

    const { output, exitCode } = (await capture(['merge', good, bad])) as {
      output: { status: string; issues: Array<{ file: string }> }
      exitCode: number | undefined
    }
    expect(output.status).toBe('rejected')
    expect(output.issues.some((issue) => issue.file === bad)).toBe(true)
    expect(exitCode).toBe(1)
  })

  test('throws a usage error naming the missing file', async () => {
    const good = join(workDir, 'usage-good.json')
    writeFileSync(good, JSON.stringify([proposal(1000, 1500)]))
    await expect(semanticCommand(['merge', good, join(workDir, 'nope.json')])).rejects.toThrow(
      /proposals file missing/,
    )
  })

  test('throws a usage error when fewer than two files are given', async () => {
    const good = join(workDir, 'usage-one.json')
    writeFileSync(good, JSON.stringify([proposal(1000, 1500)]))
    await expect(semanticCommand(['merge', good])).rejects.toThrow(/at least two/)
  })

  test('a value-taking global flag and its value are not mistaken for input files', async () => {
    // Global flags (--json, --human, --fields, --jq, --help) are emitJson's business, read
    // straight off process.argv, not this command's own argv: merge has to skip both the
    // flag and its value the same way detect.ts's positional() does via BOOLEAN_FLAGS, or a
    // trailing `--fields duplicates` would be read as two more file paths.
    const a = join(workDir, 'global-flag-a.json')
    const b = join(workDir, 'global-flag-b.json')
    writeFileSync(a, JSON.stringify([proposal(1000, 1500)]))
    writeFileSync(b, JSON.stringify([proposal(2000, 2500)]))
    const { output } = (await capture(['merge', a, b, '--fields', 'duplicates'])) as {
      output: { status: string; files: string[] }
    }
    expect(output.status).toBe('merged')
    expect(output.files).toEqual([a, b])
  })

  test('an unrecognized boolean-shaped flag does not crash the parse, just is not treated as a file', async () => {
    const a = join(workDir, 'flag-a.json')
    const b = join(workDir, 'flag-b.json')
    writeFileSync(a, JSON.stringify([proposal(1000, 1500)]))
    writeFileSync(b, JSON.stringify([proposal(2000, 2500)]))
    const { output } = (await capture(['merge', a, b, '--human'])) as {
      output: { status: string; files: string[] }
    }
    expect(output.status).toBe('merged')
    expect(output.files).toEqual([a, b])
  })
})
