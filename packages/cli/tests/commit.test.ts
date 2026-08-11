import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitCommand } from '../src/commit.ts'
import { cutCommand } from '../src/cut.ts'
import { runDetect } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import { diffMetaSpeech } from '../src/rounds.ts'
import { readSingleRoundAck } from '../src/rounds-gate.ts'
import {
  cachedTranscriptPath,
  openSession,
  pointCachedTranscriptAtSession,
  readMetaSpeech,
  writeCachedDetect,
} from '../src/session.ts'

// A tiny, real, ffprobe-able clip: runBuild/runRender shell to ffprobe/ffmpeg for real, so this
// generates a genuine source rather than mocking that boundary. 1s is enough for detect/build to
// have something to work with and keeps every commitCommand call in this file fast.
let fixtureDir: string
let sourcePath: string
// A longer clip for the metaSpeech describe block (#38): a marker cut has to leave kept material
// on both sides to produce a real gap `gapsBetween` can see — `gapsBetween` only reports what
// sits *between* two kept segments, so a cut spanning all the way from t=0 on the 1s fixture
// above leaves a single kept segment and no detectable gap at all, which is a property of that
// fixture's duration, not of the metaSpeech pass itself.
let longSourcePath: string

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vcut-commit-fixture-'))
  sourcePath = join(fixtureDir, 'source.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:d=1:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    sourcePath,
  ])

  longSourcePath = join(fixtureDir, 'source-long.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:d=3:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    longSourcePath,
  ])
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

let workDir: string
let mediaPath: string
let originalSessionsDir: string | undefined
let originalCwd: string
let originalLog: typeof console.log
let logged: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vcut-commit-test-'))
  mediaPath = join(workDir, 'source.mp4')
  writeFileSync(mediaPath, readFileSync(sourcePath))
  originalSessionsDir = process.env.VCUT_SESSIONS_DIR
  process.env.VCUT_SESSIONS_DIR = join(workDir, 'sessions')
  originalCwd = process.cwd()
  process.chdir(workDir)
  originalLog = console.log
  logged = ''
  console.log = (...args: unknown[]) => {
    logged += args.join(' ')
  }
})

afterEach(() => {
  console.log = originalLog
  process.chdir(originalCwd)
  rmSync(workDir, { recursive: true, force: true })
  if (originalSessionsDir === undefined) {
    delete process.env.VCUT_SESSIONS_DIR
  } else {
    process.env.VCUT_SESSIONS_DIR = originalSessionsDir
  }
})

let commitCallIndex = 0

// Each call renders to its own output: the renderer refuses to overwrite (matches the manual's
// documented per-round rule), so a second commit in the same test needs its own path exactly
// the way a real second round would name round-2 output distinctly from round-1's.
const commit = async (extraArgs: string[] = []) => {
  commitCallIndex += 1
  await openSession(mediaPath)
  await commitCommand([
    mediaPath,
    '--output',
    join(workDir, `master-${commitCallIndex}.mp4`),
    '--campaign',
    'gate-test',
    '--edl',
    join(workDir, `edl-${commitCallIndex}.json`),
    '--json',
    ...extraArgs,
  ])
  return JSON.parse(logged) as {
    status: string
    sessionDir: string
    roundDir: string
    roundsGate: { status: string; committedRounds: number; next?: unknown[] }
    metaSpeech: Array<{ text: string; startMs: number; endMs: number; nearestRef: string | null }>
    metaSpeechChecked: boolean
    next: Array<{ question: string; verb: string }>
  }
}

const srt = (entries: Array<[string, string, string]>): string =>
  entries
    .map(([start, end, text], index) => `${index + 1}\n${start} --> ${end}\n${text}`)
    .join('\n\n')

// Swaps `mediaPath` to the 3s fixture for a single test, so a cut inside it leaves real kept
// material on both sides. `commit`/`openWithTranscript` below always read the module-level
// `mediaPath`, so this only needs to run once at the top of a test.
const useLongMedia = () => {
  mediaPath = join(workDir, 'source-long.mp4')
  writeFileSync(mediaPath, readFileSync(longSourcePath))
}

// Mirrors what `vcut open <media> --transcript <path>` caches into a session — detect, then the
// transcript copy, then the same write-back `open` runs — using the lower-level primitives
// directly (the way this file's own `commit` helper already bypasses `openCommand`'s CLI
// parsing), so a test controls exactly what transcript.srt commit's metaSpeech pass reads.
const openWithTranscript = async (transcriptSrt: string) => {
  const transcriptPath = join(workDir, `transcript-${Math.random().toString(36).slice(2)}.srt`)
  writeFileSync(transcriptPath, transcriptSrt)
  const session = await openSession(mediaPath)
  const report = await runDetect({
    input: mediaPath,
    preset: 'noisy',
    minSilenceMs: 300,
    marginMs: 100,
    lang: 'es',
    transcriptPath,
    audioPath: null,
    skipVideoScan: true,
  })
  writeCachedDetect(session.dir, report)
  writeFileSync(cachedTranscriptPath(session.dir), readFileSync(transcriptPath, 'utf8'))
  pointCachedTranscriptAtSession(session.dir, report)
  return session
}

describe('commit surfaces the rounds gate (#36)', () => {
  test('the first commit reports insufficient-rounds and next hints toward a real second pass, not approval', async () => {
    const output = await commit()
    expect(output.roundsGate.status).toBe('insufficient-rounds')
    expect(output.roundsGate.committedRounds).toBe(1)
    const verbs = output.next.map((hint) => hint.verb).join(' | ')
    expect(verbs).toContain('trx transcribe')
    expect(verbs).toContain('vcut semantic review')
    expect(verbs).toContain('vcut commit')
    // The approval-shaped hint ("vcut render --mode master") must NOT appear below the floor:
    // that is exactly the framing the issue's run-3 defect shipped under.
    expect(verbs).not.toContain('--mode master')
  })

  test('a second commit on the same session reports converged-pending-review', async () => {
    await commit()
    logged = ''
    const output = await commit()
    expect(output.roundsGate.status).toBe('converged-pending-review')
    expect(output.roundsGate.committedRounds).toBe(2)
  })

  test('--single-round on the first commit records an acknowledged override instead of refusing', async () => {
    const output = await commit(['--single-round'])
    expect(output.roundsGate.status).toBe('acknowledged-single-round')
    expect(output.roundsGate.committedRounds).toBe(1)
  })

  test('--single-round writes single-round-ack.json into the session, a visible deliberate act', async () => {
    await openSession(mediaPath)
    const session = await openSession(mediaPath)
    expect(readSingleRoundAck(session.dir)).toBeNull()
    await commitCommand([
      mediaPath,
      '--output',
      join(workDir, 'master.mp4'),
      '--campaign',
      'gate-test',
      '--single-round',
      '--json',
    ])
    const ack = readSingleRoundAck(session.dir)
    expect(ack).not.toBeNull()
    expect(ack?.atRound).toBe(1)
  })

  test('without --single-round, no ack is ever written, even after a commit', async () => {
    await commit()
    const session = await openSession(mediaPath)
    expect(readSingleRoundAck(session.dir)).toBeNull()
  })
})

// The marker sits mid-clip on the 3s fixture, with kept material on both sides (unlike the 1s
// fixture used above), so a cut over it leaves a real gap `gapsBetween` can detect.
const MARKER_SRT = srt([
  ['00:00:01,400', '00:00:01,900', ' ah, ok, otra, rebobinando desde el inicio'],
])

describe('commit auto-runs metaSpeech against the session transcript (#38)', () => {
  test('a marker outside every proposal surfaces in metaSpeech, the human report, and next hints first', async () => {
    useLongMedia()
    await openWithTranscript(MARKER_SRT)
    const output = await commit()

    expect(output.metaSpeechChecked).toBe(true)
    expect(output.metaSpeech.length).toBeGreaterThan(0)
    expect(output.metaSpeech[0].text).toContain('rebobinando')

    // Named before every other hint (#38's rank-1 fix), including the rounds gate's own
    // insufficient-rounds hints this session also carries at round 1.
    expect(output.next[0].question).toContain('metaSpeech')
    expect(output.next[0].question).toContain('not cut')

    commitCallIndex += 1
    logged = ''
    await commitCommand([
      mediaPath,
      '--output',
      join(workDir, `master-${commitCallIndex}.mp4`),
      '--campaign',
      'gate-test',
      '--edl',
      join(workDir, `edl-${commitCallIndex}.json`),
      '--human',
    ])
    expect(logged).toContain('metaSpeech')
    expect(logged).toContain('not cut')
  })

  test('a marker covered by a proposal does not surface', async () => {
    useLongMedia()
    await openWithTranscript(MARKER_SRT)
    // 1200..2100, not the marker's own 1400..1900: `edl build`'s default 100ms margin pads the
    // kept segments on both sides of a cut inward and the fixture's 10fps snaps each boundary to
    // a 100ms frame center on top of that, so the gap `gapsBetween` actually reports is narrower
    // than the proposal by more than the margin alone. Measured directly against this fixture:
    // a 1200..2100 proposal produces a 1350..2050 gap, which fully contains the marker line.
    await cutCommand([
      mediaPath,
      '--start-ms',
      '1200',
      '--end-ms',
      '2100',
      '--kind',
      'filler',
      '--reason',
      'spoken rewind marker, cutting the whole line',
      '--json',
    ])
    logged = ''
    const output = await commit()
    expect(output.metaSpeechChecked).toBe(true)
    expect(output.metaSpeech).toEqual([])
  })

  test('an unchecked session (no transcript) reports metaSpeechChecked: false and an empty array, never silently absent', async () => {
    const output = await commit()
    expect(output.metaSpeechChecked).toBe(false)
    expect(output.metaSpeech).toEqual([])
    // Not confused with a clean, checked round: no metaSpeech hint jumps the queue when there
    // was nothing to check in the first place.
    expect(output.next[0].question).not.toContain('metaSpeech')
  })

  test('rounds --diff reports metaSpeech findings addressed by the next round as no longer standing', async () => {
    useLongMedia()
    await openWithTranscript(MARKER_SRT)
    const first = await commit()
    expect(first.metaSpeech.length).toBeGreaterThan(0)

    const spansBefore = readMetaSpeech(first.sessionDir, 1)
    expect(spansBefore).not.toBeNull()
    expect(spansBefore?.length).toBeGreaterThan(0)

    // Round 2 commits with no new proposals — same transcript, same session — so the marker's
    // line still sits outside every cut and metaSpeech reports it standing, not addressed.
    logged = ''
    const second = await commit()
    expect(second.metaSpeech.length).toBeGreaterThan(0)

    const diff = diffMetaSpeech(
      readMetaSpeech(first.sessionDir, 1),
      readMetaSpeech(first.sessionDir, 2),
    )
    expect(diff).not.toBeNull()
    const standing = (diff ?? []).filter((entry) => entry.status === 'standing')
    expect(standing.length).toBeGreaterThan(0)
  })

  test('rounds --diff reports a metaSpeech finding addressed by the next round as no longer standing', async () => {
    useLongMedia()
    await openWithTranscript(MARKER_SRT)
    const first = await commit()
    expect(first.metaSpeech.length).toBeGreaterThan(0)

    // 1200..2100, not the marker's own 1400..1900: see the margin/frame-snap note above.
    await cutCommand([
      mediaPath,
      '--start-ms',
      '1200',
      '--end-ms',
      '2100',
      '--kind',
      'filler',
      '--reason',
      'spoken rewind marker, cutting the whole line, folded back in after round 1',
      '--json',
    ])
    logged = ''
    const second = await commit()
    expect(second.metaSpeech).toEqual([])

    const diff = diffMetaSpeech(
      readMetaSpeech(first.sessionDir, 1),
      readMetaSpeech(first.sessionDir, 2),
    )
    expect(diff).not.toBeNull()
    const statuses = (diff ?? []).map((entry) => entry.status)
    expect(statuses).toContain('addressed')
    expect(statuses).not.toContain('standing')
  })
})
