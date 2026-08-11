/**
 * `vcut cut <media> --refs b042[..b044] --kind <k> --reason "<text>"` — propose a semantic cut
 * against block refs instead of raw milliseconds, and see what it removes before building
 * anything.
 *
 * This is the corrective the shape names directly: the corrupted-cut class (`edl build`'s
 * `removedText`/`boundariesInSilence` fields already answer "what did a span end up removing"
 * at build time, after the fact) moves earlier, to propose time. A ref resolves to a measured
 * block boundary rather than a hand-typed millisecond pair, so the class of mistake where a
 * measured block gets mis-assigned to the wrong words cannot be written in the first place —
 * the span comes from the block, not from a number someone typed while looking at a different
 * output.
 *
 * `--refs b042..b044` is inclusive: the cut runs from b042's own start to b044's own end,
 * spanning whatever lies between them (including any silence). A single ref (`--refs b042`) is
 * that block alone. Gen enforcement reuses `peek`'s `resolveRef`: a ref from an old generation
 * is rejected by name rather than silently resolved against boundaries the session no longer
 * has, per the spike's B2-Q3 resolution.
 *
 * `--span <startS>..<endS>` is the escape hatch for a raw span when no ref fits (a cut that
 * straddles what the detector saw as one long block, or a boundary a ref's own edges do not
 * reach) — mutually exclusive with `--refs`, so a call is never ambiguous about which one is
 * driving the span.
 *
 * `--start-ms <n> --end-ms <n>` is the same escape hatch in the unit `say`, `silences`, and
 * `semantic export` (before this slice's nearestRef) actually emit: raw milliseconds, not
 * seconds. Before this, a finding born from any of those three commands had no path into a
 * session's coordinate system without a caller doing the ms-to-seconds conversion by hand for
 * `--span`, which is exactly the gap issue #23 names. Mutually exclusive with both `--refs` and
 * `--span`; validated against the session's own detect report duration the same way `edl build`
 * validates a raw semantic proposal.
 *
 * `removedText` is quoted from the session's cached transcript at propose time, which is the
 * whole point named in the shaping doc: this is what B-V2's honest-limits stance calls quoting,
 * not re-transcribing — the same words a human reading the proposal later would see if they ran
 * `peek` themselves, read once here so a caller does not have to run a second command to find
 * out what they are about to remove.
 *
 * Proposing and `--drop` take the session's advisory lock (B-V4, B7-Q1) for the duration of
 * the write; `--list` never locks, since it only reads. A second writer on the same session
 * gets `SessionLockedError` naming the holder's pid, verb, and age rather than a race on
 * `proposals.json`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { parseSrt, type Word } from './detect.ts'
import { emitJson, heading, line, type Mode, nextStep, resolveMode, UsageError } from './output.ts'
import { resolveRef } from './peek.ts'
import { wordsInWindow } from './say.ts'
import type { Proposal } from './semantic.ts'
import {
  acquireLock,
  appendProposal,
  cachedDetect,
  cachedTranscriptPath,
  checkSession,
  dropProposal,
  openSession,
  type RefBlock,
  readProposalsFile,
  readRefs,
  releaseLock,
  type SessionProposal,
} from './session.ts'

const HELP = `vcut cut - propose a semantic cut against block refs, see what it removes

Usage:
  vcut cut <media> --refs <ref>[..<ref>] --kind <kind> --reason "<text>" [--json|--human]
  vcut cut <media> --span <startS>..<endS> --kind <kind> --reason "<text>"
  vcut cut <media> --start-ms <n> --end-ms <n> --kind <kind> --reason "<text>"
  vcut cut <media> --list
  vcut cut <media> --drop <index>

Flags:
  --refs <ref[..ref]>   A block ref, or an inclusive range (b042..b044) from this session's
                        refs.json. Mutually exclusive with --span and --start-ms/--end-ms.
  --span <s..s>         A raw span in seconds when no ref fits. Mutually exclusive with --refs
                        and --start-ms/--end-ms.
  --start-ms <n>        Raw span start in milliseconds, the unit say/silences/semantic export
                        emit. Requires --end-ms. Mutually exclusive with --refs and --span.
  --end-ms <n>          Raw span end in milliseconds. Requires --start-ms.
  --kind <kind>         Required: false-start | repetition | tangent | filler
  --reason <text>       Required, non-empty. Read by a human deciding whether to approve.
  --list                Print the session's accumulated proposals with their removedText
  --drop <index>        Remove the proposal at this 0-based index
  --json / --human      Output mode
  --help                Show this message

The session must already exist (run vcut open first) — cutting against a session that was
never opened is a caller mistake, not something this command creates on the fly. A ref from an
earlier generation is a usage error naming the ref and the session's current gen, the same
enforcement peek already applies.

--start-ms/--end-ms take the same session-tracked path --refs and --span do: the proposal
accumulates in proposals.json, shows in vcut rounds --diff, and needs no hand-typed detect or
semantic file. Bounds are validated against the session's own source duration, and an inverted
range (end at or before start) is a usage error rather than a silent swap.

Appends the proposal to the session's proposals.json (created on first cut). Proposing and
--drop take the session's advisory lock for the duration of the write and release it after;
--list never locks, since it only reads. A session already locked by another live process
fails with an error naming its pid, verb, and age rather than racing the write — see
vcut session gc --help for how a stale lock (dead pid) clears on the next attempt by anyone.
Next: vcut peek to hear the span, vcut commit when done proposing.

Also accepts --fields/--jq. See vcut --help for the full picture.`

const BOOLEAN_FLAGS = new Set(['--json', '--human', '--help', '--list'])

const positional = (args: string[]): string | undefined => {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith('--')) {
      continue
    }
    const previous = args[index - 1]
    if (previous?.startsWith('--') && !BOOLEAN_FLAGS.has(previous)) {
      continue
    }
    return arg
  }
  return undefined
}

const flagValue = (argv: string[], name: string): string | undefined => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

export type Span = { startMs: number; endMs: number }

/**
 * `b042` or `b042..b044` against this session's refs.json.
 *
 * A single ref is that block's own span. A range is inclusive on both ends: from the first
 * ref's start to the second ref's end, spanning whatever lies between them — silence, another
 * block, or both. Reversed (`b044..b042`) is a usage error rather than a silent swap: a caller
 * who typed the range backwards almost certainly transposed two refs they meant in the other
 * order, and guessing which one they meant is how the wrong span gets cut.
 *
 * Each ref resolves through `resolveRef` (peek.ts), so gen enforcement and the "run vcut open
 * first" / "unknown ref" errors are the same for `cut` as they are for `peek` — one resolver,
 * not two copies that could drift.
 */
export const resolveRefsRange = (
  refsArg: string,
  refs: { gen: number; blocks: RefBlock[] } | null,
): { span: Span; refs: [string] | [string, string] } => {
  const parts = refsArg.split('..')
  if (parts.length > 2 || parts.some((part) => part.trim() === '')) {
    throw new UsageError(`--refs takes a single ref or a range like b042..b044, got ${refsArg}`)
  }
  if (parts.length === 1) {
    const block = resolveRef(parts[0], refs)
    return { span: { startMs: block.startMs, endMs: block.endMs }, refs: [block.ref] }
  }
  const [fromRef, toRef] = parts
  const from = resolveRef(fromRef, refs)
  const to = resolveRef(toRef, refs)
  if (to.startMs < from.startMs) {
    throw new UsageError(
      `--refs ${refsArg} runs backwards: ${to.ref} starts before ${from.ref}. Did you mean ${to.ref}..${from.ref}?`,
    )
  }
  return { span: { startMs: from.startMs, endMs: to.endMs }, refs: [from.ref, to.ref] }
}

/** `<startS>..<endS>` in seconds, to a millisecond span. */
export const parseSpanArg = (spanArg: string): Span => {
  const parts = spanArg.split('..')
  if (parts.length !== 2) {
    throw new UsageError(`--span takes <startS>..<endS>, got ${spanArg}`)
  }
  const startS = Number(parts[0])
  const endS = Number(parts[1])
  if (!Number.isFinite(startS) || !Number.isFinite(endS)) {
    throw new UsageError(`--span takes two numbers in seconds, got ${spanArg}`)
  }
  if (endS <= startS) {
    throw new UsageError(`--span end must be after start, got ${spanArg}`)
  }
  return { startMs: Math.round(startS * 1000), endMs: Math.round(endS * 1000) }
}

/**
 * `--start-ms <n> --end-ms <n>` read as a span with no unit conversion, since the values
 * arriving here are already the millisecond ints `say`, `silences`, and `semantic export`
 * emit — the whole point named in issue #23 is that a finding born from any of those never
 * needs a seconds round-trip to reach a session.
 */
export const parseMsRangeArgs = (startMsArg: string, endMsArg: string): Span => {
  const startMs = Number(startMsArg)
  const endMs = Number(endMsArg)
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
    throw new UsageError(
      `--start-ms and --end-ms take whole milliseconds, got ${startMsArg}..${endMsArg}`,
    )
  }
  if (startMs < 0) {
    throw new UsageError(`--start-ms cannot be negative, got ${startMsArg}`)
  }
  if (endMs <= startMs) {
    throw new UsageError(`--end-ms must be after --start-ms, got ${startMsArg}..${endMsArg}`)
  }
  return { startMs, endMs }
}

/** A span cannot run past the source it was measured against, the same bound edl build's
 * validateProposals applies to a raw semantic proposal. */
export const validateSpanBounds = (span: Span, durationMs: number): void => {
  if (span.endMs > durationMs) {
    throw new UsageError(`--end-ms ${span.endMs} runs past this session's ${durationMs}ms source`)
  }
}

const KINDS = new Set(['false-start', 'repetition', 'tangent', 'filler'])

export const validateKind = (kind: string | undefined): Proposal['kind'] => {
  if (kind === undefined || !KINDS.has(kind)) {
    throw new UsageError(`--kind must be one of ${[...KINDS].join(', ')}, got ${kind ?? '(none)'}`)
  }
  return kind as Proposal['kind']
}

export const validateReason = (reason: string | undefined): string => {
  if (reason === undefined || reason.trim() === '') {
    throw new UsageError('--reason is required and must be non-empty')
  }
  return reason
}

/** The transcript words inside a span, quoted at propose time, from a session's cached SRT. */
export const quoteRemovedText = (span: Span, words: Word[]): string =>
  wordsInWindow(words, span.startMs, span.endMs)
    .map((word) => word.text)
    .join(' ')
    .trim()

export const cutNext = (input: string, span: Span): Array<{ question: string; verb: string }> => [
  {
    question: 'hear the span before committing',
    verb: `vcut peek ${input} --at ${((span.startMs + span.endMs) / 2000).toFixed(2)} --window ${Math.max(2, Math.round((span.endMs - span.startMs) / 1000))}`,
  },
  {
    question: 'build and render everything proposed so far',
    verb: `vcut commit ${input} --output <master path> --campaign <id>`,
  },
]

const humanList = (input: string, proposals: SessionProposal[]): string => {
  if (proposals.length === 0) {
    return heading(`${input.split('/').pop()}  no proposals yet`)
  }
  const lines = [heading(`${input.split('/').pop()}  ${proposals.length} proposal(s)`)]
  proposals.forEach((proposal, index) => {
    lines.push(
      line(
        `[${index}] ${(proposal.startMs / 1000).toFixed(2)}-${(proposal.endMs / 1000).toFixed(2)}s`,
        `${proposal.kind}: "${proposal.removedText || '(no transcript)'}"`,
      ),
    )
    lines.push(line('', `reason: ${proposal.reason}`))
  })
  return lines.join('\n')
}

const humanAccepted = (
  input: string,
  proposal: SessionProposal,
  hints: Array<{ question: string; verb: string }>,
): string => {
  const lines = [
    heading(`${input.split('/').pop()}  proposed`),
    line('span', `${(proposal.startMs / 1000).toFixed(2)}-${(proposal.endMs / 1000).toFixed(2)}s`),
    line('kind', proposal.kind),
    line('reason', proposal.reason),
    line('removedText', proposal.removedText || '(no transcript cached in this session)'),
  ]
  for (const hint of hints) {
    lines.push(nextStep(hint.verb))
  }
  return lines.join('\n')
}

export const cutCommand = async (argv: string[]): Promise<void> => {
  if (argv.includes('--help') || argv.length === 0) {
    console.log(HELP)
    return
  }
  const mode: Mode = resolveMode(argv, Boolean(process.stdout.isTTY))
  const media = positional(argv)
  if (media === undefined) {
    throw new UsageError(HELP)
  }
  const resolvedMedia = resolve(media)
  if (!existsSync(resolvedMedia)) {
    throw new Error(`input missing: ${resolvedMedia}`)
  }

  // A cut against a session that was never opened is a caller mistake, not a flow this command
  // smooths over by creating one: unlike peek and open, cut never calls openSession.
  const session = await openSession(resolvedMedia)
  if (session.fresh) {
    throw new UsageError(
      `no session for ${resolvedMedia} yet. Run vcut open ${resolvedMedia} first — cut resolves refs against a session it does not create.`,
    )
  }
  const check = await checkSession(session.dir, resolvedMedia)
  if (check.status === 'sha-changed') {
    throw new UsageError(
      `${resolvedMedia} no longer matches this session (sha ${check.previousSha256.slice(0, 12)} -> ${check.currentSha256.slice(0, 12)}). Run vcut open again; the new content belongs to ${check.newSessionDir}.`,
    )
  }

  if (argv.includes('--list')) {
    const proposals = readProposalsFile(session.dir)
    if (mode === 'json') {
      emitJson({ version: 1, input: resolvedMedia, sessionDir: session.dir, proposals })
      return
    }
    console.log(humanList(resolvedMedia, proposals))
    return
  }

  const dropArg = flagValue(argv, '--drop')
  if (dropArg !== undefined) {
    const index = Number(dropArg)
    if (!Number.isInteger(index)) {
      throw new UsageError(`--drop takes a 0-based integer index, got ${dropArg}`)
    }
    acquireLock(session.dir, 'cut --drop')
    let remaining: SessionProposal[]
    try {
      remaining = dropProposal(session.dir, index)
    } finally {
      releaseLock(session.dir)
    }
    if (mode === 'json') {
      emitJson({
        version: 1,
        input: resolvedMedia,
        sessionDir: session.dir,
        dropped: index,
        proposals: remaining,
      })
      return
    }
    console.log(humanList(resolvedMedia, remaining))
    return
  }

  const refsArg = flagValue(argv, '--refs')
  const spanArg = flagValue(argv, '--span')
  const startMsArg = flagValue(argv, '--start-ms')
  const endMsArg = flagValue(argv, '--end-ms')
  if ((startMsArg !== undefined) !== (endMsArg !== undefined)) {
    throw new UsageError('--start-ms and --end-ms must be given together')
  }
  const msRangeGiven = startMsArg !== undefined && endMsArg !== undefined
  const waysGiven = [refsArg !== undefined, spanArg !== undefined, msRangeGiven].filter(
    Boolean,
  ).length
  if (waysGiven === 0) {
    throw new UsageError(
      'cut needs --refs <ref[..ref]>, --span <startS>..<endS>, or --start-ms <n> --end-ms <n>',
    )
  }
  if (waysGiven > 1) {
    throw new UsageError('--refs, --span, and --start-ms/--end-ms are mutually exclusive')
  }

  const kind = validateKind(flagValue(argv, '--kind'))
  const reason = validateReason(flagValue(argv, '--reason'))

  let span: Span
  let usedRefs: string[] = []
  if (refsArg !== undefined) {
    const refsFile = readRefs(session.dir)
    const resolved = resolveRefsRange(refsArg, refsFile)
    span = resolved.span
    usedRefs = resolved.refs
  } else if (spanArg !== undefined) {
    span = parseSpanArg(spanArg)
  } else {
    span = parseMsRangeArgs(startMsArg as string, endMsArg as string)
    const report = cachedDetect(session.dir)
    if (report !== null) {
      validateSpanBounds(span, report.durationMs)
    }
  }

  const transcriptPath = cachedTranscriptPath(session.dir)
  const removedText =
    existsSync(transcriptPath) === false
      ? ''
      : quoteRemovedText(span, parseSrt(readFileSync(transcriptPath, 'utf8')).words)

  const proposal: SessionProposal = {
    startMs: span.startMs,
    endMs: span.endMs,
    kind,
    reason,
    removedText,
    proposedAt: new Date().toISOString(),
  }
  acquireLock(session.dir, 'cut')
  try {
    appendProposal(session.dir, proposal)
  } finally {
    releaseLock(session.dir)
  }

  const hints = cutNext(resolvedMedia, span)
  if (mode === 'json') {
    emitJson({
      version: 1,
      input: resolvedMedia,
      sessionDir: session.dir,
      refs: usedRefs,
      accepted: proposal,
      transcriptPresent: existsSync(transcriptPath),
      next: hints,
    })
    return
  }
  console.log(humanAccepted(resolvedMedia, proposal, hints))
}
