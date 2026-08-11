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
