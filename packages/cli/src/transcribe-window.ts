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

import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { run } from './exec.ts'
import { UsageError } from './output.ts'

export const transcribeWindow = async (
  mediaPath: string,
  startMs: number,
  endMs: number,
  language: string | undefined,
  prefix = 'vcut',
): Promise<string> => {
  const workDir = tmpdir()
  const clip = join(workDir, `${prefix}-${process.pid}-${startMs}.wav`)
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
  try {
    const args = ['transcribe', clip, '--preset', 'verbatim', '--output-dir', workDir]
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
    const parsed = JSON.parse(said.stdout) as { text?: unknown }
    return typeof parsed.text === 'string' ? parsed.text.replace(/\s+/g, ' ').trim() : ''
  } finally {
    // trx names its cleaned copy after its own normalisation step ("clip.wav" becomes
    // "clip_clean.wav" beside a ".srt"), a suffix this function does not own and should not
    // hardcode. Sweeping every file in workDir that starts with this clip's own stem catches
    // whatever trx left behind without guessing its naming scheme.
    const stem = `${prefix}-${process.pid}-${startMs}`
    for (const entry of readdirSync(workDir)) {
      if (entry.startsWith(stem)) {
        rmSync(join(workDir, entry), { force: true })
      }
    }
  }
}
