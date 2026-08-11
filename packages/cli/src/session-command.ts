/**
 * `vcut session list|gc` — see what a session store holds, and clear it explicitly.
 *
 * B7-Q2's resolution: gc is explicit only (nothing here runs itself from another command),
 * dry-run by default (`--apply` is the only thing that deletes anything), and a successful
 * `commit` marks a session as a candidate rather than being the trigger that removes it. Every
 * classification names why a session is a candidate — `orphan` (its source no longer exists),
 * `committed` (at least one commit ran), `older-than` (only when `--older-than` was passed),
 * `locked-protected` (a live writer holds it right now, and this always wins: a locked session
 * is never deletable regardless of what else applies).
 *
 * The EDL a human approved is never at risk here: `commit` writes it wherever `--output`/`--edl`
 * pointed, outside every session directory this module manages, so clearing a whole session
 * directory can never reach it. `session.ts`'s own doc block says the same thing from the
 * writer's side; this is the reader's side of that same guarantee.
 */

import { positional } from './detect.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import {
  applyGc,
  classifySessionsForGc,
  type GcCandidate,
  listSessions,
  type SessionSummary,
} from './session.ts'

const HELP = `vcut session - see what a session store holds, and clear it explicitly

Usage:
  vcut session list [--json|--human]
  vcut session gc [--apply] [--older-than <days>] [--json|--human]

list shows every session under ~/.vcut/sessions/: its source path (and whether that source
still exists), size on disk, when it was created, how many rounds it has committed, and
whether a live process currently holds its advisory lock.

gc classifies every session against the reasons it could be cleared, without deleting
anything unless --apply is also given (dry-run is the default, not a flag to remember).
A session is a candidate when its source no longer exists (orphan), it has committed at
least one round (committed — the spike's rule: a successful commit marks a session as
disposable, nothing marks it automatically), or --older-than <days> is given and it is
older than that. A session a live process currently holds the lock on is always
locked-protected and never deletable, whatever else is true of it.

The EDL a human approved is never inside a session directory (commit writes it to
--output/--edl, wherever the caller pointed), so gc clearing a whole session can never
touch an approved edit — only the disposable detect cache, transcript copy, refs, and
round history behind it.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const mbFromBytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(2)

const humanList = (sessions: SessionSummary[]): string => {
  if (sessions.length === 0) {
    return heading('sessions  none')
  }
  const lines = [heading(`sessions  ${sessions.length}`)]
  for (const session of sessions) {
    lines.push(
      line(
        session.sessionDir.split('/').pop() ?? session.sessionDir,
        `${session.sourceExists ? 'source ok' : 'ORPHAN, source gone'}  ${mbFromBytes(session.sizeBytes)}MB  ${session.committedRounds} round(s)${session.locked ? '  LOCKED' : ''}`,
      ),
    )
    lines.push(line('', session.sourcePath))
  }
  return lines.join('\n')
}

const humanGc = (candidates: GcCandidate[], applied: boolean): string => {
  const deletable = candidates.filter((candidate) => candidate.deletable)
  const lines = [
    heading(
      applied
        ? `gc  deleted ${deletable.length} of ${candidates.length} session(s)`
        : `gc dry-run  ${deletable.length} of ${candidates.length} session(s) would go`,
    ),
  ]
  for (const candidate of candidates) {
    if (candidate.reasons.length === 0) {
      continue
    }
    lines.push(
      line(
        candidate.sessionDir.split('/').pop() ?? candidate.sessionDir,
        `${candidate.reasons.join(', ')}  ${mbFromBytes(candidate.sizeBytes)}MB  ${candidate.deletable ? (applied ? 'deleted' : 'would delete') : 'protected'}`,
      ),
    )
  }
  if (!applied && deletable.length > 0) {
    lines.push(nextStep('vcut session gc --apply'))
  }
  return lines.join('\n')
}

const listCommand = (argv: string[]): void => {
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const sessions = listSessions()
  if (mode === 'json') {
    emitJson({ version: 1, sessions })
    return
  }
  console.log(humanList(sessions))
}

const gcCommand = (argv: string[]): void => {
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const olderThanArg = flagValue(argv, '--older-than')
  let olderThanDays: number | null = null
  if (olderThanArg !== undefined) {
    const parsed = Number(olderThanArg)
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new UsageError(`--older-than takes a non-negative number of days, got ${olderThanArg}`)
    }
    olderThanDays = parsed
  }
  const apply = argv.includes('--apply')

  const sessions = listSessions()
  const candidates = classifySessionsForGc(sessions, olderThanDays)
  const removed = apply ? applyGc(candidates) : []
  const removedDirs = new Set(removed.map((candidate) => candidate.sessionDir))
  const reported = apply
    ? candidates.map((candidate) =>
        removedDirs.has(candidate.sessionDir) ? candidate : { ...candidate, deletable: false },
      )
    : candidates

  if (mode === 'json') {
    emitJson({
      version: 1,
      applied: apply,
      olderThanDays,
      candidates: reported,
      deleted: apply ? removed.length : 0,
    })
    return
  }
  console.log(humanGc(reported, apply))
}

export const sessionCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const verb = positional(argv)
  if (verb === 'list') {
    listCommand(argv)
    return
  }
  if (verb === 'gc') {
    gcCommand(argv)
    return
  }
  throw new UsageError(HELP)
}
