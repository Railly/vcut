import { describe, expect, test } from 'bun:test'
import {
  absorbSlivers,
  boundariesAfterSpeech,
  boundariesInSilence,
  buildEdlNext,
  type Cut,
  clampedSpanFor,
  clampToWords,
  describeSemanticCuts,
  invertToSegments,
  matchTarget,
  mergeIntervals,
  parseCrop,
  reasonMismatch,
  removedText,
  snapToFrame,
  wordBoundaries,
} from '../src/build-edl.ts'
import type { SilenceCandidate, Transcript, Word } from '../src/detect.ts'

const silence = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'silence' })
const semantic = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'semantic' })

describe('mergeIntervals', () => {
  test('sorts and fuses overlapping cuts', () => {
    const merged = mergeIntervals([silence(5000, 6000), silence(1000, 2000), silence(1500, 3000)])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ startMs: 1000, endMs: 3000 })
    expect(merged[1]).toMatchObject({ startMs: 5000, endMs: 6000 })
  })

  test('keeps adjacent-but-disjoint cuts separate', () => {
    expect(mergeIntervals([silence(0, 1000), silence(1001, 2000)])).toHaveLength(2)
  })

  test('does not mutate the caller array', () => {
    const input = [silence(1000, 2000), silence(1500, 3000)]
    mergeIntervals(input)
    expect(input[0].endMs).toBe(2000)
  })

  test('degrades a fused mixed-reason cut to silence', () => {
    const merged = mergeIntervals([semantic(1000, 2000), silence(1500, 3000)])
    expect(merged).toHaveLength(1)
    expect(merged[0].reason).toBe('silence')
  })
})

describe('clampToWords', () => {
  const boundaries = wordBoundaries({
    words: [
      { text: 'hola', startMs: 900, endMs: 1200 },
      { text: 'mundo', startMs: 2800, endMs: 3200 },
    ],
    wordLevel: true,
  } as Transcript)

  const MIN = 300

  test('pulls a cut start out of a spoken word', () => {
    const clamped = clampToWords(silence(1000, 2000), boundaries, MIN)
    expect(clamped?.startMs).toBe(1200)
    expect(clamped?.endMs).toBe(2000)
  })

  test('pulls a cut end out of a spoken word', () => {
    const clamped = clampToWords(silence(1500, 3000), boundaries, MIN)
    expect(clamped?.startMs).toBe(1500)
    expect(clamped?.endMs).toBe(2800)
  })

  test('leaves a cut that already sits between words untouched', () => {
    const clamped = clampToWords(silence(1300, 2700), boundaries, MIN)
    expect(clamped).toEqual(silence(1300, 2700))
  })

  test('keeps a measured cut that a swallowing cue would erase', () => {
    // whisper --max-len 1 stretches a cue to the next word, so a word's range
    // routinely covers the pause after it. ffmpeg measured a real silence here.
    const swallowing = wordBoundaries({
      words: [{ text: 'trabajando', startMs: 0, endMs: 5000 }],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 2000), swallowing, MIN)).toEqual(silence(1000, 2000))
  })

  test('drops a cut that was already shorter than the detector minimum', () => {
    const swallowing = wordBoundaries({
      words: [{ text: 'larga', startMs: 0, endMs: 5000 }],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 1100), swallowing, MIN)).toBeNull()
  })

  test('drops a sliver left by clamping when the source cut was also short', () => {
    const tight = wordBoundaries({
      words: [
        { text: 'uno', startMs: 900, endMs: 1150 },
        { text: 'dos', startMs: 1200, endMs: 1500 },
      ],
      wordLevel: true,
    } as Transcript)
    expect(clampToWords(silence(1000, 1250), tight, MIN)).toBeNull()
  })
})

describe('snapToFrame', () => {
  const frameMs = 1000 / 60

  test('lands mid-frame, away from the edge where rounding flips', () => {
    // A frame boundary is not a whole millisecond at 60fps, so the value cannot sit
    // exactly on it. Landing in the middle keeps ffmpeg's own rounding stable.
    for (const input of [1097, 4634, 333, 15_833]) {
      const snapped = snapToFrame(input, 60)
      const offset = ((snapped % frameMs) + frameMs) % frameMs
      expect(Math.abs(offset - frameMs / 2)).toBeLessThan(1)
    }
  })

  test('stays within half a frame of the requested time', () => {
    for (const input of [1097, 4634, 333, 15_833]) {
      expect(Math.abs(snapToFrame(input, 60) - input)).toBeLessThanOrEqual(frameMs)
    }
  })

  test('picks the same frame no matter how it is approached', () => {
    const target = Math.round(120 * frameMs)
    expect(snapToFrame(target - 3, 60)).toBe(snapToFrame(target + 3, 60))
  })

  test('leaves values untouched when fps is unknown', () => {
    expect(snapToFrame(1097, 0)).toBe(1097)
  })

  test('resolves each boundary to an unambiguous frame index', () => {
    const durationMs = 10_000
    const segments = invertToSegments([silence(2000, 3000)], durationMs, 'take-01', 100, 60)
    for (const segment of segments) {
      for (const boundary of [segment.inMs, segment.outMs]) {
        // The end of the source is clamped to the real duration, not snapped: a
        // segment must never claim material past the end of the file.
        if (boundary === durationMs) {
          continue
        }
        // Everywhere else, mid-frame placement puts the fractional part near 0.5,
        // so the frame ffmpeg resolves to is the same from either direction.
        expect(Math.abs(((boundary / frameMs) % 1) - 0.5)).toBeLessThan(0.1)
      }
    }
  })
})

describe('invertToSegments', () => {
  test('keeps the spans between cuts', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ id: 'segment-001', inMs: 0, outMs: 2000 })
    expect(segments[1]).toMatchObject({ id: 'segment-002', inMs: 3000, outMs: 10_000 })
  })

  test('drops a leading cut that starts at zero without emitting an empty segment', () => {
    const segments = invertToSegments([silence(0, 1197)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 1197, outMs: 10_000 })
  })

  test('emits no margin-only sliver when a cut starts at zero', () => {
    const segments = invertToSegments([silence(0, 1197)], 10_000, 'take-01', 100)
    expect(segments).toHaveLength(1)
    expect(segments[0].inMs).toBe(1097)
    expect(segments.every((segment) => segment.outMs - segment.inMs > 100)).toBe(true)
  })

  test('drops a trailing cut that runs to the end of the source', () => {
    const segments = invertToSegments([silence(9000, 10_000)], 10_000, 'take-01', 0)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 0, outMs: 9000 })
  })

  test('never exceeds the source duration when applying margins', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 100)
    expect(segments.every((segment) => segment.outMs <= 10_000)).toBe(true)
    expect(segments.every((segment) => segment.inMs >= 0)).toBe(true)
    expect(segments[0].outMs).toBe(2100)
    expect(segments[1].inMs).toBe(2900)
  })

  test('emits monotonic non-overlapping segments for many cuts', () => {
    const cuts = Array.from({ length: 50 }, (_, index) =>
      silence(index * 1000 + 500, index * 1000 + 800),
    )
    const segments = invertToSegments(cuts, 60_000, 'take-01', 0)
    expect(segments.every((segment) => segment.outMs > segment.inMs)).toBe(true)
    for (const [index, segment] of segments.entries()) {
      if (index > 0) {
        expect(segment.inMs).toBeGreaterThanOrEqual(segments[index - 1].outMs)
      }
    }
  })

  test('pads segment ids to the schema pattern', () => {
    const cuts = Array.from({ length: 12 }, (_, index) =>
      silence(index * 1000 + 500, index * 1000 + 800),
    )
    const segments = invertToSegments(cuts, 20_000, 'take-01', 0)
    expect(segments.every((segment) => /^segment-[0-9]{3}$/.test(segment.id))).toBe(true)
    expect(segments[9].id).toBe('segment-010')
  })

  test('marks every segment as proposed with zero semantic risk', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'take-01', 100)
    expect(segments.every((segment) => segment.approval === 'proposed')).toBe(true)
    expect(segments.every((segment) => segment.semanticRisk === 'none')).toBe(true)
    expect(segments[0].handlesMs).toEqual({ before: 100, after: 100 })
  })

  test('returns the whole source when there is nothing to cut', () => {
    const segments = invertToSegments([], 10_000, 'take-01', 100)
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ inMs: 0, outMs: 10_000 })
  })

  test('returns nothing when a single cut covers the entire source', () => {
    expect(invertToSegments([silence(0, 10_000)], 10_000, 'take-01', 0)).toHaveLength(0)
  })
})

describe('absorbSlivers', () => {
  const cut = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'silence' })

  test('merges two cuts across a remainder too short to be speech', () => {
    const merged = absorbSlivers([cut(0, 1_000), cut(1_200, 2_000)], 300)
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ startMs: 0, endMs: 2_000 })
  })

  test('keeps two cuts apart when real speech survives between them', () => {
    expect(absorbSlivers([cut(0, 1_000), cut(2_000, 3_000)], 300)).toHaveLength(2)
  })

  test('collapses a run of stutters into one cut', () => {
    const merged = absorbSlivers([cut(0, 500), cut(700, 900), cut(1_100, 1_400)], 300)
    expect(merged).toHaveLength(1)
    expect(merged[0].endMs).toBe(1_400)
  })

  test('a merged cut reports as silence when its parts disagree', () => {
    const merged = absorbSlivers(
      [cut(0, 500), { startMs: 600, endMs: 900, reason: 'semantic' }],
      300,
    )
    expect(merged[0].reason).toBe('silence')
  })

  test('leaves a single cut alone', () => {
    expect(absorbSlivers([cut(0, 1_000)], 300)).toEqual([cut(0, 1_000)])
  })

  test('stops islands of pure margin reaching the EDL', () => {
    // Two silences 216ms apart at a 100ms margin. The remainder is margin on both sides and
    // nothing else, which is what turned one pause into three audible stutters. Without the
    // absorb step this inverts to three segments with a sliver in the middle.
    const segments = invertToSegments(
      [cut(1_000, 2_000), cut(2_216, 3_000)],
      10_000,
      'src',
      100,
      60,
    )
    expect(segments).toHaveLength(2)
  })
})

describe('matchTarget bounds', () => {
  test('says above, not below, when more was removed than any range allows', () => {
    expect(matchTarget(45.4)).toContain('above every target range')
  })

  test('still says below when the source barely moved', () => {
    expect(matchTarget(2)).toContain('below every target range')
  })

  test('names the range at its exact ceiling', () => {
    expect(matchTarget(45)).toContain('event or interview')
  })
})

describe('parseCrop', () => {
  test('shaves a strip off the top, which is the request this exists for', () => {
    expect(parseCrop('top:0.06')).toEqual({ x: 0, y: 0.06, width: 1, height: 0.94 })
  })

  test('shaves the other three edges', () => {
    expect(parseCrop('bottom:0.1')).toEqual({ x: 0, y: 0, width: 1, height: 0.9 })
    expect(parseCrop('left:0.2')).toEqual({ x: 0.2, y: 0, width: 0.8, height: 1 })
    expect(parseCrop('right:0.2')).toEqual({ x: 0, y: 0, width: 0.8, height: 1 })
  })

  test('accepts an arbitrary window as fractions', () => {
    expect(parseCrop('0.1,0.2,0.5,0.6')).toEqual({ x: 0.1, y: 0.2, width: 0.5, height: 0.6 })
  })

  test('refuses an edge fraction outside the unit range', () => {
    expect(() => parseCrop('top:1.5')).toThrow()
    expect(() => parseCrop('top:0')).toThrow()
  })

  test('refuses a window that runs past the source', () => {
    expect(() => parseCrop('0.5,0.5,0.9,0.9')).toThrow()
  })

  test('refuses a malformed spec rather than guessing', () => {
    expect(() => parseCrop('0.1,0.2')).toThrow()
    expect(() => parseCrop('middle:0.5')).toThrow()
  })
})

describe('invertToSegments with a crop', () => {
  test('applies one frame decision to every segment', () => {
    const crop = { x: 0, y: 0.06, width: 1, height: 0.94 }
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'src', 100, 60, 300, crop)
    expect(segments.every((segment) => segment.crop === crop)).toBe(true)
  })

  test('leaves crop null when none was asked for, so old EDLs render unchanged', () => {
    const segments = invertToSegments([silence(2000, 3000)], 10_000, 'src', 100, 60)
    expect(segments.every((segment) => segment.crop === null)).toBe(true)
  })
})

describe('boundariesAfterSpeech', () => {
  const seg = (inMs: number, outMs: number, id: string) => ({ id, inMs, outMs })
  const span = (startMs: number, endMs: number) => ({ startMs, endMs })

  // Three kept spans. The gap before the third is where a semantic cut removed speech.
  const segments = [
    seg(0, 2000, 'segment-001'),
    seg(2100, 4000, 'segment-002'),
    seg(11000, 13000, 'segment-003'),
  ]
  const words = [span(4200, 4600), span(4700, 5200), span(10500, 10900)]

  test('names the boundary that opens after a semantic cut', () => {
    const found = boundariesAfterSpeech(segments, [span(4000, 11000)], words)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ index: 2, wordsRemoved: 3 })
    expect(found[0]?.cutMs).toBe(7000)
  })

  // The first attempt at this check keyed on "did the removed span contain words" and fired
  // on 23 of 24 boundaries of a real EDL: with word clamping every silence cut brushes the
  // margin around a word. A warning that fires everywhere trains a reader to skip it.
  test('says nothing when the only cuts were silence', () => {
    expect(boundariesAfterSpeech(segments, [], words)).toEqual([])
  })

  test('ignores a semantic cut that does not touch a boundary', () => {
    expect(boundariesAfterSpeech(segments, [span(20_000, 21_000)], words)).toEqual([])
  })

  test('the opening segment follows no cut', () => {
    const found = boundariesAfterSpeech(segments, [span(0, 1000)], words)
    expect(found.every((entry) => entry.index !== 0)).toBe(true)
  })

  // A semantic cut can remove a pause the model judged dead rather than words, and that
  // boundary is still where a tail survives.
  test('reports a semantic cut even when it removed no words', () => {
    const found = boundariesAfterSpeech(segments, [span(4000, 11000)], [])
    expect(found).toHaveLength(1)
    expect(found[0]?.wordsRemoved).toBe(0)
  })
})

describe('clampedSpanFor', () => {
  const semantic = (startMs: number, endMs: number): Cut => ({ startMs, endMs, reason: 'semantic' })

  test('returns the merged cut that contains the proposal, not the raw proposal', () => {
    // The proposal asked for 5000-5500; it absorbed into a wider merged span because a
    // silence cut sat right beside it.
    const merged = [semantic(4900, 5800)]
    expect(clampedSpanFor({ startMs: 5000, endMs: 5500 }, merged)).toEqual(merged[0])
  })

  test('falls back to the raw proposal when nothing merged contains it', () => {
    const proposal = { startMs: 100, endMs: 200 }
    expect(clampedSpanFor(proposal, [])).toEqual(proposal)
  })
})

describe('removedText', () => {
  const word = (text: string, startMs: number, endMs: number): Word => ({
    text,
    startsWord: true,
    startMs,
    endMs,
  })

  test('joins words falling inside the span, in order', () => {
    const words = [word('en', 1000, 1200), word('nuestra', 1200, 1600), word('propia', 1600, 2000)]
    expect(removedText({ startMs: 900, endMs: 2100 }, words)).toBe('en nuestra propia')
  })

  test('includes a word that only overlaps the edge', () => {
    const words = [word('propia', 1600, 2000)]
    expect(removedText({ startMs: 1800, endMs: 2500 }, words)).toBe('propia')
  })

  test('empty string with no transcript words', () => {
    expect(removedText({ startMs: 0, endMs: 5000 }, [])).toBe('')
  })

  test('empty string when nothing falls inside the span', () => {
    const words = [word('hola', 100, 400)]
    expect(removedText({ startMs: 5000, endMs: 6000 }, words)).toBe('')
  })
})

describe('boundariesInSilence', () => {
  const silence = (startMs: number, endMs: number): SilenceCandidate => ({
    kind: 'silence',
    startMs,
    endMs,
    durationMs: endMs - startMs,
  })

  test('both edges inside measured silence', () => {
    expect(
      boundariesInSilence({ startMs: 1000, endMs: 2000 }, [
        silence(900, 1100),
        silence(1900, 2100),
      ]),
    ).toEqual([true, true])
  })

  test('one edge in silence, the other in speech', () => {
    expect(boundariesInSilence({ startMs: 1000, endMs: 2000 }, [silence(900, 1100)])).toEqual([
      true,
      false,
    ])
  })

  test('neither edge touches a measured silence', () => {
    expect(boundariesInSilence({ startMs: 5000, endMs: 6000 }, [silence(0, 100)])).toEqual([
      false,
      false,
    ])
  })
})

describe('reasonMismatch', () => {
  test('fires when removedText and reason share no carrying words', () => {
    expect(
      reasonMismatch(
        'todos estamos muy contentos hoy trabajando',
        'stutter en nuestra propia empresa',
      ),
    ).toBe(true)
  })

  test('stays silent when the reason quotes the removed text', () => {
    expect(
      reasonMismatch(
        'en nuestra propia empresa nueva',
        'repite "en nuestra propia empresa" antes de continuar',
      ),
    ).toBe(false)
  })

  test('stays silent when removedText is too short to carry a signal', () => {
    expect(reasonMismatch('eh nada', 'filler word removed, not carrying meaning')).toBe(false)
  })

  test('stays silent on an empty removedText', () => {
    expect(reasonMismatch('', 'anything at all')).toBe(false)
  })
})

describe('describeSemanticCuts', () => {
  const word = (text: string, startMs: number, endMs: number): Word => ({
    text,
    startsWord: true,
    startMs,
    endMs,
  })
  const silence = (startMs: number, endMs: number): SilenceCandidate => ({
    kind: 'silence',
    startMs,
    endMs,
    durationMs: endMs - startMs,
  })

  test('the corrective case: a repetition cut that removed the wrong words gets flagged', () => {
    // The measured motivation: a repetition cut removed "todos estamos" instead of the
    // stutter "en nuestra propia" because measured blocks were mis-assigned.
    const proposals = [
      {
        startMs: 1000,
        endMs: 2000,
        kind: 'repetition' as const,
        reason: 'stutter en nuestra propia empresa repetido dos veces',
      },
    ]
    const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
    const words = [
      word('todos', 1000, 1250),
      word('estamos', 1250, 1500),
      word('muy', 1500, 1600),
      word('contentos', 1600, 1800),
      word('trabajando', 1800, 1900),
    ]
    const { cuts, warnings } = describeSemanticCuts(proposals, merged, words, [])
    expect(cuts).toHaveLength(1)
    expect(cuts[0]?.removedText).toBe('todos estamos muy contentos trabajando')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('todos estamos muy contentos trabajando')
  })

  test('no warning when the reason names the removed text', () => {
    const proposals = [
      {
        startMs: 1000,
        endMs: 2000,
        kind: 'filler' as const,
        reason: 'removes the repeated "en nuestra propia empresa" before the real sentence',
      },
    ]
    const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
    const words = [
      word('en', 1000, 1200),
      word('nuestra', 1200, 1500),
      word('propia', 1500, 1700),
      word('empresa', 1700, 1950),
    ]
    const { warnings } = describeSemanticCuts(proposals, merged, words, [])
    expect(warnings).toHaveLength(0)
  })

  test('no warning on a short removedText regardless of the reason', () => {
    const proposals = [{ startMs: 1000, endMs: 1300, kind: 'filler' as const, reason: 'stray eh' }]
    const merged: Cut[] = [{ startMs: 1000, endMs: 1300, reason: 'semantic' }]
    const words = [word('eh', 1000, 1200)]
    const { warnings } = describeSemanticCuts(proposals, merged, words, [])
    expect(warnings).toHaveLength(0)
  })

  test('reports boundariesInSilence per proposal', () => {
    const proposals = [
      { startMs: 1000, endMs: 2000, kind: 'filler' as const, reason: 'filler removed' },
    ]
    const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
    const { cuts } = describeSemanticCuts(
      proposals,
      merged,
      [],
      [silence(950, 1050), silence(1950, 2050)],
    )
    expect(cuts[0]?.boundariesInSilence).toEqual([true, true])
  })

  test('empty removedText and no warning with no transcript at all', () => {
    const proposals = [
      { startMs: 1000, endMs: 2000, kind: 'filler' as const, reason: 'no transcript available' },
    ]
    const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
    const { cuts, warnings } = describeSemanticCuts(proposals, merged, [], [])
    expect(cuts[0]?.removedText).toBe('')
    expect(warnings).toHaveLength(0)
  })
})

describe('buildEdlNext', () => {
  test('names a non-empty question and a non-empty verb for each entry', () => {
    const hints = buildEdlNext('/tmp/edl.json')
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.question.length).toBeGreaterThan(0)
      expect(hint.verb.length).toBeGreaterThan(0)
    }
  })

  test('the hear-the-cut verb carries the given edl path', () => {
    const hints = buildEdlNext('/tmp/edl.json')
    expect(hints.some((hint) => hint.verb.includes('/tmp/edl.json'))).toBe(true)
  })
})
