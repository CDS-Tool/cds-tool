// Unit tests for cds-tool core modules
// Run: npx tsx src/test/unit.test.ts

import { parseCfAppsTable } from '../core/cfClient'
import { parseEventsTable } from '../core/cfEvents'
import { processLogLine, queryLogs, clearLogs, LogFilter } from '../core/logPipeline'
import { MOCK_APPS_OUTPUT, MOCK_EVENTS_OUTPUT } from './cfMock'

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
  }
}

function assertEq(actual: any, expected: any, msg: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.error(`  ✗ ${msg}`)
    console.error(`    expected: ${e}`)
    console.error(`    actual:   ${a}`)
  }
}

async function testParseCfAppsTable(): Promise<void> {
  console.log('\n--- parseCfAppsTable ---')
  const apps = parseCfAppsTable(MOCK_APPS_OUTPUT)
  assert(apps.length === 3, 'parses 3 apps')
  assert(apps[0].name === 'my-app', 'first app name is my-app')
  assert(apps[0].state === 'started', 'my-app is started')
  assert(apps[0].urls.length === 1, 'my-app has 1 URL')
  assert(apps[0].urls[0] === 'my-app.cfapps.us10.hana.ondemand.com', 'my-app URL correct')
  assert(apps[1].name === 'my-api', 'second app is my-api')
  assert(apps[2].state === 'stopped', 'my-worker is stopped')
}

async function testParseEvents(): Promise<void> {
  console.log('\n--- parseEventsTable ---')
  const events = parseEventsTable(MOCK_EVENTS_OUTPUT)
  assert(events.length === 3, 'parses 3 events')
  assert(events[0].event === 'audit.app.start', 'first event is start')
  assert(events[1].event === 'audit.app.ssh', 'second event is SSH')
  assert(events[2].description === 'App restarted', 'third event description')
}

async function testLogPipeline(): Promise<void> {
  console.log('\n--- logPipeline ---')

  // Test processing
  const entry1 = processLogLine('test-app', 'This is an ERROR message')
  assert(entry1.level === 'error', 'detects error level')
  
  const entry2 = processLogLine('test-app', 'This is a warning')
  assert(entry2.level === 'warn', 'detects warn level')
  
  const entry3 = processLogLine('test-app', '[GET] /api/v1/users 200 150ms')
  assert(entry3.method === 'GET', 'parses router method')
  assert(entry3.path === '/api/v1/users', 'parses router path')
  assert(entry3.status === 200, 'parses router status')

  // Test redaction
  const entry4 = processLogLine('test-app', 'SAP_PASSWORD=supersecret')
  assert(!entry4.message.includes('supersecret'), 'redacts SAP_PASSWORD')

  const entry5 = processLogLine('test-app', 'Authorization: Bearer eyJhbGci')
  assert(!entry5.message.includes('eyJhbGci'), 'redacts Bearer token')

  // Test storage and query
  await new Promise(r => setTimeout(r, 100))
  const results = queryLogs('test-app', { level: 'error' })
  assert(results.length >= 1, 'finds error-level logs from storage')

  const resultsFiltered = queryLogs('test-app', { query: 'ERROR' })
  assert(resultsFiltered.length >= 1, 'finds logs matching query')

  clearLogs('test-app')
  const afterClear = queryLogs('test-app')
  assert(afterClear.length === 0, 'clears logs from storage')
}

async function main(): Promise<void> {
  console.log('cds-tool unit tests')
  console.log('==================')

  await testParseCfAppsTable()
  await testParseEvents()
  await testLogPipeline()

  console.log(`\n${'='.repeat(20)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => {
  console.error('Test error:', err)
  process.exit(1)
})
