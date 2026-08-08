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

export const emitJson = (value: unknown): void => {
  console.log(JSON.stringify(value, null, 2))
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
