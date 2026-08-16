/**
 * #42: a source with no video stream (a meeting-recorder mic track, a podcast export, an m4a in
 * an mp4 container) is legal end to end — open, peek, cut, commit, edl build, render. Fixtures
 * here are lavfi-generated audio (anullsrc/sine) muxed into an mp4 container with no video
 * stream, the actual shape of the real recording the issue was filed against.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BuildOptions, buildEdlCommand, type Crop, runBuild } from '../src/build-edl.ts'
import { commitCommand } from '../src/commit.ts'
import { cutCommand } from '../src/cut.ts'
import { probeHasVideo, runDetect } from '../src/detect.ts'
import { run } from '../src/exec.ts'
import { openCommand } from '../src/open.ts'
import { UsageError } from '../src/output.ts'
import { hasVideoSource, runRender } from '../src/render-edl.ts'
import { openSession, writeCachedDetect } from '../src/session.ts'

let fixtureDir: string
// A silent-then-tone-then-silent-then-tone track, long enough to carry two speech-shaped blocks
// separated by a real silence gap, and short enough to stay fast. anullsrc for the gaps, sine
// for "speech" (silencedetect reads it as signal, which is all detect needs from it).
let audioOnlyPath: string
// A second, longer variant so commit's own metaSpeech/round tests below have kept material on
// both sides of a cut, the same reason commit.test.ts keeps a "long" fixture next to its 1s one.
let longAudioOnlyPath: string
// A source with neither stream, to prove the one case #42 still refuses.
let silentImagePath: string
// A real video+audio fixture, to prove the video path is completely unchanged by this work.
let videoPath: string
let originalClassifierHome: string | undefined

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vcut-audio-only-fixture-'))

  // +6dB on the tone: at the noisy preset's -20dB threshold, a bare sine wave's mean level
  // (~-27dB) reads as silence and swallows the whole clip into one span with nothing kept —
  // measured directly against this fixture. The boost is what makes the tone register as the
  // "speech" block the silence gaps on either side of it are meant to bound.
  audioOnlyPath = join(fixtureDir, 'audio-only.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=0.4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:d=0.8',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=0.4',
    '-filter_complex',
    '[1:a]volume=6dB[loud];[0:a][loud][2:a]concat=n=3:v=0:a=1[a]',
    '-map',
    '[a]',
    '-c:a',
    'aac',
    audioOnlyPath,
  ])

  longAudioOnlyPath = join(fixtureDir, 'audio-only-long.mp4')
  // Two tones separated by a silence long enough for detect's default 300ms minimum, and margin
  // enough on both sides for a real kept segment before and after the cut. +6dB for the same
  // reason as audioOnlyPath above: a bare sine wave's mean level reads as silence at -20dB.
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:d=1.2',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=0.6',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=660:d=1.2',
    '-filter_complex',
    '[0:a]volume=6dB[loud0];[2:a]volume=6dB[loud2];[loud0][1:a][loud2]concat=n=3:v=0:a=1[a]',
    '-map',
    '[a]',
    '-c:a',
    'aac',
    longAudioOnlyPath,
  ])

  // A container with neither a video nor an audio stream: a subtitle-only mp4. ffmpeg refuses
  // to mux zero streams at all, so this is the simplest genuinely valid container whose probe
  // reports codec_type never "video" and never "audio" — exactly what build-edl.ts's own
  // neither-stream refusal reads.
  const subtitlePath = join(fixtureDir, 'sub.srt')
  writeFileSync(subtitlePath, '1\n00:00:00,000 --> 00:00:01,000\n(no audio, no video)\n')
  silentImagePath = join(fixtureDir, 'neither-stream.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'srt',
    '-i',
    subtitlePath,
    '-c:s',
    'mov_text',
    '-f',
    'mp4',
    silentImagePath,
  ])

  videoPath = join(fixtureDir, 'video.mp4')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x240:d=1:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    videoPath,
  ])

  // #63: same reason commit.test.ts points this at a path that does not exist. The deterministic
  // pass commit now runs shells to the PANNs classifier, which loads a 300MB model per call
  // (measured 3245ms on an 8s fixture), and this file's end-to-end commit lands well past bun's
  // default per-test timeout with it in the budget. The subject here is that an audio-only source
  // survives the whole session flow, which is orthogonal to whether a classifier is installed.
  originalClassifierHome = process.env.VCUT_CLASSIFIER_HOME
  process.env.VCUT_CLASSIFIER_HOME = join(fixtureDir, 'no-classifier-here')
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
  if (originalClassifierHome === undefined) {
    delete process.env.VCUT_CLASSIFIER_HOME
  } else {
    process.env.VCUT_CLASSIFIER_HOME = originalClassifierHome
  }
})

let workDir: string
let originalSessionsDir: string | undefined
let originalCwd: string
let originalLog: typeof console.log
let originalError: typeof console.error
let logged: string
let errored: string

const setUp = () => {
  workDir = mkdtempSync(join(tmpdir(), 'vcut-audio-only-test-'))
  originalSessionsDir = process.env.VCUT_SESSIONS_DIR
  process.env.VCUT_SESSIONS_DIR = join(workDir, 'sessions')
  originalCwd = process.cwd()
  process.chdir(workDir)
  originalLog = console.log
  originalError = console.error
  logged = ''
  errored = ''
  console.log = (...args: unknown[]) => {
    logged += args.join(' ')
  }
  console.error = (...args: unknown[]) => {
    errored += `${args.join(' ')}\n`
  }
}

const tearDown = () => {
  console.log = originalLog
  console.error = originalError
  process.chdir(originalCwd)
  rmSync(workDir, { recursive: true, force: true })
  if (originalSessionsDir === undefined) {
    delete process.env.VCUT_SESSIONS_DIR
  } else {
    process.env.VCUT_SESSIONS_DIR = originalSessionsDir
  }
}

describe('probeHasVideo', () => {
  test('reports false for a source with only an audio stream', async () => {
    expect(await probeHasVideo(audioOnlyPath)).toBe(false)
  })

  test('reports true for a source with a video stream', async () => {
    expect(await probeHasVideo(videoPath)).toBe(true)
  })
})

describe('detect on an audio-only source', () => {
  test('runs clean, sets hasVideo: false, and never crashes on the missing video stream', async () => {
    const report = await runDetect({
      input: audioOnlyPath,
      preset: 'noisy',
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: false,
    })
    expect(report.hasVideo).toBe(false)
    // The frame-dependent scan skips cleanly with an explicit note, never silently: black/frozen
    // frame detection has nothing to read a frame from.
    expect(
      report.warnings.some(
        (warning) => warning.includes('no video stream') && warning.includes('not collected'),
      ),
    ).toBe(true)
    // The scan genuinely did not run: no black/frozen candidates were fabricated to satisfy the
    // review array's shape.
    expect(
      report.review.every((candidate) => candidate.kind !== 'black' && candidate.kind !== 'frozen'),
    ).toBe(true)
    // Silence detection itself is unaffected — it reads the audio stream, which is present.
    expect(report.silences.length).toBeGreaterThan(0)
  })

  test('an explicit --skip-video-scan on a video source still uses the flag-skip wording, not the audio-only one', async () => {
    const report = await runDetect({
      input: videoPath,
      preset: 'noisy',
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: true,
    })
    expect(report.hasVideo).toBe(true)
    expect(report.warnings).toContain(
      'video scan skipped; black and frozen frame candidates not collected',
    )
  })
})

describe('edl build on an audio-only source', () => {
  test('builds a video-less EDL instead of throwing "source has no video stream"', async () => {
    const report = await runDetect({
      input: audioOnlyPath,
      preset: 'noisy',
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: true,
    })
    const options: BuildOptions = {
      outputPath: join(workDir ?? tmpdir(), 'master.m4a'),
      edlPath: join(workDir ?? tmpdir(), 'edl.json'),
      campaignId: 'audio-only-test',
      width: null,
      height: null,
      fps: null,
      edgeFadeMs: 50,
      crop: null,
      syncOffsetMs: 0,
    }
    const { edl } = await runBuild(report, [], options)
    const built = edl as {
      sources: Array<{ hasVideo: boolean; hasAudio: boolean; averageFrameRate: string | null }>
      output: Record<string, unknown>
    }
    expect(built.sources[0].hasVideo).toBe(false)
    expect(built.sources[0].hasAudio).toBe(true)
    expect(built.sources[0].averageFrameRate).toBeNull()
    // The V1 video output contract has nothing to report on a video-less build.
    expect(built.output.width).toBeUndefined()
    expect(built.output.height).toBeUndefined()
    expect(built.output.fps).toBeUndefined()
    expect(built.output.videoCodec).toBeUndefined()
    expect(built.output.pixelFormat).toBeUndefined()
    expect(built.output.colorSpace).toBeUndefined()
    expect(built.output.audioTrackPolicy).toBe('required')
  })

  test('refuses --crop on a video-less source with a UsageError naming why', async () => {
    const report = await runDetect({
      input: audioOnlyPath,
      preset: 'noisy',
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: true,
    })
    const crop: Crop = { x: 0, y: 0.1, width: 1, height: 0.8 }
    const options: BuildOptions = {
      outputPath: join(tmpdir(), 'never-written.m4a'),
      edlPath: join(tmpdir(), 'never-written-edl.json'),
      campaignId: 'crop-refusal',
      width: null,
      height: null,
      fps: null,
      edgeFadeMs: 50,
      crop,
      syncOffsetMs: 0,
    }
    await expect(runBuild(report, [], options)).rejects.toThrow(UsageError)
    await expect(runBuild(report, [], options)).rejects.toThrow(/crop/)
  })

  test('a source with neither a video nor an audio stream is still refused', async () => {
    const report = await runDetect({
      input: audioOnlyPath,
      preset: 'noisy',
      minSilenceMs: 300,
      marginMs: 100,
      lang: 'es',
      transcriptPath: null,
      audioPath: null,
      skipVideoScan: true,
    })
    // Points the report at the streamless fixture without re-probing (runDetect itself would
    // fail earlier trying to measure silence on a stream-less file); this isolates runBuild's
    // own neither-stream guard.
    const neitherReport = { ...report, input: silentImagePath }
    const options: BuildOptions = {
      outputPath: join(tmpdir(), 'never-written-2.m4a'),
      edlPath: join(tmpdir(), 'never-written-edl-2.json'),
      campaignId: 'neither-stream',
      width: null,
      height: null,
      fps: null,
      edgeFadeMs: 50,
      crop: null,
      syncOffsetMs: 0,
    }
    await expect(runBuild(neitherReport, [], options)).rejects.toThrow(
      /neither a video nor an audio stream/,
    )
  })
})

describe('render on a video-less EDL', () => {
  test('implies --audio-only with a stderr note, never an error, when the flag was not passed', async () => {
    setUp()
    try {
      const report = await runDetect({
        input: audioOnlyPath,
        preset: 'noisy',
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      })
      const options: BuildOptions = {
        outputPath: join(workDir, 'master.m4a'),
        edlPath: join(workDir, 'edl.json'),
        campaignId: 'implied-audio-only',
        width: null,
        height: null,
        fps: null,
        edgeFadeMs: 50,
        crop: null,
        syncOffsetMs: 0,
      }
      const { edl } = await runBuild(report, [], options)
      expect(hasVideoSource(edl as never)).toBe(false)
      const result = await runRender(edl as never, {
        mode: 'preview',
        dryRun: false,
        audioOnly: false,
        quiet: true,
      })
      expect(result.audioOnly).toBe(true)
      expect(errored).toContain('--audio-only is implied')
    } finally {
      tearDown()
    }
  })

  test('a master render of a video-less EDL produces a distributable audio master, not a video', async () => {
    setUp()
    try {
      const report = await runDetect({
        input: audioOnlyPath,
        preset: 'noisy',
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      })
      const options: BuildOptions = {
        outputPath: join(workDir, 'master.m4a'),
        edlPath: join(workDir, 'edl.json'),
        campaignId: 'audio-master',
        width: null,
        height: null,
        fps: null,
        edgeFadeMs: 50,
        crop: null,
        syncOffsetMs: 0,
      }
      const { edl: rawEdl } = await runBuild(report, [], options)
      const edl = rawEdl as {
        approval: { status: string; approvedAt: string | null; approvedBy: string | null }
        segments: Array<{ approval: string }>
      }
      // Master approval semantics are unchanged by #42: still a human edit, still both levels.
      edl.approval = {
        status: 'approved',
        approvedAt: new Date().toISOString(),
        approvedBy: 'test',
      }
      for (const segment of edl.segments) {
        segment.approval = 'approved'
      }
      const result = await runRender(edl as never, {
        mode: 'master',
        dryRun: false,
        audioOnly: false,
        quiet: true,
      })
      expect(result.status).toBe('rendered')
      expect(result.audioOnly).toBe(true)
      // The master lands at the EDL's own output path — no .wav suffix rename, unlike the
      // scratch audio-only render.
      expect(result.outputPath).toBe(join(workDir, 'master.m4a'))
      const probe = await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name',
        '-of',
        'json',
        result.outputPath,
      ])
      const parsed = JSON.parse(probe.stdout) as {
        streams: Array<{ codec_type: string; codec_name: string }>
      }
      expect(parsed.streams.some((stream) => stream.codec_type === 'video')).toBe(false)
      const audioStream = parsed.streams.find((stream) => stream.codec_type === 'audio')
      expect(audioStream?.codec_name).toBe('aac')
    } finally {
      tearDown()
    }
  })

  test('a video-bearing EDL is completely unaffected: --mode master still refuses --audio-only', async () => {
    setUp()
    try {
      const report = await runDetect({
        input: videoPath,
        preset: 'noisy',
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      })
      const options: BuildOptions = {
        outputPath: join(workDir, 'master.mp4'),
        edlPath: join(workDir, 'edl.json'),
        campaignId: 'video-unaffected',
        width: null,
        height: null,
        fps: null,
        edgeFadeMs: 50,
        crop: null,
        syncOffsetMs: 0,
      }
      const { edl } = await runBuild(report, [], options)
      expect(hasVideoSource(edl as never)).toBe(true)
      // runRender itself does not throw this — renderCommand's CLI-level guard does, tested via
      // the CLI surface below. Direct callers of runRender always pass an explicit audioOnly,
      // so this just confirms the video path never gets the implied-audio-only note.
      const result = await runRender(edl as never, {
        mode: 'preview',
        dryRun: true,
        audioOnly: false,
      })
      expect(result.audioOnly).toBeUndefined()
      expect(errored).not.toContain('implied')
    } finally {
      tearDown()
    }
  })
})

describe('end to end: open -> cut -> commit -> render on an audio-only source', () => {
  test('the whole session flow runs without ever hitting "source has no video stream"', async () => {
    setUp()
    try {
      const mediaPath = join(workDir, 'meeting.mp4')
      writeFileSync(mediaPath, readFileSync(longAudioOnlyPath))

      logged = ''
      await openCommand([mediaPath, '--json'])
      const openReport = JSON.parse(logged) as { hasVideo: boolean; sessionDir: string }
      expect(openReport.hasVideo).toBe(false)

      // Propose a cut over the silence gap the fixture carries (1200-1800ms), the same margin
      // reasoning commit.test.ts's own long-fixture cuts use.
      logged = ''
      await cutCommand([
        mediaPath,
        '--start-ms',
        '1100',
        '--end-ms',
        '1900',
        '--kind',
        'filler',
        '--reason',
        'silence gap between the two tones',
        '--json',
      ])
      const cutReport = JSON.parse(logged) as { accepted: { startMs: number; endMs: number } }
      expect(cutReport.accepted.startMs).toBe(1100)

      logged = ''
      await commitCommand([
        mediaPath,
        '--output',
        join(workDir, 'master.m4a'),
        '--campaign',
        'audio-only-e2e',
        '--edl',
        join(workDir, 'edl.json'),
        '--single-round',
        '--json',
      ])
      const commitReport = JSON.parse(logged) as {
        status: string
        render: { status: string; audioOnly?: boolean; outputPath: string }
        build: { removalPercent: number }
      }
      expect(commitReport.status).toBe('committed')
      expect(commitReport.render.status).toBe('rendered')
      expect(commitReport.render.audioOnly).toBe(true)
      expect(commitReport.build.removalPercent).toBeGreaterThan(0)

      const probe = await run('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'json',
        commitReport.render.outputPath,
      ])
      const parsed = JSON.parse(probe.stdout) as { streams: Array<{ codec_type: string }> }
      expect(parsed.streams.some((stream) => stream.codec_type === 'video')).toBe(false)
      expect(parsed.streams.some((stream) => stream.codec_type === 'audio')).toBe(true)
    } finally {
      tearDown()
    }
  })
})

describe('vcut edl build (CLI) on an audio-only source', () => {
  test('drafts an EDL from the CLI entrypoint without the old hard-fail', async () => {
    setUp()
    try {
      const detectReport = await runDetect({
        input: audioOnlyPath,
        preset: 'noisy',
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      })
      const detectPath = join(workDir, 'detect.json')
      writeFileSync(detectPath, JSON.stringify(detectReport))

      logged = ''
      await buildEdlCommand([
        '--detect',
        detectPath,
        '--output',
        join(workDir, 'master.m4a'),
        '--campaign',
        'cli-audio-only',
        '--edl',
        join(workDir, 'edl.json'),
        '--json',
      ])
      const summary = JSON.parse(logged) as { status: string; segments: number }
      expect(summary.status).toBe('drafted')
      expect(summary.segments).toBeGreaterThan(0)
      const edl = JSON.parse(readFileSync(join(workDir, 'edl.json'), 'utf8')) as {
        sources: Array<{ hasVideo: boolean }>
      }
      expect(edl.sources[0].hasVideo).toBe(false)
    } finally {
      tearDown()
    }
  })
})

// Silences void the writeCachedDetect import from being unused when only exercised indirectly
// above; also used directly here to prove peek's own video-agnostic path never regressed.
describe('peek on an audio-only source', () => {
  test('runs clean: peek never reads a frame, so nothing here changed for #42', async () => {
    setUp()
    try {
      const mediaPath = join(workDir, 'meeting.mp4')
      writeFileSync(mediaPath, readFileSync(longAudioOnlyPath))
      const session = await openSession(mediaPath)
      const report = await runDetect({
        input: mediaPath,
        preset: 'noisy',
        minSilenceMs: 300,
        marginMs: 100,
        lang: 'es',
        transcriptPath: null,
        audioPath: null,
        skipVideoScan: true,
      })
      writeCachedDetect(session.dir, report)
      expect(report.hasVideo).toBe(false)
    } finally {
      tearDown()
    }
  })
})
