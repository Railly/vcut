import { describe, expect, test } from 'bun:test'
import { deltaSpans, deltaVerification } from '../src/rounds.ts'

const segment = (id: string, sourceId: string, inMs: number, outMs: number) => ({
  id,
  sourceId,
  inMs,
  outMs,
  reason: 'approved-line',
  handlesMs: { before: 100, after: 100 },
  approval: 'proposed' as const,
  semanticRisk: 'none' as const,
  crop: null,
})

describe('deltaSpans', () => {
  test('a round with no changes flags nothing', () => {
    const round = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 2000),
      segment('segment-003', 'source-a', 2000, 3000),
    ]
    expect(deltaSpans(round, round)).toEqual([])
  })

  // The core case this issue exists for: removing segment-002 shifts segment-003's master
  // position from 2000-3000 to 1000-2000, but segment-003's own source span (2000-3000, still
  // unchanged) never moved. A naive "what moved in master time" diff would flag segment-003;
  // this must not, since segment-003's content is exactly what it was last round.
  test('a removal downstream does not flag a segment that only slid in master time', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 2000),
      segment('segment-003', 'source-a', 2000, 3000),
      segment('segment-004', 'source-a', 3000, 4000),
      segment('segment-005', 'source-a', 4000, 5000),
    ]
    const to = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-003', 'source-a', 2000, 3000),
      segment('segment-004', 'source-a', 3000, 4000),
      segment('segment-005', 'source-a', 4000, 5000),
    ]
    const spans = deltaSpans(from, to)
    // segment-002 is gone; its old neighbours (segment-001 and segment-003) meet at a new join,
    // so both are flagged as the neighbours of that join. segment-004 and segment-005 kept the
    // same neighbour they always had (segment-003 / segment-004 respectively) and moved only in
    // master time, so neither is flagged.
    const ids = spans.map((span) => span.segmentId).sort()
    expect(ids).toEqual(['segment-001', 'segment-003'])
    expect(spans.every((span) => span.reason === 'neighbour-of-new-join')).toBe(true)
  })

  test('a new segment is flagged content-changed, and both its neighbours are flagged', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 2000, 3000),
    ]
    const to = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-new', 'source-a', 1000, 2000),
      segment('segment-002', 'source-a', 2000, 3000),
    ]
    const spans = deltaSpans(from, to)
    const byId = new Map(spans.map((span) => [span.segmentId, span.reason]))
    expect(byId.get('segment-new')).toBe('content-changed')
    expect(byId.get('segment-001')).toBe('neighbour-of-new-join')
    expect(byId.get('segment-002')).toBe('neighbour-of-new-join')
    expect(spans).toHaveLength(3)
  })

  test('a boundary re-clamping is flagged content-changed, not slid', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 2670),
      segment('segment-003', 'source-a', 2670, 3670),
    ]
    const to = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 2620),
      segment('segment-003', 'source-a', 2670, 3670),
    ]
    const spans = deltaSpans(from, to)
    const byId = new Map(spans.map((span) => [span.segmentId, span.reason]))
    expect(byId.get('segment-002')).toBe('content-changed')
    expect(byId.get('segment-001')).toBe('neighbour-of-new-join')
    expect(byId.get('segment-003')).toBe('neighbour-of-new-join')
    expect(spans).toHaveLength(3)
  })

  test('two changed segments that are already adjacent do not double-count each other as neighbours', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 2000),
      segment('segment-003', 'source-a', 2000, 3000),
    ]
    const to = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 1900),
      segment('segment-003', 'source-a', 2100, 3000),
    ]
    const spans = deltaSpans(from, to)
    // segment-002 and segment-003 both content-changed directly, segment-001 is their only
    // outside neighbour. Every master-time span is named exactly once.
    expect(spans.map((span) => span.segmentId).sort()).toEqual([
      'segment-001',
      'segment-002',
      'segment-003',
    ])
    const ids = spans.map((span) => span.segmentId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a sourceId change is flagged content-changed', () => {
    const from = [segment('segment-001', 'source-a', 0, 1000)]
    const to = [segment('segment-001', 'source-b', 0, 1000)]
    const spans = deltaSpans(from, to)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.reason).toBe('content-changed')
  })

  // The trap this issue names directly: build-edl.ts assigns segment.id by array index
  // (segment-${index + 1}), so a removal renumbers every id after it even though the audio those
  // segments carry never changed. Verified against the real 14-round session (bfd7c6fac64c2968,
  // round 11 -> round 12): 22 segments got a new id purely from the renumbering, with identical
  // sourceId/inMs/outMs. Diffing by id alone would flag all 22 as content changes; this must not.
  test('a removal that renumbers every following id does not flag the renumbered survivors', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1000, 1200),
      segment('segment-003', 'source-a', 1200, 2200),
      segment('segment-004', 'source-a', 2200, 3200),
      segment('segment-005', 'source-a', 3200, 4200),
    ]
    // segment-002 removed; build-edl.ts would relabel segment-003/004/005 as
    // segment-002/003/004 respectively in the next round's build, even though their
    // sourceId/inMs/outMs never changed.
    const to = [
      segment('segment-001', 'source-a', 0, 1000),
      segment('segment-002', 'source-a', 1200, 2200),
      segment('segment-003', 'source-a', 2200, 3200),
      segment('segment-004', 'source-a', 3200, 4200),
    ]
    const spans = deltaSpans(from, to)
    // Only the pair the removal made newly adjacent (round-2's segment-001 and the renumbered
    // segment-002, whose content is round-1's segment-003) is flagged. The renumbered
    // segment-003/segment-004 (round-1's segment-004/segment-005) never changed content and
    // are not adjacent to the closed gap, so neither appears.
    const flaggedIds = spans.map((span) => span.segmentId).sort()
    expect(flaggedIds).toEqual(['segment-001', 'segment-002'])
    expect(spans.every((span) => span.reason === 'neighbour-of-new-join')).toBe(true)
  })
})

describe('deltaVerification', () => {
  test('reports span duration against total duration, proving the delta is smaller than the whole render', () => {
    const from = [
      segment('segment-001', 'source-a', 0, 60_000),
      segment('segment-002', 'source-a', 60_000, 61_000),
      segment('segment-003', 'source-a', 61_000, 121_000),
      segment('segment-004', 'source-a', 121_000, 181_000),
      segment('segment-005', 'source-a', 181_000, 241_000),
    ]
    const to = [
      segment('segment-001', 'source-a', 0, 60_000),
      segment('segment-003', 'source-a', 61_000, 121_000),
      segment('segment-004', 'source-a', 121_000, 181_000),
      segment('segment-005', 'source-a', 181_000, 241_000),
    ]
    const result = deltaVerification(1, from, 2, to)
    expect(result.totalSegments).toBe(4)
    // Only segment-001 and segment-003 are the newly adjacent pair the removal created;
    // segment-004 and segment-005 kept their existing neighbour and only slid in master time.
    expect(result.spanCount).toBe(2)
    expect(result.spanDurationMs).toBeLessThan(result.totalDurationMs)
  })

  test('an unchanged round between two commits reports zero spans', () => {
    const round = [segment('segment-001', 'source-a', 0, 1000)]
    const result = deltaVerification(3, round, 4, round)
    expect(result.spans).toEqual([])
    expect(result.spanCount).toBe(0)
    expect(result.spanDurationMs).toBe(0)
  })
})
