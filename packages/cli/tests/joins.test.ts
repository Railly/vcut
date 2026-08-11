import { describe, expect, test } from 'bun:test'
import { classifyReading, deriveJoins } from '../src/joins.ts'
import type { Edl } from '../src/render-edl.ts'

const segment = (id: string, inMs: number, outMs: number) => ({
  id,
  sourceId: 'source-a',
  inMs,
  outMs,
  reason: 'approved-line',
  handlesMs: { before: 100, after: 100 },
  approval: 'proposed' as const,
  semanticRisk: 'none' as const,
  crop: null,
})

describe('deriveJoins', () => {
  // A semantic cut removes 2000-5000ms of source. The next segment (segment-002) opens at
  // 5000ms, which becomes master 2000ms once segment-001's own 0-2000 span is laid down first.
  test('derives the join at the segment that opens right after a semantic cut', () => {
    const segments = [segment('segment-001', 0, 2000), segment('segment-002', 5000, 8000)]
    const joins = deriveJoins(segments as Edl['segments'], [{ startMs: 2000, endMs: 5000 }])
    expect(joins).toHaveLength(1)
    expect(joins[0]).toMatchObject({
      segmentId: 'segment-002',
      joinMasterMs: 2000,
      cutStartMs: 2000,
      cutEndMs: 5000,
    })
  })

  // boundariesAfterSpeech's own rule: the first segment opens the file rather than following a
  // cut, so a semantic cut at the very start (nothing survives before it) produces no join.
  test('a semantic cut that opens the file has no join', () => {
    const segments = [segment('segment-001', 3000, 6000)]
    const joins = deriveJoins(segments as Edl['segments'], [{ startMs: 0, endMs: 3000 }])
    expect(joins).toHaveLength(0)
  })

  test('multiple semantic cuts each produce their own join', () => {
    const segments = [
      segment('segment-001', 0, 1000),
      segment('segment-002', 2000, 3000),
      segment('segment-003', 4000, 5000),
    ]
    const joins = deriveJoins(segments as Edl['segments'], [
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4000 },
    ])
    expect(joins).toHaveLength(2)
    expect(joins.map((join) => join.segmentId)).toEqual(['segment-002', 'segment-003'])
    // segment-002 master span is 1000-2000 (after segment-001's 0-1000), so its join lands
    // at master 1000; segment-003 follows at master 2000-3000, join at master 2000.
    expect(joins[0]?.joinMasterMs).toBe(1000)
    expect(joins[1]?.joinMasterMs).toBe(2000)
  })

  // A silence cut, not a semantic one, in the same gap: boundariesAfterSpeech only fires on
  // the *kind* of cut, so a gap with no semantic cut touching it produces no join.
  test('a gap with no semantic cut touching it produces no join', () => {
    const segments = [segment('segment-001', 0, 1000), segment('segment-002', 1500, 2500)]
    const joins = deriveJoins(segments as Edl['segments'], [{ startMs: 5000, endMs: 6000 }])
    expect(joins).toHaveLength(0)
  })

  test('no semantic cuts means no joins', () => {
    const segments = [segment('segment-001', 0, 1000), segment('segment-002', 2000, 3000)]
    expect(deriveJoins(segments as Edl['segments'], [])).toHaveLength(0)
  })
})

describe('classifyReading', () => {
  // The case joins exists to catch: the window's carrying words are mostly the same ones
  // removedText claims were cut, meaning the tail of the removed speech survived the join.
  test('a window that mostly repeats removedText reads as removed-text-leaked', () => {
    const removed = 'perdón otra vez rebobinando completamente diferente'
    const window = 'perdón otra vez rebobinando algo'
    expect(classifyReading(window, removed)).toBe('removed-text-leaked')
  })

  // The window carries real words that connect across the join rather than repeating what
  // was cut.
  test('a window whose carrying words differ from removedText reads as lands', () => {
    const removed = 'perdón otra vez rebobinando completamente diferente'
    const window = 'va a ser mucho mejor porque el mundo cambió'
    expect(classifyReading(window, removed)).toBe('lands')
  })

  test('no removedText and real words in the window reads as lands', () => {
    expect(classifyReading('va a ser mucho mejor', null)).toBe('lands')
  })

  // Honest limits: an empty or too-short window carries nothing to judge, so it says so
  // rather than guessing either verdict.
  test('an empty window reads as check-by-ear', () => {
    expect(classifyReading('', 'perdón otra vez rebobinando')).toBe('check-by-ear')
  })

  test('a window with only short grammar words reads as check-by-ear', () => {
    expect(classifyReading('y de la', 'perdón otra vez rebobinando')).toBe('check-by-ear')
  })

  test('empty removedText with real window words reads as lands', () => {
    expect(classifyReading('va a ser mucho mejor', '')).toBe('lands')
  })

  // A partial, minority overlap: the window carries mostly new words with one incidental
  // repeat, which is not the leaked-tail pattern.
  test('a minority overlap with removedText still reads as lands', () => {
    const removed = 'perdón otra vez rebobinando completamente diferente'
    const window = 'lo que decía es que el mundo cambió otra vez'
    expect(classifyReading(window, removed)).toBe('lands')
  })
})
