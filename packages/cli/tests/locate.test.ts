import { describe, expect, test } from 'bun:test'
import {
  checkAgainstRender,
  masterToSource,
  type Placement,
  placements,
  sourceToMaster,
} from '../src/locate.ts'
import type { Edl } from '../src/render-edl.ts'

const edlWith = (spans: Array<[number, number]>): Edl =>
  ({
    timebase: 'milliseconds',
    sources: [],
    segments: spans.map(([inMs, outMs], index) => ({
      id: `segment-${String(index + 1).padStart(3, '0')}`,
      sourceId: 'source-a',
      inMs,
      outMs,
      reason: 'approved-line',
      handlesMs: { before: 100, after: 100 },
      approval: 'proposed',
      semanticRisk: 'material',
      crop: null,
    })),
    audio: { externalAudioSourceId: null, syncOffsetMs: 0, edgeFadeMs: 50 },
    output: {},
    approval: { status: 'draft', approvedAt: null, approvedBy: null },
  }) as unknown as Edl

// Three kept spans with gaps between them: 1s, 2s and 1s of surviving material,
// so the master runs 0-4s while the source it came from spans 0-20s.
const sample = edlWith([
  [1000, 2000],
  [10000, 12000],
  [19000, 20000],
])

describe('placements', () => {
  test('lays segments end to end in master time', () => {
    const map = placements(sample)
    expect(map).toHaveLength(3)
    expect(map[0]).toMatchObject({ masterInMs: 0, masterOutMs: 1000 })
    expect(map[1]).toMatchObject({ masterInMs: 1000, masterOutMs: 3000 })
    expect(map[2]).toMatchObject({ masterInMs: 3000, masterOutMs: 4000 })
  })

  test('keeps the source span of each segment alongside its master span', () => {
    expect(placements(sample)[1]).toMatchObject({ sourceInMs: 10000, sourceOutMs: 12000 })
  })
})

describe('masterToSource', () => {
  // The whole reason the command exists: a master position lands in a segment whose
  // source is far from it, and no amount of checking the total would reveal that.
  test('translates a position into the source span it came from', () => {
    const hit = masterToSource(placements(sample), 2000)
    expect(hit?.sourceMs).toBe(11000)
    expect(hit?.placement.id).toBe('segment-002')
    expect(hit?.offsetIntoSegmentMs).toBe(1000)
  })

  test('a position in the first segment is not shifted', () => {
    expect(masterToSource(placements(sample), 500)?.sourceMs).toBe(1500)
  })

  test('the boundary belongs to the segment that starts there', () => {
    expect(masterToSource(placements(sample), 1000)?.placement.id).toBe('segment-002')
  })

  test('a position past the end of the master has no answer', () => {
    expect(masterToSource(placements(sample), 4000)).toBeNull()
  })
})

describe('sourceToMaster', () => {
  test('translates a surviving source position into master time', () => {
    // 1500ms into segment-002, which itself starts at master 1000.
    expect(sourceToMaster(placements(sample), 11500)?.masterMs).toBe(2500)
  })

  test('round trips against masterToSource', () => {
    const map = placements(sample)
    const forward = masterToSource(map, 2500)
    expect(forward?.sourceMs).toBe(11500)
    expect(sourceToMaster(map, forward?.sourceMs as number)?.masterMs).toBe(2500)
  })

  // Asking about removed material is a normal question with a real answer, not an error.
  test('reports nothing for a source position that was cut', () => {
    expect(sourceToMaster(placements(sample), 5000)).toBeNull()
  })
})

describe('checkAgainstRender', () => {
  // This is the trap the issue documents: the accumulated total agrees with the file
  // to the millisecond, and that agreement says nothing about where any one position
  // came from. The check reports the total honestly and claims nothing more.
  test('agrees when the map total matches the rendered duration', () => {
    const check = checkAgainstRender(placements(sample), 4000)
    expect(check.agrees).toBe(true)
    expect(check.deltaMs).toBe(0)
  })

  test('reports the gap when the file runs longer than the map', () => {
    const check = checkAgainstRender(placements(sample), 4540)
    expect(check.agrees).toBe(false)
    expect(check.deltaMs).toBe(540)
    expect(check.expectedMs).toBe(4000)
  })

  test('an empty map has nothing to disagree with', () => {
    expect(checkAgainstRender([] as Placement[], 0).expectedMs).toBe(0)
  })
})

// Every other command in this tool speaks milliseconds, so passing them to a flag that takes
// seconds is the natural mistake — and the answer was indistinguishable from a real one. A run
// asked about nine positions in milliseconds, got `removed: true` for all nine, and read that
// as nine spans it had successfully cut.
describe('a position past the end of the source', () => {
  const map = [
    { id: 'segment-001', sourceId: 'source-1', sourceInMs: 0, sourceOutMs: 5_000, masterInMs: 0, masterOutMs: 5_000 },
  ]

  test('is not the same answer as a position that was cut', () => {
    const inside = sourceToMaster(map, 2_000)
    const cut = sourceToMaster(map, 4_999)
    expect(inside).not.toBeNull()
    expect(cut).not.toBeNull()
    // 61192 seconds against a five second source: the guard belongs above this call, since the
    // map itself cannot tell "removed" from "never existed".
    expect(sourceToMaster(map, 61_192_000)).toBeNull()
  })
})
