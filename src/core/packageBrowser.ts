import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)

function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

function shellEscape(a: string): string {
  return `'${a.replace(/'/g, "'\\''")}'`
}

export async function listRemotePackages(appName: string, org: string, space: string): Promise<string[]> {
  const shell = getShell()
  const findCmd = shellEscape('find /home/vcap/app -name "package.json" -not -path "*/node_modules/*" -maxdepth 4 2>/dev/null | sort')
  const cmd = `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && cf ssh ${shellEscape(appName)} -c ${findCmd}`
  try {
    const { stdout } = await execAsync(shell, ['-l', '-c', cmd], { timeout: 30000 })
    return stdout.split('\n').map(l => l.trim()).filter(Boolean)
  } catch (err: any) {
    throw new Error(`Failed to list packages: ${err.stderr || err.message}`)
  }
}

export async function readRemoteFile(appName: string, org: string, space: string, remotePath: string): Promise<string> {
  const shell = getShell()
  const catCmd = shellEscape(`cat ${shellEscape(remotePath)} 2>/dev/null || echo '-- file not found --'`)
  const cmd = `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && cf ssh ${shellEscape(appName)} -c ${catCmd}`
  try {
    const { stdout } = await execAsync(shell, ['-l', '-c', cmd], { timeout: 15000 })
    return stdout
  } catch (err: any) {
    throw new Error(`Failed to read file: ${err.stderr || err.message}`)
  }
}
