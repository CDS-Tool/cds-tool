# CDS Tool

> Debug SAP CAP on Cloud Foundry — multi-app SSH tunneling, HANA SQL, live logs, remote breakpoints, HTTP tracing, XSUAA tokens, file explorer, AI skill generation, and 18 CLI commands — all from VS Code.

[![VS Code](https://img.shields.io/badge/vscode-%5E1.116.0-007ACC?logo=visual-studio-code)](https://code.visualstudio.com)
[![Node](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## Features

### Cloud Foundry
| Feature | Description |
|---|---|
| **Region Picker** | 20 SAP BTP regions + custom endpoint |
| **Zero‑input Auth** | Reads `SAP_EMAIL`/`SAP_PASSWORD` from shell env |
| **Live App List** | Started/stopped, search, one-click restart |
| **Service Bindings** | View bound services per app |
| **Landscape Sync** | Cache full CF topology to `~/.cds-tool/cf-structure.json` |
| **App Watchdog** | Ping monitored apps for 8h; alerts on unresponsive |

### Debugging
| Feature | Description |
|---|---|
| **Multi‑app SSH Tunnel** | Start/stop debug sessions for multiple CAP apps in parallel |
| **Auto launch.json** | Generate VS Code attach config automatically |
| **Package Browser** | Browse remote `node_modules` with regex filter |
| **Remote Breakpoints** | Set/remove/list breakpoints, logpoints, exception BPs via CDP |
| **Stack Capture** | Get current call stack from remote app |
| **HTTP Live Trace** | Inject `http.createServer` monkey‑patch; stream request/response traces |
| **Chrome DevTools** | Open `devtools://devtools/bundled/inspector.html` for remote app |

### HANA Database
| Feature | Description |
|---|---|
| **SQL Query Runner** | Execute SELECT/DML/DDL against HANA Cloud |
| **Parameterized Queries** | Safe parameterized SQL with `?` placeholders |
| **Transactions** | `BEGIN`/`COMMIT`/`ROLLBACK` lifecycle |
| **Table Listing** | List tables with optional schema filter |
| **SQLTools Integration** | Export HANA credentials as VS Code SQLTools connection |

### Logs & Events
| Feature | Description |
|---|---|
| **Log Streaming** | Real‑time `cf logs` per app |
| **Multi‑app Tail** | Stream logs from multiple apps simultaneously |
| **Log Pipeline** | Redaction (passwords/tokens), level/source/tenant parsing, router access log parsing |
| **JSONL Storage** | Bounded 10k‑entry store at `~/.cds-tool/logs/<app>.jsonl` |
| **Log Query/Filter** | Filter by level, source, tenant, status, time window |
| **CF Audit Events** | View app events and space events |

### File Operations
| Feature | Description |
|---|---|
| **Remote Explorer** | `ls`, `find`, `grep`, `cat` files on remote app via `cf ssh` |
| **Download File/Folder** | Download single file or entire directory tree |
| **Gen default‑env.json** | Extract `VCAP_SERVICES`/`VCAP_APPLICATION` for local dev |

### XSUAA & Security
| Feature | Description |
|---|---|
| **XSUAA Token** | Fetch OAuth2 `client_credentials` token from app binding |
| **Password Vault** | Credentials stored in VS Code SecretStorage |
| **Audit Events** | SSH session detection, app events, space events |

### Additional Tools
| Feature | Description |
|---|---|
| **Bruno API Runner** | Run Bruno collections with auto‑injected XSUAA tokens |
| **GitPort** | Port GitLab MRs to another repo as Draft MR |
| **Jira Integration** | Search, get, transition, comment on issues (JiraOps OAuth) |
| **SharePoint Excel** | Create/read/append SharePoint workbooks via Graph API |
| **AI Skill Generation** | Generate `smdg.md` for Claude/Cursor/Copilot — or use **Smidge CLI** for AI‑powered skill generation |

### CLI
The `cds-tool` CLI provides 18 commands for scripting:

```
cds-tool login <api> <email> <password>
cds-tool orgs
cds-tool spaces <org>
cds-tool apps <org> <space>
cds-tool target [org] [space]
cds-tool sql <app> <org> <space> <query>
cds-tool sql-param <app> <org> <space> <query> -- <params...>
cds-tool tables <app> <org> <space> [schema]
cds-tool hana-creds <app> <org> <space>
cds-tool token <app> <org> <space>
cds-tool sync <email> <password> [regions...]
cds-tool tail <app> <org> <space>
cds-tool ls <app> <org> <space> [path]
cds-tool find <app> <org> <space> <dir> <pattern>
cds-tool grep <app> <org> <space> <query>
cds-tool cat <app> <org> <space> <path>
cds-tool events <app> <org> <space>
cds-tool space-events <org> <space>
```

---

## Requirements

- **VS Code** ≥ 1.116.0
- **Node.js** ≥ 18
- **CF CLI** on `$PATH` (`cf version` must succeed)
- Environment variables (optional): `SAP_EMAIL`, `SAP_PASSWORD`

---

## Install

### From Marketplace

```bash
ext install cds-tool.cds-tool
```

### From VSIX

```bash
code --install-extension cds-tool-*.vsix --force
```

### CLI only

```bash
npm install -g cds-tool
cds-tool --help
```

---

## Quick Start

1. Open VS Code, click the **CDS Tool** icon in the Activity Bar
2. Pick a region (or enter a custom CF API endpoint)
3. Enter credentials (or set `SAP_EMAIL`/`SAP_PASSWORD` in your shell)
4. Click **Login**
5. Select Org → Space → check apps
6. Use **Debug** tab → **Start Debug Selected** to begin multi‑app debugging
7. Use **Logs** tab to stream, **DB** tab to query HANA, **Tools** tab for file ops / breakpoints / events / skill generation

### Smidge CLI Integration

For AI‑powered skill generation:

```bash
npm install -g smdg-cli
smdg login          # Authenticate with Smidge
```

Then in VS Code: **Tools → AI Skill → Generate (Smidge AI)** — or via command palette:

```bash
CDS Tool: Generate Skill via Smidge
```

The extension auto‑detects `smdg` on PATH. Falls back to local skill generation if unavailable.

---

## Architecture

```
src/
├── core/
│   ├── cfShell.ts          # Shared cf() wrapper (spawn via SHELL -l -c)
│   ├── cfClient.ts         # cf CLI commands (login, orgs, spaces, apps, env, ssh, restart)
│   ├── cfSync.ts           # Landscape sync → ~/.cds-tool/cf-structure.json
│   ├── cfEvents.ts         # Audit events, SSH session detection
│   ├── cfFiles.ts          # Remote file download, gen default-env.json
│   ├── cfInspector.ts      # Remote breakpoints, logpoints, exception BPs via CDP
│   ├── cfLiveTrace.ts      # HTTP trace via CDP monkey-patch
│   ├── cdpClient.ts        # Raw WebSocket ↔ Chrome DevTools Protocol bridge
│   ├── cfHana.ts           # HANA SQL (parameterized, transactions, table listing)
│   ├── cfTail.ts           # Multi-app log tail
│   ├── logPipeline.ts      # Log redact, parse, store, query
│   ├── logsManager.ts      # Log stream manager
│   ├── debugManager.ts     # Debug session lifecycle
│   ├── dbManager.ts        # HANA credentials + SQLTools connection
│   ├── xsuaa.ts            # XSUAA OAuth2 token fetch
│   ├── packageBrowser.ts   # Remote node_modules browser
│   ├── watchdog.ts         # App health monitoring
│   ├── agentSkill.ts       # AI skill generation (local + smdg-cli)
│   ├── bruno.ts            # Bruno collection runner
│   ├── gitport.ts          # GitLab MR porting
│   ├── jira.ts             # Jira Cloud API
│   ├── sharepoint.ts       # SharePoint Excel via Graph API
│   ├── shellEnv.ts         # Environment variable reader
│   ├── regions.ts          # 20 BTP region catalog
│   ├── activityLog.ts      # Output channel logging
│   └── storage/store.ts    # VS Code globalState + SecretStorage
├── webview/
│   └── debugPanel.ts       # Full sidebar UI (all tabs, message handlers)
├── extension.ts            # Activation, commands, deactivation
├── cli.ts                  # 18 CLI commands
├── types.ts                # All WebviewMessage & ExtensionMessage types
└── test/
    └── unit.test.ts        # E2E tests (log pipeline, parse functions, mock data)
```

---

## Development

```bash
git clone https://github.com/CDS-Tool/cds-tool.git
cd cds-tool
npm install
npm run build        # esbuild
npm run typecheck    # tsc --noEmit
npm test             # run unit tests
npm run package      # vsce → .vsix
```

Press `F5` in VS Code to launch Extension Development Host.

---

## VS Code Commands

| Command | Description |
|---|---|
| `CDS Tool: Open Panel` | Open sidebar |
| `CDS Tool: Stream App Logs` | Stream logs to output channel |
| `CDS Tool: Add Database Connection` | Add SQLTools HANA connection |
| `CDS Tool: Open App in Browser` | Open CF app URL |
| `CDS Tool: Show App Watchdog` | Show watchdog status |
| `CDS Tool: Sync CF Landscape` | Sync all regions to cache |
| `CDS Tool: Get XSUAA Token` | Fetch OAuth2 token |
| `CDS Tool: Restart CF App` | Restart app with confirmation |
| `CDS Tool: Setup Bruno Collection` | Scaffold Bruno collection from CF app |
| `CDS Tool: Run Bruno Collection` | Run Bruno collection |
| `CDS Tool: Port GitLab MR` | Port MR to another repo |
| `CDS Tool: Search Jira Issues` | Search Jira by JQL |
| `CDS Tool: Read SharePoint Workbook` | Read SharePoint Excel file |
| `CDS Tool: Smidge Login` | Login to Smidge |
| `CDS Tool: Generate Skill via Smidge` | Generate AI skill using smdg-cli |

---

## License

MIT
