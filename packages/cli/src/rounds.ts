/**
 * `vcut rounds <media> [--diff N M]` — a session's own history of what got built, and what
 * changed between two of those builds.
 *
 * This diffs the build reports `commit` already writes into `rounds/round-N/report.json`
 * (`BuildSummary`, `build-edl.ts`): `removalPercent` delta, segment count delta, and
 * `semanticCuts` matched between rounds by span overlap so an added/removed/changed proposal
 * reads as one line rather than two unrelated lists a caller has to align by eye.
 *
 * Text-level diffing — "what changed in the words the render actually says" — needs a
 * transcript of each round's render, and vcut does not store those: `rounds/round-N/` holds
 * the EDL and the build report only, never the render or a transcript of it (B2-Q2: renders
 * are cheap to regenerate and expensive to store, so the session stays disposable cache
 * throughout). This is a diff of what the build asked for, not of what a render said back —
 * `vcut peek`/`say --transcribe` on the actual renders is the honest way to answer that, and
 * the CLI help says so rather than implying this covers it.
 */

import type { SemanticCutReport } from './build-edl.ts'
import { type Placement, placements } from './locate.ts'
import type { Edl } from './render-edl.ts'
import type { MetaSpeechSpan } from './semantic.ts'

export type RoundReport = {
  removalPercent: number
  segments: number
  semanticCuts: SemanticCutReport[]
}

export type SemanticCutDiffEntry =
  | { status: 'added'; to: SemanticCutReport }
  | { status: 'removed'; from: SemanticCutReport }
  | { status: 'unchanged'; from: SemanticCutReport; to: SemanticCutReport }
  | { status: 'changed'; from: SemanticCutReport; to: SemanticCutReport }

export type RoundsDiff = {
  fromRound: number
  toRound: number
  removalPercentDelta: number
  segmentCountDelta: number
  semanticCuts: SemanticCutDiffEntry[]
}

/** Whether two spans overlap at all — the matching rule for pairing one round's semantic cut
 * with the next round's, since a proposal's exact edges can shift slightly between rounds
 * (a neighbouring cut absorbed it, or it re-clamped) while still being recognisably "the same
 * cut". No overlap at all means a real add or remove, not a shifted match. */
const spansOverlap = (
  left: { startMs: number; endMs: number },
  right: { startMs: number; endMs: number },
): boolean => left.startMs < right.endMs && right.startMs < left.endMs

/**
 * Pairs each `from` cut with the `to` cut whose span it overlaps (first match, in order —
 * two proposals landing on the same overlapping span in one round is not a shape this build
 * pipeline produces, since proposals that overlap merge into one span before this report is
 * built). Unpaired `from` entries are `removed`; unpaired `to` entries are `added`. A paired
 * entry is `unchanged` when kind, reason, and removedText all still match, `changed` otherwise
 * — the span moving slightly on its own is not itself a change worth flagging, since that is
 * expected merge behaviour, not a different decision.
 */
export const diffSemanticCuts = (
  from: SemanticCutReport[],
  to: SemanticCutReport[],
): SemanticCutDiffEntry[] => {
  const toRemaining = [...to]
  const entries: SemanticCutDiffEntry[] = []

  for (const fromCut of from) {
    const matchIndex = toRemaining.findIndex((toCut) => spansOverlap(fromCut, toCut))
    if (matchIndex === -1) {
      entries.push({ status: 'removed', from: fromCut })
      continue
    }
    const toCut = toRemaining[matchIndex]
    toRemaining.splice(matchIndex, 1)
    const same =
      fromCut.kind === toCut.kind &&
      fromCut.reason === toCut.reason &&
      fromCut.removedText === toCut.removedText
    entries.push({ status: same ? 'unchanged' : 'changed', from: fromCut, to: toCut })
  }
  for (const toCut of toRemaining) {
    entries.push({ status: 'added', to: toCut })
  }
  return entries
}

export const diffRounds = (
  fromRound: number,
  fromReport: RoundReport,
  toRound: number,
  toReport: RoundReport,
): RoundsDiff => ({
  fromRound,
  toRound,
  removalPercentDelta: Number((toReport.removalPercent - fromReport.removalPercent).toFixed(2)),
  segmentCountDelta: toReport.segments - fromReport.segments,
  semanticCuts: diffSemanticCuts(fromReport.semanticCuts, toReport.semanticCuts),
})

// --- metaSpeech, addressed vs standing (#38) --------------------------------------------------
//
// `metaSpeech` (semantic.ts) already excludes any span landing inside a cut this EDL made — that
// is its own containment check (`isInsideACut`), run fresh against each round's own gaps. So a
// span present in round N's recorded output and absent from round N+1's is, by construction, one
// round N+1 cut: nothing else removes a line from that field. Comparing the two recorded arrays
// by identity is the whole diff; there is no separate "was this cut" question to ask.
//
// Identity is text + startMs + endMs together, not startMs/endMs alone: `metaSpeech` names spans
// off transcript lines rebuilt fresh each round from the same silences and words, so an unrelated
// span landing on the same millisecond pair after an upstream change is not the same finding
// wearing new timings, and text is what a human reads to tell the two apart.
const metaSpeechKey = (span: MetaSpeechSpan): string => `${span.startMs}:${span.endMs}:${span.text}`

export type MetaSpeechDiffEntry =
  | { status: 'addressed'; from: MetaSpeechSpan }
  | { status: 'standing'; from: MetaSpeechSpan }
  | { status: 'new'; to: MetaSpeechSpan }

/**
 * `from`/`to` are round N and round N+1's own recorded `metaspeech.json`, or `null` when a round
 * predates #38 or had no transcript to check that round — a diff against `null` cannot say
 * anything about addressed/standing, since there is no prior finding list to compare against, so
 * it returns `null` itself rather than a misleadingly empty array.
 */
export const diffMetaSpeech = (
  from: MetaSpeechSpan[] | null,
  to: MetaSpeechSpan[] | null,
): MetaSpeechDiffEntry[] | null => {
  if (from === null || to === null) {
    return null
  }
  const toKeys = new Set(to.map(metaSpeechKey))
  const fromKeys = new Set(from.map(metaSpeechKey))
  const entries: MetaSpeechDiffEntry[] = from.map((span) =>
    toKeys.has(metaSpeechKey(span))
      ? { status: 'standing', from: span }
      : { status: 'addressed', from: span },
  )
  for (const span of to) {
    if (!fromKeys.has(metaSpeechKey(span))) {
      entries.push({ status: 'new', to: span })
    }
  }
  return entries
}

// --- Delta verification (#46) ------------------------------------------------------------------
//
// The retro's structural finding: a naive "what moved in master time" diff between two rounds
// marks every segment after the first cut as changed, since a cut anywhere shifts every later
// segment's master position. That defeats the point of a delta at all: fourteen rounds in, a
// re-sweep of the whole render is exactly the cost this exists to avoid.
//
// The fix is to diff by segment identity, not by master position, but `build-edl.ts`'s own
// `segment.id` is not that identity. It is assigned by array index (`segment-${index + 1}`,
// build-edl.ts), so removing one segment renumbers every id after it even though the audio those
// later segments carry never changed. Verified against the real 14-round session this issue
// names (bfd7c6fac64c2968): round 11 to round 12 removed one short segment, and every id after it
// shifted down by one, so the segment id round 11 called segment-073 is round 12's segment-071
// with the exact same sourceId/inMs/outMs. Comparing by id alone would have read all 22 shifted
// segments as content changes, which is precisely the false positive this issue exists to kill.
//
// The real, stable identity is the source-time span itself: sourceId + inMs + outMs. Two
// segments with the same signature in both rounds are the same audio, full stop, regardless of
// what id or master position either round assigned it. A boundary re-clamp changes inMs or outMs
// by definition, so it produces a signature that simply does not exist in `from`, the same
// detection that catches brand-new material, with no separate positional pass needed. A segment
// whose exact signature survives unchanged is `slid` even if every id and master timestamp
// around it moved: it is still exactly the material verified last round.
//
// "Immediate neighbour" is the segment adjacent in `to`'s own sequence, not a duration window: a
// join is a boundary between two specific segments, and the segment on either side of that
// boundary is exactly where a duplication or a clipped word from two source spans meeting shows
// up (the same reasoning `joins.ts` already uses for semantic-cut joins, applied here to every
// join a round created, not only the semantic ones). A window in seconds would need a threshold
// nothing in this repo hands us; "the segment next in sequence" needs none.

export type DeltaSpan = {
  segmentId: string
  masterInMs: number
  masterOutMs: number
  reason: 'content-changed' | 'neighbour-of-new-join'
}

type Segment = Edl['segments'][number]

/** The real, stable identity of a kept segment: what source audio it plays, not the id or
 * position a particular round's build happened to assign it. */
const contentKey = (segment: Segment): string =>
  `${segment.sourceId}:${segment.inMs}:${segment.outMs}`

/**
 * `to` indices whose content signature does not exist anywhere in `from`: material that is new
 * (never rendered before) or whose boundary moved (a re-clamp changes inMs/outMs, which is by
 * construction a signature `from` never carried). Both need the same thing, a fresh listen, so
 * they share one reason rather than a distinction a caller would have to treat identically anyway.
 */
const contentChangedIndices = (from: Segment[], to: Segment[]): Set<number> => {
  const fromKeys = new Set(from.map(contentKey))
  const indices = new Set<number>()
  to.forEach((segment, index) => {
    if (!fromKeys.has(contentKey(segment))) {
      indices.add(index)
    }
  })
  return indices
}

/**
 * `to` indices of two surviving signatures that a removal made newly adjacent: they border each
 * other in `to` now, but at least one segment sat between them in `from` that does not survive
 * into `to`. Neither survivor's own signature changed, so `contentChangedIndices` never flags
 * them, yet the join between them is new and exactly where a duplication or clipped word from
 * the two clips now meeting would show up.
 *
 * Walks `from` in its own order, tracking the most recent surviving signature seen and whether
 * anything non-surviving came directly after it before the next survivor. Two survivors that
 * were already each other's immediate neighbour in `from` (nothing removed between them) and
 * remain adjacent in `to` are not a new join, even though everything after them slid in master
 * time, which is the whole case this issue exists to exclude.
 */
const closedGapIndices = (from: Segment[], to: Segment[]): Set<number> => {
  const toIndexByKey = new Map(to.map((segment, index) => [contentKey(segment), index]))

  const indices = new Set<number>()
  let previousSurvivorKey: string | null = null
  let sawRemovalSincePreviousSurvivor = false

  for (const segment of from) {
    const key = contentKey(segment)
    const toIndex = toIndexByKey.get(key)
    if (toIndex === undefined) {
      sawRemovalSincePreviousSurvivor = true
      continue
    }
    if (previousSurvivorKey !== null && sawRemovalSincePreviousSurvivor) {
      const previousToIndex = toIndexByKey.get(previousSurvivorKey)
      if (previousToIndex !== undefined && toIndex - previousToIndex === 1) {
        indices.add(previousToIndex)
        indices.add(toIndex)
      }
    }
    previousSurvivorKey = key
    sawRemovalSincePreviousSurvivor = false
  }
  return indices
}

/**
 * The master-time spans a downstream agent needs to re-verify after `to` was committed, given
 * what `from` (the last verified round) already cleared: every segment whose content signature
 * is new to this round, plus the segment immediately before and after each one in `to`'s own
 * sequence (that is where a join sits, and a join is where a duplicated phrase or a clipped word
 * appears), plus any pair of otherwise-unchanged survivors a removal made newly adjacent.
 *
 * Ordering follows `to`'s own segment sequence (master order), and a segment already flagged for
 * its own content change is not duplicated when it also happens to neighbour another one, so the
 * result names each master-time span once.
 */
export const deltaSpans = (from: Segment[], to: Segment[]): DeltaSpan[] => {
  const changedIndices = contentChangedIndices(from, to)

  const neighbourIndices = new Set(closedGapIndices(from, to))
  changedIndices.forEach((index) => {
    if (index - 1 >= 0 && !changedIndices.has(index - 1)) {
      neighbourIndices.add(index - 1)
    }
    if (index + 1 < to.length && !changedIndices.has(index + 1)) {
      neighbourIndices.add(index + 1)
    }
  })

  const map: Placement[] = placements({ segments: to } as Edl)

  const spans: DeltaSpan[] = []
  to.forEach((segment, index) => {
    const placement = map[index]
    if (placement === undefined) {
      return
    }
    const reason: DeltaSpan['reason'] | null = changedIndices.has(index)
      ? 'content-changed'
      : neighbourIndices.has(index)
        ? 'neighbour-of-new-join'
        : null
    if (reason === null) {
      return
    }
    spans.push({
      segmentId: segment.id,
      masterInMs: placement.masterInMs,
      masterOutMs: placement.masterOutMs,
      reason,
    })
  })
  return spans
}

export type DeltaVerification = {
  fromRound: number
  toRound: number
  spans: DeltaSpan[]
  spanDurationMs: number
  totalDurationMs: number
  spanCount: number
  totalSegments: number
}

export const deltaVerification = (
  fromRound: number,
  fromSegments: Edl['segments'],
  toRound: number,
  toSegments: Edl['segments'],
): DeltaVerification => {
  const spans = deltaSpans(fromSegments, toSegments)
  const totalDurationMs = toSegments.reduce(
    (sum, segment) => sum + (segment.outMs - segment.inMs),
    0,
  )
  const spanDurationMs = spans.reduce((sum, span) => sum + (span.masterOutMs - span.masterInMs), 0)
  return {
    fromRound,
    toRound,
    spans,
    spanDurationMs,
    totalDurationMs,
    spanCount: spans.length,
    totalSegments: toSegments.length,
  }
}
