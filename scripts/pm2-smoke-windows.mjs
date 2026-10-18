#!/usr/bin/env bun
// Windows release smoke of an installed dnt-harness running under PM2:
// interpreter, /api/health, workbench terminals over the real HTTP API
// (bash/PowerShell/cmd: input -> output, resize, DELETE, natural exit), and
// `pm2 restart` / `pm2 stop` within the 15 s kill budget without leaving any
// shell process behind.
//   bun scripts/pm2-smoke-windows.mjs --name dnt-smoke --port 3982
// Expects `dnt-harness start pm2 --name <name> --port <port>` to have run.
// Windows only; other platforms fail (this smoke has nothing to skip to).
import { spawnSync } from 'node:child_process'
import path from 'node:path'

if (process.platform !== 'win32' || !process.versions.bun) {
  console.log('FAIL pm2-smoke-windows: needs Windows and Bun')
  process.exit(1)
}

const flag = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1] ?? fallback
}
const NAME = flag('--name', 'dnt-smoke')
const BASE = `http://127.0.0.1:${flag('--port', '3982')}`
const PM2_BUDGET_MS = 15_000

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (await predicate()) return true; await sleep(100) }
  return predicate()
}
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

// pm2 is a .cmd shim on Windows: it needs a shell.
const pm2 = (args) => spawnSync(`pm2 ${args}`, { shell: true, encoding: 'utf8' })
function app() {
  // jlist prints the JSON on one line; daemon notices such as `[PM2] ...` may precede it.
  const line = pm2('jlist').stdout.split(/\r?\n/).find((l) => l.startsWith('[{') || l.trim() === '[]') ?? '[]'
  const list = JSON.parse(line)
  return list.find((entry) => entry.name === NAME)
}
function processTable() {
  const out = spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }'], { encoding: 'utf8' }).stdout
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, ppid, ...name] = line.trim().split(' ')
    return { pid: Number(pid), ppid: Number(ppid), name: name.join(' ') }
  })
}
/** Every live descendant of `root`, with its image name. */
function descendants(root) {
  const rows = processTable()
  const found = []
  const walk = (pid) => {
    for (const row of rows) if (row.ppid === pid && !found.some((f) => f.pid === row.pid)) { found.push(row); walk(row.pid) }
  }
  walk(root)
  return found
}
const healthy = async () => {
  try { return (await fetch(`${BASE}/api/health`)).status === 200 } catch { return false }
}
async function api(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

// ── PM2 registration ──────────────────────────────────────────
{
  const entry = app()
  const interpreter = entry?.pm2_env?.exec_interpreter ?? ''
  record('pm2 app is online', entry?.pm2_env?.status === 'online', entry?.pm2_env?.status)
  record('pm2 interpreter is an absolute Bun path', path.win32.isAbsolute(interpreter) && /^bun(\.exe)?$/i.test(path.win32.basename(interpreter)), interpreter)
  const describe = pm2(`describe ${NAME}`)
  console.log(describe.stdout)
  record('pm2 describe succeeds', describe.status === 0)
  record('/api/health answers 200', await until(healthy, 30_000))
}

// ── workbench terminals over HTTP ─────────────────────────────
const workspaces = await api('GET', '/api/workspaces')
const ws = Array.isArray(workspaces.json) ? (workspaces.json.find((w) => w.default) ?? workspaces.json[0]) : undefined
record('a workspace exists', ws !== undefined, `status ${workspaces.status}`)
if (ws === undefined) finish()
const TERMS = `/api/workspaces/${encodeURIComponent(ws.id)}/terminals`

const output = new Map()
const exits = new Map()
let events
/** Follow the terminal SSE stream of the current server process. */
async function follow() {
  const controller = new AbortController()
  const res = await fetch(`${BASE}${TERMS}/events`, { signal: controller.signal })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  ;(async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (line === undefined) continue
          const event = JSON.parse(line.slice(6))
          if (event.kind === 'data') output.set(event.terminalId, (output.get(event.terminalId) ?? '') + Buffer.from(event.data, 'base64').toString('utf8'))
          if (event.kind === 'exit') exits.set(event.terminalId, (exits.get(event.terminalId) ?? 0) + 1)
        }
      }
    } catch { /* stream closed by abort or server exit */ }
  })()
  return controller
}
events = await follow()

const listing = await api('GET', TERMS)
const shells = listing.json?.shells?.map((s) => s.id) ?? []
record('terminal backend available over HTTP', listing.status === 200 && listing.json?.available === true, `shells: ${shells.join(', ')}`)
for (const wanted of ['bash', 'powershell', 'cmd']) record(`shell offered: ${wanted}`, shells.includes(wanted))

// The typed command must not itself contain the marker, so the echo of the
// input cannot pass for the shell's output.
const MARK = 'SMOKE-42'
const printMark = { bash: 'echo SMOKE-$((6*7))\r', powershell: 'Write-Output "SMOKE-$((6*7))"\r', cmd: 'echo SMOKE-^42\r' }
const input = (id, text) => api('POST', `${TERMS}/${encodeURIComponent(id)}/input`, { data: Buffer.from(text, 'utf8').toString('base64') })
async function open(shellId) {
  const created = await api('POST', TERMS, { shellId, cols: 80, rows: 24 })
  if (created.status !== 201) throw new Error(`create ${shellId}: ${created.status} ${JSON.stringify(created.json)}`)
  await sleep(1500)
  return created.json.id
}

for (const shellId of shells.filter((id) => id in printMark)) {
  const id = await open(shellId)
  await input(id, printMark[shellId])
  record(`${shellId}: input -> output`, await until(() => (output.get(id) ?? '').includes(MARK), 10_000))
  const resized = await api('POST', `${TERMS}/${encodeURIComponent(id)}/resize`, { cols: 120, rows: 40 })
  record(`${shellId}: resize`, resized.status === 200 && resized.json?.cols === 120 && resized.json?.rows === 40, `status ${resized.status}`)
  const closed = await api('DELETE', `${TERMS}/${encodeURIComponent(id)}`)
  record(`${shellId}: close (DELETE answers 200)`, closed.status === 200, JSON.stringify(closed.json))

  const second = await open(shellId)
  await input(second, 'exit\r')
  record(`${shellId}: natural exit, one exit event`, await until(() => exits.get(second) === 1, 10_000) && exits.get(second) === 1)
}

// ── pm2 restart / stop with a live shell and background job ───
/** Open a cmd terminal running a background job; return the server's process tree. */
async function liveShellTree() {
  const id = await open('cmd')
  await input(id, 'start /b ping -n 120 127.0.0.1 > nul\r')
  await sleep(1500)
  const tree = descendants(app().pid)
  console.log(`server ${app().pid} tree: ${tree.map((p) => `${p.pid}=${p.name}`).join(' ')}`)
  return tree
}
async function timed(command, check) {
  const tree = await liveShellTree()
  const shellsBefore = tree.filter((p) => /^(cmd|ping)\.exe$/i.test(p.name))
  events.abort()
  const started = Date.now()
  const result = pm2(`${command} ${NAME}`)
  const ms = Date.now() - started
  record(`pm2 ${command} completes within ${PM2_BUDGET_MS / 1000} s`, result.status === 0 && ms <= PM2_BUDGET_MS, `${ms} ms, exit ${result.status}`)
  if (result.status !== 0) console.log(result.stdout, result.stderr)
  await until(() => tree.every((p) => !alive(p.pid)), 5_000)
  const survivors = tree.filter((p) => alive(p.pid))
  record(`pm2 ${command}: no leftover shell processes`, shellsBefore.length >= 2 && survivors.length === 0,
    `shells before: ${shellsBefore.map((p) => p.name).join(' ')}; survivors: ${survivors.map((p) => `${p.pid}=${p.name}`).join(' ') || 'none'}`)
  for (const p of survivors) { try { process.kill(p.pid, 'SIGKILL') } catch { /* already gone */ } }
  await check()
}

await timed('restart', async () => {
  record('after restart: online and /api/health answers 200', await until(async () => app()?.pm2_env?.status === 'online' && await healthy(), 30_000))
  events = await follow()
})
await timed('stop', async () => {
  record('after stop: pm2 reports stopped', app()?.pm2_env?.status === 'stopped', app()?.pm2_env?.status)
})

finish()

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} pm2 smoke checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}
