/**
 * `vcut audit` - check that a render carries the audio its EDL asked for.
 *
 * Separate from `render` on purpose. The renderer's own validation must stay fast and must
 * fail closed; this decodes windows out of two files and reports a similarity score, which
 * is neither. Keeping it a command means a low score is something a person or an agent looks
 * at, rather than a threshold that blocks a render on a measurement that has known blind
 * spots for quiet and short segments.
 */

import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { auditPlan, type BoundaryCheck, compareBoundary } from './audit.ts'
import { placements } from './locate.ts'
import { emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import type { Edl } from './render-edl.ts'

const HELP = `vcut audit - check a render against the EDL it came from

Usage:
  vcut audit --edl <path> --render <path> [flags]

Flags:
  --edl <path>       Edit decision list the render was built from (required)
  --render <path>    Rendered file to check (required)
  --source <path>    Source to compare against (default: the EDL's own source)
  --json / --human   Output mode
  --help             Show this message

Every check the renderer already runs is an aggregate: dimensions, frame count, duration.
A render whose segments carried the wrong material passes all of them. This compares the
audio itself, segment by segment, against the source the EDL says each one came from.

--render accepts an audio-only render. Every measurement here runs on the waveform, never
the picture, so the .wav vcut render --audio-only writes checks exactly as well as a video
render of the same cut, at a fraction of the wall clock. Use it for every round; render
video once, at the end, for the master.

A low score is a place to look, not a verdict. Correlation over a short window is weak on
quiet passages, and loudness normalisation reshapes them further. Confirm with vcut say
before believing a number here.`

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

// Where the shape of two envelopes stops being recognisably the same. Measured on one
// 22-segment render: 21 boundaries scored 0.85 or better, and the one below was verified by
// transcription to hold the right words, so this marks what to inspect rather than what is
// broken.
const LOOK_AT_BELOW = 0.8

export const auditCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const edlPath = flagValue(argv, '--edl')
  const renderPath = flagValue(argv, '--render')
  if (edlPath === undefined || renderPath === undefined) {
    throw new UsageError(HELP)
  }
  const resolvedEdl = resolve(edlPath)
  const resolvedRender = resolve(renderPath)
  if (!existsSync(resolvedEdl)) {
    throw new UsageError(`no EDL at ${resolvedEdl}`)
  }
  if (!existsSync(resolvedRender)) {
    throw new UsageError(`no render at ${resolvedRender}`)
  }

  const edl = JSON.parse(readFileSync(resolvedEdl, 'utf8')) as Edl
  const sourcePath = resolve(flagValue(argv, '--source') ?? edl.sources[0]?.path ?? '')
  if (!existsSync(sourcePath)) {
    throw new UsageError(`no source at ${sourcePath}. Pass --source if it moved.`)
  }

  const map = placements(edl)
  const plan = auditPlan(map)
  const scratch = join(tmpdir(), `vcut-audit-${process.pid}`)

  const checks: BoundaryCheck[] = []
  for (const entry of plan) {
    const check = await compareBoundary(resolvedRender, sourcePath, entry, scratch)
    if (check !== null) {
      checks.push(check)
    }
  }

  const lowest = [...checks].sort((left, right) => left.correlation - right.correlation)
  const suspect = lowest.filter((check) => check.correlation < LOOK_AT_BELOW)
  const skipped = map.length - plan.length

  if (mode === 'json') {
    emitJson({
      segments: map.length,
      checked: checks.length,
      skippedTooShort: skipped,
      lookAtBelow: LOOK_AT_BELOW,
      suspect,
      checks,
    })
    return
  }

  const lines = [
    heading(`audit  ${checks.length} of ${map.length} segments compared`),
    line('agreeing', `${checks.length - suspect.length} at or above ${LOOK_AT_BELOW} correlation`),
  ]
  if (skipped > 0) {
    lines.push(line('not compared', `${skipped} too short to score meaningfully`))
  }
  if (suspect.length === 0) {
    lines.push(line('worth a look', 'none'))
  }
  for (const check of suspect) {
    lines.push(
      line(
        check.id,
        `correlation ${check.correlation.toFixed(3)} at master ${seconds(check.masterMs)} (source ${seconds(check.sourceMs)})`,
      ),
    )
  }
  if (suspect.length > 0) {
    lines.push(
      line(
        'next',
        `vcut say ${renderPath} --transcript <srt> --at ${seconds(suspect[0]?.masterMs ?? 0)}`,
      ),
    )
    lines.push(
      line(
        'note',
        'a low score is weak evidence on quiet or short segments. Read the words before believing it',
      ),
    )
  }
  console.log(lines.join('\n'))
}
