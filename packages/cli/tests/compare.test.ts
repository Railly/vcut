import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COVERED_AT,
  checkReferenceDuration,
  classifyReference,
  compareCommand,
  compareCuts,
  edlCuts,
  edlSourcePath,
  headlineOf,
  KEPT_TOLERANCE,
  keptMs,
  transcribeReference,
} from '../src/compare.ts'
import type { Word } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import type { Edl } from '../src/render-edl.ts'

const segment = (id: string, inMs: number, outMs: number) => ({
  id,
  sourceId: 'source-a',
  inMs,
  outMs,
  approval: 'proposed' as const,
  crop: null,
})

const word = (text: string, startMs: number, endMs: number): Word => ({
  text,
  startsWord: true,
  startMs,
  endMs,
})

// What an EDL removes is the complement of what it keeps. Derived from the segments rather
// than read from a build report, since a reference EDL may not have one.
describe('edlCuts', () => {
  test('reports the gaps between kept spans', () => {
    const cuts = edlCuts(
      [segment('a', 0, 1_000), segment('b', 3_000, 5_000)] as Edl['segments'],
      null,
    )
    expect(cuts).toEqual([{ startMs: 1_000, endMs: 3_000 }])
  })

  test('a segment that does not start at zero means the head was cut', () => {
    const cuts = edlCuts([segment('a', 2_000, 5_000)] as Edl['segments'], null)
    expect(cuts).toEqual([{ startMs: 0, endMs: 2_000 }])
  })

  test('material past the last segment is a tail cut, when the duration is known', () => {
    const cuts = edlCuts([segment('a', 0, 5_000)] as Edl['segments'], 8_000)
    expect(cuts).toEqual([{ startMs: 5_000, endMs: 8_000 }])
  })

  test('without a known duration there is no tail cut to claim', () => {
    expect(edlCuts([segment('a', 0, 5_000)] as Edl['segments'], null)).toEqual([])
  })

  test('an EDL with no segments removes nothing it can name', () => {
    expect(edlCuts([], 8_000)).toEqual([])
  })

  test('sorts segments before deriving gaps, so an unordered EDL is read the same', () => {
    const cuts = edlCuts(
      [segment('b', 3_000, 5_000), segment('a', 0, 1_000)] as Edl['segments'],
      null,
    )
    expect(cuts).toEqual([{ startMs: 1_000, endMs: 3_000 }])
  })

  test('adjacent segments with no gap between them cut nothing', () => {
    expect(
      edlCuts([segment('a', 0, 1_000), segment('b', 1_000, 2_000)] as Edl['segments'], 2_000),
    ).toEqual([])
  })
})

describe('keptMs', () => {
  test('sums the spans the EDL keeps', () => {
    expect(keptMs([segment('a', 0, 1_000), segment('b', 3_000, 5_000)] as Edl['segments'])).toBe(
      3_000,
    )
  })

  test('an empty EDL keeps nothing', () => {
    expect(keptMs([])).toBe(0)
  })
})

describe('edlSourcePath', () => {
  test('reads the source path the EDL already records', () => {
    expect(edlSourcePath({ sources: [{ path: '/tmp/source.mp4' }] } as Edl)).toBe('/tmp/source.mp4')
  })

  test('an EDL naming no source reports null rather than guessing one', () => {
    expect(edlSourcePath({ sources: [] } as unknown as Edl)).toBe(null)
  })
})

// Decided by reading the file, not by its extension: a .json EDL and a .json transcript dump
// would otherwise be called the same thing.
describe('classifyReference', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-compare-classify-'))

  test('JSON with a segments array is an EDL', () => {
    const path = join(dir, 'reference.json')
    writeFileSync(path, JSON.stringify({ segments: [segment('a', 0, 1_000)] }))
    expect(classifyReference(path)).toBe('edl')
  })

  test('JSON without a segments array is not an EDL', () => {
    const path = join(dir, 'other.json')
    writeFileSync(path, JSON.stringify({ words: [] }))
    expect(classifyReference(path)).toBe('media')
  })

  test('an .srt is a transcript', () => {
    expect(classifyReference(join(dir, 'reference.srt'))).toBe('srt')
  })

  test('anything else is media to transcribe', () => {
    expect(classifyReference(join(dir, 'reference.mp4'))).toBe('media')
    expect(classifyReference(join(dir, 'reference.wav'))).toBe('media')
  })
})

describe('compareCuts', () => {
  const sourceWords = [
    word('uno', 0, 900),
    word('dos', 1_000, 1_900),
    word('tres', 2_000, 2_900),
    word('cuatro', 3_000, 3_900),
    word('cinco', 4_000, 4_900),
  ]

  // The primary product: material the human removed that survives into the agent's render.
  test('a reference span the EDL does not touch is missed, at zero coverage', () => {
    const verdict = compareCuts(
      [
        {
          startMs: 2_000,
          endMs: 4_000,
          durationMs: 2_000,
          removedText: 'tres cuatro',
          wordCount: 2,
        },
      ],
      [{ startMs: 8_000, endMs: 9_000 }],
      sourceWords,
    )
    expect(verdict.missed).toHaveLength(1)
    expect(verdict.missed[0]?.coveragePercent).toBe(0)
    expect(verdict.missed[0]?.removedText).toBe('tres cuatro')
  })

  test('a reference span the EDL already covers is not missed', () => {
    const verdict = compareCuts(
      [
        {
          startMs: 2_000,
          endMs: 4_000,
          durationMs: 2_000,
          removedText: 'tres cuatro',
          wordCount: 2,
        },
      ],
      [{ startMs: 1_900, endMs: 4_100 }],
      sourceWords,
    )
    expect(verdict.missed).toEqual([])
  })

  // The bar sits between two clusters rather than inside one: a partly-caught cut still leaves
  // most of what the human removed in the render, which is a finding.
  test('a partly covered reference span below the bar is still missed', () => {
    const verdict = compareCuts(
      [{ startMs: 0, endMs: 10_000, durationMs: 10_000, removedText: 'largo', wordCount: 1 }],
      [{ startMs: 0, endMs: 2_000 }],
      sourceWords,
    )
    expect(verdict.missed).toHaveLength(1)
    expect(verdict.missed[0]?.coveragePercent).toBe(20)
    expect(20 / 100).toBeLessThan(COVERED_AT)
  })

  test('an EDL cut over speech the reference keeps is an overcut, quoting what it removed', () => {
    const verdict = compareCuts([], [{ startMs: 1_000, endMs: 3_000 }], sourceWords)
    expect(verdict.overcut).toHaveLength(1)
    expect(verdict.overcut[0]?.keptText).toBe('dos tres')
    expect(verdict.overcut[0]?.coveragePercent).toBe(0)
  })

  // An EDL cut of pure dead air has no words in it to corroborate. Grading it against a speech
  // alignment reports noise as findings, so it is excluded rather than reported.
  test('a silence-only EDL cut is never reported as an overcut', () => {
    const verdict = compareCuts([], [{ startMs: 6_000, endMs: 8_000 }], sourceWords)
    expect(verdict.overcut).toEqual([])
  })

  test('an EDL cut the reference corroborates is not an overcut', () => {
    const verdict = compareCuts(
      [{ startMs: 1_000, endMs: 3_000, durationMs: 2_000, removedText: 'dos tres', wordCount: 2 }],
      [{ startMs: 1_000, endMs: 3_000 }],
      sourceWords,
    )
    expect(verdict.overcut).toEqual([])
  })

  test('two EDLs that agree completely produce no findings in either direction', () => {
    const verdict = compareCuts(
      [{ startMs: 1_000, endMs: 3_000, durationMs: 2_000, removedText: 'dos tres', wordCount: 2 }],
      [{ startMs: 1_000, endMs: 3_000 }],
      sourceWords,
    )
    expect(verdict).toEqual({ missed: [], overcut: [] })
  })
})

describe('headlineOf', () => {
  test('reports both durations and their delta', () => {
    const headline = headlineOf(
      10_000,
      7_000,
      [{ startMs: 1_000, endMs: 3_000, durationMs: 2_000, removedText: 'dos', wordCount: 1 }],
      [{ startMs: 1_000, endMs: 4_000 }],
      { missed: [], overcut: [] },
    )
    expect(headline.referenceKeptMs).toBe(8_000)
    expect(headline.edlKeptMs).toBe(7_000)
    expect(headline.keptDeltaMs).toBe(-1_000)
    expect(headline.edlCutCount).toBe(1)
    expect(headline.referenceCutCount).toBe(1)
  })

  test('an unknown source duration leaves the reference side null rather than guessing', () => {
    const headline = headlineOf(null, 7_000, [], [], { missed: [], overcut: [] })
    expect(headline.referenceKeptMs).toBe(null)
    expect(headline.keptDeltaMs).toBe(null)
  })

  test('sums the milliseconds behind each verdict count', () => {
    const headline = headlineOf(10_000, 7_000, [], [], {
      missed: [
        {
          startMs: 0,
          endMs: 2_000,
          durationMs: 2_000,
          removedText: 'x',
          wordCount: 1,
          coveragePercent: 0,
        },
      ],
      overcut: [
        { startMs: 5_000, endMs: 6_000, durationMs: 1_000, coveragePercent: 0, keptText: 'y' },
      ],
    })
    expect(headline.missedCount).toBe(1)
    expect(headline.missedMs).toBe(2_000)
    expect(headline.overcutCount).toBe(1)
    expect(headline.overcutMs).toBe(1_000)
  })
})

// Issue #60. referenceKeptMs is derived (source duration minus what the recovery claims) and the
// reference's duration is measurable directly. When they disagree, the derived number is wrong
// and every verdict computed from it is wrong in the same direction, silently.
describe('checkReferenceDuration', () => {
  test('a recovery that matches the measured reference passes', () => {
    const check = checkReferenceDuration(263_000, 263_381)
    expect(check?.withinTolerance).toBe(true)
    expect(check?.deltaMs).toBe(-381)
  })

  // The measured failure that opened the issue: 524.6s claimed against a 263.4s file.
  test('the inflation this guard exists to catch fails it', () => {
    const check = checkReferenceDuration(524_586, 263_381)
    expect(check?.withinTolerance).toBe(false)
    expect(check?.relative).toBeGreaterThan(0.9)
  })

  // Both approved masters leave under 1% of their own media unvoiced at the edges, which is the
  // irreducible gap this tolerance allows for. The guard must not fire on either.
  test('the unvoiced head and tail of a real reference stay inside the tolerance', () => {
    expect(checkReferenceDuration(263_381 - 861, 263_381)?.withinTolerance).toBe(true)
    expect(checkReferenceDuration(551_500 - 450, 551_500)?.withinTolerance).toBe(true)
  })

  test('the check is symmetric: understating the reference fails too', () => {
    expect(checkReferenceDuration(100_000, 263_381)?.withinTolerance).toBe(false)
  })

  test('nothing to check against yields no check rather than a passing one', () => {
    expect(checkReferenceDuration(null, 263_381)).toBe(null)
    expect(checkReferenceDuration(263_000, null)).toBe(null)
    expect(checkReferenceDuration(263_000, 0)).toBe(null)
  })

  test('the tolerance sits an order of magnitude above the measured edge error', () => {
    expect(KEPT_TOLERANCE).toBe(0.05)
    expect(861 / 263_381).toBeLessThan(KEPT_TOLERANCE / 10)
  })
})

// --- End to end -------------------------------------------------------------------------------
//
// Real ffmpeg, real fixtures, a stub standing in for trx: the same policy
// transcribe-window.test.ts applies, for the same reason (this suite has no business
// downloading a Whisper model, and CI has no trx at all). The stub is installed at the boundary
// vcut actually owns, a binary named trx on PATH, so the chunking, the offsetting, and the
// alignment all run for real against cues a transcriber really wrote.

const hasFfmpeg = await run('ffmpeg', ['-version'])
  .then((result) => result.exitCode === 0)
  .catch(() => false)

describe.if(hasFfmpeg)('compare end to end', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vcut-compare-e2e-'))
  const binDir = join(dir, 'bin')
  const sourcePath = join(dir, 'source.wav')
  const referencePath = join(dir, 'reference.wav')
  // A reference that cut nothing: same length as the source, for the overcut direction, where
  // the point is an EDL removing speech a reference kept. Its media has to be as long as its
  // transcript claims, or the sanity check correctly refuses to grade against it.
  const referenceAllPath = join(dir, 'reference-all.wav')
  const sourceSrt = join(dir, 'source.srt')
  const originalPath = process.env.PATH
  const originalSessions = process.env.VCUT_SESSIONS_DIR

  // The source says eight words at one per second. The reference is the same recording with
  // "tres cuatro cinco seis" taken out, which is the cut compare has to recover from nothing
  // but the two word streams.
  const sourceCues = ['uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho']
  const referenceCues = ['uno', 'dos', 'siete', 'ocho']

  const srtStamp = (ms: number): string => {
    const hours = String(Math.floor(ms / 3_600_000)).padStart(2, '0')
    const minutes = String(Math.floor(ms / 60_000) % 60).padStart(2, '0')
    const secs = String(Math.floor(ms / 1_000) % 60).padStart(2, '0')
    const millis = String(ms % 1_000).padStart(3, '0')
    return `${hours}:${minutes}:${secs},${millis}`
  }

  const srtFor = (cues: string[], stepMs: number): string =>
    cues
      .map((text, index) => {
        const startMs = index * stepMs
        return `${index + 1}\n${srtStamp(startMs)} --> ${srtStamp(startMs + 800)}\n ${text}\n`
      })
      .join('\n')

  beforeAll(async () => {
    mkdirSync(binDir, { recursive: true })
    for (const [path, seconds] of [
      [sourcePath, 8],
      [referencePath, 4],
      [referenceAllPath, 8],
    ] as const) {
      const built = await run('ffmpeg', [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=440:duration=${seconds}`,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-y',
        path,
      ])
      if (built.exitCode !== 0) {
        throw new Error(built.stderr)
      }
    }

    writeFileSync(sourceSrt, srtFor(sourceCues, 1_000))

    // Mirrors what trx really does with --words: write a word-level SRT beside the clip and
    // report its path in the JSON reply, with clip-relative timings a transcriber that has
    // never heard of the source file would emit. It answers with the reference's own words,
    // which is what makes the recovered cut list real rather than staged.
    writeFileSync(
      join(binDir, 'trx'),
      `#!/usr/bin/env bash
set -euo pipefail
clip=""
outdir="."
while [ "$#" -gt 0 ]; do
  case "$1" in
    transcribe) shift ;;
    --words) shift ;;
    --output-dir) outdir="$2"; shift 2 ;;
    --preset|--language) shift 2 ;;
    *) clip="$1"; shift ;;
  esac
done
base="$(basename "\${clip%.wav}")"
srt="$outdir/\${base}_clean.wav.srt"
cat > "$srt" <<'SRT'
${srtFor(referenceCues, 1_000)}
SRT
printf '{"success":true,"files":{"srt":"%s"},"text":"${referenceCues.join(' ')}"}\\n' "$srt"
`,
    )
    chmodSync(join(binDir, 'trx'), 0o755)
    process.env.PATH = `${binDir}:${originalPath ?? ''}`
    process.env.VCUT_SESSIONS_DIR = join(dir, 'sessions')
  })

  afterAll(() => {
    if (originalPath === undefined) {
      delete process.env.PATH
    } else {
      process.env.PATH = originalPath
    }
    if (originalSessions === undefined) {
      delete process.env.VCUT_SESSIONS_DIR
    } else {
      process.env.VCUT_SESSIONS_DIR = originalSessions
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const edlAt = (path: string, segments: Array<{ inMs: number; outMs: number }>): string => {
    writeFileSync(
      path,
      JSON.stringify({
        timebase: 'milliseconds',
        sources: [
          {
            id: 'source-a',
            path: sourcePath,
            sha256: 'x'.repeat(64),
            durationMs: 8_000,
            hasVideo: false,
            hasAudio: true,
          },
        ],
        segments: segments.map((span, index) => ({
          id: `segment-${String(index + 1).padStart(3, '0')}`,
          sourceId: 'source-a',
          inMs: span.inMs,
          outMs: span.outMs,
          approval: 'proposed',
          crop: null,
        })),
      }),
    )
    return path
  }

  const capture = async (argv: string[]): Promise<unknown> => {
    const original = console.log
    let captured = ''
    console.log = (value: unknown) => {
      captured += `${String(value)}\n`
    }
    try {
      await compareCommand(argv)
    } finally {
      console.log = original
    }
    return JSON.parse(captured)
  }

  // The whole loop, end to end: an EDL that cut nothing, graded against a reference the CLI
  // has to transcribe and align. The 2.0-6.9s span is the cut the human made, recovered from
  // two word streams and reported as material this EDL leaves in.
  test('recovers the reference cut from media and reports it as missed', async () => {
    const edl = edlAt(join(dir, 'agent.json'), [{ inMs: 0, outMs: 8_000 }])
    const result = (await capture([
      '--edl',
      edl,
      '--reference',
      referencePath,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as {
      referenceKind: string
      referenceTranscriptFrom: string
      headline: { missedCount: number; referenceCutCount: number }
      missed: Array<{
        startMs: number
        endMs: number
        removedText: string
        coveragePercent: number
      }>
    }
    expect(result.referenceKind).toBe('media')
    expect(result.referenceTranscriptFrom).toBe('transcribed')
    expect(result.headline.referenceCutCount).toBe(1)
    expect(result.headline.missedCount).toBe(1)
    expect(result.missed[0]?.startMs).toBe(2_000)
    expect(result.missed[0]?.removedText).toBe('tres cuatro cinco seis')
    expect(result.missed[0]?.coveragePercent).toBe(0)
  })

  test('an EDL that already makes the reference cut reports nothing missed', async () => {
    const edl = edlAt(join(dir, 'agent-good.json'), [
      { inMs: 0, outMs: 2_000 },
      { inMs: 6_900, outMs: 8_000 },
    ])
    const result = (await capture([
      '--edl',
      edl,
      '--reference',
      referencePath,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as { headline: { missedCount: number; overcutCount: number } }
    expect(result.headline.missedCount).toBe(0)
    expect(result.headline.overcutCount).toBe(0)
  })

  // An EDL that cuts speech the reference keeps: the mirror direction.
  test('an EDL cut over speech the reference keeps is reported as an overcut', async () => {
    const edl = edlAt(join(dir, 'agent-overcut.json'), [
      { inMs: 0, outMs: 2_000 },
      { inMs: 6_900, outMs: 8_000 },
    ])
    // Same EDL, but the reference is one that kept everything: nothing was cut, so both of the
    // EDL's own cuts are unsupported.
    const referenceSrtAll = join(dir, 'reference-all.srt')
    writeFileSync(referenceSrtAll, srtFor(sourceCues, 1_000))
    const result = (await capture([
      '--edl',
      edl,
      '--reference',
      referenceAllPath,
      '--reference-transcript',
      referenceSrtAll,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as {
      referenceTranscriptFrom: string
      overcut: Array<{ keptText: string }>
    }
    expect(result.referenceTranscriptFrom).toBe('flag')
    expect(result.overcut.length).toBeGreaterThan(0)
    expect(result.overcut[0]?.keptText).toContain('tres')
  })

  // Issue #60, end to end: a recovery that accounts for only half the reference must not produce
  // a verdict. Here the transcript claims all eight words survived while the reference media is
  // four seconds long, the same shape as the real failure (524.6s claimed, 263.4s of file).
  test('a recovery that contradicts the reference media withholds the verdict', async () => {
    const edl = edlAt(join(dir, 'agent-guard.json'), [
      { inMs: 0, outMs: 2_000 },
      { inMs: 6_900, outMs: 8_000 },
    ])
    const inflated = join(dir, 'reference-inflated.srt')
    writeFileSync(inflated, srtFor(sourceCues, 1_000))
    const result = (await capture([
      '--edl',
      edl,
      '--reference',
      referencePath,
      '--reference-transcript',
      inflated,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as {
      verdictWithheld: boolean
      referenceCheck: { measuredMs: number; withinTolerance: boolean } | null
      headline: { referenceKeptMs: number }
      missed: unknown[]
      overcut: unknown[]
    }
    expect(result.verdictWithheld).toBe(true)
    expect(result.referenceCheck?.withinTolerance).toBe(false)
    expect(result.referenceCheck?.measuredMs).toBeGreaterThan(3_500)
    // The numbers still come back; it is the verdict that is withheld.
    expect(result.headline.referenceKeptMs).toBeGreaterThan(0)
    expect(result.missed).toEqual([])
    expect(result.overcut).toEqual([])
  })

  // The documented bypass: a caller who already has the reference's SRT never pays for the
  // transcription again, and the result is the same one the media path produces.
  test('--reference-transcript skips transcription and lands the same verdict', async () => {
    const referenceSrt = join(dir, 'reference.srt')
    writeFileSync(referenceSrt, srtFor(referenceCues, 1_000))
    const edl = edlAt(join(dir, 'agent-2.json'), [{ inMs: 0, outMs: 8_000 }])
    const result = (await capture([
      '--edl',
      edl,
      '--reference',
      referencePath,
      '--reference-transcript',
      referenceSrt,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as {
      referenceTranscriptFrom: string
      missed: Array<{ startMs: number; removedText: string }>
    }
    expect(result.referenceTranscriptFrom).toBe('flag')
    expect(result.missed[0]?.startMs).toBe(2_000)
    expect(result.missed[0]?.removedText).toBe('tres cuatro cinco seis')
  })

  // An EDL reference states its cut list in source time already, so no alignment runs and no
  // transcription is paid for at all.
  test('an EDL reference is compared directly, with no transcription', async () => {
    const agent = edlAt(join(dir, 'agent-3.json'), [{ inMs: 0, outMs: 8_000 }])
    const reference = edlAt(join(dir, 'reference-edl.json'), [
      { inMs: 0, outMs: 2_000 },
      { inMs: 6_900, outMs: 8_000 },
    ])
    const result = (await capture([
      '--edl',
      agent,
      '--reference',
      reference,
      '--transcript',
      sourceSrt,
      '--json',
    ])) as {
      referenceKind: string
      referenceTranscriptFrom: string | null
      missed: Array<{ startMs: number; endMs: number; removedText: string }>
    }
    expect(result.referenceKind).toBe('edl')
    expect(result.referenceTranscriptFrom).toBe(null)
    expect(result.missed).toHaveLength(1)
    expect(result.missed[0]?.startMs).toBe(2_000)
    expect(result.missed[0]?.endMs).toBe(6_900)
    expect(result.missed[0]?.removedText).toContain('tres')
  })

  // Progress is a diagnostic, not the result: it goes to stderr the way render streams its
  // ffmpeg reports, so stdout stays parseable.
  test('transcribing a reference reports one progress line per chunk', async () => {
    const messages: string[] = []
    const words = await transcribeReference(referencePath, 4_000, 2_000, 'es', (message) => {
      messages.push(message)
    })
    expect(messages.length).toBe(3)
    expect(messages[0]).toContain('transcribing reference 1/2')
    expect(messages[2]).toContain('transcribed reference')
    expect(words.length).toBeGreaterThan(0)
  })

  test('--human renders a summary rather than JSON', async () => {
    const edl = edlAt(join(dir, 'agent-human.json'), [{ inMs: 0, outMs: 8_000 }])
    const original = console.log
    let captured = ''
    console.log = (value: unknown) => {
      captured += `${String(value)}\n`
    }
    try {
      await compareCommand([
        '--edl',
        edl,
        '--reference',
        referencePath,
        '--reference-transcript',
        join(dir, 'reference.srt'),
        '--transcript',
        sourceSrt,
        '--human',
      ])
    } finally {
      console.log = original
    }
    expect(captured).toContain('missed')
    expect(captured).toContain('tres cuatro cinco seis')
    expect(() => JSON.parse(captured)).toThrow()
  })

  // The global flags contract, same as every other command: --human alongside --jq is a
  // contradiction rather than a preference to arbitrate silently.
  test('--human with --jq is a usage error', async () => {
    const edl = edlAt(join(dir, 'agent-conflict.json'), [{ inMs: 0, outMs: 8_000 }])
    expect(
      compareCommand(['--edl', edl, '--reference', referencePath, '--human', '--jq', '.missed']),
    ).rejects.toThrow(/mutually exclusive/)
  })

  test('a missing reference is a usage error naming the path', async () => {
    const edl = edlAt(join(dir, 'agent-missing.json'), [{ inMs: 0, outMs: 8_000 }])
    expect(
      compareCommand(['--edl', edl, '--reference', join(dir, 'nope.wav'), '--json']),
    ).rejects.toThrow(/no reference at/)
  })

  test('a source with no cached session and no --transcript says which flag is missing', async () => {
    const edl = edlAt(join(dir, 'agent-no-transcript.json'), [{ inMs: 0, outMs: 8_000 }])
    expect(compareCommand(['--edl', edl, '--reference', referencePath, '--json'])).rejects.toThrow(
      /--transcript/,
    )
  })
})
