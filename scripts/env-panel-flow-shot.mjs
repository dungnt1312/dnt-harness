/**
 * Live capture of the two new affordances: (1) a background Bash row's
 * Background·running chip in the transcript, (2) the workbench Process view
 * reached by clicking the chip / the Environment panel row.
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
const folder = await mkdtemp(path.join(tmpdir(), 'dnt-harness-flow-'))
const project = await json(await post(`/api/workspaces/${ws.id}/projects`, { path: folder }))
const session = await json(await post(`/api/workspaces/${ws.id}/sessions`, { projectId: project.id }))
console.log('SESSION', session.id)

const events = []
let sawTurnEnd = false
let cursor = 0
const controller = new AbortController()
const listener = (async () => {
  for (let attempt = 0; attempt < 8 && !controller.signal.aborted && !sawTurnEnd; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/workspaces/${ws.id}/sessions/${session.id}/events`, { signal: controller.signal, headers: cursor > 0 ? { 'last-event-id': String(cursor) } : {} })
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
          const idLine = frame.split('\n').find((l) => l.startsWith('id: '))
          if (idLine !== undefined) cursor = Number(idLine.slice(4))
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
    } catch (error) {
      if (controller.signal.aborted) break
      console.log('sse retry', String(error?.cause?.code ?? error?.message))
    }
    await new Promise((r) => setTimeout(r, 400))
  }
})()

void post(`/api/workspaces/${ws.id}/sessions/${session.id}/messages`, { content: 'Run this exact bash command in the background (use run_in_background: true): echo hello-from-background && sleep 90. Then reply with just: ok' })

const deadline = Date.now() + 150_000
let approved = false
while (Date.now() < deadline) {
  const approval = events.find((e) => e.type === 'approval')
  if (approval !== undefined && !approved && !events.some((e) => e.type === 'process/start')) {
    await post(`/api/approvals/${approval.approvalId}`, { allow: true, scope: 'session' })
    approved = true
  }
  if (events.some((e) => e.type === 'process/start')) break
  await new Promise((r) => setTimeout(r, 400))
}
console.log('PROCESS STARTED', events.some((e) => e.type === 'process/start'))
await new Promise((r) => setTimeout(r, 2_500))

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(`${BASE}/workspaces/${ws.id}/sessions/${session.id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3_000)

  // (1) The transcript's background Bash row with its live chip.
  const chip = page.getByText('Background · running').first()
  await chip.waitFor({ timeout: 10_000 })
  await page.screenshot({ path: 'shots/flow-chip.png' })

  // (2) Expand the row, then jump to the workbench Process view.
  await chip.click()
  await page.getByText('View process in workbench').first().click()
  await page.waitForTimeout(2_500)
  await page.screenshot({ path: 'shots/flow-process-view.png' })
  console.log('PROCESS VIEW SHOT TAKEN')
} finally {
  await browser.close()
}

// Cleanup.
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
