import * as vscode from 'vscode'

let _channel: vscode.OutputChannel

export function initActivityLog(): vscode.OutputChannel {
  _channel = vscode.window.createOutputChannel('CDS TOOL MT')
  return _channel
}

export function log(type: string, message: string): void {
  if (!_channel) return
  const label = type === 'err' ? 'ERROR' : type === 'warn' ? 'WARN' : type === 'ok' ? 'OK' : 'INFO'
  const time = new Date().toLocaleTimeString()
  _channel.appendLine(`[${time}] [${label}] ${message}`)
  _channel.show(true)
}

export function logError(message: string): void { log('err', message) }
export function logInfo(message: string): void { log('info', message) }
export function logOk(message: string): void { log('ok', message) }
export function logWarn(message: string): void { log('warn', message) }
