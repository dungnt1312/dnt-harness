// SR-0 acceptance 1, live: an unrecognized provider must get the exact
// historical wire body. Runs the OLD headless (the `main` worktree) and the
// NEW headless against the same store, model and logging proxy, then compares
// the captured chat-completions bodies field by field.
//
// The old CLI has no `--config`, so both runs read the store from an isolated
// temp home (`USERPROFILE`); nothing in the real user profile is touched.
//
// Usage: node scripts/e2e/ab-wire-compat.mjs
// Env:   E2E_OLD_REPO  — old checkout (default C:\laragon\www\dnt-main)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const oldRepo = process.env['E2E_OLD_REPO'] ?? 'C:\\laragon\\www\\dnt-main'
const nodeExec = process.execPath
// TypeScript entry points run on Bun, the harness runtime.
const bunExec = process.env['BUN_BIN'] ?? 'bun'
const upstream = process.env['E2E_UPSTREAM'] ?? 'http://127.0.0.1:6536'
// The old CLI only knows the legacy DeepSeek provider (env-registered); the
// new one resolves the same name/model from the store. Same provider name and
// model ⇒ the A/B compares the old `openai.ts` against the new one.
const model = 'deepseek-chat'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dnt-e2e-ab-'))
const home = path.join(base, 'home')
const storeDir = path.join(home, '.dnt-harness')
const ws = path.join(base, 'ws')
fs.mkdirSync(storeDir, { recursive: true })
fs.mkdirSync(ws, { recursive: true })

const proxyPort = 6798
const store = path.join(storeDir, 'providers.json')
fs.writeFileSync(store, JSON.stringify({
  version: 2,
  defaults: { provider: 'deepseek', model, thinkingLevel: null },
  providers: [{ id: 'deepseek', name: 'deepseek', baseUrl: `http://127.0.0.1:${proxyPort}/v1`, apiKey: '', models: [model], enabled: true }],
  aliases: [],
  aliasGeneration: 0,
}, null, 2))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const proxyLog = path.join(base, 'proxy.jsonl')
const proxy = spawn(nodeExec, [path.join(here, 'log-proxy.mjs'), String(proxyPort), upstream], {
  cwd: repo,
  env: { ...process.env, E2E_LOG: proxyLog },
  stdio: ['ignore', 'pipe', 'pipe'],
})
proxy.stderr.on('data', (part) => process.stderr.write(`[proxy] ${part}`))
let healthy = false
for (let i = 0; i < 100 && !healthy; i++) {
  try { healthy = (await fetch(`http://127.0.0.1:${proxyPort}/v1/models`)).ok } catch { await sleep(100) }
}
if (!healthy) {
  process.stdout.write('FATAL: logging proxy never became healthy\n')
  proxy.kill()
  process.exit(1)
}

const run = ({ label, cliRepo, extraArgs, extraEnv = {}, logFile, dataDir }) => new Promise((resolve) => {
  fs.writeFileSync(logFile, '')
  const child = spawn(bunExec, [
    path.join(cliRepo, 'src', 'bins', 'headless.ts'),
    '--message', 'Reply with the single word ok.',
    '--root', ws,
    '--data-dir', dataDir,
    '--yolo',
    ...extraArgs,
  ], {
    cwd: cliRepo,
    env: {
      ...process.env,
      // The old CLI resolves its store from `homedir()`, so both sides read
      // the same isolated file.
      USERPROFILE: home,
      ...extraEnv,
      E2E_LOG: logFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (part) => { stdout += String(part) })
  child.stderr.on('data', (part) => { stderr += String(part) })
  const timer = setTimeout(() => child.kill(), 120_000)
  child.on('close', (code) => {
    clearTimeout(timer)
    process.stdout.write(`  ${label}: exit=${code}${stdout.includes('[turn provider]') ? ' turn-provider-failure' : ''}\n`)
    resolve({ code, stdout, stderr })
  })
})

const readLog = () => fs.readFileSync(proxyLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))

process.stdout.write(`A/B wire compatibility on '${model}' via ${upstream}\n`)
await run({
  label: 'old (main worktree)',
  cliRepo: oldRepo,
  extraArgs: [],
  extraEnv: { DEEPSEEK_API_KEY: 'ab-key', DEEPSEEK_BASE_URL: `http://127.0.0.1:${proxyPort}/v1` },
  logFile: proxyLog,
  dataDir: path.join(base, 'data-old'),
})
const oldBodies = readLog()
await run({
  label: 'new (working tree)',
  cliRepo: repo,
  extraArgs: ['--config', store, '--provider', 'deepseek', '--model', model],
  logFile: proxyLog,
  dataDir: path.join(base, 'data-new'),
})
const newBodies = readLog()

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok })
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}\n`)
}

const oldFirst = oldBodies[0]
const newFirst = newBodies[0]
check('both sides sent a request', oldFirst !== undefined && newFirst !== undefined, JSON.stringify({ old: oldBodies.length, new: newBodies.length }))
if (oldFirst !== undefined && newFirst !== undefined) {
  const oldKeys = [...oldFirst.keys].sort()
  const newKeys = [...newFirst.keys].sort()
  check('identical body key sets', JSON.stringify(oldKeys) === JSON.stringify(newKeys), `old=${JSON.stringify(oldKeys)} new=${JSON.stringify(newKeys)}`)
  check('same cap field name', (oldFirst.max_tokens !== undefined) === (newFirst.max_tokens !== undefined) && (oldFirst.max_completion_tokens !== undefined) === (newFirst.max_completion_tokens !== undefined), JSON.stringify({ old: [oldFirst.max_tokens, oldFirst.max_completion_tokens], new: [newFirst.max_tokens, newFirst.max_completion_tokens] }))
  check('no store on either side', oldFirst.store === undefined && newFirst.store === undefined)
  check('no prompt_cache_key on either side', oldFirst.prompt_cache_key === undefined && newFirst.prompt_cache_key === undefined)
  check('same usage setting', oldFirst.include_usage === newFirst.include_usage, JSON.stringify([oldFirst.include_usage, newFirst.include_usage]))
  check('same model', oldFirst.model === newFirst.model, JSON.stringify([oldFirst.model, newFirst.model]))
}

proxy.kill()
const failed = checks.filter((entry) => !entry.ok).length
process.stdout.write(`\n=== ab wire compat: ${checks.length - failed} passed, ${failed} failed ===\nartifacts: ${base}\n`)
if (failed > 0) process.exitCode = 1
