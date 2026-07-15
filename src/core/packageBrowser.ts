import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execAsync = promisify(execFile)

function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

function shellEscape(a: string): string {
  return `'${a.replace(/'/g, "'\\''")}'`
}

function sshCmd(appName: string, remoteCmd: string, org: string, space: string): string {
  const target = org && space ? `cf target -o ${shellEscape(org)} -s ${shellEscape(space)} >/dev/null 2>&1 && ` : ''
  return `${target}cf ssh ${shellEscape(appName)} -c ${shellEscape(remoteCmd)}`
}

async function runRemote(appName: string, remoteCmd: string, org: string, space: string, timeout = 30000): Promise<string> {
  const shell = getShell()
  const cmd = sshCmd(appName, remoteCmd, org, space)
  try {
    const { stdout } = await execAsync(shell, ['-l', '-c', cmd], { timeout })
    return stdout
  } catch (err: any) {
    throw new Error(err.stderr?.trim() || err.message)
  }
}

export async function listRemotePackages(appName: string, org: string, space: string): Promise<string[]> {
  const out = await runRemote(appName,
    'find /home/vcap/app -name "package.json" -not -path "*/node_modules/*" -maxdepth 4 2>/dev/null | sort',
    org, space
  )
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

export async function readRemoteFile(appName: string, org: string, space: string, remotePath: string): Promise<string> {
  const out = await runRemote(appName,
    `cat ${shellEscape(remotePath)} 2>/dev/null || echo '-- file not found --'`,
    org, space, 15000
  )
  return out
}

export async function findRemoteRoots(appName: string, org: string, space: string): Promise<string[]> {
  const out = await runRemote(appName,
    'for d in /home/vcap/app /home/vcap /app; do test -d "$d" && echo "$d"; done 2>/dev/null',
    org, space
  )
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

export async function lsRemote(appName: string, org: string, space: string, dir: string): Promise<string[]> {
  const out = await runRemote(appName,
    `ls -la ${shellEscape(dir)} 2>/dev/null || echo '-- directory not found --'`,
    org, space, 15000
  )
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

export async function findRemoteFiles(
  appName: string, org: string, space: string,
  pattern: string, rootDir = '/home/vcap/app', maxDepth = 6
): Promise<string[]> {
  const out = await runRemote(appName,
    `find ${shellEscape(rootDir)} -name ${shellEscape(pattern)} -not -path "*/node_modules/*" -not -path "*/.git/*" -maxdepth ${maxDepth} 2>/dev/null | sort`,
    org, space, 30000
  )
  return out.split('\n').map(l => l.trim()).filter(Boolean)
}

export async function grepRemote(
  appName: string, org: string, space: string,
  query: string, rootDir = '/home/vcap/app', maxResults = 20
): Promise<{ path: string; line: string }[]> {
  const out = await runRemote(appName,
    `grep -rn ${shellEscape(query)} ${shellEscape(rootDir)} --include="*.js" --include="*.ts" --include="*.json" --include="*.cds" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | head -${maxResults}`,
    org, space, 60000
  )
  return out.split('\n').filter(Boolean).map(l => {
    const idx = l.indexOf(':')
    if (idx < 0) return { path: '', line: l }
    const rest = l.substring(idx + 1)
    const lineIdx = rest.indexOf(':')
    if (lineIdx < 0) return { path: l.substring(0, idx), line: rest }
    return { path: l.substring(0, idx), line: rest.substring(lineIdx + 1).trim() }
  }).filter(r => r.path)
}

export async function viewRemoteFileLine(
  appName: string, org: string, space: string,
  filePath: string, line: number, context = 5
): Promise<string> {
  const start = Math.max(1, line - context)
  const end = line + context
  return runRemote(appName,
    `sed -n '${start},${end}p' ${shellEscape(filePath)} 2>/dev/null || echo '-- file not found --'`,
    org, space, 15000
  )
}
