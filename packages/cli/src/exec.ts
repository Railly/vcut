import { spawn } from 'node:child_process'

export type RunResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export const run = (command: string, args: string[]): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} not found on PATH. Install it and try again.`)
          : error,
      )
    })
    child.on('close', (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 })
    })
  })

export const runInherit = (command: string, args: string[]): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} not found on PATH. Install it and try again.`)
          : error,
      )
    })
    child.on('close', (code) => {
      resolve(code ?? 0)
    })
  })

// A long-running command's stderr split into whole lines as they arrive, so a caller can watch
// it work instead of staring at a process that prints nothing until it exits. stderr is piped
// rather than inherited so the caller decides what happens to each line — printing it straight
// through is the common case, but nothing here assumes that is the only one.
export const runWithProgress = (
  command: string,
  args: string[],
  onStderrLine: (line: string) => void,
): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'pipe'] })
    let buffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        onStderrLine(line)
      }
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} not found on PATH. Install it and try again.`)
          : error,
      )
    })
    child.on('close', (code) => {
      if (buffer.length > 0) {
        onStderrLine(buffer)
      }
      resolve(code ?? 0)
    })
  })
