import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acknowledgeSingleRound,
  evaluateRoundsGate,
  MIN_CONVERGED_ROUNDS,
  readSingleRoundAck,
} from '../src/rounds-gate.ts'
import { openSession } from '../src/session.ts'

let workDir: string
let mediaPath: string
let originalSessionsDir: string | undefined

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vcut-rounds-gate-test-'))
  mediaPath = join(workDir, 'source.mp4')
  writeFileSync(mediaPath, 'fake media bytes')
  originalSessionsDir = process.env.VCUT_SESSIONS_DIR
  process.env.VCUT_SESSIONS_DIR = join(workDir, 'sessions')
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
  if (originalSessionsDir === undefined) {
    delete process.env.VCUT_SESSIONS_DIR
  } else {
    process.env.VCUT_SESSIONS_DIR = originalSessionsDir
  }
})

describe('evaluateRoundsGate: unacknowledged', () => {
  test('0 committed rounds is insufficient-rounds', () => {
    const gate = evaluateRoundsGate(0, false)
    expect(gate.status).toBe('insufficient-rounds')
    expect(gate.committedRounds).toBe(0)
  })

  test('1 committed round is insufficient-rounds, never converged', () => {
    const gate = evaluateRoundsGate(1, false)
    expect(gate.status).toBe('insufficient-rounds')
    expect(gate.committedRounds).toBe(1)
  })

  test('the refusal message states the round count, names the missing pass, and says verification of round 1 does not count', () => {
    const gate = evaluateRoundsGate(1, false)
    expect(gate.message).toContain('1 committed round')
    expect(gate.message).toContain('second committed')
    expect(gate.message).toContain('verification')
    expect(gate.message).toContain('does not count')
  })

  test('insufficient-rounds carries concrete next commands: render, transcribe, review, cut, commit', () => {
    const gate = evaluateRoundsGate(1, false)
    expect(gate.next).toBeDefined()
    const verbs = (gate.next ?? []).map((hint) => hint.verb).join(' | ')
    expect(verbs).toContain('vcut render')
    expect(verbs).toContain('trx transcribe')
    expect(verbs).toContain('vcut semantic review')
    expect(verbs).toContain('vcut cut')
    expect(verbs).toContain('vcut commit')
  })

  test(`${MIN_CONVERGED_ROUNDS} committed rounds is converged-pending-review`, () => {
    const gate = evaluateRoundsGate(MIN_CONVERGED_ROUNDS, false)
    expect(gate.status).toBe('converged-pending-review')
    expect(gate.next).toBeUndefined()
  })

  test('3 committed rounds is also converged-pending-review, not a third tier', () => {
    const gate = evaluateRoundsGate(3, false)
    expect(gate.status).toBe('converged-pending-review')
  })
})

describe('evaluateRoundsGate: acknowledged via --single-round', () => {
  test('1 committed round, acknowledged, is acknowledged-single-round rather than insufficient-rounds', () => {
    const gate = evaluateRoundsGate(1, true)
    expect(gate.status).toBe('acknowledged-single-round')
  })

  test('the acknowledged message names the override explicitly, not silently', () => {
    const gate = evaluateRoundsGate(1, true)
    expect(gate.message).toContain('--single-round')
    expect(gate.message).toContain('human declared')
  })

  test('acknowledgement does not apply to a session with 0 rounds the same way as 1', () => {
    // The override still names its round count honestly even at 0 — acknowledging a round
    // that was never committed is a caller error the gate does not hide.
    const gate = evaluateRoundsGate(0, true)
    expect(gate.status).toBe('acknowledged-single-round')
    expect(gate.committedRounds).toBe(0)
  })
})

describe('single-round-ack.json: acknowledgeSingleRound / readSingleRoundAck', () => {
  test('a fresh session has no ack', async () => {
    const session = await openSession(mediaPath)
    expect(readSingleRoundAck(session.dir)).toBeNull()
  })

  test('acknowledgeSingleRound records the round it acknowledges and a timestamp', async () => {
    const session = await openSession(mediaPath)
    const ack = acknowledgeSingleRound(session.dir, 1)
    expect(ack.atRound).toBe(1)
    expect(() => new Date(ack.acknowledgedAt).toISOString()).not.toThrow()
  })

  test('the ack persists to disk and reads back identical, distinguishing this from a default', async () => {
    const session = await openSession(mediaPath)
    const written = acknowledgeSingleRound(session.dir, 1)
    const reloaded = readSingleRoundAck(session.dir)
    expect(reloaded).toEqual(written)
  })
})
