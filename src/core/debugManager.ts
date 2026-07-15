import * as vscode from 'vscode'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { cfSshSignal, cfEnableSsh, cfRestart, cfTarget } from './cfClient'

const DEBUG_PREFIX = 'Debug: '
const BASE_PORT = 9229
const MAX_RETRIES = 3
const PROBE_TIMEOUT = 60000

const processes = new Map<string, ChildProcess>()
const ports = new Map<string, number>()
const channels = new Map<string, vscode.OutputChannel>()
const sessionStatus = new Map<string, string>()
export const events = new EventEmitter()

let portCounter = 0

function nextPort(): number {
  portCounter++
  return BASE_PORT + portCounter - 1
}

function killProc(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGTERM'); return } catch { /* fallback */ }
  }
  try { child.kill('SIGTERM') } catch { child.kill() }
}

export function getActiveSessions(): string[] {
  return Array.from(sessionStatus.keys())
}

export function getSessionStatus(app: string): string | undefined {
  return sessionStatus.get(app)
}

export function getDebugPort(app: string): number | undefined {
  return ports.get(app)
}

export async function startDebugSession(
  appName: string,
  org: string,
  space: string
): Promise<void> {
  if (sessionStatus.has(appName)) {
    throw new Error(`Already debugging ${appName}`)
  }

  let channel = channels.get(appName)
  if (!channel) {
    channel = vscode.window.createOutputChannel(`CDS Debug: ${appName}`)
    channels.set(appName, channel)
  }
  channel.clear()
  channel.appendLine(`[CDS Tool] Starting debug for ${appName}...`)

  const port = nextPort()
  ports.set(appName, port)
  sessionStatus.set(appName, 'SIGNALING')
  emitStatus(appName, 'SIGNALING')

  const remoteRoot = vscode.workspace.getConfiguration('cdsTool').get('remoteRoot', '/home/vcap/app')
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
  const configName = `${DEBUG_PREFIX}${appName}`
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]

  channel.appendLine(`[CDS Tool] Targeting ${org}/${space}...`)
  await cfTarget(org, space)

  channel.appendLine(`[CDS Tool] Activating Node inspector on ${appName}...`)
  const signaled = await signalInspector(appName, channel)
  if (!signaled) {
    sessionStatus.delete(appName)
    ports.delete(appName)
    emitStatus(appName, 'ERROR')
    throw new Error(`Failed to activate Node inspector on ${appName}. Enable SSH first.`)
  }

  await sleep(800)
  if (!sessionStatus.has(appName)) return

  const tunnelArg = `${port}:localhost:9229`
  channel.appendLine(`[CDS Tool] Opening SSH tunnel: cf ssh ${appName} -L ${tunnelArg}`)
  sessionStatus.set(appName, 'TUNNELING')
  emitStatus(appName, 'TUNNELING')

  const child = spawn('cf', ['ssh', appName, '-L', tunnelArg, '-N'], {
    cwd: folder,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  processes.set(appName, child)

  child.stderr?.on('data', (d: Buffer) => {
    channel?.append(d.toString())
  })

  let closeHandler: ((code: number | null) => void) | null = null
  closeHandler = (code) => {
    channel?.appendLine(`\n[CDS Tool] Tunnel exited (code: ${code ?? 'null'})`)
    if (processes.get(appName) === child) processes.delete(appName)
    if (sessionStatus.has(appName)) {
      sessionStatus.delete(appName)
      emitStatus(appName, 'EXITED')
    }
  }
  child.on('close', closeHandler)

  child.on('error', (err) => {
    channel?.appendLine(`\n[CDS Tool] Tunnel error: ${err.message}`)
    sessionStatus.set(appName, 'ERROR')
    emitStatus(appName, 'ERROR')
  })

  const ready = await probePort(port, PROBE_TIMEOUT)
  if (!ready) {
    killProc(child)
    processes.delete(appName)
    ports.delete(appName)
    sessionStatus.delete(appName)
    emitStatus(appName, 'ERROR')
    throw new Error(`Inspector not ready on port ${port} within ${PROBE_TIMEOUT / 1000}s`)
  }

  channel.appendLine(`[CDS Tool] Tunnel ready on port ${port}. Attaching debugger...`)

  const launchConfig = {
    type: 'node',
    request: 'attach',
    name: configName,
    address: '127.0.0.1',
    port,
    localRoot: folder,
    remoteRoot,
    sourceMaps: true,
    skipFiles: ['<node_internals>/**'],
    outFiles: [
      `${folder}/srv/**/*.{js,cjs,mjs}`,
      `${folder}/gen/srv/**/*.{js,cjs,mjs}`,
      `${folder}/app/**/*.{js,cjs,mjs}`,
    ],
    resolveSourceMapLocations: null,
    autoAttachChildProcesses: true,
  }

  await writeLaunchConfig(workspaceFolder?.uri.fsPath ?? '', [launchConfig])

  const success = await vscode.debug.startDebugging(workspaceFolder, configName, {
    suppressSaveBeforeStart: true,
  })

  if (success) {
    sessionStatus.set(appName, 'ATTACHED')
    emitStatus(appName, 'ATTACHED')
    vscode.window.showInformationMessage(`Debugger attached to ${appName}:${port}`)
  } else {
    sessionStatus.set(appName, 'ERROR')
    emitStatus(appName, 'ERROR')
  }
}

async function signalInspector(appName: string, ch: vscode.OutputChannel): Promise<boolean> {
  // Try multiple strategies to signal Node inspector
  const cmds = [
    `kill -USR1 $(pidof node 2>/dev/null | awk '{print $NF}') 2>/dev/null; kill -USR1 1 2>/dev/null; echo ok`,
    'kill -USR1 1',
  ]

  for (const cmd of cmds) {
    ch.appendLine(`[CDS Tool] Trying: cf ssh ${appName} -c "${cmd}"`)
    const result = await cfSshSignal(appName, cmd)

    if (result.stderr.toLowerCase().includes('ssh support is disabled')) {
      ch.appendLine('[CDS Tool] SSH disabled. Enabling...')
      try {
        await cfEnableSsh(appName)
        ch.appendLine('[CDS Tool] SSH enabled. Restarting app...')
        await cfRestart(appName)
        ch.appendLine('[CDS Tool] Waiting 20s for restart...')
        await sleep(20000)
        // Retry after restart
        const retry = await cfSshSignal(appName, 'kill -USR1 1')
        return retry.code === 0
      } catch (err: any) {
        ch.appendLine(`[CDS Tool] SSH enable/restart failed: ${err.message}`)
        return false
      }
    }

    if (result.code === 0) return true
  }

  return false
}

async function writeLaunchConfig(workspacePath: string, configs: any[]): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  if (!workspacePath) return
  const launchPath = path.join(workspacePath, '.vscode', 'launch.json')
  let existing: any = { version: '0.2.0', configurations: [] }
  try {
    existing = JSON.parse(await fs.readFile(launchPath, 'utf8'))
  } catch { /* file doesn't exist */ }
  const newNames = new Set(configs.map((c: any) => c.name))
  existing.configurations = [
    ...existing.configurations.filter((c: any) => !newNames.has(c.name)),
    ...configs,
  ]
  await fs.mkdir(path.dirname(launchPath), { recursive: true })
  await fs.writeFile(launchPath, JSON.stringify(existing, null, 2) + '\n')
}

export async function stopDebugSession(appName: string): Promise<void> {
  sessionStatus.delete(appName)
  emitStatus(appName, 'EXITED')

  const child = processes.get(appName)
  if (child) {
    killProc(child)
    processes.delete(appName)
  }

  for (const s of vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : []) {
    if (s.name === `${DEBUG_PREFIX}${appName}`) {
      vscode.debug.stopDebugging(s)
    }
  }

  ports.delete(appName)

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (ws) {
    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const launchPath = path.join(ws, '.vscode', 'launch.json')
      const raw = await fs.readFile(launchPath, 'utf8')
      const json = JSON.parse(raw)
      json.configurations = json.configurations.filter((c: any) => c.name !== `${DEBUG_PREFIX}${appName}`)
      await fs.writeFile(launchPath, JSON.stringify(json, null, 2) + '\n')
    } catch { /* ignore */ }
  }
}

export async function stopAllDebugSessions(): Promise<void> {
  const apps = Array.from(sessionStatus.keys())
  await Promise.allSettled(apps.map(a => stopDebugSession(a)))
  for (const ch of channels.values()) ch.dispose()
  channels.clear()
}

async function probePort(port: number, timeout: number): Promise<boolean> {
  const net = await import('node:net')
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        const sock = new net.Socket()
        sock.setTimeout(2000)
        sock.once('connect', () => { sock.destroy(); resolve(true) })
        sock.once('error', () => { sock.destroy(); resolve(false) })
        sock.once('timeout', () => { sock.destroy(); resolve(false) })
        sock.connect(port, '127.0.0.1')
      })
      if (result) return true
      await sleep(500)
    } catch {
      await sleep(500)
    }
  }
  return false
}

function emitStatus(appName: string, status: string): void {
  events.emit('status', appName, status)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export function disposeDebugManager(): void {
  for (const child of processes.values()) killProc(child)
  processes.clear()
  ports.clear()
  sessionStatus.clear()
  for (const ch of channels.values()) ch.dispose()
  channels.clear()
}
