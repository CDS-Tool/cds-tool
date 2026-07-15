import * as vscode from 'vscode'
import { initStore } from './storage/store'
import { DebugPanelProvider } from './webview/debugPanel'
import { stopAllDebugSessions, disposeDebugManager } from './core/debugManager'
import { stopAllLogStreams } from './core/logsManager'
import { cfLogout } from './core/cfClient'
import { initActivityLog, log as activityLog } from './core/activityLog'
import { initWatchdog, showWatchdogPanel, disposeWatchdog, watchApp, unwatchApp } from './core/watchdog'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export function activate(context: vscode.ExtensionContext): void {
  initStore(context)
  const _activityChannel = initActivityLog()
  context.subscriptions.push(_activityChannel)

  initWatchdog(activityLog)

  const provider = new DebugPanelProvider(activityLog)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      DebugPanelProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  )

  // --- CF CLI health check ---
  const cfStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  cfStatusBar.text = '$(tools) CF: ...'
  cfStatusBar.tooltip = 'Checking CF CLI...'
  cfStatusBar.command = 'cdsTool.login'
  cfStatusBar.show()
  context.subscriptions.push(cfStatusBar)

  ;(async () => {
    const { checkCfCli } = await import('./core/cfClient')
    const result = await checkCfCli()
    if (result.found) {
      cfStatusBar.text = '$(cloud) CF OK'
      cfStatusBar.tooltip = result.version ?? 'CF CLI ready'
      provider.setCfReady(true)
    } else {
      cfStatusBar.text = '$(warning) CF not found'
      cfStatusBar.tooltip = 'Install Cloud Foundry CLI and restart'
      provider.setCfReady(false)
    }
  })()

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

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.restartApp', async () => {
      const app = await vscode.window.showInputBox({ prompt: 'CF App name to restart' })
      if (!app) return
      const org = await vscode.window.showInputBox({ prompt: 'CF Org' })
      if (!org) return
      const space = await vscode.window.showInputBox({ prompt: 'CF Space' })
      if (!space) return
      try {
        const { cfTarget, cfRestart } = await import('./core/cfClient')
        await cfTarget(org, space)
        const confirm = await vscode.window.showWarningMessage(
          `Restart ${app}?`, { modal: true }, 'Restart'
        )
        if (confirm !== 'Restart') return
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Restarting ${app}...` },
          async () => { await cfRestart(app) }
        )
        vscode.window.showInformationMessage(`${app} restarted`)
      } catch (err: any) {
        vscode.window.showErrorMessage(`Restart failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.brunoSetup', async () => {
      const app = await vscode.window.showInputBox({ prompt: 'CF App name' })
      if (!app) return
      const org = await vscode.window.showInputBox({ prompt: 'CF Org' })
      if (!org) return
      const space = await vscode.window.showInputBox({ prompt: 'CF Space' })
      if (!space) return
      try {
        const { generateBrunoEnv, scaffoldBrunoCollection } = await import('./core/bruno')
        const env = await generateBrunoEnv(app, org, space)
        const dir = scaffoldBrunoCollection(app, env, process.cwd())
        vscode.window.showInformationMessage(`Bruno collection setup at ${dir}`)
      } catch (err: any) {
        vscode.window.showErrorMessage(`Bruno setup failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.brunoRun', async () => {
      const coll = await vscode.window.showInputBox({ prompt: 'Bruno collection path' })
      if (!coll) return
      try {
        const { runBrunoCollection } = await import('./core/bruno')
        const output = await runBrunoCollection(coll)
        const channel = vscode.window.createOutputChannel('CDS Bruno')
        channel.appendLine(output)
        channel.show()
      } catch (err: any) {
        vscode.window.showErrorMessage(`Bruno run failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.gitport', async () => {
      const url = await vscode.window.showInputBox({ prompt: 'Source MR URL' })
      if (!url) return
      const repo = await vscode.window.showInputBox({ prompt: 'Destination repo URL' })
      if (!repo) return
      const branch = await vscode.window.showInputBox({ prompt: 'Destination branch name' })
      if (!branch) return
      try {
        const { portMr } = await import('./core/gitport')
        const mrUrl = await portMr(url, repo, branch)
        vscode.window.showInformationMessage(`MR ported: ${mrUrl}`)
      } catch (err: any) {
        vscode.window.showErrorMessage(`GitPort failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.jiraSearch', async () => {
      const jql = await vscode.window.showInputBox({ prompt: 'JQL query' })
      if (!jql) return
      try {
        const { searchIssues } = await import('./core/jira')
        const issues = await searchIssues(jql)
        const channel = vscode.window.createOutputChannel('CDS Jira')
        for (const i of issues) {
          channel.appendLine(`${i.key}: ${i.summary} [${i.status}]`)
        }
        channel.show()
      } catch (err: any) {
        vscode.window.showErrorMessage(`Jira search failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.sharepointRead', async () => {
      const siteId = await vscode.window.showInputBox({ prompt: 'SharePoint site ID' })
      if (!siteId) return
      const drivePath = await vscode.window.showInputBox({ prompt: 'Drive path' })
      if (!drivePath) return
      const fileName = await vscode.window.showInputBox({ prompt: 'File name' })
      if (!fileName) return
      try {
        const { readWorkbook } = await import('./core/sharepoint')
        const data = await readWorkbook(siteId, drivePath, fileName)
        const channel = vscode.window.createOutputChannel('CDS SharePoint')
        channel.appendLine(JSON.stringify(data, null, 2))
        channel.show()
      } catch (err: any) {
        vscode.window.showErrorMessage(`SharePoint read failed: ${err.message}`)
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.smdgLogin', async () => {
      const { smdgLogin } = await import('./core/agentSkill')
      const result = await smdgLogin()
      if (result.success) vscode.window.showInformationMessage('Smidge login successful')
      else vscode.window.showErrorMessage(result.error || 'Smidge login failed')
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('cdsTool.smdgGenerate', async () => {
      const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!ws) { vscode.window.showErrorMessage('Open a workspace first'); return }
      const { smdgGenerate } = await import('./core/agentSkill')
      const sources = [join(ws, 'README.md'), join(ws, 'package.json')].filter(existsSync)
      if (sources.length === 0) { vscode.window.showErrorMessage('No source files found'); return }
      try {
        const result = await smdgGenerate(sources, 'cds-tool-cap-debugger', 'coding')
        if (result.success) vscode.window.showInformationMessage(`Skill: ${result.skillPath}`)
        else vscode.window.showErrorMessage(result.error || 'Generation failed')
      } catch (err: any) {
        vscode.window.showErrorMessage(`Smidge: ${err.message}`)
      }
    })
  )
}

export async function deactivate(): Promise<void> {
  await stopAllDebugSessions()
  stopAllLogStreams()
  disposeDebugManager()
  disposeWatchdog()
  const { stopAllTraces } = await import('./core/cfLiveTrace')
  stopAllTraces()
  const { disposeTransactions } = await import('./core/cfHana')
  disposeTransactions()
  const { disconnectAll } = await import('./core/cfInspector')
  disconnectAll()
  await cfLogout().catch(() => {})
}
