import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { CF_REGIONS, type RegionInfo } from './regions'
import { cfLogin, cfOrgs, cfTargetOrg, cfSpaces, cfApps, cfLogout, cfCurrentTarget, type CfTargetInfo } from './cfClient'
import type { CfApp } from '../types'

export interface SyncedRegion {
  key: string
  apiEndpoint: string
  label: string
  orgs: SyncedOrg[]
  syncedAt: string
}

export interface SyncedOrg {
  name: string
  spaces: SyncedSpace[]
}

export interface SyncedSpace {
  name: string
  apps: CfApp[]
}

export interface SyncManifest {
  version: 1
  syncedAt: string
  regions: SyncedRegion[]
}

function getCachePath(): string {
  const dir = path.join(os.homedir(), '.cds-tool')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'cf-structure.json')
}

export function readSyncManifest(): SyncManifest {
  try {
    return JSON.parse(fs.readFileSync(getCachePath(), 'utf-8'))
  } catch {
    return { version: 1, syncedAt: '', regions: [] }
  }
}

export function writeSyncManifest(m: SyncManifest): void {
  fs.writeFileSync(getCachePath(), JSON.stringify(m, null, 2))
}

export async function syncRegion(
  region: RegionInfo,
  email: string,
  password: string,
  progress?: (msg: string) => void
): Promise<SyncedRegion> {
  const syncedRegion: SyncedRegion = {
    key: region.key,
    apiEndpoint: region.apiEndpoint,
    label: region.label,
    orgs: [],
    syncedAt: new Date().toISOString(),
  }

  progress?.(`Logging into ${region.label}...`)
  await cfLogin(region.apiEndpoint, email, password)

  progress?.(`Fetching orgs for ${region.label}...`)
  const orgNames = await cfOrgs()

  for (const orgName of orgNames) {
    progress?.(`Syncing ${region.label}/${orgName}...`)
    await cfTargetOrg(orgName)
    const spaces: SyncedSpace[] = []
    const spaceNames = await cfSpaces(orgName)
    for (const spaceName of spaceNames) {
      progress?.(`Syncing ${region.label}/${orgName}/${spaceName}...`)
      const apps = await cfApps(orgName, spaceName)
      spaces.push({ name: spaceName, apps })
    }
    syncedRegion.orgs.push({ name: orgName, spaces })
  }

  return syncedRegion
}

export async function runFullSync(
  email: string,
  password: string,
  regionKeys?: string[],
  progress?: (msg: string) => void
): Promise<SyncManifest> {
  const manifest = readSyncManifest()
  const regionsToSync = regionKeys
    ? CF_REGIONS.filter(r => regionKeys.includes(r.key))
    : CF_REGIONS

  for (const region of regionsToSync) {
    try {
      const synced = await syncRegion(region, email, password, progress)
      const idx = manifest.regions.findIndex(r => r.key === region.key)
      if (idx >= 0) manifest.regions[idx] = synced
      else manifest.regions.push(synced)
    } catch (err: any) {
      progress?.(`Failed to sync ${region.label}: ${err.message}`)
    }
  }

  manifest.syncedAt = new Date().toISOString()
  writeSyncManifest(manifest)
  return manifest
}

export async function syncOneOrg(
  apiEndpoint: string,
  email: string,
  password: string,
  orgName: string
): Promise<void> {
  await cfLogin(apiEndpoint, email, password)
  await cfTargetOrg(orgName)
  const spaces = await cfSpaces(orgName)

  const manifest = readSyncManifest()
  let region = manifest.regions.find(r => r.apiEndpoint === apiEndpoint)
  if (!region) {
    const ri = CF_REGIONS.find(r => r.apiEndpoint === apiEndpoint)
    region = {
      key: ri?.key ?? apiEndpoint,
      apiEndpoint,
      label: ri?.label ?? apiEndpoint,
      orgs: [],
      syncedAt: new Date().toISOString(),
    }
    manifest.regions.push(region)
  }

  let org = region.orgs.find(o => o.name === orgName)
  if (!org) {
    org = { name: orgName, spaces: [] }
    region.orgs.push(org)
  }

  for (const spaceName of spaces) {
    const apps = await cfApps(orgName, spaceName)
    const existing = org.spaces.findIndex(s => s.name === spaceName)
    if (existing >= 0) org.spaces[existing] = { name: spaceName, apps }
    else org.spaces.push({ name: spaceName, apps })
  }

  manifest.syncedAt = new Date().toISOString()
  writeSyncManifest(manifest)
}
