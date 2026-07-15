import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface SharepointProfile {
  tenantId: string
  clientId: string
  clientSecret: string
}

function loadProfile(name = 'default'): SharepointProfile {
  const profilePath = path.join(os.homedir(), '.cds-tool', 'sharepoint-profiles.json')
  try {
    const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'))
    const profile = profiles[name]
    if (!profile) throw new Error(`Profile '${name}' not found`)
    return profile
  } catch (err: any) {
    throw new Error(`SharePoint profile error: ${err.message}. Create ~/.cds-tool/sharepoint-profiles.json`)
  }
}

async function getGraphToken(profile: SharepointProfile): Promise<string> {
  const resp = await fetch(
    `https://login.microsoftonline.com/${profile.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: profile.clientId,
        client_secret: profile.clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
      signal: AbortSignal.timeout(15000),
    }
  )
  if (!resp.ok) throw new Error(`Graph auth failed: ${resp.status}`)
  const data = await resp.json() as any
  return data.access_token
}

function toDrivePath(raw: string): string {
  return raw.replace(/^\/+/, '').replace(/\/+/g, '/')
}

export async function createWorkbook(
  siteId: string,
  drivePath: string,
  fileName: string,
  data: Record<string, any>[]
): Promise<void> {
  const profile = loadProfile()
  const token = await getGraphToken(profile)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  const driveResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${toDrivePath(drivePath)}`,
    { headers }
  )
  if (!driveResp.ok) throw new Error(`Drive lookup failed: ${driveResp.status}`)
  const driveInfo = await driveResp.json() as any

  const existing = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/items/${driveInfo.id}:/${fileName}`,
    { headers }
  )
  if (existing.ok) throw new Error(`File '${fileName}' already exists. Use APPEND to update.`)

  const createResp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${toDrivePath(drivePath)}/${fileName}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(data, null, 2)),
    }
  )
  if (!createResp.ok) throw new Error(`Workbook creation failed: ${createResp.status}`)
}

export async function readWorkbook(
  siteId: string,
  drivePath: string,
  fileName: string
): Promise<Record<string, any>[]> {
  const profile = loadProfile()
  const token = await getGraphToken(profile)
  const headers = { Authorization: `Bearer ${token}` }

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${toDrivePath(drivePath)}/${fileName}:/content`,
    { headers }
  )
  if (!resp.ok) throw new Error(`Read workbook failed: ${resp.status}`)
  return resp.json() as Promise<Record<string, any>[]>
}

export async function appendToWorkbook(
  siteId: string,
  drivePath: string,
  fileName: string,
  data: Record<string, any>[]
): Promise<void> {
  const existing = await readWorkbook(siteId, drivePath, fileName)
  const merged = [...existing, ...data]
  const profile = loadProfile()
  const token = await getGraphToken(profile)

  const resp = await fetch(
    `https://graph.microsoft.com/v1.0/sites/${siteId}/drive/root:/${toDrivePath(drivePath)}/${fileName}:/content`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(merged, null, 2)),
    }
  )
  if (!resp.ok) throw new Error(`Append to workbook failed: ${resp.status}`)
}
