import { EventEmitter } from 'node:events'
import { netConnect, inspectorConnect, sendCdpCommand } from './cdpClient'
import { cf, CfError, cfSpawn, getShell } from './cfShell'
import { shellEscape } from './cfShell'

export const events = new EventEmitter()

let activeTraces = new Map<string, { disconnect: () => void }>()

const TRACE_HOOK_CODE = `
const http = require('http');
const https = require('https');
const origCreateServer = http.createServer;
const origHttpsCreateServer = https.createServer;
const origRequest = http.request;
const origHttpsRequest = https.request;

function wrapServer(server, isHttps) {
  const origEmit = server.emit.bind(server);
  server.emit = function(type, req, res) {
    if (type === 'request' && req) {
      const start = Date.now();
      const chunks = [];
      const origEnd = res.end.bind(res);
      res.end = function(chunk) {
        const duration = Date.now() - start;
        const trace = JSON.stringify({
          type: 'http',
          method: req.method,
          url: req.url,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['authorization','cookie','x-csrf-token'].includes(k))),
          status: res.statusCode,
          duration: duration,
          timestamp: new Date().toISOString(),
        });
        process.stdout.write('__CDS_TRACE__' + trace + '\\n');
        return origEnd.apply(this, arguments);
      };
    }
    return origEmit.apply(this, arguments);
  };
  return server;
}

http.createServer = function() {
  const server = origCreateServer.apply(this, arguments);
  return wrapServer(server, false);
};

https.createServer = function() {
  const server = origHttpsCreateServer.apply(this, arguments);
  return wrapServer(server, true);
};
`

export async function startTrace(appName: string, org: string, space: string): Promise<void> {
  if (activeTraces.has(appName)) return

  // 1. Enable inspector and get WebSocket URL
  const wsUrl = await enableInspectorRemote(appName, org, space)
  if (!wsUrl) throw new Error('Could not enable inspector on ' + appName)

  // 2. Connect to inspector
  const cdp = await inspectorConnect(wsUrl)
  
  // 3. Inject trace hook
  await sendCdpCommand(cdp, 'Runtime.evaluate', {
    expression: TRACE_HOOK_CODE,
    includeCommandLineAPI: true,
  })

  // 4. Subscribe to console output for trace data
  await sendCdpCommand(cdp, 'Runtime.enable')
  cdp.on('message', (msg: string) => {
    try {
      const parsed = JSON.parse(msg)
      if (parsed.method === 'Runtime.consoleAPICalled') {
        const args = parsed.params?.args || []
        for (const arg of args) {
          const text = arg.value
          if (typeof text === 'string' && text.includes('__CDS_TRACE__')) {
            const json = text.replace('__CDS_TRACE__', '')
            const trace = JSON.parse(json)
            events.emit('trace', appName, trace)
          }
        }
      }
    } catch {}
  })

  activeTraces.set(appName, {
    disconnect: () => cdp.close(),
  })
  
  events.emit('status', appName, true)
}

export function stopTrace(appName: string): void {
  const trace = activeTraces.get(appName)
  if (trace) {
    trace.disconnect()
    activeTraces.delete(appName)
    events.emit('status', appName, false)
  }
}

export function stopAllTraces(): void {
  for (const [app] of activeTraces) stopTrace(app)
}

export function getActiveTraces(): string[] {
  return Array.from(activeTraces.keys())
}

async function enableInspectorRemote(appName: string, org: string, space: string): Promise<string | null> {
  // Find the node PID and send SIGUSR1
  const targetCmd = `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
  const findPidCmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "pid=\\\$(ps aux | grep 'node' | grep -v grep | head -1 | awk '{print \\\$2}'); if [ -n \\\"\\\$pid\\\" ]; then kill -USR1 \\\$pid; sleep 1; cat /proc/\\\$pid/fd/2 2>/dev/null | grep -o 'ws://[^ ]*' | head -1; fi"`
  
  const shell = getShell() // need to import this
  const { execFileSync } = await import('node:child_process')
  try {
    const out = execFileSync(shell, ['-l', '-c', findPidCmd], { timeout: 15000, encoding: 'utf-8', maxBuffer: 1024 * 1024 })
    const lines = (out as string).split('\n').map(l => l.trim()).filter(Boolean)
    const wsLine = lines.find(l => l.startsWith('ws://'))
    if (wsLine) return wsLine
    // Try alternate: look in /proc for the inspector URL
    return null
  } catch {
    return null
  }
}
