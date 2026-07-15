import { cfEnv, parseVCAPServices } from './cfClient'

interface XsuaaBinding {
  credentials: {
    clientid: string
    clientsecret: string
    url: string
    xsappname: string
    uaadomain?: string
    identityzone?: string
    zoneid?: string
    verificationkey?: string
  }
  name: string
  label: string
  plan: string
}

export interface XsuaaToken {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
  jti: string
}

export function extractXsuaaBinding(vcap: Record<string, any>): XsuaaBinding | null {
  for (const key of Object.keys(vcap)) {
    const entries = vcap[key]
    if (!Array.isArray(entries)) continue
    for (const e of entries) {
      if (!e.credentials) continue
      const c = e.credentials
      if (c.clientid && c.clientsecret && c.url && (key.includes('xsuaa') || e.label === 'xsuaa')) {
        return e as XsuaaBinding
      }
    }
  }
  return null
}

export async function fetchXsuaaToken(
  appName: string,
  org: string,
  space: string
): Promise<XsuaaToken | null> {
  try {
    const raw = await cfEnv(appName)
    const vcap = parseVCAPServices(raw)
    if (!vcap) throw new Error('No VCAP_SERVICES found')

    const binding = extractXsuaaBinding(vcap)
    if (!binding) throw new Error('No XSUAA binding found')

    const { clientid, clientsecret, url } = binding.credentials
    const tokenUrl = `${url}/oauth/token`
    const basicAuth = Buffer.from(`${clientid}:${clientsecret}`).toString('base64')

    const resp = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        response_type: 'token',
      }),
      signal: AbortSignal.timeout(15000),
    })

    if (!resp.ok) throw new Error(`Token request failed: ${resp.status} ${resp.statusText}`)

    const token = await resp.json() as XsuaaToken
    return token
  } catch (err: any) {
    throw new Error(`XSUAA token error: ${err.message}`)
  }
}

export async function getTokenCached(
  appName: string,
  org: string,
  space: string,
  _log?: (type: string, msg: string) => void
): Promise<string | null> {
  const token = await fetchXsuaaToken(appName, org, space)
  if (!token) return null
  if (_log) _log('ok', `XSUAA token obtained for ${appName} (expires in ${token.expires_in}s)`)
  return token.access_token
}
