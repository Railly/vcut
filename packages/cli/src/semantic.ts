import { existsSync, readFileSync } from 'node:fs'

import type { DetectReport, Interval, Transcript, Word } from './detect.ts'
import { parseSrt } from './detect.ts'
import { emitJson, UsageError } from './output.ts'

const HELP = `vcut semantic - hand the transcript to a model, take back cut proposals

Usage:
  vcut semantic export --detect <path> [flags]
  vcut semantic check --proposals <path> --detect <path>

Flags:
  --detect <path>       Report produced by detect (required)
  --proposals <path>    Proposals to validate (check only)
  --help                Show this message

Both subcommands emit JSON: the reader is an agent, not a terminal.

vcut never calls a model. Export gives an agent numbered lines with timings; the
agent writes proposals back as JSON, and 'vcut edl build --semantic <path>' folds
them in. Every proposed cut lands as semanticRisk material and stays unapproved.`

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
  kind: 'false-start' | 'repetition' | 'tangent' | 'filler'
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
  const kinds = new Set(['false-start', 'repetition', 'tangent', 'filler'])
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
  'filler: a discourse marker carrying no meaning here. The same word can be load-bearing elsewhere, so judge it in context.',
  'reason is read by a human deciding whether to approve. Say what is lost, not what rule matched.',
  'Never cut the end of a sentence whose start you kept, or the answer to a question you kept.',
  'Propose nothing when nothing should go. An empty array is a valid answer.',
]

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
