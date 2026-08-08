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
