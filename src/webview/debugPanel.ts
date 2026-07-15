import * as vscode from 'vscode'
import type { WebviewMessage, ExtensionMessage } from '../types'
import { saveConfig, loadConfig, clearConfig, saveEmail, loadFolderMappings, saveFolderMappings, setCachedApps, getCachedApps, loadCachedRegions } from '../storage/store'
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

  constructor(logFn: (type: string, msg: string) => void) {
    this._log = logFn
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

    // Auto-detect credentials and send to webview
    const creds = await getCredentials()
    this._credentialSource = creds.email ? 'env' : 'none'
    post(view.webview, {
      type: 'CONFIG_LOADED',
      payload: {
        config: loadConfig(),
        activeSessions: debugManager.getActiveSessions(),
        credentialSource: this._credentialSource,
        defaultEmail: creds.email,
        defaultPassword: creds.password,
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
            apiEndpoint: '', orgs: [], orgGroupMappings: [], lastOrg: '', lastSpace: '', remoteRoot: '/home/vcap/app',
          }
          config.apiEndpoint = apiEndpoint
          config.orgs = orgs
          saveConfig(config)
          await saveEmail(email)
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
        break

      case 'LOG':
        this._log(msg.payload.level, msg.payload.message)
        break

      case 'LOAD_SETTINGS':
        post(v.webview, {
          type: 'SETTINGS_LOADED',
          payload: {
            remoteRoot: loadConfig()?.remoteRoot ?? '/home/vcap/app',
            folderMappings: loadFolderMappings(),
          },
        })
        break

      case 'SAVE_SETTINGS': {
        const cfg = loadConfig() ?? {
          apiEndpoint: '', orgs: [], orgGroupMappings: [], lastOrg: '', lastSpace: '', remoteRoot: '/home/vcap/app',
        }
        cfg.remoteRoot = msg.payload.remoteRoot
        saveConfig(cfg)
        this._log('info', 'Settings saved')
        break
      }

      case 'BROWSE_PACKAGES': {
        try {
          const { appName, org, space } = msg.payload
          const packages = await packageBrowser.listRemotePackages(appName, org, space)
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
          const { appName, path } = msg.payload
          const content = await packageBrowser.readRemoteFile(appName, '', '', path)
          post(v.webview, {
            type: 'FILE_CONTENT',
            payload: { appName, path, content },
          })
        } catch (err: any) {
          this._log('err', `Browse file error: ${err.message}`)
        }
        break
      }
    }
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
:root{--bg:#1e1e1e;--fg:#d4d4d4;--border:#3c3c3c;--accent:#0078d4;--accent-hover:#1a8ae8;--success:#4caf50;--error:#f44747;--warn:#ff8c00;--card:#252526;--card-hover:#2a2d2e;--input-bg:#3c3c3c;--text-muted:#858585;--radius:6px}
*{box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:12px;color:var(--fg);background:var(--bg);font-size:13px;margin:0;line-height:1.5}
.hidden{display:none!important}
.section{margin-bottom:16px}
h3{margin:10px 0 8px;font-size:11.5px;font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:.8px}
label{display:block;margin:6px 0 3px;font-size:11px;color:var(--text-muted);font-weight:500}
input,select,button{width:100%;box-sizing:border-box;margin:3px 0;padding:6px 10px;font-size:12.5px}
input,select{background:var(--input-bg);border:1px solid var(--border);color:var(--fg);border-radius:var(--radius);transition:border-color .15s}
input:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
input::placeholder{color:var(--text-muted)}
button{background:var(--accent);color:#fff;border:none;padding:7px 14px;cursor:pointer;border-radius:var(--radius);font-weight:500;transition:all .12s;display:inline-flex;align-items:center;justify-content:center;gap:6px}
button:hover{background:var(--accent-hover);box-shadow:0 1px 3px rgba(0,0,0,.3)}
button:active{transform:scale(.97)}
button:disabled{opacity:.4;cursor:default;transform:none;box-shadow:none}
.btn-danger{background:#c73e3e}
.btn-danger:hover{background:var(--error)}
.btn-success{background:#388e3c}
.btn-success:hover{background:var(--success)}
.btn-small{padding:4px 10px;font-size:11px;width:auto;border-radius:4px;font-weight:500}
.btn-outline{background:transparent;border:1px solid var(--border);color:var(--fg)}
.btn-outline:hover{background:var(--card-hover);border-color:var(--text-muted);box-shadow:none}
.btn-icon{padding:4px;width:auto;background:transparent;color:var(--text-muted)}
.btn-icon:hover{background:var(--card-hover);color:var(--fg);box-shadow:none}
.row{display:flex;gap:6px;align-items:center}
.row button{flex:1}
.app-item{display:flex;align-items:center;gap:8px;padding:6px 8px;transition:background .1s;border-radius:4px}
.app-item:hover{background:var(--card-hover)}
.app-item .name{flex:1;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.app-item .cb-wrap{display:flex;align-items:center}
.app-check{width:auto;margin:0;accent-color:var(--accent);cursor:pointer}
.state-started{color:var(--success);font-size:11px;font-weight:500;background:rgba(76,175,80,.12);padding:1px 6px;border-radius:3px}
.state-stopped{color:var(--text-muted);font-size:11px;background:rgba(133,133,133,.1);padding:1px 6px;border-radius:3px}
.state-empty{color:var(--warn);font-size:11px;background:rgba(255,140,0,.12);padding:1px 6px;border-radius:3px}
.badge{font-size:10px;padding:2px 6px;border-radius:3px;background:var(--input-bg);cursor:pointer;transition:all .12s}
.badge:hover{background:var(--accent);color:#fff}
.log-line{font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:11px;white-space:pre-wrap;word-break:break-all;border-bottom:1px solid rgba(255,255,255,.04);padding:2px 0;transition:background .1s}
.log-line:hover{background:rgba(255,255,255,.03)}
.log-container{max-height:300px;overflow-y:auto;background:#0d0d0d;padding:6px;border-radius:var(--radius);font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:11px;border:1px solid var(--border)}
.session-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin-bottom:6px;transition:all .12s}
.session-card:hover{border-color:var(--text-muted)}
.session-card .top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.session-card .name{font-size:12.5px;font-weight:600;flex:1}
.session-card .badge-status{font-size:10px;padding:2px 8px;border-radius:10px;font-weight:500}
.session-card .badge-ATTACHED{background:var(--success);color:#fff}
.session-card .badge-CONNECTING{background:var(--accent);color:#fff}
.session-card .badge-TUNNELING{background:var(--warn);color:#000}
.session-card .badge-SIGNALING{background:var(--warn);color:#000}
.session-card .badge-ERROR{background:var(--error);color:#fff}
.session-card .badge-PENDING{background:var(--text-muted);color:#fff}
.session-card .details{font-size:11px;color:var(--text-muted);padding:4px 0}
.session-card .actions{display:flex;gap:4px;margin-top:6px}
.status-ATTACHED{color:var(--success);font-size:11px;font-weight:500;display:none}
.status-TUNNELING{color:var(--warn);font-size:11px;display:none}
.status-SIGNALING{color:var(--warn);font-size:11px;display:none}
.status-ERROR{color:var(--error);font-size:11px;display:none}
.status-PENDING{color:var(--text-muted);font-size:11px;display:none}
.status-CONNECTING{color:var(--accent);font-size:11px;display:none}
.tab-bar{display:flex;gap:1px;margin-bottom:12px;position:sticky;top:0;background:var(--bg);z-index:1;padding:6px 0 0;border-bottom:1px solid var(--border)}
.tab-bar button{flex:1;background:transparent;color:var(--text-muted);font-size:11.5px;padding:6px 4px;border-radius:0;border-bottom:2px solid transparent;margin:0;transition:all .15s;font-weight:400}
.tab-bar button:hover{background:transparent;color:var(--fg)}
.tab-bar button.active{background:transparent;color:var(--fg);border-bottom-color:var(--accent);font-weight:600}
.server-info{font-size:11.5px;color:var(--text-muted);padding:8px 10px;background:var(--card);border-radius:var(--radius);margin:6px 0;word-break:break-all;border:1px solid var(--border)}
.pill{display:inline-block;font-size:10px;padding:1px 7px;border-radius:10px;margin:2px 0;font-weight:500}
.pill-env{background:var(--success);color:#fff}
.pill-none{background:var(--text-muted);color:#fff}
.pill-srv{background:#0078d4;color:#fff}
.pill-db{background:#7c4dff;color:#fff}
.pill-ui{background:#ff8c00;color:#fff}
.pill-router{background:#00bcd4;color:#fff}
.pill-job{background:#607d8b;color:#fff}
.filter-input{margin:4px 0}
.section-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:10px}
#loadingOverlay{position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
#loadingOverlay.hidden{display:none}
.spinner{width:16px;height:16px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;display:inline-block;flex-shrink:0}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-text{font-size:13px;color:var(--text-muted)}
.project-group{margin-bottom:4px}
.project-header{display:flex;align-items:center;gap:6px;padding:5px 6px;cursor:pointer;border-radius:4px;transition:background .1s;font-size:12px;font-weight:600;color:var(--fg);user-select:none}
.project-header:hover{background:var(--card-hover)}
.project-header .arrow{font-size:8px;transition:transform .15s;color:var(--text-muted)}
.project-header .arrow.collapsed{transform:rotate(-90deg)}
.project-header .count{font-size:10px;color:var(--text-muted);font-weight:400;margin-left:auto}
.project-children{border-left:1px solid var(--border);margin-left:10px;padding-left:6px}
.inline-spinner{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);font-size:12px}
.db-table td:first-child{font-weight:500}
.db-table td:last-child{font-family:monospace;font-size:11px}
</style>
</head><body>
<div id="loadingOverlay"><div class="spinner"></div><div class="loading-text">Loading CDS Tool...</div></div>

<div class="tab-bar">
  <button class="active" data-tab="login">Login</button>
  <button data-tab="apps">Apps</button>
  <button data-tab="debug">Debug</button>
  <button data-tab="logs">Logs</button>
  <button data-tab="db">DB</button>
  <button data-tab="settings">&#9881;</button>
</div>

<div id="tab-login" class="section">
  <div class="section-card">
    <h3>Cloud Foundry Login</h3>
    <label>API Endpoint</label>
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
  </div>
</div>

<div id="tab-apps" class="section hidden">
  <div class="section-card">
    <h3>Organization &amp; Space</h3>
    <select id="orgSelect"><option value="">Select org...</option></select>
    <select id="spaceSelect"><option value="">Select space...</option></select>
    <button id="btnRefreshApps" style="margin-top:6px">Refresh Apps</button>
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
</div>

<div id="tab-logs" class="section hidden">
  <div class="section-card">
    <h3>Log Streaming</h3>
    <select id="logAppSelect"><option value="">Select app...</option></select>
    <div class="row">
      <button id="btnStartLogs">Start</button>
      <button id="btnStopLogs" class="btn-danger btn-small">Stop</button>
      <button id="btnClearLogs" class="btn-small">Clear</button>
    </div>
  </div>
  <div class="section-card">
    <div id="logContainer" class="log-container"></div>
  </div>
</div>

<div id="tab-db" class="section hidden">
  <div class="section-card">
    <h3>HANA Database</h3>
    <select id="dbAppSelect"><option value="">Select app...</option></select>
    <button id="btnGetDbCreds">Get DB Credentials</button>
    <div id="dbInfo" class="server-info hidden"></div>
    <button id="btnAddDb" class="btn-success hidden">Add SQLTools Connection</button>
  </div>
</div>

<div id="tab-settings" class="section hidden">
  <div class="section-card">
    <h3>Settings</h3>
    <label>Remote Root Path</label>
    <input id="remoteRoot" value="/home/vcap/app" placeholder="/home/vcap/app">
    <label>Folder Mappings</label>
    <div id="folderMappings"></div>
    <button id="btnAddMapping" class="btn-small btn-outline" style="margin-top:4px">+ Add Mapping</button>
    <button id="btnSaveSettings" class="btn-success" style="margin-top:8px">Save Settings</button>
    <div id="settingsStatus" class="server-info hidden"></div>
  </div>
  <div class="section-card">
    <h3>Cache</h3>
    <div id="cacheInfo" class="server-info">No cached data</div>
    <button id="btnClearCache" class="btn-small btn-danger">Clear Cache</button>
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
  vscode.postMessage({type:'SAVE_SETTINGS',payload:{remoteRoot:root}})
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

window.addEventListener('message',function(e){
  var msg=e.data
  switch(msg.type){
    case 'LOGIN_SUCCESS':
      document.getElementById('btnLogin').disabled=false
      document.getElementById('loginStatus').innerHTML='<span style="color:var(--success)">Connected to '+msg.payload.apiEndpoint+'</span>'
      aLog('ok','Connected to '+msg.payload.apiEndpoint)
      document.getElementById('orgSelect').innerHTML='<option value="">Loading...</option>'
      populateOrgs(msg.payload.orgs)
      showTab('apps')
      break
    case 'LOGIN_ERROR':
      document.getElementById('btnLogin').disabled=false
      document.getElementById('loginStatus').innerHTML='<span style="color:var(--error)">'+esc(msg.payload.message)+'</span>'
      aLog('err','Login failed: '+msg.payload.message)
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
      aLog(msg.payload.fromCache?'info':'ok','Loaded '+apps.length+' app(s)'+(msg.payload.fromCache?' (from cache)':''))
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
      if(msg.payload.config){
        var c=msg.payload.config
        if(c.apiEndpoint){
          document.getElementById('apiEndpoint').value=c.apiEndpoint
        }
        if(c.orgs&&c.orgs.length)populateOrgs(c.orgs)
        if(c.lastOrg)setSelectValue('orgSelect',c.lastOrg)
        if(c.lastSpace)setSelectValue('spaceSelect',c.lastSpace)
        if(c.remoteRoot)document.getElementById('remoteRoot').value=c.remoteRoot
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
      break
    }

    case 'SETTINGS_LOADED':{
      if(msg.payload.remoteRoot)document.getElementById('remoteRoot').value=msg.payload.remoteRoot
      var fm=document.getElementById('folderMappings')
      if(msg.payload.folderMappings&&msg.payload.folderMappings.length){
        fm.innerHTML=msg.payload.folderMappings.map(function(m){
          return '<div style="font-size:11px;padding:3px 0;display:flex;align-items:center;gap:4px"><span style="flex:1">'+esc(m.cfOrg)+'/'+esc(m.cfSpace)+'</span><span style="color:var(--text-muted)">'+esc(m.groupFolderPath)+'</span></div>'
        }).join('')
      }
      break
    }

    case 'PACKAGES_LOADED':{
      if(msg.payload.error){
        aLog('err','Browse packages: '+msg.payload.error)
      }else{
        aLog('ok','Found '+msg.payload.packages.length+' packages in '+msg.payload.appName)
      }
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
  }
})

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
      return '<div class="app-item"><div class="cb-wrap">'+ch+'</div>'+pill+'<span class="name">'+esc(a.name)+'</span><span class="state-'+a.state+'">'+a.state+'</span>'+url+'</div>'
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
