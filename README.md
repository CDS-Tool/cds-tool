# CDS Tool

VS Code extension for debugging CAP applications on Cloud Foundry.

## Features

- **Login** to any CF endpoint (SAP BTP, custom)
- **Browse** orgs, spaces, and apps
- **Debug** Node.js CAP apps via SSH tunnel + inspector
- **Stream** `cf logs` in real-time
- **Query** HANA databases via SQLTools

## Requirements

- [VS Code](https://code.visualstudio.com/) ≥ 1.116.0
- [CF CLI](https://github.com/cloudfoundry/cli) installed and on `$PATH`
- Node.js ≥ 18

## Install

### From VSIX (recommended)

Download the latest `.vsix` from [Releases](https://github.com/CDS-Tool/cds-tool/releases), then:

```bash
code --install-extension cds-tool-*.vsix --force
```

### From source

```bash
git clone https://github.com/CDS-Tool/cds-tool.git
cd cds-tool
npm install
npm run build
code --install-extension cds-tool-*.vsix --force
```

## Usage

1. Open VS Code, click the **CDS Tool** icon in the activity bar (or `Cmd+Shift+P` → `CDS Tool: Open Panel`)
2. Enter your CF API endpoint, email, and password
3. Click **Login**
4. Select org → space → apps
5. Debug, stream logs, or query DB

## Development

```bash
git clone https://github.com/CDS-Tool/cds-tool.git
cd cds-tool
npm install
code .           # Open in VS Code
# Press F5 to launch Extension Development Host
```
