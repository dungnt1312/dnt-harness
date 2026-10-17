// Reproduce and diagnose the live `invalid tool ID` provider failure: runs the
// tool-heavy message through the real gateway via the logging proxy (with raw
// SSE tee and per-request body capture for byte-exact replay) until a run
// fails, then prints the offending stream fragments.
//
// Usage: node scripts/e2e/repro-toolid.mjs [maxRuns]
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
const upstream = process.env['E2E_UPSTREAM'] ?? 'http://127.0.0.1:6536'
const model = process.env['E2E_MODEL'] ?? 'deepseek-v4.1-flash-free'
const maxRuns = Number(process.argv[2] ?? 20)
const message = process.env['E2E_MESSAGE'] ?? 'Read marker.txt, then list the workspace files with Glob, then reply with how many tool calls you made.'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-e2e-repro-'))
const ws = path.join(base, 'ws')
const sseDir = path.join(base, 'sse')
const reqDir = path.join(base, 'reqs')
fs.mkdirSync(ws, { recursive: true })
fs.mkdirSync(sseDir, { recursive: true })
fs.mkdirSync(reqDir, { recursive: true })
fs.writeFileSync(path.join(ws, 'marker.txt'), 'marker-ok\n')

const proxyPort = 6799
const proxyLog = path.join(base, 'proxy.jsonl')
fs.writeFileSync(proxyLog, '')

const store = path.join(base, 'store.json')
fs.writeFileSync(store, JSON.stringify({
  version: 2,
  defaults: { provider: 'ocproxy-e2e', model, thinkingLevel: null },
  providers: [{ id: 'ocproxy-e2e', name: 'ocproxy-e2e', baseUrl: `http://127.0.0.1:${proxyPort}/v1`, apiKey: '', models: [model], enabled: true }],
  aliases: [],
  aliasGeneration: 0,
}, null, 2))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const proxy = spawn(nodeExec, [path.join(here, 'log-proxy.mjs'), String(proxyPort), upstream], {
  cwd: repo,
  env: { ...process.env, E2E_LOG: proxyLog, E2E_SSE_DIR: sseDir, E2E_REQ_DIR: reqDir },
  stdio: ['ignore', 'pipe', 'pipe'],
})
proxy.stderr.on('data', (part) => process.stderr.write(`[proxy] ${part}`))
{
  let healthy = false
  for (let i = 0; i < 100 && !healthy; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)).ok } catch { await sleep(100) }
  }
  if (!healthy) {
    process.stdout.write('FATAL: proxy never became healthy\n')
    proxy.kill()
    process.exit(1)
  }
}

const runCli = (dataDir) => new Promise((resolve) => {
  const child = spawn(bunExec, [
    path.join(repo, 'src', 'bins', 'headless.ts'),
    '--message', message, '--config', store, '--root', ws, '--data-dir', dataDir, '--yolo',
  ], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (part) => { stdout += String(part) })
  child.stderr.on('data', (part) => { stderr += String(part) })
  const timer = setTimeout(() => child.kill(), 150_000)
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
})

const requestCount = () => fs.readFileSync(proxyLog, 'utf8').trim().split('\n').filter(Boolean).length

let failures = 0
for (let attempt = 1; attempt <= maxRuns; attempt++) {
  const dataDir = path.join(base, `data-${attempt}`)
  const before = requestCount()
  const run = await runCli(dataDir)
  const after = requestCount()
  const eventLog = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir, { recursive: true }).map(String).find((file) => file.endsWith('events.jsonl') && file.includes(`${path.sep}sessions${path.sep}`))
    : undefined
  const events = eventLog !== undefined
    ? fs.readFileSync(path.join(dataDir, eventLog), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const error = events.find((event) => event.type === 'turn/error')
  if (error !== undefined) {
    const message = String(error.message ?? '')
    const target = /tool ID|tool identity/iu.test(message)
    if (!target) {
      // Environmental (429/5xx) — not the wire fault under test.
      process.stdout.write(`attempt ${attempt}: other provider error (kind=${error.kind} message=${JSON.stringify(message)}) — continuing\n`)
      continue
    }
    failures += 1
    process.stdout.write(`\nattempt ${attempt}: TURN ERROR kind=${error.kind} message=${JSON.stringify(error.message)}\n`)
    process.stdout.write(`  requests ${before + 1}..${after} of this run\n`)
    for (let n = before + 1; n <= after; n++) {
      const file = path.join(sseDir, `sse-${n}.jsonl`)
      if (!fs.existsSync(file)) continue
      const records = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      const joined = records.filter((record) => typeof record.chunk === 'string').map((record) => record.chunk).join('')
      const idFragments = [...joined.matchAll(/"tool_calls":\[[^\]]*\]/gu)].map((match) => match[0])
      if (idFragments.length > 0) {
        process.stdout.write(`  sse-${n}.jsonl tool_calls fragments:\n`)
        for (const fragment of idFragments.slice(0, 6)) process.stdout.write(`    ${fragment}\n`)
      }
    }
    process.stdout.write(`session events: ${path.join(dataDir, eventLog ?? '(none)')}\nartifacts: ${base}\n`)
    break
  }
  process.stdout.write(`attempt ${attempt}: ok (requests ${after - before}, code=${run.code})\n`)
}

proxy.kill()
process.stdout.write(`\n=== repro done: ${failures} failing run(s) in ${maxRuns} attempt(s) ===\n`)
process.stdout.write(`artifacts: ${base}\n`)
