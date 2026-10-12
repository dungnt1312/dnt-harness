// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { listMcpServers, listSecrets, setSecret, upsertMcpServer } from '../../lib/api.ts'
import { McpPanel } from './McpPanel.tsx'

vi.mock('../../lib/api.ts', () => ({
  HttpError: class HttpError extends Error {
    constructor(readonly status: number, body: string) { super(`HTTP ${status}: ${body}`); this.name = 'HttpError' }
  },
  McpOAuthError: class McpOAuthError extends Error {
    constructor(readonly code: string | undefined, message: string) { super(message); this.name = 'McpOAuthError' }
  },
  listMcpServers: vi.fn(async () => []),
  getMcpServer: vi.fn(async () => ({})),
  upsertMcpServer: vi.fn(async (_ws: string, name: string) => ({ saved: name, enabled: false })),
  deleteMcpServer: vi.fn(async () => ({ deleted: 'x' })),
  importMcpServers: vi.fn(async () => ({ imported: [] })),
  setMcpServerAction: vi.fn(async () => ({ status: 'ready' })),
  beginMcpOAuth: vi.fn(),
  completeMcpOAuth: vi.fn(),
  revokeMcpOAuth: vi.fn(),
  listSecrets: vi.fn(async () => []),
  setSecret: vi.fn(async (_ws: string, key: string) => ({ rotated: key })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}" in: ${buttons().map((node) => node.getAttribute('aria-label') ?? node.textContent).join(' | ')}`)
  return found
}
const input = (label: string): HTMLInputElement => {
  const found = [...document.body.querySelectorAll('label')].find((node) => node.textContent === label)?.control
  if (!(found instanceof HTMLInputElement)) throw new Error(`no field "${label}"`)
  return found
}
function type(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
const text = (): string => document.body.textContent ?? ''

async function openCatalog(): Promise<void> {
  await act(async () => root.render(<McpPanel workspaceId="ws" />))
  await settle()
  await act(async () => button('Browse catalog').click())
  await settle()
}

describe('MCP catalog', () => {
  it('opens grouped by category and filters by what you type', async () => {
    await openCatalog()
    for (const heading of ['Dev & Git', 'Docs & Search', 'Browser & Testing', 'Database', 'Productivity']) expect(text()).toContain(heading)
    expect(button('Install GitHub')).toBeTruthy()
    expect(button('Install Linear')).toBeTruthy()
    await act(async () => type(input('Search the catalog'), 'postgres'))
    expect(button('Install PostgreSQL')).toBeTruthy()
    expect(() => button('Install GitHub')).toThrow()
    expect(text()).not.toContain('Browser & Testing')
    await act(async () => type(input('Search the catalog'), 'zzz-no-match'))
    expect(text()).toContain('Nothing in the catalog matches')
  })

  it('installs a server that needs nothing with one click, saved but not running', async () => {
    await openCatalog()
    await act(async () => button('Install Context7').click())
    await settle()
    expect(setSecret).not.toHaveBeenCalled()
    expect(upsertMcpServer).toHaveBeenCalledTimes(1)
    const [workspace, name, body] = vi.mocked(upsertMcpServer).mock.calls[0]!
    expect(workspace).toBe('ws')
    expect(name).toBe('context7')
    expect(body).toEqual({ transport: 'http', url: 'https://mcp.context7.com/mcp' })
    expect(body).not.toHaveProperty('enabled')
    expect(text()).toContain('Installed context7')
    expect(text()).toContain('Enable')
  })

  it('stores the key it asks for in Secrets before saving the server', async () => {
    await openCatalog()
    await act(async () => button('Install Brave Search').click())
    expect(upsertMcpServer).not.toHaveBeenCalled()
    const field = input('Brave Search API key')
    expect(field.type).toBe('password')
    await act(async () => type(field, 'key-123'))
    await act(async () => button('Install Brave Search').click())
    await settle()
    expect(setSecret).toHaveBeenCalledWith('ws', 'BRAVE_API_KEY', 'key-123')
    expect(vi.mocked(upsertMcpServer).mock.calls[0]?.[2]).toMatchObject({
      transport: 'stdio', command: 'npx', env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    })
    expect(vi.mocked(setSecret).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(upsertMcpServer).mock.invocationCallOrder[0]!)
    expect(text()).not.toContain('key-123')
  })

  it('does not ask again for a secret the workspace already has', async () => {
    vi.mocked(listSecrets).mockResolvedValue([{ name: 'BRAVE_API_KEY' }] as never)
    await openCatalog()
    await act(async () => button('Install Brave Search').click())
    await settle()
    expect(() => input('Brave Search API key')).toThrow()
    expect(setSecret).not.toHaveBeenCalled()
    expect(upsertMcpServer).toHaveBeenCalledTimes(1)
  })

  it('installs without a key when left blank, and says which secret is still missing', async () => {
    await openCatalog()
    await act(async () => button('Install GitHub').click())
    await act(async () => button('Install GitHub').click())
    await settle()
    expect(setSecret).not.toHaveBeenCalled()
    expect(upsertMcpServer).toHaveBeenCalledTimes(1)
    expect(text()).toContain('GITHUB_PERSONAL_ACCESS_TOKEN')
    expect(text()).toContain('Secrets')
  })

  it('will not install until a required value is filled, then writes it into the config', async () => {
    await openCatalog()
    await act(async () => button('Install SQLite').click())
    expect(button('Install SQLite').disabled).toBe(true)
    await act(async () => type(input('Database file'), '/Users/me/app.db'))
    expect(button('Install SQLite').disabled).toBe(false)
    await act(async () => button('Install SQLite').click())
    await settle()
    expect(vi.mocked(upsertMcpServer).mock.calls[0]?.[2]).toMatchObject({ args: ['mcp-server-sqlite', '--db-path', '/Users/me/app.db'] })
  })

  it('picks a free name instead of replacing an existing server', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([{ name: 'git', transport: 'stdio', enabled: true, status: 'ready', breakerOpenUntil: null }] as never)
    await openCatalog()
    expect(text()).toContain('Added')
    await act(async () => button('Install Git').click())
    await settle()
    expect(vi.mocked(upsertMcpServer).mock.calls[0]?.[1]).toBe('git-2')
  })

  it('installs an OAuth server and points to Connect', async () => {
    await openCatalog()
    await act(async () => button('Install Linear').click())
    await settle()
    expect(vi.mocked(upsertMcpServer).mock.calls[0]?.[2]).toMatchObject({
      transport: 'http', url: 'https://mcp.linear.app/mcp',
      auth: { type: 'managed_oauth', provider: 'mcp.linear.app', resource: 'https://mcp.linear.app/mcp' },
    })
    expect(text()).toContain('Connect')
  })

  it('shows what each entry runs and returns to the server list', async () => {
    await openCatalog()
    expect(text()).toContain('uvx mcp-server-git')
    expect(text()).toContain('needs uvx')
    await act(async () => button('Back to servers').click())
    expect(document.querySelector('[aria-label="MCP servers"]') ?? text().includes('No MCP servers yet')).toBeTruthy()
    expect(() => input('Search the catalog')).toThrow()
  })

  it('reports an install failure and leaves the catalog open', async () => {
    vi.mocked(upsertMcpServer).mockRejectedValueOnce(new Error('HTTP 400: bad config'))
    await openCatalog()
    await act(async () => button('Install Context7').click())
    await settle()
    expect(text()).toContain('bad config')
    expect(button('Install Context7')).toBeTruthy()
  })
})
