import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { CfApp } from '../types'

const execFileAsync = promisify(execFile)
const MAX_BUF = 10 * 1024 * 1024

function shellEscape(a: string): string {
  return `'${a.replace(/'/g, "'\\''")}'`
}

function shellCmd(cmd: string, args: string[]): string {
  return cmd + ' ' + args.map(shellEscape).join(' ')
}

function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

async function cf(args: string[], timeout = 60000): Promise<string> {
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

export async function cfLogin(api: string, email: string, pw: string): Promise<void> {
  await cf(['api', api])
  await cf(['auth', email, pw])
}

export async function cfOrgs(): Promise<string[]> {
  const out = await cf(['orgs'])
  const lines = out.split('\n')
  const idx = lines.findIndex(l => l.trim() === 'name')
  return idx >= 0
    ? lines.slice(idx + 1).map(l => l.trim()).filter(Boolean)
    : []
}

export async function cfTargetOrg(org: string): Promise<void> {
  await cf(['target', '-o', org])
}

export async function cfTarget(org: string, space: string): Promise<void> {
  await cf(['target', '-o', org, '-s', space])
}

export async function cfSpaces(org: string): Promise<string[]> {
  await cf(['target', '-o', org])
  const out = await cf(['spaces'])
  const lines = out.split('\n')
  const idx = lines.findIndex(l => l.trim() === 'name')
  return idx >= 0
    ? lines.slice(idx + 1).map(l => l.trim()).filter(Boolean)
    : []
}

export function parseCfAppsTable(stdout: string): CfApp[] {
  const lines = stdout.split('\n')
  const hdr = lines.findIndex(l => l.includes('requested state'))
  if (hdr < 0) return []

  return lines.slice(hdr + 1).map(l => l.trim()).filter(Boolean).flatMap(l => {
    const parts = l.split(/\s{2,}/)
    const name = parts[0]?.trim()
    const stateRaw = parts[1]?.trim()
    if (!name || !stateRaw) return []

    const instanceStr = parts[2]?.trim() ?? ''
    const instanceMatch = instanceStr.match(/(\d+)\/(\d+)/)
    const runningInstances = instanceMatch ? parseInt(instanceMatch[1], 10) : 0

    let urls: string[] = []
    if (parts.length > 4) {
      const routePart = parts.slice(4).join(' ').trim()
      if (routePart) {
        urls = routePart.split(',').map(u => u.trim()).filter(Boolean)
      }
    }

    let state: CfApp['state'] = 'stopped'
    if (stateRaw === 'started') {
      state = runningInstances > 0 ? 'started' : 'empty'
    }

    return [{ name, state, urls }]
  })
}

export async function cfApps(org: string, space: string): Promise<CfApp[]> {
  await cf(['target', '-o', org, '-s', space])
  const out = await cf(['apps'])
  return parseCfAppsTable(out)
}

export async function cfEnv(app: string): Promise<string> {
  return cf(['env', app])
}

export async function cfLogout(): Promise<void> {
  await cf(['logout']).catch(() => {})
}

export function parseVCAPServices(raw: string): Record<string, any> | null {
  const lines = raw.split('\n')
  const startIdx = lines.findIndex(l => l.trim().startsWith('VCAP_SERVICES'))
  if (startIdx < 0) return null

  let braceIdx = startIdx
  while (braceIdx < lines.length && !lines[braceIdx].includes('{')) {
    braceIdx++
  }
  if (braceIdx >= lines.length) return null

  let depth = 0
  let inString = false
  let escape = false
  let jsonStr = ''

  for (let i = braceIdx; i < lines.length; i++) {
    const line = lines[i]
    for (const ch of line) {
      if (escape) {
        jsonStr += ch
        escape = false
        continue
      }
      if (ch === '\\' && inString) {
        jsonStr += ch
        escape = true
        continue
      }
      if (ch === '"') {
        inString = !inString
        jsonStr += ch
        continue
      }
      if (!inString) {
        if (ch === '{') depth++
        if (ch === '}') depth--
      }
      jsonStr += ch
      if (!inString && depth === 0) {
        try {
          return JSON.parse(jsonStr)
        } catch {
          return null
        }
      }
    }
    if (i < lines.length - 1) jsonStr += '\n'
  }

  return null
}

export function extractHanaCreds(vcap: Record<string, any>): {
  host: string; port: number; database: string; user: string; password: string; schema?: string
} | null {
  for (const key of Object.keys(vcap)) {
    const entries = vcap[key]
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (!e.credentials) continue
      const c = e.credentials
      if (c.host && c.port && (c.database || c.dbname)) {
        return {
          host: c.host,
          port: typeof c.port === 'number' ? c.port : parseInt(String(c.port), 10),
          database: c.database || c.dbname,
          user: c.user || c.username,
          password: c.password,
          schema: c.schema,
        }
      }
    }
  }
  return null
}

export async function cfSshEnabled(app: string): Promise<boolean> {
  try {
    const out = await cf(['ssh-enabled', app])
    return out.toLowerCase().includes('ssh support is enabled')
  } catch {
    return false
  }
}

export async function cfEnableSsh(app: string): Promise<void> {
  await cf(['enable-ssh', app])
}

export async function cfRestart(app: string): Promise<void> {
  await cf(['restart', app], 120000)
}

export function cfSshSignal(app: string, cmd: string): Promise<{ code: number | null; stderr: string }> {
  const shell = getShell()
  const fullCmd = shellCmd('cf', ['ssh', app, '-c', cmd])
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-l', '-c', fullCmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', (code) => resolve({ code, stderr }))
    child.on('error', reject)
  })
}
