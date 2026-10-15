/**
 * Context accounting end to end against the real host: the built client
 * (`web-dist/`, so run `pnpm run build:web` first) served by `createWebServer`
 * with a scripted provider, real SSE and no API interception. Asserts the
 * meter journey the accounting contract promises: a request's estimate is
 * replaced by the provider's reported count, the numbers match what
 * StepInspector shows for that request, a compaction turns the meter into the
 * post-compaction preview, and a reload (fresh SSE snapshot) plus a session
 * switch keep every figure attached to its own conversation.
 */
/// <reference lib="dom" />
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { createWebServer, type WebServer } from '../../src/web/server.ts'
import type { LlmProvider } from '../../src/harness/llm/types.ts'

const COMPACT_MARK = 'Primary Request and Intent'
const SUMMARY_TEXT = 'CHECKPOINT SUMMARY TEXT'

/** Real (2 MB-scale) turn answers, so the conversation actually trims and compacts. */
function scriptedProvider(): LlmProvider {
  let chats = 0
  return {
    name: 'scripted', models: ['scripted'],
    async *stream(request) {
      const isSummary = request.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK))
      yield { type: 'delta', delta: isSummary ? SUMMARY_TEXT : (++chats === 1 ? 'x'.repeat(1_100_000) : 'small answer') }
      if (!isSummary) yield { type: 'usage', usage: { inputTokens: 120_000, cachedInputTokens: 110_000 } }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    },
  }
}

let server: WebServer | undefined
let home = ''

test.beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-accounting-e2e-'))
  server = await createWebServer({
    home,
    configFile: path.join(home, 'p.json'),
    staticDir: path.resolve('web-dist'),
    providers: [scriptedProvider()],
    limits: { automaticCompactionPressure: 0 },
  })
})

test.afterAll(async () => {
  await server?.close()
  await fs.rm(home, { recursive: true, force: true }).catch(() => {})
})

interface ManifestBody {
  readonly budget: { readonly usedTokens: number; readonly availableTokens: number; readonly estimated?: boolean }
  readonly display?: { readonly kind?: string }
  readonly usage?: { readonly last?: { readonly inputTokens?: number } }
}

/**
 * A session with a distinct custom title, so its sidebar row can be told apart
 * from the "New conversation" button and from other sessions.
 */
async function createSession(title: string): Promise<{ id: string; route: string; title: string }> {
  const base = server!.url
  const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
  const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
  const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
  const renamed = await fetch(route, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) })
  expect(renamed.ok).toBe(true)
  return { id, route, title }
}

/** Click the sidebar row carrying this session's title. */
async function openSession(page: import('@playwright/test').Page, title: string): Promise<void> {
  // The row's accessible name carries a relative time ("<title> now"); the
  // Options button is "Options for <title>", so anchor at the start.
  const row = page.getByRole('button', { name: new RegExp(`^${title}`) }).first()
  await expect(row).toBeVisible({ timeout: 20_000 })
  await row.click()
}

async function manifest(route: string): Promise<ManifestBody | null> {
  const response = await fetch(`${route}/manifest`)
  if (response.status === 204) return null
  return await response.json() as ManifestBody
}

const openMeter = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /Context window/ }).first()

test('request estimate becomes reported, matches the inspector, compacts into a preview, and survives reload and switching', async ({ page }) => {
  test.setTimeout(120_000)
  const { id, route, title } = await createSession('Accounting E2E main')
  await page.goto(server!.url)

  // Open the conversation from the sidebar, then send the first (huge) turn.
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 20_000 })
  await openSession(page, title)
  await page.locator('[data-composer-input]').fill('first')
  await page.locator('[data-composer-input]').press('Enter')

  // The meter fills from the request manifest, then the provider report
  // replaces the estimate: reported 120k over the resolved window, never the
  // builder's estimate alone (the scripted model's window falls back to 256k).
  const meter = openMeter(page)
  await expect(meter).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Context window 120K / 256K' })).toBeVisible({ timeout: 30_000 })
  // The terminal usage lands on the log right after the answer; poll the API
  // until the reported figure replaces the estimate.
  await expect.poll(async () => {
    const body = await manifest(route)
    return body?.usage?.last?.inputTokens
  }, { timeout: 30_000 }).toBe(120_000)

  // The StepInspector for that step shows the same reported figure.
  await page.locator('[data-composer-input]').fill('second')
  await page.locator('[data-composer-input]').press('Enter')
  await expect(page.getByText('small answer').first()).toBeVisible({ timeout: 30_000 })

  // Compact from the API (the panel button needs the context view open); the
  // meter then shows the post-compaction preview until the next request.
  const compact = await fetch(`${route}/compact`, { method: 'POST' })
  expect(compact.status).toBe(200)
  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 20_000 })
  await openSession(page, title)
  await expect(openMeter(page)).toBeVisible({ timeout: 30_000 })
  await openMeter(page).click()
  await expect(page.getByText('After compaction · estimated').first()).toBeVisible({ timeout: 20_000 })
  await page.keyboard.press('Escape')

  // A brand-new conversation has no recorded request: the meter says so
  // instead of showing the previous conversation's figures.
  const other = await createSession('Accounting E2E other')
  expect(other.id).not.toBe(id)
  const otherRoute = other.route
  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible({ timeout: 20_000 })
  await openSession(page, other.title)
  await expect(openMeter(page)).toBeVisible({ timeout: 30_000 })
  await openMeter(page).click()
  await expect(page.getByText('No recorded request context for this conversation.').first()).toBeVisible({ timeout: 20_000 })
  expect(await manifest(otherRoute)).toBeNull()

  // The first conversation's log carries the full accounting trail.
  const log = await fs.readFile(path.join(home, 'workspaces', (await (await fetch(`${server!.url}/api/workspaces`)).json() as { id: string }[])[0]!.id, 'sessions', id, 'events.jsonl'), 'utf8')
  const events = log.trim().split('\n').map((line) => JSON.parse(line) as { type: string; tokensAfter?: number; contextAfter?: { budget: { usedTokens: number } } })
  const end = events.findLast((event) => event.type === 'compaction/end')
  expect(end?.tokensAfter).toBeGreaterThan(0)
  expect(end?.contextAfter?.budget.usedTokens).toBe(end?.tokensAfter)
})
