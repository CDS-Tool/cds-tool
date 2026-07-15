import * as vscode from 'vscode'
import { EventEmitter } from 'node:events'

const WATCHDOG_TTL = 8 * 60 * 60 * 1000
const PING_INTERVAL = 90000
const CHECK_ACTIVE_INTERVAL = 120000

interface WatchEntry {
  appName: string
  url: string
  lastOk: number
  startedAt: number
  failed: boolean
  timer?: NodeJS.Timeout
}

const watched = new Map<string, WatchEntry>()
const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
statusBar.command = 'cdsTool.showWatchdog'
let checkTimer: NodeJS.Timeout | undefined
let watchdogActive = false
let _lastLog: ((type: string, msg: string) => void) | undefined

export const events = new EventEmitter()

export function initWatchdog(logFn: (type: string, msg: string) => void): void {
  _lastLog = logFn
}

export function startWatchdog(): void {
  if (watchdogActive) return
  watchdogActive = true
  statusBar.text = '$(shield) Watchdog'
  statusBar.tooltip = 'CDS Tool App Watchdog active'
  statusBar.show()
  log('info', 'Watchdog started')
  checkTimer = setInterval(checkApps, CHECK_ACTIVE_INTERVAL)
}

export function stopWatchdog(): void {
  watchdogActive = false
  if (checkTimer) { clearInterval(checkTimer); checkTimer = undefined }
  statusBar.hide()
  log('info', 'Watchdog stopped')
}

export function watchApp(appName: string, url: string): void {
  if (watched.has(appName)) return
  const entry: WatchEntry = { appName, url, lastOk: Date.now(), startedAt: Date.now(), failed: false }
  entry.timer = setInterval(() => pingApp(entry), PING_INTERVAL)
  watched.set(appName, entry)
  log('info', `Watchdog watching ${appName} @ ${url}`)
  updateStatusBar()
}

export function unwatchApp(appName: string): void {
  const entry = watched.get(appName)
  if (!entry) return
  if (entry.timer) clearInterval(entry.timer)
  watched.delete(appName)
  log('info', `Watchdog stopped watching ${appName}`)
  updateStatusBar()
}

export function getWatchedApps(): WatchEntry[] {
  return Array.from(watched.values())
}

export function getFailedApps(): WatchEntry[] {
  return Array.from(watched.values()).filter(e => e.failed)
}

async function pingApp(entry: WatchEntry): Promise<void> {
  const now = Date.now()
  if (now - entry.startedAt > WATCHDOG_TTL) {
    unwatchApp(entry.appName)
    log('info', `Watchdog TTL expired for ${entry.appName}`)
    return
  }
  if (isBeingDebugged(entry.appName)) {
    entry.lastOk = now
    return
  }
  try {
    const resp = await fetch(entry.url, { method: 'HEAD', signal: AbortSignal.timeout(10000) })
    if (resp.ok) {
      entry.lastOk = now
      if (entry.failed) {
        entry.failed = false
        log('ok', `Watchdog: ${entry.appName} recovered`)
        updateStatusBar()
      }
    } else {
      markFailed(entry)
    }
  } catch {
    markFailed(entry)
  }
}

function markFailed(entry: WatchEntry): void {
  if (!entry.failed) {
    entry.failed = true
    log('warn', `Watchdog: ${entry.appName} not responding`)
    events.emit('appDown', entry.appName, entry.url)
    updateStatusBar()
    vscode.window.showWarningMessage(`[CDS Tool] ${entry.appName} may be frozen (not responding on ${entry.url})`, 'Open', 'Dismiss').then(action => {
      if (action === 'Open') vscode.env.openExternal(vscode.Uri.parse(entry.url))
    })
  }
}

function isBeingDebugged(appName: string): boolean {
  return vscode.debug.activeDebugSession?.name === `Debug: ${appName}`
}

function checkApps(): void {
  const now = Date.now()
  for (const [name, entry] of watched) {
    if (now - entry.startedAt > WATCHDOG_TTL) {
      unwatchApp(name)
    }
  }
  if (watched.size === 0 && watchdogActive) {
    stopWatchdog()
  }
  updateStatusBar()
}

function updateStatusBar(): void {
  const failed = getFailedApps()
  if (failed.length > 0) {
    statusBar.text = `$(alert) Watchdog: ${failed.length} app(s) down`
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    statusBar.tooltip = failed.map(e => `${e.appName} @ ${e.url}`).join('\n')
  } else {
    statusBar.text = `$(shield) Watchdog (${watched.size})`
    statusBar.backgroundColor = undefined
    statusBar.tooltip = `${watched.size} app(s) healthy`
  }
  events.emit('update', Array.from(watched.values()))
}

export function showWatchdogPanel(): void {
  const failed = getFailedApps()
  if (failed.length > 0) {
    vscode.window.showInformationMessage(
      `Watchdog: ${failed.length} app(s) not responding`,
      { modal: true },
      ...failed.map(e => `Open ${e.appName}`)
    ).then(action => {
      if (action?.startsWith('Open ')) {
        const appName = action.slice(5)
        const entry = failed.find(e => e.appName === appName)
        if (entry) vscode.env.openExternal(vscode.Uri.parse(entry.url))
      }
    })
  } else {
    vscode.window.showInformationMessage(`Watchdog: ${watched.size} app(s) healthy`)
  }
}

export function disposeWatchdog(): void {
  stopWatchdog()
  for (const [name] of watched) unwatchApp(name)
  statusBar.dispose()
}

function log(type: string, msg: string): void {
  if (_lastLog) _lastLog(type, `[Watchdog] ${msg}`)
}
