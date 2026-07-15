import * as vscode from 'vscode'
import { initStore } from './storage/store'
import { DebugPanelProvider } from './webview/debugPanel'
import { stopAllDebugSessions, disposeDebugManager } from './core/debugManager'
import { stopAllLogStreams } from './core/logsManager'
import { cfLogout } from './core/cfClient'
import { initActivityLog, log as activityLog } from './core/activityLog'
import { initWatchdog, showWatchdogPanel, disposeWatchdog, watchApp, unwatchApp } from './core/watchdog'

export function activate(context: vscode.ExtensionContext): void {
  initStore(context)
  const _activityChannel = initActivityLog()
  context.subscriptions.push(_activityChannel)

  initWatchdog(activityLog)

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DebugPanelProvider.viewId,
      new DebugPanelProvider(activityLog),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.login', () => {
      vscode.commands.executeCommand('workbench.view.extension.cds-tool')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.logs', async () => {
      const app = await vscode.window.showInputBox({ prompt: 'CF App name for log streaming' })
      if (!app) return

      const channel = vscode.window.createOutputChannel(`CDS Logs: ${app}`)
      channel.show()

      const { startLogStream, events: logEvents } = await import('./core/logsManager')
      startLogStream(app)

      const handler = (a: string, line: string) => {
        if (a === app) channel.appendLine(line)
      }
      logEvents.on('line', handler)
      context.subscriptions.push({
        dispose: () => {
          logEvents.off('line', handler)
          channel.dispose()
        },
      })
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.addDbConnection', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!ws) {
        vscode.window.showErrorMessage('Open a workspace first')
        return
      }
      const app = await vscode.window.showInputBox({ prompt: 'CF App name for DB credentials' })
      if (!app) return
      const org = await vscode.window.showInputBox({ prompt: 'CF Org' })
      if (!org) return
      const space = await vscode.window.showInputBox({ prompt: 'CF Space' })
      if (!space) return

      const { getDbCredentials, addSqlToolsConnection, saveCredentialsFile } = await import('./core/dbManager')
      try {
        const creds = await getDbCredentials(app, org, space)
        if (!creds) {
          vscode.window.showErrorMessage('No HANA credentials found')
          return
        }
        addSqlToolsConnection(creds, app)
        await saveCredentialsFile(creds, app)
        vscode.window.showInformationMessage(`SQLTools connection added for ${app}`)
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.openApp', async () => {
      const org = await vscode.window.showInputBox({ prompt: 'CF Org' })
      if (!org) return
      const space = await vscode.window.showInputBox({ prompt: 'CF Space' })
      if (!space) return
      const app = await vscode.window.showInputBox({ prompt: 'CF App name to open' })
      if (!app) return

      const { cfApps } = await import('./core/cfClient')
      try {
        const apps = await cfApps(org, space)
        const found = apps.find(a => a.name === app)
        if (found?.urls?.length) {
          vscode.env.openExternal(vscode.Uri.parse(found.urls[0]))
        } else {
          vscode.window.showWarningMessage(`No URL found for ${app}`)
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.showWatchdog', showWatchdogPanel)
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.syncOrg', async () => {
      const { runFullSync, readSyncManifest } = await import('./core/cfSync')
      const creds = await (await import('./core/shellEnv')).getCredentials()
      if (!creds.email || !creds.password) {
        vscode.window.showErrorMessage('Set SAP_EMAIL and SAP_PASSWORD in your environment')
        return
      }
      const manifest = readSyncManifest()
      const regions = manifest.regions.map(r => r.key)
      if (regions.length === 0) {
        const pick = await vscode.window.showQuickPick(
          (await import('./core/regions')).CF_REGIONS.map(r => ({ label: r.label, description: r.key })),
          { canPickMany: true, placeHolder: 'Select regions to sync' }
        )
        if (!pick || pick.length === 0) return
        const keys = pick.map(p => p.description!)
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Syncing CF landscape...' },
          async (progress) => {
            progress.report({ message: 'Starting...' })
            await runFullSync(creds.email!, creds.password!, keys, (msg) => progress.report({ message: msg }))
          }
        )
      } else {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Syncing CF landscape...' },
          async (progress) => {
            await runFullSync(creds.email!, creds.password!, regions, (msg) => progress.report({ message: msg }))
          }
        )
      }
      vscode.window.showInformationMessage('CF landscape sync complete')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.getToken', async () => {
      const app = await vscode.window.showInputBox({ prompt: 'CF App name' })
      if (!app) return
      const org = await vscode.window.showInputBox({ prompt: 'CF Org' })
      if (!org) return
      const space = await vscode.window.showInputBox({ prompt: 'CF Space' })
      if (!space) return
      try {
        const token = await (await import('./core/xsuaa')).getTokenCached(app, org, space, activityLog)
        if (token) {
          vscode.env.clipboard.writeText(token)
          vscode.window.showInformationMessage('XSUAA token copied to clipboard')
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(err.message)
      }
    })
  )
}

export async function deactivate(): Promise<void> {
  await stopAllDebugSessions()
  stopAllLogStreams()
  disposeDebugManager()
  disposeWatchdog()
  await cfLogout().catch(() => {})
}
