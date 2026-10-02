#!/usr/bin/env node
/**
 * Read-only UI smoke test against a running mini-dsh host.
 * It never sends a model message or changes workspace/session settings.
 *
 * Usage: npm run test:live-ui
 * Optional: MINI_DSH_LIVE_URL=http://127.0.0.1:3082 npm run test:live-ui
 */
import { chromium } from 'playwright'

const base = (process.env.MINI_DSH_LIVE_URL ?? 'http://127.0.0.1:3082').replace(/\/$/, '')
const fail = (message) => { throw new Error(message) }
const waitFor = async (predicate, timeout = 5_000, step = 50) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  fail(`Timed out after ${timeout}ms`)
}

const workspacesResponse = await fetch(`${base}/api/workspaces`)
if (!workspacesResponse.ok) fail(`Workspace list returned HTTP ${workspacesResponse.status}`)
const workspaces = await workspacesResponse.json()
const workspace = workspaces.find((row) => row.default === true) ?? workspaces[0]
if (workspace === undefined) fail('Live host has no workspace to inspect')
const sessionsResponse = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspace.id)}/sessions`)
if (!sessionsResponse.ok) fail(`Session list returned HTTP ${sessionsResponse.status}`)
const sessions = await sessionsResponse.json()
const session = sessions.find((row) => row.eventCount > 0) ?? sessions[0]
if (session === undefined) fail('Live host has no conversation to inspect')

const browser = await chromium.launch()
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const pageErrors = []
const errorResponses = []
page.on('pageerror', (error) => pageErrors.push(error.message))
page.on('response', (response) => {
  if (response.url().includes('/api/') && response.status() >= 400) errorResponses.push(`${response.status()} ${response.url()}`)
})

try {
  const started = Date.now()
  await page.goto(`${base}/workspaces/${encodeURIComponent(workspace.id)}/sessions/${encodeURIComponent(session.id)}`, { waitUntil: 'domcontentloaded' })
  await waitFor(async () => (await page.locator('.transcript, .empty, .chat-scroll').count()) > 0)
  const elapsed = Date.now() - started
  if (elapsed > 2_000) fail(`Deep-link view took ${elapsed}ms; expected < 2000ms`)

  const manifestStatus = await page.evaluate(async ({ workspaceId, sessionId }) => {
    const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/manifest`)
    return response.status
  }, { workspaceId: workspace.id, sessionId: session.id })
  if (manifestStatus !== 200 && manifestStatus !== 204) fail(`Manifest returned unexpected HTTP ${manifestStatus}`)

  for (const width of [1279, 1023, 375]) {
    await page.setViewportSize({ width, height: 800 })
    await page.waitForTimeout(200)
    const state = await page.evaluate(() => ({
      drawer: document.querySelector('[role="dialog"]') !== null,
      scrim: document.querySelector('[data-workbench-scrim]') !== null,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))
    if (state.drawer || state.scrim) fail(`Responsive resize to ${width}px automatically opened a drawer`)
    if (state.overflow > 0) fail(`Responsive resize to ${width}px created ${state.overflow}px horizontal overflow`)
  }

  if (pageErrors.length > 0) fail(`Browser page errors: ${pageErrors.join(' | ')}`)
  if (errorResponses.length > 0) fail(`Unexpected live API errors: ${errorResponses.join(' | ')}`)
  console.log(`Live UI smoke passed: ${workspace.id}/${session.id}; deep link ${elapsed}ms; manifest ${manifestStatus}`)
} finally {
  await browser.close()
}
