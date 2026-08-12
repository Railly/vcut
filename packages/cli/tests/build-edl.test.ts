import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  absorbSlivers,
  type BuildOptions,
  boundariesAfterSpeech,
  boundariesInSilence,
  buildEdlCommand,
  buildEdlNext,
  type Cut,
  clampedSpanFor,
  clampToWords,
  describeSemanticCuts,
  driftSuspectSpan,
  invertToSegments,
  type KeptSegment,
  markSemanticRisk,
  matchTarget,
  mergeIntervals,
  parseCrop,
  reasonMismatch,
  removedText,
  runBuild,
  snapToFrame,
  wordBoundaries,
} from '../src/build-edl.ts'
import type { DetectReport, SilenceCandidate, Transcript, Word } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import { buildFfmpegArgs, type Edl, outputErrors } from '../src/render-edl.ts'

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

describe('markSemanticRisk', () => {
  const seg = (id: string, inMs: number, outMs: number): KeptSegment => ({
    id,
    sourceId: 'src',
    inMs,
    outMs,
    reason: 'approved-line',
    handlesMs: { before: 0, after: 0 },
    approval: 'proposed',
    semanticRisk: 'none',
    crop: null,
  })

  test('flags a segment touching the raw proposal edge when nothing merged', () => {
    const segments = [seg('segment-001', 0, 5000), seg('segment-002', 5000, 10_000)]
    const proposal = { startMs: 5000, endMs: 6000 }
    const merged: Cut[] = [semantic(5000, 6000)]
    const flagged = markSemanticRisk(segments, [proposal], merged, 50)
    expect(flagged[0].semanticRisk).toBe('material')
    expect(flagged[1].semanticRisk).toBe('material')
  })

  // The absorbed-span case: a 9.4s proposal (5000-14400) sits close enough to a neighbouring
  // silence cut that mergeIntervals/absorbSlivers fuse them into one ~10s span (4900-15200).
  // Comparing segment edges against the raw 5000/14400 proposal edges misses the segments
  // that touch the merged span's actual 4900/15200 boundaries, which is what the render
  // carries regardless of which raw edge produced it — they read `semanticRisk: 'none'`
  // before this fix, exactly the gap the real recording surfaced.
  test('flags a segment touching the merged (absorbed) span, not the raw proposal edge', () => {
    const segments = [seg('segment-001', 0, 4900), seg('segment-002', 15_200, 20_000)]
    const proposal = { startMs: 5000, endMs: 14_400 }
    const merged: Cut[] = [semantic(4900, 15_200)]
    const flagged = markSemanticRisk(segments, [proposal], merged, 50)
    expect(flagged[0].semanticRisk).toBe('material')
    expect(flagged[1].semanticRisk).toBe('material')
  })

  test('does not flag a segment that touches only the raw edge once merging moved the real edge away', () => {
    // A segment sitting exactly at the raw proposal's 5000ms edge is not where the render's
    // cut actually starts once merging pulled the boundary back to 4900ms; flagging it would
    // point a reviewer at a boundary the render does not have.
    const segments = [seg('segment-001', 0, 5000)]
    const proposal = { startMs: 5000, endMs: 14_400 }
    const merged: Cut[] = [semantic(4900, 15_200)]
    const flagged = markSemanticRisk(segments, [proposal], merged, 0)
    expect(flagged[0].semanticRisk).toBe('none')
  })

  test('no proposals means no flags, even with segments and a tolerance', () => {
    const segments = [seg('segment-001', 0, 5000)]
    expect(markSemanticRisk(segments, [], [], 50)).toEqual(segments)
  })

  test('a proposal with nothing merged containing it falls back to its own raw edges', () => {
    const segments = [seg('segment-001', 0, 5000)]
    const proposal = { startMs: 5000, endMs: 6000 }
    const flagged = markSemanticRisk(segments, [proposal], [], 50)
    expect(flagged[0].semanticRisk).toBe('material')
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

describe('driftSuspectSpan', () => {
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

  test('flags a span whose word claims to start inside measured silence', () => {
    // The word claims to begin at 1000ms; the audio stays silent until 1400ms.
    const words = [word('hola', 1000, 1600)]
    const silences = [silence(800, 1400)]
    expect(driftSuspectSpan({ startMs: 900, endMs: 2000 }, words, silences)).toBe(true)
  })

  test('does not flag a clean span with no contradicting word', () => {
    const words = [word('hola', 1500, 1800)]
    const silences = [silence(800, 1400)]
    expect(driftSuspectSpan({ startMs: 900, endMs: 2000 }, words, silences)).toBe(false)
  })

  test('ignores a contradicting word outside the span', () => {
    // The drifted word sits well before the span; the span's own words are clean.
    const words = [word('antes', 100, 300), word('dentro', 5000, 5300)]
    const silences = [silence(0, 250)]
    expect(driftSuspectSpan({ startMs: 4900, endMs: 5500 }, words, silences)).toBe(false)
  })

  test('no words, no silences: never flags', () => {
    expect(driftSuspectSpan({ startMs: 0, endMs: 1000 }, [], [])).toBe(false)
  })

  test('boundary case: a word starting exactly at a silence edge is not inside it', () => {
    // wordsContradictingSilence uses startMs >= span.startMs && startMs < span.endMs; a word
    // starting exactly at the silence's own end is speech resuming, not drift.
    const words = [word('justo', 1400, 1700)]
    const silences = [silence(800, 1400)]
    expect(driftSuspectSpan({ startMs: 900, endMs: 2000 }, words, silences)).toBe(false)
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

  test('marks driftSuspect and warns when the span sits on drifted cues', () => {
    const proposals = [
      { startMs: 900, endMs: 2000, kind: 'filler' as const, reason: 'stray word removed' },
    ]
    const merged: Cut[] = [{ startMs: 900, endMs: 2000, reason: 'semantic' }]
    // Claims to start at 1000ms; the audio stays silent until 1400ms.
    const words = [word('hola', 1000, 1600)]
    const silences = [silence(800, 1400)]
    const { cuts, warnings } = describeSemanticCuts(proposals, merged, words, silences)
    expect(cuts[0]?.driftSuspect).toBe(true)
    expect(warnings.some((warning) => warning.includes('driftSuspect'))).toBe(true)
  })

  test('leaves driftSuspect unset on a clean span', () => {
    const proposals = [
      { startMs: 1000, endMs: 2000, kind: 'filler' as const, reason: 'filler removed' },
    ]
    const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
    const words = [word('hola', 1500, 1800)]
    const { cuts, warnings } = describeSemanticCuts(proposals, merged, words, [])
    expect(cuts[0]?.driftSuspect).toBeUndefined()
    expect(warnings.some((warning) => warning.includes('driftSuspect'))).toBe(false)
  })

  test('driftSuspect can fire independently of reasonMismatch on the same span', () => {
    // The reason accurately names the word, so reasonMismatch stays silent; the word's own
    // timing still contradicts measured silence, so driftSuspect still fires.
    const proposals = [
      { startMs: 900, endMs: 2000, kind: 'filler' as const, reason: 'removes stray "hola cómo"' },
    ]
    const merged: Cut[] = [{ startMs: 900, endMs: 2000, reason: 'semantic' }]
    const words = [word('hola', 1000, 1600), word('cómo', 1600, 1900)]
    const silences = [silence(800, 1400)]
    const { cuts, warnings } = describeSemanticCuts(proposals, merged, words, silences)
    expect(cuts[0]?.driftSuspect).toBe(true)
    expect(warnings.some((warning) => warning.includes('driftSuspect'))).toBe(true)
    expect(
      warnings.every((warning) => !warning.includes('which the reason does not mention')),
    ).toBe(true)
  })

  // Issue #40: reproduces the drop-and-repropose loop the retro named — a proposal whose exact
  // boundary already sits right beside a silence cut absorbs into the wider merged span by
  // default, and the reported removedText grows to include a word the caller meant to keep.
  // `literal: true` on the proposal is the escape hatch: it reports the proposal's own span
  // exactly, the same one invertToSegments never touches either way.
  describe('literal proposals (issue #40)', () => {
    test('a literal proposal keeps its exact span where a non-literal one would absorb the neighbouring silence cut', () => {
      // A silence cut runs 1800-2100; a proposal asking for 1000-1800 sits flush against it, so
      // the default merge (mergeIntervals) fuses them into one 1000-2100 span before
      // describeSemanticCuts ever sees it — this is the corrective the flag exists for.
      const merged: Cut[] = [{ startMs: 1000, endMs: 2100, reason: 'semantic' }]
      const words = [
        word('borra', 1000, 1400),
        word('esto', 1400, 1800),
        // "profe" starts inside the merged span's absorbed tail (1800-2100), the word a
        // clamped read would eat that the caller meant to keep.
        word('profe', 1850, 2050),
      ]

      const clamped = describeSemanticCuts(
        [{ startMs: 1000, endMs: 1800, kind: 'filler' as const, reason: 'borra esto' }],
        merged,
        words,
        [],
      )
      expect(clamped.cuts[0]).toMatchObject({ startMs: 1000, endMs: 2100 })
      expect(clamped.cuts[0]?.removedText).toBe('borra esto profe')

      const literal = describeSemanticCuts(
        [
          {
            startMs: 1000,
            endMs: 1800,
            kind: 'filler' as const,
            reason: 'borra esto',
            literal: true,
          },
        ],
        merged,
        words,
        [],
      )
      expect(literal.cuts[0]).toMatchObject({ startMs: 1000, endMs: 1800, literal: true })
      expect(literal.cuts[0]?.removedText).toBe('borra esto')
    })

    test('removedText and driftSuspect are still computed against the literal span, not skipped', () => {
      // Same drift shape every other driftSuspect fixture in this file uses: a word claims to
      // start at 900ms while detect measured silence through 1400ms.
      const merged: Cut[] = [{ startMs: 900, endMs: 2000, reason: 'semantic' }]
      const words = [word('hola', 1000, 1600)]
      const silences = [silence(800, 1400)]
      const { cuts, warnings } = describeSemanticCuts(
        [
          {
            startMs: 900,
            endMs: 2000,
            kind: 'filler' as const,
            reason: 'stray word',
            literal: true,
          },
        ],
        merged,
        words,
        silences,
      )
      expect(cuts[0]?.literal).toBe(true)
      expect(cuts[0]?.removedText).toBe('hola')
      expect(cuts[0]?.driftSuspect).toBe(true)
      expect(warnings.some((warning) => warning.includes('driftSuspect'))).toBe(true)
    })

    test('a clean literal span carries literal: true with no driftSuspect', () => {
      const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
      const words = [word('hola', 1500, 1800)]
      const { cuts } = describeSemanticCuts(
        [{ startMs: 1000, endMs: 2000, kind: 'filler' as const, reason: 'clean', literal: true }],
        merged,
        words,
        [],
      )
      expect(cuts[0]?.literal).toBe(true)
      expect(cuts[0]?.driftSuspect).toBeUndefined()
    })

    test('a non-literal proposal never carries literal on its report', () => {
      const merged: Cut[] = [{ startMs: 1000, endMs: 2000, reason: 'semantic' }]
      const { cuts } = describeSemanticCuts(
        [{ startMs: 1000, endMs: 2000, kind: 'filler' as const, reason: 'clean' }],
        merged,
        [],
        [],
      )
      expect(cuts[0]?.literal).toBeUndefined()
      expect('literal' in (cuts[0] ?? {})).toBe(false)
    })
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

// commit (B-V3) builds from an in-memory detect report and proposals array through runBuild
// rather than round-tripping through --detect/--semantic file paths. This pins that the seam
// produces byte-identical output (modulo the two fields that are legitimately call-time —
// createdAt and each source's sha256, both deterministic given the same source bytes and
// clock, so sha256 is compared and createdAt is dropped before comparing) to running
// `vcut edl build --detect <path> --semantic <path>` on the equivalent inputs on disk.
describe('runBuild matches buildEdlCommand given equivalent inputs', () => {
  let workDir: string
  let mediaPath: string

  beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'vcut-build-equiv-'))
    mediaPath = join(workDir, 'source.mp4')
    // A short, deterministic lavfi source: real enough for ffprobe/ffmpeg to read streams
    // from, cheap enough to generate inline in a test (tens of milliseconds).
    const { exitCode, stderr } = await run('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=6:size=320x240:rate=10',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mediaPath,
    ])
    if (exitCode !== 0) {
      throw new Error(`fixture generation failed: ${stderr}`)
    }
  })

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  const stripVolatile = (edl: Record<string, unknown>) => {
    const { createdAt: _createdAt, ...rest } = edl
    return rest
  }

  test('the drafted EDL and build summary match, semantic proposals included', async () => {
    if (!existsSync(mediaPath)) {
      throw new Error('fixture source was not generated')
    }
    const report: DetectReport = {
      version: 1,
      input: mediaPath,
      durationMs: 6000,
      preset: 'noisy',
      thresholdDb: -20,
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcript: { path: null, wordLevel: false, words: 0 },
      audioPath: null,
      silences: [{ kind: 'silence', startMs: 1000, endMs: 1500, durationMs: 500 }],
      review: [],
      warnings: [],
    }
    const detectPath = join(workDir, 'detect.json')
    writeFileSync(detectPath, JSON.stringify(report))

    const proposals = [
      {
        startMs: 3000,
        endMs: 3800,
        kind: 'tangent' as const,
        reason: 'test aside, cut it',
      },
    ]
    const semanticPath = join(workDir, 'proposals.json')
    writeFileSync(semanticPath, JSON.stringify(proposals))

    // Path A: the CLI command, exactly as a caller on the command line would run it.
    const cliEdlPath = join(workDir, 'cli-edl.json')
    const originalLog = console.log
    let cliOutput = ''
    console.log = (...args: unknown[]) => {
      cliOutput += args.join(' ')
    }
    try {
      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        join(workDir, 'master.mp4'),
        '--campaign',
        'equivalence-test',
        '--edl',
        cliEdlPath,
        '--semantic',
        semanticPath,
        '--json',
      ])
    } finally {
      console.log = originalLog
    }
    const cliSummary = JSON.parse(cliOutput) as Record<string, unknown>
    const cliEdl = JSON.parse(readFileSync(cliEdlPath, 'utf8')) as Record<string, unknown>

    // Path B: runBuild called directly with the same report and proposals in memory, the way
    // commit calls it.
    const buildOptions: BuildOptions = {
      outputPath: join(workDir, 'master.mp4'),
      edlPath: join(workDir, 'seam-edl.json'),
      campaignId: 'equivalence-test',
      width: null,
      height: null,
      fps: null,
      edgeFadeMs: 50,
      crop: null,
      syncOffsetMs: 0,
    }
    const { edl: seamEdl, summary: seamSummary } = await runBuild(report, proposals, buildOptions)

    expect(stripVolatile(seamEdl as Record<string, unknown>)).toEqual(stripVolatile(cliEdl))
    // The two EDL files were written to different paths by construction; the summary's own
    // edlPath field differs for the same reason and is stripped below. Everything else,
    // including semanticCuts[].removedText and warnings, must match exactly.
    const {
      edlPath: _cliEdlPath,
      next: _cliNext,
      vcutVersion: _v,
      ...cliSummaryRest
    } = cliSummary as Record<string, unknown>
    const { edlPath: _seamEdlPath, ...seamSummaryRest } = seamSummary as unknown as Record<
      string,
      unknown
    >
    expect(seamSummaryRest).toEqual(cliSummaryRest)
  })
})

// A screen recording's audio device commonly outruns the last frame: the container reports
// the audio's longer duration as its own, and a segment trimmed to that number asks the video
// trim filter for frames the stream does not have. ffmpeg clamps silently, so the render comes
// out short and fails its own frame-count and duration checks (issue #14). Built on the fly, a
// real file because the defect lives in what ffprobe reports per stream, which a fixture path
// cannot fake. Where ffmpeg is absent the behaviour under test cannot exist, so this skips
// rather than fails: see semantic.test.ts's renderedGaps for the same convention.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)(
  'edl build clamps the final segment to the video stream, not the container',
  () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcut-avmismatch-'))
    const fixturePath = join(dir, 'fixture.mp4')
    const detectPath = join(dir, 'detect.json')
    const edlPath = join(dir, 'edl.json')
    const masterPath = join(dir, 'master.mp4')

    beforeAll(async () => {
      // 60fps video for 5s (300 frames) against audio that runs 84ms longer, the same shape
      // testing-10m.mp4 measured: video stream duration 700.717s, container 700.800s.
      const built = await run('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=rate=60:size=320x240:duration=5',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=5.084',
        '-map',
        '0:v',
        '-map',
        '1:a',
        '-y',
        fixturePath,
      ])
      if (built.exitCode !== 0) {
        throw new Error(built.stderr)
      }

      // Silences scattered across the fixture so invertToSegments keeps many segments, with
      // the last one running uncut to the source's end — the span that used to reach past the
      // video stream into the audio-only tail.
      const silences: SilenceCandidate[] = []
      let cursor = 300
      while (cursor < 4600) {
        silences.push({ startMs: cursor, endMs: cursor + 350, kind: 'silence', durationMs: 350 })
        cursor += 350 + 300
      }
      const report: DetectReport = {
        version: 1,
        input: fixturePath,
        durationMs: 5084,
        preset: 'noisy',
        thresholdDb: -20,
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'en',
        transcript: { path: null, wordLevel: false, words: 0 },
        audioPath: null,
        silences,
        review: [],
        warnings: [],
      }
      await Bun.write(detectPath, JSON.stringify(report))

      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        masterPath,
        '--campaign',
        'avmismatch-test',
        '--edl',
        edlPath,
        '--fps',
        '60',
        '--edge-fade',
        '0',
      ])
    })

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    test('writes a source durationMs bounded by the video stream, not the longer audio tail', async () => {
      const edl = JSON.parse(await Bun.file(edlPath).text()) as Edl
      // The fixture's audio runs to 5084ms; its video stream ends at 5000ms (300 frames @ 60fps).
      expect(edl.sources[0]?.durationMs).toBeLessThanOrEqual(5000)
      expect(edl.sources[0]?.durationMs).toBeGreaterThan(4900)
    })

    test('never asks a segment to trim past the video stream', async () => {
      const edl = JSON.parse(await Bun.file(edlPath).text()) as Edl
      // Fixed against the fixture's true video duration, not edl.sources[0].durationMs: that
      // field is what the bug got wrong, so asserting a segment stays under it would pass even
      // on the buggy build.
      for (const segment of edl.segments) {
        expect(segment.outMs).toBeLessThanOrEqual(5000)
      }
    })

    test('renders clean: frame count and duration land inside the validator tolerance', async () => {
      const edl = JSON.parse(await Bun.file(edlPath).text()) as Edl
      const renderedPath = join(dir, 'rendered.mp4')
      const args = buildFfmpegArgs(edl, renderedPath)
      const rendered = await run('ffmpeg', ['-v', 'error', ...args])
      expect(rendered.exitCode).toBe(0)

      const probed = await run('ffprobe', [
        '-v',
        'error',
        '-count_frames',
        '-show_entries',
        'format=duration:stream=codec_type,width,height,pix_fmt,color_range,color_space,color_transfer,color_primaries,r_frame_rate,nb_read_frames,sample_rate,channels',
        '-of',
        'json',
        renderedPath,
      ])
      expect(probed.exitCode).toBe(0)
      const probe = JSON.parse(probed.stdout)
      // color_transfer/color_primaries come back absent on this fixture's 320x240 testsrc2
      // encode, a libx264 tagging quirk at that resolution unrelated to issue #14 (a real
      // 1056x720 source carries all four fields). Filtered out so this test stays about the
      // frame count and duration checks it exists to prove.
      const errors = outputErrors(edl, probe).filter((error) => !error.includes('color metadata'))
      expect(errors).toEqual([])
    })
  },
)

// Issue #27: joins --report needs the JSON build report, which --human does not print to
// stdout. --report-json writes it to a file regardless of stdout mode, so a caller reading
// the human summary still gets a report joins can read without a second edl build run.
describe.if(hasFfmpeg)('edl build --report-json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-report-json-'))
  const mediaPath = join(dir, 'source.mp4')

  beforeAll(async () => {
    const built = await run('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=6:size=320x240:rate=10',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=stereo',
      '-t',
      '6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      mediaPath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(`fixture generation failed: ${built.stderr}`)
    }
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const detectReport = (): DetectReport => ({
    version: 1,
    input: mediaPath,
    durationMs: 6000,
    preset: 'noisy',
    thresholdDb: -20,
    minSilenceMs: 300,
    marginMs: 100,
    lang: 'es',
    transcript: { path: null, wordLevel: false, words: 0 },
    audioPath: null,
    silences: [{ kind: 'silence', startMs: 1000, endMs: 1500, durationMs: 500 }],
    review: [],
    warnings: [],
  })

  const proposals = [
    { startMs: 3000, endMs: 3800, kind: 'tangent' as const, reason: 'test aside, cut it' },
  ]

  test('writes the full report to disk while --human keeps printing the human summary', async () => {
    const detectPath = join(dir, 'detect-human.json')
    writeFileSync(detectPath, JSON.stringify(detectReport()))
    const semanticPath = join(dir, 'proposals-human.json')
    writeFileSync(semanticPath, JSON.stringify(proposals))
    const edlPath = join(dir, 'edl-human.json')
    const reportPath = join(dir, 'report-human.json')

    const originalLog = console.log
    let stdout = ''
    console.log = (...args: unknown[]) => {
      stdout += args.join(' ')
    }
    try {
      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        join(dir, 'master-human.mp4'),
        '--campaign',
        'report-json-test',
        '--edl',
        edlPath,
        '--semantic',
        semanticPath,
        '--report-json',
        reportPath,
        '--human',
      ])
    } finally {
      console.log = originalLog
    }

    // --human's own contract: a human summary on stdout, not JSON.
    expect(stdout).toContain('segments drafted')
    expect(() => JSON.parse(stdout)).toThrow()

    // The file --report-json named carries the full report regardless.
    expect(existsSync(reportPath)).toBe(true)
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      semanticCuts: Array<{ removedText: string; driftSuspect?: true }>
    }
    expect(report.semanticCuts.length).toBe(1)
    expect(report.semanticCuts[0]?.removedText).toBeDefined()
  })

  test('the report matches the summary emitted on stdout in --json mode', async () => {
    const detectPath = join(dir, 'detect-json.json')
    writeFileSync(detectPath, JSON.stringify(detectReport()))
    const semanticPath = join(dir, 'proposals-json.json')
    writeFileSync(semanticPath, JSON.stringify(proposals))
    const edlPath = join(dir, 'edl-json.json')
    const reportPath = join(dir, 'report-json.json')

    const originalLog = console.log
    let stdout = ''
    console.log = (...args: unknown[]) => {
      stdout += args.join(' ')
    }
    try {
      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        join(dir, 'master-json.mp4'),
        '--campaign',
        'report-json-test',
        '--edl',
        edlPath,
        '--semantic',
        semanticPath,
        '--report-json',
        reportPath,
        '--json',
      ])
    } finally {
      console.log = originalLog
    }

    const stdoutSummary = JSON.parse(stdout) as Record<string, unknown>
    const fileReport = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>

    // The file is the same report the CLI already prints, minus the stdout-only fields
    // (next/vcutVersion) that emitJson adds on top of the summary.
    const { next: _next, vcutVersion: _v, ...stdoutRest } = stdoutSummary
    expect(fileReport).toEqual(stdoutRest)
  })

  test('composes with --semantic omitted: an empty semanticCuts array still lands on disk', async () => {
    const detectPath = join(dir, 'detect-empty.json')
    writeFileSync(detectPath, JSON.stringify(detectReport()))
    const edlPath = join(dir, 'edl-empty.json')
    const reportPath = join(dir, 'report-empty.json')

    await buildEdlCommand([
      '--detect',
      detectPath,
      '--output',
      join(dir, 'master-empty.mp4'),
      '--campaign',
      'report-json-test',
      '--edl',
      edlPath,
      '--report-json',
      reportPath,
      '--json',
    ])

    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { semanticCuts: unknown[] }
    expect(report.semanticCuts).toEqual([])
  })

  test('omitting --report-json writes no file and leaves stdout unchanged', async () => {
    const detectPath = join(dir, 'detect-noreport.json')
    writeFileSync(detectPath, JSON.stringify(detectReport()))
    const edlPath = join(dir, 'edl-noreport.json')

    const originalLog = console.log
    let stdout = ''
    console.log = (...args: unknown[]) => {
      stdout += args.join(' ')
    }
    try {
      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        join(dir, 'master-noreport.mp4'),
        '--campaign',
        'report-json-test',
        '--edl',
        edlPath,
        '--json',
      ])
    } finally {
      console.log = originalLog
    }

    const summary = JSON.parse(stdout) as { status: string }
    expect(summary.status).toBe('drafted')
  })
})
