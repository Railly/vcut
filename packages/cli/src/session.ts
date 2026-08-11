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
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { DetectReport } from './detect.ts'
import { packageVersion } from './output.ts'

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
  return JSON.parse(readFileSync(path, 'utf8')) as RefsFile
}

/**
 * Writes refs.json, bumping `gen` when the preset changed since the last write. A re-open
 * with a different preset re-detects (the caller's job, not this function's) and the refs it
 * derives from that new detect are a new generation: the old gen's block boundaries no longer
 * describe this source at this threshold, and B-V3 is where that gets enforced against `cut`.
 * This slice only stores the counter.
 */
export const writeRefs = (sessionDir: string, preset: string, blocks: RefBlock[]): RefsFile => {
  const previous = readRefs(sessionDir)
  const gen =
    previous === null || previous.preset !== preset ? (previous?.gen ?? 0) + 1 : previous.gen
  const refs: RefsFile = { gen, preset, blocks }
  writeFileSync(refsPath(sessionDir), JSON.stringify(refs, null, 2))
  return refs
}
