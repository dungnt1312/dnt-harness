import { describe, expect, it, vi } from 'vitest'
import { getSessionMode, setSessionMode } from './api.ts'

/** Every call goes through apiFetch: same-origin credentials, a Headers bag. */
type Call = [string, RequestInit]
const callOf = (mock: ReturnType<typeof vi.fn>, index: number): Call => mock.mock.calls[index] as unknown as Call

describe('session mode API', () => {
  it('reads one conversation mode at the session route', async () => {
    const selection = { modeId: 'full-access', name: 'Full access', revision: 2, source: 'session' } as const
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(selection)))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(getSessionMode('workspace / 1', 'session / 1')).resolves.toEqual(selection)
      const [url, init] = callOf(fetchMock, 0)
      expect(url).toBe('/api/workspaces/workspace%20%2F%201/sessions/session%20%2F%201/mode')
      expect(init.credentials).toBe('same-origin')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('puts the conversation mode selection to the session route', async () => {
    const selection = { modeId: 'plan', name: 'Plan', revision: 3, source: 'session' } as const
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(selection)))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(setSessionMode('w', 's', 'plan')).resolves.toEqual(selection)
      const [url, init] = callOf(fetchMock, 0)
      expect(url).toBe('/api/workspaces/w/sessions/s/mode')
      expect(init.method).toBe('PUT')
      expect(new Headers(init.headers).get('content-type')).toBe('application/json')
      expect(init.body).toBe(JSON.stringify({ modeId: 'plan' }))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
