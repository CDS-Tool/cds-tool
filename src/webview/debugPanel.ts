import * as vscode from 'vscode'
import type { WebviewMessage, ExtensionMessage } from '../types'
import { saveConfig, loadConfig, clearConfig, saveEmail, savePassword, loadFolderMappings, saveFolderMappings, setCachedApps, getCachedApps, loadCachedRegions } from '../storage/store'
import { cfLogin, cfOrgs, cfTargetOrg, cfSpaces, cfApps, cfLogout } from '../core/cfClient'
import { getCredentials } from '../core/shellEnv'
import * as packageBrowser from '../core/packageBrowser'
import * as debugManager from '../core/debugManager'
import * as logsManager from '../core/logsManager'
import * as dbManager from '../core/dbManager'

function post(v: vscode.Webview, msg: ExtensionMessage): void {
  try { v.postMessage(msg) } catch {}
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export class DebugPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'cdsTool.mainView'
  private _view?: vscode.WebviewView
  private _disposables: vscode.Disposable[] = []
  private _credentialSource = ''
  private _log: (type: string, msg: string) => void
  private _cfReady = false
  private _debugPorts: Map<string, number> = new Map()

  constructor(logFn: (type: string, msg: string) => void) {
    this._log = logFn
  }

  setCfReady(ready: boolean): void {
    this._cfReady = ready
    if (this._view) {
      post(this._view.webview, { type: 'CF_READY', payload: { ready } })
    }
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this._view = view
    view.webview.options = { enableScripts: true }
    view.webview.html = this.getHtml()

    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg))

    for (const d of this._disposables) d.dispose()
    this._disposables = []

    const onStatus = (app: string, status: string) =>
      post(view.webview, { type: 'SESSION_UPDATED', payload: { appName: app, status } })
    debugManager.events.on('status', onStatus)
    this._disposables.push(new vscode.Disposable(() => debugManager.events.off('status', onStatus)))

    const onLogLine = (app: string, line: string) =>
      post(view.webview, { type: 'LOGS_LINE', payload: { appName: app, line } })
    logsManager.events.on('line', onLogLine)
    this._disposables.push(new vscode.Disposable(() => logsManager.events.off('line', onLogLine)))

    const onLogStatus = (app: string, streaming: boolean) =>
      post(view.webview, { type: 'LOGS_STATUS', payload: { appName: app, streaming } })
    logsManager.events.on('status', onLogStatus)
    this._disposables.push(new vscode.Disposable(() => logsManager.events.off('status', onLogStatus)))

    const onTailLine = (app: string, line: string) =>
      post(view.webview, { type: 'TAIL_LINE', payload: { appName: app, line } })
    const { events: tailEvents } = await import('../core/cfTail')
    tailEvents.on('line', onTailLine)
    this._disposables.push(new vscode.Disposable(() => tailEvents.off('line', onTailLine)))

    // Trace events
    const onTraceLine = (app: string, trace: any) =>
      post(view.webview, { type: 'TRACE_LINE', payload: { appName: app, line: JSON.stringify(trace) } })
    const { events: traceEvents } = await import('../core/cfLiveTrace')
    traceEvents.on('trace', onTraceLine)
    this._disposables.push(new vscode.Disposable(() => traceEvents.off('trace', onTraceLine)))

    const onTraceStatus = (app: string, active: boolean) =>
      post(view.webview, { type: 'TRACE_STATUS', payload: { appName: app, active } })
    traceEvents.on('status', onTraceStatus)
    this._disposables.push(new vscode.Disposable(() => traceEvents.off('status', onTraceStatus)))

    // Auto-detect credentials and CF target
    const creds = await getCredentials()
    this._credentialSource = creds.email ? 'env' : 'none'
    const { cfCurrentTarget } = await import('../core/cfClient')
    const target = await cfCurrentTarget()
    post(view.webview, {
      type: 'CONFIG_LOADED',
      payload: {
        config: loadConfig(),
        activeSessions: debugManager.getActiveSessions(),
        credentialSource: this._credentialSource,
        defaultEmail: creds.email,
        defaultPassword: creds.password,
        cachedRegions: loadCachedRegions(),
        folderMappings: loadFolderMappings(),
        cfTarget: target ?? undefined,
      },
    })
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    const v = this._view
    if (!v) return

    switch (msg.type) {
      case 'LOGIN': {
        try {
          const { apiEndpoint, email, password } = msg.payload
          await cfLogin(apiEndpoint, email, password)
          const orgs = await cfOrgs()
          const config = loadConfig() ?? {
            apiEndpoint: '', orgs: [], orgGroupMappings: [], lastOrg: '', lastSpace: '', remoteRoot: '/home/vcap/app', knownEndpoints: [],
          }
          config.apiEndpoint = apiEndpoint
          config.orgs = orgs
          config.knownEndpoints = config.knownEndpoints ?? []
          if (!config.knownEndpoints.includes(apiEndpoint)) {
            config.knownEndpoints.push(apiEndpoint)
          }
          saveConfig(config)
          await saveEmail(email)
          await savePassword(password)
          this._log('info', `Email saved to secret storage`)
          post(v.webview, { type: 'LOGIN_SUCCESS', payload: { orgs, apiEndpoint } })
        } catch (err: any) {
          post(v.webview, { type: 'LOGIN_ERROR', payload: { message: err.stderr || err.message } })
        }
        break
      }

      case 'LOAD_SPACES': {
        try {
          const org = msg.payload.org
          await cfTargetOrg(org)
          const spaces = await cfSpaces(org)
          post(v.webview, { type: 'SPACES_LOADED', payload: { org, spaces } })
        } catch (err: any) {
          post(v.webview, { type: 'APPS_ERROR', payload: { message: err.message } })
        }
        break
      }

      case 'LOAD_APPS': {
        try {
          const { org, space, force } = msg.payload
          const config = loadConfig()
          const apiEndpoint = config?.apiEndpoint ?? ''
          // Check cache first unless force refresh
          if (!force) {
            const cached = getCachedApps(apiEndpoint, org, space)
            if (cached) {
              post(v.webview, { type: 'APPS_LOADED', payload: { apps: cached, fromCache: true } })
              break
            }
          }
          const apps = await cfApps(org, space)
          setCachedApps(apiEndpoint, org, space, apps)
          post(v.webview, { type: 'APPS_LOADED', payload: { apps, fromCache: false } })
        } catch (err: any) {
          post(v.webview, { type: 'APPS_ERROR', payload: { message: err.message } })
        }
        break
      }

      case 'START_DEBUG': {
        const { appNames, org, space } = msg.payload
        const ports: Record<string, number> = {}
        for (const name of appNames) ports[name] = 9229
        post(v.webview, { type: 'DEBUG_CONNECTING', payload: { appNames, ports } })
        for (const appName of appNames) {
          debugManager.startDebugSession(appName, org, space).catch((err: Error) => {
            post(v.webview, {
              type: 'APP_DEBUG_STATUS',
              payload: { appName, status: 'ERROR', message: err.message },
            })
          })
        }
        break
      }

      case 'STOP_DEBUG':
        await debugManager.stopDebugSession(msg.payload.appName)
        break

      case 'STOP_ALL_DEBUG':
        await debugManager.stopAllDebugSessions()
        break

      case 'STREAM_LOGS': {
        const { appName, action } = msg.payload
        if (action === 'start') logsManager.startLogStream(appName)
        else logsManager.stopLogStream(appName)
        break
      }

      case 'LOAD_CONFIG':
        post(v.webview, {
          type: 'CONFIG_LOADED',
          payload: {
            config: loadConfig(),
            activeSessions: debugManager.getActiveSessions(),
            cachedRegions: loadCachedRegions(),
            folderMappings: loadFolderMappings(),
          },
        })
        break

      case 'GET_DB_CREDENTIALS': {
        try {
          const creds = await dbManager.getDbCredentials(
            msg.payload.appName, msg.payload.org, msg.payload.space
          )
          post(v.webview, { type: 'DB_CREDENTIALS', payload: { creds, appName: msg.payload.appName } })
        } catch (err: any) {
          post(v.webview, { type: 'DB_ERROR', payload: { message: err.message } })
        }
        break
      }

      case 'ADD_DB_CONNECTION': {
        try {
          dbManager.addSqlToolsConnection(msg.payload.creds, msg.payload.appName)
          await dbManager.saveCredentialsFile(msg.payload.creds, msg.payload.appName)
          post(v.webview, { type: 'DB_CONNECTION_ADDED', payload: { appName: msg.payload.appName } })
        } catch (err: any) {
          post(v.webview, { type: 'DB_ERROR', payload: { message: err.message } })
        }
        break
      }

      case 'OPEN_APP':
        vscode.env.openExternal(vscode.Uri.parse(msg.payload.url))
        break

      case 'RESET_LOGIN':
        clearConfig()
        await cfLogout()
        const { clearSecrets } = await import('../storage/store')
        await clearSecrets()
        post(v.webview, { type: 'LOGOUT' })
        break

      case 'GENERATE_LAUNCH_CONFIG': {
        try {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          if (!ws) {
            this._log('warn', 'No workspace open, cannot generate launch.json')
            break
          }
          const fs = await import('node:fs')
          const path = await import('node:path')
          const vscodeDir = path.join(ws, '.vscode')
          if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true })
          const launchPath = path.join(vscodeDir, 'launch.json')
          let existing: any = { version: '0.2.0', configurations: [] }
          try {
            existing = JSON.parse(fs.readFileSync(launchPath, 'utf-8'))
          } catch {}
          existing.configurations = existing.configurations ?? []
          existing.configurations.push(msg.payload.config)
          fs.writeFileSync(launchPath, JSON.stringify(existing, null, 2))
          this._log('info', `Launch config written to ${launchPath}`)
        } catch (err: any) {
          this._log('err', `Failed to generate launch config: ${err.message}`)
        }
        break
      }

      case 'LOG':
        this._log(msg.payload.level, msg.payload.message)
        break

      case 'LOAD_SETTINGS':
        post(v.webview, {
          type: 'SETTINGS_LOADED',
          payload: {
            remoteRoot: loadConfig()?.remoteRoot ?? '/home/vcap/app',
            sshUser: loadConfig()?.sshUser,
            pkgRegexDefault: loadConfig()?.pkgRegexDefault,
            folderMappings: loadFolderMappings(),
          },
        })
        break

      case 'SAVE_SETTINGS': {
        const cfg = loadConfig() ?? {
          apiEndpoint: '', orgs: [], orgGroupMappings: [], lastOrg: '', lastSpace: '', remoteRoot: '/home/vcap/app', knownEndpoints: [], sshUser: undefined,
        }
        cfg.remoteRoot = msg.payload.remoteRoot
        cfg.sshUser = msg.payload.sshUser || undefined
        if (msg.payload.pkgRegexDefault !== undefined) cfg.pkgRegexDefault = msg.payload.pkgRegexDefault || undefined
        if (msg.payload.newEndpoint) {
          cfg.knownEndpoints = cfg.knownEndpoints ?? []
          if (!cfg.knownEndpoints.includes(msg.payload.newEndpoint)) {
            cfg.knownEndpoints.push(msg.payload.newEndpoint)
          }
        }
        saveConfig(cfg)
        this._log('info', 'Settings saved')
        break
      }

      case 'SAVE_MAPPING': {
        try {
          const { cfOrg, cfSpace, folderPath } = msg.payload
          const mappings = loadFolderMappings()
          const existing = mappings.findIndex(m => m.cfOrg === cfOrg && m.cfSpace === cfSpace)
          const entry = { cfOrg, cfSpace, groupFolderPath: folderPath }
          if (existing >= 0) mappings[existing] = entry
          else mappings.push(entry)
          saveFolderMappings(mappings)
          this._log('ok', `Mapping saved: ${cfOrg}/${cfSpace} -> ${folderPath}`)
        } catch (err: any) {
          this._log('err', `Save mapping failed: ${err.message}`)
        }
        break
      }

      case 'BRUNO_RUN': {
        try {
          const { runBrunoCollection } = await import('../core/bruno')
          const output = await runBrunoCollection(msg.payload.collectionPath, msg.payload.envVars)
          post(v.webview, { type: 'BRUNO_RESULT', payload: { success: true, output } })
        } catch (err: any) {
          post(v.webview, { type: 'BRUNO_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'BRUNO_SETUP': {
        try {
          const { generateBrunoEnv, scaffoldBrunoCollection } = await import('../core/bruno')
          const env = await generateBrunoEnv(msg.payload.appName, msg.payload.org, msg.payload.space)
          const outDir = msg.payload.outputDir || (await import('node:os')).tmpdir()
          const dir = scaffoldBrunoCollection(msg.payload.appName, env, outDir)
          post(v.webview, { type: 'BRUNO_SETUP_RESULT', payload: { success: true, outputDir: dir } })
        } catch (err: any) {
          post(v.webview, { type: 'BRUNO_SETUP_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'GITPORT_CREATE': {
        try {
          const { portMr } = await import('../core/gitport')
          const destRepo = msg.payload.destRepo
          const mrUrl = await portMr(msg.payload.sourceMrUrl, destRepo, msg.payload.destBranch)
          post(v.webview, { type: 'GITPORT_RESULT', payload: { success: true, mrUrl } })
        } catch (err: any) {
          post(v.webview, { type: 'GITPORT_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'JIRA_SEARCH': {
        try {
          const { searchIssues } = await import('../core/jira')
          const issues = await searchIssues(msg.payload.jql, msg.payload.maxResults)
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: true, data: issues } })
        } catch (err: any) {
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'JIRA_ISSUE': {
        try {
          const { getIssue } = await import('../core/jira')
          const issue = await getIssue(msg.payload.issueKey)
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: true, data: issue } })
        } catch (err: any) {
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'JIRA_TRANSITION': {
        try {
          const { transitionIssue } = await import('../core/jira')
          await transitionIssue(msg.payload.issueKey, msg.payload.transitionId)
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: true } })
        } catch (err: any) {
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'JIRA_COMMENT': {
        try {
          const { addComment } = await import('../core/jira')
          await addComment(msg.payload.issueKey, msg.payload.comment)
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: true } })
        } catch (err: any) {
          post(v.webview, { type: 'JIRA_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SHAREPOINT_CREATE': {
        try {
          const { createWorkbook } = await import('../core/sharepoint')
          await createWorkbook(msg.payload.siteId, msg.payload.drivePath, msg.payload.fileName, msg.payload.data)
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: true } })
        } catch (err: any) {
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SHAREPOINT_READ': {
        try {
          const { readWorkbook } = await import('../core/sharepoint')
          const data = await readWorkbook(msg.payload.siteId, msg.payload.drivePath, msg.payload.fileName)
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: true, data } })
        } catch (err: any) {
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SHAREPOINT_APPEND': {
        try {
          const { appendToWorkbook } = await import('../core/sharepoint')
          await appendToWorkbook(msg.payload.siteId, msg.payload.drivePath, msg.payload.fileName, msg.payload.data)
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: true } })
        } catch (err: any) {
          post(v.webview, { type: 'SHAREPOINT_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'BROWSE_PACKAGES': {
        try {
          const { appName, org, space, filter } = msg.payload
          const packages = await packageBrowser.listRemotePackages(appName, org, space, filter)
          post(v.webview, {
            type: 'PACKAGES_LOADED',
            payload: { appName, packages, error: packages.length ? undefined : 'No packages found' },
          })
        } catch (err: any) {
          post(v.webview, {
            type: 'PACKAGES_LOADED',
            payload: { appName: msg.payload.appName, packages: [], error: err.message },
          })
        }
        break
      }

      case 'BROWSE_FILE': {
        try {
          const { appName, path, org, space } = msg.payload
          const content = await packageBrowser.readRemoteFile(appName, org, space, path)
          post(v.webview, {
            type: 'FILE_CONTENT',
            payload: { appName, path, content },
          })
        } catch (err: any) {
          this._log('err', `Browse file error: ${err.message}`)
        }
        break
      }

      case 'GET_XSUAA_TOKEN': {
        try {
          const { appName, org, space } = msg.payload
          const { getTokenCached } = await import('../core/xsuaa')
          const token = await getTokenCached(appName, org, space, this._log)
          if (token) {
            post(v.webview, { type: 'XSUAA_TOKEN_RESPONSE', payload: { token, expiresIn: 3600 } })
          } else {
            post(v.webview, { type: 'XSUAA_TOKEN_RESPONSE', payload: { error: 'No token obtained' } })
          }
        } catch (err: any) {
          post(v.webview, { type: 'XSUAA_TOKEN_RESPONSE', payload: { error: err.message } })
        }
        break
      }

      case 'SHOW_WATCHDOG': {
        const { showWatchdogPanel } = await import('../core/watchdog')
        showWatchdogPanel()
        break
      }

      case 'SYNC_LANDSCAPE': {
        try {
          const { getCredentials } = await import('../core/shellEnv')
          const creds = await getCredentials()
          if (!creds.email || !creds.password) {
            post(v.webview, { type: 'SYNC_STATUS', payload: { message: '<span style="color:var(--error)">Set SAP_EMAIL and SAP_PASSWORD in environment</span>' } })
            break
          }
          const { runFullSync } = await import('../core/cfSync')
          post(v.webview, { type: 'SYNC_STATUS', payload: { message: 'Syncing landscape...' } })
          await runFullSync(creds.email, creds.password, undefined, (msg) => {
            post(v.webview, { type: 'SYNC_STATUS', payload: { message: esc(msg) } })
          })
          post(v.webview, { type: 'SYNC_STATUS', payload: { message: '<span style="color:var(--success)">Sync complete</span>' } })
        } catch (err: any) {
          post(v.webview, { type: 'SYNC_STATUS', payload: { message: `<span style="color:var(--error)">${esc(err.message)}</span>` } })
        }
        break
      }

      case 'EXPLORER_LS': {
        try {
          const { appName, org, space, dir } = msg.payload
          const result = await packageBrowser.lsRemote(appName, org, space, dir)
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { result } })
        } catch (err: any) {
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { error: err.message } })
        }
        break
      }

      case 'EXPLORER_FIND': {
        try {
          const { appName, org, space, dir, query } = msg.payload
          const result = await packageBrowser.findRemoteFiles(appName, org, space, query, dir)
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { result } })
        } catch (err: any) {
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { error: err.message } })
        }
        break
      }

      case 'EXPLORER_GREP': {
        try {
          const { appName, org, space, query } = msg.payload
          const result = await packageBrowser.grepRemote(appName, org, space, query)
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { result: result.map(r => `${r.path}: ${r.line}`) } })
        } catch (err: any) {
          post(v.webview, { type: 'EXPLORER_RESULT', payload: { error: err.message } })
        }
        break
      }

      case 'BROWSE_FOLDER': {
        try {
          const { org, space } = msg.payload
          const folders = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: `Select local folder for org: ${org}` })
          if (folders && folders.length > 0) {
            const folderPath = folders[0].fsPath
            const { saveFolderMappings, loadFolderMappings } = await import('../storage/store')
            const mappings = loadFolderMappings()
            const existingIdx = mappings.findIndex(m => m.cfOrg === org)
            const mapping = { cfOrg: org, cfSpace: space ?? '', groupFolderPath: folderPath }
            if (existingIdx >= 0) mappings[existingIdx] = mapping
            else mappings.push(mapping)
            saveFolderMappings(mappings)
            this._log('ok', `Folder mapped: ${org} → ${folderPath}`)
            post(v.webview, { type: 'CONFIG_LOADED', payload: {
              config: (await import('../storage/store')).loadConfig(),
              activeSessions: (await import('../core/debugManager')).getActiveSessions(),
              folderMappings: loadFolderMappings(),
            }})
          }
        } catch (err: any) {
          this._log('err', `Folder browse error: ${err.message}`)
        }
        break
      }

      case 'RUN_SQL': {
        try {
          const { appName, org, space, sql } = msg.payload
          const { executeSql } = await import('../core/cfHana')
          const result = await executeSql(appName, org, space, sql, this._log)
          post(v.webview, { type: 'SQL_RESULT', payload: { columns: result.columns, rows: result.rows } })
        } catch (err: any) {
          post(v.webview, { type: 'SQL_RESULT', payload: { error: err.message } })
        }
        break
      }

      case 'START_TAIL': {
        try {
          const { appNames, org, space } = msg.payload
          const { startTailSession } = await import('../core/cfTail')
          startTailSession(appNames, org, space)
          this._log('info', `Tail started for ${appNames.length} app(s)`)
        } catch (err: any) {
          this._log('err', `Tail error: ${err.message}`)
        }
        break
      }

      case 'STOP_TAIL': {
        const { stopAllTailSessions } = await import('../core/cfTail')
        stopAllTailSessions()
        this._log('info', 'All tail sessions stopped')
        break
      }

      case 'CHECK_CONNECTION': {
        const { checkCfSession } = await import('../core/cfClient')
        const health = await checkCfSession()
        post(v.webview, { type: 'CONNECTION_HEALTH', payload: health })
        break
      }

      case 'RESTART_APP': {
        try {
          const { appName, org, space } = msg.payload
          const { cfTarget, cfRestart } = await import('../core/cfClient')
          await cfTarget(org, space)
          this._log('info', `Restarting ${appName}...`)
          await cfRestart(appName)
          this._log('ok', `${appName} restarted`)
          post(v.webview, { type: 'APP_RESTARTED', payload: { appName } })
        } catch (err: any) {
          this._log('err', `Restart failed: ${err.message}`)
        }
        break
      }

      case 'LIST_SERVICES': {
        try {
          const { appName, org, space } = msg.payload
          const { cfTarget, cfServiceList } = await import('../core/cfClient')
          await cfTarget(org, space)
          const services = await cfServiceList(appName)
          post(v.webview, { type: 'SERVICES_LOADED', payload: { appName, services } })
        } catch (err: any) {
          this._log('err', `List services failed: ${err.message}`)
        }
        break
      }

      case 'GET_EVENTS': {
        try {
          const { appName, org, space } = msg.payload
          const { cfTarget } = await import('../core/cfClient')
          await cfTarget(org, space)
          const { cfAppEvents } = await import('../core/cfEvents')
          const events = await cfAppEvents(appName)
          post(v.webview, { type: 'EVENTS_LOADED', payload: { appName, events } })
        } catch (err: any) {
          this._log('err', `Events fetch failed: ${err.message}`)
        }
        break
      }

      case 'GET_SPACE_EVENTS': {
        try {
          const { org, space } = msg.payload
          const { cfTarget } = await import('../core/cfClient')
          await cfTarget(org, space)
          const { cfSpaceEvents } = await import('../core/cfEvents')
          const events = await cfSpaceEvents()
          post(v.webview, { type: 'EVENTS_LOADED', payload: { events } })
        } catch (err: any) {
          this._log('err', `Space events fetch failed: ${err.message}`)
        }
        break
      }

      case 'START_TRACE': {
        try {
          const { appName, org, space } = msg.payload
          const { startTrace } = await import('../core/cfLiveTrace')
          await startTrace(appName, org, space)
          this._log('ok', `HTTP trace started for ${appName}`)
        } catch (err: any) {
          this._log('err', `Trace start failed: ${err.message}`)
        }
        break
      }

      case 'STOP_TRACE': {
        const { stopAllTraces } = await import('../core/cfLiveTrace')
        stopAllTraces()
        this._log('info', 'All traces stopped')
        break
      }

      case 'SET_BREAKPOINT': {
        try {
          const { appName, org, space, url, line, condition, logMessage } = msg.payload
          const { setBreakpoint } = await import('../core/cfInspector')
          const bpId = await setBreakpoint(appName, org, space, url, line, condition, logMessage)
          this._log('ok', `Breakpoint set: ${url}:${line}`)
        } catch (err: any) {
          this._log('err', `Breakpoint failed: ${err.message}`)
        }
        break
      }

      case 'REMOVE_BREAKPOINT': {
        try {
          const { appName, breakpointId } = msg.payload
          const { removeBreakpoint } = await import('../core/cfInspector')
          await removeBreakpoint(appName, breakpointId)
          this._log('ok', `Breakpoint ${breakpointId} removed`)
        } catch (err: any) {
          this._log('err', `Remove breakpoint failed: ${err.message}`)
        }
        break
      }

      case 'GET_STACK': {
        try {
          const { appName } = msg.payload
          const { getStack } = await import('../core/cfInspector')
          const stack = await getStack(appName)
          post(v.webview, { type: 'STACK_CAPTURE', payload: { appName, stack } })
        } catch (err: any) {
          this._log('err', `Stack capture failed: ${err.message}`)
        }
        break
      }

      case 'LIST_BREAKPOINTS': {
        try {
          const { appName } = msg.payload
          const { listBreakpoints } = await import('../core/cfInspector')
          const bps = listBreakpoints(appName)
          post(v.webview, { type: 'BREAKPOINT_LIST', payload: { appName, breakpoints: bps } })
        } catch (err: any) {
          this._log('err', `List breakpoints failed: ${err.message}`)
        }
        break
      }

      case 'RUN_QUERY': {
        try {
          const { appName, org, space, sql, params } = msg.payload
          const { executeParametrizedQuery } = await import('../core/cfHana')
          const result = await executeParametrizedQuery(appName, org, space, sql, params)
          post(v.webview, { type: 'QUERY_RESULT', payload: { columns: result.columns, rows: result.rows } })
        } catch (err: any) {
          post(v.webview, { type: 'QUERY_RESULT', payload: { error: err.message } })
        }
        break
      }

      case 'BEGIN_TRANSACTION': {
        try {
          const { appName, org, space } = msg.payload
          const { beginTransaction } = await import('../core/cfHana')
          const sessionId = await beginTransaction(appName, org, space)
          post(v.webview, { type: 'TRANSACTION_STARTED', payload: { sessionId } })
          this._log('ok', `Transaction started: ${sessionId}`)
        } catch (err: any) {
          this._log('err', `Transaction start failed: ${err.message}`)
        }
        break
      }

      case 'COMMIT': {
        try {
          const { sessionId } = msg.payload
          const { commit } = await import('../core/cfHana')
          await commit(sessionId)
          post(v.webview, { type: 'TRANSACTION_COMMITTED', payload: { sessionId } })
          this._log('ok', `Transaction committed: ${sessionId}`)
        } catch (err: any) {
          this._log('err', `Commit failed: ${err.message}`)
        }
        break
      }

      case 'ROLLBACK': {
        try {
          const { sessionId } = msg.payload
          const { rollback } = await import('../core/cfHana')
          await rollback(sessionId)
          post(v.webview, { type: 'TRANSACTION_ROLLED_BACK', payload: { sessionId } })
          this._log('ok', `Transaction rolled back: ${sessionId}`)
        } catch (err: any) {
          this._log('err', `Rollback failed: ${err.message}`)
        }
        break
      }

      case 'QUERY_FILTER': {
        try {
          const { appName, query, level, source, tenant, status, since } = msg.payload
          const { queryLogs } = await import('../core/logPipeline')
          const lines = queryLogs(appName, { query, level, source, tenant, status, since })
          post(v.webview, { type: 'QUERY_FILTERED', payload: { appName, lines } })
        } catch (err: any) {
          this._log('err', `Filter failed: ${err.message}`)
        }
        break
      }

      case 'DOWNLOAD_FILE': {
        try {
          const { appName, org, space, remotePath } = msg.payload
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          if (!ws) { this._log('warn', 'Open a workspace first'); break }
          const { downloadFile } = await import('../core/cfFiles')
          const result = await downloadFile(appName, org, space, remotePath, ws)
          this._log('ok', `Downloaded ${result.path} (${result.size}b)`)
          post(v.webview, { type: 'FILE_DOWNLOADED', payload: { appName, localPath: result.path, size: result.size } })
        } catch (err: any) {
          this._log('err', `Download failed: ${err.message}`)
        }
        break
      }

      case 'DOWNLOAD_FOLDER': {
        try {
          const { appName, org, space, remoteDir } = msg.payload
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          if (!ws) { this._log('warn', 'Open a workspace first'); break }
          const { downloadFolder } = await import('../core/cfFiles')
          const results = await downloadFolder(appName, org, space, remoteDir, ws)
          this._log('ok', `Downloaded ${results.length} files from ${remoteDir}`)
          post(v.webview, { type: 'FOLDER_DOWNLOADED', payload: { appName, files: results.length, localDir: ws } })
        } catch (err: any) {
          this._log('err', `Download folder failed: ${err.message}`)
        }
        break
      }

      case 'GEN_ENV': {
        try {
          const { appName, org, space } = msg.payload
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
          if (!ws) { this._log('warn', 'Open a workspace first'); break }
          const { genDefaultEnv } = await import('../core/cfFiles')
          const localPath = genDefaultEnv(appName, org, space, ws)
          this._log('ok', `default-env.json generated at ${localPath}`)
          post(v.webview, { type: 'ENV_GENERATED', payload: { appName, localPath } })
        } catch (err: any) {
          this._log('err', `Gen env failed: ${err.message}`)
        }
        break
      }

      case 'SET_EXCEPTION_BP': {
        try {
          const { appName, org, space } = msg.payload
          const { setExceptionBreakpoint } = await import('../core/cfInspector')
          await setExceptionBreakpoint(appName, org, space)
          this._log('ok', `Exception breakpoint set on ${appName}`)
          post(v.webview, { type: 'EXCEPTION_BP_SET', payload: { appName } })
        } catch (err: any) {
          this._log('err', `Exception BP failed: ${err.message}`)
        }
        break
      }

      case 'REMOVE_EXCEPTION_BP': {
        try {
          const { appName } = msg.payload
          const { removeExceptionBreakpoint } = await import('../core/cfInspector')
          await removeExceptionBreakpoint(appName)
          this._log('ok', `Exception breakpoint removed on ${appName}`)
        } catch (err: any) {
          this._log('err', `Remove exception BP failed: ${err.message}`)
        }
        break
      }

      case 'OPEN_DEVTOOLS': {
        try {
          const { appName, port } = msg.payload
          const debugPort = port || (await import('../core/debugManager')).getDebugPort(appName)
          if (!debugPort) { this._log('warn', `No active debug session for ${appName}`); break }
          const devtoolsUrl = `devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${debugPort}`
          vscode.env.openExternal(vscode.Uri.parse(devtoolsUrl))
          this._log('info', `DevTools opened for ${appName} on port ${debugPort}`)
        } catch (err: any) {
          this._log('err', `Open DevTools failed: ${err.message}`)
        }
        break
      }

      case 'CHANGE_DEBUG_PORT': {
        try {
          const { appName, port } = msg.payload
          this._debugPorts.set(appName, port)
          this._log('info', `Debug port for ${appName} set to ${port}`)
          post(v.webview, { type: 'DEBUG_PORT_CHANGED', payload: { appName, port } })
        } catch (err: any) {
          this._log('err', `Change port failed: ${err.message}`)
        }
        break
      }

      case 'GEN_SKILL': {
        try {
          const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || (await import('node:os')).homedir()
          const { generateAgentSkill, checkSmdgCli } = await import('../core/agentSkill')
          const smdgAvailable = checkSmdgCli()
          if (smdgAvailable && msg.payload?.useSmdg) {
            const { smdgGenerate } = await import('../core/agentSkill')
            const { existsSync } = await import('node:fs')
            const sources = [`${ws}/README.md`, `${ws}/package.json`].filter(existsSync)
            const result = await smdgGenerate(sources, 'cds-tool-cap-debugger', 'coding')
            if (result.success) {
              this._log('ok', `Smidge skill generated: ${result.skillPath}`)
              post(v.webview, { type: 'SMDG_SKILL_GENERATED', payload: { skillPath: result.skillPath, output: result.output } })
            } else {
              this._log('warn', `Smidge generation failed, using fallback: ${result.error}`)
              const skillPath = generateAgentSkill(ws, { name: 'cds-tool-cap-debugger', version: '1.0.0' })
              post(v.webview, { type: 'SKILL_GENERATED', payload: { localPath: skillPath } })
            }
          } else {
            const skillPath = generateAgentSkill(ws, { name: 'cds-tool-cap-debugger', version: '1.0.0' })
            this._log('ok', `AI agent skill generated at ${skillPath}`)
            post(v.webview, { type: 'SKILL_GENERATED', payload: { localPath: skillPath } })
          }
        } catch (err: any) {
          this._log('err', `Skill generation failed: ${err.message}`)
        }
        break
      }

      case 'SMDG_CHECK': {
        try {
          const { checkSmdgCli } = await import('../core/agentSkill')
          post(v.webview, { type: 'SMDG_STATUS', payload: { available: checkSmdgCli() } })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_STATUS', payload: { available: false } })
        }
        break
      }

      case 'SMDG_LOGIN': {
        try {
          const { smdgLogin } = await import('../core/agentSkill')
          const result = await smdgLogin()
          post(v.webview, { type: 'SMDG_RESULT', payload: result })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SMDG_LOGOUT': {
        try {
          const { smdgLogout } = await import('../core/agentSkill')
          const result = smdgLogout()
          post(v.webview, { type: 'SMDG_RESULT', payload: result })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SMDG_GENERATE': {
        try {
          const { smdgGenerate } = await import('../core/agentSkill')
          const result = await smdgGenerate(msg.payload.sources, msg.payload.name, msg.payload.category, msg.payload.install)
          if (result.success) {
            post(v.webview, { type: 'SMDG_SKILL_GENERATED', payload: { skillPath: result.skillPath, output: result.output } })
          } else {
            post(v.webview, { type: 'SMDG_RESULT', payload: result })
          }
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SMDG_INSTALL': {
        try {
          const { smdgInstall } = await import('../core/agentSkill')
          const result = smdgInstall(msg.payload.skillName, msg.payload.platform)
          post(v.webview, { type: 'SMDG_RESULT', payload: result })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SMDG_CREDITS': {
        try {
          const { smdgCredits } = await import('../core/agentSkill')
          const credits = smdgCredits()
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: true, output: credits } })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }

      case 'SMDG_LIST': {
        try {
          const { smdgListSkills } = await import('../core/agentSkill')
          const skills = smdgListSkills()
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: true, output: skills } })
        } catch (err: any) {
          post(v.webview, { type: 'SMDG_RESULT', payload: { success: false, error: err.message } })
        }
        break
      }
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:#0d1117;--fg:#e6edf3;--border:#30363d;--accent:#2d9bf0;--accent-hover:#58a6ff;--success:#3fb950;--error:#f85149;--warn:#d29922;--card:#161b22;--card-hover:#1c2128;--card-alt:#0d1117;--input-bg:#0d1117;--text-muted:#8b949e;--radius:10px;--shadow:0 4px 20px rgba(0,0,0,.4)}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif;padding:14px;color:var(--fg);background:var(--bg);font-size:13px;margin:0;line-height:1.6;overflow-x:hidden;-webkit-font-smoothing:antialiased}
.hidden{display:none!important}
.section{animation:fadeSlide .2s ease;margin-bottom:16px}
@keyframes fadeSlide{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes slideDown{from{opacity:0;max-height:0}to{opacity:1;max-height:400px}}
h3{margin:10px 0 8px;font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.2px;display:flex;align-items:center;gap:6px}
h3::before{content:'';display:inline-block;width:3px;height:14px;background:linear-gradient(180deg,var(--accent),#1f6feb);border-radius:3px}
label{display:block;margin:8px 0 4px;font-size:11px;color:var(--text-muted);font-weight:600;letter-spacing:.3px}
input,select,textarea{width:100%;box-sizing:border-box;margin:3px 0;padding:8px 12px;font-size:12.5px}
input,select,textarea{background:var(--input-bg);border:1px solid var(--border);color:var(--fg);border-radius:var(--radius);transition:all .2s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,155,240,.15)}
input::placeholder,textarea::placeholder{color:var(--text-muted);opacity:.5}
textarea{resize:vertical;min-height:60px;font-family:'SF Mono','SFMono-Regular','Menlo',monospace;font-size:11px;line-height:1.5}
button{background:linear-gradient(180deg,#238636,#196c2e);color:#fff;border:none;padding:8px 16px;cursor:pointer;border-radius:var(--radius);font-weight:600;transition:all .15s;display:inline-flex;align-items:center;justify-content:center;gap:7px;font-size:12.5px}
button:hover{background:linear-gradient(180deg,#2ea043,#238636);transform:translateY(-1px);box-shadow:0 3px 10px rgba(35,134,54,.3)}
button:active{transform:translateY(0)}
button:disabled{opacity:.3;cursor:default;transform:none;box-shadow:none}
.btn-primary{background:linear-gradient(180deg,var(--accent),#1f6feb)}
.btn-primary:hover{background:linear-gradient(180deg,#58a6ff,var(--accent));box-shadow:0 3px 10px rgba(45,155,240,.3)}
.btn-danger{background:linear-gradient(180deg,#da3633,#b62324)}
.btn-danger:hover{background:linear-gradient(180deg,#f85149,#da3633);box-shadow:0 3px 10px rgba(248,81,73,.3)}
.btn-success{background:linear-gradient(180deg,#238636,#196c2e)}
.btn-small{padding:5px 12px;font-size:11px;width:auto;border-radius:6px;font-weight:600}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--fg)}
.btn-outline:hover{background:var(--card-hover);border-color:var(--text-muted);transform:none;box-shadow:none}
.btn-ghost{background:transparent;color:var(--text-muted);padding:4px 8px;width:auto}
.btn-ghost:hover{background:var(--card-hover);color:var(--fg);transform:none;box-shadow:none}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.row button{flex:1;min-width:60px}
.app-item{display:flex;align-items:center;gap:10px;padding:7px 10px;transition:all .12s;border-radius:6px;margin:2px 0}
.app-item:hover{background:var(--card-hover)}
.app-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;font-size:12.5px;font-weight:500}
.app-check{width:auto;margin:0;accent-color:var(--accent);cursor:pointer;transform:scale(1.1)}
.state-started{color:var(--success);font-size:10.5px;font-weight:600;display:flex;align-items:center;gap:5px}
.state-started::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--success);animation:pulse 2s infinite;display:inline-block}
.state-stopped{color:var(--text-muted);font-size:10.5px}
.state-empty{color:var(--warn);font-size:10.5px}
.badge{display:inline-flex;align-items:center;font-size:9.5px;padding:2px 8px;background:linear-gradient(180deg,var(--accent),#1f6feb);color:#fff;border-radius:10px;cursor:pointer;transition:all .12s;font-weight:600;text-decoration:none}
.badge:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(45,155,240,.25)}
.pill{display:inline-flex;align-items:center;font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;letter-spacing:.3px;text-transform:uppercase}
.pill-env{background:linear-gradient(180deg,#238636,#196c2e);color:#fff}
.pill-none{background:var(--text-muted);color:#fff}
.pill-srv{background:linear-gradient(180deg,#1f6feb,#0d419d);color:#fff}
.pill-db{background:linear-gradient(180deg,#8957e5,#512a97);color:#fff}
.pill-ui{background:linear-gradient(180deg,#d29922,#9e6a03);color:#fff}
.pill-router{background:linear-gradient(180deg,#1f6feb,#0d419d);color:#fff}
.pill-job{background:linear-gradient(180deg,#8b949e,#484f58);color:#fff}
.filter-input{margin:4px 0;background:var(--input-bg);border:1px solid var(--border);border-radius:6px;padding:7px 12px;font-size:12px;color:var(--fg);width:100%;transition:all .2s}
.filter-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(45,155,240,.15)}
.section-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-bottom:10px;transition:all .2s}
.section-card:hover{border-color:rgba(45,155,240,.15)}
#loadingOverlay{position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px}
#loadingOverlay.hidden{display:none}
.spinner{width:18px;height:18px;border:2.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-text{font-size:13px;color:var(--text-muted);font-weight:500}
.project-group{margin-bottom:6px}
.project-header{display:flex;align-items:center;gap:8px;padding:6px 8px;cursor:pointer;border-radius:6px;transition:all .12s;font-size:12px;font-weight:700;color:var(--fg);user-select:none}
.project-header:hover{background:var(--card-hover)}
.project-header .arrow{font-size:7px;transition:transform .2s;color:var(--text-muted)}
.project-header .arrow.collapsed{transform:rotate(-90deg)}
.project-header .count{font-size:10px;color:var(--text-muted);font-weight:500;margin-left:auto;background:var(--input-bg);padding:1px 8px;border-radius:8px}
.project-children{border-left:2px solid var(--border);margin-left:12px;padding-left:8px;animation:slideDown .2s ease}
.inline-spinner{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);font-size:12px}
.tab-bar{display:flex;gap:3px;margin-bottom:12px;background:var(--card);border-radius:var(--radius);border:1px solid var(--border);padding:3px}
.tab-bar button{background:transparent;color:var(--text-muted);border:none;padding:7px 10px;font-size:11px;cursor:pointer;font-weight:600;transition:all .2s;border-radius:7px;flex:1;text-align:center}
.tab-bar button.active{color:#fff;background:linear-gradient(180deg,var(--accent),#1f6feb);box-shadow:0 2px 8px rgba(45,155,240,.25)}
.tab-bar button:hover:not(.active){color:var(--fg);background:var(--card-hover)}
.log-container{background:var(--input-bg);border:1px solid var(--border);border-radius:var(--radius);padding:8px;height:280px;overflow-y:auto;font-family:'SF Mono','SFMono-Regular','Menlo',monospace;font-size:10.5px;line-height:1.7}
.log-line{white-space:pre-wrap;word-break:break-all;color:var(--fg);padding:2px 6px;border-radius:3px}
.log-line:nth-child(odd){background:rgba(255,255,255,.02)}
.log-line:hover{background:rgba(45,155,240,.06)}
.server-info{font-size:11.5px;color:var(--text-muted);padding:10px 12px;background:var(--input-bg);border-radius:var(--radius);margin:6px 0;word-break:break-all;border:1px solid var(--border);line-height:1.6}
.session-card{background:var(--input-bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin:4px 0;display:flex;align-items:center;gap:10px;transition:all .15s}
.session-card:hover{border-color:rgba(45,155,240,.15)}
.status-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block}
.status-ATTACHED{background:var(--success);animation:pulse 2s infinite;box-shadow:0 0 6px rgba(63,185,80,.5)}
.status-CONNECTING{background:var(--warn);animation:pulse 1s infinite}
.status-TUNNELING{background:var(--accent);animation:pulse 1.5s infinite}
.status-ERROR{background:var(--error)}
.status-SIGNALING{background:var(--warn);animation:pulse 1s infinite}
.status-EXITED{background:var(--text-muted)}
.session-card .session-name{flex:1;font-weight:600;font-size:12px}
.session-card .session-status{font-size:10px;color:var(--text-muted);font-weight:600;letter-spacing:.5px}
.region-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:8px}
.region-btn{font-size:10px;padding:5px 8px;text-align:left;border:1px solid var(--border);background:var(--card);border-radius:6px;cursor:pointer;transition:all .12s;font-weight:500;color:var(--text-muted)}
.region-btn:hover{background:var(--card-hover);color:var(--fg);border-color:var(--accent)}
.region-btn.active{border-color:var(--accent);background:rgba(45,155,240,.1);color:var(--accent);font-weight:600}
.db-table{width:100%;border-collapse:collapse;font-size:11.5px}
.db-table td{padding:6px 8px;border-bottom:1px solid var(--border)}
.db-table td:first-child{font-weight:600;color:var(--text-muted);white-space:nowrap}
.db-table td:last-child{font-family:'SF Mono','SFMono-Regular','Menlo',monospace;font-size:10.5px;word-break:break-all}
.sql-table-wrap{overflow-x:auto;margin-top:8px;border:1px solid var(--border);border-radius:8px}
.sql-table{width:100%;border-collapse:collapse;font-size:10.5px;min-width:400px}
.sql-table th,.sql-table td{padding:5px 8px;border:1px solid var(--border);text-align:left;white-space:nowrap}
.sql-table th{background:var(--card);color:var(--text-muted);font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:.5px;position:sticky;top:0}
.sql-table tr:nth-child(even){background:rgba(255,255,255,.015)}
.sql-table tr:hover{background:rgba(45,155,240,.05)}
.tail-line{font-family:'SF Mono','SFMono-Regular','Menlo',monospace;font-size:10px;line-height:1.5;padding:1px 6px;border-radius:2px;white-space:pre-wrap;word-break:break-all}
.tail-line .app-tag{display:inline-block;font-size:8px;padding:1px 6px;border-radius:4px;margin-right:4px;font-weight:600}
.toast-container{position:fixed;bottom:12px;right:12px;z-index:99999;display:flex;flex-direction:column;gap:6px;max-width:320px}
.toast{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:11.5px;color:var(--fg);box-shadow:0 4px 16px rgba(0,0,0,.5);animation:slideIn .25s ease;display:flex;align-items:center;gap:8px;cursor:pointer;border-left:3px solid var(--accent)}
.toast.error{border-left-color:var(--error)}
.toast.success{border-left-color:var(--success)}
.toast.warn{border-left-color:var(--warn)}
@keyframes slideIn{from{opacity:0;transform:translateX(24px)}to{opacity:1;transform:translateX(0)}}
</style>
</head><body>
<div id="loadingOverlay"><div class="spinner"></div><div class="loading-text">Loading CDS Tool...</div></div>

<div class="tab-bar">
  <button class="active" data-tab="login">Login</button>
  <button data-tab="apps">Apps</button>
  <button data-tab="debug">Debug</button>
  <button data-tab="logs">Logs</button>
  <button data-tab="db">DB</button>
  <button data-tab="tools">Tools</button>
  <button data-tab="settings">&#9881;</button>
</div>

<div id="tab-login" class="section">
  <div class="section-card">
    <h3>Cloud Foundry Login</h3>
    <div id="cfLoggedInBanner" class="server-info hidden" style="background:var(--card-hover);border-left:3px solid var(--success);margin-bottom:8px"></div>
    <label>Region</label>
    <div id="regionGrid" style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px"></div>
    <div class="row" style="gap:4px">
      <select id="regionSelect" style="flex:1">
        <option value="">Custom...</option>
      </select>
      <button id="btnAddRegion" class="btn-small btn-outline" title="Save current endpoint as region">+</button>
    </div>
    <input id="apiEndpoint" placeholder="https://api.cf.us10.hana.ondemand.com">
    <label>Email <span id="credSource" class="pill pill-none">manual</span></label>
    <input type="email" id="email" placeholder="user@domain.com">
    <label>Password</label>
    <input type="password" id="password" placeholder="password">
    <div class="row" style="margin-top:8px">
      <button id="btnLogin">Login</button>
      <button id="btnLogout" class="btn-danger btn-small">Logout</button>
    </div>
    <div id="loginStatus" class="server-info" style="margin-top:8px">Waiting for login...</div>
    <div id="cfStatus" class="server-info" style="margin-top:4px;font-size:11px"></div>
    <div id="connectionStatus" class="server-info" style="margin-top:2px;font-size:11px"></div>
    <div class="row" style="margin-top:4px;gap:4px">
      <button id="btnCheckConnection" class="btn-small btn-outline">Check Connection</button>
    </div>
  </div>
</div>

<div id="tab-apps" class="section hidden">
  <div class="section-card">
    <h3>Organization &amp; Space</h3>
    <select id="orgSelect"><option value="">Select org...</option></select>
    <select id="spaceSelect"><option value="">Select space...</option></select>
    <div class="row" style="margin-top:6px">
      <button id="btnRefreshApps" class="btn-small btn-outline">Refresh Apps</button>
      <button id="btnBrowseFolder" class="btn-small btn-outline" title="Select local workspace folder for this org">Browse Folder</button>
    </div>
    <div id="folderMappingInfo" class="server-info hidden" style="font-size:10px;margin-top:4px"></div>
    <input id="appFilter" class="filter-input" placeholder="Filter apps...">
  </div>
  <div class="section-card">
    <h3>Applications</h3>
    <div id="appsList"></div>
  </div>
</div>

<div id="tab-debug" class="section hidden">
  <div class="section-card">
    <h3>Debug Sessions</h3>
    <div id="debugControls" class="hidden">
      <button id="btnStartDebug" class="btn-success">Start Debug Selected</button>
    </div>
    <div id="sessionsList"></div>
  </div>
  <div class="section-card">
    <h3>Launch Config</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Generate a <code>launch.json</code> entry for the currently selected org/space.</p>
    <button id="btnGenLaunchConfig" class="btn-small btn-outline">Generate launch.json</button>
    <div id="launchConfigStatus" class="server-info hidden" style="margin-top:6px"></div>
  </div>
  <div class="section-card">
    <h3>App Watchdog</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Monitors debugged apps every 90s. Alerts if unresponsive.</p>
    <div id="watchdogStatus" class="server-info">No apps watched</div>
    <button id="btnShowWatchdog" class="btn-small btn-outline">Show Watchdog</button>
  </div>
  <div class="section-card">
    <h3>HTTP Trace (cf-live-trace)</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Monkey-patches <code>http.createServer</code> via CDP to capture request/response traces.</p>
    <select id="traceAppSelect"><option value="">Select app...</option></select>
    <div class="row">
      <button id="btnStartTrace" class="btn-small btn-success">Start Trace</button>
      <button id="btnStopTrace" class="btn-small btn-danger">Stop Trace</button>
      <button id="btnClearTrace" class="btn-small btn-outline">Clear</button>
    </div>
    <div id="traceStatus" class="server-info hidden" style="font-size:10px"></div>
    <div id="traceContainer" class="log-container" style="max-height:200px;font-size:9.5px;margin-top:6px"></div>
  </div>
</div>

<div id="tab-logs" class="section hidden">
  <div class="section-card">
    <h3>Log Streaming</h3>
    <select id="logAppSelect"><option value="">Select app...</option></select>
    <div class="row">
      <button id="btnStartLogs" class="btn-small btn-success">Start</button>
      <button id="btnStopLogs" class="btn-small btn-danger">Stop</button>
      <button id="btnClearLogs" class="btn-small btn-outline">Clear</button>
    </div>
    <div id="logFilters" style="margin-top:6px;padding:6px;background:var(--card);border:1px solid var(--border);border-radius:6px">
      <div class="row" style="gap:4px;flex-wrap:wrap">
        <select id="logLevelFilter" style="flex:1;min-width:70px">
          <option value="">All levels</option>
          <option value="error">Error</option>
          <option value="warn">Warn</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <input id="logSourceFilter" placeholder="Source" style="flex:1;min-width:80px">
        <input id="logTenantFilter" placeholder="Tenant" style="flex:1;min-width:80px">
        <input id="logStatusFilter" placeholder="Status" style="flex:1;min-width:80px">
      </div>
      <div class="row" style="gap:4px;margin-top:4px">
        <input id="logSinceFilter" type="datetime-local" style="flex:1">
        <button id="btnApplyLogFilter" class="btn-small btn-outline" style="flex-shrink:0">Filter</button>
        <button id="btnClearLogFilter" class="btn-small" style="flex-shrink:0">Clear</button>
      </div>
    </div>
  </div>
  <div class="section-card">
    <div id="logContainer" class="log-container"></div>
  </div>
  <div class="section-card">
    <h3>Multi-App Log Tail</h3>
    <p style="font-size:10.5px;color:var(--text-muted);margin-bottom:6px">Stream logs from multiple selected apps simultaneously.</p>
    <button id="btnStartTail" class="btn-small btn-success">Start Tail All</button>
    <button id="btnStopTail" class="btn-small btn-danger">Stop Tail</button>
    <div id="tailContainer" class="log-container" style="max-height:200px;font-size:9.5px;margin-top:6px"></div>
    <div id="tailStatus" class="server-info hidden" style="font-size:10px"></div>
  </div>
</div>

<div id="tab-db" class="section hidden">
  <div class="section-card">
    <h3>HANA Database</h3>
    <select id="dbAppSelect"><option value="">Select app...</option></select>
    <div class="row">
      <button id="btnGetDbCreds">Get Credentials</button>
      <button id="btnListTables" class="btn-small btn-outline">List Tables</button>
    </div>
    <div id="dbInfo" class="server-info hidden"></div>
    <button id="btnAddDb" class="btn-success hidden">Add SQLTools Connection</button>
    <div id="sqlQueryArea" class="hidden" style="margin-top:8px">
      <textarea id="sqlInput" placeholder="SELECT * FROM TABLES" rows="3"></textarea>
      <div class="row">
        <button id="btnRunSql" class="btn-small btn-success">Run SQL</button>
        <button id="btnClearSql" class="btn-small btn-outline">Clear</button>
      </div>
      <div id="sqlResult"></div>
    </div>
  </div>
  <div class="section-card">
    <h3>XSUAA Token</h3>
    <select id="xsuaaAppSelect"><option value="">Select app...</option></select>
    <button id="btnGetToken">Get XSUAA Token</button>
    <div id="tokenStatus" class="server-info hidden"></div>
  </div>
  <div class="section-card">
    <h3>Package Browser</h3>
    <select id="pkgAppSelect"><option value="">Select app...</option></select>
    <div class="row" style="gap:4px">
      <input id="pkgRegexFilter" class="filter-input" placeholder="Filter by regex (e.g. @sap/)" style="flex:1">
    </div>
    <button id="btnBrowsePkg">Browse package.json</button>
    <div id="pkgList" class="server-info hidden"></div>
  </div>
  <div class="section-card">
    <h3>Remote Explorer</h3>
    <select id="explorerAppSelect"><option value="">Select app...</option></select>
    <div class="row" style="gap:4px">
      <input id="explorerPath" value="/home/vcap/app" style="flex:1;font-size:11px">
      <button id="btnLsRemote" class="btn-small btn-outline">ls</button>
      <button id="btnFindRemote" class="btn-small btn-outline">Find</button>
    </div>
    <div class="row" style="gap:4px;margin-top:4px">
      <input id="explorerQuery" placeholder="Grep query..." style="flex:1;font-size:11px">
      <button id="btnGrepRemote" class="btn-small btn-primary">Grep</button>
    </div>
    <div id="explorerOutput" class="server-info hidden"></div>
  </div>
</div>

<div id="tab-settings" class="section hidden">
  <div class="section-card">
    <h3>Settings</h3>
    <label>Remote Root Path</label>
    <input id="remoteRoot" value="/home/vcap/app" placeholder="/home/vcap/app">
    <label>SSH User (optional, for cf ssh)</label>
    <input id="sshUser" placeholder="cfuser" style="font-size:11px">
    <label>Package Regex Filter (default)</label>
    <input id="pkgRegexDefault" placeholder="e.g. ^@sap/" style="font-size:11px">
    <label>Folder Mappings</label>
    <div id="folderMappings"></div>
    <button id="btnAddMapping" class="btn-small btn-outline" style="margin-top:4px">+ Add Mapping</button>
    <button id="btnSaveSettings" class="btn-success" style="margin-top:8px">Save Settings</button>
    <div id="settingsStatus" class="server-info hidden"></div>
  </div>
  <div class="section-card">
    <h3>CF Landscape Sync</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Sync all regions/orgs/spaces/apps to a local cache file (~/.cds-tool/cf-structure.json)</p>
    <button id="btnSyncLandscape" class="btn-small">Start Sync</button>
    <div id="syncStatus" class="server-info hidden"></div>
  </div>
  <div class="section-card">
    <h3>Cache</h3>
    <div id="cacheInfo" class="server-info">No cached data</div>
    <button id="btnClearCache" class="btn-small btn-danger">Clear Cache</button>
  </div>
</div>

<div id="tab-tools" class="section hidden">
  <div class="section-card">
    <h3>File Operations</h3>
    <select id="toolsAppSelect"><option value="">Select app...</option></select>
    <label>Remote path</label>
    <input id="toolsRemotePath" placeholder="/home/vcap/app/package.json">
    <div class="row" style="gap:4px">
      <button id="btnDownloadFile" class="btn-small btn-success">Download File</button>
      <button id="btnDownloadFolder" class="btn-small btn-outline">Download Folder</button>
      <button id="btnGenEnv" class="btn-small btn-outline">Gen default-env.json</button>
    </div>
    <div id="downloadStatus" class="server-info hidden" style="margin-top:6px"></div>
  </div>
  <div class="section-card">
    <h3>Inspector &amp; DevTools</h3>
    <select id="inspectorAppSelect"><option value="">Select app...</option></select>
    <div class="row" style="gap:4px">
      <button id="btnOpenDevTools" class="btn-small">Open Chrome DevTools</button>
      <button id="btnSetExceptionBp" class="btn-small btn-outline">Exception BP</button>
      <button id="btnListBp" class="btn-small btn-outline">List BPs</button>
    </div>
    <div id="inspectorStatus" class="server-info hidden" style="margin-top:6px"></div>
  </div>
  <div class="section-card">
    <h3>Events &amp; Activity</h3>
    <select id="eventsAppSelect"><option value="">Select app...</option></select>
    <div class="row" style="gap:4px">
      <button id="btnGetEvents" class="btn-small">Get App Events</button>
      <button id="btnGetSpaceEvents" class="btn-small btn-outline">Space Events</button>
    </div>
    <div id="eventsList" class="server-info hidden" style="margin-top:6px;max-height:200px;overflow-y:auto"></div>
  </div>
  <div class="section-card">
    <h3>AI Skill</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Generate an AI skill so Claude, Cursor, Copilot can use cds-tool for CAP debugging.</p>
    <div id="smdgStatus" class="server-info hidden" style="font-size:10px;margin-bottom:4px"></div>
    <div class="row" style="gap:4px;flex-wrap:wrap">
      <button id="btnGenSkill" class="btn-small">Generate (local)</button>
      <button id="btnSmdgGenSkill" class="btn-small btn-outline">Generate (Smidge AI)</button>
      <button id="btnSmdgLogin" class="btn-small btn-outline">Smidge Login</button>
      <button id="btnSmdgCredits" class="btn-small btn-outline">Credits</button>
    </div>
    <div id="skillStatus" class="server-info hidden" style="margin-top:6px"></div>
  </div>
  <div class="section-card">
    <h3>XSUAA Token</h3>
    <select id="xsuaaAppSelect"><option value="">Select app...</option></select>
    <button id="btnGetToken" class="btn-small">Get XSUAA Token</button>
    <div id="tokenStatus" class="server-info hidden" style="margin-top:6px"></div>
  </div>
  <div class="section-card">
    <h3>Bruno API Runner</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Run Bruno collections against CF services with auto-injected XSUAA tokens.</p>
    <input id="brunoCollectionPath" placeholder="Path to Bruno collection" style="font-size:10px">
    <button id="btnBrunoRun" class="btn-small">Run Collection</button>
    <div id="brunoStatus" class="server-info hidden" style="margin-top:6px;font-size:10px"></div>
  </div>
  <div class="section-card">
    <h3>GitPort (GitLab MR)</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Port a GitLab MR into another repo as a Draft MR.</p>
    <input id="gitportSourceUrl" placeholder="Source MR URL" style="font-size:10px">
    <input id="gitportDestRepo" placeholder="Dest repo (git@... or https://...)" style="font-size:10px">
    <input id="gitportDestBranch" placeholder="Dest branch name" style="font-size:10px">
    <button id="btnGitportCreate" class="btn-small">Port MR</button>
    <div id="gitportStatus" class="server-info hidden" style="margin-top:6px;font-size:10px"></div>
  </div>
  <div class="section-card">
    <h3>Jira</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Search issues, get details, transition, or comment. Uses JiraOps OAuth token.</p>
    <input id="jiraInput" placeholder="JQL or issue key (e.g. PROJ-123)" style="font-size:10px">
    <div class="row" style="gap:4px">
      <button id="btnJiraSearch" class="btn-small">Search</button>
      <button id="btnJiraGet" class="btn-small btn-outline">Get Issue</button>
    </div>
    <div id="jiraStatus" class="server-info hidden" style="margin-top:6px;max-height:150px;overflow-y:auto;font-size:10px"></div>
  </div>
  <div class="section-card">
    <h3>SharePoint Excel</h3>
    <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Create, read, or append to SharePoint-hosted workbooks. Uses app-only Graph access.</p>
    <input id="spSiteId" placeholder="SharePoint site ID" style="font-size:10px">
    <input id="spDrivePath" placeholder="Drive path (e.g. /Shared Documents)" style="font-size:10px">
    <input id="spFileName" placeholder="File name (e.g. data.json)" style="font-size:10px">
    <div class="row" style="gap:4px">
      <button id="btnSpCreate" class="btn-small">Create</button>
      <button id="btnSpRead" class="btn-small btn-outline">Read</button>
      <button id="btnSpAppend" class="btn-small btn-outline">Append</button>
    </div>
    <div id="spStatus" class="server-info hidden" style="margin-top:6px;font-size:10px"></div>
  </div>
</div>

<script>
var vscode=acquireVsCodeApi()
var apps=[],activeSessions={},allApps=[]

function aLog(level,msg){vscode.postMessage({type:'LOG',payload:{level:level,message:msg}})}

document.getElementById('loadingOverlay').classList.add('hidden')

document.querySelectorAll('.tab-bar button').forEach(function(b){
  b.addEventListener('click',function(){
    var name=this.getAttribute('data-tab')
    document.querySelectorAll('[id^="tab-"]').forEach(function(t){t.classList.add('hidden')})
    document.querySelectorAll('.tab-bar button').forEach(function(x){x.classList.remove('active')})
    document.getElementById('tab-'+name).classList.remove('hidden')
    this.classList.add('active')
  })
})

document.getElementById('regionSelect').addEventListener('change',function(){
  if(this.value)document.getElementById('apiEndpoint').value=this.value
})
document.getElementById('btnAddRegion').addEventListener('click',function(){
  var api=document.getElementById('apiEndpoint').value.trim()
  if(!api){aLog('err','Enter an API endpoint first');return}
  var sel=document.getElementById('regionSelect')
  for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===api){aLog('info','Region already saved');return}}
  var opt=document.createElement('option')
  opt.value=api;opt.textContent=api.replace(/^https:\/\/api\./,'').replace(/\.hana\.ondemand\.com$/,'')
  sel.insertBefore(opt,sel.lastElementChild)
  sel.value=api
  vscode.postMessage({type:'SAVE_SETTINGS',payload:{remoteRoot:document.getElementById('remoteRoot').value.trim(),newEndpoint:api}})
  aLog('ok','Region saved: '+api)
})

document.getElementById('btnLogin').addEventListener('click',function(){
  var api=document.getElementById('apiEndpoint').value.trim()
  var email=document.getElementById('email').value
  var pw=document.getElementById('password').value
  if(!api||!email||!pw){
    document.getElementById('loginStatus').innerHTML='<span style="color:var(--error)">Fill in all fields</span>'
    aLog('err','Fill in all fields');return
  }
  aLog('info','Logging in to '+api+'...')
  document.getElementById('loginStatus').innerHTML='<span class="spinner" style="display:inline-block;vertical-align:middle;margin-right:4px"></span> Logging in...'
  this.disabled=true
  vscode.postMessage({type:'LOGIN',payload:{apiEndpoint:api,email:email,password:pw}})
})

document.getElementById('btnLogout').addEventListener('click',function(){
  aLog('info','Logging out')
  vscode.postMessage({type:'RESET_LOGIN'})
  document.getElementById('loginStatus').textContent='Logged out'
  document.getElementById('appsList').innerHTML=''
  document.getElementById('sessionsList').innerHTML=''
})

document.getElementById('orgSelect').addEventListener('change',function(){
  var org=this.value
  if(!org)return
  aLog('info','Loading spaces for '+org+'...')
  document.getElementById('spaceSelect').innerHTML='<option>Loading...</option>'
  document.getElementById('appsList').innerHTML=''
  vscode.postMessage({type:'LOAD_SPACES',payload:{org:org}})
})

document.getElementById('btnSaveSettings').addEventListener('click',function(){
  var root=document.getElementById('remoteRoot').value.trim()
  var sshUser=document.getElementById('sshUser').value.trim()
  var pkgRegex=document.getElementById('pkgRegexDefault').value.trim()
  vscode.postMessage({type:'SAVE_SETTINGS',payload:{remoteRoot:root,sshUser:sshUser||undefined,pkgRegexDefault:pkgRegex||undefined}})
  document.getElementById('settingsStatus').classList.remove('hidden')
  document.getElementById('settingsStatus').innerHTML='<span style="color:var(--success)">Settings saved</span>'
  aLog('ok','Settings saved')
})
document.getElementById('btnClearCache').addEventListener('click',function(){
  vscode.postMessage({type:'RESET_LOGIN'})
  document.getElementById('cacheInfo').innerHTML='Cache cleared'
  aLog('info','Cache cleared')
})

document.getElementById('spaceSelect').addEventListener('change',function(){
  var org=document.getElementById('orgSelect').value,space=this.value
  if(org&&space){aLog('info','Loading apps for '+org+'/'+space+'...');vscode.postMessage({type:'LOAD_APPS',payload:{org:org,space:space}})}
})

document.getElementById('btnRefreshApps').addEventListener('click',function(){
  var org=document.getElementById('orgSelect').value
  var space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org and space first');return}
  aLog('info','Loading apps for '+org+'/'+space+'...')
  vscode.postMessage({type:'LOAD_APPS',payload:{org:org,space:space}})
})

document.getElementById('appFilter').addEventListener('input',function(){
  var q=this.value.toLowerCase()
  apps=q?allApps.filter(function(a){return a.name.toLowerCase().includes(q)}):allApps
  renderApps(apps)
})

document.getElementById('btnStartDebug').addEventListener('click',function(){
  var checked=Array.from(document.querySelectorAll('.app-check:checked')).map(function(cb){return cb.value})
  if(!checked.length){aLog('warn','No apps selected');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  aLog('info','Starting debug for '+checked.length+' app(s): '+checked.join(', '))
  vscode.postMessage({type:'START_DEBUG',payload:{appNames:checked,org:org,space:space}})
})

document.getElementById('btnStartLogs').addEventListener('click',function(){
  var app=document.getElementById('logAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  aLog('info','Starting log stream for '+app)
  document.getElementById('logContainer').innerHTML=''
  vscode.postMessage({type:'STREAM_LOGS',payload:{appName:app,action:'start'}})
})

document.getElementById('btnStopLogs').addEventListener('click',function(){
  var app=document.getElementById('logAppSelect').value
  if(!app)return
  aLog('info','Stopping log stream for '+app)
  vscode.postMessage({type:'STREAM_LOGS',payload:{appName:app,action:'stop'}})
})

document.getElementById('btnClearLogs').addEventListener('click',function(){
  document.getElementById('logContainer').innerHTML=''
  aLog('info','Logs cleared')
})

document.getElementById('btnApplyLogFilter').addEventListener('click',function(){
  var app=document.getElementById('logAppSelect').value
  if(!app){aLog('warn','Select an app first');return}
  var level=document.getElementById('logLevelFilter').value
  var source=document.getElementById('logSourceFilter').value.trim()
  var tenant=document.getElementById('logTenantFilter').value.trim()
  var status=document.getElementById('logStatusFilter').value.trim()
  var since=document.getElementById('logSinceFilter').value
  vscode.postMessage({type:'QUERY_FILTER',payload:{appName:app,level:level||undefined,source:source||undefined,tenant:tenant||undefined,status:status||undefined,since:since||undefined}})
})

document.getElementById('btnClearLogFilter').addEventListener('click',function(){
  document.getElementById('logLevelFilter').value=''
  document.getElementById('logSourceFilter').value=''
  document.getElementById('logTenantFilter').value=''
  document.getElementById('logStatusFilter').value=''
  document.getElementById('logSinceFilter').value=''
})

document.getElementById('btnGetDbCreds').addEventListener('click',function(){
  var app=document.getElementById('dbAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  document.getElementById('dbInfo').classList.add('hidden')
  document.getElementById('btnAddDb').classList.add('hidden')
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  aLog('info','Getting DB credentials for '+app)
  vscode.postMessage({type:'GET_DB_CREDENTIALS',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnAddDb').addEventListener('click',function(){
  var creds=window.__lastDbCreds,app=window.__lastDbApp||document.getElementById('dbAppSelect').value
  if(!creds)return
  aLog('info','Adding SQLTools connection for '+app)
  vscode.postMessage({type:'ADD_DB_CONNECTION',payload:{appName:app,creds:creds}})
})

document.getElementById('btnGenLaunchConfig').addEventListener('click',function(){
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var api=document.getElementById('apiEndpoint').value.trim()
  if(!org||!space){aLog('warn','Select org and space first');return}
  var cfg={
    version:'0.2.0',
    configurations:[{
      type:'node',
      request:'attach',
      name:'CDS: '+org+'/'+space,
      address:'localhost',
      port:9229,
      localRoot:'\${workspaceFolder}',
      remoteRoot:'/home/vcap/app',
      protocol:'inspector',
      skipFiles:['<node_internals>/**']
    }]
  }
  vscode.postMessage({type:'GENERATE_LAUNCH_CONFIG',payload:{config:cfg,org:org,space:space,apiEndpoint:api}})
  var status=document.getElementById('launchConfigStatus')
  status.classList.remove('hidden')
  status.innerHTML='<span style="color:var(--success)">launch.json generated</span>'
  aLog('ok','Launch config generated for '+org+'/'+space)
})

document.getElementById('btnBrowsePkg').addEventListener('click',function(){
  var app=document.getElementById('pkgAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var filterInput=document.getElementById('pkgRegexFilter')
  var pkgDefault=document.getElementById('pkgRegexDefault').value.trim()
  if(!filterInput.value.trim()&&pkgDefault)filterInput.value=pkgDefault
  var filter=filterInput.value.trim()
  aLog('info','Browsing packages for '+app)
  document.getElementById('pkgList').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Listing packages...'
  document.getElementById('pkgList').classList.remove('hidden')
  vscode.postMessage({type:'BROWSE_PACKAGES',payload:{appName:app,org:org,space:space,filter:filter}})
})

document.getElementById('btnGetToken').addEventListener('click',function(){
  var app=document.getElementById('xsuaaAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  aLog('info','Getting XSUAA token for '+app)
  document.getElementById('tokenStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Getting token...'
  document.getElementById('tokenStatus').classList.remove('hidden')
  vscode.postMessage({type:'GET_XSUAA_TOKEN',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnBrunoRun').addEventListener('click',function(){
  var path=document.getElementById('brunoCollectionPath').value.trim()
  if(!path){aLog('warn','Enter Bruno collection path');return}
  document.getElementById('brunoStatus').classList.remove('hidden')
  document.getElementById('brunoStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Running Bruno collection...'
  vscode.postMessage({type:'BRUNO_RUN',payload:{collectionPath:path}})
})

document.getElementById('btnGitportCreate').addEventListener('click',function(){
  var url=document.getElementById('gitportSourceUrl').value.trim()
  var repo=document.getElementById('gitportDestRepo').value.trim()
  var branch=document.getElementById('gitportDestBranch').value.trim()
  if(!url||!repo||!branch){aLog('warn','Fill in all GitPort fields');return}
  document.getElementById('gitportStatus').classList.remove('hidden')
  document.getElementById('gitportStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Porting MR...'
  vscode.postMessage({type:'GITPORT_CREATE',payload:{sourceMrUrl:url,destRepo:repo,destBranch:branch}})
})

document.getElementById('btnJiraSearch').addEventListener('click',function(){
  var q=document.getElementById('jiraInput').value.trim()
  if(!q){aLog('warn','Enter JQL query');return}
  document.getElementById('jiraStatus').classList.remove('hidden')
  document.getElementById('jiraStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Searching...'
  vscode.postMessage({type:'JIRA_SEARCH',payload:{jql:q}})
})

document.getElementById('btnJiraGet').addEventListener('click',function(){
  var key=document.getElementById('jiraInput').value.trim()
  if(!key){aLog('warn','Enter issue key');return}
  document.getElementById('jiraStatus').classList.remove('hidden')
  document.getElementById('jiraStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Loading...'
  vscode.postMessage({type:'JIRA_ISSUE',payload:{issueKey:key}})
})

document.getElementById('btnSpCreate').addEventListener('click',function(){
  var sid=document.getElementById('spSiteId').value.trim()
  var dp=document.getElementById('spDrivePath').value.trim()
  var fn=document.getElementById('spFileName').value.trim()
  if(!sid||!dp||!fn){aLog('warn','Fill in SharePoint fields');return}
  document.getElementById('spStatus').classList.remove('hidden')
  document.getElementById('spStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Creating...'
  vscode.postMessage({type:'SHAREPOINT_CREATE',payload:{siteId:sid,drivePath:dp,fileName:fn,data:[]}})
})

document.getElementById('btnSpRead').addEventListener('click',function(){
  var sid=document.getElementById('spSiteId').value.trim()
  var dp=document.getElementById('spDrivePath').value.trim()
  var fn=document.getElementById('spFileName').value.trim()
  if(!sid||!dp||!fn){aLog('warn','Fill in SharePoint fields');return}
  document.getElementById('spStatus').classList.remove('hidden')
  document.getElementById('spStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Reading...'
  vscode.postMessage({type:'SHAREPOINT_READ',payload:{siteId:sid,drivePath:dp,fileName:fn}})
})

document.getElementById('btnSpAppend').addEventListener('click',function(){
  var sid=document.getElementById('spSiteId').value.trim()
  var dp=document.getElementById('spDrivePath').value.trim()
  var fn=document.getElementById('spFileName').value.trim()
  if(!sid||!dp||!fn){aLog('warn','Fill in SharePoint fields');return}
  document.getElementById('spStatus').classList.remove('hidden')
  document.getElementById('spStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Appending...'
  vscode.postMessage({type:'SHAREPOINT_APPEND',payload:{siteId:sid,drivePath:dp,fileName:fn,data:[]}})
})

document.getElementById('btnShowWatchdog').addEventListener('click',function(){
  vscode.postMessage({type:'SHOW_WATCHDOG'})
})

document.getElementById('btnSyncLandscape').addEventListener('click',function(){
  var status=document.getElementById('syncStatus')
  status.classList.remove('hidden')
  status.innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Starting sync...'
  vscode.postMessage({type:'SYNC_LANDSCAPE'})
})

document.getElementById('btnLsRemote').addEventListener('click',function(){
  var app=document.getElementById('explorerAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var dir=document.getElementById('explorerPath').value.trim()||'/home/vcap/app'
  document.getElementById('explorerOutput').classList.remove('hidden')
  document.getElementById('explorerOutput').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Listing...'
  vscode.postMessage({type:'EXPLORER_LS',payload:{appName:app,org:org,space:space,dir:dir}})
})

document.getElementById('btnFindRemote').addEventListener('click',function(){
  var app=document.getElementById('explorerAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var dir=document.getElementById('explorerPath').value.trim()||'/home/vcap/app'
  document.getElementById('explorerOutput').classList.remove('hidden')
  document.getElementById('explorerOutput').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Finding...'
  vscode.postMessage({type:'EXPLORER_FIND',payload:{appName:app,org:org,space:space,dir:dir,query:'*.js'}})
})

document.getElementById('btnGrepRemote').addEventListener('click',function(){
  var app=document.getElementById('explorerAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var query=document.getElementById('explorerQuery').value.trim()
  if(!query){aLog('warn','Enter a grep query');return}
  document.getElementById('explorerOutput').classList.remove('hidden')
  document.getElementById('explorerOutput').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Grepping...'
  vscode.postMessage({type:'EXPLORER_GREP',payload:{appName:app,org:org,space:space,query:query}})
})

document.getElementById('btnBrowseFolder').addEventListener('click',function(){
  var org=document.getElementById('orgSelect').value
  if(!org){aLog('warn','Select an org first');return}
  var space=document.getElementById('spaceSelect').value
  vscode.postMessage({type:'BROWSE_FOLDER',payload:{org:org,space:space}})
})

document.getElementById('btnListTables').addEventListener('click',function(){
  var app=document.getElementById('dbAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  document.getElementById('sqlQueryArea').classList.remove('hidden')
  document.getElementById('sqlInput').value='SELECT TABLE_NAME, TABLE_TYPE, SCHEMA_NAME FROM TABLES ORDER BY TABLE_NAME'
  document.getElementById('sqlResult').innerHTML='<span class="spinner"></span> Loading tables...'
  vscode.postMessage({type:'RUN_SQL',payload:{appName:app,org:org,space:space,sql:document.getElementById('sqlInput').value}})
})

document.getElementById('btnRunSql').addEventListener('click',function(){
  var app=document.getElementById('dbAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  var sql=document.getElementById('sqlInput').value.trim()
  if(!sql){aLog('warn','Enter SQL query');return}
  document.getElementById('sqlResult').innerHTML='<span class="spinner"></span> Executing...'
  vscode.postMessage({type:'RUN_SQL',payload:{appName:app,org:org,space:space,sql:sql}})
})

document.getElementById('btnClearSql').addEventListener('click',function(){
  document.getElementById('sqlInput').value=''
  document.getElementById('sqlResult').innerHTML=''
})

document.getElementById('btnStartTail').addEventListener('click',function(){
  var checked=Array.from(document.querySelectorAll('.app-check:checked')).map(function(cb){return cb.value})
  if(!checked.length){aLog('warn','Select apps in the Apps tab first');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  document.getElementById('tailContainer').innerHTML=''
  document.getElementById('tailStatus').classList.remove('hidden')
  document.getElementById('tailStatus').innerHTML='<span class="spinner" style="display:inline-block;margin-right:4px"></span> Tailing '+checked.length+' app(s)...'
  vscode.postMessage({type:'START_TAIL',payload:{appNames:checked,org:org,space:space}})
})

document.getElementById('btnStopTail').addEventListener('click',function(){
  vscode.postMessage({type:'STOP_TAIL'})
  document.getElementById('tailStatus').innerHTML='Stopped'
  document.getElementById('tailStatus').classList.remove('hidden')
  aLog('info','Tail stopped')
})

document.getElementById('btnCheckConnection').addEventListener('click',function(){
  vscode.postMessage({type:'CHECK_CONNECTION'})
})

// --- Trace buttons ---
document.getElementById('btnStartTrace').addEventListener('click',function(){
  var app=document.getElementById('traceAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  vscode.postMessage({type:'START_TRACE',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnStopTrace').addEventListener('click',function(){
  vscode.postMessage({type:'STOP_TRACE'})
  document.getElementById('traceStatus').classList.remove('hidden')
  document.getElementById('traceStatus').innerHTML='Trace stopped'
})

document.getElementById('btnClearTrace').addEventListener('click',function(){
  document.getElementById('traceContainer').innerHTML=''
  document.getElementById('traceContainer').classList.add('hidden')
  document.getElementById('traceStatus').classList.add('hidden')
})

// --- Tools tab buttons ---
document.getElementById('btnDownloadFile').addEventListener('click',function(){
  var app=document.getElementById('toolsAppSelect').value,path=document.getElementById('toolsRemotePath').value.trim()
  if(!app||!path){aLog('warn','Select app and enter remote path');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  document.getElementById('downloadStatus').classList.remove('hidden')
  document.getElementById('downloadStatus').innerHTML='<span class="spinner"></span> Downloading...'
  vscode.postMessage({type:'DOWNLOAD_FILE',payload:{appName:app,org:org,space:space,remotePath:path}})
})

document.getElementById('btnDownloadFolder').addEventListener('click',function(){
  var app=document.getElementById('toolsAppSelect').value,path=document.getElementById('toolsRemotePath').value.trim()
  if(!app||!path){aLog('warn','Select app and enter remote path');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  document.getElementById('downloadStatus').classList.remove('hidden')
  document.getElementById('downloadStatus').innerHTML='<span class="spinner"></span> Downloading folder...'
  vscode.postMessage({type:'DOWNLOAD_FOLDER',payload:{appName:app,org:org,space:space,remoteDir:path}})
})

document.getElementById('btnGenEnv').addEventListener('click',function(){
  var app=document.getElementById('toolsAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  document.getElementById('downloadStatus').classList.remove('hidden')
  document.getElementById('downloadStatus').innerHTML='<span class="spinner"></span> Generating...'
  vscode.postMessage({type:'GEN_ENV',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnOpenDevTools').addEventListener('click',function(){
  var app=document.getElementById('inspectorAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  vscode.postMessage({type:'OPEN_DEVTOOLS',payload:{appName:app}})
})

document.getElementById('btnSetExceptionBp').addEventListener('click',function(){
  var app=document.getElementById('inspectorAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  vscode.postMessage({type:'SET_EXCEPTION_BP',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnListBp').addEventListener('click',function(){
  var app=document.getElementById('inspectorAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  vscode.postMessage({type:'LIST_BREAKPOINTS',payload:{appName:app}})
})

document.getElementById('btnGetEvents').addEventListener('click',function(){
  var app=document.getElementById('eventsAppSelect').value
  if(!app){aLog('warn','Select an app');return}
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  document.getElementById('eventsList').classList.remove('hidden')
  document.getElementById('eventsList').innerHTML='<span class="spinner"></span> Loading events...'
  vscode.postMessage({type:'GET_EVENTS',payload:{appName:app,org:org,space:space}})
})

document.getElementById('btnGetSpaceEvents').addEventListener('click',function(){
  var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
  if(!org||!space){aLog('warn','Select org/space first');return}
  document.getElementById('eventsList').classList.remove('hidden')
  document.getElementById('eventsList').innerHTML='<span class="spinner"></span> Loading space events...'
  vscode.postMessage({type:'GET_SPACE_EVENTS',payload:{org:org,space:space}})
})

document.getElementById('btnGenSkill').addEventListener('click',function(){
  document.getElementById('skillStatus').classList.remove('hidden')
  document.getElementById('skillStatus').innerHTML='<span class="spinner"></span> Generating AI skill...'
  vscode.postMessage({type:'GEN_SKILL',payload:{}})
})

document.getElementById('btnSmdgGenSkill').addEventListener('click',function(){
  document.getElementById('skillStatus').classList.remove('hidden')
  document.getElementById('skillStatus').innerHTML='<span class="spinner"></span> Generating skill via Smidge AI...'
  vscode.postMessage({type:'GEN_SKILL',payload:{useSmdg:true}})
})

document.getElementById('btnSmdgLogin').addEventListener('click',function(){
  document.getElementById('smdgStatus').classList.remove('hidden')
  document.getElementById('smdgStatus').innerHTML='<span class="spinner"></span> Logging into Smidge...'
  vscode.postMessage({type:'SMDG_LOGIN'})
})

document.getElementById('btnSmdgCredits').addEventListener('click',function(){
  document.getElementById('smdgStatus').classList.remove('hidden')
  document.getElementById('smdgStatus').innerHTML='<span class="spinner"></span> Checking credits...'
  vscode.postMessage({type:'SMDG_CREDITS'})
})

// Auto-refresh apps every 30s
var autoRefreshTimer=null
function startAutoRefresh(){
  if(autoRefreshTimer)clearInterval(autoRefreshTimer)
  autoRefreshTimer=setInterval(function(){
    var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
    if(org&&space)vscode.postMessage({type:'LOAD_APPS',payload:{org:org,space:space,force:true}})
  },30000)
}
function stopAutoRefresh(){
  if(autoRefreshTimer){clearInterval(autoRefreshTimer);autoRefreshTimer=null}
}

window.addEventListener('message',function(e){
  var msg=e.data
  switch(msg.type){
    case 'LOGIN_SUCCESS':
      document.getElementById('btnLogin').disabled=false
      document.getElementById('loginStatus').innerHTML='<span style="color:var(--success)">Connected to '+msg.payload.apiEndpoint+'</span>'
      aLog('ok','Connected to '+msg.payload.apiEndpoint)
      document.getElementById('orgSelect').innerHTML='<option value="">Loading...</option>'
      // Check connection status right after login
      vscode.postMessage({type:'CHECK_CONNECTION'})
      populateOrgs(msg.payload.orgs)
      showTab('apps')
      break
    case 'LOGIN_ERROR':
      document.getElementById('btnLogin').disabled=false
      document.getElementById('loginStatus').innerHTML='<span style="color:var(--error)">'+esc(msg.payload.message)+'</span>'
      aLog('err','Login failed: '+msg.payload.message)
      break
    case 'LOGOUT':
      stopAutoRefresh()
      break
    case 'SPACES_LOADED':{
      var sel=document.getElementById('spaceSelect')
      var spaces=msg.payload.spaces
      sel.innerHTML='<option value="">Select space...</option>'+spaces.map(function(s){return '<option value="'+esc(s)+'">'+esc(s)+'</option>'}).join('')
      aLog('ok','Loaded '+spaces.length+' space(s)')
      if(spaces.length==1){
        sel.value=spaces[0]
        var org=document.getElementById('orgSelect').value
        aLog('info','Loading apps for '+org+'/'+spaces[0]+'...')
        vscode.postMessage({type:'LOAD_APPS',payload:{org:org,space:spaces[0]}})
      }
      break
    }
    case 'APPS_LOADED':
      allApps=msg.payload.apps
      apps=allApps
      renderApps(apps)
      populateSelect('logAppSelect',apps)
      populateSelect('dbAppSelect',apps)
      populateSelect('pkgAppSelect',apps)
      populateSelect('explorerAppSelect',apps)
      populateSelect('toolsAppSelect',apps)
      populateSelect('inspectorAppSelect',apps)
      populateSelect('eventsAppSelect',apps)
      populateSelect('traceAppSelect',apps)
      populateSelect('xsuaaAppSelect',apps)
      aLog('info','Loaded '+apps.length+' app(s)'+(msg.payload.fromCache?' (cached)':''))
      startAutoRefresh()
      break
    case 'APPS_ERROR':
      document.getElementById('appsList').innerHTML='<div style="color:var(--error)">'+esc(msg.payload.message)+'</div>'
      aLog('err',msg.payload.message)
      break
    case 'DEBUG_CONNECTING':
      for(var i=0;i<msg.payload.appNames.length;i++)activeSessions[msg.payload.appNames[i]]='CONNECTING'
      renderSessions()
      showTab('debug')
      aLog('info','Debug connecting: '+msg.payload.appNames.join(', '))
      break
    case 'SESSION_UPDATED':
      activeSessions[msg.payload.appName]=msg.payload.status
      renderSessions()
      break
    case 'APP_DEBUG_STATUS':
      activeSessions[msg.payload.appName]=msg.payload.status
      renderSessions()
      aLog(msg.payload.status==='ATTACHED'?'ok':'warn',msg.payload.appName+': '+msg.payload.status+(msg.payload.message?': '+msg.payload.message:''))
      break
    case 'LOGS_LINE':{
      var cont=document.getElementById('logContainer')
      var div=document.createElement('div');div.className='log-line';div.textContent=msg.payload.line
      cont.appendChild(div);cont.scrollTop=cont.scrollHeight
      break
    }
    case 'CONFIG_LOADED':{
      var cfConfig=msg.payload.config
      if(cfConfig){
        var c=cfConfig
        if(c.apiEndpoint){
          document.getElementById('apiEndpoint').value=c.apiEndpoint
        }
        if(c.orgs&&c.orgs.length)populateOrgs(c.orgs)
        if(c.lastOrg)setSelectValue('orgSelect',c.lastOrg)
        if(c.lastSpace)setSelectValue('spaceSelect',c.lastSpace)
        if(c.remoteRoot)document.getElementById('remoteRoot').value=c.remoteRoot
        if(c.sshUser)document.getElementById('sshUser').value=c.sshUser
        // Populate region selector
        populateRegionSelect(c.knownEndpoints||[],c.apiEndpoint)
      }
      if(msg.payload.defaultEmail){
        document.getElementById('email').value=msg.payload.defaultEmail
      }
      if(msg.payload.defaultPassword){
        document.getElementById('password').value=msg.payload.defaultPassword
      }
      if(msg.payload.credentialSource==='env'){
        document.getElementById('credSource').textContent='auto-detected'
        document.getElementById('credSource').className='pill pill-env'
      }
      // Auto-detect cf target (already logged in via cf CLI)
      var ct=msg.payload.cfTarget
      if(ct&&ct.apiEndpoint){
        var banner=document.getElementById('cfLoggedInBanner')
        banner.classList.remove('hidden')
        banner.innerHTML='<b>Already logged in</b> as '+esc(ct.user)+'<br><span style="font-size:11px">'+esc(ct.apiEndpoint)+' &middot; '+esc(ct.org)+'/'+esc(ct.space)+'</span>'
        document.getElementById('apiEndpoint').value=ct.apiEndpoint
        document.getElementById('loginStatus').innerHTML='<span style="color:var(--success)">&#9679; Detected CF session</span>'
        aLog('info','Detected CF session: '+ct.apiEndpoint+' as '+ct.user)
      }
      // Show cache info
      var cacheDiv=document.getElementById('cacheInfo')
      if(msg.payload.cachedRegions&&msg.payload.cachedRegions.length){
        var total=0;msg.payload.cachedRegions.forEach(function(r){r.orgs.forEach(function(o){total+=o.spaces.length})})
        cacheDiv.innerHTML='<span style="color:var(--success)">&#9679;</span> '+msg.payload.cachedRegions.length+' region(s), '+total+' space(s) cached'
      }else{cacheDiv.innerHTML='No cached data'}
      // Show folder mappings
      if(msg.payload.folderMappings&&msg.payload.folderMappings.length){
        var fm=document.getElementById('folderMappings')
        fm.innerHTML=msg.payload.folderMappings.map(function(m,i){
          return '<div style="font-size:11px;padding:3px 0;display:flex;align-items:center;gap:4px"><span style="flex:1">'+esc(m.cfOrg)+'/'+esc(m.cfSpace)+'</span><span style="color:var(--text-muted)">'+esc(m.groupFolderPath)+'</span></div>'
        }).join('')
      }
      activeSessions={}
      if(msg.payload.activeSessions)for(var i=0;i<msg.payload.activeSessions.length;i++)activeSessions[msg.payload.activeSessions[i]]='ATTACHED'
      renderSessions()
      aLog('info','Config loaded'+(msg.payload.credentialSource==='env'?' (auto-detected)':''))
      // Check connection health
      vscode.postMessage({type:'CHECK_CONNECTION'})
      break
    }

    case 'SETTINGS_LOADED':{
      if(msg.payload.remoteRoot)document.getElementById('remoteRoot').value=msg.payload.remoteRoot
      if(msg.payload.sshUser)document.getElementById('sshUser').value=msg.payload.sshUser
      if(msg.payload.pkgRegexDefault)document.getElementById('pkgRegexDefault').value=msg.payload.pkgRegexDefault
      var fm=document.getElementById('folderMappings')
      if(msg.payload.folderMappings&&msg.payload.folderMappings.length){
        fm.innerHTML=msg.payload.folderMappings.map(function(m){
          return '<div style="font-size:11px;padding:3px 0;display:flex;align-items:center;gap:4px"><span style="flex:1">'+esc(m.cfOrg)+'/'+esc(m.cfSpace)+'</span><span style="color:var(--text-muted)">'+esc(m.groupFolderPath)+'</span></div>'
        }).join('')
      }
      break
    }

    case 'PACKAGES_LOADED':{
      var pkgDiv=document.getElementById('pkgList')
      if(msg.payload.error){
        aLog('err','Browse packages: '+msg.payload.error)
        pkgDiv.innerHTML='<span style="color:var(--error)">'+esc(msg.payload.error)+'</span>'
      }else{
        aLog('ok','Found '+msg.payload.packages.length+' packages in '+msg.payload.appName)
        pkgDiv.innerHTML=msg.payload.packages.map(function(p,i){
          return '<div style="padding:2px 0;font-size:11px;cursor:pointer;color:var(--accent)" data-path="'+esc(p)+'" data-app="'+esc(msg.payload.appName)+'" class="pkg-item">'+(i+1)+'. '+esc(p)+'</div>'
        }).join('')
        pkgDiv.querySelectorAll('.pkg-item').forEach(function(el){
          el.addEventListener('click',function(){
            var app=this.getAttribute('data-app'),path=this.getAttribute('data-path')
            var org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
            vscode.postMessage({type:'BROWSE_FILE',payload:{appName:app,path:path,org:org,space:space}})
            aLog('info','Reading '+path+' from '+app)
            this.style.color='var(--text-muted)'
          })
        })
      }
      break
    }

    case 'FILE_CONTENT':{
      var aLogMsg='File: '+msg.payload.path+' ('+msg.payload.content.length+' chars)'
      aLog('info',aLogMsg)
      var pkgDiv=document.getElementById('pkgList')
      var pre=document.createElement('pre')
      pre.style.cssText='font-size:10px;line-height:1.4;max-height:300px;overflow:auto;background:var(--card-hover);padding:8px;border-radius:4px;margin-top:6px;white-space:pre-wrap;word-break:break-all'
      pre.textContent=msg.payload.content.length>3000?msg.payload.content.substring(0,3000)+'\n\n... (truncated)':msg.payload.content
      var existing=pkgDiv.querySelector('pre')
      if(existing)existing.remove()
      pkgDiv.appendChild(pre)
      break
    }
    case 'DB_CREDENTIALS':{
      var div=document.getElementById('dbInfo'),btn=document.getElementById('btnAddDb')
      window.__lastDbCreds=msg.payload.creds;window.__lastDbApp=msg.payload.appName
      if(msg.payload.creds){
        div.classList.remove('hidden')
        var html='<table class="db-table" style="width:100%;border-collapse:collapse;font-size:11.5px">'
        html+=row('Host',esc(msg.payload.creds.host)+':'+msg.payload.creds.port)
        html+=row('Database',esc(msg.payload.creds.database))
        html+=row('User',esc(msg.payload.creds.user))
        html+=row('Schema',esc(msg.payload.creds.schema||'(default)'))
        html+=row('Password','<span style="font-family:monospace">'+esc(msg.payload.creds.password)+'</span>')
        html+='</table>'
        div.innerHTML=html
        btn.classList.remove('hidden')
        aLog('ok','DB credentials found for '+msg.payload.appName)
      }else{div.classList.remove('hidden');div.textContent='No HANA credentials found';btn.classList.add('hidden');aLog('warn','No HANA credentials for '+msg.payload.appName)}
      break
    }
    case 'DB_CONNECTION_ADDED':
      document.getElementById('dbInfo').textContent='SQLTools connection added for '+msg.payload.appName
      document.getElementById('btnAddDb').classList.add('hidden')
      aLog('ok','SQLTools connection added for '+msg.payload.appName)
      break
    case 'DB_ERROR':
      document.getElementById('dbInfo').classList.remove('hidden')
      document.getElementById('dbInfo').innerHTML='<span style="color:var(--error)">'+esc(msg.payload.message)+'</span>'
      aLog('err',msg.payload.message)
      break

    case 'XSUAA_TOKEN_RESPONSE':{
      var ts=document.getElementById('tokenStatus')
      if(msg.payload.token){
        navigator.clipboard.writeText(msg.payload.token)
        ts.innerHTML='<span style="color:var(--success)">Token copied to clipboard (expires in '+msg.payload.expiresIn+'s)</span>'
        aLog('ok','XSUAA token copied to clipboard')
      }else{
        ts.innerHTML='<span style="color:var(--error)">'+esc(msg.payload.error)+'</span>'
        aLog('err','XSUAA token error: '+msg.payload.error)
      }
      break
    }

    case 'WATCHDOG_UPDATE':{
      var wd=document.getElementById('watchdogStatus')
      var apps=msg.payload.apps||[]
      if(apps.length){
        var failed=apps.filter(function(a){return a.failed})
        wd.innerHTML=failed.length
          ? '<span style="color:var(--error)">&#9679; '+failed.length+'/'+apps.length+' app(s) not responding</span>'
          : '<span style="color:var(--success)">&#9679; '+apps.length+' app(s) healthy</span>'
      }else{wd.textContent='No apps watched'}
      break
    }

    case 'SYNC_STATUS':{
      var ss=document.getElementById('syncStatus')
      ss.innerHTML=msg.payload.message
      break
    }

    case 'EXPLORER_RESULT':{
      var eo=document.getElementById('explorerOutput')
      if(msg.payload.error){
        eo.innerHTML='<span style="color:var(--error)">'+esc(msg.payload.error)+'</span>'
      }else{
        eo.innerHTML=msg.payload.result.map(function(l){return '<div style="font-size:10px;line-height:1.4;white-space:pre-wrap;overflow-x:auto">'+esc(l)+'</div>'}).join('')
      }
      break
    }

    case 'TAIL_LINE':{
      var tc=document.getElementById('tailContainer')
      var div=document.createElement('div');div.className='tail-line'
      var tag=document.createElement('span');tag.className='app-tag'
      tag.style.background='linear-gradient(135deg,'+stringToColor(msg.payload.appName)+',rgba(0,0,0,.3))'
      tag.textContent=msg.payload.appName
      div.appendChild(tag)
      div.appendChild(document.createTextNode(msg.payload.line))
      tc.appendChild(div);tc.scrollTop=tc.scrollHeight
      break
    }

    case 'SQL_RESULT':{
      var sr=document.getElementById('sqlResult')
      if(msg.payload.error){
        sr.innerHTML='<div style="color:var(--error);padding:8px;background:rgba(248,81,73,.1);border-radius:6px;margin-top:6px">'+esc(msg.payload.error)+'</div>'
      }else if(msg.payload.columns&&msg.payload.columns.length){
        var html='<div class="sql-table-wrap"><table class="sql-table"><thead><tr>'
        msg.payload.columns.forEach(function(c){html+='<th>'+esc(c)+'</th>'})
        html+='</tr></thead><tbody>'
        msg.payload.rows.forEach(function(r){
          html+='<tr>'
          r.forEach(function(v){html+='<td>'+esc(v==null?'NULL':String(v))+'</td>'})
          html+='</tr>'
        })
        html+='</tbody></table></div>'
        html+='<div style="font-size:10px;color:var(--text-muted);padding:4px 0">'+msg.payload.rows.length+' row(s)</div>'
        sr.innerHTML=html
      }else{
        sr.innerHTML='<div style="color:var(--success);padding:8px">Query executed (0 rows)</div>'
      }
      break
    }

    case 'CF_READY':{
      var cfStatus=document.getElementById('cfStatus')
      if(cfStatus){
        cfStatus.innerHTML=msg.payload.ready
          ? '<span style="color:var(--success)">&#9679; CF CLI ready</span>'
          : '<span style="color:var(--error)">&#9679; CF CLI not found</span>'
      }
      break
    }

    case 'CONNECTION_HEALTH':{
      var ch=document.getElementById('connectionStatus')
      if(!ch)break
      if(msg.payload.ok){
        ch.innerHTML='<span style="color:var(--success)">&#9679; <strong>'+esc(msg.payload.user||'')+'</strong> / '+esc(msg.payload.org||'-')+' / '+esc(msg.payload.space||'-')+'</span>'
      }else{
        ch.innerHTML='<span style="color:var(--warn)">&#9679; Not logged in</span>'
      }
      break
    }

    case 'APP_RESTARTED':{
      aLog('ok','App '+msg.payload.appName+' restarted')
      break
    }

    case 'SERVICES_LOADED':{
      var appName=msg.payload.appName
      var sl=document.querySelector('.services-list[data-app="'+CSS.escape(appName)+'"]')
      if(!sl)break
      if(msg.payload.services.length){
        sl.innerHTML='<span style="color:var(--text-muted)">Services:</span> '+msg.payload.services.map(function(s){return '<span style="display:inline-block;background:var(--card);border:1px solid var(--border);border-radius:4px;padding:1px 4px;margin:1px;font-size:10px">'+esc(s)+'</span>'}).join('')
      }else{
        sl.innerHTML='<span style="color:var(--text-muted)">No services bound</span>'
      }
      break
    }

    case 'FILE_DOWNLOADED':{
      var ds=document.getElementById('downloadStatus')
      if(ds)ds.innerHTML='<span style="color:var(--success)">&#9679; Downloaded: '+esc(msg.payload.localPath)+' ('+msg.payload.size+'b)</span>'
      break
    }
    case 'FOLDER_DOWNLOADED':{
      var ds=document.getElementById('downloadStatus')
      if(ds)ds.innerHTML='<span style="color:var(--success)">&#9679; Downloaded '+msg.payload.files+' files to '+esc(msg.payload.localDir)+'</span>'
      break
    }
    case 'ENV_GENERATED':{
      var ds=document.getElementById('downloadStatus')
      if(ds)ds.innerHTML='<span style="color:var(--success)">&#9679; default-env.json generated at '+esc(msg.payload.localPath)+'</span>'
      break
    }
    case 'EXCEPTION_BP_SET':{
      var is=document.getElementById('inspectorStatus')
      if(is){is.classList.remove('hidden');is.innerHTML='<span style="color:var(--success)">&#9679; Exception BP set on '+esc(msg.payload.appName)+'</span>'}
      break
    }
    case 'BREAKPOINT_LIST':{
      var is=document.getElementById('inspectorStatus')
      if(!is)break
      is.classList.remove('hidden')
      var bps=msg.payload.breakpoints
      if(bps.length){
        is.innerHTML='<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Breakpoints:</div>'+
          bps.map(function(b){return '<div style="font-size:10px;padding:2px 0">'+esc(b.url)+':'+b.line+(b.condition?' if '+esc(b.condition):'')+(b.logMessage?' log: '+esc(b.logMessage):'')+(b.hitCount?' hit: '+b.hitCount:'')+'</div>'}).join('')
      }else{
        is.innerHTML='<span style="color:var(--text-muted)">No breakpoints</span>'
      }
      break
    }
    case 'EVENTS_LOADED':{
      var el=document.getElementById('eventsList')
      if(!el)break
      el.classList.remove('hidden')
      if(msg.payload.events.length){
        el.innerHTML=msg.payload.events.slice(0,50).map(function(e){return '<div style="font-size:10px;padding:3px 0;border-bottom:1px solid var(--border)"><span style="color:var(--text-muted)">'+esc(e.time)+'</span> <strong>'+esc(e.event)+'</strong> <span style="color:var(--text-muted)">'+esc(e.actor)+'</span><br><span style="font-size:9px">'+esc(e.description)+'</span></div>'}).join('')
      }else{
        el.innerHTML='<span style="color:var(--text-muted)">No events found</span>'
      }
      break
    }
    case 'SKILL_GENERATED':{
      var ss=document.getElementById('skillStatus')
      if(ss){ss.innerHTML='<span style="color:var(--success)">&#9679; AI skill generated: '+esc(msg.payload.localPath)+'</span>'}
      break
    }
    case 'STACK_CAPTURE':{
      var is=document.getElementById('inspectorStatus')
      if(!is)break
      is.classList.remove('hidden')
      if(msg.payload.stack.length){
        is.innerHTML='<div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">Stack:</div>'+
          msg.payload.stack.map(function(s){return '<div style="font-size:10px;padding:1px 0;font-family:monospace">'+esc(s)+'</div>'}).join('')
      }else{
        is.innerHTML='<span style="color:var(--warn)">No stack frames</span>'
      }
      break
    }
    case 'TRACE_LINE':{
      var traceContainer=document.getElementById('traceContainer')
      if(!traceContainer)break
      traceContainer.classList.remove('hidden')
      var line=document.createElement('div');line.className='tail-line'
      line.style.fontSize='10px';line.style.color='var(--accent)'
      line.textContent='['+msg.payload.appName+'] '+msg.payload.line
      traceContainer.appendChild(line);traceContainer.scrollTop=traceContainer.scrollHeight
      break
    }
    case 'TRACE_STATUS':{
      var traceStatus=document.getElementById('traceStatus')
      if(!traceStatus)break
      traceStatus.innerHTML=msg.payload.active
        ? '<span style="color:var(--success)">&#9679; Tracing '+esc(msg.payload.appName)+'</span>'
        : '<span style="color:var(--text-muted)">Trace stopped</span>'
      break
    }

    case 'QUERY_RESULT':{
      var sr=document.getElementById('sqlResult')
      if(!sr)break
      if(msg.payload.error){
        sr.innerHTML='<div style="color:var(--error);padding:8px">'+esc(msg.payload.error)+'</div>'
      }else if(msg.payload.columns&&msg.payload.columns.length){
        var html='<div class="sql-table-wrap"><table class="sql-table"><thead><tr>'
        msg.payload.columns.forEach(function(c){html+='<th>'+esc(c)+'</th>'})
        html+='</tr></thead><tbody>'
        msg.payload.rows.forEach(function(r){
          html+='<tr>'
          r.forEach(function(v){html+='<td>'+esc(v==null?'NULL':String(v))+'</td>'})
          html+='</tr>'
        })
        html+='</tbody></table></div>'
        html+='<div style="font-size:10px;color:var(--text-muted);padding:4px 0">'+msg.payload.rows.length+' row(s)</div>'
        sr.innerHTML=html
      }else{
        sr.innerHTML='<div style="color:var(--success);padding:8px">Query executed (0 rows)</div>'
      }
      break
    }

    case 'QUERY_FILTERED':{
      var lc=document.getElementById('logContainer')
      if(!lc)break
      if(msg.payload.entries.length){
        lc.innerHTML=msg.payload.entries.map(function(e){return '<div class="log-entry" style="font-size:10px">'+esc(e.message||'')+'</div>'}).join('')
      }else{
        lc.innerHTML='<div style="color:var(--text-muted);padding:8px">No matching log entries</div>'
      }
      break
    }

    case 'TRANSACTION_STARTED':{
      aLog('ok','Transaction started: '+esc(msg.payload.id))
      break
    }

    case 'TRANSACTION_COMMITTED':
    case 'TRANSACTION_ROLLED_BACK':{
      var txStatus=document.getElementById('dbInfo')
      var label=msg.type==='TRANSACTION_COMMITTED'?'Committed':'Rolled back'
      if(txStatus){txStatus.classList.remove('hidden');txStatus.innerHTML='<span style="color:var(--warn)">&#9679; Transaction '+label+'</span>'}
      break
    }

    case 'BREAKPOINT_SET':{
      var id=msg.payload.id||'?'
      aLog('ok','BP set ['+id+'] at '+esc(msg.payload.url||'?')+':'+msg.payload.line)
      break
    }

    case 'BREAKPOINT_REMOVED':{
      aLog('info','BP removed ['+(msg.payload.id||'?')+']')
      break
    }

    case 'BREAKPOINT_HIT':{
      var is=document.getElementById('inspectorStatus')
      if(!is)break
      is.classList.remove('hidden')
      is.innerHTML='<span style="color:var(--warn)">&#9679; BP hit: '+esc(msg.payload.url||'?')+':'+msg.payload.line+'</span>'
      break
    }

    case 'BRUNO_RESULT':
    case 'BRUNO_SETUP_RESULT':{
      var bs=document.getElementById('brunoStatus')
      if(!bs)break
      if(msg.payload.success){
        var out=msg.type==='BRUNO_SETUP_RESULT'?('Collection setup at: '+esc(msg.payload.outputDir||'')):(msg.payload.output||'Done')
        bs.innerHTML='<span style="color:var(--success)">&#9679; '+out+'</span>'
      }else{
        bs.innerHTML='<span style="color:var(--error)">&#9679; '+esc(msg.payload.error||'Failed')+'</span>'
      }
      break
    }

    case 'GITPORT_RESULT':{
      var gs=document.getElementById('gitportStatus')
      if(!gs)break
      if(msg.payload.success){
        gs.innerHTML='<span style="color:var(--success)">&#9679; MR created: <a href="'+esc(msg.payload.mrUrl||'')+'" target="_blank">'+esc(msg.payload.mrUrl||'')+'</a></span>'
      }else{
        gs.innerHTML='<span style="color:var(--error)">&#9679; '+esc(msg.payload.error||'Failed')+'</span>'
      }
      break
    }

    case 'JIRA_RESULT':{
      var js=document.getElementById('jiraStatus')
      if(!js)break
      if(msg.payload.success){
        var d=msg.payload.data
        if(Array.isArray(d)){
          js.innerHTML=d.slice(0,20).map(function(i){return '<div style="padding:2px 0;font-size:10px;border-bottom:1px solid var(--border)"><strong>'+esc(i.key)+'</strong> '+esc(i.summary)+' <span style="color:var(--text-muted)">['+esc(i.status)+']</span></div>'}).join('')
        }else if(d&&d.key){
          js.innerHTML='<div style="padding:4px 0"><strong>'+esc(d.key)+'</strong> '+esc(d.summary)+'<br><span style="color:var(--text-muted)">Status: '+esc(d.status)+' | Assignee: '+esc(d.assignee||'-')+' | Priority: '+esc(d.priority||'-')+'</span></div>'
        }else{
          js.innerHTML='<span style="color:var(--success)">&#9679; Done</span>'
        }
      }else{
        js.innerHTML='<span style="color:var(--error)">&#9679; '+esc(msg.payload.error||'Failed')+'</span>'
      }
      break
    }

    case 'SHAREPOINT_RESULT':{
      var ss=document.getElementById('spStatus')
      if(!ss)break
      if(msg.payload.success){
        var d=msg.payload.data
        if(Array.isArray(d)){
          ss.innerHTML='<span style="color:var(--success)">&#9679; Read '+d.length+' records</span>'
        }else{
          ss.innerHTML='<span style="color:var(--success)">&#9679; Done</span>'
        }
      }else{
        ss.innerHTML='<span style="color:var(--error)">&#9679; '+esc(msg.payload.error||'Failed')+'</span>'
      }
      break
    }

    case 'SMDG_STATUS':{
      var ss=document.getElementById('smdgStatus')
      if(!ss)break
      ss.classList.remove('hidden')
      ss.innerHTML=msg.payload.available
        ? '<span style="color:var(--success)">&#9679; Smidge CLI available</span>'
        : '<span style="color:var(--warn)">&#9679; Smidge CLI not found (npm i -g smdg-cli)</span>'
      break
    }

    case 'SMDG_RESULT':{
      var ss=document.getElementById('smdgStatus')
      if(!ss)break
      ss.classList.remove('hidden')
      if(msg.payload.success){
        ss.innerHTML='<span style="color:var(--success)">&#9679; '+(msg.payload.output||'Done')+'</span>'
      }else{
        ss.innerHTML='<span style="color:var(--error)">&#9679; '+esc(msg.payload.error||'Failed')+'</span>'
      }
      break
    }

    case 'SMDG_SKILL_GENERATED':{
      var sk=document.getElementById('skillStatus')
      if(sk){
        sk.classList.remove('hidden')
        sk.innerHTML='<span style="color:var(--success)">&#9679; Skill: '+esc(msg.payload.skillPath||'')+'</span>'
      }
      break
    }
  }
})

function stringToColor(s){
  var hash=0;for(var i=0;i<s.length;i++){hash=s.charCodeAt(i)+((hash<<5)-hash)}
  var hue=((hash%360)+360)%360
  return 'hsl('+hue+',60%,50%)'
}

var REGIONS_CATALOG=[
  {key:'cf-ap10',label:'Australia',api:'https://api.cf.ap10.hana.ondemand.com'},
  {key:'cf-ap11',label:'Singapore',api:'https://api.cf.ap11.hana.ondemand.com'},
  {key:'cf-ap12',label:'Mumbai',api:'https://api.cf.ap12.hana.ondemand.com'},
  {key:'cf-ap20',label:'Seoul',api:'https://api.cf.ap20.hana.ondemand.com'},
  {key:'cf-ap21',label:'Osaka',api:'https://api.cf.ap21.hana.ondemand.com'},
  {key:'cf-br10',label:'São Paulo',api:'https://api.cf.br10.hana.ondemand.com'},
  {key:'cf-ca10',label:'Montreal',api:'https://api.cf.ca10.hana.ondemand.com'},
  {key:'cf-ch20',label:'Zurich',api:'https://api.cf.ch20.hana.ondemand.com'},
  {key:'cf-eu10',label:'Frankfurt',api:'https://api.cf.eu10.hana.ondemand.com'},
  {key:'cf-eu11',label:'London',api:'https://api.cf.eu11.hana.ondemand.com'},
  {key:'cf-eu20',label:'Amsterdam',api:'https://api.cf.eu20.hana.ondemand.com'},
  {key:'cf-eu30',label:'St. Leon Rot',api:'https://api.cf.eu30.hana.ondemand.com'},
  {key:'cf-eu31',label:'Rot BLP',api:'https://api.cf.eu31.hana.ondemand.com'},
  {key:'cf-in30',label:'Hyderabad',api:'https://api.cf.in30.hana.ondemand.com'},
  {key:'cf-jp10',label:'Tokyo',api:'https://api.cf.jp10.hana.ondemand.com'},
  {key:'cf-us10',label:'US East',api:'https://api.cf.us10.hana.ondemand.com'},
  {key:'cf-us20',label:'US West (Sterling)',api:'https://api.cf.us20.hana.ondemand.com'},
  {key:'cf-us21',label:'US West (Champaign)',api:'https://api.cf.us21.hana.ondemand.com'},
  {key:'cf-us30',label:'US Central',api:'https://api.cf.us30.hana.ondemand.com'},
  {key:'cf-us31',label:'US East BLP',api:'https://api.cf.us31.hana.ondemand.com'},
]

function buildRegionGrid(){
  var grid=document.getElementById('regionGrid')
  grid.innerHTML=REGIONS_CATALOG.map(function(r){
    return '<button class="btn-small region-btn" data-api="'+esc(r.api)+'" data-key="'+esc(r.key)+'" style="font-size:10px;padding:3px 4px;text-align:left;border:1px solid var(--border);background:var(--card);border-radius:4px;cursor:pointer;transition:background .1s">'+esc(r.label)+'</button>'
  }).join('')
  grid.querySelectorAll('.region-btn').forEach(function(b){
    b.addEventListener('click',function(){
      document.getElementById('apiEndpoint').value=this.getAttribute('data-api')
      document.getElementById('regionSelect').value=''
      document.querySelectorAll('.region-btn').forEach(function(x){x.style.borderColor='var(--border)'})
      this.style.borderColor='var(--accent)'
    })
  })
}
buildRegionGrid()

function showTab(name){
  document.querySelectorAll('[id^="tab-"]').forEach(function(t){t.classList.add('hidden')})
  document.querySelectorAll('.tab-bar button').forEach(function(b){b.classList.remove('active')})
  document.getElementById('tab-'+name).classList.remove('hidden')
  document.querySelector('.tab-bar button[data-tab="'+name+'"]').classList.add('active')
}
function mtaModuleType(name){
  if(/-srv$/i.test(name))return 'srv'
  if(/-(db|data|database)$/i.test(name))return 'db'
  if(/-(ui|app|web|frontend)$/i.test(name))return 'ui'
  if(/-router$/i.test(name))return 'router'
  if(/-(job|scheduler|worker)$/i.test(name))return 'job'
  return ''
}
function mtaProjectName(name){
  var parts=name.split('-')
  if(mtaModuleType(name)&&parts.length>1)return parts.slice(0,-1).join('-')
  return name
}
function groupAppsByMta(list){
  var groups={}
  list.forEach(function(a){
    var p=mtaProjectName(a.name)
    if(!groups[p])groups[p]={project:p,apps:[]}
    groups[p].apps.push(a)
  })
  return Object.values(groups).sort(function(a,b){return a.project.localeCompare(b.project)})
}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function populateRegionSelect(endpoints,current){
  var sel=document.getElementById('regionSelect')
  var known=endpoints.filter(function(e){return e})
  known=known.filter(function(v,i){return known.indexOf(v)===i})
  sel.innerHTML='<option value="">Custom...</option>'+known.map(function(e){return '<option value="'+esc(e)+'"'+(e===current?' selected':'')+'>'+esc(e.replace(/^https:\/\/api\./,'').replace(/\.hana\.ondemand\.com$/,''))+'</option>'}).join('')
}
function setSelectValue(id,val){
  var sel=document.getElementById(id)
  for(var i=0;i<sel.options.length;i++){if(sel.options[i].value===val){sel.value=val;break}}
}
function populateOrgs(orgs){
  var sel=document.getElementById('orgSelect')
  sel.innerHTML='<option value="">Select org...</option>'+orgs.map(function(o){return '<option value="'+esc(o)+'">'+esc(o)+'</option>'}).join('')
  if(orgs.length==1){sel.value=orgs[0];loadSpaces()}
}
function loadApps(){
  var org=document.getElementById('orgSelect').value
  var space=document.getElementById('spaceSelect').value
  if(!org||!space)return
  vscode.postMessage({type:'LOAD_APPS',payload:{org:org,space:space}})
}
function renderApps(list){
  var div=document.getElementById('appsList')
  if(!list.length){div.innerHTML='<div class="server-info">No apps found</div>';return}
  var groups=groupAppsByMta(list)
  div.innerHTML=groups.map(function(g){
    var items=g.apps.map(function(a){
      var ch='<input type="checkbox" class="app-check" value="'+esc(a.name)+'">'
      var url=a.urls&&a.urls.length?'<span class="badge" data-url="'+esc(a.urls[0])+'">URL</span>':''
      var mod=mtaModuleType(a.name)
      var pill=mod?'<span class="pill pill-'+mod+'">'+mod+'</span>':''
      return '<div class="app-item"><div class="cb-wrap">'+ch+'</div>'+pill+'<span class="name">'+esc(a.name)+'</span><span class="state-'+a.state+'">'+a.state+'</span>'+url
        +'<span class="badge btn-restart" data-app="'+esc(a.name)+'" style="color:var(--warn);cursor:pointer">&#8635;</span>'
        +'<span class="badge btn-services" data-app="'+esc(a.name)+'" style="color:var(--accent);cursor:pointer">S</span>'
        +'<span class="services-list" data-app="'+esc(a.name)+'" style="display:block;font-size:10px;margin-top:2px;grid-column:1/-1"></span>'
        +'</div>'
    }).join('')
    return '<div class="project-group"><div class="project-header" data-project="'+esc(g.project)+'"><span class="arrow">&#9660;</span><span>'+esc(g.project)+'</span><span class="count">'+g.apps.length+'</span></div><div class="project-children">'+items+'</div></div>'
  }).join('')
  div.querySelectorAll('.project-header').forEach(function(h){
    h.addEventListener('click',function(){
      var arrow=this.querySelector('.arrow'),children=this.nextElementSibling
      arrow.classList.toggle('collapsed'),children.classList.toggle('hidden')
    })
  })
  div.querySelectorAll('.app-check').forEach(function(cb){cb.addEventListener('change',updateDebugBtn)})
  div.querySelectorAll('.badge').forEach(function(el){el.addEventListener('click',function(){vscode.postMessage({type:'OPEN_APP',payload:{url:this.getAttribute('data-url')}})})})
  div.querySelectorAll('.btn-restart').forEach(function(el){
    el.addEventListener('click',function(){
      var app=this.getAttribute('data-app'),org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
      if(!org||!space){aLog('warn','Select org/space first');return}
      vscode.postMessage({type:'RESTART_APP',payload:{appName:app,org:org,space:space}})
    })
  })
  div.querySelectorAll('.btn-services').forEach(function(el){
    el.addEventListener('click',function(){
      var app=this.getAttribute('data-app'),org=document.getElementById('orgSelect').value,space=document.getElementById('spaceSelect').value
      if(!org||!space){aLog('warn','Select org/space first');return}
      vscode.postMessage({type:'LIST_SERVICES',payload:{appName:app,org:org,space:space}})
    })
  })
  updateDebugBtn()
  var countEl=document.querySelector('#tab-apps h3:last-child')
  if(countEl)countEl.textContent='Applications ('+list.length+')'
}
function updateDebugBtn(){
  var checked=document.querySelectorAll('.app-check:checked')
  var btn=document.getElementById('btnStartDebug')
  var parent=document.getElementById('debugControls')
  if(checked.length){parent.classList.remove('hidden');btn.textContent='Debug ('+checked.length+')'}
  else parent.classList.add('hidden')
}
function renderSessions(){
  var div=document.getElementById('sessionsList')
  var keys=Object.keys(activeSessions)
  if(!keys.length){div.innerHTML='<div class="server-info">No active debug sessions</div>';return}
  div.innerHTML=keys.map(function(app){
    var s=activeSessions[app]
    var icon=s==='ATTACHED'?'&#9679;':s==='ERROR'?'&#10007;':s==='TUNNELING'||s==='SIGNALING'?'&#9881;':'&#9679;'
    var detail=s==='ATTACHED'?'Debugger attached, inspect in Run & Debug view':s==='TUNNELING'?'Establishing SSH tunnel...':s==='SIGNALING'?'Sending inspector signal...':s==='ERROR'?'Failed to attach debugger':s==='CONNECTING'?'Connecting...':'Preparing...'
    return '<div class="session-card"><div class="top"><span class="name">'+esc(app)+'</span><span class="badge-status badge-'+s+'">'+icon+' '+s+'</span></div><div class="details">'+detail+'</div><div class="actions"><button class="btn-small btn-danger" data-app="'+esc(app)+'">Stop</button></div></div>'
  }).join('')
  div.querySelectorAll('.btn-danger').forEach(function(el){el.addEventListener('click',function(){
    vscode.postMessage({type:'STOP_DEBUG',payload:{appName:this.getAttribute('data-app')}})
  })})
}
function row(l,v){return '<tr><td style="padding:3px 6px;color:var(--text-muted);white-space:nowrap;border-bottom:1px solid var(--border)">'+l+'</td><td style="padding:3px 6px;border-bottom:1px solid var(--border);word-break:break-all">'+v+'</td></tr>'}
function populateSelect(id,list){
  var sel=document.getElementById(id)
  sel.innerHTML='<option value="">Select app...</option>'+list.map(function(a){return '<option value="'+esc(a.name)+'">'+esc(a.name)+'</option>'}).join('')
}
vscode.postMessage({type:'LOAD_CONFIG'})
</script>
</body></html>`
  }
}
