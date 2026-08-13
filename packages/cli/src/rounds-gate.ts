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
 *
 * #44 adds the second thing that can hold the same status back, on the same argument. The rounds
 * floor answers "did enough passes run"; it cannot answer "did the passes find anything", and a
 * session that ran two rounds and still repeats a sentence twice is exactly as unfinished as one
 * that ran one. An agnostic run reached `converged-pending-review` on a render `verify --windows`
 * finds 18 repeated phrases in, and that status reads as advisory once a human is about to look:
 * it does not say a defect is still standing. `'repeated-phrases-unresolved'` does, and it quotes
 * the phrases, because the quote is the part a run cannot argue with.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MIN_CONVERGED_ROUNDS = 2

export type RoundsGateStatus =
  | 'insufficient-rounds'
  | 'repeated-phrases-unresolved'
  | 'converged-pending-review'
  | 'acknowledged-single-round'

export type RoundsGate = {
  status: RoundsGateStatus
  committedRounds: number
  message: string
  next?: Array<{ question: string; verb: string }>
}

/**
 * What the listener sweep found in the round's own render, in the only shape this gate needs: how
 * many findings stand and what they actually say.
 *
 * `phrases` carries the offending text verbatim, not a count and a span. #44's own forensics are
 * why: asked directly whether it would have overridden this gate, the agent that shipped the
 * defect answered that a silent boolean (`verified: false`) it might have rationalised past, but
 * the phrase quoted in front of it, no. A gate whose message says "something repeats" is arguable;
 * one that says `"reciben un poema mio"` is not. `metaSpeech`'s own findings already set this
 * precedent by carrying `text` rather than a category.
 */
export type ListenerFindings = {
  repeatedPhrases: number
  truncatedEdges: number
  phrases: string[]
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

// How many quoted phrases the gate's own message carries before it stops listing and says how
// many more there are. Every finding is still in `listener.repeatedPhrases` and in the round's
// own listener.json; this only bounds the one-line message, which stops being readable long
// before an 18-finding render runs out of phrases to name.
const QUOTED_IN_MESSAGE = 3

const unresolvedMessage = (committedRounds: number, listener: ListenerFindings): string => {
  const quoted = listener.phrases.slice(0, QUOTED_IN_MESSAGE).map((phrase) => `"${phrase}"`)
  const rest =
    listener.phrases.length > QUOTED_IN_MESSAGE
      ? ` and ${listener.phrases.length - QUOTED_IN_MESSAGE} more`
      : ''
  const truncated =
    listener.truncatedEdges > 0
      ? `, plus ${listener.truncatedEdges} truncated edge${listener.truncatedEdges === 1 ? '' : 's'}`
      : ''
  return (
    `${committedRounds} committed rounds, and the listener sweep over this round's own render ` +
    `still finds ${listener.repeatedPhrases} repeated phrase` +
    `${listener.repeatedPhrases === 1 ? '' : 's'}${truncated}: ${quoted.join(', ')}${rest}. ` +
    `A whole-file transcript averages a repeat away, which is why reading one clean does not ` +
    `clear this. Cut each phrase or name why it stays, then commit again. Re-run the sweep ` +
    `directly with: vcut verify --windows <render.wav> --lang <code>`
  )
}

/**
 * Evaluates the gate from a session's own committed-round count — the same number
 * `listRoundNumbers` already tracks, not a new counter this introduces.
 *
 * `acknowledged` is whether `--single-round` (or the equivalent session-level ack) was passed
 * for THIS commit: the override is per-declaration, not a session-wide amnesty, so a caller
 * re-checks it on every call rather than trusting a stale ack from an earlier round.
 *
 * `listener` (#44) is what the window sweep found in the round's own render, or `undefined` when
 * no sweep ran for this call (a round with no render to sweep, or a caller that has none to
 * pass). Undefined never reads as clean: the gate only holds when it has findings in hand, and
 * `commit` reports whether the sweep ran through a separate `listenerChecked` boolean rather than
 * letting an empty result stand in for both answers, the same honest split `metaSpeechChecked`
 * already makes.
 *
 * Order matters and is deliberate. `insufficient-rounds` still wins: a session below the floor
 * has a missing pass regardless of what the sweep says, and naming the sweep first would let a
 * run fix quoted phrases and believe it had arrived. `--single-round` is checked after the
 * listener, not before, because it acknowledges a one-round EDIT (a trivial clip that does not
 * need a second propose pass) and it was never a declaration that a duplicated sentence in the
 * render is acceptable. Those are different claims, and only a human making the second one
 * explicitly (by cutting the phrase, or by saying in a `cut --reason` why it stays) clears it.
 */
export const evaluateRoundsGate = (
  committedRounds: number,
  acknowledged: boolean,
  listener?: ListenerFindings,
): RoundsGate => {
  if (committedRounds < MIN_CONVERGED_ROUNDS && !acknowledged) {
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
  if (listener !== undefined && listener.repeatedPhrases > 0) {
    return {
      status: 'repeated-phrases-unresolved',
      committedRounds,
      message: unresolvedMessage(committedRounds, listener),
      next: [
        {
          question: 'read every quoted phrase in the listener field above, at its own timestamp',
          verb: 'vcut say <render.wav> --at-ms <n> --transcribe --lang <code>',
        },
        {
          question: 'find where the surviving telling starts, for a phrase said more than once',
          verb: 'vcut converge <media> --phrase "<the quoted phrase>" --lang <code>',
        },
        {
          question: 'cut each repeat, or name in the reason why it stays',
          verb: 'vcut cut <media> --start-ms <n> --end-ms <n> --kind repetition --reason "..."',
        },
        {
          question: 'commit again; the sweep re-runs on the new render and the gate re-evaluates',
          verb: 'vcut commit <media> --output <path> --campaign <id>',
        },
      ],
    }
  }
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
  return {
    status: 'converged-pending-review',
    committedRounds,
    message:
      `${committedRounds} committed rounds. This session has cleared the rounds floor — ` +
      `convergence still means the most recent round proposed nothing, not merely that a second ` +
      `round ran. Confirm with the human before treating the edit as done.`,
  }
}
