import { run } from './exec.ts'

// Whether a command is actually on PATH, the same question doctor and init already ask
// (trx --version, ffmpeg -version) before deciding what to install or report missing. Its own
// file rather than living in cli.ts so a module transcribe-window.ts can import it without
// cli.ts importing peek.ts importing transcribe-window.ts importing cli.ts back.
export const has = async (command: string, args: string[]): Promise<boolean> => {
  try {
    const { exitCode } = await run(command, args)
    return exitCode === 0
  } catch {
    return false
  }
}
