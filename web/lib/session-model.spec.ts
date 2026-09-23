import { describe, expect, it, vi } from 'vitest'
import { getModelDefaults, getSessionModel, setModelDefaults, setSessionModel } from './api.ts'

/** Every call goes through apiFetch: same-origin credentials, a Headers bag. */
type Call = [string, RequestInit]
const callOf = (mock: ReturnType<typeof vi.fn>, index: number): Call => mock.mock.calls[index] as unknown as Call

describe('session model API', () => {
  it('gets an encoded workspace/session model route', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ provider: 'p', model: 'm', thinkingLevel: null, source: 'session' })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(getSessionModel('workspace / 1', 'session / 1')).resolves.toEqual({ provider: 'p', model: 'm', thinkingLevel: null, source: 'session' })
      const [url, init] = callOf(fetchMock, 0)
      expect(url).toBe('/api/workspaces/workspace%20%2F%201/sessions/session%20%2F%201/model')
      expect(init.credentials).toBe('same-origin')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('gets and writes global defaults at the global endpoint', async () => {
    const defaults = { provider: 'p', model: 'm', thinkingLevel: 'high' }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(defaults)))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(getModelDefaults()).resolves.toEqual(defaults)
      await expect(setModelDefaults(defaults)).resolves.toEqual(defaults)
      expect(callOf(fetchMock, 0)[0]).toBe('/api/model-defaults')
      const [url, init] = callOf(fetchMock, 1)
      expect(url).toBe('/api/model-defaults')
      expect(init.method).toBe('PUT')
      expect(new Headers(init.headers).get('content-type')).toBe('application/json')
      expect(init.body).toBe(JSON.stringify(defaults))
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('puts partial nullable controls without dropping explicit clears', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ provider: null, model: null, thinkingLevel: null, source: 'global' })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await setSessionModel('w', 's', { provider: null, thinkingLevel: null })
      const [url, init] = callOf(fetchMock, 0)
      expect(url).toBe('/api/workspaces/w/sessions/s/model')
      expect(init.method).toBe('PUT')
      expect(new Headers(init.headers).get('content-type')).toBe('application/json')
      expect(init.body).toBe(JSON.stringify({ provider: null, thinkingLevel: null }))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
