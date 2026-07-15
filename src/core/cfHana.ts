import { cfEnv, parseVCAPServices, extractHanaCreds } from './cfClient'
import type { DbCredentials } from '../types'
import { EventEmitter } from 'node:events'

export const events = new EventEmitter()

interface TransactionSession {
  client: any
  appName: string
}

const transactions = new Map<string, TransactionSession>()

async function getHdbClient(appName: string, org: string, space: string): Promise<any> {
  const creds = await getHanaCreds(appName, org, space)
  let hdb: any
  try {
    hdb = await import('hdb')
  } catch {
    throw new Error('Install hdb package: npm install hdb')
  }
  const client = hdb.createConnection({
    host: creds.host,
    port: creds.port,
    database: creds.database.trim(),
    user: creds.user,
    password: creds.password,
  })
  return new Promise((resolve, reject) => {
    client.on('error', (err: any) => reject(new Error(`HANA error: ${err.message}`)))
    client.connect((err: any) => {
      if (err) reject(new Error(`HANA connect failed: ${err.message}`))
      else resolve(client)
    })
  })
}

export async function getHanaCreds(appName: string, org: string, space: string): Promise<DbCredentials> {
  const raw = await cfEnv(appName)
  const vcap = parseVCAPServices(raw)
  if (!vcap) throw new Error('No VCAP_SERVICES found')
  const creds = extractHanaCreds(vcap)
  if (!creds) throw new Error('No HANA credentials found')
  return creds
}

export async function executeSql(
  appName: string, org: string, space: string, sql: string,
  _log?: (type: string, msg: string) => void
): Promise<{ columns: string[]; rows: any[][] }> {
  const client = await getHdbClient(appName, org, space)
  return new Promise((resolve, reject) => {
    client.exec(sql, (execErr: any, rows: any[]) => {
      client.disconnect()
      if (execErr) return reject(new Error(`HANA query error: ${execErr.message}`))
      if (!rows || rows.length === 0) return resolve({ columns: [], rows: [] })
      const columns = Object.keys(rows[0])
      const result = rows.map(row => columns.map(col => row[col] ?? null))
      resolve({ columns, rows: result })
    })
  })
}

export async function executeParametrizedQuery(
  appName: string, org: string, space: string, sql: string, params?: any[]
): Promise<{ columns: string[]; rows: any[][] }> {
  const client = await getHdbClient(appName, org, space)
  return new Promise((resolve, reject) => {
    client.prepare(sql, (prepareErr: any, statement: any) => {
      if (prepareErr) {
        client.disconnect()
        return reject(new Error(`Prepare error: ${prepareErr.message}`))
      }
      statement.exec(params || [], (execErr: any, rows: any[]) => {
        statement.drop(() => {})
        client.disconnect()
        if (execErr) return reject(new Error(`Query error: ${execErr.message}`))
        if (!rows || rows.length === 0) return resolve({ columns: [], rows: [] })
        const columns = Object.keys(rows[0])
        const result = rows.map(row => columns.map(col => row[col] ?? null))
        resolve({ columns, rows: result })
      })
    })
  })
}

export async function beginTransaction(appName: string, org: string, space: string): Promise<string> {
  const client = await getHdbClient(appName, org, space)
  return new Promise((resolve, reject) => {
    client.setAutoCommit(false)
    client.exec('BEGIN', (err: any) => {
      if (err) {
        client.disconnect()
        return reject(new Error(`BEGIN failed: ${err.message}`))
      }
      const sessionId = `tx_${appName}_${Date.now()}`
      transactions.set(sessionId, { client, appName })
      events.emit('transactionStarted', sessionId)
      resolve(sessionId)
    })
  })
}

export async function commit(sessionId: string): Promise<void> {
  const session = transactions.get(sessionId)
  if (!session) throw new Error('Transaction session not found: ' + sessionId)
  return new Promise((resolve, reject) => {
    session.client.commit((err: any) => {
      session.client.disconnect()
      transactions.delete(sessionId)
      if (err) return reject(new Error(`COMMIT failed: ${err.message}`))
      events.emit('transactionCommitted', sessionId)
      resolve()
    })
  })
}

export async function rollback(sessionId: string): Promise<void> {
  const session = transactions.get(sessionId)
  if (!session) throw new Error('Transaction session not found: ' + sessionId)
  return new Promise((resolve, reject) => {
    session.client.rollback((err: any) => {
      session.client.disconnect()
      transactions.delete(sessionId)
      if (err) return reject(new Error(`ROLLBACK failed: ${err.message}`))
      events.emit('transactionRolledBack', sessionId)
      resolve()
    })
  })
}

export async function execInTransaction(sessionId: string, sql: string, params?: any[]): Promise<{ columns: string[]; rows: any[][] }> {
  const session = transactions.get(sessionId)
  if (!session) throw new Error('Transaction session not found: ' + sessionId)
  return new Promise((resolve, reject) => {
    session.client.prepare(sql, (prepareErr: any, statement: any) => {
      if (prepareErr) return reject(new Error(`Prepare error: ${prepareErr.message}`))
      statement.exec(params || [], (execErr: any, rows: any[]) => {
        if (execErr) return reject(new Error(`Query error: ${execErr.message}`))
        if (!rows || rows.length === 0) return resolve({ columns: [], rows: [] })
        const columns = Object.keys(rows[0])
        const result = rows.map(row => columns.map(col => row[col] ?? null))
        resolve({ columns, rows: result })
      })
    })
  })
}

export function disposeTransactions(): void {
  for (const [, session] of transactions) {
    try { session.client.disconnect() } catch {}
  }
  transactions.clear()
}

export async function listTables(
  appName: string, org: string, space: string, schema?: string
): Promise<{ columns: string[]; rows: any[][] }> {
  const sql = schema
    ? `SELECT TABLE_NAME, TABLE_TYPE, SCHEMA_NAME FROM TABLES WHERE SCHEMA_NAME = '${schema.replace(/'/g, "''")}' ORDER BY TABLE_NAME`
    : `SELECT TABLE_NAME, TABLE_TYPE, SCHEMA_NAME FROM TABLES ORDER BY TABLE_NAME`
  return executeSql(appName, org, space, sql)
}
