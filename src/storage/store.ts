import * as vscode from 'vscode'
import type { ExtensionConfig, CachedRegion, CfApp, OrgGroupMapping } from '../types'

const CONFIG_KEY = 'cds-tool.config'
const CACHE_KEY = 'cds-tool.cache'
const MAPPINGS_KEY = 'cds-tool.mappings'
const SECRET_EMAIL = 'cds-tool.email'
const SECRET_PASSWORD = 'cds-tool.password'

let context: vscode.ExtensionContext | undefined

export function initStore(ctx: vscode.ExtensionContext): void {
  context = ctx
}

export function saveConfig(config: ExtensionConfig): void {
  if (!context) return
  context.globalState.update(CONFIG_KEY, config)
}

export function loadConfig(): ExtensionConfig | null {
  if (!context) return null
  return context.globalState.get<ExtensionConfig>(CONFIG_KEY) ?? null
}

export function clearConfig(): void {
  if (!context) return
  context.globalState.update(CONFIG_KEY, undefined)
}

// --- Topology Cache ---
export function saveCachedRegions(regions: CachedRegion[]): void {
  if (!context) return
  context.globalState.update(CACHE_KEY, regions)
}

export function loadCachedRegions(): CachedRegion[] {
  if (!context) return []
  return context.globalState.get<CachedRegion[]>(CACHE_KEY) ?? []
}

export function getCachedApps(apiEndpoint: string, org: string, space: string): CfApp[] | null {
  const regions = loadCachedRegions()
  const region = regions.find(r => r.apiEndpoint === apiEndpoint)
  if (!region) return null
  const o = region.orgs.find(o => o.name === org)
  if (!o) return null
  const s = o.spaces.find(s => s.name === space)
  if (!s) return null
  return s.apps
}

export function setCachedApps(apiEndpoint: string, org: string, space: string, apps: CfApp[]): void {
  const regions = loadCachedRegions()
  let region = regions.find(r => r.apiEndpoint === apiEndpoint)
  if (!region) {
    region = { apiEndpoint, orgs: [], cachedAt: new Date().toISOString() }
    regions.push(region)
  }
  let o = region.orgs.find(o => o.name === org)
  if (!o) {
    o = { name: org, spaces: [] }
    region.orgs.push(o)
  }
  let s = o.spaces.find(s => s.name === space)
  if (!s) {
    s = { name: space, apps, cachedAt: new Date().toISOString() }
    o.spaces.push(s)
  } else {
    s.apps = apps
    s.cachedAt = new Date().toISOString()
  }
  saveCachedRegions(regions)
}

// --- Folder Mappings ---
export function saveFolderMappings(mappings: OrgGroupMapping[]): void {
  if (!context) return
  context.globalState.update(MAPPINGS_KEY, mappings)
}

export function loadFolderMappings(): OrgGroupMapping[] {
  if (!context) return []
  return context.globalState.get<OrgGroupMapping[]>(MAPPINGS_KEY) ?? []
}

// --- Credential Store (SecretStorage) ---
export async function saveEmail(email: string): Promise<void> {
  if (!context) return
  await context.secrets.store(SECRET_EMAIL, email)
}

export async function loadEmail(): Promise<string> {
  if (!context) return ''
  return (await context.secrets.get(SECRET_EMAIL)) ?? ''
}

export async function savePassword(pw: string): Promise<void> {
  if (!context) return
  await context.secrets.store(SECRET_PASSWORD, pw)
}

export async function loadPassword(): Promise<string> {
  if (!context) return ''
  return (await context.secrets.get(SECRET_PASSWORD)) ?? ''
}

export async function clearSecrets(): Promise<void> {
  if (!context) return
  await context.secrets.delete(SECRET_EMAIL)
  await context.secrets.delete(SECRET_PASSWORD)
}
