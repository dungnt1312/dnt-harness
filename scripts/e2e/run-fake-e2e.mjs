// E2E driver against the deterministic fake gateway - runs the REAL headless
// CLI (real agent loop, real session log, real adapter) end to end:
//
//   1. resend-before-args    - SR-1 fix: turn completes, the LAST header id wins
//      on the wire, and no `conflicting tool ID` failure appears.
//   2. resend-after-args     - strictness kept: the turn fails with
//      `conflicting tool ID` and no tool is executed.
//   3. flaky-then-ok         - a transient 500 is retried and the session
//      affinity stays one stable value across the retry.
//   4. null-id-continuation  - the live relay shape (`id: null`, blank name on
//      every continuation fragment): the turn completes and the real header id
//      reaches the next request.
//   5. multi-null-id         - two parallel calls, indexes arriving out of
//      order, interleaved `id: null` continuations: both calls run and both
//      real ids reach the wire.
//   6. placeholder-then-id   - a blank id placeholder first, the real identity
//      on a later fragment: only the real id reaches the wire.
//   7. http-400              - a structured JSON 400 body: the turn fails with
//      the relay's excerpt in the visible message, and a 400 is never retried
//      (exactly one request, no tool executed).
//
// Usage: node scripts/e2e/run-fake-e2e.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const nodeExec = process.execPath
// TypeScript entry points run on Bun, the harness runtime.
const bunExec = process.env['BUN_BIN'] ?? 'bun'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-e2e-fake-'))
const ws = path.join(base, 'ws')
const data = path.join(base, 'data')
fs.mkdirSync(ws, { recursive: true })
fs.writeFileSync(path.join(ws, 'note.md'), 'alpha\n')
fs.writeFileSync(path.join(ws, 'other.txt'), 'beta\n')

const gateways = []
const failures = []
let passed = 0
let failed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${name}${detail === '' ? '' : ` - ${detail}`}`)
    process.stdout.write(`  FAIL ${name}${detail === '' ? '' : ` - ${detail}`}\n`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitHealthy(port, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`gateway exited early with ${child.exitCode}`)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.ok) return
    } catch { /* not up yet */ }
    await sleep(100)
  }
  throw new Error('gateway never became healthy')
}

async function startGateway(port, mode, extraEnv = {}) {
  const logFile = path.join(base, `gw-${mode}-${port}.jsonl`)
  const child = spawn(nodeExec, [path.join(here, 'fake-gateway.mjs'), String(port), mode], {
    cwd: repo,
    env: { ...process.env, E2E_LOG: logFile, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (part) => process.stderr.write(`[gw ${mode}] ${part}`))
  gateways.push(child)
  await waitHealthy(port, child)
  return logFile
}

function writeStore(file, baseUrl) {
  const store = {
    version: 2,
    defaults: { provider: 'e2egw', model: 'fake-model', thinkingLevel: null },
    providers: [{
      id: 'e2egw',
      name: 'e2egw',
      baseUrl,
      apiKey: '',
      models: ['fake-model'],
      enabled: true,
    }],
    aliases: [],
    aliasGeneration: 0,
  }
  fs.writeFileSync(file, JSON.stringify(store, null, 2))
}

function runCli({ message, store, runData, extraArgs = [], timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const child = spawn(bunExec, [
      path.join(repo, 'src', 'bins', 'headless.ts'),
      '--message', message,
      '--config', store,
      '--root', ws,
      '--data-dir', runData,
      '--yolo',
      ...extraArgs,
    ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (part) => { stdout += String(part) })
    child.stderr.on('data', (part) => { stderr += String(part) })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function readLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

// -- scenario 1: re-sent header before arguments -----------------------------
process.stdout.write('\n[1/7] resend-before-args\n')
{
  const port = 6791
  const logFile = await startGateway(port, 'resend-before-args')
  const store = path.join(base, 'store-before.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'List the workspace files.', store, runData: path.join(data, 'before') })
  const log = readLog(logFile)
  check('exit code 0', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
  check('tool ran', run.stdout.includes('[tool] Glob'), run.stdout.slice(0, 400))
  check('final answer rendered', run.stdout.includes('e2e-after-resend'), run.stdout.slice(-400))
  check('no conflicting tool ID', !run.stdout.includes('conflicting tool ID'), run.stdout.slice(0, 400))
  check('second request carries the LAST header id', log[1]?.assistantIds?.includes('call_b') === true, JSON.stringify(log[1] ?? null))
  check('first id never reaches the wire', log[1]?.assistantIds?.includes('call_a') !== true, JSON.stringify(log[1] ?? null))
}

// -- scenario 2: re-sent header after arguments ------------------------------
process.stdout.write('\n[2/7] resend-after-args\n')
{
  const port = 6792
  const logFile = await startGateway(port, 'resend-after-args')
  const store = path.join(base, 'store-after.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'List the workspace files.', store, runData: path.join(data, 'after') })
  const log = readLog(logFile)
  check('conflicting tool ID surfaced', run.stdout.includes('conflicting tool ID'), run.stdout.slice(0, 400))
  check('no tool executed', !run.stdout.includes('[tool] Glob'), run.stdout.slice(0, 400))
  check('run stops cleanly (no crash)', run.code === 0 && !run.stderr.includes('dnt-harness:'), `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
  check('exactly one model request', log.length === 1, `requests=${log.length}`)
}

// -- scenario 3: transient 500, retried - one stable affinity per session ----
process.stdout.write('\n[3/7] flaky-then-ok (affinity across retry)\n')
{
  const port = 6794
  const logFile = await startGateway(port, 'flaky-then-ok')
  const store = path.join(base, 'store-flaky.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'Reply with a short greeting.', store, runData: path.join(data, 'flaky') })
  const log = readLog(logFile)
  check('run completes after the retry', run.code === 0 && run.stdout.includes('e2e-after-retry'), run.stdout.slice(-400))
  check('retry actually happened', log.length >= 2, `requests=${log.length}`)
  const affinities = [...new Set(log.map((entry) => entry.affinity))]
  check('one stable non-empty affinity across retry', affinities.length === 1 && affinities[0] !== '', JSON.stringify(affinities))
  check('same model on every request', new Set(log.map((entry) => entry.model)).size === 1, JSON.stringify(log.map((entry) => entry.model)))
}

// -- scenario 4: the live `id: null` continuation shape ----------------------
process.stdout.write('\n[4/7] null-id-continuation (live DeepSeek relay shape)\n')
{
  const port = 6795
  const logFile = await startGateway(port, 'null-id-continuation')
  const store = path.join(base, 'store-nullid.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'List the workspace files.', store, runData: path.join(data, 'nullid') })
  const log = readLog(logFile)
  check('exit code 0', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
  check('tool ran', run.stdout.includes('[tool] Glob'), run.stdout.slice(0, 400))
  check('final answer rendered', run.stdout.includes('e2e-null-id-ok'), run.stdout.slice(-400))
  check('no invalid tool ID', !run.stdout.includes('invalid tool ID'), run.stdout.slice(0, 400))
  check('the real header id reaches the wire', log[1]?.assistantIds?.includes('call_real') === true, JSON.stringify(log[1] ?? null))
}
// -- scenario 5: parallel calls, interleaved `id: null` continuations --------
process.stdout.write('\n[5/7] multi-null-id (parallel calls + live null shape)\n')
{
  const port = 6796
  const logFile = await startGateway(port, 'multi-null-id')
  const store = path.join(base, 'store-multi.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'List files with two Glob calls.', store, runData: path.join(data, 'multi') })
  const log = readLog(logFile)
  const toolRuns = (run.stdout.match(/\[tool\] Glob/g) ?? []).length
  check('exit code 0', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
  check('both parallel calls ran', toolRuns >= 2, `toolRuns=${toolRuns} stdout=${run.stdout.slice(0, 400)}`)
  check('final answer rendered', run.stdout.includes('e2e-multi-ok'), run.stdout.slice(-400))
  check('no invalid tool ID', !run.stdout.includes('invalid tool ID'), run.stdout.slice(0, 400))
  const ids = log[1]?.assistantIds ?? []
  check('both real header ids on the wire', ids.includes('call_one') && ids.includes('call_two'), JSON.stringify(ids))
}

// -- scenario 6: blank-id placeholder, real identity arrives later -----------
process.stdout.write('\n[6/7] placeholder-then-id (blank id first, real id later)\n')
{
  const port = 6797
  const logFile = await startGateway(port, 'placeholder-then-id')
  const store = path.join(base, 'store-late.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'List the workspace files.', store, runData: path.join(data, 'late') })
  const log = readLog(logFile)
  check('exit code 0', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
  check('tool ran after the late identity', run.stdout.includes('[tool] Glob'), run.stdout.slice(0, 400))
  check('final answer rendered', run.stdout.includes('e2e-late-ok'), run.stdout.slice(-400))
  check('no invalid tool ID', !run.stdout.includes('invalid tool ID'), run.stdout.slice(0, 400))
  check('only the real id reaches the wire', JSON.stringify(log[1]?.assistantIds) === JSON.stringify(['call_late']), JSON.stringify(log[1]?.assistantIds ?? null))
}

// -- scenario 7: structured HTTP 400 - excerpt surfaced, never retried --------
process.stdout.write('\n[7/7] http-400 (relay excerpt in the surfaced message)\n')
{
  const port = 6798
  const logFile = await startGateway(port, 'http-400')
  const store = path.join(base, 'store-http400.json')
  writeStore(store, `http://127.0.0.1:${port}/v1`)
  const run = await runCli({ message: 'Reply with a short greeting.', store, runData: path.join(data, 'http400') })
  const log = readLog(logFile)
  check('provider turn error surfaced', run.stdout.includes('[turn provider]'), run.stdout.slice(0, 400))
  check('status and reason surfaced', run.stdout.includes('HTTP 400: unknown'), run.stdout.slice(0, 400))
  check('relay excerpt in the visible message', run.stdout.includes('injected relay rejection: bad tool sequence'), run.stdout.slice(0, 400))
  check('400 not retried', log.length === 1, `requests=${log.length}`)
  check('no tool executed', !run.stdout.includes('[tool] Glob'), run.stdout.slice(0, 400))
  check('run stops cleanly (no crash)', run.code === 0 && !run.stderr.includes('dnt-harness:'), `code=${run.code} stderr=${run.stderr.slice(0, 300)}`)
}

for (const child of gateways) child.kill()
process.stdout.write(`\n=== fake e2e: ${passed} passed, ${failed} failed ===\n`)
if (failed > 0) {
  for (const line of failures) process.stdout.write(`- ${line}\n`)
  process.exitCode = 1
}
process.stdout.write(`artifacts: ${base}\n`)

