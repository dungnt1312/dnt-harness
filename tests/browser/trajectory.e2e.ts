/// <reference lib="dom" />
// The init script runs in the browser, where the DOM lib applies.
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { readFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { selectWorkbenchView } from './workbench-nav.ts'

/**
 * A real session log, trimmed of bulky text: 15 turns, ~200 tool calls, many
 * of them in parallel batches, and long idle gaps between turns. A synthetic
 * two-turn log passed the old time-axis chart while this one rendered as an
 * unreadable pile, so the timeline is tested against this shape.
 */
const EVENTS = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/trajectory-session.json', import.meta.url)), 'utf8')) as readonly Record<string, unknown>[]
const SMALL = [
  { type: 'turn/start', seq: 1, timestamp: 1_000, turnId: 't1' },
  { type: 'user/message', seq: 2, timestamp: 1_000, turnId: 't1', content: 'first turn' },
  { type: 'assistant/message', seq: 3, timestamp: 2_000, content: '', toolCalls: [{ id: 'c1', name: 'Bash', args: {} }, { id: 'c2', name: 'Grep', args: {} }] },
  { type: 'tool/call', seq: 4, timestamp: 2_000, call: { id: 'c1', name: 'Bash', args: { command: 'pnpm test' } } },
  { type: 'tool/call', seq: 5, timestamp: 2_100, call: { id: 'c2', name: 'Grep', args: { pattern: 'createProject', path: 'src' } } },
  { type: 'tool/result', seq: 6, timestamp: 5_000, callId: 'c1', ok: true, output: 'ok' },
  { type: 'tool/result', seq: 7, timestamp: 5_200, callId: 'c2', ok: false, output: 'no such dir' },
  { type: 'step/start', seq: 8, timestamp: 5_200, turnId: 't1' },
  { type: 'assistant/message', seq: 9, timestamp: 6_000, content: 'All done.' },
  { type: 'turn/end', seq: 10, timestamp: 6_000, turnId: 't1', reason: 'completed' },
]
const shots = fileURLToPath(new URL('../../artifacts/product-ui/trajectory', import.meta.url))

function json(route: Route, value: unknown): Promise<void> {
  return route.fulfill({ status: 200, json: value })
}

async function serve(page: Page, events: readonly unknown[], children: readonly unknown[] = []): Promise<void> {
  await page.addInitScript((snapshot) => {
    class FixtureEventSource {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      constructor(readonly url: string) {
        window.setTimeout(() => {
          this.readyState = 1
          this.onopen?.(new Event('open'))
          this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ kind: 'snapshot', events: snapshot }) }))
        }, 0)
      }
      close(): void { this.readyState = 2 }
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: FixtureEventSource })
    window.localStorage.clear()
  }, events)

  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path === '/api/auth/state') return json(route, { required: false, paired: true })
    if (path === '/api/workspaces') return json(route, [{ id: 'w', name: 'Fixture workspace', default: true, archived: false, createdAt: 0 }])
    if (path === '/api/workspaces/w/projects') return json(route, [{ id: 'p', name: 'Fixture project', workspaceId: 'w', path: 'C:/fixture/project', createdAt: 0 }])
    if (path === '/api/workspaces/w/projects/p/files') return json(route, { path: '', entries: [] })
    if (path === '/api/workspaces/w/sessions') return json(route, [
      { id: 's', workspaceId: 'w', title: 'Fixture conversation', projectId: 'p', folder: null, eventCount: events.length, createdAt: 0, updatedAt: 0, status: 'idle' },
      // Children are conversations of their own; the app only opens ids it lists.
      ...children.map((child) => ({ id: (child as { childSessionId: string }).childSessionId, workspaceId: 'w', title: 'Child conversation', projectId: 'p', folder: null, eventCount: 0, createdAt: 0, updatedAt: 0, status: 'idle' })),
    ])
    if (path === '/api/workspaces/w/meta') return json(route, { workspace: { id: 'w', name: 'Fixture workspace', archived: false }, provider: 'fixture-provider', model: 'fixture-model', providers: [], models: ['fixture-model'], projects: [{ id: 'p', name: 'Fixture project', path: 'C:/fixture/project' }], permissionDefaults: {}, thinkingLevel: null })
    if (path === '/api/workspaces/w/mode') return json(route, { modes: [{ id: 'chat', name: 'Chat', source: 'bundled' }], selected: 'chat', revision: 1 })
    if (path === '/api/model-defaults') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null })
    if (path === '/api/workspaces/w/agents/children') return json(route, children)
    // Any conversation id: a Subagents row navigates to the child's own session.
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/model$/.test(path)) return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null, source: 'global' })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/grants$/.test(path)) return json(route, { revision: 0, roots: [], effective: [] })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/manifest$/.test(path)) return json(route, { modeId: 'chat', modeRevision: 1, budget: { availableTokens: 32000, usedTokens: 0, estimated: false }, history: { setting: 'all', includedTurns: 0, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [] })
    if (path === '/api/workspaces/w/skills') return json(route, [])
    // The real log's user messages reference attachments; the chart never reads them.
    if (path.startsWith('/api/workspaces/w/attachments/')) return route.fulfill({ status: 404, body: '' })
    throw new Error(`Unexpected fixture API request: ${route.request().method()} ${url.href}`)
  })

  await page.goto('/workspaces/w/sessions/s')
  await expect(page.getByRole('button', { name: /^(Open|Close) workbench$/ })).toBeVisible()
}

interface Mark { readonly lane: string; readonly x: number; readonly y: number; readonly right: number; readonly bottom: number }

/** Every mark on the timeline, in document (= step) order, with the lane it sits in. */
async function marks(timeline: Locator): Promise<Mark[]> {
  return timeline.evaluate((root) => {
    const lanes = ['Input', 'Model', 'Tools']
    const scroller = root.querySelector('.overflow-x-auto') as HTMLElement
    const base = scroller.getBoundingClientRect()
    return Array.from(root.querySelectorAll('button')).map((button) => {
      const cell = button.parentElement as HTMLElement
      const column = cell.parentElement as HTMLElement
      const laneIndex = Array.from(column.children).indexOf(cell) - 1
      const box = button.getBoundingClientRect()
      return { lane: lanes[laneIndex] ?? '?', x: box.left - base.left + scroller.scrollLeft, y: box.top, right: box.right - base.left + scroller.scrollLeft, bottom: box.bottom }
    })
  })
}

test('a real ~200-call session reads as a sequence: no mark overlaps another', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await serve(page, EVENTS)
  const workbench = await selectWorkbenchView(page, 'Trajectory')
  const timeline = workbench.getByRole('group', { name: 'Conversation timeline' })
  await expect(timeline).toBeVisible()

  const all = await marks(timeline)
  const turnCount = EVENTS.filter((event) => event.type === 'turn/start').length
  expect(all.filter((mark) => mark.lane === 'Input')).toHaveLength(turnCount)
  expect(all.filter((mark) => mark.lane === 'Model').length).toBeGreaterThan(100)
  expect(all.filter((mark) => mark.lane === 'Tools').length).toBeGreaterThan(50)

  // The complaint: marks piling on top of each other. None may intersect.
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1]!
    const current = all[index]!
    expect(current.x, `mark ${index} starts before mark ${index - 1} ends`).toBeGreaterThanOrEqual(previous.right - 0.5)
    expect(current.right - current.x, `mark ${index} is too thin to read`).toBeGreaterThan(20)
  }
  // Each lane is its own row.
  const rows = new Map<string, number>()
  for (const mark of all) rows.set(mark.lane, mark.y)
  expect(new Set(rows.values()).size).toBe(3)

  mkdirSync(shots, { recursive: true })
  await workbench.screenshot({ path: `${shots}/real-session.png` })
})

test('clicking a step shows what the log recorded for it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await serve(page, SMALL)
  const workbench = await selectWorkbenchView(page, 'Trajectory')
  const timeline = workbench.getByRole('group', { name: 'Conversation timeline' })

  // input → request 1 → its 2 parallel calls in ONE slot → request 2
  const order = (await marks(timeline)).map((mark) => mark.lane)
  expect(order).toEqual(['Input', 'Model', 'Tools', 'Model'])

  // The log is readable before any click: prompt, answers and calls in order.
  const steps = workbench.getByRole('list', { name: 'Steps' })
  await expect(steps.getByText('first turn')).toBeVisible()
  await expect(steps.getByText('All done.')).toBeVisible()

  await timeline.getByRole('button', { name: 'Turn 1, 2 tool calls' }).click()
  const calls = workbench.getByRole('list', { name: 'Turn 1, 2 tool calls' })
  await expect(calls.getByText('pnpm test')).toBeVisible()
  await expect(calls.getByText('createProject in src')).toBeVisible()

  // Each call opens to what the log recorded: exact arguments and output.
  const grep = calls.getByRole('button', { name: /Grep/ })
  await expect(grep).toHaveAttribute('aria-expanded', 'false')
  await grep.click()
  await expect(grep).toHaveAttribute('aria-expanded', 'true')
  const body = calls.getByRole('group').filter({ has: page.locator('pre') })
  await expect(body).toContainText('"pattern": "createProject"')
  await expect(body).toContainText('no such dir')
  await grep.click()
  await expect(calls.getByRole('group').filter({ has: page.locator('pre') })).toHaveCount(0)

  await timeline.getByRole('button', { name: 'Turn 1, request 2' }).click()
  await expect(steps.locator('[aria-current="step"]')).toContainText('All done.')

  await timeline.getByRole('button', { name: 'Turn 1 input' }).click()
  const input = steps.locator('[aria-current="step"]')
  await expect(input).toContainText('first turn')
  await expect(input).toContainText('Completed')
})

test('the Subagents view lists running and ended children and opens one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const now = Date.now()
  const spawns = [
    { type: 'agent/child-spawn', seq: 1, timestamp: now - 7_200_000, childSessionId: 'c-old', parentTurnId: 't', definition: 'reviewer', brief: 'Audit subagent isolation\nDetails the row must not show.' },
    { type: 'agent/child-spawn', seq: 2, timestamp: now - 60_000, childSessionId: 'c-run', parentTurnId: 't', definition: 'explorer', brief: 'Explore delegation terminal' },
  ]
  const children = [
    { childSessionId: 'c-old', status: 'completed', definitionName: 'reviewer', startedAt: now - 7_200_000, endedAt: now - 7_000_000, result: { report: '## Code Review Summary\n**Scope:** read-only', filesTouched: [] } },
    { childSessionId: 'c-run', status: 'running', definitionName: 'explorer', model: 'far:gpt-luna', startedAt: now - 60_000, awaitingApproval: true },
  ]
  await serve(page, spawns, children)
  const workbench = await selectWorkbenchView(page, 'Subagents')

  const running = workbench.getByRole('region', { name: 'Running subagents' })
  await expect(running).toContainText('Running · 1')
  await expect(running).toContainText('Explore delegation terminal')
  await expect(running).toContainText('Waiting for your approval')

  const ended = workbench.getByRole('region', { name: 'Ended subagents' })
  await expect(ended).toContainText('Ended · 1')
  await expect(ended).toContainText('Audit subagent isolation')
  await expect(ended).toContainText('Completed')
  await expect(ended).toContainText('Code Review Summary')
  await expect(ended).not.toContainText('Details the row must not show')
  await expect(ended).not.toContainText('##')
  // Delegation is the model's job now: no spawn form in the workbench.
  await expect(workbench.getByRole('button', { name: /Spawn/ })).toHaveCount(0)
  await expect(workbench.locator('textarea')).toHaveCount(0)

  await workbench.screenshot({ path: `${shots}/subagents.png` })

  // A row opens the child's own conversation.
  await ended.getByRole('button', { name: /Audit subagent isolation/ }).click()
  await expect(page).toHaveURL(/\/sessions\/c-old$/)
})
