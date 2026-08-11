/**
 * Session store: state keyed by the content of a source file, not its path.
 *
 * `~/.vcut/sessions/<sha256-16>/` holds everything a run over one recording needs to stop
 * repeating: the detect report, a copy of the transcript, and (this slice) refs derived from
 * the two. It is disposable cache, not an artifact — nothing here is the user's edit. The EDL
 * a human approves lives where they wrote it, not inside a session directory that `session gc`
 * (a later slice) can clear.
 *
 * Addressing by content rather than path answers the two questions the spike asked first: the
 * same file copied to two paths shares a session (detect and a transcript are derived from
 * bytes, not from where those bytes happen to sit), and the same path pointed at new content
 * gets a session of its own rather than silently serving stale cache.
 *
 * Invalidation is two levels, cheapest check first. `checkSession` compares size and mtime
 * against what `meta.json` recorded — free, and right almost always, since a file that has not
 * been touched has not changed. A mismatch there re-hashes, which costs real time on a long
 * recording (seconds, not the render-length cost this exists to avoid) but only runs on the
 * rare occasion the cheap check actually disagrees. If the re-hash lands on a different sha,
 * this never mixes silently into the old session: it reports both hashes and the session
 * directory the new content belongs to, and the caller turns that into a UsageError naming
 * both. A full hash otherwise only happens in `openSession`, once, when a session is created
 * or resumed.
 */

import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DetectReport } from './detect.ts'
import { packageVersion } from './output.ts'
import type { Proposal } from './semantic.ts'

export const sessionRoot = (): string =>
  process.env.VCUT_SESSIONS_DIR ?? join(homedir(), '.vcut', 'sessions')

// First 16 hex characters of the sha256, the same truncation the spike settled on: short
// enough to read and type as a directory name, long enough that a collision is not a real
// concern for a per-machine cache (2^64 possibilities, and vcut sessions do not span machines).
const SHA_DIR_LENGTH = 16

export const sha256File = (path: string): Promise<string> =>
  new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })

export const shaDirName = (sha256: string): string => sha256.slice(0, SHA_DIR_LENGTH)

export type SessionMeta = {
  sourcePath: string
  sizeBytes: number
  mtimeMs: number
  sha256: string
  vcutVersion: string
  createdAt: string
}

const metaPath = (sessionDir: string): string => join(sessionDir, 'meta.json')

export const readMeta = (sessionDir: string): SessionMeta | null => {
  const path = metaPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SessionMeta
}

const writeMeta = (sessionDir: string, meta: SessionMeta): void => {
  writeFileSync(metaPath(sessionDir), JSON.stringify(meta, null, 2))
}

export type OpenedSession = {
  dir: string
  meta: SessionMeta
  // false when an existing meta.json was loaded unchanged; true when this call created the
  // session directory or rewrote meta.json because the content changed. `open`'s `cached`
  // field in its own output means something narrower (whether detect was skipped this call) —
  // this is about the session record itself, not any one cache inside it.
  fresh: boolean
}

/**
 * Create or resume the session for a source file, hashing it in full. The only place a full
 * hash runs outside a forced re-check: every other verb that touches a session goes through
 * `checkSession`'s cheap path first.
 */
export const openSession = async (mediaPath: string): Promise<OpenedSession> => {
  const stat = statSync(mediaPath)
  const sha = await sha256File(mediaPath)
  const dir = join(sessionRoot(), shaDirName(sha))
  const existing = readMeta(dir)

  if (
    existing !== null &&
    existing.sha256 === sha &&
    existing.sizeBytes === stat.size &&
    existing.mtimeMs === stat.mtimeMs
  ) {
    return { dir, meta: existing, fresh: false }
  }

  mkdirSync(dir, { recursive: true })
  const meta: SessionMeta = {
    sourcePath: mediaPath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: sha,
    vcutVersion: packageVersion(),
    // ISO from the current instant: a session created just now was created just now. Tests
    // that need a fixed value control it by asserting shape rather than the exact timestamp,
    // same as every other command here that touches wall-clock time.
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  writeMeta(dir, meta)
  return { dir, meta, fresh: true }
}

export type CheckResult =
  | { status: 'match' }
  | { status: 'rehashed-match' }
  | {
      status: 'sha-changed'
      previousSha256: string
      currentSha256: string
      newSessionDir: string
    }

/**
 * The cheap check every verb runs before trusting a session's cache: size and mtime against
 * `meta.json`. Only re-hashes when those disagree, and only reports `sha-changed` when the
 * re-hash itself disagrees with the recorded sha — a size/mtime touch with the same bytes
 * (a `cp -p`, a `touch`) resolves as `rehashed-match` rather than a false alarm.
 */
export const checkSession = async (sessionDir: string, mediaPath: string): Promise<CheckResult> => {
  const meta = readMeta(sessionDir)
  if (meta === null) {
    throw new Error(`no session at ${sessionDir}`)
  }
  const stat = statSync(mediaPath)
  if (stat.size === meta.sizeBytes && stat.mtimeMs === meta.mtimeMs) {
    return { status: 'match' }
  }
  const sha = await sha256File(mediaPath)
  if (sha === meta.sha256) {
    return { status: 'rehashed-match' }
  }
  return {
    status: 'sha-changed',
    previousSha256: meta.sha256,
    currentSha256: sha,
    newSessionDir: join(sessionRoot(), shaDirName(sha)),
  }
}

// --- Cache helpers -----------------------------------------------------------------------
//
// meta.json, detect.json and the transcript copy are the only pieces this slice writes.
// silences cache, proposals, and rounds/ are B-V2/B-V3 territory (peek and cut) and are not
// created here, matching the spike's B2-Q2 answer: what is cheap to recompute stays
// uncomputed until something actually asks for it.

const detectPath = (sessionDir: string): string => join(sessionDir, 'detect.json')

export const cachedDetect = (sessionDir: string): DetectReport | null => {
  const path = detectPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  return JSON.parse(readFileSync(path, 'utf8')) as DetectReport
}

export const writeCachedDetect = (sessionDir: string, report: DetectReport): void => {
  writeFileSync(detectPath(sessionDir), JSON.stringify(report, null, 2))
}

export const cachedTranscriptPath = (sessionDir: string): string =>
  join(sessionDir, 'transcript.srt')

/**
 * Points a cached detect report's `transcript.path` at the session's own transcript copy,
 * writing the change back to detect.json when it does not already agree.
 *
 * `open` is the only place a transcript enters a session (`--transcript`), so it is the only
 * place this needs to run: once, at cache time, rather than on every later read. Before B-V4,
 * `commit` compared `report.transcript.path` against `cachedTranscriptPath` and patched a local
 * copy on every call, because the cached detect report could carry whatever external path the
 * original `open --transcript` call was given — a path that can move or vanish after that call
 * returns. Fixing the cache once here means every later reader of `cachedDetect` gets a path
 * guaranteed to still resolve, with nothing left for a caller to patch.
 *
 * Returns the (possibly unchanged) report, so a caller can keep using its own in-memory copy
 * rather than re-reading the file it just wrote.
 */
export const pointCachedTranscriptAtSession = (
  sessionDir: string,
  report: DetectReport,
): DetectReport => {
  const transcriptPath = cachedTranscriptPath(sessionDir)
  if (!existsSync(transcriptPath) || report.transcript.path === transcriptPath) {
    return report
  }
  const updated: DetectReport = {
    ...report,
    transcript: { ...report.transcript, path: transcriptPath },
  }
  writeCachedDetect(sessionDir, updated)
  return updated
}

// --- Refs ----------------------------------------------------------------------------------

export type RefBlock = {
  ref: string
  startMs: number
  endMs: number
  durationMs: number
}

export type RefsFile = {
  gen: number
  preset: string
  blocks: RefBlock[]
  // Every preset this session has ever detected with, mapped to the gen it was first assigned.
  // Absent on refs.json written before B-V4; readRefs backfills it from `preset`/`gen` alone so
  // an old session still resolves through the same lookup instead of a separate code path.
  presetGens: Record<string, number>
}

const refWidth = (count: number): number => String(Math.max(count, 1)).length

/**
 * Speech blocks between the detect's own silences, in time order, numbered b001, b002, ...
 *
 * Refs point at what a cut can name, and a ref that changes meaning between calls is worse
 * than a raw millisecond, so this derives strictly from the silence list a detect run already
 * measured — never from `silences`, which is the placing instrument and answers a different,
 * caller-chosen resolution question. Silence at position 0 produces no leading empty block;
 * a trailing silence produces no trailing empty block; a source with no measured silence at
 * all is a single block spanning the whole duration.
 */
export const deriveRefs = (
  silences: Array<{ startMs: number; endMs: number }>,
  durationMs: number,
): RefBlock[] => {
  const sorted = [...silences].sort((left, right) => left.startMs - right.startMs)
  const spans: Array<{ startMs: number; endMs: number }> = []
  let cursor = 0

  for (const silence of sorted) {
    const startMs = Math.max(0, Math.min(silence.startMs, durationMs))
    const endMs = Math.max(0, Math.min(silence.endMs, durationMs))
    if (startMs > cursor) {
      spans.push({ startMs: cursor, endMs: startMs })
    }
    cursor = Math.max(cursor, endMs)
  }
  if (cursor < durationMs) {
    spans.push({ startMs: cursor, endMs: durationMs })
  }

  const width = refWidth(spans.length)
  return spans.map((span, index) => ({
    ref: `b${String(index + 1).padStart(width, '0')}`,
    startMs: span.startMs,
    endMs: span.endMs,
    durationMs: span.endMs - span.startMs,
  }))
}

const refsPath = (sessionDir: string): string => join(sessionDir, 'refs.json')

export const readRefs = (sessionDir: string): RefsFile | null => {
  const path = refsPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as RefsFile
  // Backfill for refs.json written before presetGens existed: the only preset on record is
  // the current one, at the current gen, which is exactly what a single-write history implies.
  if (parsed.presetGens === undefined) {
    return { ...parsed, presetGens: { [parsed.preset]: parsed.gen } }
  }
  return parsed
}

/**
 * Writes refs.json, deriving `gen` from the EFFECTIVE preset rather than from whether the
 * previous write's preset differs.
 *
 * The distinction: bumping on every change means a session that opens noisy, re-opens clean,
 * then re-opens noisy again lands on gen 3, even though gen 3's blocks are byte-identical to
 * gen 1's — the same silences, from the same detect threshold, on unchanged source bytes. A
 * caller holding a b-ref from gen 1 sees it rejected by name on the third open despite nothing
 * about the source or the threshold having changed since the first. `presetGens` remembers the
 * gen each preset was first assigned, so returning to a preset returns to its own generation
 * instead of minting a new one: noisy/1, clean/2, noisy/1 again, never a noisy/3.
 *
 * A genuinely new preset (one this session has never detected with) still gets a new gen, same
 * as before: the old gen's boundaries describe a different threshold and `cut`/`peek` reject
 * them by name (B-V3's resolveRef), which is the whole point of gen enforcement.
 */
export const writeRefs = (sessionDir: string, preset: string, blocks: RefBlock[]): RefsFile => {
  const previous = readRefs(sessionDir)
  const presetGens = { ...(previous?.presetGens ?? {}) }
  const knownGen = presetGens[preset]
  const gen = knownGen ?? Object.keys(presetGens).length + 1
  presetGens[preset] = gen
  const refs: RefsFile = { gen, preset, blocks, presetGens }
  writeFileSync(refsPath(sessionDir), JSON.stringify(refs, null, 2))
  return refs
}

// --- Proposals -------------------------------------------------------------------------------
//
// `cut` (B-V3) accumulates proposals here instead of a caller hand-writing a semantic proposals
// file, and `commit` reads them back to build the same EDL a standalone `vcut edl build
// --semantic <path>` would from the equivalent file. Each entry carries `removedText` alongside
// the bare `Proposal` fields, quoted from the session's cached transcript at propose time —
// the "see it before you build it" answer B6 needs, not a value `edl build` itself computes
// (that one derives `removedText` from the merged span at build time, which can differ slightly
// once several proposals land in the same place; this is the caller-facing echo, not the
// build's own accounting).
//
// No lockfile guards concurrent writers here. B7's advisory lock is B-V4's job; this slice
// reads-modifies-writes proposals.json the way every other session file already does, which is
// fine for one writer and is exactly the gap B-V4 closes for two.
export type SessionProposal = Proposal & {
  removedText: string
  proposedAt: string
}

const proposalsPath = (sessionDir: string): string => join(sessionDir, 'proposals.json')

export const readProposalsFile = (sessionDir: string): SessionProposal[] => {
  const path = proposalsPath(sessionDir)
  if (!existsSync(path)) {
    return []
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SessionProposal[]
}

const writeProposalsFile = (sessionDir: string, proposals: SessionProposal[]): void => {
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(proposalsPath(sessionDir), JSON.stringify(proposals, null, 2))
}

export const appendProposal = (
  sessionDir: string,
  proposal: SessionProposal,
): SessionProposal[] => {
  const proposals = [...readProposalsFile(sessionDir), proposal]
  writeProposalsFile(sessionDir, proposals)
  return proposals
}

/** Removes the proposal at `index` (0-based, insertion order) and returns what remains. */
export const dropProposal = (sessionDir: string, index: number): SessionProposal[] => {
  const proposals = readProposalsFile(sessionDir)
  if (index < 0 || index >= proposals.length) {
    throw new Error(
      `no proposal at index ${index}; this session has ${proposals.length} (0..${Math.max(0, proposals.length - 1)})`,
    )
  }
  const remaining = proposals.filter((_, position) => position !== index)
  writeProposalsFile(sessionDir, remaining)
  return remaining
}

// --- Rounds ------------------------------------------------------------------------------------
//
// `commit` (B-V3) records each build in `rounds/round-N/`: the EDL it wrote and the build
// report, so a session carries its own history of what was proposed and what got built from it.
// Renders and wavs stay out, matching B2-Q2's answer — they are cheap to regenerate and
// expensive to store, and the session is disposable cache throughout.
const roundsDir = (sessionDir: string): string => join(sessionDir, 'rounds')

/** The next round directory to write into: `rounds/round-1`, `rounds/round-2`, ... */
export const nextRoundDir = (sessionDir: string): string => {
  const dir = roundsDir(sessionDir)
  if (!existsSync(dir)) {
    return join(dir, 'round-1')
  }
  const existing = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^round-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('round-'.length)))
  const next = existing.length === 0 ? 1 : Math.max(...existing) + 1
  return join(dir, `round-${next}`)
}

export const writeRound = (
  roundDir: string,
  edl: unknown,
  buildReport: unknown,
): { edlPath: string; reportPath: string } => {
  mkdirSync(roundDir, { recursive: true })
  const edlPath = join(roundDir, 'edl.json')
  const reportPath = join(roundDir, 'report.json')
  writeFileSync(edlPath, `${JSON.stringify(edl, null, 2)}\n`)
  writeFileSync(reportPath, `${JSON.stringify(buildReport, null, 2)}\n`)
  return { edlPath, reportPath }
}

/** Every round number this session has recorded, ascending. Empty when rounds/ does not exist. */
export const listRoundNumbers = (sessionDir: string): number[] => {
  const dir = roundsDir(sessionDir)
  if (!existsSync(dir)) {
    return []
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^round-\d+$/.test(entry.name))
    .map((entry) => Number(entry.name.slice('round-'.length)))
    .sort((left, right) => left - right)
}

/** A round's own EDL and build report, read back for `vcut rounds --diff`. Null if absent. */
export const readRound = (
  sessionDir: string,
  roundNumber: number,
): { edl: unknown; report: unknown } | null => {
  const dir = join(roundsDir(sessionDir), `round-${roundNumber}`)
  const edlPath = join(dir, 'edl.json')
  const reportPath = join(dir, 'report.json')
  if (!existsSync(edlPath) || !existsSync(reportPath)) {
    return null
  }
  return {
    edl: JSON.parse(readFileSync(edlPath, 'utf8')),
    report: JSON.parse(readFileSync(reportPath, 'utf8')),
  }
}

// --- Commit marker -------------------------------------------------------------------------
//
// A successful commit marks the session as a gc candidate (spike's B7-Q2: "commit exitoso
// marca la sesion como candidata"). This is a marker file rather than a field folded into
// meta.json so gc's read stays a single existsSync rather than a JSON parse of a file gc has
// no other reason to touch, and so a session with zero commits (still being worked) is
// trivially distinguishable from one that finished at least one round.
const committedMarkerPath = (sessionDir: string): string => join(sessionDir, 'committed-at')

export const markCommitted = (sessionDir: string): void => {
  writeFileSync(committedMarkerPath(sessionDir), new Date().toISOString())
}

/** ISO timestamp of the first successful commit, or null if this session never committed. */
export const committedAt = (sessionDir: string): string | null => {
  const path = committedMarkerPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  return readFileSync(path, 'utf8').trim()
}

// --- Advisory lock ---------------------------------------------------------------------------
//
// B7-Q1's resolution: only the writing verbs (cut's propose/drop, commit) take a lock; readers
// (open, peek) never do. lock.json holds { pid, startedAt, verb }. A live pid blocks a second
// writer with an error naming the holder; a dead pid is stale and gets cleared automatically
// rather than requiring a human to notice and delete the file by hand — a lock nobody can ever
// clear is worse than no lock, since it survives past the crash that left it behind.
const lockPath = (sessionDir: string): string => join(sessionDir, 'lock.json')

export type SessionLock = {
  pid: number
  startedAt: string
  verb: string
}

/** True when a pid still names a live process. Cross-platform via signal 0: no kill, just a check. */
const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process, the pid is dead. EPERM: a live process this user cannot signal,
    // which still means it is alive and the lock is real — treated as alive rather than dead,
    // since clearing a lock held by a process we merely lack permission to signal would be the
    // wrong direction to guess wrong in.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const readLock = (sessionDir: string): SessionLock | null => {
  const path = lockPath(sessionDir)
  if (!existsSync(path)) {
    return null
  }
  return JSON.parse(readFileSync(path, 'utf8')) as SessionLock
}

export class SessionLockedError extends Error {
  readonly holder: SessionLock
  constructor(holder: SessionLock) {
    const ageMs = Date.now() - new Date(holder.startedAt).getTime()
    const ageS = Math.max(0, Math.round(ageMs / 1000))
    super(
      `session is locked by pid ${holder.pid} running '${holder.verb}', started ${ageS}s ago. ` +
        `If that process is gone, this lock would have cleared itself on the next attempt; ` +
        `if it is still running, wait for it to finish.`,
    )
    this.holder = holder
  }
}

/**
 * Takes the advisory lock for a writing verb, clearing a stale one (dead pid) automatically
 * first. Throws `SessionLockedError` naming the holder when a live process already holds it.
 *
 * Not a filesystem lock in the fcntl/flock sense — two processes racing the same instant could
 * both pass this check before either writes lock.json, the same TOCTOU gap every advisory lock
 * in a scripting language has without a kernel primitive underneath it. It is honest as a
 * courtesy between cooperating callers (two agents, or an agent and a human, sharing one
 * session), which is the actual failure mode B7-Q1 was written against, not a guarantee against
 * an adversarial writer.
 */
export const acquireLock = (sessionDir: string, verb: string): void => {
  const existing = readLock(sessionDir)
  if (existing !== null) {
    if (pidIsAlive(existing.pid)) {
      throw new SessionLockedError(existing)
    }
    // Stale: the holder's pid is dead. Clear and fall through to taking it ourselves.
  }
  mkdirSync(sessionDir, { recursive: true })
  const lock: SessionLock = { pid: process.pid, startedAt: new Date().toISOString(), verb }
  writeFileSync(lockPath(sessionDir), JSON.stringify(lock, null, 2))
}

/** Releases the lock if this process holds it. Never throws: a finally block calls this
 * unconditionally, including on a path that never got as far as acquiring one. */
export const releaseLock = (sessionDir: string): void => {
  const existing = readLock(sessionDir)
  if (existing === null || existing.pid !== process.pid) {
    return
  }
  unlinkSync(lockPath(sessionDir))
}

/** Whether a session is currently locked by a live process, for gc and `session list` to report. */
export const isLocked = (sessionDir: string): boolean => {
  const existing = readLock(sessionDir)
  return existing !== null && pidIsAlive(existing.pid)
}

// --- gc ----------------------------------------------------------------------------------
//
// B7-Q2's resolution: gc is explicit only (never runs itself), dry-run by default, and a
// successful commit marks a session as a candidate rather than triggering deletion. Nothing
// here ever touches the EDL a human approved — that artefact lives wherever the user's
// `--edl`/`--output` pointed, outside every session directory this module manages, so gc
// clearing a whole session directory can never reach it.
export type SessionSummary = {
  sessionDir: string
  sourcePath: string
  sourceExists: boolean
  sizeBytes: number
  createdAt: string
  committedRounds: number
  committedAt: string | null
  locked: boolean
}

/** Every session on disk, newest meta.json first isn't guaranteed — callers sort as needed. */
export const listSessions = (): SessionSummary[] => {
  const root = sessionRoot()
  if (!existsSync(root)) {
    return []
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .map((dir) => summariseSession(dir))
    .filter((summary): summary is SessionSummary => summary !== null)
}

const dirSizeBytes = (dir: string): number => {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        total += statSync(full).size
      }
    }
  }
  return total
}

export const summariseSession = (sessionDir: string): SessionSummary | null => {
  const meta = readMeta(sessionDir)
  if (meta === null) {
    return null
  }
  return {
    sessionDir,
    sourcePath: meta.sourcePath,
    sourceExists: existsSync(meta.sourcePath),
    sizeBytes: dirSizeBytes(sessionDir),
    createdAt: meta.createdAt,
    committedRounds: listRoundNumbers(sessionDir).length,
    committedAt: committedAt(sessionDir),
    locked: isLocked(sessionDir),
  }
}

export type GcReason = 'orphan' | 'committed' | 'older-than' | 'locked-protected'

export type GcCandidate = {
  sessionDir: string
  sourcePath: string
  sizeBytes: number
  reasons: GcReason[]
  deletable: boolean
}

/**
 * Classifies every session against the reasons gc would remove it, without deleting anything.
 * `olderThanDays` is optional: omitted, age alone never qualifies a session, matching "gc is
 * explicit only" — a caller who wants an age-based sweep asks for one by name.
 *
 * A locked session always reports `locked-protected` and `deletable: false` regardless of how
 * many other reasons apply, since a live writer's lock is exactly the case B7-Q1 exists to
 * protect: gc racing a `cut` or `commit` in progress would delete state out from under it.
 */
export const classifySessionsForGc = (
  sessions: SessionSummary[],
  olderThanDays: number | null,
  now: number = Date.now(),
): GcCandidate[] => {
  const DAY_MS = 24 * 60 * 60 * 1000
  return sessions.map((session) => {
    const reasons: GcReason[] = []
    if (!session.sourceExists) {
      reasons.push('orphan')
    }
    if (session.committedAt !== null) {
      reasons.push('committed')
    }
    if (olderThanDays !== null) {
      const ageMs = now - new Date(session.createdAt).getTime()
      if (ageMs >= olderThanDays * DAY_MS) {
        reasons.push('older-than')
      }
    }
    if (session.locked) {
      reasons.push('locked-protected')
    }
    return {
      sessionDir: session.sessionDir,
      sourcePath: session.sourcePath,
      sizeBytes: session.sizeBytes,
      reasons,
      deletable: !session.locked && reasons.some((reason) => reason !== 'locked-protected'),
    }
  })
}

/** Deletes every candidate gc marked deletable. Returns the ones actually removed. */
export const applyGc = (candidates: GcCandidate[]): GcCandidate[] => {
  const removed: GcCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.deletable) {
      continue
    }
    rmSync(candidate.sessionDir, { recursive: true, force: true })
    removed.push(candidate)
  }
  return removed
}
