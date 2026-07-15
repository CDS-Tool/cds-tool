import { cf } from './cfShell'
import type { CfEvent } from '../types'

export async function cfAppEvents(app: string): Promise<CfEvent[]> {
  const out = await cf(['events', app])
  return parseEventsTable(out)
}

export async function cfSpaceEvents(): Promise<CfEvent[]> {
  const out = await cf(['events'])
  return parseEventsTable(out)
}

export function parseEventsTable(stdout: string): CfEvent[] {
  const lines = stdout.split('\n')
  const hdr = lines.findIndex(l => l.includes('time'))
  if (hdr < 0) return []
  return lines.slice(hdr + 1).map(l => l.trim()).filter(Boolean).map(l => {
    const parts = l.split(/\s{2,}/)
    return {
      time: parts[0]?.trim() ?? '',
      actor: parts[1]?.trim() ?? '',
      event: parts[2]?.trim() ?? '',
      description: parts.slice(3).join(' ').trim(),
    }
  }).filter(e => e.time && e.event)
}

export async function sshSessionDetect(app: string): Promise<boolean> {
  const events = await cfAppEvents(app)
  return events.some(e => e.event.toLowerCase().includes('ssh'))
}
