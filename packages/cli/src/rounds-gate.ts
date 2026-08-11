/**
 * The rounds gate (issue #36) — the manual states "never stop at one round" as prose, and prose
 * is a rule an agent can read, agree with, and violate on the same run under the pressure of a
 * clean-looking first pass. Three agnostic runs on the same recording did exactly that: one
 * committed round, a full audit/review/read pass over round 1's own render, and a declared
 * convergence that shipped a defect round 2 of a fourth run caught — a spoken rewind marker the
 * round-1-primed reading answered "does this look clean" instead of "what would I cut seeing
 * this fresh".
 *
 * This is a framing gate, not a render lock. Preview renders stay allowed at any point and the
 * human approval boundary (`commit` never writes approval, never touches master mode) is
 * unchanged. What this refuses is narrower and sharper: the CLI itself describing a session with
 * fewer than two committed rounds as done or converged, on the two surfaces an agent reads to
 * decide it is finished — `commit`'s own `next` hints and `rounds`'s summary. Below two rounds,
 * both name the missing pass instead of a next step that reads like polish, and the JSON carries
 * a `status` of `'insufficient-rounds'` rather than the value that would let an agent branch past
 * the wording — an agent skimming for a truthy `converged` field cannot rationalize past a
 * refusal that only exists as one of two known status strings, but `--single-round` still lets a
 * human declare the genuine one-round case explicitly.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIN_CONVERGED_ROUNDS = 2

export type RoundsGateStatus =
  | 'insufficient-rounds'
  | 'converged-pending-review'
  | 'acknowledged-single-round'

export type RoundsGate = {
  status: RoundsGateStatus
  committedRounds: number
  message: string
  next?: Array<{ question: string; verb: string }>
}

const singleRoundAckPath = (sessionDir: string): string => join(sessionDir, 'single-round-ack.json')

export type SingleRoundAck = {
  acknowledgedAt: string
  atRound: number
}

/** Records the deliberate `--single-round` override — a session-visible act, never a default. */
export const acknowledgeSingleRound = (sessionDir: string, atRound: number): SingleRoundAck => {
  const ack: SingleRoundAck = { acknowledgedAt: new Date().toISOString(), atRound }
  writeFileSync(singleRoundAckPath(sessionDir), JSON.stringify(ack, null, 2))
  return ack
}

/** The recorded override, if any. Null when `--single-round` was never passed for this session. */
export const readSingleRoundAck = (sessionDir: string): SingleRoundAck | null => {
  const path = singleRoundAckPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SingleRoundAck
}

const insufficientMessage = (committedRounds: number): string =>
  `this edit has ${committedRounds} committed round. Convergence requires a second committed ` +
  `round containing a real propose pass against this round's render transcript — verification ` +
  `of round 1's own output does not count. Never stop at one round.`

/**
 * Evaluates the gate from a session's own committed-round count — the same number
 * `listRoundNumbers` already tracks, not a new counter this introduces.
 *
 * `acknowledged` is whether `--single-round` (or the equivalent session-level ack) was passed
 * for THIS commit: the override is per-declaration, not a session-wide amnesty, so a caller
 * re-checks it on every call rather than trusting a stale ack from an earlier round.
 */
export const evaluateRoundsGate = (committedRounds: number, acknowledged: boolean): RoundsGate => {
  if (acknowledged) {
    return {
      status: 'acknowledged-single-round',
      committedRounds,
      message:
        `${committedRounds} committed round, explicitly acknowledged as a single-round edit ` +
        `via --single-round. Convergence framing applies only because a human declared this ` +
        `trivial clip does not need a second round — not because the CLI inferred it.`,
    }
  }
  if (committedRounds < MIN_CONVERGED_ROUNDS) {
    return {
      status: 'insufficient-rounds',
      committedRounds,
      message: insufficientMessage(committedRounds),
      next: [
        {
          question: "render this round's audio if not already done",
          verb: 'vcut render --edl edl.json --audio-only',
        },
        { question: 'hear what survived', verb: 'trx transcribe <render.wav> --words' },
        {
          question:
            'semantic review against THIS render — a real propose pass, not verification of round 1',
          verb:
            'vcut semantic review --edl edl.json --detect <detect path> --master <render.wav> ' +
            '--master-transcript <the .srt trx wrote>',
        },
        {
          question: 'read the review output before proposing anything',
          verb: 'read unreviewed, repeated, and lines end to end',
        },
        {
          question: 'fold each finding back in',
          verb: 'vcut cut <media> --refs <ref[..ref]> --kind <kind> --reason "..."',
        },
        {
          question: 'commit the second round',
          verb: 'vcut commit <media> --output <path> --campaign <id>',
        },
      ],
    }
  }
  return {
    status: 'converged-pending-review',
    committedRounds,
    message:
      `${committedRounds} committed rounds. This session has cleared the rounds floor — ` +
      `convergence still means the most recent round proposed nothing, not merely that a second ` +
      `round ran. Confirm with the human before treating the edit as done.`,
  }
}
