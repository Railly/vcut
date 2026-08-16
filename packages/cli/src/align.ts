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
 * MIN_SPAN_MS: a recovered span shorter than this is not reported *unless something outside the
 * text inference corroborates it*. Below a second, the difference between the two streams is
 * transcription noise (a dropped "y", a "de" that became "que") far more often than it is an
 * edit anyone made on purpose. That reasoning holds only where the reference offers a competing
 * account of the same speech, which is exactly a `replace` opcode; it does not hold for a
 * `delete`, where the reference carries nothing at all, nor for a span measured silent on the
 * audio. Applying it to those was the second half of issue #60: on the Cueva pair the threshold
 * discarded 15.3s of real removals, and every short span it dropped there was a word the
 * reference carries fewer of, or none of, rather than a word it merely spells differently.
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

/**
 * A span of source time the reference does not carry, with the words it removed.
 *
 * `corroborated` records whether anything beyond a contested text inference supports the span:
 * the reference carrying nothing at all in its place (a `delete` opcode), or the audio measuring
 * silent there. It is what lets `MIN_SPAN_MS` suppress transcription noise without also
 * suppressing the short removals a human really made, and it is deliberately not part of the
 * reported shape's meaning beyond that: a caller reads `startMs`/`removedText`, not this.
 */
export type RecoveredSpan = {
  startMs: number
  endMs: number
  durationMs: number
  removedText: string
  wordCount: number
  corroborated: boolean
}

const spanFrom = (
  tokens: AlignToken[],
  from: number,
  to: number,
  corroborated: boolean,
): RecoveredSpan | null => {
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
    corroborated,
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
 *
 * Corroboration unions across a merge: a span any part of which is measured silent, or which the
 * reference answers with nothing, is corroborated as a whole. The alternative would let a
 * contested fragment merged onto a measured one relitigate ground the audio already settled.
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
      previous.corroborated = previous.corroborated || span.corroborated
      continue
    }
    merged.push({ ...span })
  }
  return merged
}

export type RecoverOptions = {
  mergeGapMs?: number
  minSpanMs?: number
  sourceSilences?: Span[]
}

/**
 * Silence the reference itself carries between consecutive words, measured on its own word
 * stream rather than on its audio.
 *
 * A source pause is only a cut if the reference does not keep a pause there too, and the
 * reference's word stream already answers that: the same transcriber, on the same speech,
 * reports where it stopped hearing words. Measuring it here rather than with a second ffmpeg
 * pass keeps the recovery pure and costs nothing, and the quantity wanted is "did the human
 * leave a pause", which is a statement about the edit's structure, not about its noise floor.
 *
 * Measured on both approved masters this command was built against: the Cueva reference keeps
 * 2.2s of inter-word gap across 263.4s, the issue #39 hand run 4.0s across 551.5s. A human
 * editing for delivery removes nearly every pause, which is why source silence maps to a cut
 * so reliably that seeding on it is safe.
 */
export const referencePauseMs = (reference: Word[]): number => {
  const ordered = [...reference].sort((left, right) => left.startMs - right.startMs)
  let total = 0
  let cursor = 0
  for (const word of ordered) {
    if (cursor > 0 && word.startMs > cursor) {
      total += word.startMs - cursor
    }
    cursor = Math.max(cursor, word.endMs)
  }
  return total
}

/**
 * The implicit cut list: every span of the source the reference does not carry.
 *
 * `source` is the source recording's own word stream; `reference` is the approved edit's. Both
 * are folded to tokens, aligned, and every non-equal opcode's source-side range becomes a
 * candidate span with the words it removed. Adjacent candidates are merged, then anything under
 * `minSpanMs` that nothing corroborates is dropped as transcription noise rather than reported
 * as an edit.
 *
 * The corroboration carve-out is the second half of issue #60. `minSpanMs` exists because two
 * transcriptions of the same speech disagree in fragments, but that is an argument about spans
 * where the reference offers a rival account of the same audio: a `replace`, where "cra"+"fter"
 * met "crafter". A `delete` is not that. There the reference says nothing at all, which is what
 * a removal looks like, and on the Cueva pair every short `delete` the threshold discarded was a
 * word the reference carries fewer of ("ChatGPT", 11 in the source against 6) or none of
 * ("hackeé", 1 against 0). Measured silence is likewise a fact about the audio that no cue
 * boundary or token count can outvote. So the threshold now guards only the case it was
 * reasoned about, and 15.3s of real removals stop being invisible.
 *
 * `insert` opcodes are ignored on purpose: tokens present in the reference and absent from the
 * source are the transcriber hearing the edit's audio differently, never material a human
 * added — an edit removes, it does not record new speech.
 *
 * `sourceSilences` closes the blind spot the text walk cannot see (issue #60). A recovered span
 * can only begin and end on a source token, so silence is invisible to the walk in two ways at
 * once. The obvious one is a stretch of source with no words in it, which no opcode ever claims.
 * The one that actually dominated the measured error is subtler: Whisper emits gapless cues, so
 * a source word's cue absorbs the pause that follows it. Measured on the Cueva pair, the same
 * speech carries an average cue of 547ms in the source against 302ms in the reference, and the
 * alignment matched the words almost perfectly (857 surviving source tokens against 861
 * reference words) while still overstating what the reference kept by 261.2s. That surplus is
 * entirely pause hiding inside cues the walk reads as kept speech.
 *
 * So a measured silence is taken as removed wherever it lands, including inside a surviving
 * word's cue: silencedetect reports where the audio is quiet, which no cue boundary can
 * contradict, and a cue that spans quiet audio is padding rather than speech. Seeds go through
 * the same `mergeAdjacent` pass as every other candidate, so a region both mechanisms find is
 * one span rather than two, and they carry corroboration through it: a measured span is reported
 * at whatever width it has, because `minSpanMs` is a statement about contested text and a
 * silence seed is not contested.
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
    const span = spanFrom(sourceTokens, opcode.aStart, opcode.aEnd, opcode.tag === 'delete')
    if (span !== null) {
      candidates.push(span)
    }
  }

  for (const silence of options.sourceSilences ?? []) {
    if (silence.endMs > silence.startMs) {
      candidates.push({
        startMs: silence.startMs,
        endMs: silence.endMs,
        durationMs: silence.endMs - silence.startMs,
        removedText: '',
        wordCount: 0,
        corroborated: true,
      })
    }
  }

  const minSpanMs = options.minSpanMs ?? MIN_SPAN_MS
  return mergeAdjacent(candidates, options.mergeGapMs ?? MERGE_GAP_MS).filter(
    (span) => span.corroborated || span.durationMs >= minSpanMs,
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
