/**
 * Recover the cut list a human edit implies, by aligning its word stream against the source's.
 *
 * An approved master is the only ground truth this pipeline ever gets about edit quality. It
 * does not arrive as an EDL: it arrives as a rendered file somebody listened to and said yes
 * to. What the human removed is recorded nowhere except in the difference between the two word
 * streams — the source's, and the edit's. So it is recovered rather than read: transcribe the
 * reference word-level, align its tokens against the source transcript's, and every run of
 * source tokens the alignment cannot match is a span the human took out.
 *
 * The alignment itself is a longest-matching-subsequence opcodes walk, the same shape Python's
 * `difflib.SequenceMatcher.get_opcodes` produces, implemented here rather than depended on:
 * the whole method was proven by hand against `difflib` on a real 11.7-minute run (issue #39),
 * and vcut takes no dependency to reproduce ~40 lines of it. `equal` runs are what both takes
 * of the recording agree on; `delete` and `replace` runs on the source side are where the
 * reference stops agreeing, which is exactly where a cut was made.
 *
 * Everything in this module is pure: word streams in, spans out. No media, no transcriber, no
 * filesystem. That is what makes the recovery testable without a Whisper model in the room —
 * the one part of `compare` that can be wrong in a way no fixture would reveal.
 */

import type { Word } from './detect.ts'

/**
 * Tolerances measured on the hand run this command generalises (issue #39, testing-10m.mp4,
 * a 9:11.5 approved reference against an 11.7-minute source). Constants rather than flags:
 * each is a property of how two independent transcriptions of the same speech differ, not a
 * preference a caller has an opinion about, and inventing a knob per number is how a report
 * becomes untunable in practice because nobody knows which of five dials moved the answer.
 *
 * MERGE_GAP_MS: two recovered deletions separated by less than this are one cut. A human cut
 * does not land on a token boundary, so a single removal frequently comes back as two adjacent
 * deletions with one survivor word wedged between them that both takes happened to transcribe
 * the same way.
 *
 * MIN_SPAN_MS: a recovered span shorter than this is not reported. Below a second, the
 * difference between the two streams is transcription noise (a dropped "y", a "de" that became
 * "que") far more often than it is an edit anyone made on purpose.
 */
export const MERGE_GAP_MS = 800
export const MIN_SPAN_MS = 1000

/**
 * Diacritic-folded, punctuation-stripped, lowercased: the token form both streams are compared
 * in. Two independent transcriptions of the same audio disagree on accents and punctuation
 * routinely ("informacion" vs "información", "si," vs "si"), and every one of those
 * disagreements would otherwise read as an edit the human made. NFD decomposition splits a
 * letter from its combining mark so the mark can be dropped without a per-accent table.
 *
 * A token that folds to nothing (a cue carrying only punctuation) returns the empty string;
 * callers drop those rather than aligning on them.
 */
export const foldToken = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')

/** A word with its folded comparison form, carrying its own source timing. */
export type AlignToken = {
  token: string
  startMs: number
  endMs: number
  text: string
}

/**
 * Word cues to comparable tokens, dropping anything that folds away to nothing.
 *
 * The timings ride along untouched: the whole point of the alignment is to turn "these source
 * tokens have no counterpart in the reference" into "this span of source milliseconds is
 * missing", and that translation is only possible because each token still knows where it came
 * from.
 */
export const toTokens = (words: Word[]): AlignToken[] => {
  const tokens: AlignToken[] = []
  for (const word of words) {
    const token = foldToken(word.text)
    if (token === '') {
      continue
    }
    tokens.push({ token, startMs: word.startMs, endMs: word.endMs, text: word.text.trim() })
  }
  return tokens
}

// --- Sequence alignment ---------------------------------------------------------------------

export type OpcodeTag = 'equal' | 'delete' | 'insert' | 'replace'

export type Opcode = {
  tag: OpcodeTag
  aStart: number
  aEnd: number
  bStart: number
  bEnd: number
}

type Match = { aStart: number; bStart: number; size: number }

/**
 * The longest run of tokens common to `a[aLo:aHi]` and `b[bLo:bHi]`, ties broken toward the
 * earliest position in both — the same rule `difflib.SequenceMatcher.find_longest_match`
 * follows, and the reason two alignments of the same pair of streams are reproducible rather
 * than merely plausible.
 *
 * Implemented as the rolling-row dynamic program difflib itself uses: `run` maps "a match
 * ending at this index in b" to its length, rebuilt per row of `a`, so the whole search costs
 * one pass over the b-index buckets of each a-token rather than a full O(n*m) matrix. `bIndex`
 * is built once by the caller and reused across every recursion, which is what keeps this
 * usable on the ~2,000-token streams a 10-minute recording produces.
 */
const findLongestMatch = (
  a: string[],
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  bIndex: Map<string, number[]>,
): Match => {
  let bestA = aLo
  let bestB = bLo
  let bestSize = 0
  let run = new Map<number, number>()

  for (let i = aLo; i < aHi; i += 1) {
    const next = new Map<number, number>()
    for (const j of bIndex.get(a[i]) ?? []) {
      if (j < bLo) {
        continue
      }
      if (j >= bHi) {
        break
      }
      const size = (run.get(j - 1) ?? 0) + 1
      next.set(j, size)
      if (size > bestSize) {
        bestSize = size
        bestA = i - size + 1
        bestB = j - size + 1
      }
    }
    run = next
  }
  return { aStart: bestA, bStart: bestB, size: bestSize }
}

/**
 * Every matching block between the two streams, in order — `get_matching_blocks` without the
 * sentinel difflib appends.
 *
 * Recursion rather than iteration over a matrix: find the longest match, then recurse into
 * whatever sits before it and whatever sits after it. Written with an explicit stack so a
 * long recording cannot blow the call stack on a stream that alternates match/no-match
 * thousands of times.
 */
export const matchingBlocks = (a: string[], b: string[]): Match[] => {
  const bIndex = new Map<string, number[]>()
  for (const [index, token] of b.entries()) {
    const bucket = bIndex.get(token)
    if (bucket === undefined) {
      bIndex.set(token, [index])
    } else {
      bucket.push(index)
    }
  }

  const blocks: Match[] = []
  const queue: Array<[number, number, number, number]> = [[0, a.length, 0, b.length]]
  while (queue.length > 0) {
    const region = queue.pop()
    if (region === undefined) {
      break
    }
    const [aLo, aHi, bLo, bHi] = region
    if (aLo >= aHi || bLo >= bHi) {
      continue
    }
    const match = findLongestMatch(a, aLo, aHi, bLo, bHi, bIndex)
    if (match.size === 0) {
      continue
    }
    blocks.push(match)
    queue.push([aLo, match.aStart, bLo, match.bStart])
    queue.push([match.aStart + match.size, aHi, match.bStart + match.size, bHi])
  }
  blocks.sort((left, right) => left.aStart - right.aStart || left.bStart - right.bStart)
  return blocks
}

/**
 * The opcodes walk: matching blocks turned into the equal/delete/insert/replace runs that
 * describe how to get from `a` to `b`.
 *
 * Same contract as `difflib.SequenceMatcher.get_opcodes`: the tags cover both sequences
 * completely and in order, so summing the source-side ranges of every non-equal opcode
 * accounts for every source token the reference does not carry. `delete` is source tokens with
 * no counterpart at all (a clean cut); `replace` is source tokens the reference swapped for
 * different ones, which on two transcriptions of the same speech is usually a cut whose
 * boundary landed mid-phrase plus the transcriber hearing the survivors differently.
 */
export const opcodes = (a: string[], b: string[]): Opcode[] => {
  const result: Opcode[] = []
  let aCursor = 0
  let bCursor = 0
  for (const block of matchingBlocks(a, b)) {
    const aGap = block.aStart > aCursor
    const bGap = block.bStart > bCursor
    if (aGap && bGap) {
      result.push({
        tag: 'replace',
        aStart: aCursor,
        aEnd: block.aStart,
        bStart: bCursor,
        bEnd: block.bStart,
      })
    } else if (aGap) {
      result.push({
        tag: 'delete',
        aStart: aCursor,
        aEnd: block.aStart,
        bStart: bCursor,
        bEnd: bCursor,
      })
    } else if (bGap) {
      result.push({
        tag: 'insert',
        aStart: aCursor,
        aEnd: aCursor,
        bStart: bCursor,
        bEnd: block.bStart,
      })
    }
    result.push({
      tag: 'equal',
      aStart: block.aStart,
      aEnd: block.aStart + block.size,
      bStart: block.bStart,
      bEnd: block.bStart + block.size,
    })
    aCursor = block.aStart + block.size
    bCursor = block.bStart + block.size
  }
  const aTail = aCursor < a.length
  const bTail = bCursor < b.length
  if (aTail && bTail) {
    result.push({
      tag: 'replace',
      aStart: aCursor,
      aEnd: a.length,
      bStart: bCursor,
      bEnd: b.length,
    })
  } else if (aTail) {
    result.push({ tag: 'delete', aStart: aCursor, aEnd: a.length, bStart: bCursor, bEnd: bCursor })
  } else if (bTail) {
    result.push({ tag: 'insert', aStart: aCursor, aEnd: aCursor, bStart: bCursor, bEnd: b.length })
  }
  return result
}

// --- Recovery -------------------------------------------------------------------------------

/** A span of source time the reference does not carry, with the words it removed. */
export type RecoveredSpan = {
  startMs: number
  endMs: number
  durationMs: number
  removedText: string
  wordCount: number
}

const spanFrom = (tokens: AlignToken[], from: number, to: number): RecoveredSpan | null => {
  const slice = tokens.slice(from, to)
  if (slice.length === 0) {
    return null
  }
  const startMs = slice[0].startMs
  const endMs = slice[slice.length - 1].endMs
  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
    removedText: slice.map((entry) => entry.text).join(' '),
    wordCount: slice.length,
  }
}

/**
 * Two recovered spans separated by less than `gapMs` are one cut.
 *
 * A human's cut lands where the sentence turns, not where a token ends, so one removal
 * routinely comes back as two deletions with a survivor word between them — a "y" or a "que"
 * that both takes transcribed identically and the alignment therefore matched, splitting a
 * single 6-second cut into 3.1s and 2.6s halves. Merging on measured proximity is what makes
 * the recovered list read as the cuts a human would describe rather than as alignment debris.
 *
 * The merged span's `removedText` is joined with a middle dot so a reader can see the join
 * happened rather than reading two removals as one continuous quote that was never spoken that
 * way.
 */
export const mergeAdjacent = (spans: RecoveredSpan[], gapMs = MERGE_GAP_MS): RecoveredSpan[] => {
  if (spans.length === 0) {
    return []
  }
  const ordered = [...spans].sort((left, right) => left.startMs - right.startMs)
  const merged: RecoveredSpan[] = [{ ...ordered[0] }]
  for (const span of ordered.slice(1)) {
    const previous = merged[merged.length - 1]
    if (span.startMs - previous.endMs < gapMs) {
      previous.endMs = Math.max(previous.endMs, span.endMs)
      previous.durationMs = previous.endMs - previous.startMs
      previous.removedText = `${previous.removedText} · ${span.removedText}`.trim()
      previous.wordCount += span.wordCount
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

export type RecoverOptions = {
  mergeGapMs?: number
  minSpanMs?: number
}

/**
 * The implicit cut list: every span of the source the reference does not carry.
 *
 * `source` is the source recording's own word stream; `reference` is the approved edit's. Both
 * are folded to tokens, aligned, and every non-equal opcode's source-side range becomes a
 * candidate span with the words it removed. Adjacent candidates are merged, then anything under
 * `minSpanMs` is dropped as transcription noise rather than reported as an edit.
 *
 * `insert` opcodes are ignored on purpose: tokens present in the reference and absent from the
 * source are the transcriber hearing the edit's audio differently, never material a human
 * added — an edit removes, it does not record new speech.
 */
export const recoverCuts = (
  source: Word[],
  reference: Word[],
  options: RecoverOptions = {},
): RecoveredSpan[] => {
  const sourceTokens = toTokens(source)
  const referenceTokens = toTokens(reference)
  if (sourceTokens.length === 0) {
    return []
  }
  // A reference that transcribed to nothing means the whole source is "missing", which is a
  // broken transcription rather than a human edit that removed everything. Reporting one span
  // covering the entire recording would be technically true and useless.
  if (referenceTokens.length === 0) {
    return []
  }
  const candidates: RecoveredSpan[] = []
  for (const opcode of opcodes(
    sourceTokens.map((entry) => entry.token),
    referenceTokens.map((entry) => entry.token),
  )) {
    if (opcode.tag === 'equal' || opcode.tag === 'insert') {
      continue
    }
    const span = spanFrom(sourceTokens, opcode.aStart, opcode.aEnd)
    if (span !== null) {
      candidates.push(span)
    }
  }
  const minSpanMs = options.minSpanMs ?? MIN_SPAN_MS
  return mergeAdjacent(candidates, options.mergeGapMs ?? MERGE_GAP_MS).filter(
    (span) => span.durationMs >= minSpanMs,
  )
}

// --- Span comparison --------------------------------------------------------------------------

export type Span = { startMs: number; endMs: number }

/** How much of `span` any of `others` covers, 0 to 1. */
export const coverage = (span: Span, others: Span[]): number => {
  const width = span.endMs - span.startMs
  if (width <= 0) {
    return 0
  }
  // Overlaps are unioned before they are summed: two EDL cuts that both reach into the same
  // recovered span would otherwise double-count and report more than full coverage.
  const overlaps = others
    .map((other) => ({
      startMs: Math.max(span.startMs, other.startMs),
      endMs: Math.min(span.endMs, other.endMs),
    }))
    .filter((overlap) => overlap.endMs > overlap.startMs)
    .sort((left, right) => left.startMs - right.startMs)
  let covered = 0
  let cursor = -1
  for (const overlap of overlaps) {
    const start = Math.max(overlap.startMs, cursor)
    if (overlap.endMs > start) {
      covered += overlap.endMs - start
      cursor = overlap.endMs
    }
  }
  return covered / width
}
