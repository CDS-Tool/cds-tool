import { writeFileSync, mkdirSync, existsSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { shellEscape, getShell } from './cfShell'
import { execFileSync } from 'node:child_process'

export interface DownloadResult {
  path: string
  size: number
}

export function downloadFile(appName: string, org: string, space: string, remotePath: string, localDir: string): DownloadResult {
  const shell = getShell()
  const fileName = remotePath.split('/').pop() || 'file'
  const localPath = join(localDir, fileName)
  const targetCmd = org && space
    ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
    : ''
  const cmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "cat ${shellEscape(remotePath)}"`

  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true })
  const buf = execFileSync(shell, ['-l', '-c', cmd], { timeout: 30000, encoding: 'buffer' })
  writeFileSync(localPath, buf)
  return { path: localPath, size: buf.length }
}

export function downloadFolder(appName: string, org: string, space: string, remoteDir: string, localDir: string): DownloadResult[] {
  const shell = getShell()
  const results: DownloadResult[] = []
  const targetCmd = org && space
    ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
    : ''

  // List all files recursively using tar
  const listCmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "find ${shellEscape(remoteDir)} -type f 2>/dev/null | head -200"`
  const listOut = execFileSync(shell, ['-l', '-c', listCmd], { timeout: 30000, encoding: 'utf-8' })
  const files = listOut.split('\n').map(l => l.trim()).filter(Boolean)

  for (const file of files) {
    const relPath = file.replace(remoteDir, '').replace(/^\//, '')
    const localFilePath = join(localDir, relPath)
    if (!existsSync(dirname(localFilePath))) mkdirSync(dirname(localFilePath), { recursive: true })

    const cmd = `${targetCmd}cf ssh ${shellEscape(appName)} -c "cat ${shellEscape(file)}"`
    try {
      const buf = execFileSync(shell, ['-l', '-c', cmd], { timeout: 30000, encoding: 'buffer' })
      writeFileSync(localFilePath, buf)
      results.push({ path: relPath, size: buf.length })
    } catch {}
  }
  return results
}

export function genDefaultEnv(appName: string, org: string, space: string, localDir: string): string {
  const shell = getShell()
  const targetCmd = org && space
    ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && `
    : ''
  const cmd = `${targetCmd}cf env ${shellEscape(appName)}`
  const out = execFileSync(shell, ['-l', '-c', cmd], { timeout: 30000, encoding: 'utf-8' })

  // Extract VCAP_SERVICES and VCAP_APPLICATION JSON
  const vcapServices = extractEnvJson(out, 'VCAP_SERVICES')
  const vcapApplication = extractEnvJson(out, 'VCAP_APPLICATION')
  const userProvided = extractEnvJson(out, 'VCAP_APPLICATION') // fallback

  const env: Record<string, any> = {}
  if (vcapServices) env.VCAP_SERVICES = vcapServices
  if (vcapApplication) env.VCAP_APPLICATION = vcapApplication

  // Also extract user-provided env vars
  const userVars = extractUserProvided(out)
  Object.assign(env, userVars)

  const localPath = join(localDir, 'default-env.json')
  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true })
  writeFileSync(localPath, JSON.stringify(env, null, 2))
  return localPath
}

function extractEnvJson(out: string, name: string): any | null {
  const lines = out.split('\n')
  const start = lines.findIndex(l => l.trim().startsWith(name))
  if (start < 0) return null

  let braceIdx = start
  while (braceIdx < lines.length && !lines[braceIdx].includes('{')) braceIdx++
  if (braceIdx >= lines.length) return null

  // Simple brace matching
  let depth = 0, inStr = false, esc = false, json = ''
  for (let i = braceIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (esc) { json += ch; esc = false; continue }
      if (ch === '\\' && inStr) { json += ch; esc = true; continue }
      if (ch === '"') { inStr = !inStr; json += ch; continue }
      if (!inStr) {
        if (ch === '{') depth++
        if (ch === '}') depth--
      }
      json += ch
      if (!inStr && depth === 0) {
        try { return JSON.parse(json) } catch { return null }
      }
    }
    if (i < lines.length - 1) json += '\n'
  }
  return null
}

function extractUserProvided(out: string): Record<string, string> {
  const vars: Record<string, string> = {}
  const lines = out.split('\n')
  let inUser = false
  for (const line of lines) {
    if (line.includes('user-provided')) { inUser = true; continue }
    if (inUser && line.includes(':')) {
      const idx = line.indexOf(':')
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key && val && !key.includes(' ')) vars[key] = val
    }
    if (inUser && line.trim() === '') inUser = false
  }
  return vars
}
