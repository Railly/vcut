/**
 * Where a moment in the master came from in the source, and the other way round.
 *
 * The mapping is arithmetic over the EDL, which is exactly why this is a command
 * rather than a note in the manual: accumulating `outMs - inMs` by hand produces a
 * total that can match the rendered file to the millisecond while placing individual
 * positions several seconds away from where they really came from. A sum that agrees
 * with the container is not evidence that any single position is right.
 *
 * So `--explain` reports the neighbourhood a position sits in rather than only the
 * translated number, and `--render` measures the file instead of trusting the EDL's
 * intent. The EDL says what was asked for; only the render says what happened.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { run } from './exec.ts'
import { emitJson, heading, line, type Mode, resolveMode, UsageError } from './output.ts'
import type { Edl } from './render-edl.ts'

const HELP = `vcut locate - translate between master time and source time

Usage:
  vcut locate --edl <path> --master <seconds>
  vcut locate --edl <path> --source <seconds>
  vcut locate --edl <path> --all

Flags:
  --edl <path>       Edit decision list to read (required)
  --master <sec>     Position in the rendered master to translate
  --source <sec>     Position in the source to translate
  --sources <list>   Several source positions at once, comma separated
  --all              Emit the whole segment map instead of one position
  --render <path>    Check the map against a rendered file
  --explain          Report the neighbourhood, not only the number
  --json / --human   Output mode
  --help             Show this message

The map is derived from the EDL, which records intent. Pass --render to compare that
intent against a file that actually exists.

Also accepts --fields/--jq. See vcut --help for the full picture.`

export type Placement = {
  id: string
  sourceId: string
  sourceInMs: number
  sourceOutMs: number
  masterInMs: number
  masterOutMs: number
}

/**
 * The segment map, in master order. Segment durations are summed the same way the
 * renderer sums them, so a disagreement here is a disagreement with the render.
 */
export const placements = (edl: Edl): Placement[] => {
  let masterCursor = 0
  return edl.segments.map((segment) => {
    const span = segment.outMs - segment.inMs
    const placement: Placement = {
      id: segment.id,
      sourceId: segment.sourceId,
      sourceInMs: segment.inMs,
      sourceOutMs: segment.outMs,
      masterInMs: masterCursor,
      masterOutMs: masterCursor + span,
    }
    masterCursor += span
    return placement
  })
}

export const masterToSource = (
  map: Placement[],
  masterMs: number,
): { placement: Placement; sourceMs: number; offsetIntoSegmentMs: number } | null => {
  const placement = map.find(
    (entry) => masterMs >= entry.masterInMs && masterMs < entry.masterOutMs,
  )
  if (placement === undefined) {
    return null
  }
  const offsetIntoSegmentMs = masterMs - placement.masterInMs
  return { placement, sourceMs: placement.sourceInMs + offsetIntoSegmentMs, offsetIntoSegmentMs }
}

/**
 * A source position can be absent from the master, which is the normal outcome for
 * anything that was cut. That is reported as a miss with the neighbours that survived,
 * because "this was removed" is the useful answer, not an error.
 */
export const sourceToMaster = (
  map: Placement[],
  sourceMs: number,
): { placement: Placement; masterMs: number } | null => {
  const placement = map.find(
    (entry) => sourceMs >= entry.sourceInMs && sourceMs < entry.sourceOutMs,
  )
  if (placement === undefined) {
    return null
  }
  return { placement, masterMs: placement.masterInMs + (sourceMs - placement.sourceInMs) }
}

const neighbours = (
  map: Placement[],
  placement: Placement,
): { before: Placement | null; after: Placement | null } => {
  const index = map.findIndex((entry) => entry.id === placement.id)
  return { before: map[index - 1] ?? null, after: map[index + 1] ?? null }
}

/**
 * A gap in the source between two adjacent master segments is removed material. It is
 * worth naming because a boundary with a large cut behind it is where a tail survives,
 * and that is invisible when only the translated number is reported.
 */
const cutBeforeMs = (map: Placement[], placement: Placement): number | null => {
  const { before } = neighbours(map, placement)
  if (before === null || before.sourceId !== placement.sourceId) {
    return null
  }
  return placement.sourceInMs - before.sourceOutMs
}

const seconds = (ms: number): string => (ms / 1000).toFixed(3)

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const numericFlag = (argv: string[], name: string): number | undefined => {
  const raw = flagValue(argv, name)
  if (raw === undefined) {
    return undefined
  }
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new UsageError(`${name} expects a number in seconds, got ${raw}`)
  }
  return value
}

/**
 * Duration only, without -count_frames: this asks where a position came from, and
 * decoding every frame to answer that would make the cheap question expensive.
 *
 * Exported for `joins`, which needs the identical measurement to check the EDL's map against
 * the same render it re-transcribes, rather than a second ffprobe invocation for the same
 * question.
 */
export const probeDurationMs = async (path: string): Promise<number> => {
  const { stdout, stderr, exitCode } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    path,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ffprobe exited with ${exitCode}`)
  }
  const seconds = Number(stdout.trim())
  if (!Number.isFinite(seconds)) {
    throw new Error(`could not read a duration from ${path}`)
  }
  return seconds * 1000
}

const readEdl = (path: string): Edl => {
  if (!existsSync(path)) {
    throw new UsageError(`no EDL at ${path}`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Edl
}

/**
 * The EDL's own arithmetic against a file on disk. A mismatch does not say which
 * position is wrong, only that the map cannot be trusted as a whole, which is the
 * distinction the caller needs before acting on any single translation.
 */
export const checkAgainstRender = (
  map: Placement[],
  observedMs: number,
): { agrees: boolean; expectedMs: number; observedMs: number; deltaMs: number } => {
  const expectedMs = map.length === 0 ? 0 : (map[map.length - 1]?.masterOutMs ?? 0)
  const deltaMs = observedMs - expectedMs
  return { agrees: Math.abs(deltaMs) <= 50, expectedMs, observedMs, deltaMs }
}

export const locateCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help')) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const edlPath = flagValue(argv, '--edl')
  if (edlPath === undefined) {
    throw new UsageError(HELP)
  }
  const edl = readEdl(resolve(edlPath))
  const map = placements(edl)
  const explain = argv.includes('--explain')

  const renderPath = flagValue(argv, '--render')
  let check: ReturnType<typeof checkAgainstRender> | null = null
  if (renderPath !== undefined) {
    const resolved = resolve(renderPath)
    if (!existsSync(resolved)) {
      throw new UsageError(`no render at ${resolved}`)
    }
    check = checkAgainstRender(map, await probeDurationMs(resolved))
  }

  if (argv.includes('--all')) {
    if (mode === 'json') {
      emitJson({ segments: map, ...(check === null ? {} : { render: check }) })
      return
    }
    console.log(
      [
        heading('segment map'),
        ...map.map((entry) =>
          line(
            entry.id,
            `master ${seconds(entry.masterInMs)}-${seconds(entry.masterOutMs)}  <-  source ${seconds(entry.sourceInMs)}-${seconds(entry.sourceOutMs)}`,
          ),
        ),
      ].join('\n'),
    )
    return
  }

  const masterSeconds = numericFlag(argv, '--master')
  const sourceSeconds = numericFlag(argv, '--source')
  if (
    masterSeconds === undefined &&
    sourceSeconds === undefined &&
    flagValue(argv, '--sources') === undefined
  ) {
    throw new UsageError(HELP)
  }
  if (masterSeconds !== undefined && sourceSeconds !== undefined) {
    throw new UsageError('pass --master or --source, not both')
  }

  if (masterSeconds !== undefined) {
    const hit = masterToSource(map, masterSeconds * 1000)
    if (hit === null) {
      const total = map[map.length - 1]?.masterOutMs ?? 0
      throw new UsageError(
        `master ${masterSeconds}s is outside the master, which runs 0-${seconds(total)}s`,
      )
    }
    const cut = cutBeforeMs(map, hit.placement)
    const { before, after } = neighbours(map, hit.placement)
    if (mode === 'json') {
      emitJson({
        query: { masterMs: masterSeconds * 1000 },
        sourceMs: hit.sourceMs,
        segment: hit.placement,
        offsetIntoSegmentMs: hit.offsetIntoSegmentMs,
        ...(explain ? { cutBeforeSegmentMs: cut, neighbors: { before, after } } : {}),
        ...(check === null ? {} : { render: check }),
      })
      return
    }
    const lines = [
      heading('locate'),
      line(
        `master ${seconds(masterSeconds * 1000)}`,
        `-> source ${seconds(hit.sourceMs)}  (${hit.placement.id})`,
      ),
    ]
    if (explain) {
      lines.push(
        line(
          'segment',
          `source ${seconds(hit.placement.sourceInMs)}-${seconds(hit.placement.sourceOutMs)}, ${seconds(hit.offsetIntoSegmentMs)} in`,
        ),
      )
      if (before !== null) {
        lines.push(line('previous', `${before.id} ends master ${seconds(before.masterOutMs)}`))
      }
      if (after !== null) {
        lines.push(line('next', `${after.id} starts master ${seconds(after.masterInMs)}`))
      }
      if (cut !== null && cut > 0) {
        lines.push(line('cut before it', `${seconds(cut)} of source removed`))
      }
    }
    if (check !== null) {
      lines.push(
        line(
          'against render',
          check.agrees
            ? `map total ${seconds(check.expectedMs)} matches the file`
            : `map total ${seconds(check.expectedMs)} but the file runs ${seconds(check.observedMs)} (${seconds(check.deltaMs)} off)`,
        ),
      )
    }
    console.log(lines.join('\n'))
    return
  }

  // Several positions at once, because a round asks about every boundary it proposed and one
  // call each turns into a shell loop with a JSON parser inside it. A run wrote that loop twice.
  const list = flagValue(argv, '--sources')
  if (list !== undefined) {
    const positions = list
      .split(',')
      .map((entry: string) => Number(entry.trim()))
      .filter((entry: number) => Number.isFinite(entry))
    const sourceEnds = map.length === 0 ? 0 : Math.max(...map.map((entry) => entry.sourceOutMs))
    const answers = positions.map((seconds) => {
      const ms = seconds * 1000
      if (ms > sourceEnds) {
        return { sourceMs: ms, error: 'past the end of the source; this flag takes seconds' }
      }
      const found = sourceToMaster(map, ms)
      return found === null
        ? { sourceMs: ms, masterMs: null, removed: true }
        : { sourceMs: ms, masterMs: found.masterMs, removed: false, segment: found.placement.id }
    })
    if (mode === 'json') {
      emitJson({ positions: answers })
      return
    }
    console.log(
      [
        heading('locate'),
        ...answers.map((answer) =>
          line(
            `${(answer.sourceMs / 1000).toFixed(2)}s`,
            'error' in answer
              ? (answer.error as string)
              : answer.masterMs === null
                ? 'removed'
                : `master ${(answer.masterMs / 1000).toFixed(2)}s`,
          ),
        ),
      ].join('\n'),
    )
    return
  }

  const sourceMs = (sourceSeconds as number) * 1000
  // Every other command in this tool speaks milliseconds, so passing them here is the natural
  // mistake and the answer was indistinguishable from a real one: a run asked about nine
  // positions in milliseconds, got `removed: true` for all nine, and read that as nine spans
  // it had successfully cut. The source ends where it ends, and a position past it is a
  // question about nothing rather than a span that was removed.
  const sourceEndsMs = map.length === 0 ? 0 : Math.max(...map.map((entry) => entry.sourceOutMs))
  if (sourceMs > sourceEndsMs) {
    throw new UsageError(
      `--source ${sourceSeconds} is past the end of the source (${(sourceEndsMs / 1000).toFixed(2)}s). This flag takes seconds; ${sourceSeconds} looks like milliseconds`,
    )
  }
  const hit = sourceToMaster(map, sourceMs)
  if (hit === null) {
    const survivor = map.find((entry) => entry.sourceInMs >= sourceMs) ?? null
    if (mode === 'json') {
      emitJson({
        query: { sourceMs },
        masterMs: null,
        removed: true,
        nextSurvivingSegment: survivor,
        ...(check === null ? {} : { render: check }),
      })
      return
    }
    console.log(
      [
        heading('locate'),
        line(`source ${seconds(sourceMs)}`, 'not in the master: this span was cut'),
        ...(survivor === null
          ? []
          : [
              line(
                'next surviving',
                `${survivor.id} at source ${seconds(survivor.sourceInMs)} (master ${seconds(survivor.masterInMs)})`,
              ),
            ]),
      ].join('\n'),
    )
    return
  }
  if (mode === 'json') {
    emitJson({
      query: { sourceMs },
      masterMs: hit.masterMs,
      removed: false,
      segment: hit.placement,
      ...(check === null ? {} : { render: check }),
    })
    return
  }
  console.log(
    [
      heading('locate'),
      line(
        `source ${seconds(sourceMs)}`,
        `-> master ${seconds(hit.masterMs)}  (${hit.placement.id})`,
      ),
    ].join('\n'),
  )
}
