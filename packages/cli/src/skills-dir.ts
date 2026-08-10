import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Split out of cli.ts so a command module (nonspeech.ts needs this to find
// skills/core/scripts/non-speech.py) can resolve the skills directory without importing the
// router itself, which runs `route(process.argv.slice(2))` at module load.
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
