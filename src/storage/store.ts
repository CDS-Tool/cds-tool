import * as vscode from 'vscode'
import type { ExtensionConfig } from '../types'

const CONFIG_KEY = 'cds-tool.config'

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
