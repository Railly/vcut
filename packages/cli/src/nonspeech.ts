/**
 * Audible sound that is not language, verified by asking the audio rather than reading
 * about it.
 *
 * The classifier (skills/core/scripts/non-speech.py) finds spans a whole-file transcript
 * cannot see: a breath, a mic bump, a stretched "eeeh" that whisper cleans away even with
 * a verbatim preset. That is the whole point of running it. But the manual's closing rule
 * for those hits used to be `vcut say` against the same whole-file transcript that just
 * proved it cannot see this class of sound — verifying the one instrument that sees against
 * the one instrument that does not. On a real 7.5-minute run (2026-08-10), 18 classifier
 * spans were closed that way, all read as "breath", all four spot-checked against the
 * transcript and cleared. Seven of them were audible "eeeh" fillers the listener caught on
 * the first playback.
 *
 * --verify breaks the circularity: it re-transcribes a short window around each span with
 * trx, the same way `say --transcribe` and `converge` already do, so the answer comes from
 * hearing the window again rather than from re-reading the pass that dropped the sound in
 * the first place.
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { run } from './exec.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import { skillsDir } from './skills-dir.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut nonspeech - find audible sound that is not language

Usage:
  vcut nonspeech <render> [--verify] [--lang <code>] [flags]

Flags:
  --verify        Re-transcribe a window around each span with trx and attach a reading
  --lang <code>   Language passed to the transcriber (--verify only)
  --json / --human  Output mode
  --help          Show this message

Runs the bundled classifier (skills/core/scripts/non-speech.py) against a rendered preview.
Run it on the render, not the source: on raw footage every pause scores as non-speech,
correctly and uselessly.

Needs python3 on PATH, the panns-inference/scipy/numpy packages, and the classifier model
under ~/.vcut/panns (fetch it with vcut setup classifier). Absent is a supported state: this
says so and exits 0, the same way vcut doctor treats a missing classifier, and the check
falls back to a human ear.

--verify closes the loop honestly. Reading the whole-file transcript to check a classifier
hit is circular for this class of sound: the transcript is exactly what could not see it.
--verify cuts a window of the span plus 1.2s of context on each side and asks trx again,
which is the only way to recover a filler the first pass cleaned away.`

export type Span = { startMs: number; endMs: number }

export type Reading = 'vocalization-suspect' | 'words-around' | 'empty'

export type VerifiedSpan = Span & {
  text: string
  peakDb: number | null
  meanDb: number | null
  reading: Reading
}

// Everything the classifier script needs to run at all, independent of --verify.
const CLASSIFIER_HOME = (): string =>
  process.env.VCUT_CLASSIFIER_HOME ?? join(homedir(), '.vcut', 'panns')

const CLASSIFIER_FILES = ['class_labels_indices.csv', 'Cnn14_mAP=0.431.pth']

export const classifierMissing = (): string | null => {
  const home = CLASSIFIER_HOME()
  const missing = CLASSIFIER_FILES.filter((file) => !existsSync(join(home, file)))
  return missing.length === 0 ? null : `not installed, optional. Run vcut setup classifier.`
}

// Context on each side of the span. Long enough to catch a hesitation token whose vowel
// runs past the span the classifier drew, short enough that the window still reads as
// "around this position" rather than "somewhere in this minute".
const CONTEXT_MS = 1200

// Case-insensitive, tolerant of a stretched vowel in either direction: "eh", "ehh", "eeeh",
// "eeehhh" are the same token said longer, which is exactly what a filler sounds like held
// past its ordinary length. "no sé" does not match anything here on purpose — it is a real
// phrase, not a hesitation sound, and a matcher broad enough to catch it would flag ordinary
// speech.
const HESITATION_TOKENS = [
  /\be+h+m?\b/iu, // eh, ehh, eeeh, ehm, eehm
  /\bm+h?m+\b/iu, // mmm, mhm
  /\ba+h+\b/iu, // aah, aaah, aaahhh
]

export const hasHesitationToken = (text: string): boolean =>
  HESITATION_TOKENS.some((pattern) => pattern.test(text))

// Real level, as vcut says everywhere else: audible enough that "no words here" is
// interesting rather than expected.
const REAL_LEVEL_DB = -40

export const classifyReading = (
  text: string,
  peakDb: number | null,
  wordsInsideSpan: boolean,
): Reading => {
  const trimmed = text.trim()
  const hasWords = trimmed !== ''

  if (hasHesitationToken(trimmed)) {
    return 'vocalization-suspect'
  }
  if (!wordsInsideSpan && peakDb !== null && peakDb > REAL_LEVEL_DB) {
    return 'vocalization-suspect'
  }
  if (hasWords) {
    return 'words-around'
  }
  return 'empty'
}

const measureLevel = async (
  path: string,
  startMs: number,
  endMs: number,
): Promise<{ peakDb: number | null; meanDb: number | null }> => {
  const { stderr, exitCode } = await run('ffmpeg', [
    '-v',
    'info',
    '-ss',
    (startMs / 1000).toFixed(3),
    '-to',
    (endMs / 1000).toFixed(3),
    '-i',
    path,
    '-vn',
    '-af',
    'volumedetect',
    '-f',
    'null',
    '-',
  ])
  if (exitCode !== 0) {
    return { peakDb: null, meanDb: null }
  }
  const peak = stderr.match(/max_volume:\s*(-?[\d.]+) dB/)
  const mean = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/)
  return {
    peakDb: peak === null ? null : Number(peak[1]),
    meanDb: mean === null ? null : Number(mean[1]),
  }
}

// A crude "did the window's transcript put any word inside the span itself" check, used
// only to distinguish vocalization-suspect from words-around when there is no hesitation
// token: whether the words the window heard fall inside the span or to either side of it.
// The windowed transcript carries no per-word timing of its own here (it is a short clip,
// not a word-level SRT), so this reads it as prose against the window's own bounds rather
// than claiming per-word timing that was never measured.
const wordsLikelyInsideSpan = (text: string, hasRealLevelInSpan: boolean): boolean => {
  if (text.trim() === '') {
    return false
  }
  // With real level in the span and words in the window, the two are more likely to
  // overlap than not: a window built around one span rarely carries an entire separate
  // sentence unless the span is a pause between them, which real level in the span itself
  // rules out (a pause is quiet by definition).
  return hasRealLevelInSpan
}

export const runClassifier = async (
  scriptPath: string,
  renderPath: string,
): Promise<{ spans: Span[] } | { error: string }> => {
  const result = await run('python3', [scriptPath, renderPath])
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || 'the classifier script failed' }
  }
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ startMs: number; endMs: number }>
    return { spans: parsed.map((entry) => ({ startMs: entry.startMs, endMs: entry.endMs })) }
  } catch {
    return { error: 'the classifier printed something that was not the expected JSON' }
  }
}

// Sequential on purpose: transcribeWindow shells out to trx, which loads a Whisper model
// into memory per call, and this runs once per classifier span. A 7.5-minute render
// produced 18 spans; racing 18 model loads at once is exactly the kind of concurrency that
// chokes a machine already carrying a video editor's memory footprint. measureLevel's ffmpeg
// call is comparatively free, so it still runs alongside its own span's transcription, but
// one span waits for the previous one to finish before starting its own trx call.
export const verifySpan = async (
  renderPath: string,
  span: Span,
  language: string | undefined,
): Promise<VerifiedSpan> => {
  const windowStart = Math.max(0, span.startMs - CONTEXT_MS)
  const windowEnd = span.endMs + CONTEXT_MS
  const [text, level] = await Promise.all([
    transcribeWindow(renderPath, windowStart, windowEnd, language, 'vcut-nonspeech'),
    measureLevel(renderPath, span.startMs, span.endMs),
  ])
  const inside = wordsLikelyInsideSpan(text, level.peakDb !== null && level.peakDb > REAL_LEVEL_DB)
  const reading = classifyReading(text, level.peakDb, inside)
  return { ...span, text, peakDb: level.peakDb, meanDb: level.meanDb, reading }
}

// One span at a time. See the note on verifySpan: each call loads a transcription model,
// and running all of them concurrently is the failure mode this avoids rather than a
// performance nicety.
const verifySpansSequentially = async (
  renderPath: string,
  spans: Span[],
  language: string | undefined,
): Promise<VerifiedSpan[]> => {
  const verified: VerifiedSpan[] = []
  for (const span of spans) {
    verified.push(await verifySpan(renderPath, span, language))
  }
  return verified
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

/** Empty with nothing found: there is nothing to verify. */
export const nonspeechNext = (renderPath: string, spanCount: number) =>
  spanCount === 0
    ? []
    : [{ question: 'verify the spans', verb: `vcut nonspeech ${renderPath} --verify` }]

export const nonspeechCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const positional = argv.find(
    (arg, index) => !arg.startsWith('-') && (index === 0 || !argv[index - 1].startsWith('--')),
  )
  if (positional === undefined) {
    throw new UsageError(HELP)
  }
  const renderPath = resolve(positional)
  if (!existsSync(renderPath)) {
    throw new UsageError(`no render at ${renderPath}`)
  }

  const missing = classifierMissing()
  if (missing !== null) {
    if (mode === 'json') {
      emitJson({ status: 'classifier-absent', detail: missing, spans: [] })
    } else {
      console.log(
        [heading('nonspeech'), line('classifier', missing), nextStep('vcut setup classifier')].join(
          '\n',
        ),
      )
    }
    return
  }

  const scriptPath = join(skillsDir(), 'core', 'scripts', 'non-speech.py')
  if (!existsSync(scriptPath)) {
    if (mode === 'json') {
      emitJson({
        status: 'classifier-absent',
        detail: `script missing at ${scriptPath}`,
        spans: [],
      })
    } else {
      console.log(
        [heading('nonspeech'), line('classifier', `script missing at ${scriptPath}`)].join('\n'),
      )
    }
    return
  }

  const outcome = await runClassifier(scriptPath, renderPath)
  if ('error' in outcome) {
    throw new Error(outcome.error)
  }

  const verify = argv.includes('--verify')
  if (!verify) {
    if (mode === 'json') {
      const next = nonspeechNext(positional, outcome.spans.length)
      emitJson({
        status: 'ok',
        spans: outcome.spans,
        ...(next.length === 0 ? {} : { next }),
      })
    } else {
      const lines = [heading('nonspeech'), line('spans', String(outcome.spans.length))]
      for (const span of outcome.spans) {
        lines.push(line(`${(span.startMs / 1000).toFixed(2)}s`, `${span.endMs - span.startMs}ms`))
      }
      if (outcome.spans.length > 0) {
        lines.push(nextStep(`vcut nonspeech ${positional} --verify`))
      }
      console.log(lines.join('\n'))
    }
    return
  }

  const language = flagValue(argv, '--lang')
  const verified = await verifySpansSequentially(renderPath, outcome.spans, language)

  if (mode === 'json') {
    emitJson({
      status: 'ok',
      verified: true,
      spans: verified,
      means:
        'reading vocalization-suspect is audible and likely a filler; words-around is a breath between words; empty at real level is still a question for a listener',
    })
    return
  }

  const lines = [heading('nonspeech'), line('spans', String(verified.length))]
  for (const span of verified) {
    lines.push(
      line(
        `${(span.startMs / 1000).toFixed(2)}s`,
        `${span.reading}  ${span.text === '' ? '(no words in window)' : span.text}`,
      ),
    )
  }
  const suspects = verified.filter((span) => span.reading === 'vocalization-suspect')
  if (suspects.length > 0) {
    lines.push(
      nextStep(`listen at ${suspects.map((span) => (span.startMs / 1000).toFixed(2)).join(', ')}`),
    )
  }
  console.log(lines.join('\n'))
}
