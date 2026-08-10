import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Mode = 'json' | 'human'

export const resolveMode = (args: string[], isTty: boolean): Mode => {
  if (args.includes('--json')) {
    return 'json'
  }
  if (args.includes('--human')) {
    return 'human'
  }
  return isTty ? 'human' : 'json'
}

export const EXIT_USAGE = 2
export const EXIT_FAILURE = 1

export class UsageError extends Error {}

// Read rather than restated, because a hand-maintained copy drifts silently: 0.4.1 shipped to
// npm with a hardcoded VERSION constant still reading 0.4.0, so the published binary reported
// a version it was not. The release only bumps package.json, which makes that the one place
// worth trusting. Lives here rather than in cli.ts so emitJson can stamp it without cli.ts and
// output.ts importing each other.
export const packageVersion = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: string }
      if (typeof parsed.version === 'string') {
        return parsed.version
      }
    }
    const parent = dirname(dir)
    if (parent === dir) {
      break
    }
    dir = parent
  }
  return 'unknown'
}

const VCUT_VERSION = packageVersion()

// Every JSON output carries the version of the binary that produced it. The manual is read
// once and cached in an agent's context while the CLI can change underneath it: one session
// upgraded mid-run, kept hand-rolling an 18-call window loop for a question `converge`
// (shipped an hour earlier) already answered in one call, because nothing in the output said
// the tool had moved. This is the one place that stamp is added, so no command can forget it.
export const emitJson = (value: unknown): void => {
  const stamped =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? { ...(value as Record<string, unknown>), vcutVersion: VCUT_VERSION }
      : value
  console.log(JSON.stringify(stamped, null, 2))
}

const HUMAN_WIDTH = 24

export const bar = (fraction: number, width = 20): string => {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
}

export const duration = (milliseconds: number): string => {
  const total = Math.round(milliseconds / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

export const line = (label: string, value: string): string =>
  `  ${label.padEnd(HUMAN_WIDTH)}${value}`

export const heading = (text: string): string => `\n${text}`

export const nextStep = (command: string): string => `\n  Next:\n    ${command}`

export const fail = (error: unknown): never => {
  const usage = error instanceof UsageError
  const message = error instanceof Error ? error.message : String(error)
  console.error(usage ? message : `error: ${message}`)
  process.exit(usage ? EXIT_USAGE : EXIT_FAILURE)
}
