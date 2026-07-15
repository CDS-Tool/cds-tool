import * as vscode from 'vscode'
import { cfEnv, cfTarget, parseVCAPServices, extractHanaCreds } from './cfClient'
import type { DbCredentials } from '../types'

export async function getDbCredentials(
  appName: string,
  org: string,
  space: string
): Promise<DbCredentials | null> {
  if (org && space) {
    await cfTarget(org, space)
  }
  const raw = await cfEnv(appName)
  const vcap = parseVCAPServices(raw)
  if (!vcap) return null
  return extractHanaCreds(vcap)
}

export function addSqlToolsConnection(creds: DbCredentials, appName: string): void {
  const config = vscode.workspace.getConfiguration()

  const connection = {
    name: `${appName} (cds-tool)`,
    driver: 'SAPHana',
    server: creds.host,
    port: creds.port,
    username: creds.user,
    password: creds.password,
    database: creds.database,
    connectionTimeout: 30,
    previewLimit: 50,
    hanaOptions: {
      encrypt: true,
      sslValidateCertificate: true,
      sslCryptoProvider: 'openssl',
    },
  }

  const current = config.inspect('sqltools.connections')
  let connections: any[] = []
  if (current?.globalValue && Array.isArray(current.globalValue)) {
    connections = (current.globalValue as any[]).filter((c: any) => c?.name !== connection.name)
  }
  connections.push(connection)

  config.update('sqltools.connections', connections, vscode.ConfigurationTarget.Global)
  config.update('sqltools.useNodeRuntime', true, vscode.ConfigurationTarget.Global)
}

export async function saveCredentialsFile(creds: DbCredentials, appName: string): Promise<void> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!ws) return

  const outPath = path.join(ws, `${appName}-hana-creds.json`)
  await fs.writeFile(outPath, JSON.stringify(creds, null, 2))
  vscode.window.showInformationMessage(`Credentials saved to ${outPath}`)
}
