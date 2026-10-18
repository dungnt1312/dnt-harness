#!/usr/bin/env node
// Replay real API snapshots on an isolated memory host. Never writes to live host.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const { createWebServer } = await import(pathToFileURL(path.resolve('src/web/server.ts')).href)
import { chromium } from 'playwright'
const live = process.env.DNT_HARNESS_LIVE_URL ?? 'http://127.0.0.1:3082'
const wid = process.env.DNT_PROFILE_WORKSPACE ?? 'ws-mur65pzr745ftn'
const ids = (process.env.DNT_PROFILE_SESSIONS ?? 'session-muurazmurs6jkh,session-muxl4w308j8ide').split(',')
const listing = await (await fetch(`${live}/api/workspaces/${wid}/sessions`)).json()
const parent = listing.find(s => s.id === ids[1])?.parentSessionId
if (parent && !ids.includes(parent)) ids.push(parent)
const server = await createWebServer({ providers: [], configFile: '/tmp/dnt-profile-empty-providers.json', terminals: { enabled: false } })
const mapped = new Map()
let browser
try {
  for (const id of ids) {
    const response = await fetch(`${live}/api/workspaces/${wid}/sessions/${id}/events`)
    if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`)
    const reader = response.body.getReader(), decoder = new TextDecoder()
    let text = ''
    while (!text.includes('\n\n')) text += decoder.decode((await reader.read()).value, { stream: true })
    await reader.cancel()
    const envelope = JSON.parse(text.split('\n').find(l => l.startsWith('data: ')).slice(6))
    const session = server.kernel.ctx.sessions.create('default')
    session.adoptHistory(envelope.events.map((e, i) => ({ ...e, seq: i + 1 })))
    mapped.set(id, session)
  }
  const rows = ids.map(id => ({ ...listing.find(s => s.id === id), id: mapped.get(id).id, title: 'Profile session', projectId: null, parentSessionId: id === ids[1] && parent ? mapped.get(parent).id : null, status: 'idle' }))
  browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  let blocked = 0
  await context.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { blocked++; return route.abort() }
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/workspaces') return json([{ id: 'default', name: 'Profile', default: true, archived: false }])
    if (path === '/api/workspaces/default/sessions') return json(rows)
    if (path === '/api/workspaces/default/projects') return json([])
    return route.continue()
  })
  await context.addInitScript(() => {
    window.__profile = { frames: [], longTasks: [] }
    new PerformanceObserver(list => list.getEntries().forEach(e => window.__profile.longTasks.push(Math.round(e.duration)))).observe({ type: 'longtask', buffered: true })
    const parse = JSON.parse
    JSON.parse = function(text, ...args) {
      const value = parse.call(this, text, ...args)
      if (value?.kind === 'snapshot' || value?.kind === 'resume') window.__profile.frames.push({ kind: value.kind, chars: text.length, events: value.events.length })
      return value
    }
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  for (const [label, id] of [['root', ids[0]], ['child', ids[1]], ['root-return', ids[0]]]) {
    const path = `/workspaces/default/sessions/${mapped.get(id).id}`, start = performance.now()
    if (label === 'root') await page.goto(server.url + path, { waitUntil: 'domcontentloaded' })
    else await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')) }, path)
    // Wait for the selected session's authoritative replay, not the old DOM
    // that can remain visible until React commits the route change.
    await page.waitForFunction(() => window.__profile.frames.length > 0, { timeout: 30000 })
    await page.getByRole('region', { name: 'Conversation transcript', exact: true }).waitFor({ timeout: 30000 })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const readyMs = Math.round(performance.now() - start)
    await page.waitForTimeout(600)
    const metrics = await page.evaluate(() => { const result = window.__profile; window.__profile = { frames: [], longTasks: [] }; return { ...result, domNodes: document.querySelectorAll('*').length } })
    console.log(JSON.stringify({ label, readyMs, blockedMutations: blocked, errors, ...metrics }))
  }
} finally { await browser?.close(); await server.close() }
