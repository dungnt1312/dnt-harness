/**
 * The compact client: always a plain POST — the server picks how to compact and
 * never asks the user to choose. A cancel is typed; any other refusal is an HTTP error.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { compactSession, CompactionCancelled, HttpError } from './api.ts'

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

describe('compactSession', () => {
  it('a compaction is an empty POST and returns the result with its path', async () => {
    const calls = stubFetch(() => reply(200, { coversSeq: 7, summaryChars: 120, tokensBefore: 9000, tokensAfter: 2000, path: 'exact' }))
    const result = await compactSession('ws 1', 's/1')
    expect(result).toEqual({ coversSeq: 7, summaryChars: 120, tokensBefore: 9000, tokensAfter: 2000, path: 'exact' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('/api/workspaces/ws%201/sessions/s%2F1/compact')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBeUndefined()
  })

  it('there is no recovery question to answer: the client exposes no confirmation type', () => {
    expect('CompactionRecoveryNeeded' in api).toBe(false)
  })

  it('a refusal is an ordinary HTTP error, whatever its body carries', async () => {
    stubFetch(() => reply(409, { error: 'compaction requires a completed exchange boundary' }))
    expect(await compactSession('w', 's').catch((e: unknown) => e)).toBeInstanceOf(HttpError)
    stubFetch(() => reply(409, { error: 'x', recovery: { cutoff: 1, sourceDigest: 'd', estimatedCalls: 2 } }))
    expect(await compactSession('w', 's').catch((e: unknown) => e)).toBeInstanceOf(HttpError)
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
})
