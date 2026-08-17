import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runJq } from './jq.ts'

export type Mode = 'json' | 'human'

const hasFields = (args: string[]): boolean =>
  args.some((arg) => arg === '--fields' || arg.startsWith('--fields='))

const hasJq = (args: string[]): boolean =>
  args.some((arg) => arg === '--jq' || arg.startsWith('--jq='))

// --fields and --jq both ask for machine output by construction: a caller naming dot paths to
// extract, or a filter to run, wants that projection, not a human summary those paths and
// filters do not exist in. The manual says both imply --json, so --human alongside either is a
// contradiction, not a preference to arbitrate silently — the caller asked for a summary and a
// machine projection of the same run in one breath. Checked before --json/--human resolve so
// the conflict is caught however the two are ordered on the command line, and shared between
// resolveMode and emitJson (its own callers reach it without ever calling resolveMode) so the
// rule lives once rather than once per seam.
export const checkModeConflicts = (args: string[]): void => {
  if (args.includes('--human') && (hasFields(args) || hasJq(args))) {
    const culprit = hasJq(args) ? '--jq' : '--fields'
    throw new UsageError(`--human and ${culprit} are mutually exclusive; ${culprit} implies --json`)
  }
}

// A handful of commands (schema, setup classifier, semantic's subcommands) never call
// resolveMode: they have no human summary to switch to, by design — schema prints a machine
// contract, setup classifier reports a download, semantic hands proposals to a model. --human
// on any of them used to be accepted and silently ignored rather than switching anything, which
// is the same silent-acceptance bug resolveMode's own --human/--jq guard exists to close.
// commandLabel names the caller in the error so a rejection reads as "this command" rather
// than a generic flag complaint.
export const requireJson = (args: string[], commandLabel: string): void => {
  if (args.includes('--human')) {
    throw new UsageError(`${commandLabel} has no human summary; drop --human`)
  }
}

// `vcut skills get <name>` streams a document's raw bytes to stdout (an agent asking for the
// manual wants the manual, not a JSON envelope around it) — none of the four global output
// flags apply, and all four used to be silently ignored rather than rejected. Named per flag
// rather than one combined message, since a caller who typed --jq almost certainly wants to
// know --jq specifically does not apply here, not that some unspecified flag does not.
export const requireRawOutput = (args: string[], commandLabel: string): void => {
  if (args.includes('--json')) {
    throw new UsageError(`${commandLabel} prints raw text, not JSON; drop --json`)
  }
  if (args.includes('--human')) {
    throw new UsageError(`${commandLabel} prints raw text; there is no separate --human view`)
  }
  if (hasFields(args)) {
    throw new UsageError(`${commandLabel} prints raw text, not JSON; --fields does not apply`)
  }
  if (hasJq(args)) {
    throw new UsageError(`${commandLabel} prints raw text, not JSON; --jq does not apply`)
  }
}

// The mirror case: `vcut init` (and `setup all`) is a scripted installer, side effects
// reported as they happen, never a value to project or reshape. --human asks for the only
// mode this command has, so it is left alone rather than rejected for redundancy; --json,
// --fields, and --jq ask this command to become something it structurally is not, and used to
// be silently accepted and ignored rather than refused.
export const requireHumanOnly = (args: string[], commandLabel: string): void => {
  if (args.includes('--json')) {
    throw new UsageError(`${commandLabel} has no JSON output; drop --json`)
  }
  if (hasFields(args)) {
    throw new UsageError(`${commandLabel} has no JSON output; --fields does not apply`)
  }
  if (hasJq(args)) {
    throw new UsageError(`${commandLabel} has no JSON output; --jq does not apply`)
  }
}

// --fields asks for machine output by construction: a caller naming dot paths to extract wants
// the extraction, not a human summary those paths do not exist in. --jq asks the same thing
// for a filter or a merge, which is why it forces JSON the same way.
export const resolveMode = (args: string[], isTty: boolean): Mode => {
  checkModeConflicts(args)
  if (args.includes('--json')) {
    return 'json'
  }
  if (args.includes('--human')) {
    return 'human'
  }
  if (hasFields(args)) {
    return 'json'
  }
  if (hasJq(args)) {
    return 'json'
  }
  return isTty ? 'human' : 'json'
}

// --fields <a.b,c,d> alongside --fields=<a.b,c,d>, matching how every other flag in this CLI
// is read. Comma-separated, each a dot path; whitespace around a path is trimmed so
// "--fields a, b" does not silently ask for " b".
export const parseFields = (args: string[]): string[] | null => {
  const index = args.indexOf('--fields')
  if (index !== -1) {
    const raw = args[index + 1]
    return raw === undefined
      ? []
      : raw
          .split(',')
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
  }
  const inline = args.find((arg) => arg.startsWith('--fields='))
  if (inline === undefined) {
    return null
  }
  return inline
    .slice('--fields='.length)
    .split(',')
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
}

// Every global flag a command inherits without declaring it: the four output flags plus the
// two a command answers before parsing anything of its own.
const GLOBAL_FLAGS = ['--json', '--human', '--fields', '--jq', '--help', '--version']

// A flag a command does not read is a question it did not answer. `silences --threshold -80`
// ran, exited 0, and reported `thresholdDb: -30` back — the default, formatted exactly like a
// measurement, with the real flag named --noise. Nothing downstream could tell the difference
// between a threshold that was honoured and one that was never seen (#67).
//
// This is the same silent-acceptance bug requireJson and requireRawOutput each close for one
// flag, widened to the flags a command declares itself. Values are skipped rather than
// validated: a command's own parser owns what its flags mean, and this only asks whether the
// flag exists at all. A bare `-` or a negative number reads as a value, never as a flag, so
// `--noise -30` does not report -30 as unknown.
export const rejectUnknownFlags = (args: string[], known: string[], commandLabel: string): void => {
  const allowed = new Set([...known, ...GLOBAL_FLAGS])
  const unknown = args.filter(
    (arg) => arg.startsWith('--') && !allowed.has(arg.split('=')[0] as string),
  )
  if (unknown.length > 0) {
    const named = unknown.join(', ')
    throw new UsageError(
      `${commandLabel} does not take ${named}; see \`vcut ${commandLabel} --help\``,
    )
  }
}

// --jq <expr> alongside --jq=<expr>, the same two forms --fields reads. Only the last flag
// wins when repeated, matching how `value()` helpers across every command read a flag today.
export const parseJqExpr = (args: string[]): string | null => {
  const index = args.indexOf('--jq')
  if (index !== -1) {
    const raw = args[index + 1]
    if (raw === undefined) {
      throw new UsageError(
        '--jq needs an expression, e.g. --jq ".[] | select(.kind == \\"filler\\")"',
      )
    }
    return raw
  }
  const inline = args.find((arg) => arg.startsWith('--jq='))
  if (inline === undefined) {
    return null
  }
  return inline.slice('--jq='.length)
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

// Walks a dot path from a value. An array segment projects the rest of the path over every
// element rather than indexing into the array itself, since that is the shape a caller wants
// when a path crosses a list field ("semanticCuts.removedText" over an array of cuts): the
// array of that field, not one element's field. Returns { found: false } rather than undefined
// so a path that legitimately resolves to undefined is not confused with one that never
// existed — the caller decides what "unknown path" means from that.
const walkPath = (value: unknown, segments: string[]): { found: boolean; value: unknown } => {
  if (segments.length === 0) {
    return { found: true, value }
  }
  if (Array.isArray(value)) {
    const results = value.map((item) => walkPath(item, segments))
    if (results.some((result) => !result.found)) {
      return { found: false, value: undefined }
    }
    return { found: true, value: results.map((result) => result.value) }
  }
  if (value === null || typeof value !== 'object') {
    return { found: false, value: undefined }
  }
  const [head, ...rest] = segments
  const record = value as Record<string, unknown>
  if (!(head in record)) {
    return { found: false, value: undefined }
  }
  return walkPath(record[head], rest)
}

// The result of --fields: only the requested paths, keyed by the path string itself so a
// caller reads back exactly what it asked for rather than a reconstructed nested shape it has
// to re-derive. An unknown path becomes a fieldErrors entry naming it rather than failing the
// whole call — an agent asking for a field that moved should learn that, not lose the call.
export const projectFields = (
  value: unknown,
  paths: string[],
): { projected: Record<string, unknown>; fieldErrors: string[] } => {
  const projected: Record<string, unknown> = {}
  const fieldErrors: string[] = []
  for (const path of paths) {
    const segments = path.split('.').filter((segment) => segment.length > 0)
    if (segments.length === 0) {
      continue
    }
    const result = walkPath(value, segments)
    if (result.found) {
      projected[path] = result.value
    } else {
      fieldErrors.push(path)
    }
  }
  return { projected, fieldErrors }
}

// Every JSON output carries the version of the binary that produced it. The manual is read
// once and cached in an agent's context while the CLI can change underneath it: one session
// upgraded mid-run, kept hand-rolling an 18-call window loop for a question `converge`
// (shipped an hour earlier) already answered in one call, because nothing in the output said
// the tool had moved. This is the one place that stamp is added, so no command can forget it.
//
// `--fields` reads the same way: rather than every one of the 30-odd call sites across every
// command parsing its own argv for the flag, emitJson reads process.argv directly, the same
// precedent packageVersion already set by reading package.json unprompted. `fields` stays as an
// explicit second argument only so a test (or a future caller with its own argv) can drive the
// projection without shelling out. When given, the object is projected down to those dot paths
// before the stamp is added, so vcutVersion always rides along regardless of what was
// selected — it is the version stamp, not a field a caller could ask away.
export const emitJson = (value: unknown, fields?: string[]): void => {
  const argv = process.argv.slice(2)
  // A command that calls emitJson without ever calling resolveMode (schema, setup classifier,
  // semantic's subcommands — all JSON-only by design) still reaches process.argv here, so the
  // --human/--jq and --human/--fields conflict is caught the same way resolveMode catches it
  // for every command that does call resolveMode, rather than only for the callers that do.
  checkModeConflicts(argv)
  const jqExpr = parseJqExpr(argv)
  const requested = fields ?? parseFields(argv) ?? []
  if (jqExpr !== null && requested.length > 0) {
    throw new UsageError('--jq and --fields are mutually exclusive; pass one or the other')
  }
  // --jq runs against the value as vcutVersion-stamped output would already read (a caller
  // piping `vcut detect | jq` today sees the stamp, so `--jq` sees it too, and `.vcutVersion`
  // is a legal path in a filter). Past that, the filter's own result is printed as-is: jq
  // itself does not append metadata to a filter's output, and doing so here would corrupt a
  // result that is not shaped like this CLI's usual objects (an array, a number, a string).
  if (jqExpr !== null) {
    const stampable =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>), vcutVersion: VCUT_VERSION }
        : value
    console.log(JSON.stringify(runJq(jqExpr, stampable), null, 2))
    return
  }
  if (requested.length > 0 && value !== null && typeof value === 'object') {
    const { projected, fieldErrors } = projectFields(value, requested)
    const withErrors = fieldErrors.length > 0 ? { ...projected, fieldErrors } : projected
    console.log(JSON.stringify({ ...withErrors, vcutVersion: VCUT_VERSION }, null, 2))
    return
  }
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
