import { existsSync, readFileSync } from 'node:fs'

import type { DetectReport, Interval, Transcript, Word } from './detect.ts'
import { parseSilenceLog, parseSrt } from './detect.ts'
import { run } from './exec.ts'
import { emitJson, UsageError } from './output.ts'

const HELP = `vcut semantic - hand the transcript to a model, take back cut proposals

Usage:
  vcut semantic export --detect <path>
  vcut semantic check --proposals <path> --detect <path>
  vcut semantic review --edl <path> --detect <path> [--master <path>]
                       [--master-transcript <path>]

Flags:
  --detect <path>       Report produced by detect (required)
  --proposals <path>    Proposals to validate (check only)
  --edl <path>          EDL to read back (review only)
  --master <path>       Rendered file to measure silence on (review only)
  --master-transcript <path>  Word-level SRT of the master; lines come from it (review only)
  --help                Show this message

Both subcommands emit JSON: the reader is an agent, not a terminal.

vcut never calls a model. Export gives an agent numbered lines with timings; the
agent writes proposals back as JSON, and 'vcut edl build --semantic <path>' folds
them in. Every proposed cut lands as semanticRisk material and stays unapproved.

review closes the loop: it reads an EDL back and returns the transcript as it
survives the cuts, so the agent judges the result a viewer hears rather than the
plan it wrote.`

// Whisper with --max-len 1 emits BPE pieces, not words: "Crafter" arrives as "Cra" + "fter".
// A model reasoning over raw cues sees fragments and proposes cuts against text nobody
// spoke, so the export rebuilds words before it rebuilds lines.
//
// Whisper writes the word boundary as a leading space, which parseSrt records as startsWord
// before trimming. A cue that does not start a word continues the previous one, and so does
// bare punctuation, which belongs to the word it follows rather than opening a new one.
export const joinWords = (transcript: Transcript): Word[] => {
  const words: Word[] = []

  for (const cue of transcript.words) {
    const text = cue.text.trim()
    if (text === '') {
      continue
    }
    const previous = words[words.length - 1]
    const isPunctuation = /^[^\p{L}\p{N}]+$/u.test(text)
    const continues = previous !== undefined && (cue.startsWord !== true || isPunctuation)

    if (continues) {
      previous.text += text
      previous.endMs = cue.endMs
      continue
    }
    words.push({ text, startMs: cue.startMs, endMs: cue.endMs })
  }

  return words
}

export type Line = {
  index: number
  startMs: number
  endMs: number
  text: string
}

// Sentence-ish units, because a model asked to spot a false start needs to see the restart
// next to it. Terminal punctuation alone is not enough: whisper leaves long unpunctuated
// runs, and its cues carry no pauses to fall back on, since each cue is stretched to the
// start of the next word (1591 of 1609 cues touch, on the corpus this was built against).
// The silences the detector measured from audio energy are the real sentence breaks.
export const buildLines = (words: Word[], silences: Interval[], breakMs: number): Line[] => {
  const lines: Line[] = []
  let current: Word[] = []
  // Only pauses long enough to end a thought. Every gap between words is a silence to the
  // detector, and breaking on those chops sentences mid-clause, which is the opposite of
  // what a model needs to see a false start and its restart together.
  const breaks = silences
    .filter((silence) => silence.endMs - silence.startMs >= breakMs)
    .map((silence) => silence.startMs)

  const flush = () => {
    if (current.length === 0) {
      return
    }
    lines.push({
      index: lines.length + 1,
      startMs: current[0].startMs,
      endMs: current[current.length - 1].endMs,
      text: current
        .map((word) => word.text)
        .join(' ')
        .replace(/\s+([,.;:!?…])/g, '$1')
        .trim(),
    })
    current = []
  }

  for (const [index, word] of words.entries()) {
    current.push(word)
    const next = words[index + 1]
    const endsSentence = /[.!?…]$/.test(word.text)
    // The silence begins inside the stretched cue rather than between two cues, so the
    // test is whether a measured pause starts anywhere after this word is spoken.
    const pauseFollows =
      next !== undefined && breaks.some((start) => start > word.startMs && start <= next.startMs)
    if (endsSentence || pauseFollows) {
      flush()
    }
  }
  flush()

  return lines
}

export type Proposal = {
  startMs: number
  endMs: number
  kind: 'false-start' | 'repetition' | 'tangent' | 'filler' | 'non-speech'
  reason: string
}

export type ProposalIssue = {
  index: number
  problem: string
}

// Proposals arrive from a model, so nothing here is trusted. Anything malformed is reported
// with its index rather than dropped silently, because a cut that vanishes between export
// and build is worse than one that is refused out loud.
export const validateProposals = (
  parsed: unknown,
  durationMs: number,
): { proposals: Proposal[]; issues: ProposalIssue[] } => {
  const kinds = new Set(['false-start', 'repetition', 'tangent', 'filler', 'non-speech'])
  const issues: ProposalIssue[] = []
  const proposals: Proposal[] = []

  if (!Array.isArray(parsed)) {
    return { proposals: [], issues: [{ index: 0, problem: 'proposals must be a JSON array' }] }
  }

  for (const [index, entry] of parsed.entries()) {
    const candidate = entry as Partial<Proposal>
    const problem = (): string | null => {
      if (typeof entry !== 'object' || entry === null) {
        return 'entry is not an object'
      }
      if (!Number.isFinite(candidate.startMs) || !Number.isFinite(candidate.endMs)) {
        return 'startMs and endMs must be numbers'
      }
      const start = candidate.startMs as number
      const end = candidate.endMs as number
      if (start < 0 || end <= start) {
        return 'endMs must be greater than startMs, and startMs cannot be negative'
      }
      if (end > durationMs) {
        return `endMs ${end} runs past the ${durationMs}ms source`
      }
      if (candidate.kind === undefined || !kinds.has(candidate.kind)) {
        return `kind must be one of ${[...kinds].join(', ')}`
      }
      if (typeof candidate.reason !== 'string' || candidate.reason.trim() === '') {
        return 'reason must be a non-empty string, it is what a human reads before approving'
      }
      return null
    }

    const found = problem()
    if (found === null) {
      proposals.push(candidate as Proposal)
      continue
    }
    issues.push({ index, problem: found })
  }

  return { proposals, issues }
}

export const readProposals = (
  path: string,
  durationMs: number,
): { proposals: Proposal[]; issues: ProposalIssue[] } => {
  if (!existsSync(path)) {
    throw new UsageError(`proposals file missing: ${path}`)
  }
  try {
    return validateProposals(JSON.parse(readFileSync(path, 'utf8')), durationMs)
  } catch (error) {
    if (error instanceof UsageError) {
      throw error
    }
    throw new UsageError(`proposals file is not valid JSON: ${path}`)
  }
}

// Between the median silence and the third quartile on the corpus this was built against:
// long enough to skip the gaps between words, short enough to still end a thought.
const LINE_BREAK_MS = 700

const loadTranscript = (report: DetectReport): Transcript => {
  if (report.transcript.path === null || !existsSync(report.transcript.path)) {
    throw new UsageError('semantic export needs the word-level transcript used by detect')
  }
  return parseSrt(readFileSync(report.transcript.path, 'utf8'))
}

const readReport = (path: string | undefined): DetectReport => {
  if (path === undefined) {
    throw new UsageError(HELP)
  }
  if (!existsSync(path)) {
    throw new UsageError(`detect report missing: ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DetectReport
}

const INSTRUCTIONS = [
  'Read the lines and propose spans to cut. Return a JSON array, nothing else.',
  'Each entry: {"startMs": number, "endMs": number, "kind": "false-start" | "repetition" | "tangent" | "filler", "reason": string}.',
  'Use the line timings; a span may cover part of a line or several lines.',
  'false-start: the speaker restarts a sentence. Cut the abandoned attempt, keep the one that lands.',
  'repetition: the same point made twice. Keep the clearer telling.',
  'tangent: a digression the speaker leaves and returns from. Only when the thread survives without it.',
  'filler: a span that can be deleted without a listener learning anything less. Test by deletion, not by matching a vocabulary, so it works in any language and on constructions nobody named. The same words are filler in one clause and content in the next.',
  'non-speech: audible sound that is not language. A breath, a mic bump, a lip smack, a laugh. The transcript has no word for it and the silence pass hears energy and calls it speech, so it is invisible to both and needs an audio classifier to find. skills/core/scripts/non-speech.py does that; nothing in vcut detects it on its own.',
  'reason is read by a human deciding whether to approve. Say what is lost, not what rule matched.',
  'Never cut the end of a sentence whose start you kept, or the answer to a question you kept.',
  'Propose nothing when nothing should go. An empty array is a valid answer.',
  'Before proposing, list what the recording actually says. One idea told three times is one idea and two cuts, however far apart they sit: distance is not evidence they differ, and a listener hears them together at speed even when the transcript spreads them over a minute.',
  'Keep the best telling, not the first. The clearest version is usually the last, after the speaker worked out how to say it.',
  'A span covering a whole paragraph is normal. False starts and restatements run ten or fifteen seconds. If every span you propose is a few hundred milliseconds, you found fillers and missed the redundancy.',
  'Cut to the end of the clause. Half a sentence surviving its own cut is worse than leaving the passage whole.',
  'The failure mode is politeness: reading this as an argument to preserve rather than a recording to edit. The human can refuse any cut and it is their voice, so under-proposing takes the decision away from them just as much as over-cutting, only silently.',
]

export type SurvivingLine = Line & {
  keptMs: number
  truncated: boolean
  precededByCut: boolean
}

export type DeadAir = {
  segmentId: string
  startMs: number
  endMs: number
  detail: string
}

// What a viewer actually hears, which is not what the proposals described. Each cut is sound
// on its own, and the run of them is what breaks: a sentence whose start survives and whose
// end went, a pronoun whose antecedent left, two clauses that now collide. Rebuilding the
// transcript from the segments is the only way to read the result rather than the intent.
export const survivingLines = (lines: Line[], segments: Interval[]): SurvivingLine[] => {
  const kept: SurvivingLine[] = []

  for (const [index, line] of lines.entries()) {
    const overlaps = segments
      .map((segment) => ({
        startMs: Math.max(line.startMs, segment.startMs),
        endMs: Math.min(line.endMs, segment.endMs),
      }))
      .filter((overlap) => overlap.endMs > overlap.startMs)
    if (overlaps.length === 0) {
      continue
    }
    const keptMs = overlaps.reduce((total, overlap) => total + (overlap.endMs - overlap.startMs), 0)
    const previous = lines[index - 1]
    kept.push({
      ...line,
      keptMs,
      truncated: keptMs < line.endMs - line.startMs,
      // A line whose predecessor is gone is where the join lands, and where a broken
      // transition would be heard.
      precededByCut:
        previous !== undefined &&
        !segments.some(
          (segment) => previous.endMs > segment.startMs && previous.endMs <= segment.endMs,
        ),
    })
  }
  return kept
}

// A segment that is mostly measured silence is a pause the cut left behind: the speech on
// both sides went and the quiet between them stayed. It is what a viewer calls a gap for no
// reason.
//
// Judged against the silences the detector measured, not the transcript. Whisper stretches
// each cue to the next word, so a cue routinely covers the pause that follows it and a span
// of dead air still looks like it holds a word. Audio energy is the evidence here.
export const silentSegments = (
  segments: Array<Interval & { id: string }>,
  silences: Interval[],
  minMs: number,
): DeadAir[] =>
  segments
    .filter((segment) => segment.endMs - segment.startMs >= minMs)
    .map((segment) => {
      const quietMs = silences.reduce((total, silence) => {
        const overlap =
          Math.min(segment.endMs, silence.endMs) - Math.max(segment.startMs, silence.startMs)
        return overlap > 0 ? total + overlap : total
      }, 0)
      return { segment, quietMs, spanMs: segment.endMs - segment.startMs }
    })
    .filter(({ quietMs, spanMs }) => quietMs / spanMs >= 0.5)
    .map(({ segment, quietMs, spanMs }) => ({
      segmentId: segment.id,
      startMs: segment.startMs,
      endMs: segment.endMs,
      detail: `${spanMs}ms segment, ${quietMs}ms of it measured silence`,
    }))

// The detector cuts by threshold, so a passage just above it survives whole even when it
// carries almost nothing. Between two cuts that is heard as a gap rather than as speech: the
// audio around it was removed for being quiet and this stayed for being marginally less so.
//
// Judged against the other survivors, not against a fixed dB value, because the floor depends
// on the mic, the room, and how close the speaker sat. A segment far below its own recording's
// median is the outlier worth a listen. Reported, never cut: only a listener can tell a held
// breath from a word said softly.
export const quietSegments = (
  levels: Array<{ id: string; startMs: number; endMs: number; meanDb: number }>,
  belowMedianDb: number,
): DeadAir[] => {
  const usable = levels.filter((level) => Number.isFinite(level.meanDb))
  if (usable.length < 3) {
    return []
  }
  const sorted = [...usable].map((level) => level.meanDb).sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]
  return usable
    .filter((level) => median - level.meanDb >= belowMedianDb)
    .map((level) => ({
      segmentId: level.id,
      startMs: level.startMs,
      endMs: level.endMs,
      detail: `${level.meanDb.toFixed(1)} dB against a ${median.toFixed(1)} dB median for this recording`,
    }))
}

// Longer than a breath between clauses, short enough to catch a pause that stalls the video.
const GAP_MS = 600

// Two cuts closer than this leave nothing between them worth a second look.
const UNREVIEWED_MS = 2_000

// Measured on this corpus: the one segment a listener flagged as an unexplained gap sat
// 16 dB under the median while every other survivor stayed within 6.
const QUIET_BELOW_MEDIAN_DB = 12

const segmentLevels = async (
  input: string,
  segments: Array<Interval & { id: string }>,
): Promise<Array<{ id: string; startMs: number; endMs: number; meanDb: number }>> =>
  Promise.all(
    segments.map(async (segment) => {
      const { stderr } = await run('ffmpeg', [
        '-hide_banner',
        '-nostats',
        '-ss',
        (segment.startMs / 1000).toFixed(3),
        '-t',
        ((segment.endMs - segment.startMs) / 1000).toFixed(3),
        '-i',
        input,
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-',
      ])
      const match = stderr.match(/mean_volume:\s*(-?[\d.]+)/)
      return {
        id: segment.id,
        startMs: segment.startMs,
        endMs: segment.endMs,
        meanDb: match === null ? Number.NaN : Number(match[1]),
      }
    }),
  )

// What the EDL removed, which is what the segments do not cover.
export const gapsBetween = (segments: Interval[]): Interval[] => {
  const sorted = [...segments].sort((left, right) => left.startMs - right.startMs)
  const gaps: Interval[] = []
  for (let index = 0; index < sorted.length - 1; index += 1) {
    if (sorted[index + 1].startMs > sorted[index].endMs) {
      gaps.push({ startMs: sorted[index].endMs, endMs: sorted[index + 1].startMs })
    }
  }
  return gaps
}

// A pass reads what it went looking for. Cuts land where attention was, and the stretches
// between two cuts are where nothing was ever read: they look reviewed because their
// neighbours are, which is exactly why a marker can survive four rounds sitting between two
// spans that were both examined closely.
//
// This names them. Not a defect on its own, since a long clean passage is also a long gap
// between cuts, but it is the list of places a pass has evidence of having skipped.
export const unreviewedStretches = (
  lines: Line[],
  cuts: Interval[],
  minMs: number,
): Array<{ startMs: number; endMs: number; text: string }> => {
  const sorted = [...cuts].sort((left, right) => left.startMs - right.startMs)
  if (sorted.length === 0) {
    return []
  }
  const stretches: Array<{ startMs: number; endMs: number; text: string }> = []

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const from = sorted[index].endMs
    const to = sorted[index + 1].startMs
    if (to - from < minMs) {
      continue
    }
    // A line belongs to the stretch its middle falls in. Asking for containment loses almost
    // everything, since a line rarely fits between two cuts; asking for overlap pulls in the
    // long line on either side and reports the whole recording.
    const inside = lines.filter((line) => {
      const middle = (line.startMs + line.endMs) / 2
      return middle >= from && middle < to
    })
    if (inside.length === 0) {
      continue
    }
    stretches.push({
      startMs: from,
      endMs: to,
      text: inside.map((line) => line.text).join(' '),
    })
  }
  return stretches
}

const REVIEW_INSTRUCTIONS = [
  'These are the lines of the edit, in the order a viewer hears them. Read the result, not the plan.',
  'linesFrom says where they came from. "master" means the render was transcribed again, so this is literally what a listener hears, word for word, including any word the cuts left half-spoken. "source" means the original transcript projected onto the surviving spans, which shows the plan and can hide a mangled join.',
  'When linesFrom is "master", read it as prose and judge it as prose: a word cut in half, a clause with no verb, a sentence split across two lines that used to be one, the same point still made twice after all the cutting. Timings are the master timeline.',
  'Return a JSON array of problems, nothing else. Each entry: {"lineIndex": number, "problem": string, "fix": string}.',
  'precededByCut marks a join: the line before it was removed. That is where a transition breaks.',
  'truncated marks a line the cuts entered: part of it is gone, so check the half that stayed still parses.',
  'Look for a sentence whose start survived and whose end did not, a pronoun whose antecedent was cut, two clauses that now collide, and an idea that still repeats after the cuts.',
  'Redundancy that survives is worth reporting even when every cut was correct: keeping the clearest of three tellings is the point, and two of them may still be there.',
  'deadAir lists gaps left by the cuts, each one a pause the viewer hears for no reason.',
  'A deadAir entry with segmentId "rendered" was measured on the master itself, so its timings are the master timeline, not the source. Those are the ones a viewer really sits through, including a pause two adjoining segments create together.',
  'A missing word is not proof of a bad cut. Whisper drops words, so before reporting one, check the EDL still covers that span: if it does, the transcript is wrong and the audio is fine.',
  'fix says what to do: extend a cut, shorten it, restore a span. Give timings when you can.',
  'Check these one at a time against the text above. Each is a defect, not a matter of taste, and each survives a pass that only looked for the obvious:',
  '1. No idea is stated twice. Two passages making the same point means one is a cut, however far apart they sit.',
  '2. No sentence begins and does not land. Every start has its ending here, or the whole attempt goes.',
  '3. No pronoun outlives its antecedent. If "that" refers to something cut, the sentence goes with it.',
  '4. No fragment survives alone. A clause that only made sense inside a removed passage is a leftover, not content.',
  '5. Nothing survives that can be deleted without changing what the sentence says. Delete the candidate, read what remains, and ask whether a listener learns anything less; if not, it goes. This is a deletion test, never a vocabulary: a word list only finds what someone thought to write down and has to be rewritten per language, while asking what a span does in its sentence works on a construction nobody named. Sweep span by span rather than scanning for shapes you recognise, because what you recognise is gone by the second pass and what stays reads as ordinary grammar. Two things fail the test and stay anyway: a word carrying emphasis the speaker meant, and a beat that gives a listener room before a heavy point.',
  '6. The last line lands. Ending on an abandoned start is worse than ending four seconds sooner.',
  '7. Nothing audible is left that is not language: a breath, a mic bump, a lip smack. Neither the silence pass nor the transcript can see these, so they need an audio classifier or a human ear.',
  '8. Every stretch has been read at least once. An unread stretch violates nothing visibly, because nobody looked, which is what lets a defect survive round after round.',
  'When a false-start survived its own cut, the span was too narrow, not the judgement wrong: widen the existing proposal rather than adding a new one beside it.',
  'unreviewed lists the stretches between two cuts that no proposal ever touched. They look reviewed because their neighbours were cut, and that is where a marker survives round after round. Read those first and apply the deletion test to every span in them.',
  'Report nothing when the result reads clean and every invariant holds. An empty array is a valid answer, and it is the signal to stop looping.',
]

// Everything else in review reasons about the source: the transcript mapped onto the spans
// that survive. That describes the plan, not the file. Silence measured on the rendered master
// is the only evidence of what a viewer actually sits through, and it catches the pause that
// two adjoining segments create together, which neither of them contained on its own.
export const renderedGaps = async (
  masterPath: string,
  thresholdDb: number,
  minMs: number,
): Promise<DeadAir[]> => {
  // A missing ffmpeg throws rather than returning a code, and this measurement is an extra
  // signal on top of the review, not a precondition for producing one. Losing it costs the
  // caller one class of finding; failing here would cost them the whole review.
  const probe = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    masterPath,
    '-af',
    `silencedetect=noise=${thresholdDb}dB:d=${minMs / 1000}`,
    '-f',
    'null',
    '-',
  ]).catch(() => null)
  if (probe === null || probe.exitCode !== 0) {
    return []
  }
  return parseSilenceLog(probe.stderr, Number.POSITIVE_INFINITY).map((silence) => ({
    segmentId: 'rendered',
    startMs: silence.startMs,
    endMs: silence.endMs,
    detail: `${silence.durationMs}ms of silence at ${(silence.startMs / 1000).toFixed(2)}s of the master itself`,
  }))
}

export const semanticCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const value = (flag: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const subcommand = argv[0]

  if (subcommand === 'export') {
    const report = readReport(value('--detect'))
    const lines = buildLines(joinWords(loadTranscript(report)), report.silences, LINE_BREAK_MS)
    emitJson({
      status: 'exported',
      input: report.input,
      durationMs: report.durationMs,
      lang: report.lang,
      instructions: INSTRUCTIONS,
      lines,
    })
    return
  }

  if (subcommand === 'review') {
    const report = readReport(value('--detect'))
    const edlPath = value('--edl')
    if (edlPath === undefined) {
      throw new UsageError(HELP)
    }
    if (!existsSync(edlPath)) {
      throw new UsageError(`edl missing: ${edlPath}`)
    }
    const edl = JSON.parse(readFileSync(edlPath, 'utf8')) as {
      segments: Array<{ id: string; inMs: number; outMs: number }>
    }
    const segments = edl.segments.map((segment) => ({
      id: segment.id,
      startMs: segment.inMs,
      endMs: segment.outMs,
    }))
    const words = joinWords(loadTranscript(report))
    const masterTranscript = value('--master-transcript')
    if (masterTranscript !== undefined && !existsSync(masterTranscript)) {
      throw new UsageError(`master transcript missing: ${masterTranscript}`)
    }
    const masterPath = value('--master')
    if (masterPath !== undefined && !existsSync(masterPath)) {
      throw new UsageError(`master missing: ${masterPath}`)
    }
    const gaps =
      masterPath === undefined ? [] : await renderedGaps(masterPath, report.thresholdDb, GAP_MS)
    const deadAir = [
      ...silentSegments(segments, report.silences, report.minSilenceMs),
      ...quietSegments(await segmentLevels(report.input, segments), QUIET_BELOW_MEDIAN_DB),
      ...gaps,
    ]
    // Lines from the master need the master's own pauses to break on. Without --master there
    // are none measured, and the transcript's own punctuation carries the split.
    const masterSilences = gaps.map((gap) => ({ startMs: gap.startMs, endMs: gap.endMs }))
    const keptMs = segments.reduce((total, segment) => total + (segment.endMs - segment.startMs), 0)
    // Transcribing the master and reading that is the only way to see a word the cuts left
    // half-spoken, or two clauses that only collide once they are adjacent. Projecting the
    // source transcript onto the surviving spans shows the plan; this shows the sentence.
    const lines =
      masterTranscript === undefined
        ? survivingLines(buildLines(words, report.silences, LINE_BREAK_MS), segments)
        : buildLines(
            joinWords(parseSrt(readFileSync(masterTranscript, 'utf8'))),
            masterSilences,
            LINE_BREAK_MS,
          )
    emitJson({
      status: 'exported',
      input: report.input,
      sourceDurationMs: report.durationMs,
      resultDurationMs: keptMs,
      instructions: REVIEW_INSTRUCTIONS,
      masterMeasured: masterPath !== undefined,
      linesFrom: masterTranscript === undefined ? 'source' : 'master',
      unreviewed: unreviewedStretches(lines, gapsBetween(segments), UNREVIEWED_MS),
      deadAir,
      lines,
    })
    return
  }

  if (subcommand === 'check') {
    const report = readReport(value('--detect'))
    const path = value('--proposals')
    if (path === undefined) {
      throw new UsageError(HELP)
    }
    const { proposals, issues } = readProposals(path, report.durationMs)
    emitJson({
      status: issues.length === 0 ? 'valid' : 'rejected',
      accepted: proposals.length,
      issues,
    })
    if (issues.length > 0) {
      process.exitCode = 1
    }
    return
  }

  throw new UsageError(HELP)
}
