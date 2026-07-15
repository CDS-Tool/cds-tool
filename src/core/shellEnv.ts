import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)

let _cachedShellEnv: Record<string, string> | null = null

export async function readLoginShellEnv(): Promise<Record<string, string>> {
  if (_cachedShellEnv) return _cachedShellEnv
  if (process.platform === 'win32') return {}

  const shell = process.env.SHELL || '/bin/zsh'
  const isFish = shell.endsWith('fish')
  const args = ['-l', '-c', 'env']

  try {
    const { stdout } = await execAsync(shell, args, { timeout: 10000 })
    const parsed: Record<string, string> = {}
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) parsed[line.slice(0, idx)] = line.slice(idx + 1)
    }
    _cachedShellEnv = parsed
    return parsed
  } catch {
    return {}
  }
}

export async function getCredentials(): Promise<{ email: string; password: string }> {
  // Priority 1: process.env
  const e1 = process.env.SAP_EMAIL
  const p1 = process.env.SAP_PASSWORD
  if (e1 && p1) return { email: e1, password: p1 }

  // Priority 2: login shell env (covers macOS dock/spotlight launch)
  const shellEnv = await readLoginShellEnv()
  if (shellEnv.SAP_EMAIL && shellEnv.SAP_PASSWORD) {
    return { email: shellEnv.SAP_EMAIL, password: shellEnv.SAP_PASSWORD }
  }

  return { email: '', password: '' }
}

export function clearShellEnvCache(): void {
  _cachedShellEnv = null
}
