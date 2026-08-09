import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildEdlCommand } from './build-edl.ts'
import { detectCommand, positional } from './detect.ts'
import { run } from './exec.ts'
import {
  emitJson,
  fail,
  heading,
  line,
  type Mode,
  nextStep,
  resolveMode,
  UsageError,
} from './output.ts'
import { renderCommand } from './render-edl.ts'
import { semanticCommand } from './semantic.ts'

export const VERSION = '0.2.0'
export const SCHEMA_VERSION = 1

const HELP = `vcut - cut dead air out of a recording, reproducibly

Usage:
  vcut <input>                       Shorthand for: vcut detect <input>
  vcut detect <input> [flags]        Find silences and review candidates
  vcut edl build [flags]             Turn a detect report into a draft EDL
  vcut semantic export|check [flags] Hand the transcript to a model, take back proposals
  vcut render --edl <path> [flags]   Render an EDL to video
  vcut schema [name]                 Print the JSON contract for a command
  vcut skills list|get [name]        Read the bundled agent manual
  vcut doctor                        Check external dependencies
  vcut version                       Print the version

Global flags:
  --json     Force JSON output (the default when stdout is not a TTY)
  --human    Force the human summary
  --help     Show help for a command

Every command writes data to stdout and diagnostics to stderr. Exit code 2 means
the invocation was wrong, 1 means the run failed.`

const here = dirname(fileURLToPath(import.meta.url))

export const skillsDir = (): string => {
  const candidates = [
    process.env.VCUT_SKILLS_DIR,
    join(here, 'skills'),
    join(here, '..', 'skills'),
    join(here, '..', '..', 'skills'),
  ].filter((candidate): candidate is string => candidate !== undefined)

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error(
    'could not find skills/ near the executable. Set VCUT_SKILLS_DIR to its location.',
  )
}

const DEPENDENCIES = [
  { name: 'ffmpeg', why: 'silence detection and rendering' },
  { name: 'ffprobe', why: 'reading duration, streams, and frame counts' },
]

const doctorCommand = async (argv: string[]): Promise<void> => {
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const checks = await Promise.all(
    DEPENDENCIES.map(async (dependency) => {
      try {
        const { exitCode, stdout } = await run(dependency.name, ['-version'])
        return {
          name: dependency.name,
          why: dependency.why,
          ok: exitCode === 0,
          version: stdout.split('\n')[0] ?? '',
        }
      } catch {
        return { name: dependency.name, why: dependency.why, ok: false, version: '' }
      }
    }),
  )
  const missing = checks.filter((check) => !check.ok)

  if (mode === 'json') {
    emitJson({ ok: missing.length === 0, checks })
  } else {
    const lines = [heading('dependencies')]
    for (const check of checks) {
      lines.push(line(check.name, check.ok ? check.version : `MISSING - needed for ${check.why}`))
    }
    if (missing.length > 0) {
      lines.push(nextStep(`brew install ${missing.map((check) => check.name).join(' ')}`))
    }
    console.log(lines.join('\n'))
  }
  if (missing.length > 0) {
    process.exit(1)
  }
}

const CONTRACTS: Record<string, unknown> = {
  detect: {
    version: SCHEMA_VERSION,
    command: 'vcut detect',
    output: {
      version: 'number, always 1',
      input: 'absolute path to the source',
      durationMs: 'integer',
      preset: 'noisy | clean | podcast',
      thresholdDb: 'number, the dB floor for the preset',
      minSilenceMs: 'integer',
      marginMs: 'integer, padding kept around speech',
      lang: 'free-form language tag, passed through to the semantic export',
      transcript: '{ path: string|null, wordLevel: boolean, words: integer }',
      silences: '[{ kind: "silence", startMs, endMs, durationMs }]',
      review: '[{ kind: "clipping"|"black"|"frozen", startMs, endMs, detail }]',
      warnings: 'string[], non-fatal conditions worth reading',
    },
    notes: [
      'Silence only. Filler words are not detected here: a word list cannot tell a filler from ordinary use, and it never survives a new language. Run vcut semantic for those.',
      'review entries are candidates for a human to inspect. They are never cut automatically.',
    ],
  },
  edl: {
    version: SCHEMA_VERSION,
    command: 'vcut edl build',
    output: {
      status: 'always "drafted"',
      edlPath: 'absolute path to the EDL that was written',
      segments: 'integer, how many spans survive',
      cuts: 'integer, how many cuts were applied',
      sourceDurationMs: 'integer',
      keptDurationMs: 'integer',
      removalPercent: 'number, 0-100',
      wordBoundaryClamping: 'boolean, whether cuts were clamped to word edges',
      warnings: 'string[]',
    },
    notes: [
      'The EDL itself validates against schemas/edl.schema.json.',
      'Every segment is written as proposed and the EDL as draft. Nothing is approved here.',
    ],
  },
  semantic: {
    version: SCHEMA_VERSION,
    command: 'vcut semantic export | vcut semantic check',
    output: {
      export:
        '{ status: "exported", input, durationMs, lang, instructions: string[], lines: [{ index, startMs, endMs, text }] }',
      check: '{ status: "valid"|"rejected", accepted: integer, issues: [{ index, problem }] }',
    },
    notes: [
      'vcut never calls a model. Export hands over the lines; you write the proposals back.',
      'A proposal is { startMs, endMs, kind, reason }, kind being false-start | repetition | tangent | filler | non-speech.',
      'non-speech covers audible sound that is not language, which neither detect nor the transcript can see. skills/non-speech.py finds those with an audio classifier and prints them in this schema.',
      'Feed accepted proposals to vcut edl build --semantic <path>. Each lands as semanticRisk material.',
      'check exits 1 when anything is malformed, and edl build refuses the whole file rather than skipping entries.',
    ],
  },
  render: {
    version: SCHEMA_VERSION,
    command: 'vcut render',
    output: {
      status: '"ready" for --dry-run, "rendered" otherwise',
      outputPath: 'absolute path to the rendered file',
      sha256: 'hex digest of the output, stable across identical runs',
      duration: 'seconds, as reported by ffprobe',
      frames: 'decoded frame count',
    },
    notes: [
      'Preview mode accepts proposed segments; master mode requires approval.',
      'Audio is normalised to the EDL speechTargetLufs, on the concatenated result rather than per segment.',
      'The renderer validates its own output against the EDL and fails on a mismatch.',
    ],
  },
}

const schemaCommand = (argv: string[]): void => {
  const name = positional(argv)
  if (name === undefined) {
    emitJson({ version: SCHEMA_VERSION, commands: Object.keys(CONTRACTS) })
    return
  }
  const contract = CONTRACTS[name]
  if (contract === undefined) {
    throw new UsageError(`unknown schema: ${name}. Try one of ${Object.keys(CONTRACTS).join(', ')}`)
  }
  emitJson(contract)
}

const skillsCommand = (argv: string[]): void => {
  const [verb, ...rest] = argv
  const directory = skillsDir()
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))

  if (verb === undefined || verb === 'list') {
    const names = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    if (mode === 'json') {
      emitJson({ skills: names })
      return
    }
    console.log(
      [
        heading('bundled skills'),
        ...names.map((name) => line(name, `vcut skills get ${name}`)),
      ].join('\n'),
    )
    return
  }

  if (verb === 'path') {
    const name = positional(rest)
    const target = name === undefined ? directory : join(directory, name)
    if (mode === 'json') {
      emitJson({ path: target })
      return
    }
    console.log(target)
    return
  }

  if (verb === 'get') {
    // `core` is the usage guide. `vcut` is the discovery stub that points here,
    // so a bare `skills get` should serve the content, not the pointer.
    const name = positional(rest) ?? 'core'
    const file = join(directory, name, 'SKILL.md')
    if (!existsSync(file)) {
      throw new UsageError(`no skill named ${name}. Run vcut skills list.`)
    }
    process.stdout.write(readFileSync(file, 'utf8'))
    return
  }

  throw new UsageError('Usage: vcut skills list | get <name> | path [name]')
}

const isPath = (value: string | undefined): boolean =>
  value !== undefined && !value.startsWith('-') && (value.includes('/') || value.includes('.'))

export const route = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv

  if (command === undefined || command === '--help' || command === 'help') {
    console.log(HELP)
    return
  }
  if (command === 'version' || command === '--version') {
    console.log(VERSION)
    return
  }
  if (command === 'detect') {
    return detectCommand(rest)
  }
  if (command === 'edl') {
    const [verb, ...edlRest] = rest
    if (verb !== 'build') {
      throw new UsageError('Usage: vcut edl build --detect <path> --output <path> --campaign <id>')
    }
    return buildEdlCommand(edlRest)
  }
  if (command === 'semantic') {
    return semanticCommand(rest)
  }
  if (command === 'render') {
    return renderCommand(rest)
  }
  if (command === 'schema') {
    return schemaCommand(rest)
  }
  if (command === 'skills') {
    return skillsCommand(rest)
  }
  if (command === 'doctor') {
    return doctorCommand(rest)
  }
  if (isPath(command)) {
    return detectCommand([resolve(command), ...rest])
  }
  throw new UsageError(`unknown command: ${command}\n\n${HELP}`)
}

route(process.argv.slice(2)).catch(fail)
