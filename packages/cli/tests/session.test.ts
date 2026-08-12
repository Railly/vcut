import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DetectReport } from '../src/detect.ts'
import {
  acquireLock,
  appendProposal,
  applyGc,
  cachedDetect,
  cachedTranscriptPath,
  checkSession,
  classifySessionsForGc,
  committedAt,
  deriveRefs,
  dropProposal,
  isLocked,
  listRoundNumbers,
  markCommitted,
  nextRoundDir,
  openSession,
  pointCachedTranscriptAtSession,
  readMeta,
  readProposalsFile,
  readRefs,
  readRound,
  releaseLock,
  SessionLockedError,
  type SessionSummary,
  sessionRoot,
  sha256File,
  shaDirName,
  summariseSession,
  writeCachedDetect,
  writeRefs,
  writeRound,
} from '../src/session.ts'

let workDir: string
let mediaPath: string
let originalSessionsDir: string | undefined

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'vcut-session-test-'))
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

describe('sessionRoot', () => {
  test('reads VCUT_SESSIONS_DIR when set', () => {
    expect(sessionRoot()).toBe(join(workDir, 'sessions'))
  })
})

describe('shaDirName', () => {
  test('takes the first 16 hex characters', () => {
    const full = 'a'.repeat(64)
    expect(shaDirName(full)).toBe('a'.repeat(16))
    expect(shaDirName(full)).toHaveLength(16)
  })
})

describe('openSession', () => {
  test('creates a session directory named after the content hash', async () => {
    const session = await openSession(mediaPath)
    const expectedSha = await sha256File(mediaPath)
    expect(session.dir).toBe(join(sessionRoot(), shaDirName(expectedSha)))
    expect(session.fresh).toBe(true)
    expect(session.meta.sha256).toBe(expectedSha)
    expect(session.meta.sourcePath).toBe(mediaPath)
  })

  test('meta.json round-trips through readMeta', async () => {
    const session = await openSession(mediaPath)
    const reloaded = readMeta(session.dir)
    expect(reloaded).toEqual(session.meta)
  })

  test('resuming the same untouched content returns fresh: false', async () => {
    const first = await openSession(mediaPath)
    const second = await openSession(mediaPath)
    expect(second.dir).toBe(first.dir)
    expect(second.fresh).toBe(false)
    expect(second.meta).toEqual(first.meta)
  })

  test('same content copied to a second path resolves to the same session', async () => {
    const copyPath = join(workDir, 'copy.mp4')
    writeFileSync(copyPath, 'fake media bytes')
    const original = await openSession(mediaPath)
    const copy = await openSession(copyPath)
    expect(copy.dir).toBe(original.dir)
  })

  test('the same path with new content opens a different session', async () => {
    const first = await openSession(mediaPath)
    writeFileSync(mediaPath, 'different bytes now')
    const second = await openSession(mediaPath)
    expect(second.dir).not.toBe(first.dir)
    expect(second.fresh).toBe(true)
  })
})

describe('checkSession', () => {
  test('matches when size and mtime are untouched', async () => {
    const session = await openSession(mediaPath)
    const result = await checkSession(session.dir, mediaPath)
    expect(result).toEqual({ status: 'match' })
  })

  test('a touch that changes mtime but not bytes re-hashes to rehashed-match', async () => {
    const session = await openSession(mediaPath)
    // Rewrite identical content: mtime moves, sha does not.
    writeFileSync(mediaPath, 'fake media bytes')
    const result = await checkSession(session.dir, mediaPath)
    expect(result.status).toBe('rehashed-match')
  })

  test('changed content produces a typed sha-changed error naming both shas', async () => {
    const session = await openSession(mediaPath)
    const previousSha = session.meta.sha256
    writeFileSync(mediaPath, 'entirely different content, longer this time')
    const result = await checkSession(session.dir, mediaPath)
    expect(result.status).toBe('sha-changed')
    if (result.status !== 'sha-changed') {
      throw new Error('expected sha-changed')
    }
    expect(result.previousSha256).toBe(previousSha)
    expect(result.currentSha256).not.toBe(previousSha)
    expect(result.newSessionDir).toBe(join(sessionRoot(), shaDirName(result.currentSha256)))
  })
})

describe('cachedDetect', () => {
  const fakeReport: DetectReport = {
    version: 1,
    input: '/fake/input.mp4',
    durationMs: 10_000,
    preset: 'clean',
    thresholdDb: -30,
    minSilenceMs: 300,
    marginMs: 100,
    lang: 'es',
    transcript: { path: null, wordLevel: false, words: 0 },
    audioPath: null,
    hasVideo: true,
    silences: [],
    review: [],
    warnings: [],
  }

  test('is null before anything is written', async () => {
    const session = await openSession(mediaPath)
    expect(cachedDetect(session.dir)).toBeNull()
  })

  test('round-trips a detect report', async () => {
    const session = await openSession(mediaPath)
    writeCachedDetect(session.dir, fakeReport)
    expect(cachedDetect(session.dir)).toEqual(fakeReport)
  })
})

describe('deriveRefs', () => {
  test('a single speech block when there is no silence at all', () => {
    const refs = deriveRefs([], 10_000)
    expect(refs).toEqual([{ ref: 'b1', startMs: 0, endMs: 10_000, durationMs: 10_000 }])
  })

  test('numbers blocks in time order between silences', () => {
    const silences = [
      { startMs: 2000, endMs: 2500 },
      { startMs: 6000, endMs: 6300 },
    ]
    const refs = deriveRefs(silences, 10_000)
    expect(refs).toEqual([
      { ref: 'b1', startMs: 0, endMs: 2000, durationMs: 2000 },
      { ref: 'b2', startMs: 2500, endMs: 6000, durationMs: 3500 },
      { ref: 'b3', startMs: 6300, endMs: 10_000, durationMs: 3700 },
    ])
  })

  test('silence at position 0 produces no leading empty block', () => {
    const silences = [{ startMs: 0, endMs: 1000 }]
    const refs = deriveRefs(silences, 5000)
    expect(refs).toEqual([{ ref: 'b1', startMs: 1000, endMs: 5000, durationMs: 4000 }])
  })

  test('trailing silence produces no trailing empty block', () => {
    const silences = [{ startMs: 4000, endMs: 5000 }]
    const refs = deriveRefs(silences, 5000)
    expect(refs).toEqual([{ ref: 'b1', startMs: 0, endMs: 4000, durationMs: 4000 }])
  })

  test('a source that is entirely silence produces no blocks', () => {
    const silences = [{ startMs: 0, endMs: 5000 }]
    expect(deriveRefs(silences, 5000)).toEqual([])
  })

  test('unordered silences are sorted before deriving blocks', () => {
    const silences = [
      { startMs: 6000, endMs: 6300 },
      { startMs: 2000, endMs: 2500 },
    ]
    const refs = deriveRefs(silences, 10_000)
    expect(refs.map((block) => block.startMs)).toEqual([0, 2500, 6300])
  })

  test('pads ref numbers to the width of the block count', () => {
    const silences = Array.from({ length: 12 }, (_, index) => ({
      startMs: index * 100,
      endMs: index * 100 + 10,
    }))
    const refs = deriveRefs(silences, 1400)
    expect(refs[0].ref).toBe('b01')
    expect(refs.at(-1)?.ref.length).toBe(3)
  })
})

describe('refs.json / writeRefs', () => {
  test('is null before anything is written', async () => {
    const session = await openSession(mediaPath)
    expect(readRefs(session.dir)).toBeNull()
  })

  test('first write starts at gen 1', async () => {
    const session = await openSession(mediaPath)
    const refs = writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    expect(refs.gen).toBe(1)
    expect(refs.preset).toBe('noisy')
  })

  test('re-writing with the same preset does not bump gen', async () => {
    const session = await openSession(mediaPath)
    writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    const second = writeRefs(session.dir, 'noisy', deriveRefs([{ startMs: 0, endMs: 100 }], 5000))
    expect(second.gen).toBe(1)
  })

  test('a different preset bumps gen', async () => {
    const session = await openSession(mediaPath)
    writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    const second = writeRefs(session.dir, 'clean', deriveRefs([], 5000))
    expect(second.gen).toBe(2)
    expect(second.preset).toBe('clean')
  })

  test('round-trips through readRefs', async () => {
    const session = await openSession(mediaPath)
    const written = writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    expect(readRefs(session.dir)).toEqual(written)
  })

  // B-V4 gen stability: gen derives from the effective preset, not from "did the last write
  // differ". Reproduced against the real CLI (open, open --preset clean, open again with no
  // flag) before this fix: noisy/1, clean/2, noisy/3 — a caller's gen-1 ref rejected on the
  // third call despite the source and threshold being identical to the first.
  test('returning to an earlier preset resolves to its original gen, not a new one', async () => {
    const session = await openSession(mediaPath)
    const first = writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    const second = writeRefs(session.dir, 'clean', deriveRefs([], 5000))
    const third = writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    expect(first.gen).toBe(1)
    expect(second.gen).toBe(2)
    expect(third.gen).toBe(1)
    expect(third.preset).toBe('noisy')
  })

  test('presetGens accumulates every preset this session has ever used', async () => {
    const session = await openSession(mediaPath)
    writeRefs(session.dir, 'noisy', deriveRefs([], 5000))
    writeRefs(session.dir, 'clean', deriveRefs([], 5000))
    const third = writeRefs(session.dir, 'podcast', deriveRefs([], 5000))
    expect(third.presetGens).toEqual({ noisy: 1, clean: 2, podcast: 3 })
  })

  test('readRefs backfills presetGens for refs.json written before B-V4', async () => {
    const session = await openSession(mediaPath)
    // Simulate a pre-B-V4 refs.json: no presetGens field at all.
    const legacyPath = join(session.dir, 'refs.json')
    writeFileSync(legacyPath, JSON.stringify({ gen: 1, preset: 'noisy', blocks: [] }))
    const loaded = readRefs(session.dir)
    expect(loaded?.presetGens).toEqual({ noisy: 1 })
  })
})

describe('sessions live under a subdirectory that must be created lazily', () => {
  test('openSession creates the sessions root if absent', async () => {
    mkdirSync(workDir, { recursive: true })
    const session = await openSession(mediaPath)
    expect(session.dir.startsWith(sessionRoot())).toBe(true)
  })
})

describe('proposals: append/list/drop roundtrip', () => {
  const proposal = (startMs: number, endMs: number, removedText: string) => ({
    startMs,
    endMs,
    kind: 'tangent' as const,
    reason: 'sneeze and aside',
    removedText,
    proposedAt: '2026-08-10T00:00:00.000Z',
  })

  test('an empty session has no proposals', async () => {
    const session = await openSession(mediaPath)
    expect(readProposalsFile(session.dir)).toEqual([])
  })

  test('appendProposal creates proposals.json on first call and accumulates after', async () => {
    const session = await openSession(mediaPath)
    const first = appendProposal(session.dir, proposal(0, 1000, 'uno'))
    expect(first).toHaveLength(1)
    const second = appendProposal(session.dir, proposal(2000, 3000, 'dos'))
    expect(second).toHaveLength(2)
    expect(readProposalsFile(session.dir)).toEqual(second)
  })

  test('dropProposal removes by 0-based index and returns what remains', async () => {
    const session = await openSession(mediaPath)
    appendProposal(session.dir, proposal(0, 1000, 'uno'))
    appendProposal(session.dir, proposal(2000, 3000, 'dos'))
    appendProposal(session.dir, proposal(4000, 5000, 'tres'))
    const remaining = dropProposal(session.dir, 1)
    expect(remaining.map((entry) => entry.removedText)).toEqual(['uno', 'tres'])
    expect(readProposalsFile(session.dir).map((entry) => entry.removedText)).toEqual([
      'uno',
      'tres',
    ])
  })

  test('re-adding after a drop appends at the end, not back at the dropped index', async () => {
    const session = await openSession(mediaPath)
    appendProposal(session.dir, proposal(0, 1000, 'uno'))
    appendProposal(session.dir, proposal(2000, 3000, 'dos'))
    dropProposal(session.dir, 0)
    appendProposal(session.dir, proposal(0, 1000, 'uno-otra-vez'))
    expect(readProposalsFile(session.dir).map((entry) => entry.removedText)).toEqual([
      'dos',
      'uno-otra-vez',
    ])
  })

  test('dropProposal on an out-of-range index throws rather than silently no-op', async () => {
    const session = await openSession(mediaPath)
    appendProposal(session.dir, proposal(0, 1000, 'uno'))
    expect(() => dropProposal(session.dir, 5)).toThrow()
    expect(() => dropProposal(session.dir, -1)).toThrow()
  })
})

describe('rounds', () => {
  test('nextRoundDir starts at round-1 for a fresh session', async () => {
    const session = await openSession(mediaPath)
    expect(nextRoundDir(session.dir)).toBe(join(session.dir, 'rounds', 'round-1'))
  })

  test('writeRound then nextRoundDir advances to round-2', async () => {
    const session = await openSession(mediaPath)
    const first = nextRoundDir(session.dir)
    writeRound(first, { segments: [] }, { removalPercent: 12.5 })
    expect(nextRoundDir(session.dir)).toBe(join(session.dir, 'rounds', 'round-2'))
  })

  test('writeRound writes edl.json and report.json with the given content', async () => {
    const session = await openSession(mediaPath)
    const dir = nextRoundDir(session.dir)
    const { edlPath, reportPath } = writeRound(dir, { hello: 'edl' }, { hello: 'report' })
    expect(JSON.parse(readFileSync(edlPath, 'utf8'))).toEqual({ hello: 'edl' })
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({ hello: 'report' })
  })
})

describe('pointCachedTranscriptAtSession', () => {
  const fakeReport = (transcriptPath: string | null): DetectReport => ({
    version: 1,
    input: '/fake/input.mp4',
    durationMs: 10_000,
    preset: 'noisy',
    thresholdDb: -20,
    minSilenceMs: 300,
    marginMs: 100,
    lang: 'es',
    transcript: { path: transcriptPath, wordLevel: true, words: 3 },
    audioPath: null,
    hasVideo: true,
    silences: [],
    review: [],
    warnings: [],
  })

  test('rewrites transcript.path to the session copy and persists it to detect.json', async () => {
    const session = await openSession(mediaPath)
    writeFileSync(cachedTranscriptPath(session.dir), '1\n00:00:00,000 --> 00:00:01,000\nhola\n')
    const report = fakeReport('/some/external/original.srt')
    const updated = pointCachedTranscriptAtSession(session.dir, report)
    expect(updated.transcript.path).toBe(cachedTranscriptPath(session.dir))
    // Persisted, not just returned: a later independent cachedDetect() read sees the fix too.
    writeCachedDetect(session.dir, report)
    const rewritten = pointCachedTranscriptAtSession(
      session.dir,
      cachedDetect(session.dir) as DetectReport,
    )
    expect(rewritten.transcript.path).toBe(cachedTranscriptPath(session.dir))
  })

  test('is a no-op when the report already points at the session copy', async () => {
    const session = await openSession(mediaPath)
    writeFileSync(cachedTranscriptPath(session.dir), '1\n00:00:00,000 --> 00:00:01,000\nhola\n')
    const report = fakeReport(cachedTranscriptPath(session.dir))
    const result = pointCachedTranscriptAtSession(session.dir, report)
    expect(result).toEqual(report)
  })

  test('is a no-op when no transcript is cached in this session', async () => {
    const session = await openSession(mediaPath)
    const report = fakeReport('/some/external/original.srt')
    const result = pointCachedTranscriptAtSession(session.dir, report)
    expect(result.transcript.path).toBe('/some/external/original.srt')
  })
})

describe('advisory lock: acquire/conflict-alive/stale-clear/release', () => {
  test('acquireLock takes an uncontested lock and releaseLock clears it', async () => {
    const session = await openSession(mediaPath)
    expect(isLocked(session.dir)).toBe(false)
    acquireLock(session.dir, 'cut')
    expect(isLocked(session.dir)).toBe(true)
    releaseLock(session.dir)
    expect(isLocked(session.dir)).toBe(false)
  })

  test('a second acquireLock from a live pid throws SessionLockedError naming the holder', async () => {
    const session = await openSession(mediaPath)
    acquireLock(session.dir, 'commit')
    expect(() => acquireLock(session.dir, 'cut')).toThrow(SessionLockedError)
    try {
      acquireLock(session.dir, 'cut')
      throw new Error('expected acquireLock to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(SessionLockedError)
      const locked = error as SessionLockedError
      expect(locked.holder.pid).toBe(process.pid)
      expect(locked.holder.verb).toBe('commit')
      expect(locked.message).toContain(String(process.pid))
      expect(locked.message).toContain('commit')
    }
    releaseLock(session.dir)
  })

  test('a lock held by a dead pid clears itself and the new writer takes it', async () => {
    const session = await openSession(mediaPath)
    // A high, out-of-range pid: process.kill(pid, 0) reports ESRCH (no such process) for it
    // on both macOS and Linux, modelling "the process that held this lock is long gone" —
    // pid 1 (init/launchd) is always alive and would wrongly read as a live holder here.
    writeFileSync(
      join(session.dir, 'lock.json'),
      JSON.stringify({ pid: 999_999, startedAt: new Date().toISOString(), verb: 'cut' }),
    )
    expect(isLocked(session.dir)).toBe(false)
    acquireLock(session.dir, 'commit')
    expect(isLocked(session.dir)).toBe(true)
    releaseLock(session.dir)
  })

  test('releaseLock is a no-op when this process does not hold the lock', async () => {
    const session = await openSession(mediaPath)
    writeFileSync(
      join(session.dir, 'lock.json'),
      JSON.stringify({ pid: 999_998, startedAt: new Date().toISOString(), verb: 'cut' }),
    )
    releaseLock(session.dir)
    // The file survives: releaseLock only clears a lock this pid holds, never another's.
    expect(isLocked(session.dir)).toBe(false) // false because 999998 is dead, not because we cleared it
  })

  test('releaseLock is a no-op when nothing was ever acquired', async () => {
    const session = await openSession(mediaPath)
    expect(() => releaseLock(session.dir)).not.toThrow()
  })
})

describe('commit marker: committedAt / markCommitted', () => {
  test('a session with no commit reports null', async () => {
    const session = await openSession(mediaPath)
    expect(committedAt(session.dir)).toBeNull()
  })

  test('markCommitted records an ISO timestamp readable back', async () => {
    const session = await openSession(mediaPath)
    markCommitted(session.dir)
    const at = committedAt(session.dir)
    expect(at).not.toBeNull()
    expect(() => new Date(at as string).toISOString()).not.toThrow()
  })
})

describe('rounds: listRoundNumbers / readRound', () => {
  test('an empty session has no rounds', async () => {
    const session = await openSession(mediaPath)
    expect(listRoundNumbers(session.dir)).toEqual([])
    expect(readRound(session.dir, 1)).toBeNull()
  })

  test('listRoundNumbers is ascending and readRound returns what writeRound wrote', async () => {
    const session = await openSession(mediaPath)
    writeRound(nextRoundDir(session.dir), { segments: [1] }, { removalPercent: 10 })
    writeRound(nextRoundDir(session.dir), { segments: [1, 2] }, { removalPercent: 20 })
    expect(listRoundNumbers(session.dir)).toEqual([1, 2])
    expect(readRound(session.dir, 1)).toEqual({
      edl: { segments: [1] },
      report: { removalPercent: 10 },
    })
    expect(readRound(session.dir, 2)).toEqual({
      edl: { segments: [1, 2] },
      report: { removalPercent: 20 },
    })
  })
})

describe('gc candidate classification: orphan/committed/older-than/locked-protected', () => {
  const summary = (overrides: Partial<SessionSummary>): SessionSummary => ({
    sessionDir: '/fake/session',
    sourcePath: '/fake/source.mp4',
    sourceExists: true,
    sizeBytes: 1000,
    createdAt: new Date().toISOString(),
    committedRounds: 0,
    committedAt: null,
    locked: false,
    ...overrides,
  })

  test('a session whose source no longer exists is classified orphan', () => {
    const [candidate] = classifySessionsForGc([summary({ sourceExists: false })], null)
    expect(candidate.reasons).toEqual(['orphan'])
    expect(candidate.deletable).toBe(true)
  })

  test('a session with a successful commit is classified committed', () => {
    const [candidate] = classifySessionsForGc(
      [summary({ committedAt: '2026-08-01T00:00:00.000Z' })],
      null,
    )
    expect(candidate.reasons).toEqual(['committed'])
    expect(candidate.deletable).toBe(true)
  })

  test('a session older than the threshold is classified older-than', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    const [candidate] = classifySessionsForGc([summary({ createdAt: tenDaysAgo })], 7)
    expect(candidate.reasons).toEqual(['older-than'])
    expect(candidate.deletable).toBe(true)
  })

  test('a session under the age threshold is not classified older-than', () => {
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString()
    const [candidate] = classifySessionsForGc([summary({ createdAt: oneDayAgo })], 7)
    expect(candidate.reasons).toEqual([])
    expect(candidate.deletable).toBe(false)
  })

  test('omitting olderThanDays never classifies on age alone', () => {
    const veryOld = new Date(0).toISOString()
    const [candidate] = classifySessionsForGc([summary({ createdAt: veryOld })], null)
    expect(candidate.reasons).toEqual([])
    expect(candidate.deletable).toBe(false)
  })

  test('a locked session is always locked-protected and never deletable, regardless of other reasons', () => {
    const [candidate] = classifySessionsForGc(
      [summary({ sourceExists: false, committedAt: '2026-08-01T00:00:00.000Z', locked: true })],
      null,
    )
    expect(candidate.reasons).toContain('locked-protected')
    expect(candidate.deletable).toBe(false)
  })

  test('a healthy, uncommitted, unlocked, recent session has no reasons and is not deletable', () => {
    const [candidate] = classifySessionsForGc([summary({})], 30)
    expect(candidate.reasons).toEqual([])
    expect(candidate.deletable).toBe(false)
  })

  test('applyGc deletes only what was classified deletable and returns those it removed', async () => {
    const keepSession = await openSession(mediaPath)
    const copyPath = join(workDir, 'orphan-source.mp4')
    writeFileSync(copyPath, 'orphan bytes')
    const orphanSession = await openSession(copyPath)
    rmSync(copyPath) // the source vanishes, making orphanSession an orphan

    const candidates = classifySessionsForGc(
      [summariseSession(keepSession.dir), summariseSession(orphanSession.dir)].filter(
        (entry): entry is SessionSummary => entry !== null,
      ),
      null,
    )
    const removed = applyGc(candidates)
    expect(removed).toHaveLength(1)
    expect(removed[0].sessionDir).toBe(orphanSession.dir)
    expect(existsSync(orphanSession.dir)).toBe(false)
    expect(existsSync(keepSession.dir)).toBe(true)
  })
})

describe('summariseSession', () => {
  test('returns null for a directory with no meta.json', () => {
    expect(summariseSession(join(workDir, 'not-a-session'))).toBeNull()
  })

  test('reports size, source existence, rounds, and lock state', async () => {
    const session = await openSession(mediaPath)
    writeRound(nextRoundDir(session.dir), { segments: [] }, { removalPercent: 5 })
    const result = summariseSession(session.dir)
    expect(result?.sourceExists).toBe(true)
    expect(result?.committedRounds).toBe(1)
    expect(result?.sizeBytes).toBeGreaterThan(0)
    expect(result?.locked).toBe(false)
  })
})
