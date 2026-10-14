/**
 * The compact client: a plain POST stays plain, a 409 that asks for slow-recovery
 * confirmation becomes a typed error carrying the exact fingerprint to echo, and
 * the echo is sent back verbatim. Cancelling never confirms.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compactSession, CompactionCancelled, CompactionRecoveryNeeded, HttpError } from './api.ts'

interface Call { readonly url: string; readonly init: RequestInit }

function stubFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url, init }
    calls.push(call)
    return handler(call)
  }))
  return calls
}

afterEach(() => vi.unstubAllGlobals())

const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const RECOVERY = { cutoff: 42, sourceDigest: 'abc123', estimatedCalls: 9 }

describe('compactSession', () => {
  it('a plain compaction is an empty POST and returns the result with its path', async () => {
    const calls = stubFetch(() => reply(200, { coversSeq: 7, summaryChars: 120, tokensBefore: 9000, tokensAfter: 2000, path: 'exact' }))
    const result = await compactSession('ws 1', 's/1')
    expect(result).toEqual({ coversSeq: 7, summaryChars: 120, tokensBefore: 9000, tokensAfter: 2000, path: 'exact' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/workspaces/ws%201/sessions/s%2F1/compact')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('a 409 that asks for recovery becomes a typed error carrying the exact fingerprint and the call estimate', async () => {
    stubFetch(() => reply(409, { error: 'slow recovery needed', recovery: RECOVERY }))
    const error = await compactSession('w', 's').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CompactionRecoveryNeeded)
    expect((error as CompactionRecoveryNeeded).recovery).toEqual(RECOVERY)
  })

  it('any other 409, or a malformed fingerprint, stays an ordinary HTTP error', async () => {
    stubFetch(() => reply(409, { error: 'compaction requires a completed exchange boundary' }))
    expect(await compactSession('w', 's').catch((e: unknown) => e)).toBeInstanceOf(HttpError)
    stubFetch(() => reply(409, { error: 'x', recovery: { cutoff: 'nope' } }))
    const malformed = await compactSession('w', 's').catch((e: unknown) => e)
    expect(malformed).toBeInstanceOf(HttpError)
    expect(malformed).not.toBeInstanceOf(CompactionRecoveryNeeded)
  })

  it('a confirmation is sent back as JSON, unchanged', async () => {
    const calls = stubFetch(() => reply(200, { coversSeq: 42, summaryChars: 300, path: 'recovery' }))
    await compactSession('w', 's', RECOVERY)
    expect(calls[0]!.init.headers).toBeDefined()
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ recovery: RECOVERY })
  })

  it('a 409 that says it was cancelled becomes a typed cancel, not an error to show', async () => {
    stubFetch(() => reply(409, { error: 'compaction was cancelled', cancelled: true }))
    const error = await compactSession('w', 's').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CompactionCancelled)
    expect(error).not.toBeInstanceOf(HttpError)
  })

  it('only an explicit cancelled flag counts: a refusal that merely mentions it is an ordinary error', async () => {
    stubFetch(() => reply(409, { error: 'compaction was cancelled by someone' }))
    expect(await compactSession('w', 's').catch((e: unknown) => e)).toBeInstanceOf(HttpError)
  })

  it('a server error is never mistaken for a request for recovery', async () => {
    stubFetch(() => reply(500, { error: 'boom', recovery: RECOVERY }))
    expect(await compactSession('w', 's').catch((e: unknown) => e)).toBeInstanceOf(HttpError)
  })
})
