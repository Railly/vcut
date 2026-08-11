import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DetectReport } from '../src/detect.ts'
import {
  cachedDetect,
  checkSession,
  deriveRefs,
  openSession,
  readMeta,
  readRefs,
  sessionRoot,
  sha256File,
  shaDirName,
  writeCachedDetect,
  writeRefs,
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
})

describe('sessions live under a subdirectory that must be created lazily', () => {
  test('openSession creates the sessions root if absent', async () => {
    mkdirSync(workDir, { recursive: true })
    const session = await openSession(mediaPath)
    expect(session.dir.startsWith(sessionRoot())).toBe(true)
  })
})
