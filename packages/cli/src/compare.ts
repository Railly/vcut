/**
 * Grade an agent's EDL against an approved human edit.
 *
 * Every round in the agnostic-run series was graded by ear: the human listened to a render,
 * quoted what should not have survived, and forensics went looking for it in the source. Runs
 * 3, 4, and 5 each shipped or missed cuts that only that listening caught, and the loop cost a
 * transcription, several `locate` calls, and a work order every time.
 *
 * Doing it once by hand collapsed the whole loop (issue #39): transcribe the human's approved
 * 9:11.5 reference word-level, align its word stream against the source transcript, recover
 * every span the human implicitly removed, and diff that against the agent's EDL. Output was
 * five concrete missed spans, one of them a 6.4s flubbed clause at 165.0-171.5s that no agent
 * in five runs had ever found.
 *
 * That is what this command is. An approved master stops being a file somebody liked and
 * becomes a quality oracle: ground truth for the next run on similar material, and the eval
 * harness this CLI never had. A corpus of (source, approved edit) pairs turns any future
 * change to vcut into a measurable regression test on edit quality, which is the metric every
 * release in this series was actually chasing.
 *
 * The recovery itself lives in `align.ts`, pure and unit-tested: word streams in, spans out.
 * This module is the seam around it — read the EDL, get the reference's word stream (from an
 * EDL, from an SRT, or by transcribing the media), and report the two directions of
 * disagreement. vcut calls no model of its own here either: `--reference <media>` runs the
 * transcriber already on the caller's PATH, through the same `transcribe-window` seam
 * `say --transcribe` uses.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { coverage, type RecoveredSpan, recoverCuts, type Span } from './align.ts'
import { parseSrt, probeDurationMs, type Word } from './detect.ts'
import { duration, emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import type { Edl } from './render-edl.ts'
import {
  cachedDetect,
  cachedTranscriptPath,
  readMeta,
  sessionRoot,
  sha256File,
  shaDirName,
} from './session.ts'
import { transcribeWindowWords } from './transcribe-window.ts'

const HELP = `vcut compare - grade an EDL against an approved human edit

Usage:
  vcut compare --edl <agent.json> --reference <path> [flags]

Flags:
  --edl <path>                  The agent's EDL, the thing being graded (required)
  --reference <path>            The approved edit: another EDL, or the edited media itself
                                 (audio or video), which is transcribed and aligned (required)
  --transcript <path>           Word-level SRT of the SOURCE. Required when no session exists
                                 for the EDL's source; a session's cached transcript is used
                                 otherwise
  --reference-transcript <path> Word-level SRT of the REFERENCE media, reusing a transcription
                                 you already have instead of paying for another one
  --lang <code>                 Language passed to the transcriber
  --chunk <sec>                 Reference transcription chunk width (default 120)
  --json / --human              Output mode
  --help                        Show this message

Turns an approved master into a quality oracle. The reference's implicit cut list is recovered
by aligning its word stream against the source transcript, then diffed against the EDL both
ways: spans the reference removes that the EDL keeps (missed), and spans the EDL removes that
the reference keeps (overcut).

Transcribing a reference is real wall-clock time. It streams progress to stderr, and
--reference-transcript skips it entirely when you already have the SRT.

A missed or overcut span is a place to look, not a verdict: it rests on two independent
transcriptions of the same speech agreeing about what was said.

The recovered cut list is cross-checked against the reference media's own measured duration.
When the two disagree by more than 5%, the recovery has not accounted for the reference and the
verdict is withheld rather than reported with a caveat. A session's detect report supplies the
source's measured silence, which is what lets a cut be recovered in a stretch with no words to
anchor it.

Also accepts --fields/--jq. See vcut --help for the full picture.`

// The reference is transcribed in chunks rather than in one call: a `trx` invocation over a
// ten-minute file reports nothing until it finishes, and this command's whole cost is that
// transcription. Chunking is what makes progress reportable at all. 120s matches the window
// width the hand run used and is wide enough that no chunk boundary lands often enough to
// matter — a word split across a boundary loses one token from a ~2,000-token stream, which
// the alignment absorbs as a single mismatch.
const DEFAULT_CHUNK_S = 120

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const numericFlag = (argv: string[], name: string): number | undefined => {
  const raw = flagValue(argv, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`${name} expects a number in seconds, got ${raw}`)
  }
  return value
}

// --- EDL reading -----------------------------------------------------------------------------

/**
 * What an EDL removes, in source time: the gaps between the spans it keeps, plus whatever it
 * drops before the first segment and after the last.
 *
 * Derived from the segments rather than read from a build report, because a reference given as
 * an EDL may not have one and because this must answer the same question for both sides of the
 * comparison. An EDL records intent; that is exactly what is being graded here.
 */
export const edlCuts = (segments: Edl['segments'], sourceDurationMs: number | null): Span[] => {
  if (segments.length === 0) {
    return []
  }
  const ordered = [...segments].sort((left, right) => left.inMs - right.inMs)
  const cuts: Span[] = []
  if (ordered[0].inMs > 0) {
    cuts.push({ startMs: 0, endMs: ordered[0].inMs })
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const gapStart = ordered[index - 1].outMs
    const gapEnd = ordered[index].inMs
    if (gapEnd > gapStart) {
      cuts.push({ startMs: gapStart, endMs: gapEnd })
    }
  }
  const lastOut = ordered[ordered.length - 1].outMs
  if (sourceDurationMs !== null && sourceDurationMs > lastOut) {
    cuts.push({ startMs: lastOut, endMs: sourceDurationMs })
  }
  return cuts
}

/** Total kept duration an EDL's segments describe. */
export const keptMs = (segments: Edl['segments']): number =>
  segments.reduce((total, segment) => total + Math.max(0, segment.outMs - segment.inMs), 0)

const readEdl = (path: string): Edl => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Edl
  if (!Array.isArray(parsed.segments)) {
    throw new UsageError(`${path} is not an EDL: no segments array`)
  }
  return parsed
}

/**
 * The source file an EDL points at. The comparison needs it to resolve a session (for the
 * cached transcript) and to know how long the recording was, and an EDL already records it —
 * asking a caller to retype a path the file in their hand already carries is friction for
 * nothing.
 */
export const edlSourcePath = (edl: Edl): string | null => {
  const source = edl.sources?.[0]
  return source === undefined ? null : source.path
}

export const edlSourceDurationMs = (edl: Edl): number | null => {
  const source = edl.sources?.[0]
  return source === undefined ? null : source.durationMs
}

// --- Source transcript resolution --------------------------------------------------------------

/**
 * The source's word stream: `--transcript` when given, otherwise the session's cached copy.
 *
 * The session lookup is by content hash, the same addressing `open` uses, so a caller who has
 * already run `vcut open` on this source never passes `--transcript` at all. Resolved without
 * creating a session: this command reads a session's cache when one exists and asks for the
 * SRT otherwise, rather than minting a session as a side effect of a comparison.
 */
export const resolveSourceWords = async (
  transcriptFlag: string | undefined,
  sourcePath: string | null,
): Promise<{ words: Word[]; from: 'flag' | 'session'; path: string; silences: Span[] }> => {
  if (transcriptFlag !== undefined) {
    const path = resolve(transcriptFlag)
    if (!existsSync(path)) {
      throw new UsageError(`no transcript at ${path}`)
    }
    return { words: parseSrt(readFileSync(path, 'utf8')).words, from: 'flag', path, silences: [] }
  }
  if (sourcePath === null || !existsSync(sourcePath)) {
    throw new UsageError(
      'no source transcript. The EDL names no reachable source to find a session for, so pass --transcript <word-level srt>.',
    )
  }
  const sessionDir = join(sessionRoot(), shaDirName(await sha256File(sourcePath)))
  const cached = cachedTranscriptPath(sessionDir)
  if (readMeta(sessionDir) === null || !existsSync(cached)) {
    throw new UsageError(
      `no session transcript for ${sourcePath}. Run vcut open ${sourcePath} --transcript <srt> first, or pass --transcript <srt> here.`,
    )
  }
  return {
    words: parseSrt(readFileSync(cached, 'utf8')).words,
    from: 'session',
    path: cached,
    silences: sessionSilences(sessionDir),
  }
}

/**
 * The source's measured silence, read from the session's own `detect.json` rather than probed
 * again here.
 *
 * `recoverCuts` needs to know where the source is quiet to recover a cut in a region no word
 * anchors (issue #60), and `open` already measured exactly that, at the threshold the operator
 * chose for this recording and recorded alongside it. Re-probing would either repeat that work
 * or, worse, pick a different threshold and grade against silence the session never saw. No new
 * constant is introduced: the number this recovery leans on is the one already in the session.
 *
 * A session without a detect report yields no silences, which is the pre-#60 behaviour: the
 * text walk alone, and the sanity guard to catch what it misses.
 */
const sessionSilences = (sessionDir: string): Span[] => {
  const detected = cachedDetect(sessionDir)
  if (detected === null) {
    return []
  }
  return detected.silences.map((silence) => ({
    startMs: silence.startMs,
    endMs: silence.endMs,
  }))
}

// --- Reference word stream ---------------------------------------------------------------------

export type ReferenceKind = 'edl' | 'srt' | 'media'

/**
 * What a `--reference` path is, decided by reading it rather than by its extension: an EDL is
 * JSON with a segments array, an SRT parses to cues, and anything else is media to transcribe.
 * Extension sniffing would call a `.json` EDL and a `.json` transcript dump the same thing.
 */
export const classifyReference = (path: string): ReferenceKind => {
  if (/\.srt$/i.test(path)) {
    return 'srt'
  }
  if (!/\.json$/i.test(path)) {
    return 'media'
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { segments?: unknown }
    return Array.isArray(parsed.segments) ? 'edl' : 'media'
  } catch {
    return 'media'
  }
}

/**
 * Transcribe a whole file word-level, in chunks, reporting each one on stderr as it lands.
 *
 * Sequential, never `Promise.all`: each chunk shells out to `trx`, which loads a Whisper model
 * into memory, the same reasoning `joins`, `nonspeech --verify`, and `say --positions
 * --transcribe` already apply. Every chunk's cues come back already offset into reference time
 * by `transcribeWindowWords`, so the assembled stream reads as one transcription of the whole
 * file rather than as N clip transcripts a caller has to stitch.
 *
 * Progress goes to stderr, the same place `render` streams its ffmpeg reports: stdout stays
 * reserved for the result, so a caller piping this into `jq` sees the JSON and a human watching
 * the terminal sees it working. Nothing is cached — a chunk transcript keyed by nothing this
 * command can invalidate is a stale answer waiting to be trusted, and `--reference-transcript`
 * is the explicit, caller-owned version of the same saving.
 */
export const transcribeReference = async (
  mediaPath: string,
  durationMs: number,
  chunkMs: number,
  lang: string | undefined,
  onProgress: (message: string) => void,
): Promise<Word[]> => {
  const chunks = Math.max(1, Math.ceil(durationMs / chunkMs))
  const words: Word[] = []
  for (let index = 0; index < chunks; index += 1) {
    const startMs = index * chunkMs
    const endMs = Math.min(durationMs, startMs + chunkMs)
    onProgress(
      `transcribing reference ${index + 1}/${chunks}  ${duration(startMs)}-${duration(endMs)}`,
    )
    const heard = await transcribeWindowWords(mediaPath, startMs, endMs, lang, 'vcut-compare')
    words.push(...heard.words)
  }
  onProgress(`transcribed reference: ${words.length} words`)
  return words
}

// --- The comparison ------------------------------------------------------------------------------

export type MissedSpan = RecoveredSpan & { coveragePercent: number }

export type OvercutSpan = Span & {
  durationMs: number
  coveragePercent: number
  keptText: string
}

export type CompareVerdict = {
  missed: MissedSpan[]
  overcut: OvercutSpan[]
}

/**
 * Full coverage is never exact. A recovered span's edges come from word cues in one
 * transcription and an EDL's edges come from a detector and a proposal in another, so a cut
 * both sides genuinely made lands a few hundred milliseconds apart in the two coordinate
 * systems. A span the EDL covers at 85% is the same cut; a span it covers at 20% is a cut that
 * caught a corner of what the human removed and left the rest in.
 *
 * Measured on the hand run: every span both sides agreed on scored above 0.9, and every span
 * the human removed alone scored 0. The bar sits between two clusters rather than inside one,
 * which is why it does not need to be tuneable.
 */
export const COVERED_AT = 0.6

/**
 * The two directions of disagreement.
 *
 * `missed` is what the human removed and the EDL kept, each with how much of it the EDL did
 * reach — the primary product, since a missed span is material that survives into a render
 * somebody will have to catch by ear.
 *
 * `overcut` is the mirror: EDL cuts the reference does not corroborate. Weaker evidence by
 * construction, and honestly so — a human editing for delivery removes different things than
 * an agent removing silence, so an EDL cut of pure dead air will read as overcut whenever the
 * reference's own transcript has no words there to prove otherwise. Silence-only spans (no
 * words removed) are excluded for exactly that reason: they are not claims about speech, and
 * grading them against a speech alignment would report noise as findings.
 */
export const compareCuts = (
  recovered: RecoveredSpan[],
  edlSpans: Span[],
  sourceWords: Word[],
): CompareVerdict => {
  const missed: MissedSpan[] = []
  for (const span of recovered) {
    const covered = coverage(span, edlSpans)
    if (covered < COVERED_AT) {
      missed.push({ ...span, coveragePercent: Number((covered * 100).toFixed(1)) })
    }
  }

  const overcut: OvercutSpan[] = []
  for (const span of edlSpans) {
    const wordsInside = sourceWords.filter(
      (word) => word.endMs > span.startMs && word.startMs < span.endMs,
    )
    if (wordsInside.length === 0) {
      continue
    }
    const covered = coverage(span, recovered)
    if (covered < COVERED_AT) {
      overcut.push({
        startMs: span.startMs,
        endMs: span.endMs,
        durationMs: span.endMs - span.startMs,
        coveragePercent: Number((covered * 100).toFixed(1)),
        keptText: wordsInside
          .map((word) => word.text.trim())
          .join(' ')
          .trim(),
      })
    }
  }
  return { missed, overcut }
}

export type Headline = {
  sourceDurationMs: number | null
  edlKeptMs: number
  referenceKeptMs: number | null
  keptDeltaMs: number | null
  edlCutCount: number
  referenceCutCount: number
  missedCount: number
  overcutCount: number
  missedMs: number
  overcutMs: number
}

/**
 * How far the recovered arithmetic may sit from the reference media's own measured duration
 * before the verdict stops being reported.
 *
 * `referenceKeptMs` is derived: source duration minus everything the recovery claims. The
 * reference's duration is also measurable directly, by ffprobe, and the two must agree. They
 * never agree exactly, and the gap has one irreducible cause worth allowing for: a word stream
 * does not cover its own media edge to edge. Speech starts after the file does and stops before
 * it ends, so the recovery cannot account for the unvoiced head and tail.
 *
 * Measured on both approved masters this command has: the Cueva reference's word stream leaves
 * 861ms of its 263.381s unvoiced at the edges (0.33%), the issue #39 hand run 450ms of 551.5s
 * (0.08%). 5% is an order of magnitude above both, which is what a guard against a broken
 * recovery wants: it must not fire on the healthy case it was measured against, and the failure
 * it exists to catch was not a few percent but 99.2% (524.6s claimed against 263.4s of file).
 * Anything between those two scales is a recovery whose arithmetic cannot be trusted, and the
 * point of the guard is that nobody can tell which by reading the number.
 */
export const KEPT_TOLERANCE = 0.05

export type ReferenceCheck = {
  measuredMs: number
  recoveredKeptMs: number
  deltaMs: number
  relative: number
  withinTolerance: boolean
  toleranceRelative: number
}

/**
 * Cross-check the recovered arithmetic against the reference media's own duration.
 *
 * The recovery can only place a cut where a source token or a measured silence gives it a
 * timestamp, so a reference whose removals the alignment cannot see comes back understated, and
 * `referenceKeptMs` comes back inflated by exactly that much. Nothing downstream can detect
 * that: an inflated denominator produces a verdict that reads as authoritative and charges the
 * EDL for cuts the reference genuinely made. This is the one check that can, because the
 * reference's real duration is a fact about a file rather than an inference from a transcript.
 */
export const checkReferenceDuration = (
  recoveredKeptMs: number | null,
  measuredMs: number | null,
  tolerance = KEPT_TOLERANCE,
): ReferenceCheck | null => {
  if (recoveredKeptMs === null || measuredMs === null || measuredMs <= 0) {
    return null
  }
  const deltaMs = recoveredKeptMs - measuredMs
  const relative = Math.abs(deltaMs) / measuredMs
  return {
    measuredMs,
    recoveredKeptMs,
    deltaMs,
    relative: Number(relative.toFixed(4)),
    withinTolerance: relative <= tolerance,
    toleranceRelative: tolerance,
  }
}

export const headlineOf = (
  sourceDurationMs: number | null,
  edlKept: number,
  recovered: RecoveredSpan[],
  edlSpans: Span[],
  verdict: CompareVerdict,
): Headline => {
  const recoveredMs = recovered.reduce((total, span) => total + span.durationMs, 0)
  const referenceKeptMs = sourceDurationMs === null ? null : sourceDurationMs - recoveredMs
  return {
    sourceDurationMs,
    edlKeptMs: edlKept,
    referenceKeptMs,
    keptDeltaMs: referenceKeptMs === null ? null : edlKept - referenceKeptMs,
    edlCutCount: edlSpans.length,
    referenceCutCount: recovered.length,
    missedCount: verdict.missed.length,
    overcutCount: verdict.overcut.length,
    missedMs: verdict.missed.reduce((total, span) => total + span.durationMs, 0),
    overcutMs: verdict.overcut.reduce((total, span) => total + span.durationMs, 0),
  }
}

const seconds = (ms: number): string => (ms / 1000).toFixed(1)

const humanReport = (
  edlPath: string,
  referencePath: string,
  headline: Headline,
  verdict: CompareVerdict,
  check: ReferenceCheck | null,
): string => {
  const lines = [heading(`compare  ${edlPath}`)]
  lines.push(line('reference', referencePath))
  if (headline.sourceDurationMs !== null) {
    lines.push(line('source', duration(headline.sourceDurationMs)))
  }
  lines.push(
    line(
      'kept',
      headline.referenceKeptMs === null
        ? `EDL ${duration(headline.edlKeptMs)}`
        : `EDL ${duration(headline.edlKeptMs)} vs reference ${duration(headline.referenceKeptMs)} (${headline.keptDeltaMs !== null && headline.keptDeltaMs >= 0 ? '+' : ''}${seconds(headline.keptDeltaMs ?? 0)}s)`,
    ),
  )
  lines.push(
    line('cuts', `EDL ${headline.edlCutCount}, reference ${headline.referenceCutCount} recovered`),
  )

  // The verdict is withheld rather than printed with a caveat. A reader who sees counts takes
  // the counts; a warning above a number that still reads as a grade is how the inflated verdict
  // in issue #60 got quoted as fact for a whole improvement arc.
  if (check !== null && !check.withinTolerance) {
    lines.push(heading('recovery failed its own sanity check - no verdict'))
    lines.push(
      line(
        'reference',
        `${duration(check.measuredMs)} measured, ${duration(check.recoveredKeptMs)} recovered (${check.deltaMs >= 0 ? '+' : ''}${seconds(check.deltaMs)}s, ${(check.relative * 100).toFixed(1)}% off, tolerance ${(check.toleranceRelative * 100).toFixed(0)}%)`,
      ),
    )
    lines.push(
      line(
        'why',
        'the recovered cut list does not account for the reference. Grading an EDL against it would charge cuts the reference genuinely made, so the missed/overcut verdict is withheld.',
      ),
    )
    lines.push(
      line(
        'next',
        'run vcut open <source> so the session carries a detect report: the recovery reads its measured silence to place cuts in stretches with no words to anchor them.',
      ),
    )
    return lines.join('\n')
  }

  lines.push(
    line(
      'verdict',
      `${headline.missedCount} missed (${seconds(headline.missedMs)}s), ${headline.overcutCount} overcut (${seconds(headline.overcutMs)}s)`,
    ),
  )

  if (verdict.missed.length > 0) {
    lines.push(heading('missed - the reference removes this, the EDL keeps it'))
    for (const span of verdict.missed) {
      lines.push(
        line(
          `${seconds(span.startMs)}-${seconds(span.endMs)}s (${seconds(span.durationMs)}s)`,
          `${span.coveragePercent}% covered  "${span.removedText}"`,
        ),
      )
    }
  }
  if (verdict.overcut.length > 0) {
    lines.push(heading('overcut - the EDL removes this, the reference keeps it'))
    for (const span of verdict.overcut) {
      lines.push(
        line(
          `${seconds(span.startMs)}-${seconds(span.endMs)}s (${seconds(span.durationMs)}s)`,
          `${span.coveragePercent}% covered  "${span.keptText}"`,
        ),
      )
    }
  }
  if (verdict.missed.length === 0 && verdict.overcut.length === 0) {
    lines.push(heading('no disagreement above the reporting threshold'))
  }
  return lines.join('\n')
}

// --- Command -------------------------------------------------------------------------------------

export const compareCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const edlArg = flagValue(argv, '--edl')
  const referenceArg = flagValue(argv, '--reference')
  if (edlArg === undefined || referenceArg === undefined) {
    throw new UsageError(HELP)
  }
  const edlPath = resolve(edlArg)
  if (!existsSync(edlPath)) {
    throw new UsageError(`no EDL at ${edlPath}`)
  }
  const referencePath = resolve(referenceArg)
  if (!existsSync(referencePath)) {
    throw new UsageError(`no reference at ${referencePath}`)
  }

  const edl = readEdl(edlPath)
  const sourcePath = edlSourcePath(edl)
  const sourceDurationMs = edlSourceDurationMs(edl)
  const edlSpans = edlCuts(edl.segments, sourceDurationMs)

  const referenceKind = classifyReference(referencePath)

  // An EDL reference needs no transcript on either side: both cut lists are already in source
  // time, and running an alignment to recover what one of them already states would be
  // strictly worse evidence than the statement itself.
  if (referenceKind === 'edl') {
    const referenceEdl = readEdl(referencePath)
    const referenceSpans = edlCuts(
      referenceEdl.segments,
      edlSourceDurationMs(referenceEdl) ?? sourceDurationMs,
    )
    const sourceWords = await resolveSourceWordsQuietly(flagValue(argv, '--transcript'), sourcePath)
    const recovered: RecoveredSpan[] = referenceSpans.map((span) => ({
      startMs: span.startMs,
      endMs: span.endMs,
      durationMs: span.endMs - span.startMs,
      removedText: sourceWords
        .filter((word) => word.endMs > span.startMs && word.startMs < span.endMs)
        .map((word) => word.text.trim())
        .join(' ')
        .trim(),
      wordCount: sourceWords.filter(
        (word) => word.endMs > span.startMs && word.startMs < span.endMs,
      ).length,
    }))
    const verdict = compareCuts(recovered, edlSpans, sourceWords)
    const headline = headlineOf(
      sourceDurationMs,
      keptMs(edl.segments),
      recovered,
      edlSpans,
      verdict,
    )
    // No check on this path: both cut lists are stated in source time, so there is no recovery
    // whose arithmetic could drift from a file the reference EDL does not even have.
    report(mode, {
      edlPath,
      referencePath,
      referenceKind,
      referenceTranscriptFrom: null,
      headline,
      verdict,
      check: null,
    })
    return
  }

  const { words: sourceWords, silences: sourceSilences } = await resolveSourceWords(
    flagValue(argv, '--transcript'),
    sourcePath,
  )
  if (sourceWords.length === 0) {
    throw new UsageError(
      'the source transcript carries no words. compare recovers the reference cut list by aligning word streams; without one there is nothing to align against.',
    )
  }

  // Probed whatever the reference turns out to be, and whether or not it is transcribed here:
  // the sanity check needs the file's own duration, and only media has one. An SRT reference
  // has no measurable duration of its own, so it goes unchecked rather than checked against a
  // number inferred from the same transcript the recovery already used.
  const referenceMediaMs = referenceKind === 'media' ? await probeDurationMs(referencePath) : null

  let referenceWords: Word[]
  let referenceTranscriptFrom: 'flag' | 'transcribed'
  const referenceTranscriptFlag = flagValue(argv, '--reference-transcript')
  if (referenceTranscriptFlag !== undefined) {
    const path = resolve(referenceTranscriptFlag)
    if (!existsSync(path)) {
      throw new UsageError(`no reference transcript at ${path}`)
    }
    referenceWords = parseSrt(readFileSync(path, 'utf8')).words
    referenceTranscriptFrom = 'flag'
  } else if (referenceKind === 'srt') {
    referenceWords = parseSrt(readFileSync(referencePath, 'utf8')).words
    referenceTranscriptFrom = 'flag'
  } else {
    const chunkMs = (numericFlag(argv, '--chunk') ?? DEFAULT_CHUNK_S) * 1000
    referenceWords = await transcribeReference(
      referencePath,
      referenceMediaMs ?? (await probeDurationMs(referencePath)),
      chunkMs,
      flagValue(argv, '--lang'),
      (message) => console.error(message),
    )
    referenceTranscriptFrom = 'transcribed'
  }

  const recovered = recoverCuts(sourceWords, referenceWords, { sourceSilences })
  const verdict = compareCuts(recovered, edlSpans, sourceWords)
  const headline = headlineOf(sourceDurationMs, keptMs(edl.segments), recovered, edlSpans, verdict)
  const check = checkReferenceDuration(headline.referenceKeptMs, referenceMediaMs)
  report(mode, {
    edlPath,
    referencePath,
    referenceKind,
    referenceTranscriptFrom,
    headline,
    verdict,
    check,
  })
}

/**
 * The source words for the EDL-vs-EDL path, where a transcript is a nicety rather than the
 * mechanism: it only supplies `removedText`/`keptText` quotes. An absent transcript there is a
 * report without quotes, not a refusal, since both cut lists are already stated in source time.
 */
const resolveSourceWordsQuietly = async (
  transcriptFlag: string | undefined,
  sourcePath: string | null,
): Promise<Word[]> => {
  try {
    return (await resolveSourceWords(transcriptFlag, sourcePath)).words
  } catch {
    return []
  }
}

const report = (
  mode: Mode,
  payload: {
    edlPath: string
    referencePath: string
    referenceKind: ReferenceKind
    referenceTranscriptFrom: 'flag' | 'transcribed' | null
    headline: Headline
    verdict: CompareVerdict
    check: ReferenceCheck | null
  },
): void => {
  const trusted = payload.check === null || payload.check.withinTolerance
  if (mode === 'json') {
    // `referenceCheck` and `verdictWithheld` are stated rather than implied by empty lists: a
    // consumer that reads `missed`/`overcut` and finds them empty must be able to tell "the EDL
    // agrees with the reference" from "the recovery is not good enough to say".
    emitJson({
      version: 1,
      edl: payload.edlPath,
      reference: payload.referencePath,
      referenceKind: payload.referenceKind,
      referenceTranscriptFrom: payload.referenceTranscriptFrom,
      referenceCheck: payload.check,
      verdictWithheld: !trusted,
      headline: payload.headline,
      missed: trusted ? payload.verdict.missed : [],
      overcut: trusted ? payload.verdict.overcut : [],
    })
    return
  }
  console.log(
    humanReport(
      payload.edlPath,
      payload.referencePath,
      payload.headline,
      payload.verdict,
      payload.check,
    ),
  )
}
