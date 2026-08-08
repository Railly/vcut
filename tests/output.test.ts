import { describe, expect, test } from 'bun:test'
import { matchTarget } from '../src/build-edl.ts'
import { bar, duration, resolveMode } from '../src/output.ts'

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
