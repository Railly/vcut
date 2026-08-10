import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/cli.ts'

// 0.4.1 shipped to npm with VERSION still reading '0.4.0', so the published binary reported a
// version it was not, and `vcut --version` was no longer evidence of what was installed. The
// release bumps package.json alone, which makes any second copy of the number a thing that
// drifts the moment nobody looks.
describe('VERSION', () => {
  test('matches the version the release actually publishes', () => {
    const packageJson = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    const declared = (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version
    expect(VERSION).toBe(declared)
  })

  test('resolves to a real version rather than the not-found fallback', () => {
    expect(VERSION).not.toBe('unknown')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
