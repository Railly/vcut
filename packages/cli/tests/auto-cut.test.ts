import { describe, expect, test } from 'bun:test'

import {
  continuesTheSame,
  fragmentCuts,
  locatePhrase,
  medianWindowDb,
  mergeAutoCuts,
  nonspeechCuts,
  planAutoCuts,
  repetitionCuts,
  seamBetween,
  silenceCuts,
  snapToWords,
} from '../src/auto-cut.ts'
import type { SilenceCandidate, Word } from '../src/detect.ts'

const word = (text: string, startMs: number, endMs: number): Word => ({ text, startMs, endMs })

const silence = (startMs: number, endMs: number): SilenceCandidate => ({
  startMs,
  endMs,
  durationMs: endMs - startMs,
})

const noSilence = {
  spans: [] as SilenceCandidate[],
  floorDb: null,
  floorThresholdDb: null,
  medianDb: null,
  medianThresholdDb: null,
  thresholdDb: null,
}

describe('medianWindowDb', () => {
  // The anchor the silence threshold is measured down from. The median window is speech, which is
  // what makes it the right reference on a render whose quietest window is an assembly artefact.
  test('returns the median bucket level, not the quietest', () => {
    const output = [
      'pts_time:0.0',
      'lavfi.astats.Overall.RMS_level=-20',
      'pts_time:2.0',
      'lavfi.astats.Overall.RMS_level=-80',
      'pts_time:4.0',
      'lavfi.astats.Overall.RMS_level=-10',
    ].join('\n')
    const median = medianWindowDb(output, 2)
    expect(median).not.toBeNull()
    expect(median as number).toBeCloseTo(-20, 5)
  })

  test('reads true digital silence rather than dropping the frame', () => {
    const output = ['pts_time:0.0', 'lavfi.astats.Overall.RMS_level=-inf'].join('\n')
    expect(medianWindowDb(output, 2)).toBe(-90)
  })

  test('no usable frames is null, not a fabricated level', () => {
    expect(medianWindowDb('', 2)).toBeNull()
  })
})

describe('silenceCuts', () => {
  // Energy is the authority: no word-level veto applies, because the transcript is the instrument
  // that disagrees with the audio about where speech is (measured: cue overlap vetoed 18 of 19
  // real silences on the render that opened #63).
  test('cuts a measured pause even where a cue claims a word starts inside it', () => {
    const cuts = silenceCuts([silence(1000, 3000)], -40)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.instrument).toBe('silence')
    expect(cuts[0]?.startMs).toBe(1000)
  })

  test('records the measurement that fired, so the cut is traceable', () => {
    const cuts = silenceCuts([silence(1000, 3000)], -40.83)
    expect(cuts[0]?.measurement).toContain('-40.83dB')
    expect(cuts[0]?.measurement).toContain('2.00s')
    expect(cuts[0]?.reason).toBe(`silence: ${cuts[0]?.measurement}`)
  })

  test('a pause under the reporting floor is not a cut', () => {
    expect(silenceCuts([silence(1000, 1500)], -40)).toHaveLength(0)
  })
})

describe('nonspeechCuts', () => {
  // A classifier span is cut only where a second instrument agrees: the classifier's own label is
  // never asked for, so --verify's per-span whisper load is never paid.
  test('cuts a classifier span corroborated by measured silence', () => {
    const cuts = nonspeechCuts([{ startMs: 1000, endMs: 3000 }], [silence(1100, 2900)], -40)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.instrument).toBe('nonspeech')
    expect(cuts[0]?.measurement).toContain('below -40.00dB')
  })

  // The classifier draws generously and only the overlap is proven empty. Cutting its own bounds
  // removed audio measuring -32.6dB mean on the render that opened #63, which is speech.
  test('removes only the intersection, never the classifier bounds it could not prove', () => {
    const cuts = nonspeechCuts([{ startMs: 1000, endMs: 3000 }], [silence(1500, 2600)], -40)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.startMs).toBe(1500)
    expect(cuts[0]?.endMs).toBe(2600)
  })

  test('declines when the proven overlap is under the pause floor', () => {
    expect(nonspeechCuts([{ startMs: 1000, endMs: 3000 }], [silence(2900, 3200)], -40)).toEqual([])
  })

  test('declines a classifier span with no silence under it', () => {
    expect(nonspeechCuts([{ startMs: 1000, endMs: 3000 }], [silence(8000, 9000)], -40)).toEqual([])
  })

  test('declines a span under the pause floor even when corroborated', () => {
    expect(nonspeechCuts([{ startMs: 1000, endMs: 1400 }], [silence(1000, 1400)], -40)).toEqual([])
  })
})

describe('locatePhrase', () => {
  const words = [
    word('si', 0, 100),
    word('reciben', 100, 300),
    word('un', 300, 400),
    word('poema', 400, 700),
    word('si', 800, 900),
    word('reciben', 900, 1100),
    word('un', 1100, 1200),
    word('poema', 1200, 1500),
  ]

  test('finds both occurrences against measured timings', () => {
    const found = locatePhrase('si reciben un poema', words, 0, 2000)
    expect(found).toHaveLength(2)
    expect(found[0]?.startMs).toBe(0)
    expect(found[1]?.startMs).toBe(800)
  })

  test('matches through case and diacritics, which are delivery not words', () => {
    const accented = [word('está', 0, 100), word('ESTÁ', 200, 300)]
    expect(locatePhrase('esta', accented, 0, 1000)).toHaveLength(2)
  })
})

describe('continuesTheSame', () => {
  // The discriminator that separates a retake from legitimate reuse. #63 forbids firing on a
  // button clicked twice in a tutorial, and the content-word floor alone does not catch it.
  // Measured on real material: retakes carry 0-1 words between the readings, reuse carries 8-14.
  const spoken = (text: string): Word[] =>
    text.split(' ').map((token, index) => word(token, index * 100, index * 100 + 90))

  test('a retake with nothing between the readings is one attempt said twice', () => {
    // "es esta, es esta validacion" — the shape with no fumble at all.
    const words = spoken('normal es esta es esta validacion')
    expect(
      continuesTheSame(words, { startMs: 100, endMs: 290 }, { startMs: 300, endMs: 490 }),
    ).toBe(true)
  })

  // Deliberately refused, and the reason is the whole safety argument: one word between the
  // readings is reuse ("le damos clic a Create") as often as it is a retake fumble
  // ("probablemente"), and nothing here can tell them apart. The ambiguous case goes to the model.
  test('a single word between the readings is left to the model, not cut', () => {
    const words = spoken('si reciben un poema probablemente si reciben un poema por')
    expect(continuesTheSame(words, { startMs: 0, endMs: 390 }, { startMs: 500, endMs: 890 })).toBe(
      false,
    )
  })

  test('reuse carrying a whole sentence between the readings is refused', () => {
    // "le damos clic aqui a open chatgpt ... le damos clic a plus": two different buttons in a
    // tutorial, the exact class #63 names.
    const words = spoken('le damos clic aqui a open chatgpt eso nos lleva le damos clic a plus')
    expect(
      continuesTheSame(words, { startMs: 0, endMs: 290 }, { startMs: 1000, endMs: 1290 }),
    ).toBe(false)
  })
})

// #73: the repetition cut used to run to the SECOND occurrence's start, which removes every word
// spoken between the two readings. Those words are not only the trailing-off: when the speaker got
// further into the first attempt than the repeated phrase itself, they are the continuation the
// surviving sentence was going to complete. Measured over one master, 5 of 5 repetition cuts ate
// real words, one removing "cual es la diferencia" outright.
//
// These test seamBetween directly because MAX_FUMBLE_WORDS is 0, so repetitionCuts declines every
// finding with anything between the readings. That is precisely why #73 is latent rather than
// shipping, and why the geometry has to be right BEFORE #71 and #72 raise the sensitivity.
describe('seamBetween', () => {
  test('ends at the micro-pause, so the words after the abandoned attempt survive (#73)', () => {
    // The defect verbatim from the issue: a cut that removed "cual es la diferencia". The speaker
    // abandons after "y bueno", pauses, then says the words that belong to the surviving sentence,
    // then retakes. Ending at the retake's own start (the old geometry) deletes all four.
    const words = [
      word('y', 0, 100),
      word('bueno', 100, 300),
      word('cual', 900, 1100),
      word('es', 1110, 1200),
      word('la', 1210, 1290),
      word('diferencia', 1300, 1600),
      word('y', 1620, 1720),
      word('bueno', 1720, 1900),
    ]
    const seam = seamBetween(words, { startMs: 0, endMs: 300 }, { startMs: 1620, endMs: 1900 })
    // The widest boundary is 300 -> 900, so the cut ends at 900 rather than at the retake's 1620.
    expect(seam).toBe(900)
    // Which is the whole point: the four words the old span ate are on the keeping side now.
    expect(words.filter((entry) => entry.startMs >= seam).map((entry) => entry.text)).toEqual([
      'cual',
      'es',
      'la',
      'diferencia',
      'y',
      'bueno',
    ])
  })

  test('ends before the intervening words when the pause precedes them', () => {
    // The speaker stops dead after the abandoned attempt, then says the retake's own run-up.
    // The widest boundary is 300 -> 1200, so only the abandoned attempt goes.
    const words = [
      word('y', 0, 100),
      word('bueno', 100, 300),
      word('cual', 1200, 1400),
      word('es', 1410, 1500),
      word('y', 1520, 1620),
      word('bueno', 1620, 1800),
    ]
    const seam = seamBetween(words, { startMs: 0, endMs: 300 }, { startMs: 1520, endMs: 1800 })
    expect(seam).toBe(1200)
    // The words after the seam are kept, which is the whole point of #73.
    expect(words.filter((entry) => entry.startMs >= seam).map((entry) => entry.text)).toEqual([
      'cual',
      'es',
      'y',
      'bueno',
    ])
  })

  test('falls back to the retake start when the readings are adjacent', () => {
    // Nothing between them, so there is nothing to preserve and the old span was already right.
    const words = [word('si', 0, 100), word('si', 800, 900)]
    expect(seamBetween(words, { startMs: 0, endMs: 100 }, { startMs: 800, endMs: 900 })).toBe(800)
  })

  test('never returns a seam past the retake', () => {
    const words = [word('a', 0, 100), word('b', 200, 300), word('a', 400, 500)]
    const seam = seamBetween(words, { startMs: 0, endMs: 100 }, { startMs: 400, endMs: 500 })
    expect(seam).toBeLessThanOrEqual(400)
  })
})

describe('repetitionCuts', () => {
  const retake = [
    word('si', 0, 100),
    word('reciben', 100, 300),
    word('un', 300, 400),
    word('poema', 400, 700),
    word('si', 800, 900),
    word('reciben', 900, 1100),
    word('un', 1100, 1200),
    word('poema', 1200, 1500),
    word('por', 1500, 1700),
    word('whatsapp', 1700, 1900),
  ]

  // The direction that matters most: getting it backwards keeps the abandoned attempt and deletes
  // the completed one.
  test('removes the EARLIER occurrence and keeps the later one', () => {
    const cuts = repetitionCuts(
      [
        {
          phrase: 'si reciben un poema',
          count: 2,
          windowStartMs: 0,
          windowEndMs: 16000,
          words: retake,
        },
      ],
      'es',
    )
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.startMs).toBe(0)
    // Nothing is spoken between the two readings here, so the seam IS the second reading's start
    // and the span is unchanged by #73. The second reading survives whole either way.
    expect(cuts[0]?.endMs).toBe(800)
    expect(cuts[0]?.kind).toBe('repetition')
    expect(cuts[0]?.measurement).toContain('later kept')
  })

  test('declines a repeat below the content-word floor (#57)', () => {
    const words = [
      word('te', 0, 100),
      word('va', 100, 200),
      word('te', 300, 400),
      word('va', 400, 500),
    ]
    expect(
      repetitionCuts(
        [{ phrase: 'te va', count: 2, windowStartMs: 0, windowEndMs: 16000, words }],
        'es',
      ),
    ).toEqual([])
  })

  test('declines two readings too far apart to be one retake', () => {
    const spread = [
      word('reciben', 0, 200),
      word('poema', 200, 400),
      word('reciben', 60000, 60200),
      word('poema', 60200, 60400),
    ]
    expect(
      repetitionCuts(
        [
          {
            phrase: 'reciben poema',
            count: 2,
            windowStartMs: 0,
            windowEndMs: 70000,
            words: spread,
          },
        ],
        'es',
      ),
    ).toEqual([])
  })

  // The class #63 explicitly forbids cutting: a button clicked twice in a tutorial clears both the
  // content-word floor and the time bound, and only the fumble-width test refuses it.
  test('declines legitimate reuse that clears the content floor and the time bound', () => {
    const reuse = 'le damos clic aqui a open chatgpt eso nos lleva le damos clic a plus'
      .split(' ')
      .map((token, index) => word(token, index * 100, index * 100 + 90))
    expect(
      repetitionCuts(
        [{ phrase: 'damos clic', count: 2, windowStartMs: 0, windowEndMs: 16000, words: reuse }],
        'es',
      ),
    ).toEqual([])
  })

  test('declines a phrase it cannot locate twice in the measured timings', () => {
    expect(
      repetitionCuts(
        [
          {
            phrase: 'never spoken here',
            count: 2,
            windowStartMs: 0,
            windowEndMs: 16000,
            words: retake,
          },
        ],
        'es',
      ),
    ).toEqual([])
  })
})

describe('snapToWords', () => {
  // Word STARTS only: a cue's end is stretched to the next word, so clamping to it would widen
  // every cut by the pause the cue swallowed.
  test('pulls an end back off a word that begins inside the span', () => {
    const words = [word('hola', 900, 1400)]
    expect(snapToWords({ startMs: 0, endMs: 1000 }, words)).toEqual({ startMs: 0, endMs: 900 })
  })

  test('leaves a span that starts no word alone', () => {
    const words = [word('hola', 2000, 2400)]
    expect(snapToWords({ startMs: 0, endMs: 1000 }, words)).toEqual({ startMs: 0, endMs: 1000 })
  })

  test('no transcript is a span unchanged, never a guess', () => {
    expect(snapToWords({ startMs: 0, endMs: 1000 }, [])).toEqual({ startMs: 0, endMs: 1000 })
  })

  // A cue claiming a word starts inside measured silence is drift (build-edl's driftSuspectSpan),
  // and honouring it truncated the 3:36 cough cut on the real render from 5.29s to 0.60s, giving
  // back audio that measures -63.4dB.
  test('ignores a cue that claims a word starts inside measured silence', () => {
    const words = [word('drifted', 900, 1400)]
    const silences = [silence(500, 1200)]
    expect(snapToWords({ startMs: 0, endMs: 1000 }, words, silences)).toEqual({
      startMs: 0,
      endMs: 1000,
    })
  })

  test('still respects a word that starts in audio no silence covers', () => {
    const words = [word('real', 900, 1400)]
    const silences = [silence(0, 500)]
    expect(snapToWords({ startMs: 0, endMs: 1000 }, words, silences)).toEqual({
      startMs: 0,
      endMs: 900,
    })
  })
})

describe('fragmentCuts', () => {
  test('absorbs speech stranded between two cuts under the keepable floor', () => {
    const cuts = fragmentCuts(
      [
        {
          startMs: 0,
          endMs: 1000,
          kind: 'filler',
          instrument: 'silence',
          measurement: 'a',
          reason: 'silence: a',
        },
        {
          startMs: 1200,
          endMs: 2000,
          kind: 'filler',
          instrument: 'silence',
          measurement: 'b',
          reason: 'silence: b',
        },
      ],
      [],
    )
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.instrument).toBe('fragment')
    expect(cuts[0]?.startMs).toBe(1000)
    expect(cuts[0]?.endMs).toBe(1200)
  })

  test('leaves a remainder long enough to carry a line', () => {
    const cuts = fragmentCuts(
      [
        {
          startMs: 0,
          endMs: 1000,
          kind: 'filler',
          instrument: 'silence',
          measurement: 'a',
          reason: 'silence: a',
        },
        {
          startMs: 2000,
          endMs: 3000,
          kind: 'filler',
          instrument: 'silence',
          measurement: 'b',
          reason: 'silence: b',
        },
      ],
      [],
    )
    expect(cuts).toEqual([])
  })
})

describe('mergeAutoCuts', () => {
  test('fuses overlapping cuts and keeps both instruments in the evidence', () => {
    const merged = mergeAutoCuts([
      {
        startMs: 0,
        endMs: 1000,
        kind: 'filler',
        instrument: 'silence',
        measurement: 'sil',
        reason: 'silence: sil',
      },
      {
        startMs: 900,
        endMs: 2000,
        kind: 'filler',
        instrument: 'nonspeech',
        measurement: 'ns',
        reason: 'nonspeech: ns',
      },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.endMs).toBe(2000)
    expect(merged[0]?.measurement).toContain('sil')
    expect(merged[0]?.measurement).toContain('ns')
  })
})

describe('planAutoCuts', () => {
  test('reports both thresholds and which one was used', () => {
    const report = planAutoCuts({
      nonspeechSpans: [],
      silence: {
        spans: [],
        floorDb: -78,
        floorThresholdDb: -68,
        medianDb: -20,
        medianThresholdDb: -40,
        thresholdDb: -40,
      },
      repeats: [],
      words: [],
      durationMs: 100000,
    })
    expect(report.silence.floorThresholdDb).toBe(-68)
    expect(report.silence.medianThresholdDb).toBe(-40)
    expect(report.silence.thresholdDb).toBe(-40)
  })

  test('counts what each instrument offered against what became a cut', () => {
    const report = planAutoCuts({
      nonspeechSpans: [{ startMs: 0, endMs: 2000 }],
      silence: { ...noSilence, spans: [silence(0, 2000)], thresholdDb: -40 },
      repeats: [],
      words: [],
      durationMs: 100000,
    })
    expect(report.considered.nonspeech.offered).toBe(1)
    expect(report.considered.silence.offered).toBe(1)
    expect(report.cuts.length).toBeGreaterThan(0)
  })

  // The bound that keeps an automatic pass from deleting a recording. Hit for real while building
  // this: on silent fixtures the silence class marked the whole file and the build threw
  // "no segments survive".
  test('stands down entirely rather than removing more than half a render', () => {
    const report = planAutoCuts({
      nonspeechSpans: [],
      silence: { ...noSilence, spans: [silence(0, 9000)], thresholdDb: -40 },
      repeats: [],
      words: [],
      durationMs: 10000,
    })
    expect(report.cuts).toEqual([])
    expect(report.stoodDown).toBeDefined()
    expect(report.stoodDown?.proposedCuts).toBe(1)
    expect(report.stoodDown?.reason).toContain('exceeded')
  })

  test('an ordinary run carries no stoodDown field at all', () => {
    const report = planAutoCuts({
      nonspeechSpans: [],
      silence: { ...noSilence, spans: [silence(0, 1000)], thresholdDb: -40 },
      repeats: [],
      words: [],
      durationMs: 100000,
    })
    expect(report.stoodDown).toBeUndefined()
  })

  test('no derivable threshold cuts nothing rather than guessing one', () => {
    const report = planAutoCuts({
      nonspeechSpans: [{ startMs: 0, endMs: 2000 }],
      silence: noSilence,
      repeats: [],
      words: [],
      durationMs: 100000,
    })
    expect(report.cuts).toEqual([])
  })
})
