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

function summarizingProvider(options: {
  replies?: readonly string[]
  summarize?: (request: ModelRequest) => string
} = {}): { provider: LlmProvider; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let turn = 0
  const provider: LlmProvider = {
    name: 'scripted',
    models: ['scripted'],
    stream(request) {
      requests.push(request)
      const isSummaryCall = request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK))
      const reply = isSummaryCall ? undefined : (options.replies?.[turn++] ?? 'turn reply')
      return (async function* (): AsyncIterable<StreamEvent> {
        const text = isSummaryCall ? (options.summarize?.(request) ?? SUMMARY_TEXT) : reply!
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

const LATEST_STATE = [
  '44f6ada',
  '60 suites / 1.204 tests',
  'browser audio acceptance',
  'media smoke automation',
  'production secret rotation',
  'flake monitoring',
].join('\n')

/** Extract only newly submitted source, not the accumulated reference summary. */
function conversationChunk(request: ModelRequest): string {
  const content = request.messages[0]!.content
  if (typeof content !== 'string') throw new Error('expected text summarizer request')
  const prefix = '<conversation>\n'
  const suffix = '\n</conversation>'
  const start = content.indexOf(prefix)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(content.endsWith(suffix)).toBe(true)
  return content.slice(start + prefix.length, -suffix.length)
}

async function completedMessage(base: string, wsId: string, id: string, logPath: string, content: string, turns: number): Promise<void> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  expect(response.ok).toBe(true)
  await until(async () => {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '')
    const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
    const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
    return ended === turns && sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
  })
}

describe('web compaction', () => {
  it('folds every long-source chunk and continues the same session with latest state and a raw tail', async () => {
    const longReply = 'synthetic historical detail\n'.repeat(9_000)
    const tailReply = `RECENT RAW TAIL\n${LATEST_STATE}`
    const chunks: string[] = []
    const { provider, requests } = summarizingProvider({
      replies: [longReply, tailReply],
      summarize(request) {
        const chunk = conversationChunk(request)
        chunks.push(chunk)
        // A bounded source echo makes late state visible without exceeding the output cap.
        return `SOURCE ECHO\n${chunk.slice(-2_000)}`
      },
    })
    const { home, base, wsId } = await start(provider, { compactionTailTurns: 1 })
    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    const { id } = await created.json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'synthetic history request', 1)
    await completedMessage(base, wsId, id, logPath, 'latest state request', 2)
    const original = await fs.readFile(logPath)

    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    const compacted = await response.json() as { coversSeq: number; summaryChars: number }
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.join('')).toBe(`user: synthetic history request\nassistant: ${longReply}\nuser: latest state request\nassistant: ${tailReply}`)
    const checkpoint = JSON.parse(await fs.readFile(path.join(checkpointsDir(home, id), `${compacted.coversSeq}.json`), 'utf8')) as { summary: string }
    expect(compacted.summaryChars).toBe(checkpoint.summary.length)
    for (const marker of LATEST_STATE.split('\n')) expect(checkpoint.summary).toContain(marker)

    await completedMessage(base, wsId, id, logPath, 'Còn vấn đề gì không', 3)
    const nextRequest = requests[requests.length - 1]!
    const system = nextRequest.messages.filter((message) => message.role === 'system')
    expect(system[0]!.content).toContain('This is the same conversation continuing after compaction, not a new session')
    expect(system[1]!.content).toContain(checkpoint.summary)
    expect(system[1]!.content).toContain('<untrusted kind="compacted-history"')
    expect(nextRequest.messages).toContainEqual({ role: 'user', content: 'latest state request' })
    expect(nextRequest.messages).toContainEqual({ role: 'assistant', content: tailReply })
    expect(nextRequest.messages).toContainEqual({ role: 'user', content: 'Còn vấn đề gì không' })
    const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string }[]
    expect(sessions.map((session) => session.id)).toEqual([id])
    expect((await fs.readFile(logPath)).subarray(0, original.length)).toEqual(original)
  })

  it('refuses a second-chunk stream failure without publishing or replacing a checkpoint', async () => {
    let failing = false
    let chunkCalls = 0
    const chunks: string[] = []
    const { provider } = summarizingProvider({
      replies: ['previous state', 'synthetic long output\n'.repeat(11_000)],
      summarize(request) {
        if (!failing) return SUMMARY_TEXT
        chunks.push(conversationChunk(request))
        if (++chunkCalls === 2) throw new Error('synthetic second chunk failure')
        return 'first chunk succeeded'
      },
    })
    const { home, base, wsId } = await start(provider)
    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    const { id } = await created.json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'previous request', 1)
    const previous = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(previous.status).toBe(200)
    const dir = checkpointsDir(home, id)
    const names = await fs.readdir(dir)
    expect(names).toHaveLength(1)
    const previousBytes = await fs.readFile(path.join(dir, names[0]!))
    await completedMessage(base, wsId, id, logPath, 'long follow-up request', 2)
    const original = await fs.readFile(logPath)
    failing = true
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    // The provider boundary normalizes arbitrary stream exceptions to a safe error.
    expect(await response.json()).toMatchObject({ error: 'provider transport failure' })
    expect(chunkCalls).toBe(2)
    expect(chunks).toHaveLength(2)
    expect(await fs.readdir(dir)).toEqual(names)
    expect(await fs.readFile(path.join(dir, names[0]!))).toEqual(previousBytes)
    const after = await fs.readFile(logPath)
    expect(after.subarray(0, original.length)).toEqual(original)
    const appended = after.subarray(original.length).toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
    expect(appended.map((event) => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(appended[1]).toMatchObject({ error: 'provider transport failure', summaryChars: 0 })
    expect(appended[1].summary).toBeUndefined()
  })

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
