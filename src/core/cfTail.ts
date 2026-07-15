import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'

let tailProcesses = new Map<string, ReturnType<typeof spawn>>()
export const events = new EventEmitter()
let _log: ((type: string, msg: string) => void) | undefined

export function initTailLogger(logFn: (type: string, msg: string) => void): void {
  _log = logFn
}

function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

function shellEscape(a: string): string {
  return `'${a.replace(/'/g, "'\\''")}'`
}

export function startTailSession(appNames: string[], org?: string, space?: string): void {
  for (const app of appNames) {
    if (tailProcesses.has(app)) continue

    const shell = getShell()
    const targetCmd = org && space
      ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
      : ''
    const cmd = `${targetCmd}cf logs ${shellEscape(app)} --recent && cf logs ${shellEscape(app)}`
    const child = spawn(shell, ['-l', '-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
    tailProcesses.set(app, child)

    let buffer = ''
    child.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim()) {
          events.emit('line', app, line)
        }
      }
    })

    child.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim()
      if (msg) events.emit('line', app, `[cf] ${msg}`)
    })

    child.on('error', (err) => {
      events.emit('line', app, `[ERROR] ${err.message}`)
      tailProcesses.delete(app)
    })

    child.on('exit', (code) => {
      events.emit('line', app, `[EXIT] code ${code}`)
      tailProcesses.delete(app)
    })

    _log?.('info', `Tail started for ${app}`)
  }
}

export function stopTailSession(appName: string): void {
  const child = tailProcesses.get(appName)
  if (child) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
    }
    tailProcesses.delete(appName)
    _log?.('info', `Tail stopped for ${appName}`)
  }
}

export function stopAllTailSessions(): void {
  for (const [app] of tailProcesses) stopTailSession(app)
}

export function getTailSessions(): string[] {
  return Array.from(tailProcesses.keys())
}
