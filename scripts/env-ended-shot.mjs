/**
 * Live capture of the ended-processes group: two background sleeps run, one
 * is stopped via the operator route (killed), and the panel should show
 * 1 running row plus the collapsed "Ended · 1" group with Clear.
 */
import { chromium } from 'playwright'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const BASE = 'http://127.0.0.1:3082'
const post = async (url, body) => await fetch(`${BASE}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const json = async (res) => await res.json()

const workspaces = await json(await fetch(`${BASE}/api/workspaces`))
const ws = workspaces.find((row) => row.default) ?? workspaces[0]
const folder = await mkdtemp(path.join(tmpdir(), 'dnt-harness-ended-'))
const project = await json(await post(`/api/workspaces/${ws.id}/projects`, { path: folder }))
const session = await json(await post(`/api/workspaces/${ws.id}/sessions`, { projectId: project.id }))
console.log('SESSION', session.id)

const events = []
let sawTurnEnd = false
const controller = new AbortController()
const listener = (async () => {
  while (!controller.signal.aborted && !sawTurnEnd) {
    try {
      const res = await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/events`, { signal: controller.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let i = buffer.indexOf('\n\n')
        while (i >= 0) {
          const frame = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          i = buffer.indexOf('\n\n')
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (line === undefined) continue
          const env = JSON.parse(line.slice(6))
          if (env.kind === 'session') {
            events.push(env.event)
            if (env.event.type === 'turn/end') sawTurnEnd = true
          } else if (env.kind === 'approval') events.push({ type: 'approval', approvalId: env.approvalId })
        }
      }
      if (sawTurnEnd || controller.signal.aborted) break
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400))
  }
})()

void post(`/api/workspaces/${ws.id}/sessions/${session.id}/messages`, { content: 'Run these two bash commands in the background (each with run_in_background: true), then reply with just: ok. Command 1: sleep 300. Command 2: sleep 300' })

const deadline = Date.now() + 180_000
let approved = 0
while (Date.now() < deadline) {
  const approvals = events.filter((e) => e.type === 'approval')
  while (approved < approvals.length && !events.some((e) => e.type === 'process/start')) {
    await post(`/api/approvals/${approvals[approved].approvalId}`, { allow: true, scope: 'session' })
    approved += 1
  }
  const starts = events.filter((e) => e.type === 'process/start')
  if (starts.length >= 2) break
  await new Promise((r) => setTimeout(r, 400))
}
const started = events.filter((e) => e.type === 'process/start')
console.log('STARTED', started.length)
if (started.length >= 2) {
  // Operator-kill the first one → it becomes the "killed" row. Ids come from
  // the GET snapshot, not the stream, so a missing SSE field cannot bite.
  const rows = await json(await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes`))
  const victim = rows.find((row) => row.status === 'running')
  const stop = await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes/${victim.id}/stop`, { method: 'POST' })
  console.log('STOP', stop.status)
  await new Promise((r) => setTimeout(r, 1_500))
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(`${BASE}/workspaces/${ws.id}/sessions/${session.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3_000)
  await page.screenshot({ path: 'shots/ended-group.png' })
  console.log('SHOT TAKEN')
} finally {
  await browser.close()
}

// Cleanup: stop everything, wait for the turn, delete the scratch pair.
const rows = await json(await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes`))
for (const row of rows ?? []) {
  if (row.status === 'running') await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/processes/${row.id}/stop`, { method: 'POST' })
}
while (Date.now() < deadline && !sawTurnEnd) await new Promise((r) => setTimeout(r, 500))
controller.abort()
for (let attempt = 0; attempt < 15; attempt += 1) {
  const del = await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}`, { method: 'DELETE' })
  if (del.status === 200) break
  await new Promise((r) => setTimeout(r, 2_000))
}
await fetch(`${BASE}/api/workspaces/${ws.id}/projects/${project.id}`, { method: 'DELETE' })
console.log('DONE')
