/**
 * Surviving dead air: silence measured on the render itself, at a threshold calibrated to that
 * render's own noise floor rather than a preset built for a different microphone.
 *
 * #43's two halves live here. Detection: `detect`'s preset thresholds (-20/-30/-35dB) assume a
 * raw mic. An "enhanced" track (Zoom-style, meeting-recorder noise suppression) carries a
 * processed floor tens of dB above true silence, so a fixed preset reads every pause as speech
 * and zero candidates surface. `probeNoiseFloor` answers this by measuring the quietest
 * contiguous window of the file rather than assuming a number: one `astats` pass emits an
 * RMS_level per audio frame (native ~85ms cadence at 48kHz), bucketed here into fixed windows,
 * and the quietest bucket's mean is the floor. Measured on a real 358.5s shipped preview
 * (2026-08-12): quietest 2s window sat at -50.2dB, second quietest at -48.6dB, a real plateau,
 * not a single silent instant, which is why the bucket is seconds wide rather than one frame.
 *
 * Verification: nothing downstream measured the render's own audio. `joins` verifies splices,
 * `audit` verifies correlation, `nonspeech` classifies flagged spans, all three read the EDL's
 * intent, none reads what survived it. `findSurvivingDeadAir` runs the same `silencedetect`
 * `detect.ts` already uses, at the calibrated threshold, directly against the rendered wav.
 *
 * The margin above the floor (not the floor itself) is the one constant this file owns.
 * `MARGIN_DB = 10` reproduced the -40dB manual baseline that named this issue almost exactly on
 * the fixture it was measured against: 13 spans over 0.8s, 17.8s total, longest 2.5s, at a
 * computed threshold of -40.22dB, with zero knowledge of "-40dB" fed in. `semantic.ts` already
 * treats "how far below a recording's own measured level" as the right shape for a threshold
 * with no natural fixed value (`QUIET_BELOW_MEDIAN_DB = 12`); this is the same idea anchored to
 * the floor rather than the median, because dead air is defined by how far it sits above true
 * silence, not by how far it sits below ordinary speech.
 */

import { parseSilenceLog, probeDurationMs, type SilenceCandidate } from './detect.ts'
import { run } from './exec.ts'

// Wide enough that a single near-silent phoneme gap inside ordinary speech does not skew the
// floor, narrow enough that a real pause of the length this check exists to catch still lands
// inside one bucket whole. Matches the width `semantic.ts`'s own segment-level dB probes treat
// as one unit of measurement.
const FLOOR_WINDOW_S = 2

// Added to the measured floor to set the detection threshold: quiet enough that ordinary
// speech at typical mic gain sits well above it, loud enough that the processed noise floor
// this issue is about (tens of dB above true digital silence) still reads as "silence" against
// it. Reproduced the issue's own -40dB manual baseline on the fixture it was measured against;
// see the module doc for the exact numbers.
const MARGIN_DB = 10

// The digital floor and short clicks read as spuriously "quiet" windows on very short or
// otherwise pathological input; a threshold derived from one such window would flag ordinary
// speech as silence. No real recording this check is built for is this short, so refusing
// gracefully (empty result) rather than emitting a threshold with no evidence behind it.
const MIN_WINDOWS = 3

export type NoiseFloor = {
  floorDb: number
  windowS: number
  thresholdDb: number
}

// astats reports true digital silence as "-inf", which a threshold this file derives by adding
// a margin cannot use directly: floorDb + MARGIN_DB on -Infinity is still -Infinity, a threshold
// silencedetect will never actually fire on (measured: silencedetect stopped registering true
// zero samples as silence somewhere between -90dB and -95dB, a float-precision floor of its own
// internal comparison, not a documented constant). -90dB is below any real recording's noise
// floor this module is built for (the fixture that named this issue measured -50.2dB at its
// quietest), so a genuinely silent probe clamps here rather than to a number outside
// silencedetect's own working range.
const SILENCE_FLOOR_DB = -90
const dbToLinear = (db: number): number => 10 ** (db / 20)
const linearToDb = (linear: number): number =>
  linear > 0 ? Math.max(SILENCE_FLOOR_DB, 20 * Math.log10(linear)) : SILENCE_FLOOR_DB

/**
 * The quietest `windowS`-second window's mean RMS, in dB, from a single `astats` pass. Frames
 * arrive at the encoder's native cadence (not exactly `windowS` apart), so they are bucketed by
 * `pts_time` into fixed windows and averaged in the linear-power domain, matching how RMS
 * itself is defined (a dB-domain mean of dB-domain frames is not the same quantity).
 */
export const quietestWindowDb = (
  metadataOutput: string,
  windowS: number,
): { floorDb: number; windows: number } | null => {
  const buckets = new Map<number, number[]>()
  let pendingTimeS: number | null = null

  for (const rawLine of metadataOutput.split('\n')) {
    const timeMatch = rawLine.match(/pts_time:([\d.]+)/)
    if (timeMatch !== null) {
      pendingTimeS = Number(timeMatch[1])
      continue
    }
    // astats reports true digital silence as the literal string "-inf" rather than a very
    // negative number, which Number() reads as NaN, not -Infinity. Genuine silence is exactly
    // the case a noise-floor probe most needs to see, so it is read explicitly here rather than
    // dropped for failing a digits-only pattern.
    const dbMatch = rawLine.match(/RMS_level=(-inf|-?[\d.]+)/)
    if (dbMatch !== null && pendingTimeS !== null) {
      const bucket = Math.floor(pendingTimeS / windowS)
      const values = buckets.get(bucket) ?? []
      values.push(dbMatch[1] === '-inf' ? Number.NEGATIVE_INFINITY : Number(dbMatch[1]))
      buckets.set(bucket, values)
      pendingTimeS = null
    }
  }

  if (buckets.size < MIN_WINDOWS) {
    return null
  }

  let quietestDb = Number.POSITIVE_INFINITY
  for (const values of buckets.values()) {
    const meanLinear =
      values.reduce((total, db) => total + dbToLinear(db), 0) / Math.max(1, values.length)
    const meanDb = linearToDb(meanLinear)
    if (meanDb < quietestDb) {
      quietestDb = meanDb
    }
  }

  return { floorDb: quietestDb, windows: buckets.size }
}

/**
 * One `astats` pass over the whole file, one JS pass over its metadata output: no per-window
 * ffmpeg invocation, the same "one call, once" shape `detect.ts`'s own probes already follow.
 * `reset=1` recomputes stats per frame rather than accumulating across the whole file, which is
 * what makes each emitted RMS_level a local reading instead of a running average.
 */
export const probeNoiseFloor = async (input: string): Promise<NoiseFloor | null> => {
  const { stdout, stderr, exitCode } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-af',
    'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-',
    '-f',
    'null',
    '-',
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with ${exitCode}`)
  }
  const measured = quietestWindowDb(stdout, FLOOR_WINDOW_S)
  if (measured === null) {
    return null
  }
  return {
    floorDb: measured.floorDb,
    windowS: FLOOR_WINDOW_S,
    thresholdDb: measured.floorDb + MARGIN_DB,
  }
}

export type SurvivingPause = {
  startMs: number
  endMs: number
  durationMs: number
}

export type SurvivingDeadAirReport = {
  input: string
  durationMs: number
  floor: NoiseFloor | null
  minSilenceMs: number
  pauses: SurvivingPause[]
}

// Long enough that ordinary word-to-word breathing does not count, short enough to still catch
// the class of pause this issue names (2.5s to 19.9s observed). Matches the `d=0.8` (800ms)
// `detect`'s own silencedetect calls already use as their floor for "worth reporting."
export const DEFAULT_MIN_PAUSE_MS = 800

/**
 * Silence measured directly on `input` (the rendered media) at a threshold calibrated to that
 * same file's own noise floor. `null` floor (too short to measure, or ametadata emitted no
 * usable frames) reports zero pauses rather than guessing a threshold with no evidence behind
 * it, the same shape `commit`'s metaSpeech pass already uses for "nothing to check yet."
 */
export const findSurvivingDeadAir = async (
  input: string,
  minSilenceMs: number = DEFAULT_MIN_PAUSE_MS,
): Promise<SurvivingDeadAirReport> => {
  const durationMs = await probeDurationMs(input)
  const floor = await probeNoiseFloor(input)
  if (floor === null) {
    return { input, durationMs, floor: null, minSilenceMs, pauses: [] }
  }

  const { stderr, exitCode } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    input,
    '-af',
    `silencedetect=noise=${floor.thresholdDb.toFixed(2)}dB:d=${(minSilenceMs / 1000).toFixed(3)}`,
    '-f',
    'null',
    '-',
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited with ${exitCode}`)
  }

  const candidates: SilenceCandidate[] = parseSilenceLog(stderr, durationMs)
  const pauses: SurvivingPause[] = candidates.map((candidate) => ({
    startMs: candidate.startMs,
    endMs: candidate.endMs,
    durationMs: candidate.durationMs,
  }))

  return { input, durationMs, floor, minSilenceMs, pauses }
}
