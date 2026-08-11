import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { auditCommand } from './audit-command.ts'
import { buildEdlCommand } from './build-edl.ts'
import { commitCommand } from './commit.ts'
import { convergeCommand } from './converge.ts'
import { cutCommand } from './cut.ts'
import { detectCommand, positional } from './detect.ts'
import { run, runInherit } from './exec.ts'
import { joinsCommand } from './joins.ts'
import { JQ_HELP } from './jq.ts'
import { locateCommand } from './locate.ts'
import { nonspeechCommand } from './nonspeech.ts'
import { openCommand } from './open.ts'
import {
  emitJson,
  fail,
  heading,
  line,
  type Mode,
  nextStep,
  packageVersion,
  resolveMode,
  UsageError,
} from './output.ts'
import { peekCommand } from './peek.ts'
import { renderCommand } from './render-edl.ts'
import { roundsCommand } from './rounds-command.ts'
import { sayCommand } from './say.ts'
import { semanticCommand } from './semantic.ts'
import { listSessions } from './session.ts'
import { sessionCommand } from './session-command.ts'
import { silencesCommand } from './silences.ts'
import { skillsDir } from './skills-dir.ts'
import { suspectsCommand } from './suspects.ts'

export { skillsDir } from './skills-dir.ts'

export const VERSION = packageVersion()
export const SCHEMA_VERSION = 1

const HELP = `vcut - cut dead air out of a recording, reproducibly

Usage:
  vcut <input>                       Shorthand for: vcut detect <input>
  vcut detect <input> [flags]        Find silences and review candidates
  vcut suspects --detect <path>      Where to look first, ranked, without reading the file
  vcut edl build [flags]             Turn a detect report into a draft EDL
  vcut semantic export|check|review|merge  Hand the transcript to a model, take proposals back
  vcut render --edl <path> [flags]   Render an EDL to video
  vcut locate --edl <path> [flags]   Translate between master time and source time
  vcut audit --edl <path> --render <path>  Check a render against the EDL it came from
  vcut joins --edl <path> --render <path>  Verify every semantic join in one call
  vcut say <media> [flags]           Read back what is spoken at a position
  vcut silences <media> [flags]      Speech/silence blocks over a range, at a chosen resolution
  vcut converge <media> [flags]      Find where a repeated phrase stops coming back
  vcut nonspeech <render> [--verify] Find audible sound that is not language
  vcut open <media> [flags]          Open or resume a session, map its blocks with stable refs
  vcut peek <media> (--ref|--at)     The four views of a position, aligned, disagreement named
  vcut cut <media> --refs|--start-ms|--span  Propose a semantic cut against a session, see what it removes
  vcut commit <media> [flags]        Build + render a session's proposals into a draft EDL
  vcut rounds <media> [--diff N M]   A session's committed rounds, diffed between two
  vcut session list|gc [flags]       See what a session store holds, and clear it explicitly
  vcut schema [name]                 Print the JSON contract for a command
  vcut skills list|get|path [name]   Read the bundled agent manual, or one section of it
  vcut doctor                        Check external dependencies
  vcut init [--no-skills]            Install everything a first run needs
  vcut setup classifier              Fetch the optional non-speech classifier
  vcut version                       Print the version

Global flags:
  --json             Force JSON output (the default when stdout is not a TTY)
  --human            Force the human summary
  --fields <paths>   Project JSON output to these dot paths, comma separated. Implies --json.
  --jq <expr>        Filter or reshape JSON output with a jq expression (see below). Implies
                     --json. Mutually exclusive with --fields.
  --help             Show help for a command

${JQ_HELP}

Every command writes data to stdout and diagnostics to stderr. Exit code 2 means
the invocation was wrong, 1 means the run failed.`

const DEPENDENCIES = [
  { name: 'ffmpeg', why: 'silence detection and rendering' },
  { name: 'ffprobe', why: 'reading duration, streams, and frame counts' },
]

// Everything the non-speech classifier needs, which is nothing the CLI itself uses. It stays
// optional because a 300MB checkpoint is a steep toll on a tool that otherwise runs anywhere
// ffmpeg does, and because the check it performs has a fallback: a human ear.
const CLASSIFIER_HOME = join(homedir(), '.vcut', 'panns')
const CLASSIFIER_FILES = [
  {
    name: 'class_labels_indices.csv',
    url: 'http://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv',
  },
  {
    name: 'Cnn14_mAP=0.431.pth',
    url: 'https://zenodo.org/record/3987831/files/Cnn14_mAP%3D0.431.pth?download=1',
  },
]

export const classifierStatus = (present: boolean[]): { ok: boolean; detail: string } => {
  const missing = present.filter((exists) => !exists).length
  if (missing === 0) {
    return { ok: true, detail: CLASSIFIER_HOME }
  }
  return {
    ok: false,
    detail: `not installed, optional. Run vcut setup classifier. Without it, invariant 7 needs a human ear.`,
  }
}

// The detector kai-doctor.sh's own audit named as missing before it existed: a cache directory
// that grows without anything watching its size or its orphans (~/.kai/logs reaching 609MB
// unnoticed is the precedent). Absent sessions dir reports zero across the board rather than
// an error — a machine that has never run vcut open has nothing wrong with it.
export type SessionsHealth = {
  count: number
  totalMb: number
  orphanCount: number
  oldestCreatedAt: string | null
}

export const sessionsHealth = (): SessionsHealth => {
  const sessions = listSessions()
  if (sessions.length === 0) {
    return { count: 0, totalMb: 0, orphanCount: 0, oldestCreatedAt: null }
  }
  const totalBytes = sessions.reduce((total, session) => total + session.sizeBytes, 0)
  const orphanCount = sessions.filter((session) => !session.sourceExists).length
  const oldest = sessions.reduce((earliest, session) =>
    session.createdAt < earliest.createdAt ? session : earliest,
  )
  return {
    count: sessions.length,
    totalMb: Number((totalBytes / (1024 * 1024)).toFixed(2)),
    orphanCount,
    oldestCreatedAt: oldest.createdAt,
  }
}

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
  const classifier = classifierStatus(
    CLASSIFIER_FILES.map((file) => existsSync(join(CLASSIFIER_HOME, file.name))),
  )
  const sessions = sessionsHealth()

  if (mode === 'json') {
    emitJson({ ok: missing.length === 0, checks, classifier, sessions })
  } else {
    const lines = [heading('dependencies')]
    for (const check of checks) {
      lines.push(line(check.name, check.ok ? check.version : `MISSING - needed for ${check.why}`))
    }
    lines.push(line('non-speech classifier', classifier.ok ? classifier.detail : classifier.detail))
    lines.push(
      line(
        'sessions',
        sessions.count === 0
          ? 'none'
          : `${sessions.count}, ${sessions.totalMb}MB, ${sessions.orphanCount} orphan(s), oldest ${sessions.oldestCreatedAt}`,
      ),
    )
    if (sessions.orphanCount > 0) {
      lines.push(nextStep('vcut session gc  # dry-run first, --apply to clear orphans'))
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

const SETUP_HELP = `vcut setup - fetch the optional non-speech classifier

Usage:
  vcut init [--no-skills]           Install everything a first run needs
  vcut setup classifier [--force]   Fetch the non-speech classifier

Downloads the AudioSet model that skills/core/scripts/non-speech.py uses to find breaths, mic bumps and
other audible sound that is not language. Around 320MB, kept under ~/.vcut/panns.

Nothing else in vcut needs it: detect, edl build and render all run without it. Skipping this
leaves invariant 7 to a human ear, which is a real answer, not a broken state.

The script also needs Python with panns-inference:
  pip install panns-inference scipy numpy`

// Everything a first run needs, done rather than listed.
//
// An earlier version printed the commands and left them to the reader, which reads as prudence
// and is really the work unfinished: the step people skip is the transcription model, and
// skipping it does not fail, it produces a worse cut. A setup that hands you four commands has
// four chances to be half-followed.
//
// So it runs what it can and reports what it cannot. Installing a package manager is not this
// tool's business, and neither is deciding to write into a project directory without being
// asked, so those two stay as instructions with everything else already done around them.
const step = async (
  label: string,
  command: string,
  args: string[],
): Promise<{ ok: boolean; detail: string }> => {
  // Announced before it runs and settled on its own line after, rather than overwritten in
  // place: these steps shell out to installers that write to the terminal themselves, and a
  // carriage return cannot take back a line something else has already scrolled past.
  console.log(line(label, 'installing...'))
  try {
    const { exitCode, stderr } = await run(command, args)
    const ok = exitCode === 0
    console.log(line(label, ok ? 'done' : 'failed'))
    return { ok, detail: ok ? 'done' : (stderr.trim().split('\n')[0] ?? 'failed') }
  } catch (error) {
    console.log(line(label, 'failed'))
    return { ok: false, detail: error instanceof Error ? error.message : 'failed' }
  }
}

const has = async (command: string, args: string[]): Promise<boolean> => {
  try {
    const { exitCode } = await run(command, args)
    return exitCode === 0
  } catch {
    return false
  }
}

const INIT_HELP = `vcut init - install everything a first run needs

Usage:
  vcut init [--no-skills]

Installs ffmpeg through brew when it is missing, the transcriber through npm, the
transcription model through trx init, and the agent skills through npx skills add
(into the current directory; --no-skills leaves it alone). Reports anything it could
not do and exits non-zero. The optional non-speech classifier stays separate:
vcut setup classifier.`

const setupAll = async (argv: string[]): Promise<void> => {
  // A --help that runs the installer is worse than no help at all: asking what a command
  // does must never do the thing. Found by an agent whose exploration of this flag wrote
  // .agents/ and skills-lock.json into a worktree it was documenting.
  if (argv.includes('--help')) {
    process.stdout.write(`${INIT_HELP}\n`)
    return
  }
  const skipSkills = argv.includes('--no-skills')
  const modelPath = join(homedir(), '.trx', 'models', 'ggml-large-v3-turbo.bin')
  const blocked: string[] = []

  console.log(heading('setup'))

  for (const dependency of DEPENDENCIES) {
    if (await has(dependency.name, ['-version'])) {
      console.log(line(dependency.name, 'found'))
      continue
    }
    // Homebrew is the one dependency this cannot bootstrap, and guessing a package manager on
    // an unknown machine is how a setup command breaks the machine it was meant to prepare.
    if (await has('brew', ['--version'])) {
      const result = await step(dependency.name, 'brew', ['install', dependency.name])
      if (!result.ok) {
        blocked.push(`brew install ${dependency.name}`)
      }
    } else {
      console.log(line(dependency.name, 'missing, and no brew to install it with'))
      blocked.push(`install ${dependency.name} however your system does it`)
    }
  }

  if (await has('trx', ['--version'])) {
    console.log(line('trx', 'found'))
  } else if (await has('npm', ['--version'])) {
    const result = await step('trx', 'npm', ['install', '-g', '@crafter/trx'])
    if (!result.ok) {
      blocked.push('npm install -g @crafter/trx')
    }
  } else {
    blocked.push('npm install -g @crafter/trx')
  }

  if (existsSync(modelPath)) {
    console.log(line('transcription model', 'large-v3-turbo'))
  } else if (await has('trx', ['--version'])) {
    // The small default splits words mid-token, which reads as a transcript and cuts like
    // noise, so the model is named rather than left to a default nobody chose.
    const result = await step('transcription model', 'trx', ['init', '--model', 'large-v3-turbo'])
    if (!result.ok) {
      blocked.push('trx init --model large-v3-turbo')
    }
  } else {
    blocked.push('trx init --model large-v3-turbo')
  }

  if (skipSkills) {
    console.log(line('skills', 'skipped'))
  } else if (await has('npx', ['--version'])) {
    // Writes into the current directory, which is why --no-skills exists: a machine-wide setup
    // run from a home directory should not scatter a project's files there.
    const result = await step('skills', 'npx', ['-y', 'skills', 'add', 'Railly/vcut'])
    if (!result.ok) {
      blocked.push('npx skills add Railly/vcut')
    }
  } else {
    blocked.push('npx skills add Railly/vcut')
  }

  const classifier = CLASSIFIER_FILES.every((file) => existsSync(join(CLASSIFIER_HOME, file.name)))
  console.log(line('classifier', classifier ? 'installed' : 'not installed, optional (320MB)'))

  console.log(
    blocked.length === 0
      ? '\n  Ready. Point an agent at a recording: /vcut <file>'
      : ['\n  Left to run:', ...blocked.map((item) => `    ${item}`)].join('\n'),
  )
  if (blocked.length > 0) {
    process.exitCode = 1
  }
}

const setupCommand = async (argv: string[]): Promise<void> => {
  const target = positional(argv)
  if (target === 'all' || target === undefined) {
    return setupAll(argv)
  }
  if (target !== 'classifier') {
    throw new UsageError(SETUP_HELP)
  }
  const force = argv.includes('--force')
  mkdirSync(CLASSIFIER_HOME, { recursive: true })

  const results = []
  for (const file of CLASSIFIER_FILES) {
    const path = join(CLASSIFIER_HOME, file.name)
    if (existsSync(path) && !force) {
      results.push({ file: file.name, status: 'present' as const, path })
      continue
    }
    // curl rather than fetch: this is hundreds of megabytes and a resumable, progress-showing
    // download is worth more here than one fewer process.
    const exitCode = await runInherit('curl', ['-fL', '--progress-bar', '-o', path, file.url])
    if (exitCode !== 0) {
      throw new Error(`failed to download ${file.name}`)
    }
    results.push({ file: file.name, status: 'downloaded' as const, path })
  }
  emitJson({ status: 'ready', home: CLASSIFIER_HOME, files: results })
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
      audioPath: 'absolute path to a separate audio recording, or null',
      silences: '[{ kind: "silence", startMs, endMs, durationMs }]',
      review: '[{ kind: "clipping"|"black"|"frozen", startMs, endMs, detail }]',
      warnings:
        'string[], non-fatal conditions worth reading, including a fragment warning when the transcript was split on tokens rather than words',
    },
    notes: [
      'With --audio, silences and clipping are measured on that file rather than on the video, since that is the audio the render will carry.',
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
      semanticCuts:
        '[{ startMs, endMs, kind, reason, removedText, boundariesInSilence: [bool, bool], driftSuspect?: true }], one per accepted semantic proposal, span already merged with whatever else lands in the same place',
      warnings: 'string[]',
    },
    notes: [
      'The EDL itself validates against schemas/edl.schema.json.',
      'Every segment is written as proposed and the EDL as draft. Nothing is approved here.',
      'Read semanticCuts[].removedText before rendering: it is the transcript text the span actually removes, not the raw proposal. A warning fires when removedText and reason share fewer than half their carrying words and removedText has 4 or more of them, which is the corrective for a span drifting onto the wrong words unnoticed.',
      '--report-json <path> writes this whole summary to that path regardless of stdout mode, so --human on stdout and the JSON report vcut joins --report reads come from one build rather than two. Same shape vcut commit writes as rounds/round-N/report.json.',
      'driftSuspect is present and true only when removedText is built from cues the same drift check detect runs would flag: a word claiming to start inside measured silence. Absent (not false) when the span is clean. Do not trust removedText on a driftSuspect span without a check (peek or say --transcribe over it); the field is never re-transcribed automatically.',
    ],
  },
  semantic: {
    version: SCHEMA_VERSION,
    command: 'vcut semantic export | vcut semantic check | vcut semantic merge',
    output: {
      export:
        '{ status: "exported", input, durationMs, lang, instructions: string[], lines: [{ index, startMs, endMs, text, nearestRef }] }',
      check: '{ status: "valid"|"rejected", accepted: integer, issues: [{ index, problem }] }',
      merge:
        '{ status: "merged"|"rejected", files: string[], inputCount: integer, duplicates: integer, proposals: Proposal[] }',
    },
    notes: [
      'vcut never calls a model. Export hands over the lines; you write the proposals back.',
      'A proposal is { startMs, endMs, kind, reason }, kind being false-start | repetition | tangent | filler | non-speech.',
      'non-speech covers audible sound that is not language, which neither detect nor the transcript can see. skills/core/scripts/non-speech.py finds those with an audio classifier and prints them in this schema.',
      "Each exported line carries nearestRef, the session's block ref closest to that line's own startMs, derived the same way vcut open attaches nearestRef to suspects. A proposal can carry that ref straight into vcut cut --refs instead of retyping the line's raw milliseconds.",
      'Feed accepted proposals to vcut edl build --semantic <path>. Each lands as semanticRisk material.',
      'check exits 1 when anything is malformed, and edl build refuses the whole file rather than skipping entries.',
      'merge folds two or more proposal files into one, dropping spans identical on all four fields and re-sorting by startMs. --out <path> writes the merged array there (the same shape as an input file) instead of printing the summary object to stdout.',
    ],
  },
  silences: {
    version: SCHEMA_VERSION,
    command: 'vcut silences',
    output: {
      version: 'number, always 1',
      input: 'absolute path to the media',
      rangeStartMs: 'integer, absolute ms where the measured range begins',
      rangeEndMs: 'integer, absolute ms where the measured range ends',
      thresholdDb: 'number, the noise floor used',
      minSilenceMs: 'integer, the minimum silence duration used',
      blocks:
        '[{ kind: "speech"|"silence", startMs, endMs, durationMs }], ordered, covering the whole requested range, in absolute ms',
    },
    notes: [
      'This is the placing instrument, not the cutting one: detect.silences is still what edl build cuts against, at the threshold proven in production.',
      'Positions on --from/--to are seconds; the JSON speaks milliseconds, same rule as every other command.',
      "Exists for a resolution detect cannot give: the gap between a filler and the next word can measure 80-150ms, well under detect's 0.3s default minimum.",
    ],
  },
  open: {
    version: SCHEMA_VERSION,
    command: 'vcut open',
    output: {
      version: 'number, always 1',
      sessionDir: 'absolute path to ~/.vcut/sessions/<sha256-16>/',
      input: 'absolute path to the source, as given on this call',
      durationMs: 'integer',
      preset: 'noisy | clean | podcast',
      lang: 'free-form language tag',
      gen: 'integer, the refs generation. Bumps whenever a re-open changes the preset',
      cached:
        'boolean, whether the cached detect report from a prior open was reused for this preset',
      silenceCount: 'integer, from the cached or fresh detect report',
      blockCount: 'integer, how many refs this open produced',
      transcriptPresent:
        'boolean, whether a transcript is cached in this session (from --transcript now or an earlier open)',
      suspects:
        '[{ atMs, gapMs, ratio, nearestRef }], top 10, same ranking as vcut suspects, each with the block ref nearest it',
      fresh:
        'boolean, whether this call created the session (false when resuming one already on disk)',
    },
    notes: [
      'Sessions are addressed by content: ~/.vcut/sessions/<first 16 hex chars of the sha256>/. The same bytes at two paths share a session; the same path with new content gets a new one.',
      "Refs (b001, b002, ...) are the speech blocks between the cached detect report's own silences, in time order. They derive from detect.silences, never from vcut silences, which answers a different, caller-chosen resolution question.",
      "A re-open with a preset this session has never used re-detects and assigns it a new gen. Refs from an earlier gen describe a silence list this session no longer has; cut/peek reject them by name rather than silently reusing stale boundaries. Gen derives from the effective preset, not from whether the immediately previous open differed: returning to a preset this session has already used before returns to that preset's own original gen rather than minting a new one, so noisy -> clean -> noisy reads gen 1, 2, 1, never 1, 2, 3.",
      'This reports counts, not content: no spoken text appears anywhere in this output. Reading what is actually said at a position is a later verb (peek, not in this slice).',
      'video scan (black/frozen frame detection) is skipped: refs and the suspects ranking only need silences, and the scan is real ffmpeg time this command has no use for.',
      "With --transcript, the cached detect report's transcript.path is rewritten to the session's own copy at cache time, so every later reader of the cached detect (commit, a hand-inspected detect.json) sees a path guaranteed to still resolve rather than whatever external path this call happened to be given.",
    ],
  },
  peek: {
    version: SCHEMA_VERSION,
    command: 'vcut peek',
    output: {
      version: 'number, always 1',
      input: 'absolute path to the source',
      sessionDir: 'absolute path to this session',
      ref: 'the ref this peek resolved, or null when --at was used',
      atMs: 'integer, the centre of the span',
      spanStartMs: 'integer',
      spanEndMs: 'integer',
      transcript:
        '{ words: [{text, startMs, endMs}], note? }. Words the cached transcript claims inside the span; note explains an empty result when no transcript is cached',
      heard: '{ text: string }. The span re-transcribed just now, verbatim preset',
      blocks:
        '[{ kind: "speech"|"silence", startMs, endMs, durationMs }], fine resolution (-33dB, 0.08s min) over span ± 1s',
      level: '{ peakDb: number|null, meanDb: number|null }, over the span itself',
      viewsDisagree:
        '{ disagree: boolean, kind: "transcript-claims-more"|"heard-more"|"aligned"|"soft-speech-below-threshold" }',
    },
    notes: [
      "Resolves the session for <media> the way open does (creates it if absent, reuses checkSession's cheap path otherwise). --ref resolves a block from this session's refs.json; --at takes a raw position and derives a span --window seconds wide (default 4), centred on --at.",
      'viewsDisagree compares transcript against heard on carrying words (4+ letters), the same comparison converge uses for the same reason: short words drift between two transcriptions of the same audio and comparing them reports noise, not disagreement.',
      'soft-speech-below-threshold fires when the fine-resolution blocks read silence for the whole span but heard still carries words: speech under the level threshold that neither silences nor detect can see, but a transcriber hears plainly.',
      'A disagreement is a place to look, not a verdict. Short-window transcription is itself noisy; treat viewsDisagree as a pointer, confirm with a wider window before acting on it.',
    ],
  },
  cut: {
    version: SCHEMA_VERSION,
    command: 'vcut cut',
    output: {
      default:
        '{ version, input, sessionDir, refs: string[], accepted: Proposal & {removedText, proposedAt, driftSuspect?: true}, transcriptPresent, next }',
      '--list':
        '{ version, input, sessionDir, proposals: (Proposal & {removedText, proposedAt, driftSuspect?: true})[] }',
      '--drop':
        '{ version, input, sessionDir, dropped: number, proposals: (Proposal & {removedText, proposedAt, driftSuspect?: true})[] }',
    },
    notes: [
      'The session must already exist: cut resolves refs against a session it does not create. Run vcut open first.',
      "--refs takes a single ref or an inclusive range (b042..b044): the span runs from the first ref's start to the second's end. Resolution reuses peek's resolveRef, so an unknown or stale-gen ref is a usage error naming the ref and the session's current gen, not a guess.",
      '--span <startS>..<endS> is the escape hatch for a raw span when no ref fits. Mutually exclusive with --refs and --start-ms/--end-ms.',
      "--start-ms <n> --end-ms <n> takes the same raw milliseconds say, silences, and semantic export already emit, so a finding from any of those needs no seconds conversion to reach a session. Same session-tracking benefits as --refs and --span: accumulates in proposals.json, shows in rounds --diff. Bounds are validated against the session's own detect report duration; an inverted range is a usage error. Mutually exclusive with --refs and --span.",
      "removedText is quoted from the session's cached transcript at propose time, before any build runs — the corrective for a cut whose span drifted onto the wrong words unnoticed until a render.",
      "driftSuspect is present and true only when a proposal's own span is built from cues that claim a word starts inside the session's cached measured silence — the same driftSuspectSpan check edl build's driftSuspect runs, reused rather than duplicated. Absent (not false) when clean. Scoped to the proposal's own raw span, not the merged span commit checks: a clean read here does not guarantee a clean read once commit builds the merged span, only that this proposal's own claimed words do not already contradict the cached silences. --human prints it as a warning line, same convention edl build's own warnings use.",
      "Appends to the session's proposals.json (created on first cut) without driftSuspect: the flag is derived fresh from the session's cached transcript and detect report every time a proposal is read back (default, --list, --drop), never persisted, so it can never go stale relative to the cache it is checked against.",
      "Appends to the session's proposals.json (created on first cut). Proposing and --drop take the session's advisory lock for the write and release it after; --list never locks. A session already locked by a live process fails with an error naming its pid, verb, and age.",
    ],
  },
  commit: {
    version: SCHEMA_VERSION,
    command: 'vcut commit',
    output: {
      status: 'always "committed"',
      edlPath: 'absolute path to the EDL written (default ./edl.json, the current directory)',
      sessionDir: 'absolute path to the session this was built from',
      roundDir:
        'absolute path to rounds/round-N/ inside the session, where the EDL copy and build report were recorded',
      build:
        'the same BuildSummary shape edl build emits (segments, removalPercent, semanticCuts with removedText, warnings, ...)',
      render: 'the same shape render emits (status, outputPath, sha256, duration, ...)',
      next: '[{ question, verb }]',
    },
    notes: [
      "Builds from the session's cached detect report and its accumulated proposals.json, through the same runBuild seam vcut edl build --semantic <path> uses — byte-identical output given the same inputs.",
      'The EDL is written to the current directory by default, never only inside the session: it is the artefact a human approves.',
      "--audio-only is the default render (matching the manual's per-round rule); --video renders the preview instead. Master mode never happens here.",
      'Approval is a human edit to the EDL followed by vcut render --edl <path> --mode master. This command drafts and previews only; it never writes approval.status.',
      "Takes the session's advisory lock (pid+startedAt+verb in lock.json) for the build+render, released after. A second writer on a session already locked by a live process gets a non-usage error naming the holder's pid, verb, and age. On success the session is marked committed, which vcut session gc reads as a candidate — nothing is deleted here or automatically.",
    ],
  },
  rounds: {
    version: SCHEMA_VERSION,
    command: 'vcut rounds',
    output: {
      default: '{ version, input, sessionDir, rounds: number[] }',
      '--diff': '{ version, input, sessionDir, diff: RoundsDiff }',
    },
    notes: [
      'Without --diff, lists every round number this session has committed, ascending. With --diff <N> <M>, compares round N against round M; omitting N and M diffs the latest two.',
      'RoundsDiff: { fromRound, toRound, removalPercentDelta, segmentCountDelta, semanticCuts: [{status: "added"|"removed"|"changed"|"unchanged", from?, to?}] }. semanticCuts entries are matched between rounds by span overlap, not by array position, since a proposal\'s exact edges can shift slightly between rounds without being a different decision.',
      "This diffs each round's build report (removalPercent, segments, semanticCuts — the same data vcut commit already writes to rounds/round-N/report.json), not either round's actual render: a text-level diff of what a render says needs a transcript of it, and vcut does not store renders or their transcripts in a session. Confirm a semantic diff with vcut peek or say --transcribe on the renders themselves.",
      "The session must already exist with at least 2 committed rounds for --diff; like cut and commit, this reads a session's history rather than creating one.",
    ],
  },
  session: {
    version: SCHEMA_VERSION,
    command: 'vcut session list | vcut session gc',
    output: {
      list: '{ version, sessions: SessionSummary[] }',
      gc: '{ version, applied: boolean, olderThanDays: number|null, candidates: GcCandidate[], deleted: number }',
    },
    notes: [
      'SessionSummary: { sessionDir, sourcePath, sourceExists, sizeBytes, createdAt, committedRounds, committedAt, locked }.',
      'GcCandidate: { sessionDir, sourcePath, sizeBytes, reasons: ("orphan"|"committed"|"older-than"|"locked-protected")[], deletable }.',
      'gc is dry-run by default: it classifies every session and reports what would go, deleting nothing until --apply is also passed. A session is a candidate when its source file no longer exists (orphan), it has committed at least one round (committed), or --older-than <days> was given and it qualifies (older-than). A session a live process currently holds the lock on is always locked-protected and never deletable regardless of any other reason.',
      'Nothing here can reach an approved EDL: vcut commit writes it to --output/--edl, wherever the caller pointed, never inside a session directory. gc clearing a whole session only ever removes the disposable detect cache, transcript copy, refs, proposals, and round history behind it.',
    ],
  },
  say: {
    version: SCHEMA_VERSION,
    command: 'vcut say',
    output: {
      atMs: 'integer, the position asked about. Absent when --positions is used',
      windowMs: 'integer, how much context was read',
      text: 'the words in the window, joined',
      words: '[{ text, startMs, endMs }]',
      peakDb: 'number|null, loudest sample in the window. null when no media was given',
      meanDb: 'number|null',
      segment: '{ id, sourceMs }|null, only with --edl',
      warning: 'present when the transcript is not word-level',
      positions:
        '[{ atMs, windowMs, text, words, peakDb, meanDb, segment?, warning? }], only with --positions: one object per position, same shape as a single call, in the order given',
    },
    notes: [
      'Reads an existing transcript. vcut never calls a model, here as everywhere else.',
      'Do not answer this by transcribing a short slice instead: a window under about two seconds returns noise whatever the audio contains, so the result cannot tell a real word from a guess.',
      'A window with no words but real level is the interesting case: something audible the transcript never saw. That is what the non-speech classifier is for.',
      '--positions answers several windows in one call instead of one --at call per position. Mutually exclusive with --at/--through. With --transcribe it transcribes strictly sequentially, never concurrently, since each call loads a Whisper model into memory.',
    ],
  },
  audit: {
    version: SCHEMA_VERSION,
    command: 'vcut audit',
    output: {
      segments: 'integer, how many the EDL has',
      checked: 'integer, how many were long enough to compare',
      skippedTooShort: 'integer, segments under the minimum window',
      lookAtBelow: 'number, the correlation below which a segment is reported',
      suspect: '[{ id, masterMs, sourceMs, correlation, windowMs }], lowest first',
      checks: 'every comparison, same shape as suspect',
    },
    notes: [
      'Every check the renderer runs is an aggregate: dimensions, frame count, duration. A render whose segments carried the wrong material passes all of them. This compares the audio itself against the source span the EDL points at.',
      '--render accepts an audio-only render. Every check here decodes a waveform, never a frame, so vcut render --audio-only is enough for every round; render video once, at the end, for the master.',
      'A low score is a place to look, not a verdict. Envelope correlation is weak over short or quiet windows, and loudness normalisation reshapes quiet passages further. Confirm with vcut say before acting on it.',
      'Measured on one 22-segment render: 21 boundaries scored above 0.85, and the one below was verified by transcription to carry the right words.',
    ],
  },
  locate: {
    version: SCHEMA_VERSION,
    command: 'vcut locate',
    output: {
      query: '{ masterMs } or { sourceMs }, whichever was asked',
      sourceMs: 'integer, where the master position came from. Absent when asking the other way',
      masterMs: 'integer, or null when the source position was cut',
      removed: 'boolean, only when asking --source. true means the span is not in the master',
      segment: '{ id, sourceId, sourceInMs, sourceOutMs, masterInMs, masterOutMs }',
      offsetIntoSegmentMs: 'integer, how far into the segment the position falls',
      cutBeforeSegmentMs: 'integer|null, source removed immediately before it. --explain only',
      neighbors: '{ before, after }, the adjacent placements. --explain only',
      render: '{ agrees, expectedMs, observedMs, deltaMs }, only with --render',
      segments: 'the whole map, only with --all',
    },
    notes: [
      'The map is derived from the EDL, which records intent rather than what was produced.',
      'Deriving it by hand is the trap this replaces: the accumulated total can match the rendered file to the millisecond while individual positions land seconds away.',
      'Pass --render to compare the map against a file that exists. Agreement on the total is necessary, not sufficient.',
      'A --source position that was cut is reported as removed with the next surviving segment, not as an error.',
    ],
  },
  joins: {
    version: SCHEMA_VERSION,
    command: 'vcut joins',
    output: {
      version: 'number, always 1',
      edl: 'absolute path to the EDL',
      render: 'absolute path to the rendered file',
      renderCheck:
        '{ agrees, expectedMs, observedMs, deltaMs }, the EDL map checked against the measured render, same shape as locate --render',
      joins:
        '[{ segmentId, joinMasterMs, windowStartMs, windowEndMs, windowText, removedText, reason, driftSuspect, reading, next }], one per semantic cut that has a following segment',
      'joins[].reading': '"lands" | "removed-text-leaked" | "check-by-ear"',
      'joins[].removedText':
        'string|null. null when no --report (or sibling report.json) carries semanticCuts for this EDL',
      'joins[].reason': 'string|null, the semantic proposal reason, same source as removedText',
      'joins[].driftSuspect':
        'boolean|null, from the build report entry when present, null otherwise',
    },
    notes: [
      "The post-render twin of edl build's removedText: one call verifies every semantic join instead of N x (locate + say --transcribe). On a real 11.7-minute run, verifying 9 joins by hand cost ~14 calls.",
      "Each join is the EDL segment that opens right after a semantic cut, derived the same way build-edl.ts's boundariesAfterSpeech finds it (by the kind of cut, not a distance) — reused directly rather than re-derived, so this can never disagree with the warning edl build already writes about the same boundary. A semantic cut that opens the file (nothing precedes it) has no join and is silently absent.",
      "Runs on --render, never the source: the EDL is intent, the render is what happened. renderCheck compares the EDL's own master-time total against the render's measured duration before any window is read, the same numeric style locate --render already uses.",
      '--report points at a build report (vcut edl build or vcut commit JSON, or rounds/round-N/report.json which is the default sibling lookup next to --edl) for removedText/reason/driftSuspect. Absent is a supported state: joins still runs and reports reading from the window alone, with those three fields null.',
      'reading is "lands" when the window\'s carrying words do not majority-overlap the cut\'s removedText, "removed-text-leaked" when they do (the tail of removed speech survived the join), and "check-by-ear" when the window carries no words worth judging — the same honest-limits stance peek\'s viewsDisagree and nonspeech --verify already take rather than reading silence as a verdict.',
      '"removed-text-leaked" is a place to look, not a verdict, same as every other disagreement reading in this codebase. Verified false positive on real material: a false-start whose removedText was the speaker stumbling on the same phrase before landing it, followed by a surviving sentence that legitimately reuses that phrase as its real content — carrying-word overlap cannot tell a leaked tail from a kept sentence sharing vocabulary with its own discarded false starts. Confirm with a wider say --transcribe window before acting on it, the next hint this reading carries.',
      "Transcribes strictly sequentially, one trx call at a time, never Promise.all — the same reasoning nonspeech.ts's verifySpansSequentially and say --positions --transcribe already apply.",
    ],
  },
  nonspeech: {
    version: SCHEMA_VERSION,
    command: 'vcut nonspeech',
    output: {
      status: '"ok" | "classifier-absent"',
      detail: 'string, present only when status is "classifier-absent"',
      verified: 'boolean, present and true only when --verify was passed',
      spans:
        'without --verify: [{ startMs, endMs }]. With --verify: [{ startMs, endMs, text, peakDb, meanDb, reading }]',
      reading: '"vocalization-suspect" | "words-around" | "empty", --verify only',
      means: 'a one-line gloss of what each reading means, --verify only',
    },
    notes: [
      'Runs skills/core/scripts/non-speech.py against a rendered preview. Run it on the render, not the source: on raw footage every pause scores as non-speech, correctly and uselessly.',
      '<render> accepts an audio-only render. The classifier and --verify both decode audio only, never a frame, so the .wav vcut render --audio-only writes is enough for every round; render video once, at the end, for the master.',
      'The classifier is optional (python3, panns-inference, and a ~320MB model under ~/.vcut/panns). Its absence is a supported state, reported as status "classifier-absent" with exit 0, the same policy vcut doctor already applies. Without it, invariant 7 needs a human ear.',
      "vcut calls no model of its own: python3 and trx are binaries on the caller's PATH, exactly like ffmpeg.",
      '--verify exists because reading the whole-file transcript to close a classifier hit is circular for this class of sound: the transcript is exactly what could not see it. It re-transcribes a window of the span plus 1.2s of context on each side and reports what that window actually says.',
      'vocalization-suspect means the windowed transcript names a hesitation sound (eh, ehm, mmm, aah, tolerant of a stretched vowel), or the span has real level with no words inside it. words-around means the window transcribes to ordinary words sitting either side of the span, i.e. a breath in a pause. empty means no words and no real level. A span whose windowed transcript is genuinely empty at real level is still a question for a listener, not a false positive to wave off.',
    ],
  },
  render: {
    version: SCHEMA_VERSION,
    command: 'vcut render',
    output: {
      status: '"ready" for --dry-run, "rendered" otherwise',
      audioOnly: 'true when --audio-only was passed, absent otherwise',
      outputPath: 'absolute path to the rendered file',
      sha256: 'hex digest of the output, stable across identical runs',
      duration: 'seconds, as reported by ffprobe',
      frames: 'decoded frame count, absent for --audio-only',
    },
    notes: [
      'Preview mode accepts proposed segments; master mode requires approval.',
      'render blocks in the foreground until ffmpeg exits and streams one progress line to stderr per ffmpeg report. There is no background mode, so a caller never polls for the output file or greps a process table to learn a render is alive: when the command returns, the render is done. --quiet drops the progress lines and renders the same file.',
      'Audio is normalised to the EDL speechTargetLufs, on the concatenated result rather than per segment.',
      'The renderer validates its own output against the EDL and fails on a mismatch.',
      '--audio-only renders the audio alone for iterating, using the same audio graph as the video path. Measured at 0.25s against 31.8s on one 22-segment EDL. It writes lossless audio, defaults to the EDL output path with a .wav extension, and is refused in master mode.',
      'The audio-only verification loop: render --audio-only, then vcut audit and vcut nonspeech against that same .wav — both read the waveform only and accept it wherever they accept a video render. Render video once, at the end, for the master.',
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

// What each on-demand section of the core manual answers, in the order a reader meets them:
// the flow first, then the methodology, then per-command detail. The blurb is the whole point
// of the table — a section name alone ("detect", "joins") does not tell a caller whether the
// question they have is in it, which is how an agent ends up loading all of them to find out.
// Ordered rather than alphabetical because `skills list` prints it as a reading order.
export const CORE_SECTIONS: { name: string; reads: string }[] = [
  {
    name: 'workflow',
    reads: 'running a whole edit end to end, including the stateless path in full',
  },
  {
    name: 'rounds-methodology',
    reads: 'working a round: what to read, how to widen a span, when a boundary lies',
  },
  { name: 'invariants', reads: 'deciding whether the edit is done' },
  { name: 'how-hard-to-cut', reads: 'deciding whether a cut is worth making' },
  { name: 'semantic', reads: 'writing proposals against the exported lines' },
  {
    name: 'muletillas',
    reads: 'a filler is audible in the render and invisible in every transcript',
  },
  { name: 'classifier', reads: 'wondering why non-speech needs a model and not a statistic' },
  { name: 'eleven-runs', reads: 'about to run this for the first time: 7 habits, four failures' },
  { name: 'detect', reads: 'picking a preset, or reading a drift warning' },
  { name: 'open', reads: 'refs, gen, and what a session caches' },
  { name: 'peek', reads: 'four views of a position and viewsDisagree' },
  { name: 'cut', reads: 'ref ranges, --start-ms, --span, --list/--drop' },
  { name: 'commit', reads: 'what a commit builds, renders, and records' },
  { name: 'rounds', reads: 'comparing two committed rounds' },
  { name: 'session', reads: 'the store, gc, and the advisory lock' },
  { name: 'edl-build', reads: 'removedText, driftSuspect, boundary warnings, --crop' },
  { name: 'render', reads: 'audio-only, progress, loudness, reproducibility' },
  { name: 'silences', reads: 'placing a boundary at sub-second resolution' },
  { name: 'suspects', reads: 'where to look first in a long file' },
  { name: 'say', reads: 'reading versus re-transcribing a position' },
  { name: 'converge', reads: 'finding where a repeated phrase stops coming back' },
  { name: 'joins', reads: 'verifying every semantic join after a render' },
  { name: 'audit', reads: 'checking a render carried the material the EDL named' },
  { name: 'locate', reads: 'translating between master time and source time' },
  { name: 'nonspeech', reads: 'the classifier, --verify, and its readings' },
  { name: 'limits', reads: 'what vcut refuses to do' },
]

// Sections live beside the skill they belong to, as <skill>/sections/<name>.md. Only `core` has
// any today; resolving through the skill name rather than hardcoding `core` means a second
// skill growing sections needs no change here.
export const sectionPath = (directory: string, skill: string, section: string): string =>
  join(directory, skill, 'sections', `${section}.md`)

// Split out of skillsCommand so the flag reading is testable without a filesystem: --section
// <name> and --section=<name>, the same two forms --fields and --jq already accept. Returns
// undefined when the flag is absent, and throws rather than guessing when it is present with
// nothing usable after it — a bare `--section` is a caller who meant to name one.
export const parseSection = (args: string[]): string | undefined => {
  const index = args.indexOf('--section')
  if (index !== -1) {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new UsageError(
        '--section needs a name, e.g. --section cut. Run vcut skills list for the sections.',
      )
    }
    return value
  }
  const inline = args.find((arg) => arg.startsWith('--section='))
  if (inline === undefined) {
    return undefined
  }
  const value = inline.slice('--section='.length)
  if (value.length === 0) {
    throw new UsageError(
      '--section needs a name, e.g. --section cut. Run vcut skills list for the sections.',
    )
  }
  return value
}

const skillsCommand = (argv: string[]): void => {
  const [verb, ...rest] = argv
  const directory = skillsDir()
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))

  if (verb === undefined || verb === 'list') {
    const entries = readdirSync(directory, { withFileTypes: true })
    const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    // A skill owns its scripts, in <skill>/scripts, which is where the agent-skills layout
    // puts them. Listing them is the difference between an optional tool and a hidden one:
    // a caller asking what is available would otherwise never learn the script exists.
    const scripts = names.flatMap((name) => {
      const dir = join(directory, name, 'scripts')
      if (!existsSync(dir)) {
        return []
      }
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => ({ skill: name, name: entry.name, path: join(dir, entry.name) }))
    })
    // Only the sections that actually exist on disk, so a listing can never advertise a
    // section `get --section` would then refuse. The registry is the order and the blurb; the
    // filesystem is the authority on presence.
    const sections = CORE_SECTIONS.filter((section) =>
      existsSync(sectionPath(directory, 'core', section.name)),
    )
    if (mode === 'json') {
      emitJson({ skills: names, scripts, sections })
      return
    }
    console.log(
      [
        heading('bundled skills'),
        ...names.map((name) => line(name, `vcut skills get ${name}`)),
        ...(scripts.length === 0
          ? []
          : [
              heading('bundled scripts'),
              ...scripts.map((script) => line(`${script.skill}/${script.name}`, script.path)),
            ]),
        ...(sections.length === 0
          ? []
          : [
              heading('core sections (vcut skills get core --section <name>)'),
              ...sections.map((section) => line(section.name, section.reads)),
            ]),
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

    const section = parseSection(rest)

    if (section !== undefined) {
      const file = sectionPath(directory, name, section)
      if (!existsSync(file)) {
        // Names the sections rather than only refusing: a caller guessing a section name is one
        // list away from the right one, and making them run a second command to find out is the
        // friction this whole split exists to remove.
        const available = CORE_SECTIONS.filter((candidate) =>
          existsSync(sectionPath(directory, name, candidate.name)),
        ).map((candidate) => candidate.name)
        throw new UsageError(
          available.length === 0
            ? `${name} has no sections. Run vcut skills get ${name} for the whole document.`
            : `no section named ${section} in ${name}. Available: ${available.join(', ')}`,
        )
      }
      process.stdout.write(readFileSync(file, 'utf8'))
      return
    }

    // Without --section this serves the small always-loaded core, not every section
    // concatenated. Backward compatible in the sense that matters: the caller that ran
    // `skills get core` before still gets the document that tells it how to run an edit. Serving
    // the full concatenation instead would keep the ~35-40k token tax this split exists to
    // remove, and would do it to exactly the callers who never asked for a deep dive.
    const file = join(directory, name, 'SKILL.md')
    if (!existsSync(file)) {
      throw new UsageError(`no skill named ${name}. Run vcut skills list.`)
    }
    process.stdout.write(readFileSync(file, 'utf8'))
    return
  }

  throw new UsageError('Usage: vcut skills list | get <name> [--section <name>] | path [name]')
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
  if (command === 'converge') {
    return convergeCommand(rest)
  }
  if (command === 'suspects') {
    return suspectsCommand(rest)
  }
  if (command === 'semantic') {
    return semanticCommand(rest)
  }
  if (command === 'render') {
    return renderCommand(rest)
  }
  if (command === 'audit') {
    return auditCommand(rest)
  }
  if (command === 'locate') {
    return locateCommand(rest)
  }
  if (command === 'joins') {
    return joinsCommand(rest)
  }
  if (command === 'say') {
    return sayCommand(rest)
  }
  if (command === 'nonspeech') {
    return nonspeechCommand(rest)
  }
  if (command === 'silences') {
    return silencesCommand(rest)
  }
  if (command === 'open') {
    return openCommand(rest)
  }
  if (command === 'peek') {
    return peekCommand(rest)
  }
  if (command === 'cut') {
    return cutCommand(rest)
  }
  if (command === 'commit') {
    return commitCommand(rest)
  }
  if (command === 'rounds') {
    return roundsCommand(rest)
  }
  if (command === 'session') {
    return sessionCommand(rest)
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
  if (command === 'init') {
    return setupAll(rest)
  }
  if (command === 'setup') {
    return setupCommand(rest)
  }
  if (isPath(command)) {
    return detectCommand([resolve(command), ...rest])
  }
  throw new UsageError(`unknown command: ${command}\n\n${HELP}`)
}

route(process.argv.slice(2)).catch(fail)
