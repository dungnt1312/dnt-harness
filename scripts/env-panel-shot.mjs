/**
 * Live UI capture for the Environment panel: drives a real background-sleep
 * turn on :3082 (approving via the SSE approval frame), waits for a running
 * process, then screenshots the session page — expanded panel floating
 * top-right, plus an idle session for the collapsed look. Cleans up.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3082'
const post = async (url, body) => await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const json = async (res) => await res.json()

const workspaces = await json(await fetch(`${BASE}/api/workspaces`))
const ws = workspaces.find((row) => row.default) ?? workspaces[0]
const folder = await mkdtemp(path.join(tmpdir(), 'mini-dsh-shot-'))
const project = await json(await post(`/api/workspaces/${ws.id}/projects`, { path: folder }))
const session = await json(await post(`/api/workspaces/${ws.id}/sessions`, { projectId: project.id }))
console.log('SESSION', session.id)
const url = `${BASE}/workspaces/${ws.id}/sessions/${session.id}`
const eventsUrl = `${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/events`

const events = []
let sawTurnEnd = false
let cursor = 0
/** One SSE pass; resolves when the server closes or a fatal error hits. */
async function streamPass(signal) {
  const res = await fetch(eventsUrl, { signal, headers: cursor > 0 ? { 'last-event-id': String(cursor) } : {} })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    buffer += decoder.decode(chunk.value, { stream: true })
    let i = buffer.indexOf('\n\n')
    while (i >= 0) {
      const frame = buffer.slice(0, i)
      buffer = buffer.slice(i + 2)
      i = buffer.indexOf('\n\n')
      const idLine = frame.split('\n').find((l) => l.startsWith('id: '))
      if (idLine !== undefined) cursor = Number(idLine.slice(4))
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (line === undefined) continue
      const env = JSON.parse(line.slice(6))
      if (env.kind === 'session') {
        events.push(env.event)
        if (env.event.type === 'turn/end') sawTurnEnd = true
      } else if (env.kind === 'approval') {
        events.push({ type: 'approval', approvalId: env.approvalId })
      }
    }
  }
}
/** Resilient listener: reconnects on transient resets until aborted. */
const controller = new AbortController()
const listener = (async () => {
  for (let attempt = 0; attempt < 8 && !controller.signal.aborted && !sawTurnEnd; attempt += 1) {
    try {
      await streamPass(controller.signal)
      if (sawTurnEnd || controller.signal.aborted) return
    } catch (error) {
      if (controller.signal.aborted) return
      console.log(`sse pass failed (${String(error?.cause?.code ?? error?.message)}), retrying`)
    }
    await new Promise((r) => setTimeout(r, 400))
  }
})()

// Idle screenshot first (collapsed pill, fresh conversation).
execSync(`npx playwright screenshot --viewport-size "1600,900" --wait-for-timeout 5000 "${url}" shots/env-collapsed.png`, { stdio: 'inherit', shell: true })

// Live turn: background sleep → the panel auto-expands top-right.
void post(`/api/workspaces/${ws.id}/sessions/${session.id}/messages`, { content: 'Run this exact bash command in the background (use run_in_background: true): sleep 120. Then reply with just: ok' })

const deadline = Date.now() + 150_000
let approved = false
while (Date.now() < deadline) {
  const approval = events.find((e) => e.type === 'approval')
  if (approval !== undefined && !approved && !events.some((e) => e.type === 'process/start')) {
    const allow = await post(`/api/approvals/${approval.approvalId}`, { allow: true, scope: 'session' })
    console.log('approval allowed', allow.status)
    approved = true
  }
  if (events.some((e) => e.type === 'process/start')) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log('PROCESS STARTED', events.some((e) => e.type === 'process/start'))

if (events.some((e) => e.type === 'process/start')) {
  await new Promise((r) => setTimeout(r, 2_500))
  execSync(`npx playwright screenshot --viewport-size "1600,900" --wait-for-timeout 4000 "${url}" shots/env-expanded.png`, { stdio: 'inherit', shell: true })
}

// Cleanup: stop processes, wait for the turn to settle, delete scratch.
const rows = await json(await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes`))
for (const row of rows ?? []) {
  if (row.status === 'running') await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes/${row.id}/stop`, { method: 'POST' })
}
while (Date.now() < deadline && !sawTurnEnd) await new Promise((r) => setTimeout(r, 500))
controller.abort()
await listener.catch(() => {})
for (let attempt = 0; attempt < 15; attempt += 1) {
  const del = await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}`, { method: 'DELETE' })
  if (del.status === 200) break
  await new Promise((r) => setTimeout(r, 2_000))
}
await fetch(`${BASE}/api/workspaces/${ws.id}/projects/${project.id}`, { method: 'DELETE' })
console.log('DONE')
