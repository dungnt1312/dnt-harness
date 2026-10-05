/**
 * G3 compaction over the live web server: the manual route summarizes
 * through the session's model pair into a durable checkpoint the next
 * request reads (compactedThroughSeq + the summary rides into the request),
 * and the automatic pressure trigger compacts at a completed boundary
 * without user action.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'

const SUMMARY_TEXT = 'CHECKPOINT SUMMARY TEXT'
/** A marker inside the compaction prompt, so the fake can tell summary calls apart. */
const COMPACT_MARK = 'Primary Request and Intent'

function summarizingProvider(): { provider: LlmProvider; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  const provider: LlmProvider = {
    name: 'scripted',
    models: ['scripted'],
    stream(request) {
      requests.push(request)
      const isSummaryCall = request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK))
      const text = isSummaryCall ? SUMMARY_TEXT : 'turn reply'
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: 'delta', delta: text }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  }
  return { provider, requests }
}

const servers: WebServer[] = []
const homes = new WeakMap<WebServer, string>()

afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const server of servers) {
    const home = homes.get(server)
    if (home !== undefined) await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

async function start(provider: LlmProvider, limits?: Partial<HarnessLimits>): Promise<{ server: WebServer; home: string; base: string; wsId: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-compact-web-'))
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'p.json'), ...(limits !== undefined ? { limits } : {}) })
  servers.push(server)
  homes.set(server, home)
  const wsId = (await (await fetch(`${server.url}/api/workspaces`)).json() as { id: string }[])[0]!.id
  return { server, home, base: server.url, wsId }
}

async function until<T>(probe: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('condition not met before deadline')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

interface ManifestView {
  readonly history: { readonly compactedThroughSeq?: number; readonly checkpointHash?: string }
}

/** The store keys checkpoints flat by session id under the workspaces root. */
function checkpointsDir(home: string, sessionId: string): string {
  return path.join(home, 'workspaces', sessionId, 'checkpoints')
}

describe('web compaction', () => {
  it('the manual route summarizes through the session pair and the next request reads the checkpoint', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider)

    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'first message' }),
    })

    // Compaction refuses an open turn; retry until the turn settles.
    const compacted = await until(async () => {
      const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
      if (response.status === 200) return (await response.json()) as { coversSeq: number; summaryChars: number }
      const body = (await response.json()) as { error?: string }
      if (body.error !== undefined && body.error.includes('completed exchange boundary')) return undefined
      throw new Error(`compact failed: ${response.status} ${body.error ?? ''}`)
    })
    expect(compacted.summaryChars).toBe(SUMMARY_TEXT.length)

    const checkpoint = JSON.parse(
      await fs.readFile(path.join(checkpointsDir(home, id), `${compacted.coversSeq}.json`), 'utf8'),
    ) as { v: number; coversSeq: number; summary: string; provenance: { trigger: string; model?: string } }
    expect(checkpoint.v).toBe(1)
    expect(checkpoint.summary).toBe(SUMMARY_TEXT)
    expect(checkpoint.provenance.trigger).toBe('manual')
    expect(checkpoint.provenance.model).toBe('scripted')

    // The next turn's request carries the summary and the manifest points at it.
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'second message' }),
    })
    // Wait for the follow-up turn to settle so its model request is in the
    // provider log before the log is read (the POST alone only queues it).
    await until(async () => {
      const sessions = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
      return sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
    })
    const manifest = await until<ManifestView>(async () => {
      const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)
      if (response.status !== 200) return undefined
      const body = (await response.json()) as ManifestView
      return body.history.compactedThroughSeq !== undefined ? body : undefined
    })
    expect(manifest.history.compactedThroughSeq).toBe(compacted.coversSeq)
    expect(manifest.history.checkpointHash).toBe(createHash('sha256').update(SUMMARY_TEXT, 'utf8').digest('hex'))

    const nextRequest = requests[requests.length - 1]!
    const sent = nextRequest.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
    expect(sent).toContain(SUMMARY_TEXT)
    expect(sent).toContain('second message')
  })

  it('the automatic pressure trigger compacts at the settled boundary', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider, { automaticCompactionPressure: 0.00001, compactionTailTurns: 2 })

    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    const { id } = (await created.json()) as { id: string }
    await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'push context pressure' }),
    })

    // No user action: the trigger fires once the turn settles.
    const checkpoint = await until(async () => {
      const dir = checkpointsDir(home, id)
      const names = await fs.readdir(dir).catch(() => [])
      if (names.length === 0) return undefined
      return JSON.parse(await fs.readFile(path.join(dir, names[0]!), 'utf8')) as {
        summary: string
        provenance: { trigger: string; model?: string }
      }
    })
    expect(checkpoint.summary).toBe(SUMMARY_TEXT)
    expect(checkpoint.provenance.trigger).toBe('automatic')
    expect(checkpoint.provenance.model).toBe('scripted')

    await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'continue after compaction' }),
    })
    // Settle the follow-up turn first, so the summary request is guaranteed to
    // be in the provider log when the counts below read it.
    await until(async () => {
      const sessions = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json()) as { id: string; status: string }[]
      return sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
    })
    const manifest = await until<ManifestView>(async () => {
      const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)
      if (response.status !== 200) return undefined
      const body = (await response.json()) as ManifestView
      return body.history.compactedThroughSeq !== undefined ? body : undefined
    })
    expect(manifest.history.compactedThroughSeq).toBeTypeOf('number')
    // The summary call went through the same provider as the turns.
    expect(requests.length).toBeGreaterThanOrEqual(3)
  })
})
