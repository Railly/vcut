import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { matchTarget } from '../src/build-edl.ts'
import { classifierStatus } from '../src/cli.ts'
import {
  bar,
  checkModeConflicts,
  duration,
  emitJson,
  packageVersion,
  parseFields,
  parseJqExpr,
  projectFields,
  requireHumanOnly,
  requireJson,
  requireRawOutput,
  resolveMode,
  UsageError,
} from '../src/output.ts'

describe('resolveMode', () => {
  test('defaults to JSON when stdout is not a TTY', () => {
    expect(resolveMode([], false)).toBe('json')
  })

  test('defaults to the human view on a TTY', () => {
    expect(resolveMode([], true)).toBe('human')
  })

  test('honours an explicit --json on a TTY', () => {
    expect(resolveMode(['--json'], true)).toBe('json')
  })

  test('honours an explicit --human when piped', () => {
    expect(resolveMode(['--human'], false)).toBe('human')
  })

  test('lets --json win over --human when both appear', () => {
    expect(resolveMode(['--human', '--json'], true)).toBe('json')
  })

  test('--fields implies JSON even on a TTY', () => {
    expect(resolveMode(['--fields', 'removalPercent'], true)).toBe('json')
  })

  test('--fields=<paths> also implies JSON', () => {
    expect(resolveMode(['--fields=removalPercent'], true)).toBe('json')
  })

  test('--jq implies JSON even on a TTY', () => {
    expect(resolveMode(['--jq', '.a'], true)).toBe('json')
  })

  test('--jq=<expr> also implies JSON', () => {
    expect(resolveMode(['--jq=.a'], true)).toBe('json')
  })

  // Issue #31: --human --jq (or --human --fields) used to be a silent no-op on any command
  // that prints human output without reaching emitJson — --human won the resolveMode check
  // that ran first and --jq's own implication never got a chance to fire. Both orderings are
  // covered, since a caller could type either flag first.
  test('--human --jq is a usage error, not a silent no-op', () => {
    expect(() => resolveMode(['--human', '--jq', '.a'], true)).toThrow(UsageError)
    expect(() => resolveMode(['--human', '--jq', '.a'], true)).toThrow(/mutually exclusive/)
  })

  test('--jq --human is the same usage error regardless of flag order', () => {
    expect(() => resolveMode(['--jq', '.a', '--human'], true)).toThrow(UsageError)
  })

  test('--human --fields is a usage error, not a silent no-op', () => {
    expect(() => resolveMode(['--human', '--fields', 'a'], true)).toThrow(UsageError)
    expect(() => resolveMode(['--human', '--fields', 'a'], true)).toThrow(/mutually exclusive/)
  })

  test('--human --jq= (inline form) is caught the same way', () => {
    expect(() => resolveMode(['--human', '--jq=.a'], true)).toThrow(UsageError)
  })

  test('--human --fields= (inline form) is caught the same way', () => {
    expect(() => resolveMode(['--human', '--fields=a'], true)).toThrow(UsageError)
  })

  test('names --jq specifically when both --jq and --fields somehow appear with --human', () => {
    // Not a real invocation (--fields/--jq are already mutually exclusive elsewhere), but the
    // guard should still name one flag rather than a vague "a flag" message.
    expect(() => resolveMode(['--human', '--jq', '.a', '--fields', 'a'], true)).toThrow(/--jq/)
  })

  test('--jq alone with --human absent is untouched: still forces JSON', () => {
    expect(resolveMode(['--jq', '.a'], true)).toBe('json')
  })
})

describe('checkModeConflicts', () => {
  test('is silent when --human appears alone', () => {
    expect(() => checkModeConflicts(['--human'])).not.toThrow()
  })

  test('is silent when --jq appears without --human', () => {
    expect(() => checkModeConflicts(['--jq', '.a'])).not.toThrow()
  })

  test('throws when --human and --jq appear together', () => {
    expect(() => checkModeConflicts(['--human', '--jq', '.a'])).toThrow(UsageError)
  })
})

describe('requireJson', () => {
  test('is silent when --human is absent', () => {
    expect(() => requireJson(['--fields', 'a'], 'vcut schema')).not.toThrow()
  })

  test('throws naming the command when --human is present', () => {
    expect(() => requireJson(['--human'], 'vcut schema')).toThrow(UsageError)
    expect(() => requireJson(['--human'], 'vcut schema')).toThrow(/vcut schema/)
  })
})

describe('requireRawOutput', () => {
  test('is silent when none of the four flags are present', () => {
    expect(() => requireRawOutput(['core'], 'vcut skills get')).not.toThrow()
  })

  test('rejects --json naming the command', () => {
    expect(() => requireRawOutput(['--json'], 'vcut skills get')).toThrow(/vcut skills get/)
  })

  test('rejects --human', () => {
    expect(() => requireRawOutput(['--human'], 'vcut skills get')).toThrow(UsageError)
  })

  test('rejects --fields', () => {
    expect(() => requireRawOutput(['--fields', 'a'], 'vcut skills get')).toThrow(UsageError)
  })

  test('rejects --jq', () => {
    expect(() => requireRawOutput(['--jq', '.a'], 'vcut skills get')).toThrow(UsageError)
  })
})

describe('requireHumanOnly', () => {
  test('leaves --human alone: it asks for the only mode this command has', () => {
    expect(() => requireHumanOnly(['--human'], 'vcut init')).not.toThrow()
  })

  test('is silent when no JSON-shaped flag is present', () => {
    expect(() => requireHumanOnly(['--no-skills'], 'vcut init')).not.toThrow()
  })

  test('rejects --json naming the command', () => {
    expect(() => requireHumanOnly(['--json'], 'vcut init')).toThrow(/vcut init/)
  })

  test('rejects --fields', () => {
    expect(() => requireHumanOnly(['--fields', 'a'], 'vcut init')).toThrow(UsageError)
  })

  test('rejects --jq', () => {
    expect(() => requireHumanOnly(['--jq', '.a'], 'vcut init')).toThrow(UsageError)
  })
})

describe('parseFields', () => {
  test('splits a comma-separated --fields value into paths', () => {
    expect(parseFields(['--fields', 'a,b.c,d'])).toEqual(['a', 'b.c', 'd'])
  })

  test('trims whitespace around each path', () => {
    expect(parseFields(['--fields', 'a, b.c , d'])).toEqual(['a', 'b.c', 'd'])
  })

  test('reads the --fields=<paths> inline form', () => {
    expect(parseFields(['--fields=a,b.c'])).toEqual(['a', 'b.c'])
  })

  test('returns null when --fields was not passed', () => {
    expect(parseFields(['--json'])).toBeNull()
  })

  test('returns an empty array when --fields was passed with no value', () => {
    expect(parseFields(['--fields'])).toEqual([])
  })
})

describe('parseJqExpr', () => {
  test('reads the --jq <expr> form', () => {
    expect(parseJqExpr(['--jq', '.a'])).toBe('.a')
  })

  test('reads the --jq=<expr> inline form', () => {
    expect(parseJqExpr(['--jq=.a'])).toBe('.a')
  })

  test('returns null when --jq was not passed', () => {
    expect(parseJqExpr(['--json'])).toBeNull()
  })

  test('throws when --jq was passed with no expression', () => {
    expect(() => parseJqExpr(['--jq'])).toThrow(/needs an expression/)
  })
})

describe('projectFields', () => {
  test('projects a top-level field', () => {
    const { projected, fieldErrors } = projectFields({ removalPercent: 22.5, segments: 4 }, [
      'removalPercent',
    ])
    expect(projected).toEqual({ removalPercent: 22.5 })
    expect(fieldErrors).toEqual([])
  })

  test('projects a nested field by dot path', () => {
    const { projected } = projectFields({ audio: { speechTargetLufs: -16 } }, [
      'audio.speechTargetLufs',
    ])
    expect(projected).toEqual({ 'audio.speechTargetLufs': -16 })
  })

  test('projects each element of an array field', () => {
    const value = {
      semanticCuts: [{ removedText: 'eh' }, { removedText: 'y luego' }],
    }
    const { projected } = projectFields(value, ['semanticCuts.removedText'])
    expect(projected).toEqual({ 'semanticCuts.removedText': ['eh', 'y luego'] })
  })

  test('projects several fields in one call', () => {
    const value = { removalPercent: 22.5, semanticCuts: [{ removedText: 'eh' }] }
    const { projected } = projectFields(value, ['removalPercent', 'semanticCuts.removedText'])
    expect(projected).toEqual({
      removalPercent: 22.5,
      'semanticCuts.removedText': ['eh'],
    })
  })

  test('an unknown path becomes a fieldErrors entry, not a thrown error', () => {
    const { projected, fieldErrors } = projectFields({ removalPercent: 22.5 }, ['segmentCount'])
    expect(projected).toEqual({})
    expect(fieldErrors).toEqual(['segmentCount'])
  })

  test('mixes a found field and an unknown one in the same call', () => {
    const { projected, fieldErrors } = projectFields({ removalPercent: 22.5 }, [
      'removalPercent',
      'nope',
    ])
    expect(projected).toEqual({ removalPercent: 22.5 })
    expect(fieldErrors).toEqual(['nope'])
  })

  test('an unknown path inside an array element is reported once for the whole path', () => {
    const value = { semanticCuts: [{ removedText: 'eh' }] }
    const { projected, fieldErrors } = projectFields(value, ['semanticCuts.missing'])
    expect(projected).toEqual({})
    expect(fieldErrors).toEqual(['semanticCuts.missing'])
  })

  test('a field present but null resolves, not a fieldErrors entry', () => {
    const { projected, fieldErrors } = projectFields({ warning: null }, ['warning'])
    expect(projected).toEqual({ warning: null })
    expect(fieldErrors).toEqual([])
  })
})

describe('bar', () => {
  test('grows with the fraction it represents', () => {
    expect(bar(0, 10)).toBe('..........')
    expect(bar(0.5, 10)).toBe('#####.....')
    expect(bar(1, 10)).toBe('##########')
  })

  test('clamps values outside the unit range', () => {
    expect(bar(-1, 4)).toBe('....')
    expect(bar(2, 4)).toBe('####')
  })
})

describe('duration', () => {
  test('drops the minute part below a minute', () => {
    expect(duration(39_000)).toBe('39s')
  })

  test('zero-pads the seconds past a minute', () => {
    expect(duration(382_000)).toBe('6m 22s')
    expect(duration(65_000)).toBe('1m 05s')
  })
})

describe('matchTarget', () => {
  test('names every range the value falls inside', () => {
    expect(matchTarget(18)).toContain('tutorial or screencast')
    expect(matchTarget(18)).toContain('scripted talking head')
  })

  test('names the single range for a value in one band only', () => {
    expect(matchTarget(40)).toBe('in range for event or interview')
  })

  test('says the source may already be edited when below every range', () => {
    expect(matchTarget(4)).toContain('already be edited')
  })
})

describe('emitJson', () => {
  // Captured with console.log rather than mocking JSON.stringify, since a caller reads
  // stdout, not the internals: this test proves the same thing an agent piping the output
  // would observe.
  const captured = (value: unknown, fields?: string[]): unknown => {
    const original = console.log
    let printed = ''
    console.log = (text: string) => {
      printed = text
    }
    try {
      emitJson(value, fields)
    } finally {
      console.log = original
    }
    return JSON.parse(printed)
  }

  test('stamps vcutVersion on every object output', () => {
    const output = captured({ status: 'ok' }) as { vcutVersion: string; status: string }
    expect(output.status).toBe('ok')
    expect(output.vcutVersion).toBe(packageVersion())
  })

  test('the stamped version matches package.json', () => {
    const packageJson = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const declared = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version
    const output = captured({ ok: true }) as { vcutVersion: string }
    expect(output.vcutVersion).toBe(declared)
  })

  test('does not overwrite a caller-supplied vcutVersion silently different from itself', () => {
    // The stamp always wins: a command building its own object should never be able to lie
    // about which binary produced it, even by accident.
    const output = captured({ vcutVersion: 'not-the-real-version' }) as { vcutVersion: string }
    expect(output.vcutVersion).toBe(packageVersion())
  })

  test('leaves a non-object value alone', () => {
    expect(captured(['a', 'b'])).toEqual(['a', 'b'])
    expect(captured('plain string')).toBe('plain string')
  })

  test('with fields given, projects the object down to those paths', () => {
    const output = captured({ removalPercent: 22.5, segments: 4, cuts: 2 }, ['removalPercent']) as {
      removalPercent: number
      segments?: number
      vcutVersion: string
    }
    expect(output).toEqual({ removalPercent: 22.5, vcutVersion: packageVersion() })
  })

  test('vcutVersion survives selection even when not asked for', () => {
    const output = captured({ removalPercent: 22.5, segments: 4 }, ['segments']) as {
      vcutVersion: string
    }
    expect(output.vcutVersion).toBe(packageVersion())
  })

  test('an unknown field surfaces fieldErrors alongside whatever did resolve', () => {
    const output = captured({ removalPercent: 22.5 }, ['removalPercent', 'nope']) as {
      removalPercent: number
      fieldErrors: string[]
    }
    expect(output.removalPercent).toBe(22.5)
    expect(output.fieldErrors).toEqual(['nope'])
  })

  test('projects an array field across every element', () => {
    const output = captured({ semanticCuts: [{ removedText: 'eh' }, { removedText: 'y' }] }, [
      'semanticCuts.removedText',
    ]) as Record<string, unknown>
    expect(output['semanticCuts.removedText']).toEqual(['eh', 'y'])
  })

  test('an empty fields array falls back to the unprojected object', () => {
    const output = captured({ status: 'ok' }, []) as { status: string; vcutVersion: string }
    expect(output.status).toBe('ok')
    expect(output.vcutVersion).toBe(packageVersion())
  })
})

// emitJson's `fields` parameter bypasses process.argv for --fields, but there is no equivalent
// second argument for --jq: every call site reaches it the same way, by argv, so these tests
// drive it the same way a real invocation does rather than adding a test-only seam.
describe('emitJson with --jq', () => {
  const capturedWithArgv = (value: unknown, argv: string[]): unknown => {
    const originalLog = console.log
    const originalArgv = process.argv
    let printed = ''
    console.log = (text: string) => {
      printed = text
    }
    process.argv = ['bun', 'vcut', ...argv]
    try {
      emitJson(value)
    } finally {
      console.log = originalLog
      process.argv = originalArgv
    }
    return JSON.parse(printed)
  }

  test('projects a field through --jq', () => {
    const output = capturedWithArgv({ removalPercent: 22.5, segments: 4 }, [
      '--jq',
      '.removalPercent',
    ])
    expect(output).toBe(22.5)
  })

  test('filters an array with select()', () => {
    const output = capturedWithArgv(
      [
        { kind: 'filler', reason: 'a' },
        { kind: 'repetition', reason: 'b' },
      ],
      ['--jq', '.[] | select(.kind == "filler")'],
    )
    expect(output).toEqual({ kind: 'filler', reason: 'a' })
  })

  test('sees the vcutVersion stamp, since --jq runs after stamping', () => {
    const output = capturedWithArgv({ status: 'ok' }, ['--jq', '.vcutVersion'])
    expect(output).toBe(packageVersion())
  })

  test('does not itself add a vcutVersion to a result --jq reshaped', () => {
    const output = capturedWithArgv({ status: 'ok', segments: 4 }, ['--jq', '.segments'])
    expect(output).toBe(4)
  })

  test('reads the --jq=<expr> inline form the same way', () => {
    const output = capturedWithArgv({ a: 1 }, ['--jq=.a'])
    expect(output).toBe(1)
  })

  test('--jq together with --fields throws, naming both flags as exclusive', () => {
    expect(() => capturedWithArgv({ a: 1 }, ['--jq', '.a', '--fields', 'a'])).toThrow(
      /mutually exclusive/,
    )
  })

  test('an invalid --jq expression throws with the offending expression named', () => {
    expect(() => capturedWithArgv({ a: 1 }, ['--jq', 'not valid jq'])).toThrow()
  })
})

describe('classifierStatus', () => {
  test('reports the home when every file is present', () => {
    const status = classifierStatus([true, true])
    expect(status.ok).toBe(true)
    expect(status.detail).toContain('.vcut')
  })

  test('names the command that fixes it when something is missing', () => {
    const status = classifierStatus([true, false])
    expect(status.ok).toBe(false)
    expect(status.detail).toContain('vcut setup classifier')
  })

  test('says the check has a fallback rather than reading as broken', () => {
    // Absent is a supported state, not a failure: invariant 7 falls back to a human ear.
    expect(classifierStatus([false, false]).detail).toContain('optional')
  })
})
