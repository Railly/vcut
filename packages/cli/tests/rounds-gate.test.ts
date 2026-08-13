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

describe('evaluateRoundsGate: the listener gate (#44)', () => {
  const dirty = (phrases: string[], truncatedEdges = 0) => ({
    repeatedPhrases: phrases.length,
    truncatedEdges,
    phrases,
  })
  const clean = { repeatedPhrases: 0, truncatedEdges: 0, phrases: [] }

  test('a standing repeated phrase past the rounds floor is repeated-phrases-unresolved, not converged', () => {
    const gate = evaluateRoundsGate(2, false, dirty(['reciben un poema mio']))
    expect(gate.status).toBe('repeated-phrases-unresolved')
    expect(gate.committedRounds).toBe(2)
  })

  test('the message quotes the phrase itself and names the command that re-runs the sweep', () => {
    const gate = evaluateRoundsGate(2, false, dirty(['reciben un poema mio']))
    expect(gate.message).toContain('"reciben un poema mio"')
    expect(gate.message).toContain('vcut verify --windows')
  })

  test('many findings quote the first few and count the rest, never collapse to a bare number', () => {
    const gate = evaluateRoundsGate(2, false, dirty(['uno dos tres', 'b', 'c', 'd', 'e']))
    expect(gate.message).toContain('"uno dos tres"')
    expect(gate.message).toContain('2 more')
  })

  test('truncated edges ride in the same message when present', () => {
    const gate = evaluateRoundsGate(2, false, dirty(['una frase repetida'], 3))
    expect(gate.message).toContain('3 truncated edges')
  })

  test('insufficient-rounds still wins over the listener: a missing pass is the first problem', () => {
    const gate = evaluateRoundsGate(1, false, dirty(['reciben un poema mio']))
    expect(gate.status).toBe('insufficient-rounds')
  })

  test('--single-round does not waive a standing repeated phrase', () => {
    // The override acknowledges a one-round EDIT, never that a duplicated sentence is acceptable.
    const gate = evaluateRoundsGate(1, true, dirty(['reciben un poema mio']))
    expect(gate.status).toBe('repeated-phrases-unresolved')
  })

  test('--single-round with a clean sweep still reaches acknowledged-single-round', () => {
    const gate = evaluateRoundsGate(1, true, clean)
    expect(gate.status).toBe('acknowledged-single-round')
  })

  test('a clean sweep past the floor reaches converged-pending-review, so the gate stays reachable', () => {
    const gate = evaluateRoundsGate(2, false, clean)
    expect(gate.status).toBe('converged-pending-review')
  })

  test('no sweep at all (undefined) never reads as clean OR as a refusal: the gate says nothing about it', () => {
    // The honest split: `commit` reports whether the sweep ran through listenerChecked, and the
    // gate only holds when it has findings in hand. Undefined must not silently block, or a
    // machine without trx could never converge, and must not silently clear either.
    const gate = evaluateRoundsGate(2, false, undefined)
    expect(gate.status).toBe('converged-pending-review')
  })

  test('repeated-phrases-unresolved carries next commands that cut, never approve', () => {
    const gate = evaluateRoundsGate(2, false, dirty(['reciben un poema mio']))
    const verbs = (gate.next ?? []).map((hint) => hint.verb).join(' | ')
    expect(verbs).toContain('vcut cut')
    expect(verbs).toContain('vcut commit')
    expect(verbs).not.toContain('--mode master')
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
