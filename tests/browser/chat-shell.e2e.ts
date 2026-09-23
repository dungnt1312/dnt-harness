/// <reference lib="dom" />
// page.evaluate and init-script callbacks run in the browser.
import { expect, test, type Page, type Route } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { selectWorkbenchView } from './workbench-nav.ts'

const screenshotRoot = fileURLToPath(new URL('../../artifacts/product-ui/chat', import.meta.url))
const REQUIRED_WIDTHS = [320, 375, 768, 1024, 1440, 1920] as const
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'] as const

/** A long conversation mixing prose, thinking, tool rows, a delegation and a failure. */
function longConversation(): readonly unknown[] {
  const events: unknown[] = []
  let seq = 0
  const push = (event: Record<string, unknown>): void => { events.push({ ...event, seq: seq++, timestamp: 1_700_000_000_000 + seq * 1_000 }) }
  for (let turn = 1; turn <= 8; turn += 1) {
    push({ type: 'turn/start' })
    push({ type: 'user/message', content: `Question ${turn}: explain how the tool pipeline handles step ${turn}.` })
    push({ type: 'assistant/chunk', delta: `Considering step ${turn} of the pipeline before answering.`, thinking: true })
    push({ type: 'tool/call', call: { id: `read-${turn}`, name: 'Read', args: { path: `C:/fixture/project/src/step-${turn}.ts` } } })
    push({ type: 'tool/result', callId: `read-${turn}`, ok: true, output: `export const step${turn} = true\n`.repeat(4) })
    push({ type: 'tool/call', call: { id: `bash-${turn}`, name: 'Bash', args: { command: `npm test -- step-${turn}` } } })
    push({ type: 'tool/result', callId: `bash-${turn}`, ok: turn % 3 !== 0, output: turn % 3 !== 0 ? 'All tests passed' : '1 failing test' })
    push({ type: 'assistant/message', content: `## Step ${turn}\n\nThe pipeline validates arguments, asks the policy gate, then runs the tool.\n\n- validation happens first\n- the approval gate is next\n- results are recorded durably\n\n\`\`\`ts\nconst result = await pipeline.run(step${turn})\n\`\`\`\n\nThat is the whole flow for step ${turn}.`, controls: { model: 'fixture-model', provider: 'fixture-provider' } })
    push({ type: 'turn/end', reason: 'completed' })
  }
  push({ type: 'turn/start' })
  push({ type: 'user/message', content: 'Delegate a repository map.' })
  push({ type: 'agent/child-spawn', childSessionId: 'child', definition: 'explorer', brief: 'Map the repository modules' })
  push({ type: 'agent/child-result', childSessionId: 'child', status: 'completed' })
  push({ type: 'assistant/message', content: 'The explorer finished mapping the repository.' })
  push({ type: 'turn/end', reason: 'completed' })
  return events
}

const APPROVAL_EVENTS = [
  ...longConversation(),
  { type: 'turn/start', seq: 500 },
  { type: 'user/message', seq: 501, content: 'Run the full test suite.' },
  { type: 'approval/request', seq: 502, approvalId: 'approval-1', call: { id: 'call-1', name: 'Bash', args: { command: 'npm test', cwd: 'C:/fixture/project' } } },
]

interface Options {
  readonly events?: readonly unknown[]
  readonly path?: string
  readonly theme?: 'light' | 'dark'
}

async function fixture(page: Page, options: Options = {}): Promise<{ readonly posts: () => readonly string[] }> {
  const posts: string[] = []
  const unexpected: string[] = []
  const events = options.events ?? longConversation()
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value })

  await page.addInitScript(({ snapshot, theme }) => {
    if (theme !== undefined) window.localStorage.setItem('mini-dsh.theme', theme)
    class FixtureEventSource {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
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
  }, { snapshot: events, theme: options.theme })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (method !== 'GET') posts.push(`${method} ${path}`)
    if (path === '/api/workspaces') return json(route, [{ id: 'w', name: 'Fixture workspace', default: true, archived: false, createdAt: 0 }])
    if (path === '/api/workspaces/w/projects') return json(route, [{ id: 'p', name: 'Fixture project', workspaceId: 'w', path: 'C:/fixture/project', createdAt: 0 }])
    if (path === '/api/workspaces/w/sessions') return json(route, [
      { id: 's', workspaceId: 'w', title: 'Tool pipeline walkthrough', projectId: 'p', folder: null, eventCount: events.length, createdAt: 0, updatedAt: Date.now(), status: 'idle' },
      { id: 's2', workspaceId: 'w', title: 'Plan a refactor', projectId: null, folder: null, eventCount: 2, createdAt: 0, updatedAt: Date.now() - 86_400_000 * 3, status: 'idle' },
    ])
    if (path === '/api/workspaces/w/meta') return json(route, {
      workspace: { id: 'w', name: 'Fixture workspace', archived: false },
      provider: 'fixture-provider',
      model: 'fixture-model',
      providers: [{ id: 'fixture-provider', name: 'Fixture provider', baseUrl: 'http://fixture.invalid', enabled: true, keyMasked: '***', models: ['fixture-model', 'fixture-large'], modelSettings: {} }],
      models: ['fixture-model', 'fixture-large'],
      policy: { Bash: 'ask' },
      thinkingLevel: null,
    })
    if (path === '/api/workspaces/w/mode') return json(route, { modes: [{ id: 'chat', name: 'Chat', source: 'bundled' }, { id: 'full-access', name: 'Full access', source: 'bundled' }], selected: 'chat', revision: 1 })
    // Model selection is per conversation, with a global default behind it.
    if (path === '/api/model-defaults') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/model$/.test(path)) return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null, source: 'session' })
    if (path === '/api/workspaces/w/skills') return json(route, [])
    if (path === '/api/workspaces/w/projects/p/files') return json(route, new URL(request.url()).searchParams.get('path') === 'src'
      ? { path: 'src', entries: [{ name: 'step-8.ts', path: 'src/step-8.ts', kind: 'file', size: 120 }] }
      : { path: '', entries: [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'package.json', path: 'package.json', kind: 'file', size: 480 }] })
    if (path === '/api/workspaces/w/projects/p/file') return json(route, { path: new URL(request.url()).searchParams.get('path'), size: 120, binary: false, truncated: false, content: '{\n  "name": "fixture",\n  "private": true\n}\n' })
    if (path.endsWith('/manifest')) return json(route, { modeId: 'chat', modeRevision: 1, budget: { availableTokens: 32000, usedTokens: 12000, estimated: true }, history: { setting: 'all', includedTurns: 9, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: ['Read', 'Bash'], toolSchemas: 2 }, omissions: [] })
    if (path === '/api/workspaces/w/agents/children/child') return json(route, { childSessionId: 'child', definitionName: 'explorer', status: 'completed', result: { report: 'Mapped 12 modules.', filesTouched: ['src/index.ts'] } })
    if (path === '/api/workspaces/w/sessions/s/messages' && method === 'POST') return json(route, { inputId: 'accepted', queued: false })
    if (path === '/api/approvals/approval-1' && method === 'POST') return json(route, { answered: true })
    // Fail loudly instead of leaving the request hanging.
    unexpected.push(`${method} ${path}`)
    return json(route, { error: `unexpected fixture request ${method} ${path}` }, 500)
  })

  const target = options.path ?? '/workspaces/w/sessions/s'
  await page.goto(target)
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  // The model picker names its scope: a conversation owns its own selection,
  // while with none open the same control edits the global default.
  await expect(page.getByRole('button', {
    name: target.includes('/sessions/') ? 'Conversation model (next request)' : 'Default model for new conversations',
  })).toBeVisible()
  expect(unexpected).toEqual([])
  return { posts: () => posts }
}

async function transcriptMetrics(page: Page): Promise<{ readonly top: number; readonly max: number }> {
  return page.getByRole('region', { name: 'Conversation transcript' }).evaluate((element) => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }))
}

test('opens a long conversation at the latest message and lets the reader scroll freely', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const transcript = page.getByRole('region', { name: 'Conversation transcript' })
  await expect(transcript.getByText('The explorer finished mapping the repository.')).toBeVisible()
  await expect.poll(async () => { const m = await transcriptMetrics(page); return m.max - m.top }).toBeLessThan(4)
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0)

  await transcript.hover()
  await page.mouse.wheel(0, -2500)
  const jump = page.getByRole('button', { name: 'Jump to latest' })
  await expect(jump).toBeVisible()
  const scrolledUp = await transcriptMetrics(page)
  expect(scrolledUp.max - scrolledUp.top).toBeGreaterThan(500)

  // Expanding a row while scrolled up must not yank the reader to the bottom.
  await transcript.getByRole('button', { name: /Read/ }).first().click()
  await page.waitForTimeout(200)
  expect((await transcriptMetrics(page)).top).toBeLessThan(scrolledUp.top + 1)

  await jump.click()
  await expect.poll(async () => { const m = await transcriptMetrics(page); return m.max - m.top }).toBeLessThan(4)
  await expect(jump).toHaveCount(0)
})

test('tool rows stay inline and collapsed; expanding shows exact arguments and output', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const transcript = page.getByRole('region', { name: 'Conversation transcript' })
  const row = transcript.getByRole('button', { name: /Bash.*npm test -- step-8/ })
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'true')
  await expect(transcript.getByText('"command": "npm test -- step-8"')).toBeVisible()
  await expect(transcript.getByText('All tests passed').last()).toBeVisible()
  await expect(transcript.getByText('Failed').first()).toBeAttached()
  await expect(page.locator('[data-workbench-surface]')).toHaveCount(0)
})

test('approval cards sit above the composer and answer exactly one request', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, { events: APPROVAL_EVENTS })
  const approvals = page.getByRole('region', { name: 'Pending approvals' })
  await expect(approvals.getByText('1 request awaiting a decision')).toBeVisible()
  await approvals.getByRole('button', { name: 'Allow once' }).click()
  await expect.poll(() => state.posts().filter((post) => post === 'POST /api/approvals/approval-1').length).toBe(1)
})

test('empty state centers the composer and sends start a conversation flow', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page, { path: '/workspaces/w' })
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Conversation scope/ })).toBeVisible()
  // With no conversation open the picker edits the global default instead.
  await expect(page.getByRole('button', { name: 'Default model for new conversations' })).toContainText('fixture-model')
})

test('sidebar collapses on desktop and becomes a focus-trapped drawer on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const nav = page.getByRole('navigation', { name: 'Conversations and projects' })
  await expect(nav).toBeVisible()
  await nav.getByRole('button', { name: 'Close sidebar' }).click()
  await expect(nav).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  await expect(nav).toHaveCount(0)
  await page.getByRole('button', { name: 'Open sidebar' }).click()
  await expect(nav).toBeVisible()

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(nav).toHaveCount(0)
  const opener = page.getByRole('button', { name: 'Open sidebar' })
  await opener.click()
  const drawer = page.getByRole('dialog', { name: 'Conversation navigation' })
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  // The row's accessible name carries a relative timestamp ("Plan a refactor 3d"),
  // so anchor the match instead of pinning an exact string that ages.
  await drawer.getByRole('button', { name: /^Plan a refactor\b/ }).click()
  await expect(drawer).toHaveCount(0)
  await expect(page).toHaveURL('/workspaces/w/sessions/s2')
})

test('sidebar width resizes by keyboard and persists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const separator = page.getByRole('separator', { name: 'Resize sidebar' })
  const nav = page.getByRole('navigation', { name: 'Conversations and projects' })
  await expect(separator).toHaveAttribute('aria-valuenow', '280')
  await separator.focus()
  await page.keyboard.press('Shift+ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '344')
  await expect.poll(async () => Math.round((await nav.boundingBox())?.width ?? 0)).toBe(344)

  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toHaveAttribute('aria-valuenow', '344')
})

test('workbench docks beside the chat, browses project files and opens them as tabs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const workbench = page.getByRole('region', { name: 'Workbench' })
  await expect(workbench).toBeVisible()
  await expect(page.getByRole('region', { name: 'Conversation transcript' })).toBeVisible()
  const files = workbench.getByRole('list', { name: 'Project files' })
  await expect(files).toContainText('package.json')
  await files.getByRole('button', { name: /^src/ }).click()
  await expect(workbench.getByRole('navigation', { name: 'Folder path' })).toContainText('src')
  await files.getByRole('button', { name: /step-8\.ts/ }).click()
  await expect(workbench.getByRole('button', { name: 'step-8.ts', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(workbench.getByRole('region', { name: 'Contents of src/step-8.ts' })).toContainText('"private": true')

  await selectWorkbenchView(page, 'Context')
  await expect(workbench.getByText('~12000/32000 tok (est)')).toBeVisible()
  await selectWorkbenchView(page, 'Artifacts')
  await expect(workbench.getByRole('list', { name: 'Recorded artifacts' })).toBeVisible()
  await workbench.getByRole('button', { name: 'Close src/step-8.ts' }).click()
  await expect(workbench.getByRole('button', { name: 'step-8.ts', exact: true })).toHaveCount(0)
})

test('tool rows open recorded project paths in the workbench', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  await page.getByRole('button', { name: 'Close workbench' }).click()
  await expect(page.getByRole('region', { name: 'Workbench' })).toHaveCount(0)
  const transcript = page.getByRole('region', { name: 'Conversation transcript' })
  await transcript.getByRole('button', { name: /Read.*step-8\.ts/ }).click()
  await transcript.getByRole('button', { name: /Open C:\/fixture\/project\/src\/step-8\.ts in workbench/ }).click()
  const workbench = page.getByRole('region', { name: 'Workbench' })
  await expect(workbench.getByRole('region', { name: 'Contents of src/step-8.ts' })).toBeVisible()
})

test('workbench remembers closed state and width, resizes by keyboard and expands to full width', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page)
  const separator = page.getByRole('separator', { name: 'Resize workbench' })
  await expect(separator).toHaveAttribute('aria-valuenow', '560')
  await separator.focus()
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '624')
  const workbench = page.getByRole('region', { name: 'Workbench' })
  await expect.poll(async () => Math.round((await workbench.boundingBox())?.width ?? 0)).toBe(624)

  await workbench.getByRole('button', { name: 'Expand workbench' }).click()
  await expect(page.getByRole('region', { name: 'Conversation transcript' })).toBeHidden()
  await workbench.getByRole('button', { name: 'Exit full width' }).click()
  await expect(page.getByRole('region', { name: 'Conversation transcript' })).toBeVisible()

  await page.getByRole('button', { name: 'Close workbench' }).click()
  await page.reload()
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Workbench' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Open workbench' }).click()
  await expect(separator).toHaveAttribute('aria-valuenow', '624')
})

test('below 1280px the workbench is a sheet that restores focus to its opener', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await fixture(page)
  await expect(page.getByRole('region', { name: 'Workbench' })).toHaveCount(0)
  const opener = page.getByRole('button', { name: 'Open workbench' })
  await opener.click()
  const sheet = page.getByRole('dialog', { name: 'Workbench' })
  await expect(sheet.getByRole('list', { name: 'Project files' })).toBeVisible()
  await expect(sheet.getByRole('button', { name: 'Expand workbench' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  await expect(opener).toBeFocused()
})

test('a chat-only conversation explains that there are no files to browse', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page, { path: '/workspaces/w/sessions/s2' })
  await expect(page.getByRole('region', { name: 'Workbench' })).toContainText('No project folder for this conversation')
})

test('appearance menu switches between light and dark themes and persists', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page, { theme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByRole('button', { name: 'Preferences' }).click()
  await page.getByRole('menuitemradio', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('mini-dsh.theme'))).toBe('dark')
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(33, 33, 33)')
})

for (const theme of ['light', 'dark'] as const) {
  test(`has no horizontal overflow, passes axe and records screenshots in ${theme} theme`, async ({ page }) => {
    mkdirSync(screenshotRoot, { recursive: true })
    await fixture(page, { events: APPROVAL_EVENTS, theme })
    for (const width of REQUIRED_WIDTHS) {
      await page.setViewportSize({ width, height: width < 768 ? 800 : 900 })
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.waitForTimeout(150)
      await page.screenshot({ path: `${screenshotRoot}/${theme}-conversation-${width}.png` })
    }
    await page.setViewportSize({ width: 1440, height: 900 })
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()
    expect(results.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])

    const workbench = page.getByRole('region', { name: 'Workbench' })
    await workbench.getByRole('list', { name: 'Project files' }).getByRole('button', { name: /package\.json/ }).click()
    await expect(workbench.getByRole('region', { name: 'Contents of package.json' })).toBeVisible()
    await page.screenshot({ path: `${screenshotRoot}/${theme}-workbench-file-1440.png` })
    const workbenchAxe = await new AxeBuilder({ page }).include('[aria-label="Workbench"]').withTags([...AXE_TAGS]).analyze()
    expect(workbenchAxe.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])

    await page.goto('/workspaces/w')
    await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible()
    await page.screenshot({ path: `${screenshotRoot}/${theme}-empty-1440.png` })
    await page.getByRole('button', { name: 'Open settings' }).click()
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.screenshot({ path: `${screenshotRoot}/${theme}-settings-1440.png` })
    const settingsAxe = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze()
    expect(settingsAxe.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([])
  })
}
