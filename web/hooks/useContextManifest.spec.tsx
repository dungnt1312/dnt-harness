// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useContextManifest } from './useContextManifest.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const body = (used: number) => ({ modeId: 'm', modeRevision: 1, budget: { availableTokens: 100, usedTokens: used, estimated: true }, history: { setting: 'recent', includedTurns: 1, omittedTurns: 0 }, sources: { skills: [], memory: [], toolNames: [], toolSchemas: 0 }, omissions: [] })
const respond = (status: number, value?: unknown): Response => new Response(value === undefined ? null : JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

let root: Root | undefined
let host: HTMLDivElement
let seen: ReturnType<typeof useContextManifest>
const pending = new Map<string, (response: Response) => void>()

function Probe({ ws, session, refresh }: { ws: string | null; session: string | null; refresh: string }) {
  seen = useContextManifest(ws, session, refresh)
  return <span>{seen.status}</span>
}
const render = (session: string | null, refresh = '0') => act(async () => root!.render(<Probe ws="w" session={session} refresh={refresh} />))
const settle = (session: string, response: Response) => act(async () => { pending.get(session)!(response); await Promise.resolve() })

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  pending.clear()
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve) => { pending.set(decodeURIComponent(url.split('/sessions/')[1]!.split('/')[0]!), resolve) })))
})

afterEach(async () => {
  await act(async () => root!.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('a fetch for the previous session resolving after a switch never reaches the new session', async () => {
  await render('A')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(seen.status).toBe('loading')

  await render('B')
  // The very render after the switch: loading, not A's value and not an empty/zero view.
  expect(seen).toEqual({ manifest: null, status: 'loading' })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })

  await settle('A', respond(200, body(111)))
  expect(seen).toEqual({ manifest: null, status: 'loading' })
  await settle('B', respond(200, body(222)))
  expect(seen.status).toBe('ready')
  expect(seen.manifest).toMatchObject({ budget: { usedTokens: 222 } })
})

it('no workspace or session (home, unsent draft) is "none", never an endless "loading"', async () => {
  await act(async () => root!.render(<Probe ws="w" session={null} refresh="0" />))
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  expect(seen).toEqual({ manifest: null, status: 'none' })
  expect(fetch).not.toHaveBeenCalled()
  await act(async () => root!.render(<Probe ws={null} session="A" refresh="0" />))
  expect(seen).toEqual({ manifest: null, status: 'none' })
})

it('204 is "none"; any other HTTP failure is "error", and the same session refreshes after 150 ms', async () => {
  await render('A')
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await settle('A', respond(204))
  expect(seen).toEqual({ manifest: null, status: 'none' })

  await render('A', '1')
  expect(seen.status).toBe('none') // the same owner keeps its figures while refreshing
  expect(pending.has('A')).toBe(true)
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(149) })
  expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1)
  await settle('A', respond(500, { error: 'boom' }))
  expect(seen).toEqual({ manifest: null, status: 'error' })
})
