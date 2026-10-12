// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginMcpOAuth, completeMcpOAuth, getMcpServer, listMcpServers, McpOAuthError, revokeMcpOAuth, upsertMcpServer } from '../../lib/api.ts'
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
  upsertMcpServer: vi.fn(async () => ({ saved: 'remote', enabled: false })),
  deleteMcpServer: vi.fn(async () => ({ deleted: 'remote' })),
  importMcpServers: vi.fn(async () => ({ imported: [] })),
  setMcpServerAction: vi.fn(async () => ({ status: 'ready' })),
  beginMcpOAuth: vi.fn(async () => ({ authorizationUrl: 'https://provider.example/authorize?x=1', state: 'state-1' })),
  completeMcpOAuth: vi.fn(async () => ({ connected: true })),
  revokeMcpOAuth: vi.fn(async () => ({ local: 'revoked', remote: 'succeeded' })),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** In-memory BroadcastChannel, so a test can play the callback page. */
class FakeChannel {
  static open = new Set<FakeChannel>()
  onmessage: ((event: MessageEvent) => void) | null = null
  constructor(readonly name: string) { FakeChannel.open.add(this) }
  postMessage(data: unknown): void {
    for (const channel of FakeChannel.open) if (channel !== this && channel.name === this.name) channel.onmessage?.({ data } as MessageEvent)
  }
  close(): void { FakeChannel.open.delete(this) }
}

let host: HTMLDivElement
let root: Root
let opened: Array<{ location: { href: string }; close: () => void; closed: boolean }>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.clearAllMocks()
  FakeChannel.open.clear()
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  opened = []
  vi.stubGlobal('open', vi.fn(() => {
    const tab = { location: { href: '' }, closed: false, close: () => { tab.closed = true } }
    opened.push(tab)
    return tab
  }))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const buttons = (): HTMLButtonElement[] => [...document.body.querySelectorAll<HTMLButtonElement>('button')]
const button = (name: string): HTMLButtonElement => {
  const found = buttons().find((node) => node.textContent === name || node.getAttribute('aria-label') === name)
  if (found === undefined) throw new Error(`no button "${name}" in: ${buttons().map((node) => node.textContent).join(' | ')}`)
  return found
}
const input = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const found = [...document.body.querySelectorAll('label')].find((node) => node.textContent === label)?.control
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement)) throw new Error(`no field "${label}"`)
  return found
}
function type(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
const settle = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const saveButton = (): HTMLButtonElement => buttons().filter((node) => node.textContent === 'Add server').at(-1)!

const oauthRow = (state: 'connected' | 'needs_sign_in' | 'not_connected', extra: Record<string, unknown> = {}) => ({
  name: 'remote', transport: 'http', enabled: true, status: state === 'connected' ? 'ready' : 'failed', breakerOpenUntil: null,
  oauth: { state, ...extra },
})

async function render(): Promise<void> {
  await act(async () => root.render(<McpPanel workspaceId="ws" />))
  await settle()
}

describe('MCP panel OAuth', () => {
  it('saves an HTTP server set to OAuth as managed_oauth with no client', async () => {
    await render()
    await act(async () => button('Add server').click())
    await act(async () => button('Streamable HTTP').click())
    await act(async () => { type(input('Server name'), 'linear'); type(input('URL'), 'https://mcp.linear.app/mcp') })
    await act(async () => button('OAuth').click())
    expect(() => input('Bearer token reference')).toThrow()
    await act(async () => saveButton().click())
    await settle()
    expect(upsertMcpServer).toHaveBeenCalledWith('ws', 'linear', expect.objectContaining({
      transport: 'http', url: 'https://mcp.linear.app/mcp',
      auth: { type: 'managed_oauth', provider: 'mcp.linear.app', resource: 'https://mcp.linear.app/mcp' },
    }))
  })

  it('adds a manual client from the OAuth client section', async () => {
    await render()
    await act(async () => button('Add server').click())
    await act(async () => button('Streamable HTTP').click())
    await act(async () => { type(input('Server name'), 'github'); type(input('URL'), 'https://api.githubcopilot.com/mcp/') })
    await act(async () => button('OAuth').click())
    await act(async () => button('OAuth client · only for providers without registration').click())
    await act(async () => { type(input('Client ID'), 'Iv1.abc'); type(input('Client secret reference'), '${GITHUB_OAUTH_SECRET}') })
    await act(async () => saveButton().click())
    await settle()
    expect(upsertMcpServer).toHaveBeenCalledWith('ws', 'github', expect.objectContaining({
      auth: {
        type: 'managed_oauth', provider: 'api.githubcopilot.com', resource: 'https://api.githubcopilot.com/mcp/',
        clientId: 'Iv1.abc', clientSecret: '${GITHUB_OAUTH_SECRET}', tokenEndpointAuth: 'client_secret_post',
      },
    }))
  })

  it('refuses a plain client secret', async () => {
    await render()
    await act(async () => button('Add server').click())
    await act(async () => button('Streamable HTTP').click())
    await act(async () => { type(input('Server name'), 'github'); type(input('URL'), 'https://api.githubcopilot.com/mcp/') })
    await act(async () => button('OAuth').click())
    await act(async () => button('OAuth client · only for providers without registration').click())
    await act(async () => { type(input('Client ID'), 'Iv1.abc'); type(input('Client secret reference'), 'plain-secret') })
    expect(saveButton().disabled).toBe(true)
  })

  it('drops OAuth entirely when switched back to no authentication', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('connected')] as never)
    vi.mocked(getMcpServer).mockResolvedValueOnce({
      name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp', enabled: true, timeoutMs: 15000,
      auth: { type: 'managed_oauth', provider: 'mcp.example.com', resource: 'https://mcp.example.com/mcp', clientId: 'old' },
    })
    await render()
    await act(async () => button('Edit remote').click())
    expect(button('OAuth').getAttribute('aria-pressed')).toBe('true')
    await act(async () => button('None').click())
    await act(async () => button('Save server').click())
    await settle()
    const saved = vi.mocked(upsertMcpServer).mock.calls[0]?.[2] as Record<string, unknown>
    expect(saved['auth']).toBeUndefined()
  })

  it('shows the OAuth state on each row', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([
      oauthRow('connected'),
      { ...oauthRow('needs_sign_in', { missingScope: 'write' }), name: 'scoped' },
      { ...oauthRow('not_connected'), name: 'fresh' },
    ] as never)
    await render()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Connected')
    expect(text).toContain('Needs sign-in')
    expect(text).toContain('needs scope write')
    expect(text).toContain('Not connected')
    expect(button('Connect fresh')).toBeTruthy()
    expect(button('Reconnect scoped')).toBeTruthy()
  })

  it('opens the sign-in tab and completes when the callback page reports back', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('not_connected')] as never)
    await render()
    await act(async () => button('Connect remote').click())
    await settle()
    expect(beginMcpOAuth).toHaveBeenCalledWith('ws', 'remote', [])
    expect(opened).toHaveLength(1)
    expect(opened[0]?.location.href).toBe('https://provider.example/authorize?x=1')
    expect(document.body.textContent).toContain('Waiting for sign-in')

    // The callback page posts on the same channel name.
    await act(async () => { new FakeChannel('dnt-harness-mcp-oauth').postMessage({ type: 'mcp-oauth', state: 'other-state' }) })
    expect(completeMcpOAuth).not.toHaveBeenCalled()
    await act(async () => { new FakeChannel('dnt-harness-mcp-oauth').postMessage({ type: 'mcp-oauth', state: 'state-1' }) })
    await settle()
    expect(completeMcpOAuth).toHaveBeenCalledWith('ws', 'remote', 'state-1')
    expect(document.body.textContent).toContain('remote is connected')
  })

  it('finishes by hand when the channel message never arrives', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('not_connected')] as never)
    await render()
    await act(async () => button('Connect remote').click())
    await settle()
    await act(async () => button('Finish sign-in').click())
    await settle()
    expect(completeMcpOAuth).toHaveBeenCalledWith('ws', 'remote', 'state-1')
  })

  it('asks for the missing scope on Reconnect', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('needs_sign_in', { missingScope: 'write' })] as never)
    await render()
    await act(async () => button('Reconnect remote').click())
    await settle()
    expect(beginMcpOAuth).toHaveBeenCalledWith('ws', 'remote', ['write'])
  })

  it('opens the editor with the client section when the provider needs a client', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('not_connected')] as never)
    vi.mocked(beginMcpOAuth).mockRejectedValueOnce(new McpOAuthError('client_required', 'github.com does not offer client registration.'))
    vi.mocked(getMcpServer).mockResolvedValueOnce({
      name: 'remote', transport: 'http', url: 'https://api.githubcopilot.com/mcp/', enabled: true, timeoutMs: 15000,
      auth: { type: 'managed_oauth', provider: 'api.githubcopilot.com', resource: 'https://api.githubcopilot.com/mcp/' },
    })
    await render()
    await act(async () => button('Connect remote').click())
    await settle()
    await settle()
    expect(opened[0]?.closed).toBe(true)
    expect(input('Client ID')).toBeTruthy()
    expect(document.body.textContent).toContain('does not offer client registration')
  })

  it('disconnects', async () => {
    vi.mocked(listMcpServers).mockResolvedValue([oauthRow('connected')] as never)
    await render()
    await act(async () => button('More actions for remote').click())
    await act(async () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((node) => node.textContent === 'Disconnect OAuth')!.click())
    await settle()
    expect(revokeMcpOAuth).toHaveBeenCalledWith('ws', 'remote')
  })
})
