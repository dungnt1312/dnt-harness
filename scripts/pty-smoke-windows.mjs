#!/usr/bin/env bun
// Windows terminal smoke through the production service and the real bun-pty
// backend (no injected spawner): input/output, resize, natural exit, kill,
// background-job cleanup, and 16 concurrent terminals torn down by disposeAll.
//   bun scripts/pty-smoke-windows.mjs            # Windows; other platforms print SKIP and exit 0
//   bun scripts/pty-smoke-windows.mjs --require  # fail instead of skipping off Windows
import { spawnSync } from 'node:child_process'

if (process.platform !== 'win32' || !process.versions.bun) {
  const why = !process.versions.bun ? 'not running under Bun' : `platform ${process.platform}`
  console.log(`SKIP pty-smoke-windows: ${why}`)
  process.exit(process.argv.includes('--require') ? 1 : 0)
}

const { createTerminalService, TERMINAL_SHUTDOWN_BUDGET_MS } = await import('../src/web/terminals.ts')

const WS = 'smoke-ws'
const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` -- ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}
function descendants(root) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' }).stdout
  const rows = out.split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(' ').map(Number))
  const found = []
  const walk = (pid) => { for (const [p, pp] of rows) if (pp === pid && !found.includes(p)) { found.push(p); walk(p) } }
  walk(root)
  return found
}
async function until(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(50) }
  return predicate()
}

const terminals = createTerminalService()
const probe = await terminals.probe()
record('backend loads', probe.available, probe.hint)
if (!probe.available) process.exit(1)

const output = new Map()
const exits = new Map()
terminals.subscribe(WS, (event) => {
  if (event.kind === 'data') output.set(event.terminalId, (output.get(event.terminalId) ?? '') + event.data)
  if (event.kind === 'exit') exits.set(event.terminalId, [...(exits.get(event.terminalId) ?? []), event])
})

/**
 * Wait until the shell has drawn its prompt: some output, then 300 ms of
 * quiet (bounded). A cold PowerShell can take seconds to start; typing
 * before it reads input loses the keystrokes.
 */
async function shellReady(id, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let seen = ''
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const now = output.get(id) ?? ''
    if (now !== seen) { seen = now; quietSince = Date.now() }
    else if (seen !== '' && Date.now() - quietSince >= 300) return true
    await sleep(50)
  }
  return false
}

const pidOf = new Map()
const shells = terminals.shells()
console.log(`shells: ${shells.map((s) => s.id).join(', ')}`)

for (const shell of shells) {
  const info = await terminals.create({ workspaceId: WS, cwd: process.cwd(), shellId: shell.id, cols: 80, rows: 24 })
  const started = Date.now()
  const ready = await shellReady(info.id)
  console.log(`${shell.id}: prompt ${ready ? 'ready' : 'not seen'} after ${Date.now() - started} ms`)
  terminals.write(info.id, shell.id.includes('powershell') || shell.id.includes('pwsh') ? 'Write-Output "SMOKE-$((6*7))"\r' : 'echo SMOKE-42\r')
  const echoed = await until(() => (output.get(info.id) ?? '').includes('SMOKE-42'), 5000)
  record(`${shell.id}: input → output`, echoed)
  terminals.resize(info.id, 120, 40)
  record(`${shell.id}: resize`, terminals.get(info.id)?.cols === 120)
  terminals.write(info.id, 'exit\r')
  const exited = await until(() => (exits.get(info.id) ?? []).length > 0, 5000)
  record(`${shell.id}: natural exit, exactly one exit event`, exited && exits.get(info.id).length === 1, JSON.stringify(exits.get(info.id)?.map((e) => e.reason)))
}

{
  const shell = shells.find((s) => s.id === 'cmd') ?? shells[0]
  const info = await terminals.create({ workspaceId: WS, cwd: process.cwd(), shellId: shell.id })
  await shellReady(info.id)
  terminals.write(info.id, shell.id === 'cmd' ? 'start /b ping -n 120 127.0.0.1 > nul\r' : 'sleep 120 &\r')
  await sleep(1500)
  // The terminal record does not expose the PID, so find the shell by its child.
  // Only the shell (cmd.exe / bash.exe) and its descendants: the probe's own
  // powershell helpers are children of this process too and must not count.
  const shellName = shell.id === 'cmd' ? 'cmd.exe' : 'bash.exe'
  const before = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid} AND Name='${shellName}'").ProcessId`], { encoding: 'utf8' }).stdout.split(/\s+/).filter(Boolean).map(Number)
  const tree = before.flatMap((pid) => [pid, ...descendants(pid)])
  const names = spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process | Where-Object { @(${tree.join(',') || '0'}) -contains $_.ProcessId } | ForEach-Object { "$($_.ProcessId)=$($_.Name)" }`], { encoding: 'utf8' }).stdout.trim().split(/\s+/).join(' ')
  const started = Date.now()
  await terminals.kill(info.id)
  const ms = Date.now() - started
  await sleep(2000)
  const survivors = tree.filter(alive)
  record(`${shell.id}: kill resolves and background job dies with the console`, tree.length > 1 && survivors.length === 0, `kill ${ms}ms; tree=[${names}] survivors=${JSON.stringify(survivors)}`)
  record(`${shell.id}: killed terminal reports reason 'killed' once`, (exits.get(info.id) ?? []).length === 1 && exits.get(info.id)[0].reason === 'killed')
  for (const pid of survivors) { try { process.kill(pid, 'SIGKILL') } catch {} }
}

{
  // A natural exit must release the ConPTY: bun-pty frees it only in kill(),
  // so a leak shows up as one extra console host per exited terminal.
  const consoleHosts = () => Number(spawnSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "Name='conhost.exe' OR Name='OpenConsole.exe'").Count`], { encoding: 'utf8' }).stdout.trim())
  const before = consoleHosts()
  const shell = shells.find((s) => s.id === 'cmd') ?? shells[0]
  const ids = []
  for (let i = 0; i < 5; i++) ids.push((await terminals.create({ workspaceId: WS, cwd: process.cwd(), shellId: shell.id })).id)
  await Promise.all(ids.map((id) => shellReady(id)))
  for (const id of ids) terminals.write(id, 'exit\r')
  await until(() => ids.every((id) => (exits.get(id) ?? []).length === 1), 5000)
  await until(() => consoleHosts() <= before, 3000)
  const after = consoleHosts()
  record('natural exits release their console hosts (no leak)', after <= before, `console hosts before=${before} after=${after}`)
}

{
  const ids = []
  for (let i = 0; i < 16; i++) ids.push((await terminals.create({ workspaceId: WS, cwd: process.cwd() })).id)
  await sleep(500)
  const started = Date.now()
  let error
  try { await terminals.disposeAll({ budgetMs: TERMINAL_SHUTDOWN_BUDGET_MS }) } catch (e) { error = e }
  const ms = Date.now() - started
  const allExited = ids.every((id) => (exits.get(id) ?? []).length === 1)
  record('16 terminals: disposeAll within shutdown budget', error === undefined && allExited && ms <= TERMINAL_SHUTDOWN_BUDGET_MS, `${ms}ms${error ? `; ${error.message}` : ''}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
