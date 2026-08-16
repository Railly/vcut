import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { containsPhrase } from './converge.ts'
import type { DetectReport, Interval, SilenceCandidate, Transcript, Word } from './detect.ts'
import { parseSrt, wordsContradictingSilence } from './detect.ts'
import { run } from './exec.ts'
import {
  bar,
  duration,
  emitJson,
  heading,
  line,
  type Mode,
  nextStep,
  resolveMode,
  UsageError,
} from './output.ts'
import type { Proposal } from './semantic.ts'
import { joinWords, readProposals } from './semantic.ts'

const HELP = `vcut edl build - turn a detect report into a draft edit decision list

Usage:
  vcut edl build --detect <path> --output <master path> --campaign <id> [flags]

Flags:
  --detect <path>       Report produced by detect.ts (required)
  --output <path>       Where the rendered master will go (required)
  --campaign <id>       Campaign identifier (required)
  --edl <path>          Where to write the EDL (default ./edl.json)
  --width <n>           Output width (default: source width)
  --height <n>          Output height (default: source height)
  --fps <n>             Output frame rate (default: source rate)
  --edge-fade <ms>      Audio ramp at each segment edge (default 50, 0 disables)
  --crop <spec>         top|bottom|left|right:<fraction>, or x,y,width,height
  --audio-offset <ms>   Shift the separate audio; positive delays it (default 0)
  --semantic <path>     Model proposals from 'vcut semantic'; each lands as material risk
  --report-json <path>  Write the full JSON build report to this path regardless of stdout
                         mode. Same shape 'vcut commit' writes as rounds/round-N/report.json,
                         the report 'vcut joins --report' reads for removedText/driftSuspect.
  --json                Force JSON (default when stdout is not a TTY)
  --human               Force the human summary
  --help                Show this message

Every segment is written as proposed and the EDL as draft. Nothing is approved here.

A source with no video stream builds a legal, video-less EDL: width/height/fps/videoCodec/
pixelFormat/colorSpace are omitted from output rather than fabricated, and --crop is refused
rather than silently ignored.

Also accepts --fields/--jq. See vcut --help for the full picture.`

export type BuildSummary = {
  status: 'drafted'
  edlPath: string
  segments: number
  cuts: number
  sourceDurationMs: number
  keptDurationMs: number
  removalPercent: number
  removalTargets: Record<string, string>
  wordBoundaryClamping: boolean
  semanticCuts: SemanticCutReport[]
  warnings: string[]
}

const TARGET_RANGES: Array<{ label: string; low: number; high: number }> = [
  { label: 'event or interview', low: 30, high: 45 },
  { label: 'tutorial or screencast', low: 15, high: 25 },
  { label: 'scripted talking head', low: 10, high: 20 },
]

export const matchTarget = (removalPercent: number): string => {
  const hits = TARGET_RANGES.filter(
    (range) => removalPercent >= range.low && removalPercent <= range.high,
  )
  // Missing every range says nothing about which side you missed it on, and the two mean
  // opposite things: too little removed is an untouched source, too much is an edit that
  // took the speaker's thinking out with the dead air.
  const ceiling = Math.max(...TARGET_RANGES.map((range) => range.high))
  if (hits.length === 0 && removalPercent > ceiling) {
    return `above every target range; check the cuts kept the speaker's meaning`
  }
  return hits.length === 0
    ? 'below every target range; the source may already be edited'
    : `in range for ${hits.map((range) => range.label).join(', ')}`
}

/** The field entry names semanticCuts directly rather than pointing at another command,
 * since the answer is already in this same payload. */
export const buildEdlNext = (edlPath: string) => [
  { question: 'hear the cut', verb: `vcut render --edl ${edlPath} --audio-only` },
  {
    question: 'what each semantic span removes',
    verb: 'already in this payload: read the semanticCuts field',
  },
]

export const humanSummary = (summary: BuildSummary): string => {
  const fraction = summary.removalPercent / 100
  const lines = [
    heading(`${summary.segments} segments drafted`),
    line(
      'removed',
      `${bar(fraction)}  ${summary.removalPercent.toFixed(1)}%  (${duration(summary.sourceDurationMs - summary.keptDurationMs)})`,
    ),
    line('kept', `${duration(summary.keptDurationMs)} of ${duration(summary.sourceDurationMs)}`),
    line('cuts applied', String(summary.cuts)),
    line('target check', matchTarget(summary.removalPercent)),
    line('word clamping', summary.wordBoundaryClamping ? 'on' : 'off (no word-level transcript)'),
    line('semantic cuts', String(summary.semanticCuts.length)),
    line('approval', 'draft, every segment proposed'),
  ]
  for (const cut of summary.semanticCuts) {
    const removedLabel =
      cut.driftSuspect === true ? 'removedText (driftSuspect, unverified)' : 'removedText'
    lines.push(
      line(
        `  ${(cut.startMs / 1000).toFixed(2)}-${(cut.endMs / 1000).toFixed(2)}s`,
        `${cut.kind}${cut.literal === true ? ' (literal)' : ''}: ${removedLabel} = "${cut.removedText || '(no transcript)'}"`,
      ),
    )
  }
  for (const warning of summary.warnings) {
    lines.push(line('warning', warning))
  }
  lines.push(nextStep(`vcut render --edl ${summary.edlPath} --mode preview --dry-run`))
  return lines.join('\n')
}

export type Crop = { x: number; y: number; width: number; height: number }

// Cropping after the cuts rather than before them is the whole point. A traditional editor
// makes you set the frame per clip, so remembering the menu bar at the end means redoing
// every segment by hand. The EDL keeps the crop beside the cut list, so the frame is one
// decision applied to all of them and changing it never touches a boundary.
//
// Accepts `top:0.05` and its three siblings, which is the shape of the real request: shave a
// strip off one edge. `x,y,width,height` stays available for an arbitrary window. Fractions,
// not pixels, so the same EDL survives a source at another resolution.
export const parseCrop = (spec: string): Crop => {
  const edges: Record<string, (amount: number) => Crop> = {
    top: (amount) => ({ x: 0, y: amount, width: 1, height: 1 - amount }),
    bottom: (amount) => ({ x: 0, y: 0, width: 1, height: 1 - amount }),
    left: (amount) => ({ x: amount, y: 0, width: 1 - amount, height: 1 }),
    right: (amount) => ({ x: 0, y: 0, width: 1 - amount, height: 1 }),
  }
  const edge = spec.split(':')
  const build = edges[edge[0]]
  if (build !== undefined) {
    const amount = Number(edge[1])
    if (!Number.isFinite(amount) || amount <= 0 || amount >= 1) {
      throw new UsageError(`--crop ${edge[0]} takes a fraction between 0 and 1, exclusive`)
    }
    return build(amount)
  }

  const parts = spec.split(',').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new UsageError(
      '--crop takes top|bottom|left|right:<fraction> or x,y,width,height as fractions',
    )
  }
  const [x, y, width, height] = parts
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new UsageError('--crop must stay inside the source: fractions from 0 to 1')
  }
  return { x, y, width, height }
}

export type Cut = Interval & {
  reason: 'silence' | 'semantic'
}

// A segment touching a model-proposed cut carries the risk of that proposal: approving it
// means agreeing that what was removed next to it was safe to remove. Marking the neighbours
// is what lets a reviewer find them without reading all 70.
//
// `proposals` (raw, unmerged) resolve against `merged` through `clampedSpanFor` before their
// edges are compared to segments — not the raw proposal edges directly. A proposal absorbs
// into a wider merged span whenever a silence cut or another proposal sits close enough
// (`absorbSlivers`/`mergeIntervals`, both already applied to `merged` by the caller), and a
// real span measured this way ran about 10s from a 9.4s proposal. Comparing against the raw
// 9.4s edges left the segments touching the absorbed 600ms tail reading `semanticRisk: 'none'`
// — exactly the segments a reviewer approving "what did the model choose to remove" needs
// flagged, since the render carries the full merged cut regardless of which raw proposal edge
// produced it. Deliberately not `cuts.filter(reason === 'semantic')` on the merged list: a
// merged interval reports `reason: 'silence'` the moment it absorbs even one differently-typed
// cut (`mergeIntervals`'s own rule), so filtering the merged list by reason would drop exactly
// the absorbed spans this fix exists to catch.
export const markSemanticRisk = (
  segments: KeptSegment[],
  proposals: Interval[],
  merged: Cut[],
  toleranceMs: number,
): KeptSegment[] => {
  if (proposals.length === 0) {
    return segments
  }
  const edges = proposals.flatMap((proposal) => {
    const span = clampedSpanFor(proposal, merged)
    return [span.startMs, span.endMs]
  })
  return segments.map((segment) => {
    const touches = edges.some(
      (edge) =>
        Math.abs(segment.inMs - edge) <= toleranceMs ||
        Math.abs(segment.outMs - edge) <= toleranceMs,
    )
    return touches ? { ...segment, semanticRisk: 'material' as const } : segment
  })
}

export type KeptSegment = {
  id: string
  sourceId: string
  inMs: number
  outMs: number
  reason: string
  handlesMs: { before: number; after: number }
  approval: 'proposed'
  semanticRisk: 'none' | 'low' | 'material'
  crop: Crop | null
}

const MAX_SEGMENTS = 999

export const mergeIntervals = (intervals: Cut[]): Cut[] => {
  const sorted = [...intervals].sort((left, right) => left.startMs - right.startMs)
  const merged: Cut[] = []

  for (const interval of sorted) {
    const last = merged[merged.length - 1]
    if (last !== undefined && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs)
      if (last.reason !== interval.reason) {
        last.reason = 'silence'
      }
      continue
    }
    merged.push({ ...interval })
  }
  return merged
}

export const wordBoundaries = (transcript: Transcript): Interval[] =>
  transcript.words.map((word) => ({ startMs: word.startMs, endMs: word.endMs }))

export const clampToWords = (cut: Cut, boundaries: Interval[], minCutMs: number): Cut | null => {
  let startMs = cut.startMs
  let endMs = cut.endMs

  for (const word of boundaries) {
    if (word.startMs < startMs && word.endMs > startMs) {
      startMs = word.endMs
    }
    if (word.startMs < endMs && word.endMs > endMs) {
      endMs = word.startMs
    }
  }

  // A word-level transcript stretches each cue to the start of the next word, so a
  // spoken word's range routinely swallows the pause that follows it. Silence measured
  // from audio energy is the better evidence. When clamping shreds a cut into a sliver
  // shorter than the detector's own minimum, that remainder is overlap residue rather
  // than a real pause: keep the measured span instead of dropping the cut.
  if (endMs - startMs < minCutMs) {
    return cut.endMs - cut.startMs >= minCutMs ? { ...cut } : null
  }
  return { ...cut, startMs, endMs }
}

// Frame boundaries are not whole milliseconds: at 60fps a frame is 16.666...ms, so
// rounding a frame boundary back to an integer millisecond always lands slightly off
// it. ffmpeg then rounds each trim to the nearest frame on its own, and with enough
// segments those per-segment roundings accumulate past the renderer's one-frame
// tolerance. Landing on the middle of the frame instead of its edge puts every
// boundary as far as possible from the point where ffmpeg's rounding could flip,
// so the same frame is chosen every time regardless of segment count.
export const snapToFrame = (milliseconds: number, fps: number): number => {
  if (fps <= 0) {
    return Math.round(milliseconds)
  }
  const frameMs = 1000 / fps
  const frame = Math.round(milliseconds / frameMs)
  return Math.round(frame * frameMs + frameMs / 2)
}

// Two cuts with a sliver of speech between them do not read as two cuts. The ear hears one
// broken passage: a fragment too short to carry a word, bracketed by silence on both sides.
// Merging the cuts across such a remainder turns three stutters into one clean cut.
//
// minKeepMs measures the remainder itself, before margins are added back. A remainder that
// survives becomes a segment margin longer on each side, so the caller passes what it
// considers the shortest defensible piece of speech rather than the shortest segment.
export const absorbSlivers = (cuts: Cut[], minKeepMs: number): Cut[] => {
  const merged: Cut[] = []

  for (const cut of cuts) {
    const last = merged[merged.length - 1]
    if (last !== undefined && cut.startMs - last.endMs < minKeepMs) {
      last.endMs = Math.max(last.endMs, cut.endMs)
      if (last.reason !== cut.reason) {
        last.reason = 'silence'
      }
      continue
    }
    merged.push({ ...cut })
  }
  return merged
}

/**
 * Segment starts that open right after speech was deliberately removed.
 *
 * This is where the tail of a cut span survives into the render: the boundary sits against
 * material that was meant to be gone, so whatever the renderer carries past the edge is
 * words rather than room tone. One session shipped a round where a removed phrase leaked
 * across such a join and reversed the meaning of the sentence it landed in. It took three
 * rounds to find, and everything needed to flag it was already present at build time.
 *
 * The condition is the *kind* of cut, not a distance. "Did the removed span contain words"
 * was the first attempt and it fired on 23 of 24 boundaries: with word clamping every
 * silence cut brushes the margin around a word, so the test marked everything and would
 * have trained a reader to skip it. The measured spread on that EDL was stark — the two
 * semantic cuts removed 7.27s and 5.83s while every silence cut removed 0.83s or less —
 * but reaching for a duration threshold there would be fitting a number to one recording.
 *
 * A semantic cut is the honest signal: it is the one the model asked for because the words
 * carried meaning, and it is the only kind that removes speech on purpose.
 */
export const boundariesAfterSpeech = (
  segments: Array<{ id?: string; inMs: number; outMs: number }>,
  speechCuts: Interval[],
  words: Interval[],
): Array<{ index: number; inMs: number; cutMs: number; wordsRemoved: number }> => {
  if (speechCuts.length === 0) {
    return []
  }
  const found: Array<{ index: number; inMs: number; cutMs: number; wordsRemoved: number }> = []
  for (const [index, segment] of segments.entries()) {
    // The first segment opens the file rather than following a cut.
    if (index === 0) {
      continue
    }
    const previous = segments[index - 1]
    if (previous === undefined) {
      continue
    }
    const gapStart = previous.outMs
    const gapEnd = segment.inMs
    if (gapEnd <= gapStart) {
      continue
    }
    const removed = speechCuts.some((cut) => cut.startMs < gapEnd && cut.endMs > gapStart)
    if (!removed) {
      continue
    }
    const wordsRemoved = words.filter(
      (word) => word.endMs > gapStart && word.startMs < gapEnd,
    ).length
    found.push({ index, inMs: segment.inMs, cutMs: gapEnd - gapStart, wordsRemoved })
  }
  return found
}

/**
 * A semantic proposal's cut span after it merges with whatever else lands in the same place.
 *
 * `mergeIntervals`/`absorbSlivers` fuse overlapping and adjacent cuts before `invertToSegments`
 * ever sees them, so the span a proposal actually removes can run wider than what the model
 * asked for — it absorbed a neighbouring silence cut, or another proposal it touched. Reporting
 * the raw proposal span as `removedText` would describe words the build never removes; this
 * finds the merged span that contains the proposal's start, which is what invertToSegments cuts
 * against.
 */
export const clampedSpanFor = (proposal: Interval, merged: Cut[]): Interval => {
  const hit = merged.find((cut) => proposal.startMs >= cut.startMs && proposal.startMs < cut.endMs)
  return hit ?? proposal
}

/** The transcript words that fall inside a span, joined as read. Empty string with no transcript. */
export const removedText = (span: Interval, words: Word[]): string =>
  words
    .filter((word) => word.endMs > span.startMs && word.startMs < span.endMs)
    .map((word) => word.text)
    .join(' ')
    .trim()

/** Whether each edge of a span lands inside a silence detect measured, rather than in speech. */
export const boundariesInSilence = (
  span: Interval,
  silences: SilenceCandidate[],
): [boolean, boolean] => {
  const inside = (ms: number) =>
    silences.some((silence) => ms >= silence.startMs && ms <= silence.endMs)
  return [inside(span.startMs), inside(span.endMs)]
}

/**
 * Whether a span's removedText is built from words the drift warning would flag: cues whose
 * claimed start lands inside a span `detect` measured as silence, so the transcript disagrees
 * with the audio about where speech actually begins.
 *
 * Reuses `detect.ts`'s own `wordsContradictingSilence` rather than a second implementation of
 * that comparison — the same reasoning behind `reasonMismatch` reusing `converge`'s carrying-word
 * check. Scoped to the words `removedText` itself draws from (the ones falling inside the span),
 * since a span's own drift is about the words it claims to remove, not the recording's word list
 * as a whole. On a recording with 326 drifted cues total, `removedText` cried wolf three times in
 * one run and each wolf cost a `say --transcribe` to refute; this is the corrective read at build
 * time instead of after a render.
 *
 * Deliberately not a re-transcription: the windowed-retranscription alternative the issue also
 * named answers a harder question (what the audio actually says) and `peek` already provides it
 * on demand. This answers a cheaper one — does the transcript's own claim about this span
 * contradict the same measurement the detect warning already trusted — off data already in hand.
 */
export const driftSuspectSpan = (
  span: Interval,
  words: Word[],
  silences: SilenceCandidate[],
): boolean => {
  const spanWords = words.filter((word) => word.endMs > span.startMs && word.startMs < span.endMs)
  return wordsContradictingSilence(spanWords, silences).length > 0
}

const REASON_MISMATCH_MIN_CARRYING_WORDS = 4
const REASON_MISMATCH_MAX_SHARED_FRACTION = 0.5

/**
 * A span whose removed text and stated reason talk about different things.
 *
 * The corrective this exists for: a repetition cut removed "todos estamos" instead of the
 * stutter "en nuestra propia" because measured blocks were mis-assigned to words, and the
 * mistake was invisible until a render and a windowed re-transcription caught it. `removedText`
 * makes the actual span legible; this warning is the check that reads it automatically instead
 * of relying on someone reading every span by hand.
 *
 * Reuses converge.ts's carrying-word comparison (words of 4+ letters, punctuation and case
 * stripped) rather than a literal substring match, for the same reason converge needs it: short
 * words are grammar and drift between transcriptions, and a reason paraphrases rather than
 * quoting.
 *
 * Fires only when removedText has enough carrying words to judge — a short span (a single
 * filler, a couple of words) does not carry enough signal to call disjoint, and firing there
 * would train a reader to skip the warning the way a duration-based check did for
 * boundariesAfterSpeech.
 */
export const reasonMismatch = (removed: string, reason: string): boolean => {
  const carryingWords = (text: string) =>
    text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length >= REASON_MISMATCH_MIN_CARRYING_WORDS)

  const removedCarrying = carryingWords(removed)
  if (removedCarrying.length < REASON_MISMATCH_MIN_CARRYING_WORDS) {
    return false
  }
  const shared = removedCarrying.filter((word) => containsPhrase(reason, word)).length
  return shared / removedCarrying.length < REASON_MISMATCH_MAX_SHARED_FRACTION
}

export type SemanticCutReport = {
  startMs: number
  endMs: number
  kind: Proposal['kind']
  reason: string
  removedText: string
  boundariesInSilence: [boolean, boolean]
  driftSuspect?: true
  literal?: true
}

/**
 * Per-proposal build report: what each accepted semantic span actually removes.
 *
 * A `literal` proposal (issue #40, `cut --literal`) skips `clampedSpanFor` and reports its own
 * raw span instead of the one it absorbs into once merged with a neighbouring silence cut or
 * another proposal. `removedText`, `boundariesInSilence`, and `driftSuspect` are still computed
 * — against that exact span — so the warning surface stays intact; a `literal` cut can still
 * come back `driftSuspect: true`, and that still means re-verify, not "the flag already
 * verified it". Every non-literal proposal is unaffected: this only changes which span a
 * literal proposal is read against, never the actual cut/kept boundaries `invertToSegments`
 * computes from `allCuts`.
 */
export const describeSemanticCuts = (
  proposals: Proposal[],
  merged: Cut[],
  words: Word[],
  silences: SilenceCandidate[],
): { cuts: SemanticCutReport[]; warnings: string[] } => {
  const cuts: SemanticCutReport[] = []
  const warnings: string[] = []

  for (const proposal of proposals) {
    const span = proposal.literal === true ? proposal : clampedSpanFor(proposal, merged)
    const text = removedText(span, words)
    const inSilence = boundariesInSilence(span, silences)
    const drifted = driftSuspectSpan(span, words, silences)
    const cut: SemanticCutReport = {
      startMs: span.startMs,
      endMs: span.endMs,
      kind: proposal.kind,
      reason: proposal.reason,
      removedText: text,
      boundariesInSilence: inSilence,
    }
    if (drifted) {
      cut.driftSuspect = true
    }
    if (proposal.literal === true) {
      cut.literal = true
    }
    cuts.push(cut)
    if (reasonMismatch(text, proposal.reason)) {
      warnings.push(
        `semantic cut ${(span.startMs / 1000).toFixed(2)}-${(span.endMs / 1000).toFixed(2)}s removes "${text}", which the reason does not mention ("${proposal.reason}"). Read removedText before rendering: a span can drift onto the wrong words when measured blocks are mis-assigned.`,
      )
    }
    if (drifted) {
      warnings.push(
        `semantic cut ${(span.startMs / 1000).toFixed(2)}-${(span.endMs / 1000).toFixed(2)}s removes "${text}", built from cues that claim a word starts inside measured silence. removedText is driftSuspect here: do not trust it without a check (vcut peek or say --transcribe over the span).`,
      )
    }
  }

  return { cuts, warnings }
}

export const invertToSegments = (
  cuts: Cut[],
  durationMs: number,
  sourceId: string,
  marginMs: number,
  fps = 0,
  minKeepMs = 300,
  crop: Crop | null = null,
): KeptSegment[] => {
  // The detector's own minimum: a stretch of audio it would not have called a pause is not
  // long enough to be a word either, so anything shorter is margin wearing a segment's shape.
  const merged = absorbSlivers(mergeIntervals(cuts), minKeepMs)
  const kept: Array<{ inMs: number; outMs: number; reason: string }> = []
  let cursor = 0

  for (const cut of merged) {
    if (cut.startMs > cursor) {
      kept.push({
        inMs: Math.max(0, cursor - (cursor === 0 ? 0 : marginMs)),
        outMs: Math.min(durationMs, cut.startMs + marginMs),
        reason: 'approved-line',
      })
    }
    cursor = cut.endMs
  }
  if (cursor < durationMs) {
    kept.push({
      inMs: Math.max(0, cursor - (cursor === 0 ? 0 : marginMs)),
      outMs: durationMs,
      reason: 'approved-line',
    })
  }

  return kept
    .map((segment) => ({
      ...segment,
      inMs: Math.max(0, snapToFrame(segment.inMs, fps)),
      outMs: Math.min(durationMs, snapToFrame(segment.outMs, fps)),
    }))
    .filter((segment) => segment.outMs > segment.inMs)
    .map((segment, index) => ({
      id: `segment-${String(index + 1).padStart(3, '0')}`,
      sourceId,
      inMs: segment.inMs,
      outMs: segment.outMs,
      reason: segment.reason,
      handlesMs: { before: marginMs, after: marginMs },
      approval: 'proposed' as const,
      semanticRisk: 'none' as const,
      crop,
    }))
}

const sha256 = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

type ProbeStream = {
  codec_type: 'video' | 'audio'
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  sample_rate?: string
  channels?: number
  duration?: string
}

// format.duration is the container's: the longest of its streams, audio included. A screen
// recording's audio device keeps running a beat after the capture stops drawing frames, so
// the container reports that longer audio tail as its own duration. A segment trimmed to
// that number asks ffmpeg's video trim filter for frames the stream does not have, and the
// filter clamps silently rather than erroring — the render comes out short, not the EDL.
const probeSource = async (
  path: string,
): Promise<{ streams: ProbeStream[]; durationMs: number; videoDurationMs: number }> => {
  const { stdout, stderr, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration:stream=codec_type,width,height,r_frame_rate,avg_frame_rate,sample_rate,channels,duration',
    '-of',
    'json',
    path,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffprobe exited with ${exitCode}`)
  }
  const parsed = JSON.parse(stdout) as { streams: ProbeStream[]; format: { duration: string } }
  const durationMs = Math.round(Number(parsed.format.duration) * 1000)
  const video = parsed.streams.find((stream) => stream.codec_type === 'video')
  // A container that omits stream-level duration (some do) still deserves a bound rather
  // than a thrown error here, so it falls back to the container figure it already had.
  const videoDurationMs =
    video?.duration === undefined ? durationMs : Math.round(Number(video.duration) * 1000)
  return { streams: parsed.streams, durationMs, videoDurationMs }
}

const slug = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-') || 'source'

type CliOptions = {
  detectPath: string
  outputPath: string
  edlPath: string
  campaignId: string
  width: number | null
  height: number | null
  fps: number | null
  edgeFadeMs: number
  semanticPath: string | null
  crop: Crop | null
  syncOffsetMs: number
  reportJsonPath: string | null
}

// What `runBuild` needs once the detect report is already in hand and proposals are already
// validated objects rather than a path on disk. `commit` (B-V3) builds from a session's
// accumulated proposals.json without ever writing them to a scratch file first, which is why
// this is `Proposal[]` and not `semanticPath: string | null` the way CliOptions still is for
// the CLI-facing parse step.
export type BuildOptions = {
  outputPath: string
  edlPath: string
  campaignId: string
  width: number | null
  height: number | null
  fps: number | null
  edgeFadeMs: number
  crop: Crop | null
  syncOffsetMs: number
}

// content-factory used 50ms per joint and Hunter approved masters cut with it, so this is
// a measured inheritance rather than a guess. --edge-fade 0 restores the hard cut.
const DEFAULT_EDGE_FADE_MS = 50

const parseCli = (args: string[]): CliOptions => {
  const value = (flag: string) => {
    const index = args.indexOf(flag)
    return index === -1 ? undefined : args[index + 1]
  }
  const detectPath = value('--detect')
  const outputPath = value('--output')
  const campaignId = value('--campaign')
  if (detectPath === undefined || outputPath === undefined || campaignId === undefined) {
    throw new UsageError(HELP)
  }
  const numeric = (flag: string) => (value(flag) === undefined ? null : Number(value(flag)))
  return {
    detectPath: resolve(detectPath),
    outputPath: resolve(outputPath),
    edlPath: resolve(value('--edl') ?? 'edl.json'),
    campaignId,
    width: numeric('--width'),
    height: numeric('--height'),
    fps: numeric('--fps'),
    edgeFadeMs: edgeFade(numeric('--edge-fade')),
    semanticPath: value('--semantic') === undefined ? null : resolve(value('--semantic') as string),
    crop: value('--crop') === undefined ? null : parseCrop(value('--crop') as string),
    syncOffsetMs: syncOffset(numeric('--audio-offset')),
    reportJsonPath:
      value('--report-json') === undefined ? null : resolve(value('--report-json') as string),
  }
}

// Two recordings started by the same app share a clock, so zero is the common case and the
// flag exists for the one where a second recorder did not.
const syncOffset = (requested: number | null): number => {
  if (requested === null) {
    return 0
  }
  if (!Number.isFinite(requested)) {
    throw new UsageError('--audio-offset takes a number of milliseconds')
  }
  return Math.round(requested)
}

// Rejected here rather than in the renderer: a bad value would otherwise reach the EDL as
// NaN and only surface as a broken filter graph one command later.
const edgeFade = (requested: number | null): number => {
  if (requested === null) {
    return DEFAULT_EDGE_FADE_MS
  }
  if (!Number.isFinite(requested) || requested < 0) {
    throw new UsageError('--edge-fade takes a non-negative number of milliseconds')
  }
  return requested
}

const assertSegmentCount = (count: number): void => {
  if (count === 0) {
    throw new Error('no segments survive; every span was marked as a cut')
  }
  if (count > MAX_SEGMENTS) {
    throw new Error(
      `${count} segments exceed the schema limit of ${MAX_SEGMENTS}; raise --min-silence to merge more spans`,
    )
  }
}

const captionPaths = (report: DetectReport) => {
  const path = report.transcript.path ?? report.input
  return {
    language: report.lang,
    rawTranscriptPath: path,
    timedTokensPath: path,
    correctedTranscriptPath: path,
    dictionaryPath: path,
    burnedDerivative: false,
  }
}

// A source the EDL will read audio from and nothing else. hasVideo false is what tells the
// renderer this one is not a picture, and the id is derived so two EDLs built from the same
// pair name it the same way.
const describeAudioSource = async (path: string, videoSourceId: string) => {
  const probe = await probeSource(path)
  const stream = probe.streams.find((entry) => entry.codec_type === 'audio')
  if (stream === undefined) {
    throw new UsageError(`no audio stream in ${path}`)
  }
  return {
    id: `${videoSourceId}-audio`,
    path,
    sha256: await sha256(path),
    durationMs: probe.durationMs,
    hasVideo: false,
    hasAudio: true,
    averageFrameRate: null,
    sampleRateHz: stream.sample_rate === undefined ? null : Number(stream.sample_rate),
    channels: stream.channels ?? null,
  }
}

const collectCuts = (report: DetectReport): Cut[] =>
  report.silences.map((silence) => ({
    startMs: silence.startMs,
    endMs: silence.endMs,
    reason: 'silence' as const,
  }))

// The callable seam `commit` (B-V3) uses: everything `buildEdlCommand` does once a detect
// report and a set of already-validated proposals are in hand, minus reading either off disk
// and minus printing. Pulled out with the same minimal-refactor discipline B-V1 applied to
// `detect.ts` — the CLI path below calls straight through it, so command behaviour and every
// existing test are unchanged; a pinned equivalence test in build-edl.test.ts is what proves
// `commit`'s build matches `vcut edl build --semantic <path>` run by hand on the same inputs.
export const runBuild = async (
  report: DetectReport,
  proposals: Proposal[],
  options: BuildOptions,
): Promise<{ edl: unknown; summary: BuildSummary }> => {
  if (!existsSync(report.input)) {
    throw new Error(`source missing: ${report.input}`)
  }

  const cuts = collectCuts(report)

  const transcript =
    report.transcript.path !== null && existsSync(report.transcript.path)
      ? parseSrt(readFileSync(report.transcript.path, 'utf8'))
      : { words: [], wordLevel: false }
  const boundaries = transcript.wordLevel ? wordBoundaries(transcript) : []
  const clamped =
    boundaries.length === 0
      ? cuts
      : cuts
          .map((cut) => clampToWords(cut, boundaries, report.minSilenceMs))
          .filter((cut): cut is Cut => cut !== null)

  const semanticProposals = proposals

  const probe = await probeSource(report.input)
  const video = probe.streams.find((stream) => stream.codec_type === 'video')
  const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
  // #42: a source with no video stream (a meeting-recorder mic track, a podcast export, an m4a
  // in an mp4 container) is legal on its own — nothing downstream of the cut list reads a
  // frame. The old hard error forced every audio-only source through a black-video shim just to
  // reach detect/build/render, and a real 19-minute run proved the shim was pure overhead: 8
  // committed rounds, 0 join suspects, 111/111 audit segments above 0.99 correlation, none of
  // it touching a pixel. `hasVideo` on the built source (below) is what the rest of the pipeline
  // branches on from here. A source with neither stream is the one case still refused: there is
  // nothing here to cut, silent video included, since a muted video source still has a video
  // stream to trim against.
  if (video === undefined && audio === undefined) {
    throw new Error('source has neither a video nor an audio stream')
  }

  // Frame boundaries only mean something when a picture will be trimmed to them: an audio-only
  // build has nothing to snap, so outputFps stays 0 and snapToFrame's own fps<=0 branch (plain
  // millisecond rounding) is what actually runs invertToSegments below.
  const frameRate = video?.r_frame_rate ?? '30/1'
  const [numerator, denominator] = frameRate.split('/').map(Number)
  const outputFps =
    video === undefined ? 0 : (options.fps ?? (denominator === 0 ? 30 : numerator / denominator))

  // Semantic spans skip clampToWords on purpose: the model chose those boundaries by
  // meaning, and snapping them to word edges would undo the judgement being reviewed.
  const semanticCuts: Cut[] = semanticProposals.map((proposal) => ({
    startMs: proposal.startMs,
    endMs: proposal.endMs,
    reason: 'semantic' as const,
  }))
  const allCuts = [...clamped, ...semanticCuts]

  // Same merge invertToSegments applies internally, run here so each proposal's report can
  // point at the span it actually ends up removing rather than the one it asked for.
  const mergedCuts = absorbSlivers(mergeIntervals(allCuts), report.minSilenceMs)
  const words = transcript.wordLevel ? joinWords(transcript) : []
  const { cuts: semanticCutReports, warnings: reasonWarnings } = describeSemanticCuts(
    semanticProposals,
    mergedCuts,
    words,
    report.silences,
  )

  const sourceId = slug(report.input.split('/').pop() ?? 'source')
  // The detect report already knows the separate recording, so the EDL is built from one
  // answer rather than asking for the path a second time and risking a different file.
  const externalAudio =
    report.audioPath === null || report.audioPath === undefined
      ? null
      : await describeAudioSource(report.audioPath, sourceId)
  // #42: crop frames a picture, so it has nothing to apply to on a video-less source. Refused
  // here rather than silently dropped — a caller who asked for a crop and got none back would
  // read that as the crop having failed rather than as the flag not applying to this source.
  if (video === undefined && options.crop !== null) {
    throw new UsageError(
      `--crop applies to a picture, and ${report.input} has no video stream to crop`,
    )
  }
  // Segments are bounded by whichever stream actually gets trimmed. With a picture, that is the
  // video stream's own duration, not the container's — the container reports the longest of its
  // streams, and a screen recording's audio device commonly outlives the last frame. Without a
  // picture, the audio stream is what gets trimmed, so its own duration is the bound instead.
  const sourceDurationMs = video === undefined ? probe.durationMs : probe.videoDurationMs
  const segments = markSemanticRisk(
    invertToSegments(
      allCuts,
      sourceDurationMs,
      sourceId,
      report.marginMs,
      outputFps,
      report.minSilenceMs,
      options.crop,
    ),
    semanticCuts,
    mergedCuts,
    report.marginMs + Math.ceil(1000 / (outputFps === 0 ? 30 : outputFps)),
  )
  assertSegmentCount(segments.length)

  const keptMs = segments.reduce((total, segment) => total + segment.outMs - segment.inMs, 0)
  const removalPercent = ((sourceDurationMs - keptMs) / sourceDurationMs) * 100

  const edl = {
    version: 1,
    campaignId: options.campaignId,
    createdAt: new Date().toISOString(),
    timebase: 'milliseconds',
    sources: [
      {
        id: sourceId,
        path: report.input,
        sha256: await sha256(report.input),
        // The renderer bounds every segment against this number: the stream that actually gets
        // trimmed, per the sourceDurationMs comment above.
        durationMs: sourceDurationMs,
        hasVideo: video !== undefined,
        hasAudio: audio !== undefined,
        averageFrameRate: video === undefined ? null : (video.avg_frame_rate ?? frameRate),
        sampleRateHz: audio?.sample_rate === undefined ? null : Number(audio.sample_rate),
        channels: audio?.channels ?? null,
      },
      ...(externalAudio === null ? [] : [externalAudio]),
    ],
    segments,
    audio: {
      speechTargetLufs: -16,
      truePeakMaxDbtp: -1,
      externalAudioSourceId: externalAudio === null ? null : externalAudio.id,
      syncOffsetMs: options.syncOffsetMs,
      edgeFadeMs: options.edgeFadeMs,
    },
    captions: captionPaths(report),
    output:
      video === undefined
        ? // #42: the V1 output contract (h264/yuv420p/bt709, width/height/fps) describes a
          // picture. A video-less source has none of those to report, so the output block
          // carries only what applies — the audio contract and the master path — and the
          // renderer's own edlErrors reads hasVideo across sources to skip the picture checks
          // rather than reading a fabricated width/height/fps that never gets encoded. Audio is
          // guaranteed present here: the only source with neither stream was already refused
          // above, so a video-less source always has the audio the block below requires.
          {
            path: options.outputPath,
            audioTrackPolicy: 'required' as const,
            overwrite: false,
          }
        : {
            path: options.outputPath,
            width: options.width ?? video.width ?? 1920,
            height: options.height ?? video.height ?? 1080,
            fps: outputFps,
            videoCodec: 'h264' as const,
            pixelFormat: 'yuv420p',
            colorSpace: 'bt709',
            // The question is whether the render will have sound, not whether the picture
            // carries it: a video recorded mute is exactly the case a separate recorder exists
            // for.
            audioTrackPolicy:
              audio === undefined && externalAudio === null
                ? ('explicit-silence' as const)
                : ('required' as const),
            overwrite: false,
          },
    approval: {
      status: 'draft',
      approvedAt: null,
      approvedBy: null,
    },
  }

  const summary: BuildSummary = {
    status: 'drafted',
    edlPath: options.edlPath,
    segments: segments.length,
    cuts: clamped.length,
    sourceDurationMs: probe.durationMs,
    keptDurationMs: keptMs,
    removalPercent: Number(removalPercent.toFixed(2)),
    removalTargets: {
      'event-interview': '30-45%',
      'tutorial-screencast': '15-25%',
      'scripted-talking-head': '10-20%',
    },
    wordBoundaryClamping: boundaries.length > 0,
    semanticCuts: semanticCutReports,
    warnings: [
      ...report.warnings,
      ...boundariesAfterSpeech(segments, semanticCuts, wordBoundaries(transcript)).map(
        (boundary) =>
          `${segments[boundary.index]?.id ?? `segment ${boundary.index + 1}`} opens right after a semantic cut of ${(boundary.cutMs / 1000).toFixed(2)}s${boundary.wordsRemoved === 0 ? '' : ` (${boundary.wordsRemoved} ${boundary.wordsRemoved === 1 ? 'word' : 'words'})`}. A tail of removed speech surviving that join reads as a real sentence, so check it once rendered: vcut say <render> --transcript <srt> --at <the master position from vcut locate>.`,
      ),
      ...reasonWarnings,
    ],
  }

  return { edl, summary }
}

export const buildEdlCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const options = parseCli(argv)
  if (!existsSync(options.detectPath)) {
    throw new Error(`detect report missing: ${options.detectPath}`)
  }
  const report = JSON.parse(readFileSync(options.detectPath, 'utf8')) as DetectReport

  // Refused loudly rather than skipped: a proposal that disappears between check and build
  // would look like the model chose not to cut there.
  const semantic =
    options.semanticPath === null
      ? { proposals: [], issues: [] }
      : readProposals(options.semanticPath, report.durationMs)
  if (semantic.issues.length > 0) {
    throw new UsageError(
      `semantic proposals rejected:\n${semantic.issues
        .map((issue) => `  [${issue.index}] ${issue.problem}`)
        .join('\n')}`,
    )
  }

  const { edl, summary } = await runBuild(report, semantic.proposals, {
    outputPath: options.outputPath,
    edlPath: options.edlPath,
    campaignId: options.campaignId,
    width: options.width,
    height: options.height,
    fps: options.fps,
    edgeFadeMs: options.edgeFadeMs,
    crop: options.crop,
    syncOffsetMs: options.syncOffsetMs,
  })

  writeFileSync(options.edlPath, `${JSON.stringify(edl, null, 2)}\n`)

  // Written regardless of --human/--json: the flag exists so a caller reading the human
  // summary on stdout still gets the full report on disk, the same shape 'vcut commit' writes
  // and 'vcut joins --report' reads, without a second 'edl build' run purely to flip format.
  if (options.reportJsonPath !== null) {
    writeFileSync(options.reportJsonPath, `${JSON.stringify(summary, null, 2)}\n`)
  }

  if (mode === 'json') {
    emitJson({ ...summary, next: buildEdlNext(summary.edlPath) })
    return
  }
  console.log(humanSummary(summary))
}
