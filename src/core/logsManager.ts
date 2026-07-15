import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { processLogLine } from './logPipeline'

const streams = new Map<string, ChildProcess>()
export const events = new EventEmitter()

let _filter: string = ''
export function setLogFilter(filter: string): void {
  _filter = filter
}

export function startLogStream(appName: string): boolean {
  if (streams.has(appName)) return false

  const child = spawn('cf', ['logs', appName], { stdio: ['ignore', 'pipe', 'pipe'] })
  streams.set(appName, child)

  child.stdout?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
      const t = line.trimEnd()
      if (!t) continue
      // Process through pipeline (redact, parse, store)
      const entry = processLogLine(appName, t)
      // Apply filter
      if (_filter && !entry.message.toLowerCase().includes(_filter.toLowerCase())) continue
      events.emit('line', appName, entry.message)
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    const lines = chunk.toString().split('\n')
    for (const line of lines) {
      const t = line.trimEnd()
      if (!t) continue
      const entry = processLogLine(appName, t)
      if (_filter && !entry.message.toLowerCase().includes(_filter.toLowerCase())) continue
      events.emit('line', appName, entry.message)
    }
  })

  child.on('error', () => {
    streams.delete(appName)
    events.emit('status', appName, false)
  })

  child.on('close', () => {
    streams.delete(appName)
    events.emit('status', appName, false)
  })

  events.emit('status', appName, true)
  return true
}

export function stopLogStream(appName: string): void {
  const child = streams.get(appName)
  if (!child) return
  try { child.kill('SIGTERM') } catch {}
  streams.delete(appName)
  events.emit('status', appName, false)
}

export function isStreaming(appName: string): boolean {
  return streams.has(appName)
}

export function getStreamingApps(): string[] {
  return Array.from(streams.keys())
}

export function stopAllLogStreams(): void {
  for (const [name, child] of streams) {
    try { child.kill('SIGTERM') } catch {}
  }
  streams.clear()
}
