export interface CfApp {
  name: string
  state: 'started' | 'stopped' | 'empty'
  urls: string[]
}

export interface OrgGroupMapping {
  cfOrg: string
  cfSpace: string
  groupFolderPath: string
}

export interface CachedSpace {
  name: string
  apps: CfApp[]
  cachedAt: string
}

export interface CachedOrg {
  name: string
  spaces: CachedSpace[]
}

export interface CachedRegion {
  apiEndpoint: string
  orgs: CachedOrg[]
  cachedAt: string
}

export interface ExtensionConfig {
  apiEndpoint: string
  orgs: string[]
  orgGroupMappings: OrgGroupMapping[]
  lastOrg: string
  lastSpace: string
  remoteRoot: string
}

export interface DbCredentials {
  host: string
  port: number
  database: string
  user: string
  password: string
  schema?: string
}

export type WebviewMessage =
  | { type: 'LOGIN'; payload: { apiEndpoint: string; email: string; password: string } }
  | { type: 'LOAD_ORGS' }
  | { type: 'LOAD_SPACES'; payload: { org: string } }
  | { type: 'LOAD_APPS'; payload: { org: string; space: string; force?: boolean } }
  | { type: 'START_DEBUG'; payload: { appNames: string[]; org: string; space: string } }
  | { type: 'STOP_DEBUG'; payload: { appName: string } }
  | { type: 'STOP_ALL_DEBUG' }
  | { type: 'STREAM_LOGS'; payload: { appName: string; action: 'start' | 'stop' } }
  | { type: 'LOAD_CONFIG' }
  | { type: 'SAVE_MAPPING'; payload: { cfOrg: string; cfSpace: string; folderPath: string } }
  | { type: 'GET_DB_CREDENTIALS'; payload: { appName: string; org: string; space: string } }
  | { type: 'ADD_DB_CONNECTION'; payload: { creds: DbCredentials; appName: string } }
  | { type: 'OPEN_APP'; payload: { url: string } }
  | { type: 'RESET_LOGIN' }
  | { type: 'LOG'; payload: { level: string; message: string } }
  | { type: 'LOAD_SETTINGS' }
  | { type: 'SAVE_SETTINGS'; payload: { remoteRoot: string } }
  | { type: 'BROWSE_PACKAGES'; payload: { appName: string; org: string; space: string } }
  | { type: 'BROWSE_FILE'; payload: { appName: string; path: string } }

export type ExtensionMessage =
  | { type: 'LOGIN_SUCCESS'; payload: { orgs: string[]; apiEndpoint: string } }
  | { type: 'LOGIN_ERROR'; payload: { message: string } }
  | { type: 'ORGS_LOADED'; payload: { orgs: string[] } }
  | { type: 'SPACES_LOADED'; payload: { org: string; spaces: string[] } }
  | { type: 'APPS_LOADED'; payload: { apps: CfApp[]; fromCache?: boolean } }
  | { type: 'APPS_ERROR'; payload: { message: string } }
  | { type: 'DEBUG_CONNECTING'; payload: { appNames: string[]; ports: Record<string, number> } }
  | { type: 'APP_DEBUG_STATUS'; payload: { appName: string; status: string; message?: string } }
  | { type: 'DEBUG_ERROR'; payload: { message: string } }
  | { type: 'LOGS_LINE'; payload: { appName: string; line: string } }
  | { type: 'LOGS_STATUS'; payload: { appName: string; streaming: boolean } }
  | { type: 'CONFIG_LOADED'; payload: {
      config: ExtensionConfig | null
      activeSessions: string[]
      credentialSource?: string
      defaultEmail?: string
      defaultPassword?: string
      cachedRegions?: CachedRegion[]
      folderMappings?: OrgGroupMapping[]
    } }
  | { type: 'DB_CREDENTIALS'; payload: { creds: DbCredentials | null; appName: string } }
  | { type: 'DB_CONNECTION_ADDED'; payload: { appName: string } }
  | { type: 'DB_ERROR'; payload: { message: string } }
  | { type: 'SESSION_UPDATED'; payload: { appName: string; status: string } }
  | { type: 'SETTINGS_LOADED'; payload: { remoteRoot: string; folderMappings: OrgGroupMapping[] } }
  | { type: 'PACKAGES_LOADED'; payload: { appName: string; packages: string[]; error?: string } }
  | { type: 'FILE_CONTENT'; payload: { appName: string; path: string; content: string } }
