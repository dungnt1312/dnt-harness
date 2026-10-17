#!/usr/bin/env bun
// RH-3 actual-process PTY probes (RH3-A / RH3-C). Real processes, no mocks:
// Bun's built-in PTY (`Bun.spawn({ terminal })`) driving
// `bash --noprofile --norc -i`, torn down by the production terminal service
// and its /proc session inspector.
//
//   bun scripts/pty-probes.mjs            # Linux; other platforms print SKIP and exit 0
//   bun scripts/pty-probes.mjs --require  # fail instead of skipping off Linux
//
// Wired into .github/workflows/runtime-probes.yml (linux job).
import { existsSync, readdirSync, readFileSync } from 'node:fs'

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

if (process.platform !== 'linux' || !process.versions.bun) {
  const why = !process.versions.bun ? 'not running under Bun' : `platform ${process.platform}`
  console.log(`SKIP pty-probes (${why}); RH3-A/C need Linux + Bun`)
  process.exit(process.argv.includes('--require') ? 1 : 0)
}

const { bunPtySpawner, createTerminalService } = await import('../src/web/terminals.ts')
const { linuxInspector, parseProcStat } = await import('../src/web/pty-session.ts')

const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash'
const WS = 'probe-ws'
/** HUP→KILL escalation (1s) + KILL grace (1s) + slack. */
const PER_TERMINAL_DEADLINE_MS = 3_500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Bun's PTY adapter, but always launching a clean interactive bash. */
const base = bunPtySpawner(Bun)
const spawner = { spawn: (_file, _args, options) => base.spawn(BASH, ['--noprofile', '--norc', '-i'], options) }

function stat(pid) {
  try {
    return parseProcStat(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return undefined
  }
}
function cmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim() } catch { return '' }
}
/** Alive and still the same process (start time unchanged), not a zombie. */
function aliveSame(member) {
  const now = stat(member.pid)
  return now !== undefined && now.start === member.start && now.state !== 'Z' && now.state !== 'X'
}
/** Session members whose command line matches `marker`. */
async function waitForMembers(session, markers, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const members = await linuxInspector.members(session)
    const found = markers.map((marker) => members.find((m) => cmdline(m.pid).includes(marker)))
    if (found.every(Boolean)) return { members, found }
    await sleep(50)
  }
  const members = await linuxInspector.members(session)
  throw new Error(`timed out waiting for ${markers.join(', ')}; members: ${members.map((m) => `${m.pid}:${cmdline(m.pid)}`).join(' | ')}`)
}
function fdCount() {
  return readdirSync('/proc/self/fd').length
}

/** Open a terminal and run `script` lines in it; returns shell identity and job identities. */
async function openWithJobs(terminals, lines, markers) {
  const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
  // The service captured the shell PID through the adapter; recover it from the session.
  await sleep(150)
  const self = await findShell(info.id)
  for (const line of lines) terminals.write(info.id, `${line}\n`)
  const { members, found } = await waitForMembers(self.session, markers)
  return { info, self, members, jobs: found }
}

// The service does not expose PIDs to clients; for probes, track them by
// wrapping the spawner and remembering pid per spawn order.
const spawnedPids = []
const tracking = { spawn: (file, args, options) => { const pty = spawner.spawn(file, args, options); spawnedPids.push(pty.pid); return pty } }
const idToPid = new Map()
async function findShell(id) {
  const pid = idToPid.get(id)
  const self = await linuxInspector.identity(pid)
  if (self === undefined) throw new Error(`shell ${pid} not alive`)
  if (self.session !== String(pid)) record(`shell ${pid} is a session leader`, false, `session=${self.session}`)
  return self
}
function service(extra = {}) {
  const terminals = createTerminalService({ spawner: tracking, ...extra })
  const create = terminals.create.bind(terminals)
  terminals.create = async (input) => {
    const info = await create(input)
    idToPid.set(info.id, spawnedPids.at(-1))
    return info
  }
  return terminals
}

// An unrelated process in the host's own session: must survive everything.
const bystander = Bun.spawn(['sleep', '600'], { stdout: 'ignore', stderr: 'ignore' })
await sleep(100)
const bystanderId = stat(bystander.pid)

async function probe(name, body) {
  try {
    await body()
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

// ── RH3-A.1 remove: foreground + background jobs ──
await probe('remove stops shell, foreground and background jobs', async () => {
  const terminals = service()
  const exits = []
  terminals.subscribe(WS, (e) => { if (e.kind === 'exit') exits.push(e) })
  const { info, self, members } = await openWithJobs(
    terminals,
    ['sleep 1101 &', 'sleep 1102'],
    ['sleep 1101', 'sleep 1102'],
  )
  const started = Date.now()
  await terminals.kill(info.id)
  const elapsed = Date.now() - started
  const left = members.filter(aliveSame)
  record('remove stops shell, foreground and background jobs', left.length === 0 && elapsed < PER_TERMINAL_DEADLINE_MS,
    `members=${members.length} left=[${left.map((m) => m.pid)}] elapsed=${elapsed}ms shell=${self.pid}`)
  record('remove emits exactly one exit event', exits.length === 1, JSON.stringify(exits))
  await terminals.disposeAll()
})

// ── RH3-A.2 escalation: shell and a job both ignore HUP ──
await probe('HUP-ignoring shell and job are KILLed after the escalation deadline', async () => {
  const terminals = service()
  const { info, members } = await openWithJobs(
    terminals,
    ["trap '' HUP", "bash --noprofile --norc -c \"trap '' HUP; exec sleep 1201\" &", 'sleep 1202'],
    ['sleep 1201', 'sleep 1202'],
  )
  const started = Date.now()
  await terminals.kill(info.id)
  const elapsed = Date.now() - started
  const left = members.filter(aliveSame)
  // Escalation really ran: a pure-HUP teardown would have finished well under 1s.
  record('HUP-ignoring shell and job are KILLed after the escalation deadline',
    left.length === 0 && elapsed >= 900 && elapsed < PER_TERMINAL_DEADLINE_MS,
    `left=[${left.map((m) => m.pid)}] elapsed=${elapsed}ms`)
  await terminals.disposeAll()
})

// ── RH3-A.3 natural exit sweeps leftover background jobs ──
await probe('natural exit sweeps background jobs and emits one exit', async () => {
  const terminals = service()
  const exits = []
  terminals.subscribe(WS, (e) => { if (e.kind === 'exit') exits.push(e) })
  const { info, members } = await openWithJobs(terminals, ['sleep 1301 &'], ['sleep 1301'])
  terminals.write(info.id, 'exit\n')
  const deadline = Date.now() + PER_TERMINAL_DEADLINE_MS + 2_000
  while (terminals.get(info.id) !== undefined && Date.now() < deadline) await sleep(50)
  await sleep(100)
  const left = members.filter(aliveSame)
  record('natural exit sweeps background jobs and emits one exit',
    terminals.get(info.id) === undefined && left.length === 0 && exits.length === 1 && exits[0].reason === 'exit',
    `left=[${left.map((m) => m.pid)}] exits=${JSON.stringify(exits)}`)
  await terminals.disposeAll()
})

// ── RH3-A.4 idle reap ──
await probe('idle reap stops shell and jobs', async () => {
  const terminals = service({ idleMs: 300, reapIntervalMs: 100 })
  const exits = []
  terminals.subscribe(WS, (e) => { if (e.kind === 'exit') exits.push(e) })
  const { info, members } = await openWithJobs(terminals, ['sleep 1401 &', 'sleep 1402'], ['sleep 1401', 'sleep 1402'])
  const deadline = Date.now() + 300 + 100 + PER_TERMINAL_DEADLINE_MS + 1_000
  while (terminals.get(info.id) !== undefined && Date.now() < deadline) await sleep(50)
  const left = members.filter(aliveSame)
  record('idle reap stops shell and jobs',
    terminals.get(info.id) === undefined && left.length === 0 && exits.length === 1 && exits[0].reason === 'idle',
    `left=[${left.map((m) => m.pid)}] exits=${JSON.stringify(exits)}`)
  await terminals.disposeAll()
})

// ── RH3-A.5 disposeAll: 16 terminals, some HUP-ignoring, one budget ──
await probe('disposeAll stops 16 terminals concurrently within the shutdown budget', async () => {
  const terminals = service()
  const all = []
  for (let i = 0; i < 16; i += 1) {
    const lines = i % 4 === 0
      ? ["trap '' HUP", `sleep ${1500 + i} &`, `sleep ${1600 + i}`]
      : [`sleep ${1500 + i} &`, `sleep ${1600 + i}`]
    all.push(await openWithJobs(terminals, lines, [`sleep ${1500 + i}`, `sleep ${1600 + i}`]))
  }
  const members = all.flatMap((t) => t.members)
  const started = Date.now()
  let error
  try { await terminals.disposeAll() } catch (e) { error = e }
  const elapsed = Date.now() - started
  const left = members.filter(aliveSame)
  const { TERMINAL_SHUTDOWN_BUDGET_MS } = await import('../src/web/terminals.ts')
  record('disposeAll stops 16 terminals concurrently within the shutdown budget',
    error === undefined && left.length === 0 && elapsed <= TERMINAL_SHUTDOWN_BUDGET_MS,
    `members=${members.length} left=[${left.map((m) => m.pid)}] elapsed=${elapsed}ms budget=${TERMINAL_SHUTDOWN_BUDGET_MS}ms${error ? ` error=${error.message}` : ''}`)
})

// ── RH3-C: repeated create/close does not leak FDs, processes or records; UTF-8 split stream ──
await probe('repeated create/close is bounded (fds, processes, records)', async () => {
  const terminals = service()
  const warm = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
  await terminals.kill(warm.id)
  await sleep(200)
  const fdBefore = fdCount()
  const sessions = []
  for (let i = 0; i < 30; i += 1) {
    const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
    await sleep(50)
    sessions.push(String(idToPid.get(info.id)))
    terminals.write(info.id, 'echo hi\n')
    await terminals.kill(info.id)
  }
  await sleep(300)
  const fdAfter = fdCount()
  const survivors = (await Promise.all(sessions.map((s) => linuxInspector.members(s)))).flat()
  record('repeated create/close is bounded (fds, processes, records)',
    fdAfter - fdBefore <= 4 && survivors.length === 0 && terminals.list(WS).length === 0,
    `fds ${fdBefore}→${fdAfter} survivors=[${survivors.map((m) => m.pid)}]`)
  await terminals.disposeAll()
})

await probe('UTF-8 split across PTY reads decodes intact', async () => {
  const terminals = service()
  const info = await terminals.create({ workspaceId: WS, cwd: process.cwd() })
  await sleep(150)
  // 20k two- and four-byte characters: PTY reads will split some sequences.
  terminals.write(info.id, "for i in $(seq 1 4000); do printf 'é😀ü€ß'; done; echo; echo UTF8-DONE\n")
  const deadline = Date.now() + 8_000
  while (!terminals.scrollback(info.id).includes('UTF8-DONE\r\n') && Date.now() < deadline) await sleep(50)
  const text = terminals.scrollback(info.id)
  const count = (text.match(/é😀ü€ß/g) ?? []).length
  record('UTF-8 split across PTY reads decodes intact', !text.includes('\uFFFD') && count >= 4000,
    `groups=${count} replacementChars=${(text.match(/\uFFFD/g) ?? []).length}`)
  await terminals.kill(info.id)
  await terminals.disposeAll()
})

// ── Nothing outside the PTY sessions was signalled ──
{
  const ok = bystanderId !== undefined && aliveSame({ pid: bystander.pid, start: bystanderId.start })
  record('unrelated process in the host session was never signalled', ok, `pid=${bystander.pid}`)
  bystander.kill('SIGKILL')
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} pty probes passed`)
process.exit(failed.length === 0 ? 0 : 1)
