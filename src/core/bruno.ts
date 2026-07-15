import { cfEnv, parseVCAPServices } from './cfClient'
import { fetchXsuaaToken } from './xsuaa'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface BrunoEnv {
  url: string
  xsuaa_token: string
  xsuaa_url: string
  xsuaa_clientid: string
  xsuaa_clientsecret: string
}

export async function generateBrunoEnv(
  appName: string,
  org: string,
  space: string
): Promise<BrunoEnv> {
  const raw = await cfEnv(appName)
  const vcap = parseVCAPServices(raw)
  if (!vcap) throw new Error('No VCAP_SERVICES found')

  const xsuaaBinding = Object.values(vcap).flat().find((e: any) =>
    e?.credentials?.clientid && e?.credentials?.clientsecret && e?.credentials?.url
  )
  if (!xsuaaBinding) throw new Error('No XSUAA binding found in app')

  const { clientid, clientsecret, url: xsuaaUrl } = xsuaaBinding.credentials
  const token = await fetchXsuaaToken(appName, org, space)
  const appUrl = vcap?.VCAP_APPLICATION?.uris?.[0]
    ? `https://${vcap.VCAP_APPLICATION.uris[0]}`
    : 'http://localhost'

  return {
    url: appUrl,
    xsuaa_token: token?.access_token ?? '',
    xsuaa_url: xsuaaUrl,
    xsuaa_clientid: clientid,
    xsuaa_clientsecret: clientsecret,
  }
}

export function scaffoldBrunoCollection(
  appName: string,
  env: BrunoEnv,
  outputDir: string
): string {
  const dir = path.join(outputDir, appName)
  fs.mkdirSync(dir, { recursive: true })

  fs.writeFileSync(
    path.join(dir, 'bruno.json'),
    JSON.stringify({
      version: '1',
      name: appName,
      type: 'collection',
      ignore: ['node_modules', '.git'],
    }, null, 2)
  )

  const envContent = `{
  "env": {
    "url": { "value": "${env.url}", "type": "text" },
    "token": { "value": "${env.xsuaa_token}", "type": "text", "secret": true },
    "xsuaa_url": { "value": "${env.xsuaa_url}", "type": "text" },
    "xsuaa_clientid": { "value": "${env.xsuaa_clientid}", "type": "text" },
    "xsuaa_clientsecret": { "value": "${env.xsuaa_clientsecret}", "type": "secret" }
  }
}`
  fs.writeFileSync(path.join(dir, `__cf_${appName}.env.json`), envContent)

  const healthCheck = `meta {
  name: "Health Check"
  method: GET
  url: "{{url}}/health"
  headers: {
    Authorization: "Bearer {{token}}"
    Content-Type: "application/json"
  }
}
`
  fs.writeFileSync(path.join(dir, 'health-check.bru'), healthCheck)

  return dir
}

export async function runBrunoCollection(
  collectionPath: string,
  envVars?: Record<string, string>
): Promise<string> {
  const { execSync } = await import('node:child_process')
  const args = ['run', collectionPath]
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      args.push('--env-var', `${k}=${v}`)
    }
  }
  try {
    const output = execSync(`npx -y bru ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return output
  } catch (err: any) {
    throw new Error(`Bruno run failed: ${err.stderr || err.message}`)
  }
}
