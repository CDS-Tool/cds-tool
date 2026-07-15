import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

interface GitLabMrInfo {
  sourceProjectId: string
  sourceBranch: string
  title: string
  description: string
}

function parseGitLabUrl(url: string): { projectId: string; mrIid: string } | null {
  const patterns = [
    /gitlab\.com\/(.+?)\/-\/merge_requests\/(\d+)/,
    /gitlab\.com\/(.+?)\/merge_requests\/(\d+)/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return { projectId: m[1].replace(/\//g, '%2F'), mrIid: m[2] }
  }
  return null
}

async function fetchMrInfo(projectId: string, mrIid: string, token?: string): Promise<GitLabMrInfo> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const resp = await fetch(
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${mrIid}`,
    { headers }
  )
  if (!resp.ok) throw new Error(`GitLab API error: ${resp.status} ${resp.statusText}`)
  const data = await resp.json() as any
  return {
    sourceProjectId: data.source_project_id?.toString() ?? projectId,
    sourceBranch: data.source_branch,
    title: data.title,
    description: data.description ?? '',
  }
}

export async function portMr(
  sourceMrUrl: string,
  destRepoUrl: string,
  destBranch: string,
  gitlabToken?: string
): Promise<string> {
  const parsed = parseGitLabUrl(sourceMrUrl)
  if (!parsed) throw new Error('Could not parse GitLab MR URL')

  const info = await fetchMrInfo(parsed.projectId, parsed.mrIid, gitlabToken)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitport-'))

  try {
    execSync(`git clone --depth=50 ${destRepoUrl} .`, { cwd: tmpDir, stdio: 'pipe', timeout: 120000 })
    execSync(`git checkout -b ${destBranch}`, { cwd: tmpDir, stdio: 'pipe', timeout: 30000 })

    const remoteUrl = `https://gitlab.com/${info.sourceProjectId.replace('%2F', '/')}.git`
    execSync(`git remote add source ${remoteUrl}`, { cwd: tmpDir, stdio: 'pipe', timeout: 10000 })
    execSync(`git fetch source ${info.sourceBranch}`, { cwd: tmpDir, stdio: 'pipe', timeout: 60000 })

    const log = execSync(`git log --oneline FETCH_HEAD..HEAD 2>/dev/null || echo "no commits"`, {
      cwd: tmpDir, encoding: 'utf-8', timeout: 10000,
    }).trim()

    if (log === 'no commits' || !log) {
      execSync(`git merge --no-ff FETCH_HEAD -m "Port: ${info.title}"`, {
        cwd: tmpDir, stdio: 'pipe', timeout: 30000,
      })
    }

    execSync(`git push origin ${destBranch} --no-verify`, { cwd: tmpDir, stdio: 'pipe', timeout: 60000 })

    const projectPath = destRepoUrl
      .replace(/\.git$/, '')
      .replace(/^.*gitlab\.com[:\/]/, '')
      .replace(/^git@/, '')
    const mrResp = await fetch(
      `https://gitlab.com/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(gitlabToken ? { Authorization: `Bearer ${gitlabToken}` } : {}),
        },
        body: JSON.stringify({
          source_branch: destBranch,
          target_branch: 'main',
          title: `[Port] ${info.title}`,
          description: `Ported from ${sourceMrUrl}\n\n${info.description}`,
          draft: true,
        }),
      }
    )
    if (!mrResp.ok) throw new Error(`MR creation failed: ${mrResp.status} ${await mrResp.text()}`)
    const mr = await mrResp.json() as any

    return mr.web_url
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
