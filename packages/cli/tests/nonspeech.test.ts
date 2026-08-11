import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/exec.ts'
import {
  classifierMissing,
  classifyReading,
  hasHesitationToken,
  nonspeechNext,
  runClassifier,
} from '../src/nonspeech.ts'

describe('hasHesitationToken', () => {
  test('matches the conservative set of hesitation sounds', () => {
    expect(hasHesitationToken('eh')).toBe(true)
    expect(hasHesitationToken('Eh,')).toBe(true)
    expect(hasHesitationToken('ehh')).toBe(true)
    expect(hasHesitationToken('ehm')).toBe(true)
    expect(hasHesitationToken('mmm')).toBe(true)
    expect(hasHesitationToken('mhm')).toBe(true)
    expect(hasHesitationToken('aah')).toBe(true)
    expect(hasHesitationToken('aaah')).toBe(true)
  })

  // Stretched vowels are the same token said longer, not a different word: the classifier
  // hit this exists for is exactly a vocalization drawn out past the ordinary length.
  test('tolerates a stretched vowel', () => {
    expect(hasHesitationToken('eeeeh')).toBe(true)
    expect(hasHesitationToken('ehhhhh')).toBe(true)
    expect(hasHesitationToken('mmmmmm')).toBe(true)
  })

  test('is case-insensitive', () => {
    expect(hasHesitationToken('EHHH bueno')).toBe(true)
    expect(hasHesitationToken('MMM no se')).toBe(true)
  })

  // "no sé" is a real phrase, not a hesitation sound. A matcher broad enough to catch it
  // would flag ordinary speech, which is the failure this stays conservative to avoid.
  test('does not match "no sé"', () => {
    expect(hasHesitationToken('no sé')).toBe(false)
    expect(hasHesitationToken('No sé qué decir')).toBe(false)
  })

  test('does not match ordinary words that happen to contain the letters', () => {
    expect(hasHesitationToken('proyectos open source, lanzarlos en Linkedin')).toBe(false)
    expect(hasHesitationToken('mejor así')).toBe(false)
  })

  test('an empty string matches nothing', () => {
    expect(hasHesitationToken('')).toBe(false)
  })
})

describe('classifyReading', () => {
  // The case this command exists for: a stretched "eeeh" the whole-file transcript cleaned
  // away, recovered by re-transcribing the window.
  test('a hesitation token in the window reads as vocalization-suspect', () => {
    expect(classifyReading('Y eeeh, bueno', -12, false)).toBe('vocalization-suspect')
  })

  test('real level with no words inside the span reads as vocalization-suspect', () => {
    expect(classifyReading('palabras alrededor', -25, false)).toBe('vocalization-suspect')
  })

  // A breath in a pause: the window transcribes to ordinary words sitting either side of
  // the span, and the span itself carries no hesitation token and no isolated real level.
  test('ordinary words around the span with no hesitation token read as words-around', () => {
    expect(classifyReading('proyectos open source, lanzarlos en Linkedin', -17.6, true)).toBe(
      'words-around',
    )
  })

  test('no words and no real level reads as empty', () => {
    expect(classifyReading('', null, false)).toBe('empty')
  })

  test('no words and quiet level reads as empty', () => {
    expect(classifyReading('', -55, false)).toBe('empty')
  })

  // words-around only applies once there is something to sit around: no words at all means
  // there is nothing to call "around", so a quiet span with no transcript is empty even when
  // wordsInsideSpan is (degenerately) false.
  test('an empty transcript never reads as words-around', () => {
    expect(classifyReading('   ', -50, false)).toBe('empty')
  })
})

describe('classifierMissing', () => {
  test('reports a path to fix it when files are absent', () => {
    const previous = process.env.VCUT_CLASSIFIER_HOME
    process.env.VCUT_CLASSIFIER_HOME = '/nonexistent/panns-home-for-tests'
    try {
      expect(classifierMissing()).toContain('vcut setup classifier')
    } finally {
      if (previous === undefined) {
        delete process.env.VCUT_CLASSIFIER_HOME
      } else {
        process.env.VCUT_CLASSIFIER_HOME = previous
      }
    }
  })
})

describe('nonspeechNext', () => {
  test('is empty when nothing was found', () => {
    expect(nonspeechNext('/render.mp4', 0)).toEqual([])
  })

  test('names a non-empty question and a non-empty verb when spans exist', () => {
    const hints = nonspeechNext('/render.mp4', 3)
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) {
      expect(hint.question.length).toBeGreaterThan(0)
      expect(hint.verb.length).toBeGreaterThan(0)
    }
    expect(hints.some((hint) => hint.verb.includes('--verify'))).toBe(true)
  })
})

// runClassifier's own contract is "shell to python3, read back JSON": non-speech.py's real
// decode step (load_audio) is itself a plain ffmpeg call with no video-specific flag, the same
// -ac/-ar/-c:a decode every other measurement in this codebase runs against a render. A stub
// script standing in for the real classifier (skipping the ~320MB panns model this suite has
// no business downloading) proves that path end to end against a .wav render: if ffmpeg could
// not read an audio-only render the same way it reads a video one, the stub's own decode would
// fail before it ever got to emit a span.
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)
const hasPython3 = await run('python3', ['--version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg && hasPython3)('runClassifier against an audio-only render', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-nonspeech-audio-only-'))
  const audioOnlyRenderPath = join(dir, 'render.wav')
  const stubScriptPath = join(dir, 'stub-classifier.py')

  beforeAll(async () => {
    const built = await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:a',
      'pcm_s16le',
      '-y',
      audioOnlyRenderPath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(built.stderr)
    }

    // Mirrors non-speech.py's load_audio: decode with ffmpeg into a mono 16kHz wav, no video
    // flag either way, then report one span sized off the decoded sample count so a failed or
    // truncated decode of an audio-only render would show up as a wrong span rather than a
    // silently passing test.
    writeFileSync(
      stubScriptPath,
      `import json, os, subprocess, sys, tempfile, wave
with tempfile.TemporaryDirectory() as work:
    wav_path = os.path.join(work, "audio.wav")
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", sys.argv[1], "-ac", "1", "-ar", "16000",
         "-c:a", "pcm_s16le", "-y", wav_path],
        check=True,
    )
    with wave.open(wav_path, "rb") as handle:
        frames = handle.getnframes()
        rate = handle.getframerate()
durationMs = int(frames * 1000 / rate)
json.dump([{"startMs": 0, "endMs": durationMs}], sys.stdout)
`,
    )
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reads the render and reports a span sized off the decoded audio', async () => {
    const outcome = await runClassifier(stubScriptPath, audioOnlyRenderPath)
    expect('spans' in outcome).toBe(true)
    if ('spans' in outcome) {
      expect(outcome.spans).toHaveLength(1)
      expect(outcome.spans[0]?.startMs).toBe(0)
      // The fixture is a 2s sine wave; a truncated or failed decode of the .wav render would
      // report a duration far short of that instead.
      expect(outcome.spans[0]?.endMs).toBeGreaterThan(1900)
      expect(outcome.spans[0]?.endMs).toBeLessThanOrEqual(2000)
    }
  })
})
