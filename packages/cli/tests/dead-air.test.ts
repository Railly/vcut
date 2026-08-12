import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_MIN_PAUSE_MS,
  findSurvivingDeadAir,
  probeNoiseFloor,
  quietestWindowDb,
} from '../src/dead-air.ts'
import { run } from '../src/exec.ts'

describe('quietestWindowDb', () => {
  const astatsFrame = (timeS: number, db: number): string =>
    `frame:0    pts:0       pts_time:${timeS}\nlavfi.astats.Overall.RMS_level=${db}`

  test('finds the quietest 2s window across several buckets', () => {
    const frames = [
      astatsFrame(0, -20),
      astatsFrame(0.5, -20),
      astatsFrame(2.1, -50),
      astatsFrame(2.6, -50),
      astatsFrame(4.2, -25),
      astatsFrame(4.7, -25),
    ].join('\n')
    const result = quietestWindowDb(frames, 2)
    expect(result).not.toBeNull()
    expect(result?.floorDb).toBeCloseTo(-50, 1)
    expect(result?.windows).toBe(3)
  })

  test('averages in the linear-power domain, not the dB domain', () => {
    // Bucket 0 carries -20dB and -80dB together: a naive dB-domain mean would read -50dB.
    // Averaging in linear power (as RMS itself is defined) is dominated by the louder frame:
    // 10*log10((10^(-20/10) + 10^(-80/10)) / 2) is close to -23dB, nowhere near the dB-domain
    // midpoint. Two more buckets clear MIN_WINDOWS and stay loud enough that bucket 0 is still
    // the quietest either way this assertion could go wrong.
    const frames = [
      astatsFrame(0, -20),
      astatsFrame(0.1, -80),
      astatsFrame(2.1, -10),
      astatsFrame(4.1, -10),
    ].join('\n')
    const result = quietestWindowDb(frames, 2)
    expect(result?.floorDb).toBeGreaterThan(-30)
    expect(result?.floorDb).toBeLessThan(-20)
  })

  test('returns null when there are fewer than 3 windows', () => {
    const frames = [astatsFrame(0, -30), astatsFrame(0.5, -30)].join('\n')
    expect(quietestWindowDb(frames, 2)).toBeNull()
  })

  test('returns null on output with no parseable frames', () => {
    expect(quietestWindowDb('nothing usable here', 2)).toBeNull()
  })
})

let fixtureDir: string
// True silence (anullsrc) around a +6dB sine tone, matching audio-only.test.ts's own pattern:
// a bare sine wave's mean level reads too close to typical speech-detection thresholds to prove
// anything about calibration on its own, so the tone is boosted and the gaps are genuine digital
// silence, giving probeNoiseFloor a real, deep floor to measure and a real span above it to find.
let quietPath: string
// Same shape, entirely digital silence, for the "the file is silence and this call must not
// throw" edge.
let allSilentPath: string

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'vcut-dead-air-fixture-'))

  quietPath = join(fixtureDir, 'quiet.wav')
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=1.5',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:d=1.5',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=1.5',
    '-filter_complex',
    '[1:a]volume=6dB[loud];[0:a][loud][2:a]concat=n=3:v=0:a=1[a]',
    '-map',
    '[a]',
    quietPath,
  ])

  allSilentPath = join(fixtureDir, 'all-silent.wav')
  // Long enough to clear MIN_WINDOWS at the 2s bucket width probeNoiseFloor uses (3 buckets
  // needs > 4s of frames; 3s alone only clears two).
  await run('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo:d=7',
    allSilentPath,
  ])
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('probeNoiseFloor', () => {
  test('measures a deep floor on genuine digital silence, not the loud tone between it', async () => {
    const floor = await probeNoiseFloor(quietPath)
    expect(floor).not.toBeNull()
    // True silence sits far below the boosted tone; the floor this returns must read from the
    // silent windows, not get pulled toward the loud one by averaging across the whole file.
    expect(floor?.floorDb).toBeLessThan(-60)
    expect(floor?.thresholdDb).toBeGreaterThan(floor?.floorDb ?? 0)
  })

  test('a file that is entirely silence still returns a floor without throwing', async () => {
    const floor = await probeNoiseFloor(allSilentPath)
    expect(floor).not.toBeNull()
    expect(floor?.floorDb).toBeLessThan(-60)
  })
})

describe('findSurvivingDeadAir', () => {
  test('a calibrated threshold finds the true-silence gaps flanking the tone', async () => {
    const report = await findSurvivingDeadAir(quietPath, 500)
    expect(report.floor).not.toBeNull()
    // Two anullsrc spans (1.5s each) around a boosted tone: at a threshold calibrated to the
    // measured floor, both should surface as pauses over the 500ms minimum passed here.
    expect(report.pauses.length).toBeGreaterThanOrEqual(2)
    for (const pause of report.pauses) {
      expect(pause.durationMs).toBeGreaterThanOrEqual(500)
      expect(pause.endMs).toBeGreaterThan(pause.startMs)
    }
  })

  test('defaults minSilenceMs to 800ms, matching detect.ts silencedetect calls', () => {
    expect(DEFAULT_MIN_PAUSE_MS).toBe(800)
  })
})
