import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { roundsCommand } from '../src/rounds-command.ts'
import { acknowledgeSingleRound } from '../src/rounds-gate.ts'
import { nextRoundDir, openSession, writeRound } from '../src/session.ts'

let workDir: string
let mediaPath: string
let originalSessionsDir: string | undefined
let originalLog: typeof console.log
let logged: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vcut-rounds-command-test-'))
  mediaPath = join(workDir, 'source.mp4')
  writeFileSync(mediaPath, 'fake media bytes')
  originalSessionsDir = process.env.VCUT_SESSIONS_DIR
  process.env.VCUT_SESSIONS_DIR = join(workDir, 'sessions')
  originalLog = console.log
  logged = ''
  console.log = (...args: unknown[]) => {
    logged += args.join(' ')
  }
})

afterEach(() => {
  console.log = originalLog
  rmSync(workDir, { recursive: true, force: true })
  if (originalSessionsDir === undefined) {
    delete process.env.VCUT_SESSIONS_DIR
  } else {
    process.env.VCUT_SESSIONS_DIR = originalSessionsDir
  }
})

const round = (removalPercent: number) => ({
  edl: { segments: [] },
  report: { removalPercent, segments: 1, semanticCuts: [] },
})

describe('rounds summary carries the rounds gate (#36)', () => {
  test('a one-round session gets insufficient-rounds framing in JSON', async () => {
    const session = await openSession(mediaPath)
    const one = round(10)
    writeRound(nextRoundDir(session.dir), one.edl, one.report)

    await roundsCommand([mediaPath, '--json'])
    const output = JSON.parse(logged) as { rounds: number[]; roundsGate: Record<string, unknown> }
    expect(output.rounds).toEqual([1])
    expect(output.roundsGate.status).toBe('insufficient-rounds')
    expect(output.roundsGate.committedRounds).toBe(1)
  })

  test('a one-round session gets the refusal framing in --human, naming the missing second pass', async () => {
    const session = await openSession(mediaPath)
    const one = round(10)
    writeRound(nextRoundDir(session.dir), one.edl, one.report)

    await roundsCommand([mediaPath, '--human'])
    expect(logged).toContain('committed round')
    expect(logged).toContain('does not count')
  })

  test('a two-round session gets converged-pending-review framing in JSON', async () => {
    const session = await openSession(mediaPath)
    const one = round(10)
    const two = round(20)
    writeRound(nextRoundDir(session.dir), one.edl, one.report)
    writeRound(nextRoundDir(session.dir), two.edl, two.report)

    await roundsCommand([mediaPath, '--json'])
    const output = JSON.parse(logged) as { rounds: number[]; roundsGate: Record<string, unknown> }
    expect(output.rounds).toEqual([1, 2])
    expect(output.roundsGate.status).toBe('converged-pending-review')
  })

  test('a two-round session gets converged framing in --human, not the refusal', async () => {
    const session = await openSession(mediaPath)
    const one = round(10)
    const two = round(20)
    writeRound(nextRoundDir(session.dir), one.edl, one.report)
    writeRound(nextRoundDir(session.dir), two.edl, two.report)

    await roundsCommand([mediaPath, '--human'])
    expect(logged).toContain('cleared the rounds floor')
    expect(logged).not.toContain('does not count')
  })

  test('an acknowledged single round reports acknowledged-single-round, not insufficient-rounds', async () => {
    const session = await openSession(mediaPath)
    const one = round(5)
    writeRound(nextRoundDir(session.dir), one.edl, one.report)
    acknowledgeSingleRound(session.dir, 1)

    await roundsCommand([mediaPath, '--json'])
    const output = JSON.parse(logged) as { roundsGate: Record<string, unknown> }
    expect(output.roundsGate.status).toBe('acknowledged-single-round')
  })

  test('the override is read from the session record, not inferred from a good-looking run', async () => {
    // Two sessions with the identical single round; only one carries the ack file. Same input
    // shape, different gate status — proving the branch is driven by the recorded act, not by
    // anything about the round itself.
    const acked = await openSession(mediaPath)
    const one = round(5)
    writeRound(nextRoundDir(acked.dir), one.edl, one.report)
    acknowledgeSingleRound(acked.dir, 1)
    await roundsCommand([mediaPath, '--json'])
    const ackedOutput = JSON.parse(logged) as { roundsGate: Record<string, unknown> }

    const otherMediaPath = join(workDir, 'other.mp4')
    writeFileSync(otherMediaPath, 'different fake media bytes')
    const unacked = await openSession(otherMediaPath)
    writeRound(nextRoundDir(unacked.dir), one.edl, one.report)
    logged = ''
    await roundsCommand([otherMediaPath, '--json'])
    const unackedOutput = JSON.parse(logged) as { roundsGate: Record<string, unknown> }

    expect(ackedOutput.roundsGate.status).toBe('acknowledged-single-round')
    expect(unackedOutput.roundsGate.status).toBe('insufficient-rounds')
  })
})
