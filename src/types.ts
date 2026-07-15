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

export interface CfEvent {
  time: string
  actor: string
  event: string
  description: string
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
  knownEndpoints: string[]
  sshUser?: string
  pkgRegexDefault?: string
  sharedConfig?: {
    remoteRoot?: string
    packageRegexFilter?: string
    appFolderMappings?: { appName: string; folderName: string }[]
  }
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
  | { type: 'SAVE_SETTINGS'; payload: { remoteRoot: string; sshUser?: string; newEndpoint?: string; pkgRegexDefault?: string } }
  | { type: 'BROWSE_PACKAGES'; payload: { appName: string; org: string; space: string; filter?: string } }
  | { type: 'BROWSE_FILE'; payload: { appName: string; path: string; org: string; space: string } }
  | { type: 'GENERATE_LAUNCH_CONFIG'; payload: { config: any; org: string; space: string; apiEndpoint: string } }
  | { type: 'GET_XSUAA_TOKEN'; payload: { appName: string; org: string; space: string } }
  | { type: 'SHOW_WATCHDOG' }
  | { type: 'SYNC_LANDSCAPE' }
  | { type: 'EXPLORER_LS'; payload: { appName: string; org: string; space: string; dir: string } }
  | { type: 'EXPLORER_FIND'; payload: { appName: string; org: string; space: string; dir: string; query: string } }
  | { type: 'EXPLORER_GREP'; payload: { appName: string; org: string; space: string; query: string } }
  | { type: 'BROWSE_FOLDER'; payload: { org: string; space?: string } }
  | { type: 'RUN_SQL'; payload: { appName: string; org: string; space: string; sql: string } }
  | { type: 'START_TAIL'; payload: { appNames: string[]; org?: string; space?: string } }
  | { type: 'STOP_TAIL' }
  | { type: 'CHECK_CONNECTION' }
  | { type: 'RESTART_APP'; payload: { appName: string; org: string; space: string } }
  | { type: 'LIST_SERVICES'; payload: { appName: string; org: string; space: string } }
  | { type: 'GET_EVENTS'; payload: { appName: string; org: string; space: string } }
  | { type: 'GET_SPACE_EVENTS'; payload: { org: string; space: string } }
  | { type: 'START_TRACE'; payload: { appName: string; org: string; space: string } }
  | { type: 'STOP_TRACE' }
  | { type: 'SET_BREAKPOINT'; payload: { appName: string; org: string; space: string; url: string; line: number; condition?: string; logMessage?: string; hitCondition?: string } }
  | { type: 'REMOVE_BREAKPOINT'; payload: { appName: string; breakpointId: string } }
  | { type: 'GET_STACK'; payload: { appName: string } }
  | { type: 'LIST_BREAKPOINTS'; payload: { appName: string } }
  | { type: 'SET_EXCEPTION_BP'; payload: { appName: string; org: string; space: string } }
  | { type: 'REMOVE_EXCEPTION_BP'; payload: { appName: string } }
  | { type: 'DOWNLOAD_FILE'; payload: { appName: string; org: string; space: string; remotePath: string } }
  | { type: 'DOWNLOAD_FOLDER'; payload: { appName: string; org: string; space: string; remoteDir: string } }
  | { type: 'GEN_ENV'; payload: { appName: string; org: string; space: string } }
  | { type: 'OPEN_DEVTOOLS'; payload: { appName: string; port?: number } }
  | { type: 'CHANGE_DEBUG_PORT'; payload: { appName: string; port: number } }
  | { type: 'GEN_SKILL'; payload: { useSmdg?: boolean } }
  | { type: 'RUN_QUERY'; payload: { appName: string; org: string; space: string; sql: string; params?: any[] } }
  | { type: 'BEGIN_TRANSACTION'; payload: { appName: string; org: string; space: string } }
  | { type: 'COMMIT'; payload: { sessionId: string } }
  | { type: 'ROLLBACK'; payload: { sessionId: string } }
  | { type: 'QUERY_FILTER'; payload: { appName: string; query: string; level?: string; source?: string; tenant?: string; status?: string; since?: string } }
  | { type: 'BRUNO_RUN'; payload: { collectionPath: string; appName?: string; org?: string; space?: string; envVars?: Record<string, string> } }
  | { type: 'BRUNO_SETUP'; payload: { appName: string; org: string; space: string; outputDir?: string } }
  | { type: 'GITPORT_CREATE'; payload: { sourceMrUrl: string; destRepo: string; destBranch: string; appName?: string; org?: string; space?: string } }
  | { type: 'JIRA_SEARCH'; payload: { jql: string; maxResults?: number } }
  | { type: 'JIRA_ISSUE'; payload: { issueKey: string } }
  | { type: 'JIRA_TRANSITION'; payload: { issueKey: string; transitionId: string } }
  | { type: 'JIRA_COMMENT'; payload: { issueKey: string; comment: string } }
  | { type: 'SHAREPOINT_CREATE'; payload: { siteId: string; drivePath: string; fileName: string; data: Record<string, any>[] } }
  | { type: 'SHAREPOINT_READ'; payload: { siteId: string; drivePath: string; fileName: string } }
  | { type: 'SHAREPOINT_APPEND'; payload: { siteId: string; drivePath: string; fileName: string; data: Record<string, any>[] } }
  | { type: 'SMDG_LOGIN' }
  | { type: 'SMDG_LOGOUT' }
  | { type: 'SMDG_GENERATE'; payload: { sources: string[]; name?: string; category?: string; install?: 'claude' | 'codex' } }
  | { type: 'SMDG_INSTALL'; payload: { skillName: string; platform: 'claude' | 'codex' } }
  | { type: 'SMDG_CREDITS' }
  | { type: 'SMDG_LIST' }
  | { type: 'SMDG_CHECK' }

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
      cfTarget?: { apiEndpoint: string; user: string; org: string; space: string }
    } }
  | { type: 'DB_CREDENTIALS'; payload: { creds: DbCredentials | null; appName: string } }
  | { type: 'DB_CONNECTION_ADDED'; payload: { appName: string } }
  | { type: 'DB_ERROR'; payload: { message: string } }
  | { type: 'SESSION_UPDATED'; payload: { appName: string; status: string } }
  | { type: 'SETTINGS_LOADED'; payload: { remoteRoot: string; sshUser?: string; pkgRegexDefault?: string; folderMappings: OrgGroupMapping[] } }
  | { type: 'PACKAGES_LOADED'; payload: { appName: string; packages: string[]; error?: string } }
  | { type: 'FILE_CONTENT'; payload: { appName: string; path: string; content: string } }
  | { type: 'XSUAA_TOKEN_RESPONSE'; payload: { token?: string; expiresIn?: number; error?: string } }
  | { type: 'WATCHDOG_UPDATE'; payload: { apps: { appName: string; url: string; failed: boolean }[] } }
  | { type: 'SYNC_STATUS'; payload: { message: string } }
  | { type: 'EXPLORER_RESULT'; payload: { result?: string[]; error?: string } }
  | { type: 'TAIL_LINE'; payload: { appName: string; line: string } }
  | { type: 'SQL_RESULT'; payload: { columns?: string[]; rows?: string[][]; error?: string } }
  | { type: 'CF_READY'; payload: { ready: boolean } }
  | { type: 'CONNECTION_HEALTH'; payload: { ok: boolean; user?: string; org?: string; space?: string; error?: string } }
  | { type: 'SERVICES_LOADED'; payload: { appName: string; services: string[] } }
  | { type: 'APP_RESTARTED'; payload: { appName: string } }
  | { type: 'LOGOUT' }
  | { type: 'EVENTS_LOADED'; payload: { appName?: string; events: CfEvent[] } }
  | { type: 'TRACE_LINE'; payload: { appName: string; line: string } }
  | { type: 'TRACE_STATUS'; payload: { appName: string; active: boolean } }
  | { type: 'BREAKPOINT_SET'; payload: { appName: string; breakpointId: string; url: string; line: number } }
  | { type: 'BREAKPOINT_REMOVED'; payload: { breakpointId: string } }
  | { type: 'BREAKPOINT_HIT'; payload: { appName: string; url: string; line: number; stack: string[]; timestamp: number; hitCount?: number } }
  | { type: 'BREAKPOINT_LIST'; payload: { appName: string; breakpoints: { id: string; url: string; line: number; condition?: string; logMessage?: string; hitCondition?: string; hitCount?: number }[] } }
  | { type: 'STACK_CAPTURE'; payload: { appName: string; stack: string[] } }
  | { type: 'QUERY_RESULT'; payload: { columns?: string[]; rows?: any[][]; error?: string } }
  | { type: 'TRANSACTION_STARTED'; payload: { sessionId: string } }
  | { type: 'TRANSACTION_COMMITTED'; payload: { sessionId: string } }
  | { type: 'TRANSACTION_ROLLED_BACK'; payload: { sessionId: string } }
  | { type: 'QUERY_FILTERED'; payload: { appName: string; lines: string[] } }
  | { type: 'FILE_DOWNLOADED'; payload: { appName: string; localPath: string; size: number } }
  | { type: 'FOLDER_DOWNLOADED'; payload: { appName: string; files: number; localDir: string } }
  | { type: 'ENV_GENERATED'; payload: { appName: string; localPath: string } }
  | { type: 'EXCEPTION_BP_SET'; payload: { appName: string } }
  | { type: 'DEBUG_PORT_CHANGED'; payload: { appName: string; port: number } }
  | { type: 'SKILL_GENERATED'; payload: { localPath: string } }
  | { type: 'BRUNO_RESULT'; payload: { success: boolean; output?: string; error?: string } }
  | { type: 'BRUNO_SETUP_RESULT'; payload: { success: boolean; outputDir?: string; error?: string } }
  | { type: 'GITPORT_RESULT'; payload: { success: boolean; mrUrl?: string; error?: string } }
  | { type: 'JIRA_RESULT'; payload: { success: boolean; data?: any; error?: string } }
  | { type: 'SHAREPOINT_RESULT'; payload: { success: boolean; data?: any; error?: string } }
  | { type: 'SMDG_STATUS'; payload: { available: boolean } }
  | { type: 'SMDG_RESULT'; payload: { success: boolean; output?: string; error?: string } }
  | { type: 'SMDG_SKILL_GENERATED'; payload: { skillPath?: string; output?: string } }
