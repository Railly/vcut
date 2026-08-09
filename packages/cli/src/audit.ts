/**
 * Does the render carry the audio the EDL asked for, at each boundary.
 *
 * The renderer already validates its output: dimensions, pixel format, colour metadata,
 * frame count, duration, the audio contract. Every one of those is an aggregate, so a render
 * whose segments landed in the wrong place passes all of them — the total duration is right
 * because the segment durations are right, whatever material ended up inside them.
 *
 * This measures the substance instead: for each segment, take a window of the render and the
 * window of the source the EDL says it came from, reduce both to a loudness envelope, and
 * correlate. A join that carried the wrong material scores low.
 *
 * What a low score means is narrower than it looks, which is the reason this reports rather
 * than fails. Correlation is a similarity measure over a short window, and loudness
 * normalisation reshapes quiet passages, so a quiet or short segment can score low while
 * carrying exactly the right audio. Measured on one 22-segment render: 21 segments scored
 * above 0.8 and the one that did not was verified by transcription to hold the correct words.
 * A number here is a place to look, not a verdict.
 */

import { existsSync, readFileSync } from 'node:fs'

import { run } from './exec.ts'

export type Envelope = number[]

/**
 * Root mean square per window. 10ms at 16kHz keeps speech shape while discarding the
 * waveform detail that never survives an encode anyway.
 */
export const envelope = (samples: Float32Array, windowSize = 160): Envelope => {
  const result: Envelope = []
  for (let index = 0; index + windowSize <= samples.length; index += windowSize) {
    let sum = 0
    for (let offset = 0; offset < windowSize; offset += 1) {
      const sample = samples[index + offset] ?? 0
      sum += sample * sample
    }
    result.push(Math.sqrt(sum / windowSize))
  }
  return result
}

/**
 * Pearson correlation, which is already invariant to gain: loudness normalisation changes
 * the level of a passage without changing the shape being compared.
 */
export const correlate = (left: Envelope, right: Envelope): number => {
  const length = Math.min(left.length, right.length)
  if (length === 0) {
    return 0
  }
  const meanLeft = left.slice(0, length).reduce((total, value) => total + value, 0) / length
  const meanRight = right.slice(0, length).reduce((total, value) => total + value, 0) / length
  let numerator = 0
  let varianceLeft = 0
  let varianceRight = 0
  for (let index = 0; index < length; index += 1) {
    const a = (left[index] ?? 0) - meanLeft
    const b = (right[index] ?? 0) - meanRight
    numerator += a * b
    varianceLeft += a * a
    varianceRight += b * b
  }
  // A flat window has no shape to match, so there is nothing to claim either way.
  if (varianceLeft === 0 || varianceRight === 0) {
    return 0
  }
  return numerator / Math.sqrt(varianceLeft * varianceRight)
}

export const readWavSamples = (path: string): Float32Array => {
  const buffer = readFileSync(path)
  const HEADER_BYTES = 44
  const count = Math.max(0, Math.floor((buffer.length - HEADER_BYTES) / 2))
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = buffer.readInt16LE(HEADER_BYTES + index * 2) / 32768
  }
  return samples
}

const extract = async (
  source: string,
  startSeconds: number,
  durationSeconds: number,
  target: string,
): Promise<boolean> => {
  const { exitCode } = await run('ffmpeg', [
    '-v',
    'error',
    '-ss',
    startSeconds.toFixed(3),
    '-t',
    durationSeconds.toFixed(3),
    '-i',
    source,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-y',
    target,
  ])
  return exitCode === 0 && existsSync(target)
}

export type BoundaryCheck = {
  id: string
  masterMs: number
  sourceMs: number
  correlation: number
  windowMs: number
}

/**
 * One comparison per segment, skipping segments too short to carry a meaningful window: a
 * quarter second of audio correlates with almost anything, so scoring it would add noise
 * rather than coverage.
 */
export const auditPlan = (
  placements: Array<{ id: string; masterInMs: number; masterOutMs: number; sourceInMs: number }>,
  maxWindowMs = 1500,
  leadInMs = 100,
): Array<{ id: string; masterMs: number; sourceMs: number; windowMs: number }> =>
  placements
    .map((placement) => {
      const spanMs = placement.masterOutMs - placement.masterInMs
      const windowMs = Math.min(maxWindowMs, Math.floor(spanMs * 0.8))
      return {
        id: placement.id,
        masterMs: placement.masterInMs + leadInMs,
        sourceMs: placement.sourceInMs + leadInMs,
        windowMs,
      }
    })
    .filter((entry) => entry.windowMs >= 400)

export const compareBoundary = async (
  renderPath: string,
  sourcePath: string,
  entry: { id: string; masterMs: number; sourceMs: number; windowMs: number },
  scratchPrefix: string,
): Promise<BoundaryCheck | null> => {
  const renderWav = `${scratchPrefix}-render.wav`
  const sourceWav = `${scratchPrefix}-source.wav`
  const windowSeconds = entry.windowMs / 1000
  const gotRender = await extract(renderPath, entry.masterMs / 1000, windowSeconds, renderWav)
  const gotSource = await extract(sourcePath, entry.sourceMs / 1000, windowSeconds, sourceWav)
  if (!gotRender || !gotSource) {
    return null
  }
  return {
    id: entry.id,
    masterMs: entry.masterMs,
    sourceMs: entry.sourceMs,
    windowMs: entry.windowMs,
    correlation: correlate(
      envelope(readWavSamples(renderWav)),
      envelope(readWavSamples(sourceWav)),
    ),
  }
}
