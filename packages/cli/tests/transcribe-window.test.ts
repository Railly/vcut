import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Word } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import { carriesAWord, toAbsolute, transcribeWindowWords } from '../src/transcribe-window.ts'

const word = (text: string, startMs: number, endMs: number): Word => ({
  text,
  startsWord: true,
  startMs,
  endMs,
})

// The arithmetic the whole primitive turns on, and the one an agent kept doing by hand across
// three coordinate systems. A clip transcript counts from zero; the source does not.
describe('toAbsolute', () => {
  test('shifts every cue by the offset the clip was cut at', () => {
    expect(toAbsolute([word('conocemos', 412, 690)], 551_000)).toEqual([
      word('conocemos', 551_412, 551_690),
    ])
  })

  test('leaves the text and every other field alone', () => {
    const shifted = toAbsolute([word('ya', 0, 300)], 1_000)
    expect(shifted[0]?.text).toBe('ya')
    expect(shifted[0]?.startsWord).toBe(true)
  })

  test('an offset of zero is the identity', () => {
    expect(toAbsolute([word('uno', 100, 400)], 0)).toEqual([word('uno', 100, 400)])
  })

  test('rounds to whole milliseconds rather than carrying a fraction into a cut boundary', () => {
    const shifted = toAbsolute([word('uno', 100, 400)], 550.4)
    expect(shifted[0]?.startMs).toBe(650)
    expect(shifted[0]?.endMs).toBe(950)
  })

  test('keeps the order it was given, since a word list answers a boundary question', () => {
    const shifted = toAbsolute([word('uno', 0, 100), word('dos', 100, 200)], 5_000)
    expect(shifted.map((entry) => entry.text)).toEqual(['uno', 'dos'])
  })
})

// trx emits cues for its own padding: a 3s tone transcribes to four cues reading " ." at
// zero-width spans. Reporting those as words would put punctuation in a list whose only job is
// to answer "where exactly does this word start".
describe('carriesAWord', () => {
  test('keeps a real word', () => {
    expect(carriesAWord(word('conocemos', 0, 100))).toBe(true)
  })

  test('drops a cue that is only punctuation', () => {
    expect(carriesAWord(word('.', 0, 0))).toBe(false)
    expect(carriesAWord(word('...', 0, 0))).toBe(false)
    expect(carriesAWord(word('¿', 0, 0))).toBe(false)
  })

  test('drops an empty cue', () => {
    expect(carriesAWord(word('', 0, 0))).toBe(false)
    expect(carriesAWord(word('   ', 0, 0))).toBe(false)
  })

  test('keeps a word carrying letters outside ASCII, which is most of what this reads', () => {
    expect(carriesAWord(word('reflexión', 0, 100))).toBe(true)
  })

  test('keeps a number, which is a word a boundary can fall on', () => {
    expect(carriesAWord(word('2026', 0, 100))).toBe(true)
  })
})

// End to end over the real seam, with a stub standing in for trx: the same policy
// nonspeech.test.ts applies to the ~320MB panns model, for the same reason (this suite has no
// business downloading a Whisper model, and CI has no trx at all). ffmpeg is real, so the clip
// is really cut and the offset really comes from the span that was asked for; only the
// transcriber is stubbed, and it is stubbed at the boundary vcut actually owns — a binary
// named trx on PATH, found the same way the real one is.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('transcribeWindowWords against a stub transcriber', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-fresh-words-'))
  const binDir = join(dir, 'bin')
  const mediaPath = join(dir, 'source.wav')
  const originalPath = process.env.PATH

  beforeAll(async () => {
    mkdirSync(binDir, { recursive: true })
    const built = await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=6',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '-y',
      mediaPath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(built.stderr)
    }

    // Mirrors what trx really does with --words: write a word-level SRT beside the clip and
    // report its path in the JSON reply. Clip-relative timings, exactly as a transcriber that
    // has never heard of the source file would emit them, plus one padding cue reading "."
    // like the real one emits, so the filtering is proved rather than assumed. It refuses to
    // run without --words so a regression that drops the flag fails here instead of silently
    // returning no cues.
    writeFileSync(
      join(binDir, 'trx'),
      `#!/usr/bin/env bash
set -euo pipefail
clip=""
outdir="."
words=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    transcribe) shift ;;
    --words) words=1; shift ;;
    --output-dir) outdir="$2"; shift 2 ;;
    --preset|--language) shift 2 ;;
    *) clip="$1"; shift ;;
  esac
done
if [ "$words" -ne 1 ]; then
  echo "stub trx was not asked for --words" >&2
  exit 1
fi
base="$(basename "\${clip%.wav}")"
srt="$outdir/\${base}_clean.wav.srt"
cat > "$srt" <<'SRT'
1
00:00:00,000 --> 00:00:00,010
 .

2
00:00:00,412 --> 00:00:00,690
 conocemos

3
00:00:00,690 --> 00:00:00,980
 ya
SRT
printf '{"success":true,"files":{"srt":"%s"},"text":" conocemos ya"}\\n' "$srt"
`,
    )
    chmodSync(join(binDir, 'trx'), 0o755)
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
  })

  afterAll(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns every word in absolute source ms, not clip ms', async () => {
    const heard = await transcribeWindowWords(mediaPath, 2_000, 5_000, 'es', 'vcut-test-words')
    expect(heard.words.map((entry) => entry.text)).toEqual(['conocemos', 'ya'])
    // The clip's own cues are 412-690 and 690-980; cut at 2000ms they belong at 2412 and 2690.
    // A regression that forgot the offset would report the clip-relative numbers instead, which
    // is the exact defect this primitive exists to stop an agent from shipping.
    expect(heard.words[0]?.startMs).toBe(2_412)
    expect(heard.words[0]?.endMs).toBe(2_690)
    expect(heard.words[1]?.startMs).toBe(2_690)
  })

  test('drops the padding cue rather than reporting punctuation as a word', async () => {
    const heard = await transcribeWindowWords(mediaPath, 0, 3_000, 'es', 'vcut-test-words')
    expect(heard.words.some((entry) => entry.text === '.')).toBe(false)
  })

  test('carries the text back too, so asking for both is one transcription', async () => {
    const heard = await transcribeWindowWords(mediaPath, 0, 3_000, 'es', 'vcut-test-words')
    expect(heard.text).toBe('conocemos ya')
  })

  // The trap the module header names: trx writes its normalisation artifacts to --output-dir,
  // and a caller invoked from any cwd should not find *_clean.wav next to itself afterwards.
  test('leaves nothing behind in tmpdir under its own stem', async () => {
    await transcribeWindowWords(mediaPath, 1_000, 4_000, 'es', 'vcut-test-sweep')
    const strays = readdirSync(tmpdir()).filter((entry) => entry.startsWith('vcut-test-sweep-'))
    expect(strays).toEqual([])
  })
})
