/// <reference lib="dom" />
// page.evaluate and init-script callbacks run in the browser.
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { AxeBuilder } from '@axe-core/playwright'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openWorkbench, selectWorkbenchView } from './workbench-nav.ts'

const screenshotRoot = fileURLToPath(new URL('../../artifacts/product-ui/chat/matrix', import.meta.url))
const REQUIRED_WIDTHS = [320, 375, 768, 1024, 1440, 1920] as const
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21aa'] as const

type FixtureState = 'no-workspace' | 'running-tool' | 'completed-tool' | 'recovered-tool' | 'artifacts' | 'delegation' | 'no-work' | 'approval' | 'late-transcript' | 'reconnect' | 'new-conversation' | 'new-conversation-success' | 'settings'

interface RequestRecord {
  readonly method: string
  readonly path: string
  readonly body: unknown
}

interface Fixture {
  readonly requests: () => readonly RequestRecord[]
  readonly count: (method: string, path: string) => number
}

const SESSION_PATH = '/api/workspaces/w/sessions/s'
const EVENTS_PATH = `${SESSION_PATH}/events`

function fixtureEvents(state: FixtureState): readonly unknown[] {
  if (state === 'running-tool' || state === 'reconnect') return [
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1, content: 'Run the active task' },
    { type: 'tool/call', seq: 2, call: { id: 'tool', name: 'Bash', args: { command: 'npm test' } } },
  ]
  if (state === 'late-transcript') return Array.from({ length: 12 }, (_, index) => ({ type: 'user/message', seq: index, content: `Late transcript item ${index + 1}\n${'late content '.repeat(20)}` }))
  if (state === 'completed-tool') return [
    ...Array.from({ length: 18 }, (_, index) => ({ type: 'user/message', seq: index, content: `Transcript item ${index + 1}` })),
    { type: 'tool/call', seq: 18, call: { id: 'tool', name: 'Bash', args: { command: 'npm test' } } },
    { type: 'tool/result', seq: 19, callId: 'tool', ok: true, output: 'recorded output' },
  ]
  if (state === 'recovered-tool') return [
    { type: 'tool/call', seq: 0, call: { id: 'tool', name: 'Bash', args: { command: 'npm test' } } },
    { type: 'tool/result', seq: 1, callId: 'tool', ok: true, output: 'partial output', recovery: true },
  ]
  if (state === 'artifacts') return [
    { type: 'tool/call', seq: 0, call: { id: 'file', name: 'Read', args: { path: 'C:/fixture/project/README.md', offset: 30, limit: 6 } } },
    { type: 'tool/result', seq: 1, callId: 'file', ok: true, output: '# fixture' },
    { type: 'tool/call', seq: 2, call: { id: 'command', name: 'Bash', args: { command: 'npm test' } } },
    { type: 'tool/result', seq: 3, callId: 'command', ok: false, output: 'test failure' },
    { type: 'tool/call', seq: 4, call: { id: 'output', name: 'custom_tool', args: {} } },
    { type: 'tool/result', seq: 5, callId: 'output', ok: true, output: 'custom output' },
    { type: 'tool/call', seq: 6, call: { id: 'pending', name: 'Read', args: { file_path: 'C:/fixture/project/pending.ts' } } },
    { type: 'tool/call', seq: 7, call: { id: 'recovered', name: 'Read', args: { path: 'C:/fixture/project/recovered.ts' } } },
    { type: 'tool/result', seq: 8, callId: 'recovered', ok: true, output: 'partial recovered output', recovery: true },
  ]
  if (state === 'delegation') return [{ type: 'agent/child-spawn', seq: 0, childSessionId: 'child', definition: 'explorer', objective: 'Map the app' }]
  if (state === 'approval') return [
    ...Array.from({ length: 14 }, (_, index) => ({ type: 'user/message', seq: index, content: `Approval context ${index + 1}\n${'Detailed transcript content '.repeat(12)}` })),
    { type: 'turn/start', seq: 14 },
    { type: 'approval/request', seq: 15, approvalId: 'approval-1', call: { id: 'call-1', name: 'Bash', args: { command: 'npm test', cwd: 'C:/fixture/project' } } },
  ]
  return [{ type: 'user/message', seq: 0, content: 'No work item' }]
}

async function fixture(page: Page, state: FixtureState): Promise<Fixture> {
  const records: RequestRecord[] = []
  let createdConversation = false
  let provider = { id: 'fixture-provider', name: 'Fixture provider', baseUrl: 'http://fixture.invalid', enabled: true, keyMasked: '***', models: ['fixture-model'], modelSettings: {} }
  const replacementProvider = { id: 'replacement-provider', name: 'Replacement provider', baseUrl: 'http://replacement.invalid', enabled: true, keyMasked: '', models: ['replacement-model'], modelSettings: {} }
  let providerDeleted = false
  let skillPutCount = 0
  let memoryPatchCount = 0
  let agentDeleteCount = 0
  let mcpActionCount = 0
  let secretDeleteCount = 0
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value })

  await page.addInitScript(({ events, reconnect, delayed }) => {
    class FixtureEventSource {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSED = 2
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSED = 2
      readyState = FixtureEventSource.CONNECTING
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      constructor(readonly url: string) {
        window.setTimeout(() => {
          this.readyState = FixtureEventSource.OPEN
          this.onopen?.(new Event('open'))
          window.setTimeout(() => this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ kind: 'snapshot', events }) })), delayed ? 120 : 0)
          if (reconnect) window.setTimeout(() => {
            this.readyState = FixtureEventSource.CONNECTING
            this.onerror?.(new Event('error'))
          }, 20)
        }, 0)
      }
      close(): void { this.readyState = FixtureEventSource.CLOSED }
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: FixtureEventSource })
  }, { events: fixtureEvents(state), reconnect: state === 'reconnect', delayed: state === 'late-transcript' })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    const method = request.method()
    let body: unknown = null
    try { body = request.postDataJSON() } catch { body = request.postData() }
    records.push({ method, path, body })

    if (path === '/api/workspaces' && method === 'GET') return json(route, state === 'no-workspace' ? [] : [{ id: 'w', name: 'Fixture workspace', default: true, archived: false, createdAt: 0 }])
    if (path === '/api/auth/state' && method === 'GET') return json(route, { required: false, paired: true })
    if (path === '/api/workspaces/w/projects' && method === 'GET') return json(route, [{ id: 'p', name: 'Fixture project', workspaceId: 'w', path: 'C:/fixture/project', createdAt: 0 }])
    if (path === '/api/workspaces/w/sessions' && method === 'GET') return json(route, state === 'new-conversation' || state === 'new-conversation-success'
      ? (createdConversation ? [{ id: 'created', workspaceId: 'w', title: 'Created conversation', projectId: 'p', folder: null, eventCount: 0, createdAt: 0, updatedAt: 0, status: 'idle' }] : [])
      : [
          { id: 's', workspaceId: 'w', title: 'Fixture conversation', projectId: 'p', folder: null, eventCount: fixtureEvents(state).length, createdAt: 0, updatedAt: 0, status: state === 'running-tool' || state === 'reconnect' || state === 'approval' ? 'running' : 'idle' },
          ...(state === 'delegation' ? [{ id: 'child', workspaceId: 'w', title: 'Child conversation', folder: null, eventCount: 0, createdAt: 0, updatedAt: 0 }] : []),
        ])
    if (path === '/api/workspaces/w/sessions' && method === 'POST') { createdConversation = true; return json(route, { id: 'created', projectId: 'p' }) }
    if (path === '/api/workspaces/w/meta' && method === 'GET') return json(route, {
      workspace: { id: 'w', name: 'Fixture workspace', archived: false },
      provider: 'fixture-provider',
      model: 'fixture-model',
      providers: [...(providerDeleted ? [] : [provider]), replacementProvider],
      models: ['fixture-model'],
      projects: [{ id: 'p', name: 'Fixture project', path: 'C:/fixture/project' }],
      permissionDefaults: { Bash: 'ask' },
      thinkingLevel: null,
    })
    if (path === '/api/workspaces/w/mode' && method === 'GET') return json(route, { modes: [{ id: 'chat', name: 'Chat', source: 'bundled' }], selected: 'chat', revision: 1 })
    if (path === '/api/model-defaults' && method === 'GET') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null })
    if (path === '/api/model-defaults' && method === 'PUT') return json(route, { thinkingLevel: null, ...(body as object) })
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/model$/.test(path) && method === 'GET') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null, source: 'global' })
    // No extra folder grants: file tools stay within the bound project.
    if (/^\/api\/workspaces\/w\/sessions\/[^/]+\/grants$/.test(path) && method === 'GET') return json(route, { revision: 0, roots: [], effective: [] })
    if (path === '/api/workspaces/w/projects/p/files' && method === 'GET') return json(route, url.searchParams.get('path') === 'src'
      ? { path: 'src', entries: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', size: 26 }] }
      : { path: '', entries: [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'README.md', path: 'README.md', kind: 'file', size: 9 }] })
    // Long enough that opening it at a recorded window has somewhere to scroll.
    if (path === '/api/workspaces/w/projects/p/file' && method === 'GET') return json(route, { path: url.searchParams.get('path'), size: 26, binary: false, truncated: false, content: `export const answer = 42\n${Array.from({ length: 84 }, (_, index) => `line ${index + 2}`).join('\n')}\n` })
    if (path.endsWith('/manifest') && method === 'GET') return json(route, { modeId: 'chat', modeRevision: 1, budget: { availableTokens: 32000, usedTokens: 0, estimated: false }, history: { setting: 'all', includedTurns: 0, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [] })
    if (path === `${SESSION_PATH}/messages` && method === 'POST') return json(route, { inputId: 'queued-1', queued: state === 'running-tool' || state === 'reconnect' })
    if (path === '/api/workspaces/w/sessions/created/messages' && method === 'POST') return state === 'new-conversation-success'
      ? json(route, { inputId: 'accepted-first', queued: false })
      : json(route, { error: 'fixture send refused' }, 503)
    if (path === `${SESSION_PATH}/stop` && method === 'POST') return json(route, { stopped: true })
    if (path === '/api/approvals/approval-1' && method === 'POST') return json(route, { answered: true })
    if (state === 'settings') {
      if (path === '/api/providers/fixture-provider' && method === 'PATCH') { provider = { ...provider, ...(body as object) }; return json(route, provider) }
      if (path === '/api/providers/fixture-provider' && method === 'DELETE') { providerDeleted = true; return json(route, { deleted: true }) }
      if (path === '/api/providers/fixture-provider/test' && method === 'POST') return json(route, { ok: true })
      // The probe answers without storing anything, as the server does.
      if (path === '/api/providers/fixture-provider/models' && method === 'GET') return json(route, { ok: true, models: ['fixture-model', 'fixture-next'] })
      // Sync persists the fetched list, as the server does.
      if (path === '/api/providers/fixture-provider/sync' && method === 'POST') { provider = { ...provider, models: ['fixture-model', 'fixture-next'] }; return json(route, { ok: true, models: provider.models }) }
      if (path === '/api/workspaces/w/model' && method === 'PUT') return json(route, { model: (body as { model?: string }).model })
      if (path === '/api/workspaces/w/projects/p' && method === 'DELETE') return json(route, { error: 'project is bound to 1 conversation and has a running session' }, 409)
      if (path === '/api/workspaces/w/skills' && method === 'GET') return json(route, [{ name: 'fixture-skill', title: 'Fixture skill', description: '', source: 'workspace', hash: 'skill-old' }])
      if (path === '/api/workspaces/w/skills/fixture-skill' && method === 'GET') return json(route, { name: 'fixture-skill', title: 'Fixture skill', description: '', source: 'workspace', hash: skillPutCount === 0 ? 'skill-old' : 'skill-fresh', instructions: '---\nname: fixture-skill\n---\n\nserver content' })
      if (path === '/api/workspaces/w/skills/fixture-skill' && method === 'PUT') { skillPutCount += 1; return skillPutCount === 1 ? json(route, { error: 'skill conflict' }, 409) : json(route, { name: 'fixture-skill', hash: 'skill-saved' }) }
      if (path === '/api/workspaces/w/memory' && method === 'GET') return json(route, [{ id: 'fixture-memory', title: 'Fixture memory', pinned: false, createdAt: 0, updatedAt: 0, body: 'server body', hash: memoryPatchCount === 0 ? 'memory-old' : 'memory-fresh' }])
      if (path === '/api/workspaces/w/memory/fixture-memory' && method === 'GET') return json(route, { id: 'fixture-memory', title: 'Fixture memory', pinned: false, createdAt: 0, updatedAt: 0, body: 'server body', hash: memoryPatchCount === 0 ? 'memory-old' : 'memory-fresh' })
      if (path === '/api/workspaces/w/memory/fixture-memory' && method === 'PATCH') { memoryPatchCount += 1; return memoryPatchCount === 1 ? json(route, { error: 'memory conflict' }, 409) : json(route, { id: 'fixture-memory', title: 'Fixture memory', pinned: false, createdAt: 0, updatedAt: 0, body: 'local body', hash: 'memory-saved' }) }
      if (path === '/api/workspaces/w/agents' && method === 'GET') return json(route, agentDeleteCount === 0 ? [{ source: 'workspace', definition: { name: 'fixture-agent', description: 'Fixture agent', tools: [], disallowedTools: [] } }] : [])
      if (path === '/api/workspaces/w/agents/children' && method === 'GET') return json(route, [])
      if (path === '/api/workspaces/w/agents/fixture-agent' && method === 'DELETE') { agentDeleteCount += 1; return agentDeleteCount === 1 ? json(route, { error: 'agent delete refused' }, 503) : json(route, { deleted: true }) }
      if (path === '/api/workspaces/w/mcp' && method === 'GET') return json(route, [{ name: 'fixture-mcp', transport: 'stdio', enabled: false, status: 'disabled', breakerOpenUntil: null }])
      if (path === '/api/workspaces/w/mcp/fixture-mcp/enable' && method === 'POST') { mcpActionCount += 1; return mcpActionCount === 1 ? json(route, { error: 'MCP enable refused' }, 503) : json(route, { status: 'ready' }) }
      if (path === '/api/workspaces/w/hooks' && method === 'GET') return json(route, { version: 1, hooks: { PreToolUse: [{ matcher: 'Bash*', type: 'command', command: 'node guard.mjs', onFailure: 'deny' }] } })
      if (path === '/api/workspaces/w/hooks' && method === 'PUT') return json(route, { saved: true })
      if (path === '/api/workspaces/w/secrets' && method === 'GET') return json(route, secretDeleteCount < 2 ? [{ name: 'FIXTURE_SECRET' }] : [])
      if (path === '/api/workspaces/w/secrets/FIXTURE_SECRET' && method === 'DELETE') { secretDeleteCount += 1; return secretDeleteCount === 1 ? json(route, { error: 'secret delete refused' }, 503) : json(route, { deleted: 'FIXTURE_SECRET' }) }
    }
    if (path === '/api/workspaces/w/skills' && method === 'GET') return json(route, [])
    throw new Error(`Unexpected fixture API request: ${method} ${url.href}`)
  })

  await page.addInitScript(() => {
    if (window.sessionStorage.getItem('fixture-storage-initialized') === null) {
      window.localStorage.clear()
      window.sessionStorage.setItem('fixture-storage-initialized', 'true')
    }
  })
  await page.goto(state === 'no-workspace' ? '/' : state === 'new-conversation' || state === 'new-conversation-success' ? '/workspaces/w' : '/workspaces/w/sessions/s')
  await expect(page.getByRole('button', { name: /^(Open|Close) workbench$/ })).toBeVisible()
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  if (state !== 'no-workspace' && state !== 'new-conversation' && state !== 'new-conversation-success') {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    const openNavigation = page.getByRole('button', { name: 'Open sidebar' })
    if (await openNavigation.count() > 0) await openNavigation.click()
    await expect(page.getByRole('button', { name: /^Fixture conversation/ })).toBeVisible()
    await expect(page.locator('[aria-current="page"]')).toHaveCount(1)
    const drawer = page.getByRole('dialog', { name: 'Conversation navigation' })
    if (await drawer.count() > 0) await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await expect(page.getByRole('region', { name: 'Conversation transcript' })).toBeVisible()
  }
  return {
    requests: () => records,
    count: (method, path) => records.filter((request) => request.method === method && request.path === path).length,
  }
}

/** Settings lives in the sidebar footer; on narrow screens the sidebar is a drawer. */
/** The provider editor fills in once providers load; edit it only after that. */
async function providerName(dialog: Locator): Promise<Locator> {
  // Exact: the rename affordance beside the title also carries "name".
  const name = dialog.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue('Fixture provider')
  return name
}

async function settingsTrigger(page: Page) {
  const trigger = page.getByRole('button', { name: 'Open settings', exact: true })
  if (!(await trigger.isVisible())) await page.getByRole('button', { name: 'Open sidebar' }).click()
  return trigger
}

function expectNoMutationRequests(state: Fixture, before: number): void {
  expect(state.requests().filter((request) => request.method !== 'GET')).toHaveLength(before)
}

for (const width of [320, 375, 768, 1024, 1440]) {
  test(`settings keeps all eight sections reachable with keyboard navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const state = await fixture(page, 'settings')
    const trigger = await settingsTrigger(page)
    await trigger.focus()
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await expect(dialog).toBeVisible()
    const labels = ['Providers', 'Projects', 'Skills', 'Memory', 'Agents', 'MCP', 'Hooks', 'Secrets']
    if (width <= 600) {
      const section = page.getByRole('combobox', { name: 'Settings section' })
      await expect(section).toBeVisible()
      for (const label of labels) {
        await section.click()
        await page.getByRole('option', { name: label, exact: true }).click()
        await expect(dialog.getByRole('heading', { name: label, exact: true }).first()).toBeVisible()
      }
    } else {
      const providers = dialog.getByRole('tab', { name: /Providers/ })
      await providers.focus()
      await page.keyboard.press('ArrowDown')
      await expect(dialog.getByRole('tab', { name: /Projects/ })).toBeFocused()
      for (const label of labels) {
        const tab = dialog.getByRole('tab', { name: new RegExp(label) })
        await tab.click()
        await expect(tab).toHaveAttribute('aria-selected', 'true')
        await expect(dialog.getByRole('heading', { name: label, exact: true }).first()).toBeVisible()
      }
    }
    if (width <= 600) {
      const section = page.getByRole('combobox', { name: 'Settings section' })
      await section.click()
      await page.getByRole('option', { name: 'Hooks', exact: true }).click()
    } else await dialog.getByRole('tab', { name: /Hooks/ }).click()
    const panel = dialog.getByRole('tabpanel')
    await expect(panel).toHaveCSS('overflow-y', 'auto')
    await expect.poll(() => panel.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0)
    await panel.evaluate(element => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => panel.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
    const lastSection = panel.locator('.manage-section').last()
    if (await lastSection.count() > 0) {
      await lastSection.scrollIntoViewIfNeeded()
      const [panelBox, sectionBox] = await Promise.all([panel.boundingBox(), lastSection.boundingBox()])
      expect(panelBox).not.toBeNull(); expect(sectionBox).not.toBeNull()
      expect(sectionBox!.y + sectionBox!.height).toBeLessThanOrEqual(panelBox!.y + panelBox!.height + 2)
    }
    await dialog.getByRole('button', { name: 'Close settings' }).click()
    await expect(trigger).toBeFocused()
    expect(state.requests().every(request => request.path.startsWith('/api/'))).toBe(true)
  })
}

for (const width of [375, 1024]) {
  test(`provider discard confirmation uses ${width <= 600 ? 'mobile Select' : 'desktop tabs'} at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await fixture(page, 'settings')
    await (await settingsTrigger(page)).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await (await providerName(dialog)).fill('Dirty provider')
    if (width <= 600) {
      await page.getByRole('combobox', { name: 'Settings section' }).click()
      await page.getByRole('option', { name: 'Projects', exact: true }).click()
    } else await dialog.getByRole('tab', { name: /Projects/ }).click()
    await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Dirty provider')
  })
}

test('provider replacement, close, and pending model text all require discard confirmation', async ({ page }) => {
  await fixture(page, 'settings')
  const trigger = await settingsTrigger(page)
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await (await providerName(dialog)).fill('dirty')
  await dialog.getByRole('option', { name: /Replacement provider/ }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(trigger).toBeFocused()

  await trigger.click()
  const reopened = page.getByRole('dialog', { name: 'Settings' })
  await reopened.getByRole('button', { name: 'Add model' }).click()
  await reopened.getByPlaceholder('gpt-5.6-sol, gpt-5.6-terra').fill('pending-model')
  await reopened.getByRole('option', { name: /Replacement provider/ }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
})

test('discarding a provider draft actually clears it — later tab switches and close do not re-prompt', async ({ page }) => {
  await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await (await providerName(dialog)).fill('dirty and discarded')
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Discard changes' }).click()
  await expect(dialog.getByRole('tab', { name: /Skills/ })).toHaveAttribute('aria-selected', 'true')

  // A resolved discard must not leave the draft comparison permanently dirty:
  // every further navigation should move directly, with no repeat prompt.
  for (const tabName of [/Memory/, /Agents/, /MCP/, /Providers/]) {
    await dialog.getByRole('tab', { name: tabName }).click()
    await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeHidden()
    await expect(dialog.getByRole('tab', { name: tabName })).toHaveAttribute('aria-selected', 'true')
  }
  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeHidden()
  await expect(dialog).toBeHidden()
})

test('provider dirty draft survives sections, confirms discard, and omits a blank stored key', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const name = await providerName(dialog)
  await name.fill('Fixture provider edited')
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await expect(page.getByRole('dialog', { name: 'Discard unsaved provider changes?' })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(name).toHaveValue('Fixture provider edited')
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect.poll(() => state.count('PATCH', '/api/providers/fixture-provider')).toBe(1)
  const patch = state.requests().find(request => request.method === 'PATCH' && request.path === '/api/providers/fixture-provider')?.body as Record<string, unknown>
  expect(patch.apiKey).toBeUndefined()
  expect(patch.name).toBe('Fixture provider edited')
})

test('provider test, sync, per-model test, and delete use exact existing requests', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  // The editor fills in once providers load; the footer controls stay disabled
  // until then, so wait for the selected entry before touching any of them.
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Fixture provider')
  await dialog.getByRole('button', { name: 'Test connection' }).click()
  // Sync proposes; the operator picks and saves. Nothing is stored before that.
  await dialog.getByRole('button', { name: 'Sync from /models' }).click()
  const sync = page.getByRole('dialog', { name: /^Sync models/ })
  await sync.getByRole('checkbox').nth(1).check()
  await sync.getByRole('button', { name: 'Sync 2 models' }).click()
  await expect(dialog.getByText('fixture-next')).toBeVisible()
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect.poll(() => state.count('PATCH', '/api/providers/fixture-provider')).toBe(1)
  // Each row pings its own model, naming it in the body.
  await dialog.getByRole('button', { name: 'Test model fixture-next' }).click()
  await expect(dialog.getByText('Model replied.')).toBeVisible()
  await expect.poll(() => state.count('POST', '/api/providers/fixture-provider/test')).toBe(2)
  await dialog.getByRole('button', { name: 'Delete provider' }).click()
  // The provider delete confirms in its own dialog, outside the settings one.
  await page.getByRole('button', { name: 'Delete permanently' }).click()
  await expect.poll(() => state.count('DELETE', '/api/providers/fixture-provider')).toBe(1)
  for (const expected of [
    ['GET', '/api/providers/fixture-provider/models'],
    ['PATCH', '/api/providers/fixture-provider'],
    ['DELETE', '/api/providers/fixture-provider'],
  ] as const) expect(state.count(expected[0], expected[1])).toBe(1)
  // The persisting sync route is never what the browser uses.
  expect(state.count('POST', '/api/providers/fixture-provider/sync')).toBe(0)
  // Every row-level ping names its model; only the provider-level footer test
  // sends an empty body (it falls back to the first model server-side).
  const tests = state.requests().filter(request => request.method === 'POST' && request.path === '/api/providers/fixture-provider/test')
  expect(tests.some(request => request.body === null)).toBe(true)
  expect(tests.some(request => (request.body as { model?: string } | null)?.model === 'fixture-next')).toBe(true)
  expect(state.requests().filter(request => ['/api/providers/fixture-provider/models', '/api/providers/fixture-provider'].includes(request.path) && request.method !== 'PATCH').every(request => request.body === null)).toBe(true)
})

test('project bound and running 409 remains visible after confirmed removal', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: /Projects/ }).click()
  await dialog.getByRole('button', { name: 'Remove project' }).click()
  await dialog.getByRole('button', { name: 'Remove registration' }).click()
  await expect(dialog).toContainText('project is bound to 1 conversation and has a running session')
  expect(state.count('DELETE', '/api/workspaces/w/projects/p')).toBe(1)
})

test('Hooks raw invalid stays intact and valid raw saves the exact whole document', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: /Hooks/ }).click()
  await dialog.getByRole('button', { name: 'Advanced · edit raw JSON' }).click()
  const raw = dialog.getByLabel('hooks.json')
  await raw.fill('{}')
  await dialog.getByRole('button', { name: 'Apply raw' }).click()
  await expect(dialog).toContainText('Hooks validation error: version must be 1')
  await expect(raw).toHaveValue('{}')
  expect(state.count('PUT', '/api/workspaces/w/hooks')).toBe(0)
  const document = { version: 1, hooks: { PreToolUse: [{ matcher: 'Bash*', type: 'command', command: 'node exact.mjs', args: ['--safe'], timeoutMs: 800, onFailure: 'deny' }] } }
  await raw.fill(JSON.stringify(document))
  await dialog.getByRole('button', { name: 'Apply raw' }).click()
  await dialog.getByRole('button', { name: 'Save hooks' }).click()
  await expect.poll(() => state.count('PUT', '/api/workspaces/w/hooks')).toBe(1)
  expect(state.requests().find(request => request.method === 'PUT' && request.path === '/api/workspaces/w/hooks')?.body).toEqual(document)
})

for (const invalid of [
  { label: 'unknown top-level key', draft: '{\n  "version": 1,\n  "hooks": {},\n  "extra": true\n}', error: 'unknown top-level key "extra"' },
  { label: 'unknown binding key', draft: '{"version":1,"hooks":{"PreToolUse":[{"matcher":"*","type":"command","command":"node guard.mjs","onFailure":"deny","extra":true}]}}', error: 'PreToolUse[0] has unknown key "extra"' },
]) {
  test(`Hooks raw ${invalid.label} remains verbatim/open with zero PUT`, async ({ page }) => {
    const state = await fixture(page, 'settings')
    await (await settingsTrigger(page)).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('tab', { name: /Hooks/ }).click()
    await dialog.getByRole('button', { name: 'Advanced · edit raw JSON' }).click()
    const raw = dialog.getByLabel('hooks.json')
    await raw.fill(invalid.draft)
    await dialog.getByRole('button', { name: 'Apply raw' }).click()
    await expect(dialog).toContainText(invalid.error)
    await expect(raw).toHaveValue(invalid.draft)
    await expect(dialog.getByRole('button', { name: 'Apply raw' })).toBeVisible()
    expect(state.count('PUT', '/api/workspaces/w/hooks')).toBe(0)
  })
}

test('Agents, MCP, and Secrets expose destructive failures and explicit recovery requests', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: /Agents/ }).click()
  await dialog.getByRole('button', { name: /fixture-agent/ }).click()
  // The control names its target, matching the Secrets panel's `Delete FIXTURE_SECRET`.
  await dialog.getByRole('button', { name: 'Delete fixture-agent' }).click()
  await dialog.getByRole('button', { name: 'Delete definition' }).click()
  await expect(dialog).toContainText('agent delete refused')
  expect(state.count('DELETE', '/api/workspaces/w/agents/fixture-agent')).toBe(1)
  await dialog.getByRole('button', { name: 'Delete definition' }).click()
  await expect.poll(() => state.count('DELETE', '/api/workspaces/w/agents/fixture-agent')).toBe(2)

  await dialog.getByRole('tab', { name: /MCP/ }).click()
  // Enabling starts a process as the user, so it asks first; the ask alone
  // sends nothing.
  await dialog.getByRole('button', { name: 'Enable' }).click()
  expect(state.count('POST', '/api/workspaces/w/mcp/fixture-mcp/enable')).toBe(0)
  await dialog.getByRole('button', { name: 'Start server' }).click()
  await expect(dialog).toContainText('MCP enable refused')
  await dialog.getByRole('button', { name: 'Enable' }).click()
  await dialog.getByRole('button', { name: 'Start server' }).click()
  await expect.poll(() => state.count('POST', '/api/workspaces/w/mcp/fixture-mcp/enable')).toBe(2)

  await dialog.getByRole('tab', { name: /Secrets/ }).click()
  await dialog.getByRole('button', { name: 'Delete FIXTURE_SECRET' }).click()
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect(dialog).toContainText('secret delete refused')
  await dialog.getByRole('button', { name: 'Delete permanently' }).click()
  await expect.poll(() => state.count('DELETE', '/api/workspaces/w/secrets/FIXTURE_SECRET')).toBe(2)
  expect(state.requests().filter(request => request.method === 'DELETE' && /agents|secrets/.test(request.path)).every(request => request.body === null)).toBe(true)
})

test('Skills and Memory 409 conflicts require explicit reload or overwrite', async ({ page }) => {
  const state = await fixture(page, 'settings')
  await (await settingsTrigger(page)).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: /Skills/ }).click()
  await dialog.getByRole('button', { name: 'Edit' }).click()
  await dialog.getByLabel('SKILL.md content').fill('local skill body')
  await dialog.getByRole('button', { name: 'Save skill' }).click()
  await expect(dialog.getByRole('button', { name: 'Reload server version' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Overwrite anyway' })).toBeVisible()
  expect(state.count('PUT', '/api/workspaces/w/skills/fixture-skill')).toBe(1)
  await dialog.getByRole('button', { name: 'Overwrite anyway' }).click()
  await expect.poll(() => state.count('PUT', '/api/workspaces/w/skills/fixture-skill')).toBe(2)

  await dialog.getByRole('tab', { name: /Memory/ }).click()
  await dialog.getByRole('button', { name: /Fixture memory/ }).click()
  await dialog.getByLabel('Body').fill('local body')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByRole('button', { name: 'Reload server version' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Overwrite anyway' })).toBeVisible()
  expect(state.count('PATCH', '/api/workspaces/w/memory/fixture-memory')).toBe(1)
})

const transcriptOf = (page: Page) => page.getByRole('region', { name: 'Conversation transcript' })

test('a running tool shows inline as one running row without an output disclosure', async ({ page }) => {
  const state = await fixture(page, 'running-tool')
  const before = state.requests().filter((request) => request.method !== 'GET').length
  const row = transcriptOf(page).getByRole('button', { name: /Bash/ })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Running')
  await row.click()
  await expect(transcriptOf(page).getByText('Output', { exact: true })).toHaveCount(0)
  expectNoMutationRequests(state, before)
})

test('a completed tool row expands to recorded output without requests', async ({ page }) => {
  const state = await fixture(page, 'completed-tool')
  const before = state.requests().filter((request) => request.method !== 'GET').length
  const row = transcriptOf(page).getByRole('button', { name: /Bash/ })
  await expect(row).toContainText('Succeeded')
  // The command and what came back are on the row itself, before any click.
  await expect(row).toContainText('npm test')
  await expect(row).toContainText('recorded output')
  await row.click()
  await expect(transcriptOf(page).locator('pre').last()).toContainText('recorded output')
  await row.click()
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await expect(transcriptOf(page).locator('pre')).toHaveCount(0)
  expectNoMutationRequests(state, before)
})

test('a recovered tool outcome is unknown and never successful without requests', async ({ page }) => {
  const state = await fixture(page, 'recovered-tool')
  const before = state.requests().filter((request) => request.method !== 'GET').length
  const row = transcriptOf(page).getByRole('button', { name: /Bash/ })
  await expect(row).toContainText('Outcome unknown')
  await expect(row).not.toContainText('Succeeded')
  await row.click()
  await expect(transcriptOf(page).getByRole('note')).toContainText('Outcome unknown — the host restarted before this result was recorded.')
  expectNoMutationRequests(state, before)
})

test('a delegation row opens its existing child conversation route', async ({ page }) => {
  await fixture(page, 'delegation')
  await transcriptOf(page).getByRole('button', { name: /Delegated to explorer/ }).click()
  await transcriptOf(page).getByRole('button', { name: /Open conversation/ }).click()
  await expect(page).toHaveURL('/workspaces/w/sessions/child')
})

test('no tool or delegation renders no activity rows', async ({ page }) => {
  const state = await fixture(page, 'no-work')
  const before = state.requests().filter((request) => request.method !== 'GET').length
  await expect(transcriptOf(page).locator('button[aria-expanded]')).toHaveCount(0)
  await expect(page.locator('[data-workbench-surface]')).toHaveCount(0)
  expectNoMutationRequests(state, before)
})

test('Artifacts projects existing event data without any additional API request', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'artifacts')
  await openWorkbench(page)
  // The composer's context meter reads the manifest once the conversation
  // settles, whichever workbench view is showing.
  await expect.poll(() => state.count('GET', `${SESSION_PATH}/manifest`)).toBe(1)
  await selectWorkbenchView(page, 'Context')
  const before = state.requests().length
  const workbench = await selectWorkbenchView(page, 'Artifacts')
  const list = workbench.getByRole('list', { name: 'Recorded artifacts' })
  await expect(list).toContainText('File reference')
  await expect(list).toContainText('C:/fixture/project/README.md')
  await expect(list).toContainText('Command record')
  await expect(list).toContainText('npm test')
  await expect(list).toContainText('failed')
  await expect(list).toContainText('custom output')
  await expect(list).toContainText('pending')
  await expect(list).toContainText('Outcome unknown — the host restarted before this result was recorded.')
  await expect(list).not.toContainText(/file content|diff|changed files|terminal/i)
  await page.waitForTimeout(750)
  expect(state.requests()).toHaveLength(before)
  await page.reload()
  // The opened views and the selected one are remembered; the new page load
  // reads the manifest once more for the meter, never once per view.
  const reopened = await openWorkbench(page)
  await expect(reopened.getByRole('button', { name: 'Artifacts', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(reopened.getByRole('button', { name: 'Context', exact: true })).toBeVisible()
  await expect.poll(() => state.count('GET', `${SESSION_PATH}/manifest`)).toBe(2)
  await page.waitForTimeout(750)
  expect(state.count('GET', `${SESSION_PATH}/manifest`)).toBe(2)
})

test('Open in workbench reads the current project file, never the recorded output', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'artifacts')
  const workbench = await selectWorkbenchView(page, 'Artifacts')
  await workbench.getByRole('button', { name: 'Open in workbench' }).first().click()
  await expect(workbench.getByRole('region', { name: 'Contents of README.md' })).toContainText('export const answer = 42')
  // Dev StrictMode may mount the viewer twice; every read is a GET of the live file.
  expect(state.count('GET', '/api/workspaces/w/projects/p/file')).toBeGreaterThan(0)
  expect(state.requests().filter((request) => request.method !== 'GET')).toHaveLength(0)
})

test('a tool row states its window and opens the workbench at the lines it read', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'artifacts')
  // The window is on the row: nothing about it needs a click to be read.
  const row = transcriptOf(page).getByRole('button', { name: /README\.md:30-35/ })
  await expect(row).toHaveAttribute('aria-expanded', 'false')
  await row.click()
  await transcriptOf(page).getByRole('button', { name: /Open .* in workbench/ }).click()
  const contents = page.getByRole('region', { name: 'Contents of README.md' })
  await expect(contents).toContainText('export const answer = 42')
  // The viewer lands on the recorded window rather than the top of the file.
  await expect.poll(async () => contents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  expect(state.requests().filter((request) => request.method !== 'GET')).toHaveLength(0)
})

test('Context manifest is read once per settled conversation, not once per workbench view', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 })
  const state = await fixture(page, 'no-work')
  await expect.poll(() => state.count('GET', `${SESSION_PATH}/manifest`)).toBe(1)
  await selectWorkbenchView(page, 'Context')
  await selectWorkbenchView(page, 'Artifacts')
  const afterViews = state.requests().length
  await page.waitForTimeout(750)
  expect(state.requests()).toHaveLength(afterViews)
  await selectWorkbenchView(page, 'Context')
  await page.waitForTimeout(750)
  expect(state.count('GET', `${SESSION_PATH}/manifest`)).toBe(1)
})

test('manifest stays fail-closed beyond the delay when the active workspace is null', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'no-workspace')
  await page.waitForTimeout(750)
  expect(state.requests().filter(request => request.path.endsWith('/manifest'))).toHaveLength(0)
})

test('manifest stays fail-closed beyond the delay when the current conversation is null', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'new-conversation-success')
  await selectWorkbenchView(page, 'Context')
  await page.waitForTimeout(750)
  expect(state.requests().filter(request => request.path.endsWith('/manifest'))).toHaveLength(0)
})

test('manifest stays fail-closed beyond the delay while the session is running', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const state = await fixture(page, 'running-tool')
  await selectWorkbenchView(page, 'Context')
  await page.waitForTimeout(750)
  expect(state.count('GET', `${SESSION_PATH}/manifest`)).toBe(0)
})

for (const width of [320, 375, 768, 1024, 1440]) {
  test(`workbench views switch without requests and keep focus contained at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const state = await fixture(page, 'artifacts')
    const workbench = await openWorkbench(page)
    // Artifacts is not in the strip until it is opened from the nav picker.
    await workbench.getByRole('button', { name: 'Open a view' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Artifacts', exact: true }).click()
    const artifacts = workbench.getByRole('button', { name: 'Artifacts', exact: true })
    await expect(artifacts).toHaveAttribute('aria-pressed', 'true')
    const before = state.requests().length
    await page.waitForTimeout(750)
    expect(state.requests()).toHaveLength(before)
    if (width < 1280) {
      for (let step = 0; step < 12; step += 1) await page.keyboard.press('Tab')
      await expect.poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label'))).toBe('Workbench')
    }
  })
}

for (const width of REQUIRED_WIDTHS) {
  test(`approval card and composer stay in flow below the transcript at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    const state = await fixture(page, 'approval')
    const dock = page.getByRole('region', { name: 'Conversation composer' })
    const transcript = transcriptOf(page)
    await expect(dock).toBeVisible()
    await expect(page.locator('[data-composer-input]')).toBeVisible()
    const allowOnce = page.getByRole('button', { name: 'Allow once' })
    await allowOnce.scrollIntoViewIfNeeded()
    const [dockBox, transcriptBox, actionBox, composerBox] = await Promise.all([
      dock.boundingBox(),
      transcript.boundingBox(),
      allowOnce.boundingBox(),
      page.locator('form:has([data-composer-input])').boundingBox(),
    ])
    // The dock is a sibling below the scroller, never overlapping it.
    expect(transcriptBox!.y + transcriptBox!.height).toBeLessThanOrEqual(dockBox!.y + 1)
    expect(dockBox!.y + dockBox!.height).toBeLessThanOrEqual(800 + 1)
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(composerBox!.y + 1)

    // Opening a conversation lands on its latest row, fully visible above the dock.
    const lastRow = transcript.getByText('Approval context 14')
    await expect.poll(async () => {
      const box = await lastRow.boundingBox()
      return box !== null && box.y + box.height <= transcriptBox!.y + transcriptBox!.height + 2
    }).toBe(true)

    await allowOnce.dblclick({ delay: 5 })
    await expect.poll(() => state.count('POST', '/api/approvals/approval-1')).toBe(1)
  })
}

test('a late SSE snapshot still opens the conversation at its final row', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 })
  await fixture(page, 'late-transcript')
  const transcript = transcriptOf(page)
  const last = transcript.getByText('Late transcript item 12')
  await expect(last).toBeVisible()
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(4)
  const [transcriptBox, lastBox] = await Promise.all([transcript.boundingBox(), last.boundingBox()])
  expect(lastBox!.y + lastBox!.height).toBeLessThanOrEqual(transcriptBox!.y + transcriptBox!.height + 2)
})

test('running Enter queues once and Stop uses the existing endpoints', async ({ page }) => {
  const state = await fixture(page, 'running-tool')
  const input = page.locator('[data-composer-input]')
  await input.fill('queue this follow-up')
  await input.press('Enter')
  await expect.poll(() => state.count('POST', `${SESSION_PATH}/messages`)).toBe(1)
  expect(state.requests().find((request) => request.method === 'POST' && request.path === `${SESSION_PATH}/messages`)?.body).toMatchObject({ content: 'queue this follow-up' })
  await page.getByRole('button', { name: 'Stop work' }).click()
  await expect.poll(() => state.count('POST', `${SESSION_PATH}/stop`)).toBe(1)
})

test('reconnect retains running state, editable draft, queue and stop controls across durable reload', async ({ page }) => {
  const state = await fixture(page, 'reconnect')
  const input = page.locator('[data-composer-input]')
  await input.fill('draft retained during reconnect')
  await expect(page.getByRole('status', { name: 'Work status' })).toContainText('Working')
  await expect(page.getByRole('status', { name: 'Work status' })).toContainText('does not mean work has stopped')
  await expect(transcriptOf(page).getByRole('button', { name: /Bash/ })).toContainText('Running')
  await expect(transcriptOf(page).getByRole('button', { name: /Bash/ })).not.toContainText(/Succeeded|Failed/)
  await expect(input).toHaveText('draft retained during reconnect')
  await expect(input).toBeEditable()
  await expect(page.getByRole('button', { name: 'Stop work' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Queue message' })).toBeVisible()
  expect(state.count('POST', `${SESSION_PATH}/messages`)).toBe(0)
  expect(state.count('POST', `${SESSION_PATH}/stop`)).toBe(0)
  await page.reload()
  await expect(page.getByRole('button', { name: /^(Open|Close) workbench$/ })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('status', { name: 'Work status' })).toContainText('Working')
  await expect(transcriptOf(page).getByRole('button', { name: /Bash/ })).toContainText('Running')
  await expect(transcriptOf(page).getByRole('button', { name: /Bash/ })).not.toContainText(/Succeeded|Failed/)
  await expect(page.getByRole('button', { name: 'Stop work' })).toBeVisible()
  expect(state.count('POST', `${SESSION_PATH}/messages`)).toBe(0)
  expect(state.count('POST', `${SESSION_PATH}/stop`)).toBe(0)
})

test('immediate successful first send atomically migrates and clears the target draft', async ({ page }) => {
  const state = await fixture(page, 'new-conversation-success')
  const input = page.locator('[data-composer-input]')
  const content = 'fast accepted first draft'
  await input.fill(content)
  await input.press('Enter')
  await expect(page).toHaveURL('/workspaces/w/sessions/created')
  await expect(input).toHaveText('')
  await expect.poll(() => state.count('POST', '/api/workspaces/w/sessions')).toBe(1)
  await expect.poll(() => state.count('POST', '/api/workspaces/w/sessions/created/messages')).toBe(1)
  const sent = state.requests().find((request) => request.method === 'POST' && request.path === '/api/workspaces/w/sessions/created/messages')
  expect(sent?.body).toMatchObject({ content })
  expect((sent?.body as { clientRequestId?: unknown })?.clientRequestId).toEqual(expect.any(String))
})

test('first-send failure keeps the draft in the created conversation and sends once', async ({ page }) => {
  const state = await fixture(page, 'new-conversation')
  const input = page.locator('[data-composer-input]')
  await input.fill('preserve this first draft')
  await input.press('Enter')
  await expect(page).toHaveURL('/workspaces/w/sessions/created')
  await expect(page.getByRole('alert')).toContainText('Your draft has been kept')
  await expect(input).toHaveText('preserve this first draft')
  await expect.poll(() => state.count('POST', '/api/workspaces/w/sessions')).toBe(1)
  await expect.poll(() => state.count('POST', '/api/workspaces/w/sessions/created/messages')).toBe(1)
})

test('nested Escape closes a menu inside the navigation drawer before the drawer', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 })
  await fixture(page, 'no-work')
  await page.getByRole('button', { name: 'Open sidebar' }).click()
  const drawer = page.getByRole('dialog', { name: 'Conversation navigation' })
  await expect(drawer).toBeVisible()
  const trigger = drawer.getByRole('button', { name: 'Options for Fixture conversation' })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Options for Fixture conversation' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(drawer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(drawer).toHaveCount(0)
})

test('Escape closes the composer mode menu and returns focus to its trigger', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 })
  await fixture(page, 'no-work')
  const trigger = page.getByRole('button', { name: 'Workspace mode (next tool gate and request)' })
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Workspace mode (next tool gate and request)' })
  await expect(menu).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

async function expectAxeClean(page: Page, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...AXE_TAGS])
  if (include !== undefined) builder = builder.include(include)
  const result = await builder.analyze()
  expect(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) }))).toEqual([])
}

test('axe gates shell, drawers, Context, Artifacts, approval, and every settings section', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await fixture(page, 'approval')
  await expectAxeClean(page)
  await expectAxeClean(page, '[aria-label="Pending approvals"]')
  const workbench = await openWorkbench(page)
  await expectAxeClean(page, '[aria-label="Workbench"]')
  await workbench.getByRole('button', { name: 'Open a view' }).click()
  // The picker fades in; axe reads the mid-animation opacity as low contrast.
  await page.waitForTimeout(400)
  await expectAxeClean(page, '[role="menu"][aria-label="Open a view"]')
  await page.getByRole('menuitem', { name: 'Context', exact: true }).click()
  await expectAxeClean(page, '[aria-label="Workbench"]')
  await selectWorkbenchView(page, 'Artifacts')
  await expectAxeClean(page, '[aria-label="Workbench"]')
  await page.keyboard.press('Escape')

  await page.setViewportSize({ width: 390, height: 900 })
  await page.getByRole('button', { name: 'Open sidebar' }).click()
  await expectAxeClean(page, '[role="dialog"][aria-label="Conversation navigation"]')
  await page.keyboard.press('Escape')

  const settingsContext = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const settingsPage = await settingsContext.newPage()
  await fixture(settingsPage, 'settings')
  await (await settingsTrigger(settingsPage)).click()
  const dialog = settingsPage.getByRole('dialog', { name: 'Settings' })
  for (const label of ['Providers', 'Projects', 'Skills', 'Memory', 'Agents', 'MCP', 'Hooks', 'Secrets']) {
    await dialog.getByRole('tab', { name: new RegExp(label) }).click()
    await expectAxeClean(settingsPage, '[role="dialog"][aria-label="Settings"]')
  }
  await settingsContext.close()
})

test('reduced motion collapses nonessential motion while running status remains visible', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await fixture(page, 'running-tool')
  const samples = page.locator('.animate-spin-slow, .text-shimmer, button').filter({ visible: true })
  await expect.poll(async () => samples.count()).toBeGreaterThan(0)
  for (const sample of await samples.all()) {
    const timing = await sample.evaluate(element => {
      const style = getComputedStyle(element)
      return { animation: style.animationDuration, transition: style.transitionDuration }
    })
    const durations = (value: string): number[] => value.split(',').map(part => part.trim()).filter(Boolean).map(part => part.endsWith('ms') ? Number.parseFloat(part) / 1000 : Number.parseFloat(part))
    expect([...durations(timing.animation), ...durations(timing.transition)].every(value => value <= 0.02)).toBe(true)
  }
  await expect(page.getByRole('status', { name: 'Work status' })).toContainText('Working')
  await expect(transcriptOf(page).getByRole('button', { name: /Bash/ })).toContainText('Running')
  await expect(page.getByRole('button', { name: 'Stop work' })).toBeVisible()
})

test('coarse pointer targets meet the minimum on header, composer, approval, context and settings', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true })
  const page = await context.newPage()
  await fixture(page, 'approval')
  for (const selector of ['header button', 'form:has([data-composer-input]) button', '[aria-label="Pending approvals"] button']) {
    for (const control of await page.locator(selector).filter({ visible: true }).all()) {
      const box = await control.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44)
    }
  }
  await openWorkbench(page)
  for (const control of await page.getByRole('dialog', { name: 'Workbench' }).locator('button').filter({ visible: true }).all()) {
    const box = await control.boundingBox(); expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
  }
  await page.keyboard.press('Escape')
  await (await settingsTrigger(page)).click()
  for (const control of await page.getByRole('dialog', { name: 'Settings' }).locator('button, [role="combobox"]').filter({ visible: true }).all()) {
    const box = await control.boundingBox(); expect(box?.height ?? 0, await control.evaluate((element) => element.outerHTML.slice(0, 160))).toBeGreaterThanOrEqual(44)
  }
  await context.close()
})

test('captures the deterministic screenshot matrix', async ({ browser }) => {
  test.setTimeout(240_000)
  mkdirSync(screenshotRoot, { recursive: true })
  const openContext = async (page: Page): Promise<void> => { await selectWorkbenchView(page, 'Context') }
  const states: readonly { readonly name: string; readonly fixture: FixtureState; readonly prepare?: (page: Page) => Promise<void> }[] = [
    { name: 'empty-new-conversation', fixture: 'new-conversation-success' },
    { name: 'populated-transcript-tool', fixture: 'completed-tool' },
    { name: 'running-reconnect-queued-follow-up', fixture: 'reconnect', prepare: async page => { await page.locator('[data-composer-input]').fill('Queued follow-up draft') } },
    { name: 'pending-approval', fixture: 'approval' },
    { name: 'context-tab', fixture: 'no-work', prepare: openContext },
    { name: 'artifacts-empty', fixture: 'no-work', prepare: async page => { await selectWorkbenchView(page, 'Artifacts') } },
    { name: 'artifacts-populated', fixture: 'artifacts', prepare: async page => { await selectWorkbenchView(page, 'Artifacts') } },
    { name: 'settings-dirty', fixture: 'settings', prepare: async page => { await (await settingsTrigger(page)).click(); await (await providerName(page.getByRole('dialog', { name: 'Settings' }))).fill('Dirty provider draft') } },
    { name: 'settings-conflict', fixture: 'settings', prepare: async page => { const dialog = page.getByRole('dialog', { name: 'Settings' }); await (await settingsTrigger(page)).click(); await expect(dialog).toBeVisible(); if ((page.viewportSize()?.width ?? 0) > 600) await dialog.getByRole('tab', { name: /Skills/ }).click(); else { await page.getByRole('combobox', { name: 'Settings section' }).click(); await page.getByRole('option', { name: 'Skills' }).click() } await dialog.getByRole('button', { name: 'Edit' }).click(); await dialog.getByLabel('SKILL.md content').fill('local conflict draft'); await dialog.getByRole('button', { name: 'Save skill' }).click(); await expect(dialog.getByRole('button', { name: 'Overwrite anyway' })).toBeVisible() } },
  ]
  for (const width of REQUIRED_WIDTHS) {
    for (const state of states) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
      const page = await context.newPage()
      await fixture(page, state.fixture)
      await state.prepare?.(page)
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' })
      await page.screenshot({ path: `${screenshotRoot}/${width}-${state.name}.png`, fullPage: false, animations: 'disabled' })
      await context.close()
    }
  }
})
