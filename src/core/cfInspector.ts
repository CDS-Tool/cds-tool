import { EventEmitter } from 'node:events'
import { inspectorConnect, sendCdpCommand } from './cdpClient'
import { CfError, cfSpawn, getShell } from './cfShell'
import { shellEscape } from './cfShell'

export const events = new EventEmitter()

interface InspectorSession {
  cdp: any
  appName: string
  breakpoints: Map<string, { url: string; line: number; condition?: string; logMessage?: string; cdpId?: string; hitCount?: number; hitCondition?: string }>
}

let sessions = new Map<string, InspectorSession>()

async function connectToApp(appName: string, org: string, space: string): Promise<InspectorSession> {
  const existing = sessions.get(appName)
  if (existing) return existing

  // 1. Enable inspector and get WS URL via SSH tunnel
  const shell = getShell()
  const targetCmd = org && space
    ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
    : ''

  // Find PID, send SIGUSR1, extract debug URL from stderr
  const findCmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "\\
    pid=\\\$(ps aux | grep 'node' | grep -v grep | head -1 | awk '{print \\\$2}'); \\
    if [ -n \\\"\\\$pid\\\" ]; then \\
      kill -USR1 \\\$pid 2>/dev/null; \\
      sleep 2; \\
      cat /proc/\\\$pid/fd/2 2>/dev/null | grep -oE 'ws://[^[:space:]]+' | head -1; \\
      ls -la /proc/\\\$pid/fd/ 2>/dev/null | head -20; \\
    fi"`

  const { execFileSync } = await import('node:child_process')
  let wsUrl: string | null = null

  try {
    const out = execFileSync(shell, ['-l', '-c', findCmd], { timeout: 20000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    const lines = (out as string).split('\n').map(l => l.trim()).filter(Boolean)
    wsUrl = lines.find(l => l.startsWith('ws://')) ?? null
  } catch {}

  if (!wsUrl) {
    // Fallback: try forwarding port via SSH tunnel
    wsUrl = await tunnelInspectorPort(appName, org, space)
  }
  if (!wsUrl) throw new Error(`Could not connect inspector to ${appName}`)

  // 2. Connect CDP
  const cdp = await inspectorConnect(wsUrl)

  // 3. Enable necessary domains
  await sendCdpCommand(cdp, 'Debugger.enable')
  await sendCdpCommand(cdp, 'Runtime.enable')
  await sendCdpCommand(cdp, 'Runtime.runIfWaitingForDebugger')

  // 4. Forward CDP events
  cdp.on('message', (msg: string) => {
    try {
      const parsed = JSON.parse(msg)
      if (parsed.method === 'Debugger.paused') {
        const callFrames = parsed.params?.callFrames || []
        const topFrame = callFrames[0]
        const stack = callFrames.map((f: any) =>
          `${f.functionName || '(anonymous)'} at ${f.url}:${f.lineNumber}:${f.columnNumber}`
        )
        const url = topFrame?.url || ''
        const line = topFrame?.lineNumber || 0

        // Check if this is a logpoint
        const bp = findBreakpoint(appName, url, line)
        if (bp?.logMessage) {
          // Logpoint: evaluate message, log it, continue
          evaluateLogpoint(cdp, bp.logMessage, callFrames, appName)
          sendCdpCommand(cdp, 'Debugger.resume').catch(() => {})
          return
        }

        // Hit-count tracking
        if (bp) {
          bp.hitCount = (bp.hitCount || 0) + 1
          if (bp.hitCondition) {
            const match = bp.hitCondition.match(/^([><=!]+)\s*(\d+)$/)
            if (match) {
              const op = match[1]; const val = parseInt(match[2], 10)
              const hit = bp.hitCount
              const shouldPause = (
                (op === '>=' && hit >= val) || (op === '>' && hit > val) ||
                (op === '<=' && hit <= val) || (op === '<' && hit < val) ||
                (op === '==' && hit === val) || (op === '!=' && hit !== val) ||
                (op === '===' && hit === val)
              )
              if (!shouldPause) {
                sendCdpCommand(cdp, 'Debugger.resume').catch(() => {})
                return
              }
            }
          }
        }

        events.emit('breakpoint', appName, {
          url, line, stack, timestamp: Date.now(), hitCount: bp?.hitCount,
        })
      }
      if (parsed.method === 'Debugger.scriptParsed') {
        events.emit('scriptParsed', appName, parsed.params)
      }
    } catch {}
  })

  const session: InspectorSession = { cdp, appName, breakpoints: new Map() }
  sessions.set(appName, session)
  return session
}

function findBreakpoint(appName: string, url: string, line: number): InspectorSession['breakpoints'] extends Map<string, infer V> ? V : never {
  const session = sessions.get(appName)
  if (!session) return undefined as any
  for (const [, bp] of session.breakpoints) {
    if (bp.url === url && bp.line === line) return bp as any
  }
  return undefined as any
}

async function evaluateLogpoint(cdp: any, message: string, callFrames: any[], appName: string) {
  // Replace {expr} with evaluated expression values
  const exprMatch = message.match(/\{([^}]+)\}/g)
  if (exprMatch) {
    for (const match of exprMatch) {
      const expr = match.slice(1, -1)
      try {
        const result = await sendCdpCommand(cdp, 'Runtime.evaluate', {
          expression: expr,
          callFrameId: callFrames[0]?.callFrameId,
          includeCommandLineAPI: true,
        })
        const value = result?.result?.value ?? result?.result?.description ?? 'undefined'
        message = message.replace(match, String(value))
      } catch {
        message = message.replace(match, '<error>')
      }
    }
  }
  events.emit('logpoint', sessions.get(appName)?.appName || appName, message)
}

async function tunnelInspectorPort(appName: string, org: string, space: string): Promise<string | null> {
  // Find an accessible port on the app
  const shell = getShell()
  const targetCmd = org && space
    ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
    : ''
  
  const portScanCmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "\\
    for port in 9229 9230 9231 9232; do \\
      ss -tlnp 2>/dev/null | grep -q \\\":\\\$port \\\" && echo \\\$port; \\
    done"`

  try {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(shell, ['-l', '-c', portScanCmd], { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    const port = (out as string).split('\n').map(l => l.trim()).find(l => /^\d+$/.test(l))
    if (port) {
      return `ws://127.0.0.1:${port}`
    }
  } catch {}
  return null
}

export async function setBreakpoint(
  appName: string, org: string, space: string,
  url: string, line: number,
  condition?: string, logMessage?: string,
  hitCondition?: string,
): Promise<string> {
  const session = await connectToApp(appName, org, space)
  
  const params: any = { url, lineNumber: line }
  if (condition) params.condition = condition

  const result = await sendCdpCommand(session.cdp, 'Debugger.setBreakpointByUrl', params)
  const bpId = `bp_${appName}_${url}_${line}_${Date.now()}`
  
  session.breakpoints.set(bpId, { url, line, condition, logMessage, hitCondition, cdpId: result?.breakpointId })
  events.emit('breakpointSet', appName, { breakpointId: bpId, url, line })
  return bpId
}

export async function setExceptionBreakpoint(appName: string, org: string, space: string): Promise<void> {
  const session = await connectToApp(appName, org, space)
  await sendCdpCommand(session.cdp, 'Debugger.setPauseOnExceptions', { state: 'all' })
  events.emit('exceptionBreakpointSet', appName)
}

export async function removeExceptionBreakpoint(appName: string): Promise<void> {
  const session = sessions.get(appName)
  if (!session) return
  await sendCdpCommand(session.cdp, 'Debugger.setPauseOnExceptions', { state: 'none' })
}

export async function removeBreakpoint(appName: string, breakpointId: string): Promise<void> {
  const session = sessions.get(appName)
  if (!session) return
  
  const bp = session.breakpoints.get(breakpointId)
  if (bp?.cdpId) {
    try {
      await sendCdpCommand(session.cdp, 'Debugger.removeBreakpoint', { breakpointId: bp.cdpId })
    } catch {}
  }
  session.breakpoints.delete(breakpointId)
  events.emit('breakpointRemoved', breakpointId)
}

export async function getStack(appName: string): Promise<string[]> {
  const session = sessions.get(appName)
  if (!session) throw new Error('No active inspector session for ' + appName)
  
  const result = await sendCdpCommand(session.cdp, 'Debugger.getStackTrace', {})
  const frames = result?.stackTrace?.callFrames || []
  return frames.map((f: any) =>
    `${f.functionName || '(anonymous)'} at ${f.url}:${f.lineNumber}:${f.columnNumber}`
  )
}

export async function evaluate(appName: string, expression: string): Promise<any> {
  const session = sessions.get(appName)
  if (!session) throw new Error('No active inspector session for ' + appName)
  
  const result = await sendCdpCommand(session.cdp, 'Runtime.evaluate', {
    expression,
    includeCommandLineAPI: true,
  })
  return result?.result
}

export function listBreakpoints(appName: string): { id: string; url: string; line: number; condition?: string; logMessage?: string; hitCondition?: string; hitCount?: number }[] {
  const session = sessions.get(appName)
  if (!session) return []
  return Array.from(session.breakpoints.entries()).map(([id, bp]) => ({ id, ...bp }))
}

export function disconnectInspector(appName: string): void {
  const session = sessions.get(appName)
  if (session) {
    session.cdp.close()
    sessions.delete(appName)
  }
}

export function disconnectAll(): void {
  for (const [app] of sessions) disconnectInspector(app)
}
