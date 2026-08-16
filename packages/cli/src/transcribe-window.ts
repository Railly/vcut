/**
 * Cut a window of media and ask the transcriber what it says.
 *
 * `say --transcribe` and `converge` each grew their own copy of this: cut a clip with
 * ffmpeg, run `trx transcribe --preset verbatim` over it, read back the text, delete the
 * clip. Same four steps, same flags, written twice because each command was built to
 * answer its own question and neither looked at the other's source.
 *
 * vcut still calls no model of its own here: this runs the transcriber already on the
 * caller's PATH, the same way every measurement in this codebase runs ffmpeg.
 *
 * `trx transcribe` defaults `--output-dir` to `.`, the caller's cwd, not the input file's
 * directory: the clip itself goes to tmpdir but trx's own normalisation artifacts do not
 * unless told to. Pinning `--output-dir` to the same directory as the clip is what keeps a
 * caller invoked from any cwd (a test runner, an agent's working directory) from scattering
 * `*_clean.wav` and its `.srt` next to itself. This is the exact trap the debug skill names:
 * "artifacts landed in the working directory instead of the directory named by a flag".
 */

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSrt, type Word } from './detect.ts'
import { run } from './exec.ts'
import { has } from './has.ts'
import { UsageError } from './output.ts'

/**
 * A clip's own transcript, and where in the source it came from.
 *
 * `text` is what `transcribeWindow` has always returned. `words` is populated only when the
 * transcription asked for word-level cues, and its timings are already absolute: a clip
 * transcript counts from zero, so every cue is shifted by the offset the clip was cut at
 * before it leaves this module. Nothing downstream should ever have to remember to add it.
 */
export type WindowTranscription = {
  text: string
  words: Word[]
}

const cutClip = async (
  mediaPath: string,
  startMs: number,
  endMs: number,
  clip: string,
): Promise<void> => {
  const cut = await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-ss',
    (startMs / 1000).toFixed(3),
    '-to',
    (endMs / 1000).toFixed(3),
    '-i',
    mediaPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    clip,
  ])
  if (cut.exitCode !== 0) {
    throw new UsageError(cut.stderr.trim() || 'ffmpeg could not cut the window')
  }
}

// trx names its cleaned copy after its own normalisation step ("clip.wav" becomes
// "clip_clean.wav" beside a ".srt"), a suffix this function does not own and should not
// hardcode. Sweeping every file in workDir that starts with this clip's own stem catches
// whatever trx left behind without guessing its naming scheme.
const sweep = (workDir: string, stem: string): void => {
  for (const entry of readdirSync(workDir)) {
    if (entry.startsWith(stem)) {
      rmSync(join(workDir, entry), { force: true })
    }
  }
}

/**
 * Clip time to source time.
 *
 * A clip cut at `offsetMs` is transcribed as its own file, so every cue it produces counts
 * from zero. A word reported at 420ms inside a clip cut at 551000ms happened at 551420ms in
 * the source, and the whole reason this primitive exists is that an agent doing that addition
 * by hand across three coordinate systems is where the last measured defect came from. Pure
 * and exported so the arithmetic is tested without a transcriber in the room.
 */
export const toAbsolute = (words: Word[], offsetMs: number): Word[] =>
  words.map((word) => ({
    ...word,
    startMs: Math.round(word.startMs + offsetMs),
    endMs: Math.round(word.endMs + offsetMs),
  }))

/**
 * A cue carrying no word is not a word.
 *
 * trx emits cues for its own silence padding, which come back as an empty string or a bare
 * "." at zero-width or near-zero-width spans (measured: a 3s tone transcribes to four such
 * cues). Reporting those as words would put punctuation in a word list that exists to answer
 * "where exactly does this word start", so they are dropped here rather than in each caller.
 */
export const carriesAWord = (word: Word): boolean => /[\p{L}\p{N}]/u.test(word.text)

/**
 * trx's own error, when it has one.
 *
 * trx writes a failure as `{"success": false, "error": "..."}` on stdout, not stderr: a caller
 * whose exit code check only reads stderr sees nothing and cannot tell trx's own diagnosis from
 * silence. Missing `--language` under `--preset verbatim` and a file it could not find both come
 * back this way, with exit 1 and empty stderr, which is exactly the shape that used to collapse
 * into "could not transcribe the window, install it".
 */
export const trxStdoutError = (stdout: string): string | undefined => {
  try {
    const parsed = JSON.parse(stdout) as { success?: unknown; error?: unknown }
    return parsed.success === false && typeof parsed.error === 'string' ? parsed.error : undefined
  } catch {
    return undefined
  }
}

// trx names its own flags in the errors it writes. vcut renames some of them at its own CLI
// surface (--lang here for trx's --language), so a message passed through verbatim sends the
// caller looking for a flag vcut does not have (#54 follow-up: `vcut peek --lang es` failed
// with "pass --language", which does not exist in vcut).
const TRX_FLAG_TRANSLATIONS: Array<{ trxFlag: string; vcutFlag: string }> = [
  { trxFlag: '--language', vcutFlag: '--lang' },
]

/**
 * Appends vcut's own flag name wherever trx's message names a flag vcut renames, without
 * altering trx's text: the message still diagnoses the real cause, it just also names the flag
 * that exists here.
 */
export const translateTrxFlags = (message: string): string => {
  let translated = message
  for (const { trxFlag, vcutFlag } of TRX_FLAG_TRANSLATIONS) {
    if (translated.includes(trxFlag)) {
      translated = `${translated} (vcut's own flag for this is ${vcutFlag})`
    }
  }
  return translated
}

/**
 * What actually happened, in order of how much trx told us.
 *
 * 1. trx's own stderr, when it wrote one.
 * 2. trx's own structured error on stdout (see trxStdoutError), which is where the two
 *    measured causes of this failure (missing --language, a window too wide for it to finish)
 *    both showed up with an empty stderr.
 * 3. If neither stream says anything, whether trx is even on PATH at all: only now does
 *    "install it" become an honest thing to say, checked rather than assumed.
 * 4. If trx is installed and still silent, the width of the window asked for, since the one
 *    measured case that reaches this branch (a wide --window succeeding at --window 10) has no
 *    documented ceiling to name, only what was actually asked for.
 *
 * Every returned string passes through translateTrxFlags first: trx's diagnosis is right, but
 * trx names its own flag, not vcut's, and a caller sent hunting for a flag that does not exist
 * here is exactly the friction passing the raw message through was supposed to fix.
 */
export const explainTrxFailure = async (
  said: { stderr: string; stdout: string },
  windowMs: number,
): Promise<string> => {
  const stderr = said.stderr.trim()
  if (stderr) {
    return translateTrxFlags(stderr)
  }
  const stdoutError = trxStdoutError(said.stdout)
  if (stdoutError) {
    return translateTrxFlags(stdoutError)
  }
  if ((await has('trx', ['--version'])) === false) {
    return 'trx is not on PATH. Install it, or drop --transcribe and pass --transcript'
  }
  const windowSeconds = (windowMs / 1000).toFixed(1)
  return `trx is installed but exited with no output transcribing a ${windowSeconds}s window. Try a narrower --window; this is the same shape a window too wide for it to finish took.`
}

const parseWordsFromReply = (stdout: string): Word[] => {
  const parsed = JSON.parse(stdout) as { files?: { srt?: unknown } }
  const srtPath = parsed.files?.srt
  if (typeof srtPath !== 'string' || !existsSync(srtPath)) {
    return []
  }
  return parseSrt(readFileSync(srtPath, 'utf8')).words.filter(carriesAWord)
}

const readText = (stdout: string): string => {
  const parsed = JSON.parse(stdout) as { text?: unknown }
  return typeof parsed.text === 'string' ? parsed.text.replace(/\s+/g, ' ').trim() : ''
}

/**
 * The shared body of both exported forms: cut the clip, transcribe it, read the reply, sweep.
 *
 * `words` asks trx for word-level cues (`--words`, the same flag every transcript in this
 * manual is generated with) and parses the SRT it writes beside the clip. Without it this is
 * exactly the call `say --transcribe`, `converge`, and `peek` have always made.
 */
const transcribeClip = async (
  mediaPath: string,
  startMs: number,
  endMs: number,
  language: string | undefined,
  prefix: string,
  wantWords: boolean,
): Promise<WindowTranscription> => {
  const workDir = tmpdir()
  const stem = `${prefix}-${process.pid}-${startMs}`
  const clip = join(workDir, `${stem}.wav`)
  await cutClip(mediaPath, startMs, endMs, clip)
  try {
    const args = ['transcribe', clip, '--preset', 'verbatim', '--output-dir', workDir]
    if (wantWords) {
      args.push('--words')
    }
    if (language !== undefined) {
      args.push('--language', language)
    }
    const said = await run('trx', args)
    if (said.exitCode !== 0) {
      throw new UsageError(await explainTrxFailure(said, endMs - startMs))
    }
    return {
      text: readText(said.stdout),
      words: wantWords ? toAbsolute(parseWordsFromReply(said.stdout), startMs) : [],
    }
  } finally {
    sweep(workDir, stem)
  }
}

export const transcribeWindow = async (
  mediaPath: string,
  startMs: number,
  endMs: number,
  language: string | undefined,
  prefix = 'vcut',
): Promise<string> =>
  (await transcribeClip(mediaPath, startMs, endMs, language, prefix, false)).text

/**
 * The same window, with every word's absolute start and end in the source.
 *
 * This is the arbiter for a boundary question the whole-file transcript and a plain
 * `--transcribe` window cannot settle between them. Inside a fused region the whole-file pass
 * writes averaged timings (measured: a keeper's start placed at 550740ms when the true
 * boundary was 551300-551600ms, an error large enough to ship a defect), and a short
 * `--transcribe` window returns text with no timings at all, which is what sent one run into
 * a hand bisection of six to eight shrinking windows.
 *
 * It costs one real transcription per call, same as `--transcribe`. What it buys is that the
 * answer arrives as numbers rather than as prose an agent then has to place by ear.
 */
export const transcribeWindowWords = (
  mediaPath: string,
  startMs: number,
  endMs: number,
  language: string | undefined,
  prefix = 'vcut',
): Promise<WindowTranscription> => transcribeClip(mediaPath, startMs, endMs, language, prefix, true)
