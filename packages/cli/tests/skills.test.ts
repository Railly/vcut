import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORE_SECTIONS, parseSection, sectionPath, skillsDir } from '../src/cli.ts'
import { positional } from '../src/detect.ts'
import { UsageError } from '../src/output.ts'

describe('parseSection', () => {
  test('reads --section <name>', () => {
    expect(parseSection(['core', '--section', 'cut'])).toBe('cut')
  })

  test('reads --section=<name>', () => {
    expect(parseSection(['core', '--section=invariants'])).toBe('invariants')
  })

  test('is absent when the flag is not passed', () => {
    expect(parseSection(['core'])).toBeUndefined()
    expect(parseSection([])).toBeUndefined()
  })

  // A bare --section is a caller who meant to name one, so guessing a default would serve a
  // document they did not ask for. The message names the flag and where the list lives.
  test('a bare --section is a usage error naming the flag and how to list sections', () => {
    expect(() => parseSection(['core', '--section'])).toThrow(UsageError)
    try {
      parseSection(['core', '--section'])
      throw new Error('expected parseSection to throw')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('--section')
      expect(message).toContain('vcut skills list')
    }
  })

  test('--section followed by another flag is a usage error, not a section named --human', () => {
    expect(() => parseSection(['core', '--section', '--human'])).toThrow(UsageError)
  })

  test('an empty --section= is a usage error rather than an empty section name', () => {
    expect(() => parseSection(['core', '--section='])).toThrow(UsageError)
  })
})

// The section value must not be read as the skill name. `skills get --section cut` names no
// skill, so it has to fall through to the `core` default rather than resolving a skill called
// "cut" that does not exist.
describe('a section value is not the skill name', () => {
  test('--section <name> leaves no positional behind', () => {
    expect(positional(['--section', 'cut'])).toBeUndefined()
  })

  test('an explicit skill name still wins', () => {
    expect(positional(['core', '--section', 'cut'])).toBe('core')
  })
})

describe('CORE_SECTIONS', () => {
  const directory = skillsDir()

  // The registry is what `skills list` advertises and what a bad-section error names. A row
  // pointing at a file that does not exist would advertise a section `get --section` then
  // refuses, which is the one failure this table can have.
  test('every registered section has a file on disk', () => {
    for (const section of CORE_SECTIONS) {
      const file = sectionPath(directory, 'core', section.name)
      expect(existsSync(file)).toBe(true)
    }
  })

  test('every section file on disk is registered', () => {
    const dir = join(directory, 'core', 'sections')
    const onDisk = existsSync(dir)
      ? new Bun.Glob('*.md')
          .scanSync({ cwd: dir })
          .toArray()
          .map((name) => name.replace(/\.md$/, ''))
      : []
    const registered = new Set(CORE_SECTIONS.map((section) => section.name))
    for (const name of onDisk) {
      expect(registered.has(name)).toBe(true)
    }
  })

  test('section names are unique', () => {
    const names = CORE_SECTIONS.map((section) => section.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every section carries a blurb, since a bare name does not say what it answers', () => {
    for (const section of CORE_SECTIONS) {
      expect(section.reads.length).toBeGreaterThan(0)
    }
  })

  test('no section file is empty', () => {
    for (const section of CORE_SECTIONS) {
      const body = readFileSync(sectionPath(directory, 'core', section.name), 'utf8')
      expect(body.trim().length).toBeGreaterThan(0)
    }
  })
})

// The whole point of #28: `skills get core` without --section is what an agent loads every
// session, so it has to stay small. The old manual was ~130KB read across three calls; a
// regression here is the fixed token tax coming back, and it comes back silently.
describe('the always-loaded core stays small', () => {
  const core = readFileSync(join(skillsDir(), 'core', 'SKILL.md'), 'utf8')

  test('is a fraction of the size the sections add up to', () => {
    const sections = CORE_SECTIONS.map((section) =>
      readFileSync(sectionPath(skillsDir(), 'core', section.name), 'utf8'),
    ).join('')
    expect(core.length).toBeLessThan(sections.length / 3)
  })

  test('fits in a single read rather than needing three', () => {
    expect(core.length).toBeLessThan(40_000)
  })

  // The issue's own constraint: the session verbs and their bridges have to stay in the part
  // that is always loaded, because burying them deeper is what made the stateless pipeline win.
  test('carries the session verbs', () => {
    for (const verb of ['vcut open', 'vcut peek', 'vcut cut', 'vcut commit', 'vcut rounds']) {
      expect(core).toContain(verb)
    }
  })

  test('carries the bridges every coordinate system needs to reach a cut', () => {
    expect(core).toContain('nearestRef')
    expect(core).toContain('--start-ms')
    expect(core).toContain('--end-ms')
    expect(core).toContain('--span')
    expect(core).toContain('--refs')
  })

  test('carries the approval boundary', () => {
    expect(core).toContain('approval.status')
    expect(core).toContain('There is no approve command')
  })

  test('carries the presets', () => {
    for (const preset of ['noisy', 'clean', 'podcast']) {
      expect(core).toContain(preset)
    }
  })

  test('labels the stateless pipeline as an escape hatch rather than an equal option', () => {
    expect(core).toContain('escape hatch')
    expect(core).toContain('When you actually need this')
  })

  test('states that reading the session directory directly is unsupported', () => {
    expect(core).toContain('~/.vcut/sessions/')
    expect(core).toContain('unsupported')
  })

  // Each of these is a round an agent otherwise spends hand-rolling something the CLI does.
  test('carries the anti-friction facts from the merged wave', () => {
    expect(core).toContain('--jq')
    expect(core).toContain('semantic merge')
    expect(core).toContain('--report-json')
    expect(core).toContain('--audio-only')
    expect(core).toContain('--quiet')
  })

  test('points at the section command rather than assuming the reader has the whole manual', () => {
    expect(core).toContain('vcut skills get core --section')
  })
})
