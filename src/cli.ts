#!/usr/bin/env node

import { cf, CfError } from './core/cfShell'
import { checkCfCli, checkCfSession, cfLogin, cfOrgs, cfSpaces, cfApps, cfTarget, cfCurrentTarget, cfLogout } from './core/cfClient'
import { executeSql, getHanaCreds, executeParametrizedQuery, listTables } from './core/cfHana'
import { getTokenCached } from './core/xsuaa'
import { runFullSync, readSyncManifest } from './core/cfSync'
import { startTailSession, stopAllTailSessions } from './core/cfTail'
import { lsRemote, findRemoteFiles, grepRemote, readRemoteFile } from './core/packageBrowser'
import { cfAppEvents, cfSpaceEvents } from './core/cfEvents'
import { getCredentials } from './core/shellEnv'

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    console.log(`
cds-tool - CLI for CAP Cloud Foundry debugging

Usage:
  cds-tool login <api> <email> <password>             Login to CF
  cds-tool orgs                                        List orgs
  cds-tool spaces <org>                                List spaces
  cds-tool apps <org> <space>                          List apps
  cds-tool target [org] [space]                        Show/set target
  cds-tool sql <app> <org> <space> <sql>               Run SQL query
  cds-tool sql-param <app> <org> <space> <sql>         Run parameterized query
  cds-tool tables <app> <org> <space> [schema]         List HANA tables
  cds-tool hana-creds <app>                            Get HANA credentials
  cds-tool token <app> <org> <space>                   Get XSUAA token
  cds-tool sync <email> <password> [regions...]        Sync CF landscape
  cds-tool tail <app> <org> <space>                    Tail app logs
  cds-tool ls <app> <org> <space> [dir]                List remote files
  cds-tool find <app> <org> <space> <dir> <pattern>    Find remote files
  cds-tool grep <app> <org> <space> <query>            Grep remote files
  cds-tool cat <app> <org> <space> <path>              Read remote file
  cds-tool events <app> <org> <space>                  Get app events
  cds-tool space-events <org> <space>                  Get space events
  cds-tool version                                     Show version
`)
    process.exit(0)
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    const pkg = require('../package.json')
    console.log(pkg.version || '1.0.0')
    process.exit(0)
  }

  try {
    switch (command) {
      case 'login': {
        const [, api, email, pw] = args
        if (!api || !email || !pw) throw new Error('Usage: cds-tool login <api> <email> <password>')
        await cfLogin(api, email, pw)
        console.log('Logged in to', api)
        break
      }
      case 'orgs': {
        const orgs = await cfOrgs()
        orgs.forEach(o => console.log(o))
        break
      }
      case 'spaces': {
        const org = args[1]
        if (!org) throw new Error('Usage: cds-tool spaces <org>')
        const spaces = await cfSpaces(org)
        spaces.forEach(s => console.log(s))
        break
      }
      case 'apps': {
        const [, org, space] = args
        if (!org || !space) throw new Error('Usage: cds-tool apps <org> <space>')
        const apps = await cfApps(org, space)
        apps.forEach(a => console.log(`${a.name}\t${a.state}\t${a.urls.join(',')}`))
        break
      }
      case 'target': {
        const [, org, space] = args
        if (org && space) {
          await cfTarget(org, space)
          console.log(`Targeted ${org}/${space}`)
        } else {
          const t = await cfCurrentTarget()
          if (t) console.log(`${t.apiEndpoint}\t${t.user}\t${t.org}\t${t.space}`)
          else console.log('Not logged in')
        }
        break
      }
      case 'sql': {
        const [, app, org, space, ...sqlParts] = args
        if (!app || !org || !space || !sqlParts.length) throw new Error('Usage: cds-tool sql <app> <org> <space> <sql>')
        const sql = sqlParts.join(' ')
        const result = await executeSql(app, org, space, sql)
        console.log(JSON.stringify(result, null, 2))
        break
      }
      case 'sql-param': {
        const [, app, org, space, ...sqlParts] = args
        if (!app || !org || !space || !sqlParts.length) throw new Error('Usage: cds-tool sql-param <app> <org> <space> <sql> [params...]')
        const idx = sqlParts.findIndex(p => p === '--')
        const sql = idx >= 0 ? sqlParts.slice(0, idx).join(' ') : sqlParts.join(' ')
        const params = idx >= 0 ? sqlParts.slice(idx + 1).map(p => { try { return JSON.parse(p) } catch { return p } }) : []
        const result = await executeParametrizedQuery(app, org, space, sql, params.length ? params : undefined)
        console.log(JSON.stringify(result, null, 2))
        break
      }
      case 'tables': {
        const [, app, org, space, schema] = args
        if (!app || !org || !space) throw new Error('Usage: cds-tool tables <app> <org> <space> [schema]')
        const result = await listTables(app, org, space, schema)
        console.log(JSON.stringify(result, null, 2))
        break
      }
      case 'hana-creds': {
        const [, app, org, space] = args
        if (!app || !org || !space) throw new Error('Usage: cds-tool hana-creds <app> <org> <space>')
        const raw = await getHanaCreds(app, org, space)
        console.log(JSON.stringify(raw, null, 2))
        break
      }
      case 'token': {
        const [, app, org, space] = args
        if (!app || !org || !space) throw new Error('Usage: cds-tool token <app> <org> <space>')
        const token = await getTokenCached(app, org, space, (t, m) => { if (t === 'err') console.error(m) })
        console.log(token || 'No token')
        break
      }
      case 'sync': {
        const [, email, pw, ...regions] = args
        if (!email || !pw) throw new Error('Usage: cds-tool sync <email> <password> [regions...]')
        await runFullSync(email, pw, regions.length ? regions : undefined, m => console.error(m))
        console.log('Sync complete')
        break
      }
      case 'tail': {
        const [, ...appNames] = args
        if (appNames.length < 3) throw new Error('Usage: cds-tool tail <app> <org> <space> [more apps...]')
        const space = appNames.pop()!
        const org = appNames.pop()!
        startTailSession(appNames, org, space)
        console.log(`Tailing ${appNames.join(', ')}...`)
        break
      }
      case 'ls': {
        const [, app, org, space, dir] = args
        if (!app || !org || !space) throw new Error('Usage: cds-tool ls <app> <org> <space> [dir]')
        const result = await lsRemote(app, org, space, dir || '/home/vcap/app')
        console.log(result)
        break
      }
      case 'find': {
        const [, app, org, space, dir, pattern] = args
        if (!app || !org || !space || !pattern) throw new Error('Usage: cds-tool find <app> <org> <space> <dir> <pattern>')
        const result = await findRemoteFiles(app, org, space, dir || '/home/vcap/app', pattern)
        result.forEach(r => console.log(r))
        break
      }
      case 'grep': {
        const [, app, org, space, ...queryParts] = args
        if (!app || !org || !space || !queryParts.length) throw new Error('Usage: cds-tool grep <app> <org> <space> <query>')
        const query = queryParts.join(' ')
        const result = await grepRemote(app, org, space, query)
        result.forEach(r => console.log(`${r.path}: ${r.line}`))
        break
      }
      case 'cat': {
        const [, app, org, space, ...pathParts] = args
        if (!app || !org || !space || !pathParts.length) throw new Error('Usage: cds-tool cat <app> <org> <space> <path>')
        const content = await readRemoteFile(app, org, space, pathParts.join(' '))
        console.log(content)
        break
      }
      case 'events': {
        const [, app, org, space] = args
        if (!app || !org || !space) throw new Error('Usage: cds-tool events <app> <org> <space>')
        await cfTarget(org, space)
        const events = await cfAppEvents(app)
        events.forEach(e => console.log(`${e.time}\t${e.actor}\t${e.event}\t${e.description}`))
        break
      }
      case 'space-events': {
        const [, org, space] = args
        if (!org || !space) throw new Error('Usage: cds-tool space-events <org> <space>')
        await cfTarget(org, space)
        const events = await cfSpaceEvents()
        events.forEach(e => console.log(`${e.time}\t${e.actor}\t${e.event}\t${e.description}`))
        break
      }
      default:
        console.error('Unknown command:', command)
        console.error('Run cds-tool --help for usage')
        process.exit(1)
    }
  } catch (err: any) {
    console.error('Error:', err.stderr || err.message)
    process.exit(1)
  }
}

main()
