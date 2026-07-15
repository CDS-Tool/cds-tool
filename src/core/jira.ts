import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

interface JiraToken {
  accessToken: string
  siteUrl: string
  email: string
}

function loadJiraToken(): JiraToken | null {
  const tokenPath = path.join(os.homedir(), '.jira-oauth', 'tokens.json')
  try {
    const raw = fs.readFileSync(tokenPath, 'utf-8')
    const tokens = JSON.parse(raw)
    const entry = tokens?.default || Object.values(tokens)[0]
    if (!entry) return null
    return {
      accessToken: entry.accessToken || entry.access_token,
      siteUrl: entry.siteUrl || entry.site_url,
      email: entry.email || entry.user,
    }
  } catch {
    return null
  }
}

async function jiraFetch(
  path_: string,
  options?: { method?: string; body?: any }
): Promise<any> {
  const token = loadJiraToken()
  if (!token) throw new Error('No Jira OAuth token found. Use JiraOps to authenticate first.')

  const url = `${token.siteUrl.replace(/\/$/, '')}/rest/api/3${path_}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    'Content-Type': 'application/json',
  }

  const resp = await fetch(url, {
    method: options?.method ?? 'GET',
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15000),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Jira API ${resp.status}: ${text}`)
  }

  if (resp.status === 204) return {}
  return resp.json()
}

export interface JiraIssue {
  key: string
  summary: string
  status: string
  assignee?: string
  priority?: string
  created: string
  updated: string
}

export async function searchIssues(jql: string, maxResults = 20): Promise<JiraIssue[]> {
  const data = await jiraFetch('/search', {
    method: 'POST',
    body: {
      jql,
      maxResults,
      fields: ['summary', 'status', 'assignee', 'priority', 'created', 'updated'],
    },
  })
  return (data.issues ?? []).map((i: any) => ({
    key: i.key,
    summary: i.fields?.summary ?? '',
    status: i.fields?.status?.name ?? '',
    assignee: i.fields?.assignee?.displayName,
    priority: i.fields?.priority?.name,
    created: i.fields?.created,
    updated: i.fields?.updated,
  }))
}

export async function getIssue(issueKey: string): Promise<JiraIssue & { description?: string }> {
  const data = await jiraFetch(`/issue/${issueKey}`)
  return {
    key: data.key,
    summary: data.fields?.summary ?? '',
    status: data.fields?.status?.name ?? '',
    assignee: data.fields?.assignee?.displayName,
    priority: data.fields?.priority?.name,
    created: data.fields?.created,
    updated: data.fields?.updated,
    description: data.fields?.description,
  }
}

export async function transitionIssue(issueKey: string, transitionId: string): Promise<void> {
  await jiraFetch(`/issue/${issueKey}/transitions`, {
    method: 'POST',
    body: { transition: { id: transitionId } },
  })
}

export async function addComment(issueKey: string, comment: string): Promise<void> {
  await jiraFetch(`/issue/${issueKey}/comment`, {
    method: 'POST',
    body: { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] } },
  })
}
