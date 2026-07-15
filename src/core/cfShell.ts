import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_BUF = 10 * 1024 * 1024

export function shellEscape(a: string): string {
  return `'${a.replace(/'/g, "'\\''")}'`
}

export function shellCmd(cmd: string, args: string[]): string {
  return cmd + ' ' + args.map(shellEscape).join(' ')
}

export function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

export async function cf(args: string[], timeout = 60000): Promise<string> {
  const shell = getShell()
  const fullCmd = shellCmd('cf', args)
  try {
    const { stdout } = await execFileAsync(shell, ['-l', '-c', fullCmd], { maxBuffer: MAX_BUF, timeout })
    return stdout as string
  } catch (err: any) {
    const stderr = err.stderr?.trim() ?? ''
    throw new CfError(err.message, stderr)
  }
}

export class CfError extends Error {
  constructor(msg: string, public stderr: string) {
    super(msg)
    this.name = 'CfError'
  }
}

export function cfSpawn(args: string[], opts?: { timeout?: number }): ReturnType<typeof spawn> {
  const shell = getShell()
  const fullCmd = shellCmd('cf', args)
  return spawn(shell, ['-l', '-c', fullCmd], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts?.timeout,
  })
}
