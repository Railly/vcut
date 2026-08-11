/**
 * Where a repeated phrase stops coming back.
 *
 * A retake says the same words every time, so a window opened anywhere inside one returns
 * something grammatically complete that reads like the telling worth keeping. Three separate
 * runs cut the same retake at 61000, 61020 and 61192ms, each about 1772ms short of the boundary
 * that removed it, and each had verified its answer: a window whose start comes from a
 * hypothesis confirms the hypothesis.
 *
 * The test that settles it is the phrase rather than the timestamp — step forward until the
 * wording stops recurring. That was documented as a bash loop to copy, and runs copied it: one
 * ran it twice with nine offsets each, eighteen ffmpeg-plus-transcriber calls to answer one
 * question. The judgement in this pipeline that most often goes wrong was the only one left as
 * a snippet instead of a command.
 *
 * vcut still calls no model of its own. It runs the transcriber already on the caller's PATH,
 * the same way every measurement here runs ffmpeg.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { emitJson, heading, line, nextStep, resolveMode, UsageError } from './output.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut converge - find where a repeated phrase stops coming back

Usage:
  vcut converge <media> --phrase "<words>" --from <sec> [flags]

Flags:
  --phrase <words>      The wording that keeps recurring (required)
  --from <sec>          Where to start stepping (required)
  --to <sec>            Where to give up (default: 12s past --from)
  --step <sec>          How far to move each try (default 0.5)
  --window <sec>        How much audio each try transcribes (default 3.5)
  --lang <code>         Language passed to the transcriber
  --json / --human      Output mode
  --help                Show this message

Reports the first offset whose transcript no longer contains the phrase, and every window it
read on the way. A retake repeats the same words, so any window inside one comes back reading
like a clean start: the phrase leaving is the signal, not a window that parses.`

export type Probe = { atMs: number; text: string; contains: boolean }

const DEFAULT_STEP_S = 0.5
const DEFAULT_WINDOW_S = 3.5
const DEFAULT_SPAN_S = 12

/** Punctuation and case are delivery, not words: a match that respects them finds nothing. */
export const normalise = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Matching the phrase literally is too brittle. A short window is transcribed without the
 * context the rest of the file gives, so the same audio came back as "a la que conocemos" in
 * one window and "ahora que conocemos" in the next: a literal test calls the second one clear
 * and reports a boundary three seconds early, which is the failure this command exists to
 * prevent.
 *
 * Comparing only the carrying words survives that. Short words are grammar and drift between
 * transcriptions of the same audio; a word of four letters or more is what the sentence is
 * about, and a retake repeats those exactly. On the case above this separates cleanly rather
 * than narrowly: every window inside the retake scores 1.00 and every window past it 0.00,
 * so the result does not depend on where the bar sits between them.
 */
const OVERLAP = 0.6
const CARRIES_MEANING = 4

export const containsPhrase = (text: string, phrase: string): boolean => {
  const words = normalise(phrase).split(' ').filter(Boolean)
  // A phrase of nothing but short words has no carrying words to compare, so it falls back to
  // all of them rather than to none.
  const carrying = words.filter((word) => word.length >= CARRIES_MEANING)
  const wanted = carrying.length > 0 ? carrying : words
  if (wanted.length === 0) {
    return false
  }
  const heard = new Set(normalise(text).split(' ').filter(Boolean))
  const hits = wanted.filter((word) => heard.has(word)).length
  return hits / wanted.length >= OVERLAP
}

export const firstClear = (probes: Probe[]): Probe | null =>
  probes.find((probe) => !probe.contains) ?? null

/**
 * The near edge, which this command does not measure and does not need its own instrument for.
 *
 * converge answers the far edge: where the repeated wording stops coming back. The cut ends
 * earlier than that, at the first word of the telling being kept, and nothing here can say
 * where that word starts — every probe is a window whose own start was chosen by the stepping,
 * so its text begins where the loop happened to open it rather than where the speaker did.
 * A run needing that number bisected it by hand with six to eight shrinking `--transcribe`
 * windows.
 *
 * `say --transcribe --words` measures it directly: one transcription of the span between the
 * last window carrying the phrase and the first clear one, returning every word with its
 * absolute start. That makes a second command here redundant — the near edge is a word
 * boundary, and word boundaries have an instrument now. What was missing was not a measurement
 * but the pointer to it, so this emits the exact call with this run's own numbers in it.
 *
 * Span rather than point: the answer sits somewhere between the two edges, and a window that
 * covers both is the one a transcriber can place words in. Language rides along because the
 * probes were transcribed with it and the arbiter has to hear the same language they did.
 */
export const nearEdgeHint = (
  media: string,
  lastWithPhraseMs: number | null,
  boundaryMs: number | null,
  language: string | undefined,
): Array<{ question: string; verb: string }> => {
  if (lastWithPhraseMs === null || boundaryMs === null) {
    return []
  }
  const from = (lastWithPhraseMs / 1000).toFixed(2)
  const through = (boundaryMs / 1000).toFixed(2)
  const lang = language === undefined ? '' : ` --lang ${language}`
  return [
    {
      question: 'where exactly does the telling you are keeping start (the near edge)',
      verb: `vcut say ${media} --transcribe --words --at ${from} --through ${through}${lang}`,
    },
  ]
}

// transcribeWindow lives in transcribe-window.ts now, shared with say --transcribe and
// nonspeech --verify: cut a clip, run trx --preset verbatim over it, read the text back.
const transcribe = (
  media: string,
  startMs: number,
  windowMs: number,
  language: string | undefined,
): Promise<string> =>
  transcribeWindow(media, startMs, startMs + windowMs, language, 'vcut-converge')

const numberFlag = (argv: string[], flag: string, fallback: number): number => {
  const index = argv.indexOf(flag)
  if (index === -1) {
    return fallback
  }
  const parsed = Number(argv[index + 1])
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`${flag} needs a number`)
  }
  return parsed
}

export const convergeCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  const value = (flag: string) => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const positional = argv.find(
    (arg, index) => !arg.startsWith('-') && (index === 0 || !argv[index - 1].startsWith('--')),
  )
  const media = value('--media') ?? positional
  const phrase = value('--phrase')
  const from = value('--from')

  if (media === undefined || phrase === undefined || from === undefined) {
    throw new UsageError(HELP)
  }
  const resolved = resolve(media)
  if (!existsSync(resolved)) {
    throw new UsageError(`no media at ${resolved}`)
  }

  const fromMs = Number(from) * 1000
  if (!Number.isFinite(fromMs)) {
    throw new UsageError('--from needs a position in seconds')
  }
  const toMs = numberFlag(argv, '--to', Number(from) + DEFAULT_SPAN_S) * 1000
  const stepMs = numberFlag(argv, '--step', DEFAULT_STEP_S) * 1000
  const windowMs = numberFlag(argv, '--window', DEFAULT_WINDOW_S) * 1000
  if (stepMs <= 0) {
    throw new UsageError('--step needs to be greater than zero')
  }

  const probes: Probe[] = []
  for (let atMs = fromMs; atMs <= toMs; atMs += stepMs) {
    const text = await transcribe(resolved, atMs, windowMs, value('--lang'))
    const contains = containsPhrase(text, phrase)
    probes.push({ atMs: Math.round(atMs), text, contains })
    // Stopping at the first clear window is the answer, and every further call costs a
    // transcription to confirm something already known.
    if (!contains) {
      break
    }
  }

  const clear = firstClear(probes)
  const lastWithPhrase = [...probes].reverse().find((probe) => probe.contains) ?? null
  const mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const next = nearEdgeHint(
    resolved,
    lastWithPhrase === null ? null : lastWithPhrase.atMs,
    clear === null ? null : clear.atMs,
    value('--lang'),
  )

  if (mode === 'human') {
    const lines = [heading('converge'), line('phrase', phrase)]
    for (const probe of probes) {
      lines.push(
        line(
          `${(probe.atMs / 1000).toFixed(2)}s`,
          `${probe.contains ? 'still there' : 'CLEAR'}  ${probe.text.slice(0, 60)}`,
        ),
      )
    }
    lines.push(
      clear === null
        ? line('result', `still present at ${(toMs / 1000).toFixed(2)}s, widen --to`)
        : line('boundary', `${clear.atMs}ms`),
    )
    if (clear !== null) {
      if (lastWithPhrase !== null) {
        lines.push(
          line('last with it', `${lastWithPhrase.atMs}ms  ${lastWithPhrase.text.slice(0, 55)}`),
        )
      }
      lines.push(
        nextStep(
          `read the line above: the cut ends where that telling starts, nearer ${lastWithPhrase?.atMs ?? clear.atMs}ms than ${clear.atMs}ms`,
        ),
      )
      // The far edge is measured; the near edge is not, and estimating it off a probe's own
      // start is what a hand bisection was already doing badly. Name the command that measures
      // it rather than leaving the reader to derive the span.
      for (const hint of next) {
        lines.push(nextStep(hint.verb))
      }
    }
    console.log(lines.join('\n'))
    return
  }

  emitJson({
    input: resolved,
    phrase,
    windowMs,
    stepMs,
    // Null means it never stopped recurring inside the span searched, which is a reason to
    // widen --to rather than evidence there is nothing to cut.
    // Where the repetition ends. Past where the surviving telling begins, because the last
    // attempt starts before the previous one has finished being recognisable: cutting here
    // removes the opening of the line being kept.
    boundaryMs: clear === null ? null : clear.atMs,
    // The window that still carried the phrase and sat closest to the boundary. Its text is
    // usually the surviving telling in full, and its start is the closer estimate of where to
    // end the cut: on the case measured it sat 308ms from the correct boundary against 808ms
    // for the far edge. Read its text before trusting either number.
    lastWithPhraseMs: lastWithPhrase === null ? null : lastWithPhrase.atMs,
    lastWithPhraseText: lastWithPhrase === null ? null : lastWithPhrase.text,
    means:
      'boundaryMs is the far edge of what is safe to remove; the cut usually ends nearer lastWithPhraseMs, where the telling you keep begins',
    // lastWithPhraseMs is an estimate of the near edge, not a measurement of it: it is where a
    // probe window happened to open, not where the surviving line starts. say --transcribe
    // --words over the span between the two edges measures that word boundary directly, which
    // is the step a run hand-bisected with six to eight shrinking windows.
    next,
    probes,
  })
  if (clear === null) {
    process.exitCode = 1
  }
}
