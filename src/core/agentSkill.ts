import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface SkillOptions {
  name?: string
  description?: string
  version?: string
}

export interface SmdgResult {
  success: boolean
  skillPath?: string
  output?: string
  error?: string
}

export function checkSmdgCli(): boolean {
  try {
    execSync('smdg --version', { stdio: 'pipe', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

export async function smdgLogin(): Promise<SmdgResult> {
  try {
    const output = execSync('smdg login', { stdio: 'pipe', timeout: 30000, encoding: 'utf-8' })
    return { success: true, output }
  } catch (err: any) {
    return { success: false, error: err.stderr || err.message }
  }
}

export function smdgLogout(): SmdgResult {
  try {
    execSync('smdg logout', { stdio: 'pipe', timeout: 10000 })
    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

export async function smdgGenerate(
  sources: string[],
  name?: string,
  category?: string,
  install?: 'claude' | 'codex'
): Promise<SmdgResult> {
  try {
    const args = sources.map(s => `--source ${shellEscape(s)}`).join(' ')
    const nameFlag = name ? ` --name ${shellEscape(name)}` : ''
    const catFlag = category ? ` --category ${shellEscape(category)}` : ''
    const installFlag = install ? ` --install ${install}` : ''
    const cmd = `smdg generate ${args}${nameFlag}${catFlag}${installFlag}`
    const output = execSync(cmd, { stdio: 'pipe', timeout: 120000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 })
    const skillPath = extractSkillPath(output)
    return { success: true, skillPath, output }
  } catch (err: any) {
    return { success: false, error: err.stderr || err.message }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

function extractSkillPath(output: string): string | undefined {
  const m = output.match(/skill (?:at|saved to|written to)\s+['"]?([^\s'"]+\.md)['"]?/i)
  return m?.[1] ?? undefined
}

export function smdgInstall(skillName: string, platform: 'claude' | 'codex'): SmdgResult {
  try {
    const output = execSync(
      `smdg install --platform ${platform} --skill ${shellEscape(skillName)}`,
      { stdio: 'pipe', timeout: 30000, encoding: 'utf-8' }
    )
    return { success: true, output }
  } catch (err: any) {
    return { success: false, error: err.stderr || err.message }
  }
}

export function smdgCredits(): string {
  try {
    return execSync('smdg credits', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' }).trim()
  } catch {
    return 'Not available'
  }
}

export function smdgListSkills(): string {
  try {
    return execSync('smdg skills', { stdio: 'pipe', timeout: 10000, encoding: 'utf-8' }).trim()
  } catch {
    return 'Not available'
  }
}

// --- Local fallback skill generation (same as before) ---

const SKILL_TEMPLATE = `---
name: cds-tool-cap-debugger
description: >
  Complete reference for debugging SAP CAP applications on Cloud Foundry using the cds-tool VS Code extension.
  Covers CF login, org/space navigation, multi-app SSH tunneling, HANA SQL queries, log streaming,
  remote breakpoints, HTTP tracing, XSUAA token management, file downloads, and landscape sync.
generated_by: cds-tool
generator_url: https://github.com/CDS-Tool/cds-tool
version: "{{VERSION}}"
---

# cds-tool CAP Debugging Agent Skill

This skill teaches an AI agent how to debug SAP CAP (Cloud Application Programming) applications on SAP BTP Cloud Foundry using the cds-tool VS Code extension and CLI.

## Overview

cds-tool is a VS Code extension and CLI tool for:
- Debugging CAP applications running on Cloud Foundry
- Streaming application logs (single and multi-app)
- Querying HANA Cloud databases
- Managing XSUAA OAuth2 tokens
- Browsing remote files via SSH
- Monitoring app health (watchdog)
- Setting remote breakpoints and tracing HTTP traffic

## Available Commands

### VS Code Extension Commands

These commands are available in the VS Code command palette (Ctrl+Shift+P):

| Command | Description |
|---------|-------------|
| \`CDS Tool: Open Panel\` | Open the main cds-tool sidebar panel |
| \`CDS Tool: Stream App Logs\` | Stream logs for a single app to output channel |
| \`CDS Tool: Add Database Connection\` | Add HANA SQLTools connection |
| \`CDS Tool: Open App in Browser\` | Open a CF app URL in browser |
| \`CDS Tool: Show App Watchdog\` | Show app health monitoring status |
| \`CDS Tool: Sync CF Landscape\` | Sync all CF regions/orgs/spaces/apps to local cache |
| \`CDS Tool: Get XSUAA Token\` | Fetch OAuth2 token from XSUAA binding |
| \`CDS Tool: Restart CF App\` | Restart a Cloud Foundry application |

### CLI Commands

The \`cds-tool\` CLI provides programmatic access. Install: \`npm i -g cds-tool\`

#### Authentication & Navigation
\`\`\`bash
# Login to CF
cds-tool login <api-endpoint> <email> <password>

# List orgs
cds-tool orgs

# List spaces in org
cds-tool spaces <org>

# List apps in space
cds-tool apps <org> <space>

# Show or set CF target
cds-tool target [org] [space]
\`\`\`

#### Database (HANA Cloud)
\`\`\`bash
# Run SQL query
cds-tool sql <app> <org> <space> "SELECT * FROM TABLES"

# Run parameterized query
cds-tool sql-param <app> <org> <space> "SELECT * FROM MY_TABLE WHERE ID = ?" -- 123

# List HANA tables
cds-tool tables <app> <org> <space> [schema]

# Get HANA credentials
cds-tool hana-creds <app> <org> <space>
\`\`\`

#### Logs & Monitoring
\`\`\`bash
# Tail app logs
cds-tool tail <app> <org> <space>

# Get app audit events
cds-tool events <app> <org> <space>

# Get space events
cds-tool space-events <org> <space>
\`\`\`

#### Remote File Access
\`\`\`bash
# List remote directory
cds-tool ls <app> <org> <space> [/path]

# Find files
cds-tool find <app> <org> <space> <dir> <pattern>

# Grep remote files
cds-tool grep <app> <org> <space> <query>

# Read remote file
cds-tool cat <app> <org> <space> <path>
\`\`\`

#### XSUAA & Landscape
\`\`\`bash
# Get XSUAA token
cds-tool token <app> <org> <space>

# Sync CF landscape
cds-tool sync <email> <password> [regions...]
\`\`\`

## Debugging CAP Applications

### Workflow

1. **Open the panel**: Run "CDS Tool: Open Panel" or click the CDS Tool icon in the activity bar.
2. **Login**: Select a region or enter a CF API endpoint, enter credentials, click Login.
3. **Select target**: Choose Org and Space from the dropdowns.
4. **Select apps**: Check the apps to debug in the Apps tab.
5. **Start debugging**: Click "Start Debug Selected" in the Debug tab.
6. **Watchdog**: After debugging starts, the watchdog monitors app health for 8 hours.

### SSH Tunnel Debugging

cds-tool uses \`cf ssh\` to create SSH tunnels for Node.js inspector debugging:
1. Enables SSH on the app if disabled (restarts app if needed)
2. Sends SIGUSR1 to the Node.js process to enable inspector
3. Creates SSH tunnel: \`cf ssh <app> -L <local-port>:localhost:9229 -N\`
4. Probes the local port until the inspector is ready
5. Creates VS Code attach launch configuration in \`.vscode/launch.json\`
6. Attaches the VS Code debugger automatically

Each debug session uses an isolated CF_HOME directory (\`~/.cds-tool/cf-homes/<org>-<space>/\`) to prevent CF CLI session conflicts.

### Remote Breakpoints & Inspector

For advanced debugging with Chrome DevTools Protocol:
\`\`\`typescript
// Set breakpoint
await setBreakpoint(appName, org, space, url, lineNumber, condition?, logMessage?, hitCondition?)

// Set exception breakpoint  
await setExceptionBreakpoint(appName, org, space)

// Get current stack
await getStack(appName)

// List active breakpoints
listBreakpoints(appName)

// Remove breakpoint
await removeBreakpoint(appName, breakpointId)
\`\`\`

### HTTP Live Tracing

Inject runtime HTTP tracing into a running app:
\`\`\`
START_TRACE -> monkey-patches http.createServer to intercept all requests
STOP_TRACE  -> removes the trace hook
\`\`\`
Captures: method, URL, headers (redacted), status code, duration.

## HANA Database Operations

### SQL Execution Flow
1. Fetch \`VCAP_SERVICES\` via \`cf env\`
2. Extract HANA credentials (host, port, database, user, password)
3. Connect via \`hdb\` npm package (must be installed separately)
4. Execute SQL, return column-oriented results

### Transaction Support
\`\`\`
BEGIN_TRANSACTION -> creates HANA connection with autoCommit=false
COMMIT <sessionId> -> commits and disconnects
ROLLBACK <sessionId> -> rolls back and disconnects
\`\`\`

## Log Pipeline

All log streams pass through a processing pipeline:
1. **Redaction**: Auto-redacts \`SAP_EMAIL\`, \`SAP_PASSWORD\`, \`password\`, \`Authorization\`, \`api_key\`, \`secret\`, \`token\`
2. **Parsing**: Detects log levels (error/warn/info/debug), router access patterns (\`[GET] /path 200 150ms\`), and JSON logs
3. **Storage**: Appends to \`~/.cds-tool/logs/<app>.jsonl\` (bounded to 10k entries)
4. **Filtering**: Filter by text query, level, source, tenant, status code, time window
5. **Query**: \`queryLogs(appName, filter)\` returns filtered log entries

## XSUAA Token Management

1. Extract XSUAA binding from \`VCAP_SERVICES\` (looks for \`xsuaa\` in service keys)
2. The binding contains: \`url\`, \`clientid\`, \`clientsecret\`, \`xsappname\`
3. Fetch OAuth2 token via \`client_credentials\` grant:
   \`\`\`
   POST <url>/oauth/token
   Content-Type: application/x-www-form-urlencoded
   Authorization: Basic base64(<clientid>:<clientsecret>)
   grant_type=client_credentials&response_type=token
   \`\`\`

## Error Handling

- CF CLI must be on PATH (checked on extension activation)
- All CF API errors include stderr output for debugging
- SQL errors are caught and displayed in the webview
- Inspector connection failures gracefully degrade
- Watchdog sends VS Code warning on app unresponsive for 3+ consecutive pings
- 8-hour TTL on watchdog (auto-stops after 8h)

## Best Practices

1. **Environment variables**: Set \`SAP_EMAIL\` and \`SAP_PASSWORD\` for zero-input login
2. **Workspace**: Open a workspace folder before debugging (needed for \`launch.json\`)
3. **HANA SQL**: Install \`hdb\` package: \`npm install hdb\`
4. **Multiple apps**: Check multiple apps to start parallel debug sessions
5. **SSH**: Ensure SSH is enabled on the CF space (\`cf enable-ssh <app>\`)
6. **Port conflicts**: Debug ports start at 9229 and auto-increment

## Quick Reference

### Webview Message Flow (Extension -> Webview)
- \`CONFIG_LOADED\` - Initial config and session state
- \`APPS_LOADED\` - App list for selected org/space
- \`SPACES_LOADED\` - Space list for selected org
- \`SESSION_UPDATED\` - Debug session status change
- \`LOGS_LINE\` / \`TAIL_LINE\` - Log output
- \`SQL_RESULT\` / \`QUERY_RESULT\` - Database query results
- \`BREAKPOINT_HIT\` - Remote breakpoint triggered
- \`TRACE_LINE\` - HTTP trace event
- \`EVENTS_LOADED\` - CF audit events
- \`WATCHDOG_UPDATE\` - Health check status
- \`CONNECTION_HEALTH\` - CF session status
- \`SYNC_STATUS\` - Landscape sync progress

### Key Files
- \`~/.cds-tool/cf-structure.json\` - Cached CF topology
- \`~/.cds-tool/logs/<app>.jsonl\` - Stored log entries
- \`~/.cds-tool/cf-homes/<org>-<space>/\` - Isolated CF config per session
- \`.vscode/launch.json\` - Generated debug configurations
`

export function generateAgentSkill(localDir: string, options?: SkillOptions): string {
  const name = options?.name || 'cds-tool-cap-debugger'
  const description = options?.description || 'Complete reference for debugging SAP CAP applications on Cloud Foundry using cds-tool'
  const version = options?.version || '1.0.0'

  if (!existsSync(localDir)) mkdirSync(localDir, { recursive: true })

  const skillPath = join(localDir, `${name}.md`)
  const content = SKILL_TEMPLATE.replace('{{VERSION}}', version)
  writeFileSync(skillPath, content, 'utf-8')
  return skillPath
}

export function getSkillCatalogues(localDir: string): { name: string; path: string }[] {
  if (!existsSync(localDir)) return []
  return []
}
