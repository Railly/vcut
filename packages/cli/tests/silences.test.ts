import { describe, expect, test } from 'bun:test'
import { parseSilenceLog } from '../src/detect.ts'
import { type Block, toBlocks } from '../src/silences.ts'

describe('toBlocks', () => {
  test('fills speech between silences and covers the whole range', () => {
    const silences = [
      { kind: 'silence' as const, startMs: 327_300, endMs: 328_070, durationMs: 770 },
      { kind: 'silence' as const, startMs: 328_630, endMs: 328_740, durationMs: 110 },
    ]
    const blocks = toBlocks(silences, 327_300, 329_680)
    expect(blocks).toEqual([
      { kind: 'silence', startMs: 327_300, endMs: 328_070, durationMs: 770 },
      { kind: 'speech', startMs: 328_070, endMs: 328_630, durationMs: 560 },
      { kind: 'silence', startMs: 328_630, endMs: 328_740, durationMs: 110 },
      { kind: 'speech', startMs: 328_740, endMs: 329_680, durationMs: 940 },
    ] satisfies Block[])
  })

  test('a range with no silence is a single speech block', () => {
    expect(toBlocks([], 1000, 5000)).toEqual([
      { kind: 'speech', startMs: 1000, endMs: 5000, durationMs: 4000 },
    ])
  })

  test('a range that is entirely one silence has no speech block', () => {
    const silences = [{ kind: 'silence' as const, startMs: 0, endMs: 5000, durationMs: 5000 }]
    expect(toBlocks(silences, 0, 5000)).toEqual([
      { kind: 'silence', startMs: 0, endMs: 5000, durationMs: 5000 },
    ])
  })

  test('clamps a silence that runs past the requested range', () => {
    const silences = [{ kind: 'silence' as const, startMs: 4000, endMs: 8000, durationMs: 4000 }]
    const blocks = toBlocks(silences, 0, 5000)
    expect(blocks).toEqual([
      { kind: 'speech', startMs: 0, endMs: 4000, durationMs: 4000 },
      { kind: 'silence', startMs: 4000, endMs: 5000, durationMs: 1000 },
    ])
  })

  test('clamps a silence that starts before the requested range', () => {
    const silences = [{ kind: 'silence' as const, startMs: 0, endMs: 3000, durationMs: 3000 }]
    const blocks = toBlocks(silences, 2000, 6000)
    expect(blocks).toEqual([
      { kind: 'silence', startMs: 2000, endMs: 3000, durationMs: 1000 },
      { kind: 'speech', startMs: 3000, endMs: 6000, durationMs: 3000 },
    ])
  })

  test('drops a silence entirely outside the range', () => {
    const silences = [{ kind: 'silence' as const, startMs: 100, endMs: 200, durationMs: 100 }]
    expect(toBlocks(silences, 1000, 2000)).toEqual([
      { kind: 'speech', startMs: 1000, endMs: 2000, durationMs: 1000 },
    ])
  })

  test('sorts unordered silences before filling gaps', () => {
    const silences = [
      { kind: 'silence' as const, startMs: 5000, endMs: 5500, durationMs: 500 },
      { kind: 'silence' as const, startMs: 1000, endMs: 1500, durationMs: 500 },
    ]
    const blocks = toBlocks(silences, 0, 6000)
    expect(blocks.map((b) => b.startMs)).toEqual([0, 1000, 1500, 5000, 5500])
  })
})

// The offset arithmetic silencesCommand does after -ss seeks the demuxer: silencedetect only
// sees the requested range, so its timestamps are relative to the seek and need rangeStartMs
// added back before they mean anything against the whole file. This exercises the same
// parser silencesCommand calls, at the resolution the dangling-tail bug in design-notes.md
// describes: a range whose end lands mid-silence never gets a silence_end line at all.
describe('offset math for a sub-range (what silencesCommand does with parseSilenceLog)', () => {
  test('a dangling silence at the end of the requested range closes at the range duration', () => {
    const rangeStartMs = 327_300
    const rangeDurationMs = 330_500 - 327_300
    const log = `
[silencedetect @ 0x1] silence_start: 0.77
[silencedetect @ 0x1] silence_end: 1.33 | silence_duration: 0.56
[silencedetect @ 0x1] silence_start: 2.44
`
    const relative = parseSilenceLog(log, rangeDurationMs)
    expect(relative).toHaveLength(2)
    // The dangling start (2.44s into the range) closes at the range's own duration, not the
    // source file's, because the seek already discarded everything past it.
    expect(relative[1]).toEqual({
      kind: 'silence',
      startMs: 2440,
      endMs: rangeDurationMs,
      durationMs: rangeDurationMs - 2440,
    })
    const absolute = relative.map((silence) => ({
      ...silence,
      startMs: silence.startMs + rangeStartMs,
      endMs: silence.endMs + rangeStartMs,
    }))
    expect(absolute[0]).toEqual({
      kind: 'silence',
      startMs: 327_300 + 770,
      endMs: 327_300 + 1330,
      durationMs: 560,
    })
  })

  test('absolute ms lands correctly for a range that does not start at zero', () => {
    const rangeStartMs = 60_000
    const log = `
[silencedetect @ 0x1] silence_start: 1.5
[silencedetect @ 0x1] silence_end: 2.0 | silence_duration: 0.5
`
    const relative = parseSilenceLog(log, 10_000)
    const absolute = relative.map((silence) => ({
      ...silence,
      startMs: silence.startMs + rangeStartMs,
      endMs: silence.endMs + rangeStartMs,
    }))
    expect(absolute[0]).toEqual({
      kind: 'silence',
      startMs: 61_500,
      endMs: 62_000,
      durationMs: 500,
    })
  })
})
