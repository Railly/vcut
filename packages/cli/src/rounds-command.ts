/**
 * `vcut rounds <media> [--diff N M]` — CLI surface for `rounds.ts`'s diff.
 *
 * Resolves the session the way every other verb here does (must already exist — like `cut`
 * and `commit`, this reads a session's history rather than creating one), lists round numbers
 * without `--diff`, diffs the latest two by default with it.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type { BuildSummary } from './build-edl.ts'
import { duration, emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import type { Edl } from './render-edl.ts'
import {
  type DeltaVerification,
  deltaVerification,
  diffMetaSpeech,
  diffRounds,
  type MetaSpeechDiffEntry,
  type RoundReport,
  type RoundsDiff,
} from './rounds.ts'
import { evaluateRoundsGate, readSingleRoundAck } from './rounds-gate.ts'
import {
  checkSession,
  listRoundNumbers,
  openSession,
  readMetaSpeech,
  readRound,
} from './session.ts'

const HELP = `vcut rounds - a session's committed rounds, and what changed between two of them

Usage:
  vcut rounds <media> [--json|--human]
  vcut rounds <media> --diff <N> <M> [--json|--human]
  vcut rounds <media> --diff <N> <M> --verify-delta [--json|--human]

Without --diff, lists every round this session has committed (from 'vcut commit'), in order.
With --diff, compares round N's build report against round M's: removalPercent delta, segment
count delta, and semanticCuts matched by span overlap and reported added / removed / changed /
unchanged. Omit N and M to diff the latest two rounds.

--verify-delta names the master-time spans round M's render actually needs re-verified, instead
of the whole render. A cut anywhere shifts every later segment's master position, so "what moved
in master time" is the wrong diff: it marks everything after the first cut as changed. Segment
ids are not a safe identity either, since a removal renumbers every id after it even when the
audio itself never changed. This diffs by the segment's actual source-time span instead (source
plus inMs/outMs): a segment is only flagged when that exact span is new to this round, never for
sliding to a new master timestamp because something upstream got shorter or renumbered. The
immediate neighbours of every flagged segment are flagged too, since a join is exactly where a
duplicated phrase or a clipped word appears. Re-transcribe only the spans this reports, not the
render end to end.

This diffs what each round's build asked for (the same report 'vcut commit' already writes to
rounds/round-N/report.json), not what either round's render actually says: that needs a
transcript of each render, and vcut does not store renders or their transcripts in a session
(cheap to regenerate, expensive to keep). Confirm with vcut peek or say --transcribe on the
renders themselves before trusting a semantic diff alone.

The session must already exist (run vcut open, then vcut commit at least twice) — like cut and
commit, this reads a session's history rather than creating one.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const positional = (args: string[]): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('--')) {
      continue
    }
    const previous = args[index - 1]
    if (previous?.startsWith('--') && previous !== '--json' && previous !== '--human') {
      continue
    }
    return arg
  }
  return undefined
}

const toRoundReport = (report: unknown): RoundReport => {
  const summary = report as BuildSummary
  return {
    removalPercent: summary.removalPercent,
    segments: summary.segments,
    semanticCuts: summary.semanticCuts,
  }
}

const humanList = (input: string, rounds: number[], gateMessage: string): string => {
  if (rounds.length === 0) {
    return heading(`${input.split('/').pop()}  no committed rounds yet`)
  }
  return [
    heading(`${input.split('/').pop()}  ${rounds.length} round(s)`),
    line('rounds', rounds.join(', ')),
    heading(gateMessage),
  ].join('\n')
}

const humanDiff = (diff: RoundsDiff, metaSpeech: MetaSpeechDiffEntry[] | null): string => {
  const lines = [
    heading(`round ${diff.fromRound} -> round ${diff.toRound}`),
    line(
      'removalPercent',
      `${diff.removalPercentDelta >= 0 ? '+' : ''}${diff.removalPercentDelta}%`,
    ),
    line('segments', `${diff.segmentCountDelta >= 0 ? '+' : ''}${diff.segmentCountDelta}`),
  ]
  for (const entry of diff.semanticCuts) {
    if (entry.status === 'added') {
      lines.push(
        line(
          'added',
          `${(entry.to.startMs / 1000).toFixed(2)}-${(entry.to.endMs / 1000).toFixed(2)}s  ${entry.to.kind}: "${entry.to.removedText || '(no transcript)'}"`,
        ),
      )
    } else if (entry.status === 'removed') {
      lines.push(
        line(
          'removed',
          `${(entry.from.startMs / 1000).toFixed(2)}-${(entry.from.endMs / 1000).toFixed(2)}s  ${entry.from.kind}: "${entry.from.removedText || '(no transcript)'}"`,
        ),
      )
    } else if (entry.status === 'changed') {
      lines.push(
        line(
          'changed',
          `${(entry.to.startMs / 1000).toFixed(2)}-${(entry.to.endMs / 1000).toFixed(2)}s  "${entry.from.removedText}" -> "${entry.to.removedText}"`,
        ),
      )
    }
  }
  if (diff.semanticCuts.every((entry) => entry.status === 'unchanged')) {
    lines.push(line('semanticCuts', 'unchanged'))
  }
  if (metaSpeech === null) {
    lines.push(line('metaSpeech', 'not recorded for one of these rounds (predates #38)'))
  } else {
    const standing = metaSpeech.filter((entry) => entry.status === 'standing')
    const addressed = metaSpeech.filter((entry) => entry.status === 'addressed')
    if (standing.length === 0 && addressed.length === 0) {
      lines.push(line('metaSpeech', 'none carried from the earlier round'))
    } else {
      lines.push(
        line('metaSpeech', `${addressed.length} addressed, ${standing.length} still standing`),
      )
      for (const entry of standing) {
        lines.push(
          line(
            '  standing',
            `${(entry.from.startMs / 1000).toFixed(2)}-${(entry.from.endMs / 1000).toFixed(2)}s  "${entry.from.text}"`,
          ),
        )
      }
    }
  }
  return lines.join('\n')
}

const humanDeltaVerification = (delta: DeltaVerification): string => {
  const lines = [
    heading(`round ${delta.fromRound} -> round ${delta.toRound}  delta verification`),
    line(
      'spans to re-verify',
      `${delta.spanCount} of ${delta.totalSegments} segments (${duration(delta.spanDurationMs)} of ${duration(delta.totalDurationMs)})`,
    ),
  ]
  if (delta.spans.length === 0) {
    lines.push(line('spans', 'none, round M made no content changes since round N'))
    return lines.join('\n')
  }
  for (const span of delta.spans) {
    lines.push(
      line(
        `  ${(span.masterInMs / 1000).toFixed(2)}-${(span.masterOutMs / 1000).toFixed(2)}s`,
        `${span.segmentId}  ${span.reason}`,
      ),
    )
  }
  return lines.join('\n')
}

export const roundsCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const media = positional(argv)
  if (media === undefined) {
    throw new UsageError(HELP)
  }
  const resolvedMedia = resolve(media)
  if (!existsSync(resolvedMedia)) {
    throw new Error(`input missing: ${resolvedMedia}`)
  }

  const session = await openSession(resolvedMedia)
  if (session.fresh) {
    throw new UsageError(
      `no session for ${resolvedMedia} yet. Run vcut open ${resolvedMedia} first — rounds reads a session's history, it does not create one.`,
    )
  }
  const check = await checkSession(session.dir, resolvedMedia)
  if (check.status === 'sha-changed') {
    throw new UsageError(
      `${resolvedMedia} no longer matches this session (sha ${check.previousSha256.slice(0, 12)} -> ${check.currentSha256.slice(0, 12)}). Run vcut open again; the new content belongs to ${check.newSessionDir}.`,
    )
  }

  const rounds = listRoundNumbers(session.dir)
  const diffIndex = argv.indexOf('--diff')

  if (diffIndex === -1) {
    // The rounds gate (#36): this summary is one of the two surfaces an agent reads to decide a
    // session is done, so it carries the same refusal `commit` does rather than a bare count a
    // caller has to know to compare against 2 itself.
    const ack = readSingleRoundAck(session.dir)
    const gate = evaluateRoundsGate(rounds.length, ack !== null)
    if (mode === 'json') {
      emitJson({
        version: 1,
        input: resolvedMedia,
        sessionDir: session.dir,
        rounds,
        roundsGate: gate,
      })
      return
    }
    console.log(humanList(resolvedMedia, rounds, gate.message))
    return
  }

  if (rounds.length < 2) {
    throw new UsageError(
      `this session has ${rounds.length} committed round(s); --diff needs at least 2. Run vcut commit again to add one.`,
    )
  }

  const explicitFrom = flagValue(argv, '--diff')
  const explicitTo = argv[diffIndex + 2]
  let fromRound: number
  let toRound: number
  if (
    explicitFrom !== undefined &&
    !explicitFrom.startsWith('--') &&
    explicitTo !== undefined &&
    !explicitTo.startsWith('--')
  ) {
    fromRound = Number(explicitFrom)
    toRound = Number(explicitTo)
    if (!Number.isInteger(fromRound) || !Number.isInteger(toRound)) {
      throw new UsageError(`--diff takes two round numbers, got ${explicitFrom} ${explicitTo}`)
    }
  } else {
    // Default: the latest two rounds, in order.
    fromRound = rounds[rounds.length - 2]
    toRound = rounds[rounds.length - 1]
  }

  if (!rounds.includes(fromRound) || !rounds.includes(toRound)) {
    throw new UsageError(
      `round ${!rounds.includes(fromRound) ? fromRound : toRound} does not exist in this session. Committed rounds: ${rounds.join(', ')}.`,
    )
  }

  const fromData = readRound(session.dir, fromRound)
  const toData = readRound(session.dir, toRound)
  if (fromData === null || toData === null) {
    throw new Error(`round data missing on disk for ${fromRound} or ${toRound}`)
  }

  if (argv.includes('--verify-delta')) {
    const fromEdl = fromData.edl as Edl
    const toEdl = toData.edl as Edl
    const delta = deltaVerification(fromRound, fromEdl.segments, toRound, toEdl.segments)
    if (mode === 'json') {
      emitJson({
        version: 1,
        input: resolvedMedia,
        sessionDir: session.dir,
        deltaVerification: delta,
      })
      return
    }
    console.log(humanDeltaVerification(delta))
    return
  }

  const diff = diffRounds(
    fromRound,
    toRoundReport(fromData.report),
    toRound,
    toRoundReport(toData.report),
  )
  // #38: whether round fromRound's metaSpeech findings were addressed (cut) or are still
  // standing by round toRound. null when either round predates #38 or had no transcript to
  // check that round — readMetaSpeech distinguishes that from an empty, checked-and-clean round.
  const metaSpeechDiff = diffMetaSpeech(
    readMetaSpeech(session.dir, fromRound),
    readMetaSpeech(session.dir, toRound),
  )

  if (mode === 'json') {
    emitJson({
      version: 1,
      input: resolvedMedia,
      sessionDir: session.dir,
      diff: { ...diff, metaSpeech: metaSpeechDiff },
    })
    return
  }
  console.log(humanDiff(diff, metaSpeechDiff))
}
