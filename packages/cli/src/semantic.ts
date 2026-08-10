import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { DetectReport, Interval, Transcript, Word } from './detect.ts'
import { parseSilenceLog, parseSrt } from './detect.ts'
import { run } from './exec.ts'
import { emitJson, UsageError } from './output.ts'

const HELP = `vcut semantic - hand the transcript to a model, take back cut proposals

Usage:
  vcut semantic export --detect <path> [--terse]
  vcut semantic check --proposals <path> --detect <path> [--review <path>]
  vcut semantic review --edl <path> --detect <path> [--master <path>]
                       [--master-transcript <path>]

Flags:
  --detect <path>       Report produced by detect (required)
  --proposals <path>    Proposals to validate (check only)
  --review <path>       JSON a 'review' wrote for this render; exits 2 while a repeated
                        phrase is unnamed by any reason or still present in the
                        render's own lines (check only)
  --edl <path>          EDL to read back (review only)
  --master <path>       Rendered file to measure silence on (review only)
  --master-transcript <path>  Word-level SRT of the master; lines come from it (review only)
  --terse               Omit the instructions block, which is identical every call and
                        was 72% of the payload on one measured run (export and review)
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

// Repeated wording in the render, which is the one defect a reader talks themselves out of.
// Five runs of one recording shipped a repetition; the reading that kept it was never "I did
// not see this" but "I saw it and it is deliberate". Nothing downstream could tell that apart
// from a correct call, so the tool met a wrong judgement with the same silence it gives a right
// one. This does not judge: it names the phrases that occur twice so a claim of intent has to
// be made about something specific.
//
// Word runs rather than a similarity score. Similarity cannot separate a restatement from two
// sentences sharing prepositions: measured on one recording the repeated pair scored 0.150
// against 0.114 for a healthy neighbouring pair. An exact run of words repeating is not a
// matter of degree, and a speaker restating a line reuses the words rather than paraphrasing.
const RUN_LENGTH = 3

export const repeatedPhrases = (
  lines: Line[],
): Array<{ phrase: string; count: number; lineIndexes: number[] }> => {
  const seen = new Map<string, number[]>()
  lines.forEach((line, index) => {
    const words = line.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 0)
    const local = new Set<string>()
    for (let start = 0; start + RUN_LENGTH <= words.length; start += 1) {
      const run = words.slice(start, start + RUN_LENGTH).join(' ')
      // A run repeating inside one line still counts once for that line, so a line is never
      // reported as repeating itself through a stutter the transcript already collapsed.
      if (local.has(run)) {
        continue
      }
      local.add(run)
      const where = seen.get(run) ?? []
      where.push(index)
      seen.set(run, where)
    }
  })
  return [...seen.entries()]
    .filter(([, where]) => where.length > 1)
    .map(([phrase, where]) => ({ phrase, count: where.length, lineIndexes: where }))
    .sort((left, right) => right.count - left.count || left.phrase.localeCompare(right.phrase))
}

// Lowercasing alone leaves an accent standing between a repeated phrase and the reason that
// names it: the phrase comes off the transcript with its diacritics ("así que nada") and a
// reason typed by hand routinely drops them ("asi que nada"), so an honest naming fails
// unaddressedRepeats' includes() and check exits 2 over a repeat that was in fact named.
// Measured on the corpus that motivated this: one full build cycle lost to exactly that
// mismatch. NFD splits a letter from its combining accent, and stripping the combining marks
// (Unicode category Mn) after that leaves the letters the two spellings actually share.
export const foldDiacritics = (text: string): string =>
  text.normalize('NFD').replace(/\p{Mn}/gu, '')

// A repeated phrase nobody wrote about is a round that is not finished. Listing them in review
// was not enough on its own: a run read its own list, decided one entry was a deliberate turn,
// wrote no proposal, and shipped the repetition — the same failure as before the field existed,
// one level up. A field can be skipped in silence. A non-zero exit cannot.
//
// The bar is naming, not agreeing. Deciding a repeat is intentional is a valid answer and
// keeping it is often right, but the decision has to appear in a reason where a human reading
// the EDL can find it, rather than in a judgement that left no trace.
type Repeat = { phrase: string; count: number; lineIndexes: number[] }

// The review JSON is this tool's own output, so a missing or malformed `repeated` means an
// older run wrote it rather than a caller getting it wrong: read it as nothing to answer.
const readReview = (path: string | undefined): { repeated: Repeat[]; lines: Line[] } => {
  if (path === undefined) {
    return { repeated: [], lines: [] }
  }
  const parsed = JSON.parse(readFileSync(resolve(path), 'utf8')) as {
    repeated?: unknown
    lines?: unknown
  }
  return {
    repeated: Array.isArray(parsed.repeated) ? (parsed.repeated as Repeat[]) : [],
    lines: Array.isArray(parsed.lines) ? (parsed.lines as Line[]) : [],
  }
}

// Naming a phrase in a reason is not the same as removing it. A run wrote a reason that quoted
// the repeated line, cut a boundary 1772ms short of where the repetition ended, and passed this
// check while the render still said it twice: the reason was honest and the cut missed.
//
// The render is the only thing that settles it, and review already carries its lines, so this
// costs no transcription. A phrase still present as often as review found it was not addressed,
// whatever any reason says about it.
export const survivingRepeats = (repeated: Repeat[], masterLines: Line[]): Repeat[] => {
  const text = masterLines
    .map((line) => line.text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
  return repeated.filter((entry) => {
    let count = 0
    let from = 0
    for (;;) {
      const at = text.indexOf(entry.phrase, from)
      if (at === -1) {
        break
      }
      count += 1
      from = at + 1
    }
    return count >= entry.count
  })
}

export const unaddressedRepeats = (
  repeated: Repeat[],
  proposals: Array<{ reason?: unknown }>,
): Repeat[] => {
  const written = foldDiacritics(
    proposals
      .map((proposal) => (typeof proposal.reason === 'string' ? proposal.reason.toLowerCase() : ''))
      .join('\n'),
  )
  return repeated.filter((entry) => !written.includes(foldDiacritics(entry.phrase)))
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

export const REVIEW_INSTRUCTIONS = [
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
  'When a listener reports something this text does not show, transcribe that stretch on its own before deciding the text is right: a model reading the whole file collapses three attempts at one line into one, and the same audio cut to a few seconds returns all three.',
  'A converted timestamp looks as confident as a measured one. When a finding contradicts your mapping between the source and the master, check the mapping first, since it is the newer claim.',
  'unreviewed lists the stretches between two cuts that no proposal ever touched. They look reviewed because their neighbours were cut, and that is where a marker survives round after round. Read those first and apply the deletion test to every span in them.',
  'repeated lists wording that occurs more than once in the text above, with the lines it occurs in. It is not a verdict: a name, a term the subject is about, and a deliberate echo all repeat legitimately. It is the list of places where "I read this and it is fine" has to be a decision about a specific phrase rather than an impression of the whole.',
  'Answer every entry in repeated before reporting nothing. Say which telling you are keeping and why the others are not tellings of the same thing. A retake reads as a coherent scene, which is why a comprehension check clears it and a deletion test does not: delete each occurrence in turn and see whether the passage still says everything it said.',
  'A speaker judging their own take is a cut, whatever it sounds like. "otra vez", "no, asi no", "again", "scratch that" are stage directions that reached the microphone, and they are followed by another attempt at the same line. One run cut such a retake correctly and kept a second one in the same master, calling it a rhetorical beat, because it judged the delivery rather than the words.',
  'Reporting nothing is a claim to verify, not a way to finish. Save this output and run `vcut semantic check --proposals <yours> --detect <detect.json> --review <this file>`: it exits 2 while a repeated phrase is unnamed by any reason or still present in these lines, and an empty round that has not passed it is a round that stopped without checking. Every run that shipped a repetition reported nothing first.',
  'A phrase check reports under survivingRepeats is still in the render, and no reason removes it. Naming clears unaddressedRepeats; only a cut clears survivingRepeats. Keeping it is a decision to hand a human, not a round to close: say so and stop, rather than reporting the result clean while check exits 2.',
  'A reason naming a kept repeat has to ride on a real cut you are already making: there is no reason-only entry, and a zero-length span is rejected. Put the sentence in the reason of whichever proposal sits nearest, or if the round proposes nothing at all, report the kept repeats in your answer and stop — check reports status valid-with-kept-repeats and exits 0, which is a finished round rather than a pending one.',
  'Keeping a repeat is a valid answer and it belongs in a proposal reason, where check can see it and a human approving the EDL can read it. What separates one worth keeping from a retake is not how it reads but what surrounds it: a retake is followed by another attempt at the same sentence, usually with the speaker marking the discard out loud. A phrase that recurs while the sentence around it moves the idea forward is a callback, and cutting it flattens the writing. One recording carries both, twelve seconds apart, and a run got both right by asking what the second occurrence does rather than whether it repeats.',
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
      ...(argv.includes('--terse')
        ? { instructionsOmitted: INSTRUCTIONS.length }
        : { instructions: INSTRUCTIONS }),
      lines,
    })
    return
  }

  if (subcommand === 'review') {
    // Round one needs the instructions. Round two knows them, and repeating them is the
    // single largest line item in the review payload.
    const terse = argv.includes('--terse')
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
      // 72% of this payload on one measured run, identical in every round. A round that has
      // read them once is paying ~1650 tokens per round to be told the same thing, which is
      // budget that belongs in reading the transcript. --terse drops them and says so.
      ...(terse
        ? { instructionsOmitted: REVIEW_INSTRUCTIONS.length }
        : { instructions: REVIEW_INSTRUCTIONS }),
      masterMeasured: masterPath !== undefined,
      linesFrom: masterTranscript === undefined ? 'source' : 'master',
      unreviewed: unreviewedStretches(lines, gapsBetween(segments), UNREVIEWED_MS),
      repeated: repeatedPhrases(lines),
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
    // Optional, because a first round has no review to check against: the field is born from
    // transcribing a render that does not exist yet. Passed on later rounds, it turns the list
    // of repeated wording from something to read into something to answer.
    const reviewPath = value('--review')
    const { repeated, lines } = readReview(reviewPath)
    // Two ways a repeat goes unanswered, and the second is the one a reason cannot fake: it is
    // still in the render. Naming clears the first, removing it clears the second.
    const unaddressed = unaddressedRepeats(repeated, proposals)
    const surviving = survivingRepeats(repeated, lines)
    // Only the unnamed ones gate. A phrase still in the render is worth reporting and is not a
    // defect on its own: a callback repeats on purpose and reads exactly like a retake to
    // anything counting words. Gating on presence made naming unable to close the loop, so the
    // only move that changed the exit code was cutting further — six runs of one recording, and
    // the line it would have removed was one the author wanted.
    const rejected = issues.length > 0
    emitJson({
      // Three states, not two. 'valid' with a populated survivingRepeats reads the same as a
      // clean run, and a round told that only a cut clears that list can reasonably conclude
      // work remains and cut a callback the author wanted. Naming it is a finished answer, and
      // the status says so rather than leaving the reader to infer it.
      status: rejected
        ? 'rejected'
        : unaddressed.length > 0
          ? 'unaddressed-repeats'
          : surviving.length > 0
            ? 'valid-with-kept-repeats'
            : 'valid',
      accepted: proposals.length,
      issues,
      ...(reviewPath === undefined
        ? {}
        : {
            unaddressedRepeats: unaddressed,
            survivingRepeats: surviving,
          }),
    })
    if (rejected) {
      process.exitCode = 1
    } else if (unaddressed.length > 0) {
      process.exitCode = 2
    }
    return
  }

  throw new UsageError(HELP)
}
