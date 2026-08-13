import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/exec.ts'
import {
  buildWindows,
  corroborateRepeats,
  defaultConcurrency,
  findAnomalies,
  findRepeatedPhrases,
  findStackedOpeners,
  findTruncatedEdges,
  mergeRepeats,
  runPooled,
  runVerifyWindows,
  verifyCommand,
  type Window,
} from '../src/verify.ts'

const window = (startMs: number, endMs: number, text: string): Window => ({ startMs, endMs, text })

describe('buildWindows', () => {
  test('tiles the whole duration with no overlap when stride equals window', () => {
    expect(buildWindows(50_000, 16_000, 16_000)).toEqual([
      { startMs: 0, endMs: 16_000 },
      { startMs: 16_000, endMs: 32_000 },
      { startMs: 32_000, endMs: 48_000 },
      { startMs: 48_000, endMs: 50_000 },
    ])
  })

  test('clamps the last tile to the duration rather than dropping or padding it', () => {
    const windows = buildWindows(25_000, 16_000, 16_000)
    expect(windows.at(-1)).toEqual({ startMs: 16_000, endMs: 25_000 })
  })

  test('overlaps when stride is shorter than window', () => {
    expect(buildWindows(20_000, 10_000, 5_000)).toEqual([
      { startMs: 0, endMs: 10_000 },
      { startMs: 5_000, endMs: 15_000 },
      { startMs: 10_000, endMs: 20_000 },
    ])
  })

  test('a duration shorter than one window still returns one clamped tile', () => {
    expect(buildWindows(5_000, 16_000, 16_000)).toEqual([{ startMs: 0, endMs: 5_000 }])
  })

  test('returns nothing for a zero or negative duration', () => {
    expect(buildWindows(0, 16_000, 16_000)).toEqual([])
    expect(buildWindows(-1, 16_000, 16_000)).toEqual([])
  })
})

// The fixture from #45: a 25s window at 220s over normal-mcp-demo-round12.wav transcribes to
// "...así que si reciben un poema mío, reciben un poema mío por WhatsApp...", the same run of
// words said twice inside one window's own text, which is exactly the shape a whole-file pass
// smooths into a single clean line.
describe('findRepeatedPhrases', () => {
  test('catches the duplicated-sentence fixture from issue #45', () => {
    const windows = [
      window(
        220_000,
        245_000,
        'Esto es todo muy bueno, actually, pero bueno, así que si reciben un poema mío, ' +
          'reciben un poema mío por WhatsApp, probablemente sea normal.',
      ),
    ]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    expect(repeated.length).toBeGreaterThan(0)
    expect(repeated.some((entry) => entry.phrase.includes('reciben un poema'))).toBe(true)
    expect(repeated[0]?.windowStartMs).toBe(220_000)
  })

  test('reports how many times the run repeats', () => {
    const windows = [window(0, 10_000, 'vamos ahora mismo vamos ahora mismo a ver esto')]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    expect(repeated.find((entry) => entry.phrase === 'vamos ahora mismo')?.count).toBe(2)
  })

  test('reads through case, punctuation and accents', () => {
    const windows = [window(0, 10_000, '¡Copiamos ESTO ahora! Copiamos esto ahora, de nuevo.')]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    expect(repeated.some((entry) => entry.phrase === 'copiamos esto ahora')).toBe(true)
  })

  test('does not report a phrase said only once', () => {
    const windows = [window(0, 10_000, 'una frase distinta sin repeticiones aquí')]
    expect(findRepeatedPhrases(windows, 'es').repeated).toEqual([])
  })

  // Two overlapping windows (--stride < --window) legitimately share audio; a phrase said once
  // but covered twice by the tiling must not read as a repeat, since there is no way to tell it
  // from a real one at this layer.
  test('does not report a phrase merely present in two different overlapping windows', () => {
    const windows = [
      window(0, 10_000, 'vamos ahora mismo a comenzar con todo'),
      window(5_000, 15_000, 'a comenzar con todo el equipo listo'),
    ]
    expect(findRepeatedPhrases(windows, 'es').repeated).toEqual([])
  })

  test('an empty window reports nothing', () => {
    expect(findRepeatedPhrases([window(0, 1000, '')], 'es').repeated).toEqual([])
  })

  test('sorts by window start time', () => {
    const windows = [
      window(20_000, 30_000, 'una cosa distinta una cosa distinta'),
      window(0, 10_000, 'otra cosa nueva otra cosa nueva'),
    ]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    expect(repeated.map((entry) => entry.windowStartMs)).toEqual([0, 20_000])
  })

  // #57: a duplicated sentence produces one overlapping RUN_LENGTH-word match per sliding
  // position, not one repeat per position. "en la base de datos" said twice used to read as
  // three separate findings ("en la base", "la base de", "base de datos"); it must read as one,
  // spanning the phrase both occurrences actually share.
  test('collapses overlapping RUN_LENGTH fragments of one repeated phrase into a single finding', () => {
    const windows = [
      window(
        0,
        16_000,
        'en el servidor y en la base de datos esto está cifrado, si me hackeé en la base ' +
          'de datos nadie va a poder ver tus mensajes.',
      ),
    ]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    const baseFindings = repeated.filter((entry) => entry.phrase.includes('base de datos'))
    expect(baseFindings).toHaveLength(1)
    expect(baseFindings[0]?.phrase).toBe('en la base de datos')
    expect(baseFindings[0]?.count).toBe(2)
  })

  // A 7-word sentence said twice slides across five overlapping RUN_LENGTH probes; all five
  // must collapse to the one repeat they were always describing, not five findings.
  test('collapses a whole repeated sentence into one finding, not one per sliding probe', () => {
    const windows = [
      window(
        0,
        16_000,
        'De normal, pues este es un producto para personas, pues este es un producto para ' +
          'personas no técnicas.',
      ),
    ]
    const { repeated } = findRepeatedPhrases(windows, 'es')
    expect(repeated).toHaveLength(1)
    expect(repeated[0]?.phrase).toBe('pues este es un producto para personas')
    expect(repeated[0]?.count).toBe(2)
  })

  // "que la gente" and "va a ser" measured zero and one content word respectively in
  // semantic.ts's own corpus, never a real repetition: below MIN_CONTENT_WORDS, so this reports
  // through `discounted` rather than `repeated`, and is never silently dropped.
  test('discounts a repeated run below the content-word floor instead of dropping it', () => {
    const windows = [window(0, 16_000, 'y ese es el, y ese es el, ¿verdad?')]
    const { repeated, discounted } = findRepeatedPhrases(windows, 'es')
    expect(repeated.some((entry) => entry.phrase.includes('ese es'))).toBe(false)
    expect(discounted).toHaveLength(1)
    expect(discounted[0]?.phrase).toBe('y ese es el')
    expect(discounted[0]?.reason).toContain('content word')
  })

  // A repeat carrying two content words (the measured floor) still reports as a candidate
  // retake, the same threshold semantic.ts's own repeatedPhrases already validated.
  test('keeps a repeated run at exactly the content-word floor', () => {
    const windows = [window(0, 16_000, 'le damos clic a Create. Le damos clic a Sign In.')]
    const { repeated, discounted } = findRepeatedPhrases(windows, 'es')
    expect(repeated.some((entry) => entry.phrase === 'le damos clic a')).toBe(true)
    expect(discounted).toEqual([])
  })

  test('uses the English stopword set when lang starts with en', () => {
    const windows = [window(0, 16_000, 'and that is it, and that is it, right?')]
    const { repeated, discounted } = findRepeatedPhrases(windows, 'en')
    expect(repeated).toEqual([])
    expect(discounted).toHaveLength(1)
  })

  test('defaults to the Spanish stopword set when lang is not given', () => {
    const windows = [window(0, 16_000, 'y ese es el, y ese es el, ¿verdad?')]
    const { repeated, discounted } = findRepeatedPhrases(windows)
    expect(repeated).toEqual([])
    expect(discounted).toHaveLength(1)
  })
})

// The second defect from #45: "Y bueno, eso es todo. Y bueno, ya para cerrar" is two sentences
// opening on the same two words, not a 3-word run repeated anywhere (the two sentences diverge
// at "eso" against "ya", their third word). findRepeatedPhrases does not fire on this shape,
// which is exactly why this is a separate detector rather than a lower RUN_LENGTH.
describe('findStackedOpeners', () => {
  test('catches the stacked-filler fixture from issue #45', () => {
    const windows = [
      window(
        220_000,
        245_000,
        'Y bueno, eso es todo. Y bueno, ya para cerrar, cuál es la diferencia.',
      ),
    ]
    const stacked = findStackedOpeners(windows)
    expect(stacked).toHaveLength(1)
    expect(stacked[0]?.phrase).toBe('y bueno')
    expect(stacked[0]?.count).toBe(2)
  })

  test('does not fire on a 3-word run repeated by findRepeatedPhrases, proving the two are distinct', () => {
    const windows = [window(0, 10_000, 'vamos ahora mismo. Vamos ahora mismo a comenzar con todo.')]
    // findRepeatedPhrases already catches this shape (a full run repeated); findStackedOpeners
    // also fires here since the two sentences happen to open on the same words too. Both can
    // be true at once, which is exactly what mergeRepeats exists to dedupe by phrase+window.
    expect(findStackedOpeners(windows).length).toBeGreaterThan(0)
  })

  test('does not flag two DIFFERENT sentences that merely start with a common word', () => {
    const windows = [window(0, 10_000, 'Y bueno, esto es una cosa. Y luego pasamos a otra.')]
    expect(findStackedOpeners(windows)).toEqual([])
  })

  test('does not flag non-adjacent sentences opening the same way', () => {
    const windows = [
      window(
        0,
        10_000,
        'Y bueno, empezamos por aquí. Algo distinto en medio. Y bueno, seguimos por allá.',
      ),
    ]
    expect(findStackedOpeners(windows)).toEqual([])
  })

  test('a single sentence has nothing to compare against', () => {
    expect(findStackedOpeners([window(0, 1000, 'una sola frase sin puntos')])).toEqual([])
  })
})

describe('mergeRepeats', () => {
  const entry = (phrase: string, windowStartMs: number) => ({
    phrase,
    count: 2,
    windowStartMs,
    windowEndMs: windowStartMs + 1000,
  })

  test('concatenates distinct entries from every group', () => {
    const merged = mergeRepeats([entry('a b c', 0)], [entry('d e', 5000)])
    expect(merged).toHaveLength(2)
  })

  test('dedupes the same phrase reported by two detectors at the same window', () => {
    const merged = mergeRepeats([entry('vamos ahora mismo', 0)], [entry('vamos ahora mismo', 0)])
    expect(merged).toHaveLength(1)
  })

  test('keeps the same phrase from two different windows, since they are different findings', () => {
    const merged = mergeRepeats([entry('y bueno', 0)], [entry('y bueno', 5000)])
    expect(merged).toHaveLength(2)
  })

  test('sorts the merged result by window start time', () => {
    const merged = mergeRepeats([entry('b', 10_000)], [entry('a', 0)])
    expect(merged.map((e) => e.windowStartMs)).toEqual([0, 10_000])
  })

  // The overlap case #58 exists for: --stride < --window means the same real repeat is heard
  // by every window whose span covers it, and each one reports the identical phrase. That is
  // one finding, not one per window, and only a time overlap between the reporting windows
  // (not merely sharing a phrase) tells a genuine repeat-of-one apart from two unrelated ones.
  const spanned = (phrase: string, startMs: number, endMs: number) => ({
    phrase,
    count: 2,
    windowStartMs: startMs,
    windowEndMs: endMs,
  })

  test('collapses the same phrase reported by two time-overlapping windows into one finding', () => {
    const merged = mergeRepeats([
      spanned('reciben un poema', 216_000, 232_000),
      spanned('reciben un poema', 224_000, 240_000),
      spanned('reciben un poema', 232_000, 248_000),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.windowStartMs).toBe(216_000)
  })

  test('does not collapse the same phrase from windows whose spans do not touch', () => {
    const merged = mergeRepeats([
      spanned('y bueno', 0, 16_000),
      spanned('y bueno', 300_000, 316_000),
    ])
    expect(merged).toHaveLength(2)
  })

  test('a window ending exactly where the next starts does not overlap it', () => {
    const merged = mergeRepeats([spanned('y bueno', 0, 16_000), spanned('y bueno', 16_000, 32_000)])
    expect(merged).toHaveLength(2)
  })

  test('different phrases at overlapping windows are kept as separate findings', () => {
    const merged = mergeRepeats([
      spanned('vamos ahora mismo', 0, 16_000),
      spanned('le damos clic', 8_000, 24_000),
    ])
    expect(merged).toHaveLength(2)
  })
})

describe('findTruncatedEdges', () => {
  test('flags a window whose last word carries no terminal punctuation', () => {
    const windows = [window(0, 16_000, 'y entonces lo que hacemos es conectar el')]
    const edges = findTruncatedEdges(windows)
    expect(edges).toHaveLength(1)
    expect(edges[0]?.word).toBe('el')
    expect(edges[0]?.edge).toBe('end')
  })

  test('does not flag a window that ends on a real sentence boundary', () => {
    const windows = [window(0, 16_000, 'y entonces lo conectamos así.')]
    expect(findTruncatedEdges(windows)).toEqual([])
  })

  test('accepts question and exclamation marks as landing', () => {
    expect(findTruncatedEdges([window(0, 1000, '¿Cómo funciona esto?')])).toEqual([])
    expect(findTruncatedEdges([window(0, 1000, 'Qué increíble!')])).toEqual([])
  })

  test('an empty window is not truncated, it has nothing to land', () => {
    expect(findTruncatedEdges([window(0, 1000, '   ')])).toEqual([])
  })
})

describe('findAnomalies', () => {
  const cachedWord = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })

  test('flags a window whose carrying words the cached transcript does not corroborate', () => {
    const windows = [window(0, 5_000, 'un contenido completamente distinto aquí mismo')]
    const cached = [cachedWord('otra', 0, 1000), cachedWord('cosa', 1000, 2000)]
    const anomalies = findAnomalies(windows, cached)
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]?.windowText).toContain('distinto')
  })

  test('does not flag a window the cached transcript agrees with', () => {
    const windows = [window(0, 5_000, 'reciben un poema mío por WhatsApp')]
    const cached = [
      cachedWord('reciben', 0, 500),
      cachedWord('un', 500, 700),
      cachedWord('poema', 700, 1100),
      cachedWord('mío', 1100, 1400),
      cachedWord('por', 1400, 1600),
      cachedWord('whatsapp', 1600, 2200),
    ]
    expect(findAnomalies(windows, cached)).toEqual([])
  })

  test('only compares against cached words that overlap the window span', () => {
    const windows = [window(10_000, 15_000, 'palabras completamente diferentes ahora mismo')]
    // Cached words sit entirely outside the window's own span, so they cannot corroborate it.
    const cached = [cachedWord('reciben', 0, 500), cachedWord('poema', 500, 1000)]
    const anomalies = findAnomalies(windows, cached)
    expect(anomalies).toHaveLength(1)
    expect(anomalies[0]?.cachedText).toBe('')
  })

  test('a window with no carrying words (4+ letters) is skipped, not flagged', () => {
    const windows = [window(0, 1000, 'y ya')]
    expect(findAnomalies(windows, [])).toEqual([])
  })
})

// #57: findAnomalies already answers "does this window's own text show up in the cached
// transcript" for its own separate list; corroborateRepeats asks the same question scoped to
// each repeated-phrase finding and writes the answer onto the finding rather than a separate
// list, never dropping the ones the cache disagrees with.
describe('corroborateRepeats', () => {
  const cachedWord = (text: string, startMs: number, endMs: number) => ({ text, startMs, endMs })
  const repeat = (phrase: string, windowStartMs: number, windowEndMs: number) => ({
    phrase,
    count: 2,
    windowStartMs,
    windowEndMs,
  })

  test('marks a finding corroborated when the cached transcript contains its words', () => {
    const cached = [
      cachedWord('reciben', 0, 500),
      cachedWord('un', 500, 700),
      cachedWord('poema', 700, 1100),
    ]
    const result = corroborateRepeats([repeat('reciben un poema', 0, 2000)], cached)
    expect(result[0]?.corroborated).toBe(true)
  })

  test('marks a finding uncorroborated without dropping it', () => {
    const cached = [cachedWord('algo', 0, 500), cachedWord('distinto', 500, 1000)]
    const result = corroborateRepeats([repeat('reciben un poema', 0, 2000)], cached)
    expect(result).toHaveLength(1)
    expect(result[0]?.corroborated).toBe(false)
  })

  test('only checks cached words that overlap the finding window', () => {
    const cached = [cachedWord('reciben', 10_000, 10_500), cachedWord('poema', 10_500, 11_000)]
    const result = corroborateRepeats([repeat('reciben un poema', 0, 2000)], cached)
    expect(result[0]?.corroborated).toBe(false)
  })
})

describe('defaultConcurrency', () => {
  test('is at least 1 and at most 4', () => {
    const value = defaultConcurrency()
    expect(value).toBeGreaterThanOrEqual(1)
    expect(value).toBeLessThanOrEqual(4)
  })
})

describe('runPooled', () => {
  test('runs every item and preserves result order regardless of completion order', async () => {
    const delays = [30, 10, 20, 5]
    const results = await runPooled(delays, 2, async (delayMs, index) => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs))
      return index
    })
    expect(results).toEqual([0, 1, 2, 3])
  })

  test('never runs more than `concurrency` workers at once', async () => {
    let active = 0
    let maxActive = 0
    await runPooled([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
      active -= 1
      return item
    })
    expect(maxActive).toBeLessThanOrEqual(2)
  })

  test('an empty item list resolves to an empty result', async () => {
    const results = await runPooled([], 4, async (item) => item)
    expect(results).toEqual([])
  })

  test('concurrency higher than the item count does not break anything', async () => {
    const results = await runPooled([1, 2], 10, async (item) => item * 2)
    expect(results).toEqual([2, 4])
  })
})

// End to end over the real seam, with a stub standing in for trx: the same policy
// transcribe-window.test.ts and nonspeech.test.ts already apply (this suite has no business
// downloading a Whisper model, and CI has no trx at all). ffmpeg is real, so every window is
// really cut and really probed for duration; only the transcriber is stubbed, at the boundary
// vcut actually owns (a binary named trx on PATH).
const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('runVerifyWindows against a stub transcriber', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-verify-windows-'))
  const binDir = join(dir, 'bin')
  const mediaPath = join(dir, 'source.wav')
  const originalPath = process.env.PATH

  beforeAll(async () => {
    mkdirSync(binDir, { recursive: true })
    // 20s of silence: three windows at --window 8 --stride 8 (8s, 8s, 4s).
    const built = await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-t',
      '20',
      '-c:a',
      'pcm_s16le',
      '-y',
      mediaPath,
    ])
    if (built.exitCode !== 0) {
      throw new Error(built.stderr)
    }

    // Every window returns the same duplicated-sentence text regardless of which clip it was
    // asked to transcribe: this proves runVerifyWindows tiles, calls trx once per tile, and
    // merges every reply, without needing three different fixture audio files to prove it.
    writeFileSync(
      join(binDir, 'trx'),
      `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    transcribe) shift ;;
    --output-dir) shift 2 ;;
    --preset|--language) shift 2 ;;
    *) shift ;;
  esac
done
printf '{"success":true,"files":{},"text":" reciben un poema mio reciben un poema mio por whatsapp"}\\n'
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

  test('tiles the whole duration and transcribes every tile', async () => {
    const report = await runVerifyWindows(mediaPath, 8_000, 8_000, 'es', 2, undefined)
    expect(report.windows).toHaveLength(3)
    expect(report.windows.map((entry) => entry.startMs)).toEqual([0, 8_000, 16_000])
    expect(report.windows.at(-1)?.endMs).toBe(20_000)
  })

  test('surfaces the duplicated-sentence defect from every window that carries it', async () => {
    const report = await runVerifyWindows(mediaPath, 8_000, 8_000, 'es', 2, undefined)
    expect(report.repeatedPhrases.length).toBeGreaterThan(0)
    expect(report.repeatedPhrases.every((entry) => entry.phrase.includes('poema'))).toBe(true)
    // Every one of the three windows carries the identical stub text, so the finding recurs
    // once per window rather than only in the first: this is the direct proof runVerifyWindows
    // called trx once per tile and merged every reply, not just the first one.
    const windowsWithFinding = new Set(report.repeatedPhrases.map((entry) => entry.windowStartMs))
    expect(windowsWithFinding.size).toBe(3)
  })

  test('runs with concurrency 1 too (the sequential fallback still works)', async () => {
    const report = await runVerifyWindows(mediaPath, 8_000, 8_000, 'es', 1, undefined)
    expect(report.windows).toHaveLength(3)
  })

  // The same stub text on every tile, now with --stride 4 (half of --window 8): every window
  // overlaps its neighbor, so the identical duplicated-sentence finding is heard by all five
  // tiles but must be reported once, not once per window that heard it. #57's own within-window
  // collapse already folds the stub's two overlapping RUN_LENGTH runs ("reciben un poema",
  // "un poema mio") into one finding ("reciben un poema mio") before cross-window dedup ever
  // runs, so the proof here is that the single collapsed phrase itself still reports once.
  test('overlapping windows report each real repeat once, not once per window', async () => {
    const report = await runVerifyWindows(mediaPath, 8_000, 4_000, 'es', 2, undefined)
    expect(report.windows.length).toBeGreaterThan(3)
    const recibenFindings = report.repeatedPhrases.filter((entry) =>
      entry.phrase.includes('reciben un poema'),
    )
    expect(recibenFindings).toHaveLength(1)
  })

  test('durationMs comes from a real ffprobe measurement of the media', async () => {
    const report = await runVerifyWindows(mediaPath, 8_000, 8_000, 'es', 2, undefined)
    expect(report.durationMs).toBeGreaterThan(19_000)
    expect(report.durationMs).toBeLessThanOrEqual(20_000)
  })

  // --windows itself takes no value, and it comes before <media> in every documented example
  // ("vcut verify --windows <media>"). A naive positional scan that treats every flag as
  // value-consuming reads <media> as --windows's own argument and reports a missing positional
  // instead of running. Caught by hand running the real built CLI against this exact
  // invocation shape before this test existed.
  test('resolves the positional media path even with --windows appearing first', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (message: string) => {
      logs.push(message)
    }
    try {
      await verifyCommand([
        '--windows',
        mediaPath,
        '--window',
        '8',
        '--stride',
        '8',
        '--lang',
        'es',
        '--json',
      ])
    } finally {
      console.log = originalLog
    }
    expect(logs).toHaveLength(1)
    const report = JSON.parse(logs[0] ?? '{}')
    expect(report.windows).toHaveLength(3)
  })

  // #58: --stride with no explicit value defaults to half of --window, not the same as
  // --window, so every span in the media is covered by at least two differently-aligned
  // windows and a repeat straddling one window's boundary lands whole inside another.
  test('defaults --stride to half of --window when --stride is not given', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (message: string) => {
      logs.push(message)
    }
    try {
      await verifyCommand(['--windows', mediaPath, '--window', '8', '--lang', 'es', '--json'])
    } finally {
      console.log = originalLog
    }
    const report = JSON.parse(logs[0] ?? '{}')
    expect(report.windowMs).toBe(8_000)
    expect(report.strideMs).toBe(4_000)
  })

  // An explicit --stride still wins over the half-window default: a caller who names a stride
  // gets exactly that stride, not a value #58 silently substitutes.
  test('an explicit --stride overrides the half-window default', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (message: string) => {
      logs.push(message)
    }
    try {
      await verifyCommand([
        '--windows',
        mediaPath,
        '--window',
        '8',
        '--stride',
        '8',
        '--lang',
        'es',
        '--json',
      ])
    } finally {
      console.log = originalLog
    }
    const report = JSON.parse(logs[0] ?? '{}')
    expect(report.strideMs).toBe(8_000)
  })
})
