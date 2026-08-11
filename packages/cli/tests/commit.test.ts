import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitCommand } from '../src/commit.ts'
import { run } from '../src/exec.ts'
import { readSingleRoundAck } from '../src/rounds-gate.ts'
import { openSession } from '../src/session.ts'

// A tiny, real, ffprobe-able clip: runBuild/runRender shell to ffprobe/ffmpeg for real, so this
// generates a genuine source rather than mocking that boundary. 1s is enough for detect/build to
// have something to work with and keeps every commitCommand call in this file fast.
let fixtureDir: string
let sourcePath: string

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
    roundsGate: { status: string; committedRounds: number; next?: unknown[] }
    next: Array<{ question: string; verb: string }>
  }
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
