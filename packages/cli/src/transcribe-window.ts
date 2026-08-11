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
      throw new UsageError(
        said.stderr.trim() ||
          'trx could not transcribe the window. Install it, or drop --transcribe and pass --transcript',
      )
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
