/**
 * What is being said at a position, and how loud it is there.
 *
 * Reviewing a cut asks this constantly, and answering it by hand is four steps: extract a
 * window with ffmpeg, transcribe it, read the text, throw away the files. One session ran
 * that loop about 28 times and left 51 stray wav files behind.
 *
 * The steps are not the real cost. Transcribing a short slice returns noise no matter what
 * the audio contains, so a gibberish result cannot tell a real word from a hallucination —
 * and in that session it was read as proof of a hallucination that was not there. This reads
 * an existing transcript instead of slicing and re-transcribing, which sidesteps the trap
 * entirely: a word is reported because a transcript says it is there, not because a model
 * was asked to guess from a fragment.
 *
 * vcut never calls a model, here as everywhere else.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseSrt, type Word } from './detect.ts'
import { run } from './exec.ts'
import { masterToSource, placements } from './locate.ts'
import { emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import type { Edl } from './render-edl.ts'
import { transcribeWindow } from './transcribe-window.ts'

const HELP = `vcut say - read back what is spoken at a position

Usage:
  vcut say <media> --transcript <path> --at <seconds> [flags]
  vcut say <media> --transcribe --at <seconds> [flags]

Flags:
  --transcript <path>   Word-level SRT to read from (required unless --transcribe)
  --transcribe          Ask the audio instead of the transcript: cuts the window and runs
                        trx over it. The answer a fused region cannot give from text
  --lang <code>         Language passed to the transcriber (--transcribe only)
  --at <sec>            Position to read around, or the start of a range with --through
  --through <sec>       Read everything from --at to here, instead of a window around --at
  --window <sec>        How much context to include (default 2)
  --media <path>        Media to measure the level on, if not the positional argument
  --edl <path>          Report which segment the position falls in
  --json / --human      Output mode
  --help                Show this message

Reads the transcript rather than re-transcribing a slice. A window shorter than a couple of
seconds transcribes as noise whatever it contains, so a slice cannot tell a real word from a
model's guess; the transcript already knows.`

export type Spoken = {
  atMs: number
  windowMs: number
  text: string
  words: Array<{ text: string; startMs: number; endMs: number }>
  peakDb: number | null
  meanDb: number | null
}

/**
 * Every word whose span touches the window, in order. Touching rather than containment: a
 * word straddling the edge is exactly the one a boundary question is about.
 */
export const wordsInWindow = (words: Word[], startMs: number, endMs: number): Word[] =>
  words.filter((word) => word.endMs > startMs && word.startMs < endMs)

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

/**
 * Level over the window. Peak is what separates "nothing was said here" from "something was
 * said and the transcript missed it", which is the distinction a silent span needs.
 */
const measureLevel = async (
  path: string,
  startMs: number,
  endMs: number,
): Promise<{ peakDb: number | null; meanDb: number | null }> => {
  const { stderr, exitCode } = await run('ffmpeg', [
    '-v',
    'info',
    '-ss',
    seconds(startMs),
    '-to',
    seconds(endMs),
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

// Reading an existing transcript is the cheap path and stays the default. It is also the wrong
// one over a fused region, where the whole-file pass wrote once what the audio says three times
// and no amount of re-reading recovers the difference. There the only answer is to ask the audio
// again over a shorter span, which a run did fifteen times by hand with ffmpeg and trx before
// this flag existed. transcribeWindow lives in transcribe-window.ts now, shared with converge
// and nonspeech --verify, which needed the identical four steps for the identical reason.

export const sayCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))

  const positional = argv.find(
    (arg, index) => !arg.startsWith('-') && (index === 0 || !argv[index - 1].startsWith('--')),
  )
  const mediaPath = flagValue(argv, '--media') ?? positional
  const transcriptPath = flagValue(argv, '--transcript')
  const at = numericFlag(argv, '--at')

  const transcribe = argv.includes('--transcribe')
  if (at === undefined || (transcriptPath === undefined && !transcribe)) {
    throw new UsageError(HELP)
  }
  if (transcribe && mediaPath === undefined) {
    throw new UsageError('--transcribe needs the media to read from')
  }
  const resolvedTranscript = transcriptPath === undefined ? undefined : resolve(transcriptPath)
  if (resolvedTranscript !== undefined && !existsSync(resolvedTranscript)) {
    throw new UsageError(`no transcript at ${resolvedTranscript}`)
  }

  // A range, because reading a passage is as common as reading a point and doing it through
  // --at means guessing a window that covers it. A run wrote its own SRT parser to get this,
  // thirty lines reimplementing what this command already had loaded, and then called it nine
  // times over nine spans.
  const throughSeconds = numericFlag(argv, '--through')
  const windowSeconds = numericFlag(argv, '--window') ?? 2
  const atMs = at * 1000
  const windowMs =
    throughSeconds === undefined ? windowSeconds * 1000 : throughSeconds * 1000 - atMs
  const startMs = throughSeconds === undefined ? Math.max(0, atMs - windowMs / 2) : atMs
  const endMs = throughSeconds === undefined ? atMs + windowMs / 2 : throughSeconds * 1000
  if (throughSeconds !== undefined && endMs <= startMs) {
    throw new UsageError('--through has to come after --at')
  }

  const transcript =
    resolvedTranscript === undefined ? null : parseSrt(readFileSync(resolvedTranscript, 'utf8'))
  const words = transcript === null ? [] : wordsInWindow(transcript.words, startMs, endMs)

  let level: { peakDb: number | null; meanDb: number | null } = { peakDb: null, meanDb: null }
  if (mediaPath !== undefined) {
    const resolvedMedia = resolve(mediaPath)
    if (!existsSync(resolvedMedia)) {
      throw new UsageError(`no media at ${resolvedMedia}`)
    }
    level = await measureLevel(resolvedMedia, startMs, endMs)
  }

  const edlPath = flagValue(argv, '--edl')
  let segment: { id: string; sourceMs: number } | null = null
  if (edlPath !== undefined) {
    const resolvedEdl = resolve(edlPath)
    if (!existsSync(resolvedEdl)) {
      throw new UsageError(`no EDL at ${resolvedEdl}`)
    }
    const edl = JSON.parse(readFileSync(resolvedEdl, 'utf8')) as Edl
    const hit = masterToSource(placements(edl), atMs)
    segment = hit === null ? null : { id: hit.placement.id, sourceMs: hit.sourceMs }
  }

  const heard = transcribe
    ? await transcribeWindow(
        resolve(mediaPath as string),
        startMs,
        endMs,
        flagValue(argv, '--lang'),
        'vcut-say',
      )
    : null
  const text = heard ?? words.map((word) => word.text).join(' ')

  if (mode === 'json') {
    emitJson({
      atMs,
      windowMs,
      text,
      words: words.map((word) => ({
        text: word.text,
        startMs: word.startMs,
        endMs: word.endMs,
      })),
      peakDb: level.peakDb,
      meanDb: level.meanDb,
      ...(edlPath === undefined ? {} : { segment }),
      ...(transcript === null || transcript.wordLevel
        ? {}
        : { warning: 'transcript is not word-level' }),
    })
    return
  }

  const lines = [
    heading('say'),
    line(`at ${seconds(atMs)}`, text === '' ? '(no words here)' : text),
  ]
  if (level.peakDb !== null) {
    lines.push(
      line(
        'level',
        `peak ${level.peakDb} dB${level.meanDb === null ? '' : `, mean ${level.meanDb} dB`}`,
      ),
    )
  }
  // A window with no words but real level is the interesting case: something is audible that
  // the transcript never saw, which is what the classifier exists to catch.
  if (text === '' && level.peakDb !== null && level.peakDb > -40) {
    lines.push(line('note', 'audible, but no words here. Run the non-speech classifier'))
  }
  if (segment !== null) {
    lines.push(line('segment', `${segment.id}, source ${seconds(segment.sourceMs)}`))
  }
  if (transcript !== null && !transcript.wordLevel) {
    lines.push(line('warning', 'transcript is not word-level'))
  }
  console.log(lines.join('\n'))
}
