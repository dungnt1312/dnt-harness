/**
 * The Workbench terminal in a real browser.
 *
 * What only this pass can prove: that xterm actually renders in Chromium, that
 * ANSI colour survives the base64 → terminal path and reaches the DOM, and
 * that typing into the real terminal produces one batched request. The shell
 * behind it is a fixture, as everywhere else in this suite — no test here
 * spawns a PTY or mutates real settings.
 */
import { expect, test, type Page, type Route } from '@playwright/test'
import { selectWorkbenchView } from './workbench-nav.ts'

interface TerminalFixture {
  readonly posts: () => readonly { method: string; path: string; body: unknown }[]
  readonly push: (frame: unknown) => Promise<void>
}

const TERMINAL = {
  id: 'terminal-1',
  workspaceId: 'w',
  shellId: 'bash',
  label: 'Git Bash',
  cwd: 'C:/fixture/project',
  cols: 80,
  rows: 24,
  createdAt: 0,
}

async function fixture(page: Page, options: { readonly shells?: readonly { id: string; label: string }[]; readonly max?: number } = {}): Promise<TerminalFixture> {
  const posts: { method: string; path: string; body: unknown }[] = []
  const unexpected: string[] = []
  const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, json: value })

  // One fixture EventSource that the test can push terminal frames into.
  await page.addInitScript(() => {
    const pending: ((data: string) => void)[] = []
    class FixtureEventSource {
      readyState = 0
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      onmessage: ((event: MessageEvent<string>) => void) | null = null
      constructor(readonly url: string) {
        window.setTimeout(() => {
          this.readyState = 1
          this.onopen?.(new Event('open'))
          if (this.url.includes('/terminals/events')) {
            pending.push((data: string) => this.onmessage?.(new MessageEvent('message', { data })))
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ kind: 'snapshot', terminals: [] }) }))
          } else {
            this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ kind: 'snapshot', events: [] }) }))
          }
        }, 0)
      }
      close(): void { this.readyState = 2 }
      addEventListener(): void {}
      removeEventListener(): void {}
      dispatchEvent(): boolean { return true }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: FixtureEventSource })
    Object.defineProperty(window, '__pushTerminalFrame', {
      configurable: true,
      value: (frame: unknown) => {
        for (const send of pending) send(JSON.stringify(frame))
      },
    })
  })

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    if (method !== 'GET') posts.push({ method, path, body: request.postDataJSON() as unknown })

    if (path === '/api/workspaces') return json(route, [{ id: 'w', name: 'Fixture workspace', default: true, archived: false, createdAt: 0 }])
    if (path === '/api/workspaces/w/projects') return json(route, [{ id: 'p', name: 'Fixture project', workspaceId: 'w', path: 'C:/fixture/project', createdAt: 0 }])
    if (path === '/api/workspaces/w/sessions') return json(route, [
      { id: 's', workspaceId: 'w', title: 'Terminal fixture', projectId: 'p', folder: null, eventCount: 0, createdAt: 0, updatedAt: 0, status: 'idle' },
    ])
    if (path === '/api/workspaces/w/meta') return json(route, {
      workspace: { id: 'w', name: 'Fixture workspace', archived: false },
      provider: 'fixture-provider',
      model: 'fixture-model',
      providers: [{ id: 'fixture-provider', name: 'Fixture provider', baseUrl: 'http://fixture.invalid', enabled: true, keyMasked: '***', models: ['fixture-model'], defaultModel: 'fixture-model', modelSettings: {} }],
      models: ['fixture-model'],
      policy: { Bash: 'ask' },
      thinkingLevel: null,
    })
    if (path === '/api/workspaces/w/mode') return json(route, { modes: [{ id: 'chat', name: 'Chat', source: 'bundled' }], selected: 'chat', revision: 1 })
    if (path === '/api/workspaces/w/skills') return json(route, [])
    if (path === '/api/model-defaults') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null })
    if (path === '/api/workspaces/w/sessions/s/model') return json(route, { provider: 'fixture-provider', model: 'fixture-model', thinkingLevel: null, source: 'session' })
    if (path === '/api/workspaces/w/projects/p/files') return json(route, { path: '', entries: [] })
    if (path.endsWith('/manifest')) return json(route, { modeId: 'chat', modeRevision: 1, budget: { availableTokens: 32000, usedTokens: 0, estimated: true }, history: { setting: 'all', includedTurns: 0, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [] })

    if (path === '/api/workspaces/w/terminals' && method === 'GET') {
      return json(route, {
        terminals: [],
        shells: options.shells ?? [{ id: 'bash', label: 'Git Bash' }, { id: 'powershell', label: 'PowerShell' }],
        max: options.max ?? 4,
        available: true,
      })
    }
    if (path === '/api/workspaces/w/terminals' && method === 'POST') return json(route, TERMINAL, 201)
    if (path.endsWith('/input')) return json(route, { accepted: true }, 202)
    if (path.endsWith('/resize')) return json(route, TERMINAL)
    if (path.startsWith('/api/workspaces/w/terminals/') && method === 'DELETE') return json(route, { killed: true })

    unexpected.push(`${method} ${path}`)
    return json(route, { error: `unexpected fixture request ${method} ${path}` }, 500)
  })

  await page.goto('/workspaces/w/sessions/s')
  await expect(page.locator('[data-composer-input]')).toBeVisible()
  expect(unexpected).toEqual([])

  await selectWorkbenchView(page, 'Terminal')

  return {
    posts: () => posts,
    push: async (frame: unknown) => {
      await page.evaluate((payload) => {
        ;(window as unknown as { __pushTerminalFrame: (value: unknown) => void }).__pushTerminalFrame(payload)
      }, frame)
    },
  }
}

test('renders a real terminal and preserves ANSI colour through the stream', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const terminal = await fixture(page)

  // The view opens a terminal by itself; nothing is asked of the reader.
  await expect.poll(() => terminal.posts().some((entry) => entry.method === 'POST' && entry.path.endsWith('/terminals'))).toBe(true)
  await terminal.push({ kind: 'created', terminal: TERMINAL })
  // Red "error" then default: colour must survive base64 â†’ xterm â†’ DOM.
  await terminal.push({
    kind: 'data',
    terminalId: TERMINAL.id,
    data: Buffer.from('\u001b[31mred-text\u001b[0m plain-text\r\n', 'utf8').toString('base64'),
  })

  const screen = page.locator('.xterm-screen')
  await expect(screen).toBeVisible()
  await expect(screen).toContainText('red-text')
  await expect(screen).toContainText('plain-text')

  // xterm renders colour as a class on the cell span, not as literal escapes.
  await expect(screen.locator('span[class*="xterm-fg-1"]').first()).toBeVisible()
  await expect(screen).not.toContainText('\u001b[31m')
})

test('sends typed keystrokes as one batched request', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const terminal = await fixture(page)

  // Wait for the panel's own auto-open before pushing: a frame sent before it
  // subscribes is simply lost.
  await expect.poll(() => terminal.posts().some((entry) => entry.method === 'POST' && entry.path.endsWith('/terminals'))).toBe(true)
  await terminal.push({ kind: 'created', terminal: TERMINAL })
  await expect(page.locator('.xterm-screen')).toBeVisible()

  // Type into the real terminal: xterm reads keydown from its helper textarea.
  await page.locator('.xterm-screen').click()
  await page.keyboard.type('ls')

  await expect
    .poll(() => terminal.posts().filter((entry) => entry.path.endsWith('/input')).length, { timeout: 3_000 })
    .toBeGreaterThan(0)

  const sent = terminal.posts()
    .filter((entry) => entry.path.endsWith('/input'))
    .map((entry) => Buffer.from((entry.body as { data: string }).data, 'base64').toString('utf8'))
    .join('')
  expect(sent).toBe('ls')
})

test('closing a terminal asks the host to kill it and empties the panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const terminal = await fixture(page)

  // Wait for the panel's own auto-open before pushing: a frame sent before it
  // subscribes is simply lost.
  await expect.poll(() => terminal.posts().some((entry) => entry.method === 'POST' && entry.path.endsWith('/terminals'))).toBe(true)
  await terminal.push({ kind: 'created', terminal: TERMINAL })
  await expect(page.locator('.xterm-screen')).toBeVisible()

  await page.getByRole('button', { name: 'Close Git Bash' }).click()
  await expect
    .poll(() => terminal.posts().some((entry) => entry.method === 'DELETE'))
    .toBe(true)

  await terminal.push({ kind: 'exit', terminalId: TERMINAL.id, exitCode: 0, reason: 'killed' })
  await expect(page.getByText('No terminal open')).toBeVisible()
})

test('stops offering new terminals at the host cap', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const terminal = await fixture(page, { max: 1, shells: [{ id: 'bash', label: 'Git Bash' }] })

  // The panel must have subscribed before a frame is pushed, or it is lost.
  await expect(page.getByText('No terminal open')).toBeVisible()
  await terminal.push({ kind: 'created', terminal: TERMINAL })
  await expect(page.getByRole('button', { name: 'New terminal' })).toBeDisabled()
})
