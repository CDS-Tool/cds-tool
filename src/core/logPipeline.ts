import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LOG_DIR = join(homedir(), '.cds-tool', 'logs')
const MAX_ENTRIES_PER_APP = 10000

interface LogEntry {
  timestamp: string
  appName: string
  level?: string
  source?: string
  message: string
  tenant?: string
  method?: string
  path?: string
  status?: number
  latency?: number
  raw: string
}

const redactPatterns = [
  /SAP_EMAIL=['"][^'"]+['"]/gi,
  /SAP_PASSWORD=['"][^'"]+['"]/gi,
  /"password"\s*:\s*"[^"]+"/gi,
  /"passwd"\s*:\s*"[^"]+"/gi,
  /Authorization:\s*Bearer\s+\S+/gi,
  /api_key[=:]\s*\S+/gi,
  /secret[=:]\s*\S+/gi,
  /token[=:]\s*\S+/gi,
]

const routerLogPattern = /^\[(?<method>GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\]\s+(?<path>\S+)\s+(?<status>\d+)\s+(?<latency>\d+ms)/

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })
}

function redact(line: string): string {
  let result = line
  for (const pattern of redactPatterns) {
    result = result.replace(pattern, (match) => {
      const eqIdx = match.indexOf('=')
      const colonIdx = match.indexOf(':')
      if (eqIdx > 0 && eqIdx < match.length - 1) {
        return match.slice(0, eqIdx + 1) + '***'
      }
      if (colonIdx > 0 && colonIdx < match.length - 1) {
        return match.slice(0, colonIdx + 1) + '***'
      }
      return '***'
    })
  }
  return result
}

function parseLevel(line: string): string | undefined {
  if (/error|err|fatal|crash/i.test(line)) return 'error'
  if (/warn/i.test(line)) return 'warn'
  if (/info/i.test(line)) return 'info'
  if (/debug|trace/i.test(line)) return 'debug'
  return undefined
}

function parseLogLine(appName: string, line: string): LogEntry {
  const redacted = redact(line)
  const timestamp = new Date().toISOString()
  const level = parseLevel(redacted)
  const routerMatch = redacted.match(routerLogPattern)
  
  let source: string | undefined
  let tenant: string | undefined
  let method: string | undefined
  let path: string | undefined
  let status: number | undefined
  let latency: number | undefined

  if (routerMatch && routerMatch.groups) {
    method = routerMatch.groups.method
    path = routerMatch.groups.path
    status = parseInt(routerMatch.groups.status, 10)
    latency = parseInt(routerMatch.groups.latency, 10)
    source = 'router'
  }

  // Try to parse JSON log
  try {
    const json = JSON.parse(redacted)
    if (json.level) Object.assign({ level: json.level })
    if (json.msg) Object.assign({ message: json.msg })
    if (json.tenant || json.tenantId) tenant = json.tenant || json.tenantId
    if (json.source || json.component) source = json.source || json.component
  } catch {}

  return { timestamp, appName, level, source, message: redacted, tenant, method, path, status, latency, raw: redacted }
}

export function processLogLine(appName: string, line: string): LogEntry {
  const entry = parseLogLine(appName, line)
  storeLog(entry)
  return entry
}

function storeLog(entry: LogEntry): void {
  try {
    ensureLogDir()
    const filePath = join(LOG_DIR, `${entry.appName}.jsonl`)
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8')
    
    // Trim if too large
    const stats = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : ''
    const lines = stats.split('\n').filter(Boolean)
    if (lines.length > MAX_ENTRIES_PER_APP * 2) {
      writeFileSync(filePath, lines.slice(-MAX_ENTRIES_PER_APP).join('\n') + '\n', 'utf-8')
    }
  } catch {}
}

export interface LogFilter {
  query?: string
  level?: string
  source?: string
  tenant?: string
  status?: string
  since?: string
}

export function queryLogs(appName: string, filter?: LogFilter): string[] {
  try {
    const filePath = join(LOG_DIR, `${appName}.jsonl`)
    if (!existsSync(filePath)) return []
    const content = readFileSync(filePath, 'utf-8')
    let entries: LogEntry[] = content.split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) as LogEntry } catch { return null }
    }).filter(Boolean) as LogEntry[]

    if (filter) {
      if (filter.query) {
        const q = filter.query.toLowerCase()
        entries = entries.filter(e => e.message.toLowerCase().includes(q))
      }
      if (filter.level) {
        entries = entries.filter(e => e.level === filter.level)
      }
      if (filter.source) {
        entries = entries.filter(e => e.source === filter.source)
      }
      if (filter.tenant) {
        entries = entries.filter(e => e.tenant === filter.tenant)
      }
      if (filter.status) {
        const statusNum = parseInt(filter.status, 10)
        if (!isNaN(statusNum)) entries = entries.filter(e => e.status === statusNum)
      }
      if (filter.since) {
        const since = new Date(filter.since).getTime()
        entries = entries.filter(e => new Date(e.timestamp).getTime() >= since)
      }
    }

    return entries.map(e => {
      const tags: string[] = []
      if (e.level) tags.push(`[${e.level}]`)
      if (e.source) tags.push(`[${e.source}]`)
      if (e.tenant) tags.push(`[tenant:${e.tenant}]`)
      if (e.method && e.path) tags.push(`[${e.method} ${e.path}]`)
      if (e.status !== undefined) tags.push(`[${e.status}]`)
      if (e.latency !== undefined) tags.push(`[${e.latency}ms]`)
      return `${e.timestamp} ${tags.join(' ')} ${e.message}`
    })
  } catch {
    return []
  }
}

export function clearLogs(appName: string): void {
  try {
    const filePath = join(LOG_DIR, `${appName}.jsonl`)
    if (existsSync(filePath)) writeFileSync(filePath, '', 'utf-8')
  } catch {}
}
