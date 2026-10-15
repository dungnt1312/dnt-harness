/**
 * SSE snapshot/resume: the replay profile, Last-Event-ID resume, and the
 * durability gate — a successful compaction/end stays invisible (live and
 * replay) until its store flush commits, and a failed flush never publishes
 * what the canonical log does not hold.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebServer, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from './fake-llm.ts'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import type { LlmProvider, StreamEvent } from '../../src/harness/llm/types.ts'
import type { SessionId } from '../../src/util/brand.ts'
import { FileSessionStore } from '../../src/harness/storage/file-session-store.ts'

let server: WebServer | undefined
let root: string | undefined
afterEach(async () => {
  await server?.close()
  if (root) await fs.rm(root, { recursive: true, force: true })
})

it('compacts the snapshot: finalized content chunks and raw context bodies never ship', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-snapshot-compact-'))
  server = await createWebServer({ root, configFile: path.join(root, 'providers.json'), providers: [new FakeScriptedLlm(['a streamed reply'])] })
  const created = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const session = await created.json() as { id: string }
  void fetch(`${server.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })

  // Follow the live stream until the durable message lands, then reconnect
  // fresh: the snapshot must carry the message, not the raw chunks behind it.
  const readUntilMessage = async (): Promise<void> => {
    const abort = new AbortController()
    const response = await fetch(`${server!.url}/api/sessions/${session.id}/events`, { signal: abort.signal })
    const reader = response.body!.getReader()
    let seen = ''
    while (!seen.includes('assistant/message') || !seen.includes('turn/end')) {
      const { value, done } = await reader.read()
      if (done) break
      seen += new TextDecoder().decode(value)
    }
    abort.abort()
  }
  await readUntilMessage()
  await new Promise((resolve) => setTimeout(resolve, 100))

  const abort = new AbortController()
  const response = await fetch(`${server!.url}/api/sessions/${session.id}/events`, { signal: abort.signal })
  const reader = response.body!.getReader()
  let text = ''
  while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
  abort.abort()
  const envelope = JSON.parse(text.split('\n\n')[0]!.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as { kind: string; events: { type: string }[] }
  expect(envelope.kind).toBe('snapshot')
  const types = new Set(envelope.events.map((event) => event.type))
  // The streamed answer's raw chunks are replaced by its durable message.
  expect(types.has('assistant/chunk')).toBe(false)
  expect(types.has('assistant/message')).toBe(true)
  expect(types.has('user/message')).toBe(true)
})

it('emits an SSE id and replays only events after a valid Last-Event-ID', async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-resume-'))
  server = await createWebServer({ root, configFile: path.join(root, 'providers.json'), providers: [new FakeScriptedLlm(['done'])] })
  const created = await fetch(`${server.url}/api/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const session = await created.json() as { id: string }
  await fetch(`${server.url}/api/sessions/${session.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'hello' }) })
  const readFirst = async (cursor?: string, query?: string) => {
    const abort = new AbortController()
    const response = await fetch(`${server!.url}/api/sessions/${session.id}/events${query !== undefined ? `?cursor=${encodeURIComponent(query)}` : ''}`, { signal: abort.signal, ...(cursor !== undefined ? { headers: { 'Last-Event-ID': cursor } } : {}) })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    const frame = text.split('\n\n')[0]!
    const envelope = JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
    return { frame, envelope }
  }
  const first = await readFirst()
  expect(first.frame).toMatch(/^id: \d+\ndata: /)
  const cursor = first.envelope.events[0].seq as number
  const resumed = await readFirst(String(cursor))
  expect(resumed.envelope.kind).toBe('resume')
  expect(resumed.envelope.events.every((event: { seq: number }) => event.seq > cursor)).toBe(true)
  expect((await readFirst('99999999')).envelope.kind).toBe('snapshot')
  expect((await readFirst('invalid')).envelope.kind).toBe('snapshot')
  const cached = await readFirst(undefined, String(cursor))
  expect(cached.envelope.kind).toBe('resume')
  expect(cached.envelope.events.every((event: { seq: number }) => event.seq > cursor)).toBe(true)
  expect((await readFirst(undefined, '99999999')).envelope.kind).toBe('snapshot')
  expect((await readFirst(undefined, '-1')).envelope.kind).toBe('snapshot')
  expect((await readFirst('invalid', String(cursor))).envelope.kind).toBe('snapshot')
})

interface Envelope { kind: string; events?: { type: string; seq: number }[]; event?: { type: string; seq: number } }

/** Read SSE frames from one connection until `predicate` matches or `ms` elapses. */
const readBatch = async (url: string, ms: number, predicate: (envelope: Envelope) => boolean = () => false): Promise<Envelope[]> => {
  const abort = new AbortController()
  const collected: Envelope[] = []
  const response = await fetch(url, { signal: abort.signal })
  const reader = response.body!.getReader()
  let text = ''
  const deadline = Date.now() + ms
  try {
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const chunk = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ])
      if (chunk === 'timeout' || chunk.done) break
      text += new TextDecoder().decode(chunk.value)
      for (const frame of text.split('\n\n').slice(0, -1)) {
        text = text.slice(frame.length + 2)
        const line = frame.split('\n').find((row) => row.startsWith('data: '))
        if (line !== undefined) {
          const envelope = JSON.parse(line.slice(6)) as Envelope
          collected.push(envelope)
          if (predicate(envelope)) return collected
        }
      }
    }
  } finally { abort.abort() }
  return collected
}

const hasEvent = (type: string) => (envelopes: readonly Envelope[]): boolean =>
  envelopes.some((envelope) => envelope.event?.type === type || envelope.events?.some((event) => event.type === type))

const hasCompactionEnd = hasEvent('compaction/end')

/** The original store flush, captured before any spy replaces the prototype method. */
const storeFlush = FileSessionStore.prototype.flush

/** The summary stream parks until the test opens it; the gate body runs then. */
const gatedSummarizer = (onPark: () => Promise<void>): LlmProvider => ({
  name: 'scripted', models: ['scripted'],
  stream(request) {
    return (async function* (): AsyncIterable<StreamEvent> {
      const isSummary = request.messages.some((m) => typeof m.content === 'string' && m.content.includes('Primary Request and Intent'))
      if (isSummary) await onPark()
      yield { type: 'delta', delta: isSummary ? 'CHECKPOINT SUMMARY TEXT' : 'turn reply' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    })()
  },
})

describe('durability gate', () => {
  it('holds an uncommitted compact success and the events behind it until the flush commits', { timeout: 30_000 }, async () => {
    // Order of operations: the compaction's summary stream parks inside the
    // provider; the test installs a flush gate on the store class; the
    // summary resolves; the compaction/end appends and its barrier parks on
    // the gate. The success and every event behind it stay hidden until the
    // test releases the flush.
    let releaseSummary!: () => void
    const summaryOpen = new Promise<void>((resolve) => {
      // The provider awaits this chain: first the test must see the
      // summarizer enter (flush gate installed), then it opens.
      releaseSummary = resolve
    })
    let summarizerArrived!: () => void
    const arrived = new Promise<void>((resolve) => { summarizerArrived = resolve })
    const provider = gatedSummarizer(async () => {
      summarizerArrived()
      await summaryOpen
    })
    root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-sse-durable-'))
    server = await createWebServer({ home: root, configFile: path.join(root, 'p.json'), providers: [provider] })
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const eventsUrl = `${route}/events`
    const send = async (content: string): Promise<void> => {
      await fetch(`${route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    }
    // The first turn closes durably on its own (no gate yet).
    await send('first')
    await readBatch(eventsUrl, 10_000, (envelope) => hasEvent('turn/end')([envelope]))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // Start the compaction; its summarizer parks, so no compaction/end exists.
    const compactDone = fetch(`${route}/compact`, { method: 'POST' }).catch(() => undefined as unknown as Response)
    await arrived
    expect(hasCompactionEnd(await readBatch(eventsUrl, 800))).toBe(false)
    // Park the store's next flush for this session and open the summarizer.
    // The compaction/end appends (written to the file) but its barrier — the
    // flush — now parks, so the success is not committed and must not ship.
    let releaseFlush!: () => void
    const flushHeld = new Promise<void>((resolve) => { releaseFlush = resolve })
    const flushSpy = vi.spyOn(FileSessionStore.prototype, 'flush').mockImplementation(async function (this: FileSessionStore, sessionId: SessionId) {
      if (sessionId === id) {
        await flushHeld
        // The parked flush is a normal successful sync once released.
        return
      }
      return storeFlush.call(this, sessionId)
    })
    try {
      releaseSummary()
      await new Promise((resolve) => setTimeout(resolve, 400))
      // The append reached the live log, but a fresh reader sees no success
      // and none of the events appended behind it: append visibility for the
      // tail is gated with the held compaction success.
      expect(hasCompactionEnd(await readBatch(eventsUrl, 800))).toBe(false)
      const pinned = fetch(`${route}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pinned: true }) }).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(hasEvent('session/pinned')(await readBatch(eventsUrl, 800))).toBe(false)
      // Release the flush: the barrier commits and the held prefix drains in
      // seq order — the compact success first, then the pin behind it.
      releaseFlush()
      const response = await compactDone
      expect(response?.status).toBe(200)
      expect(hasCompactionEnd(await readBatch(eventsUrl, 8_000, (envelope) => hasCompactionEnd([envelope])))).toBe(true)
      await readBatch(eventsUrl, 4_000, (envelope) => hasEvent('session/pinned')([envelope]))
      await pinned
    } finally {
      flushSpy.mockRestore()
      releaseFlush()
    }
  })

  it('a rejected flush never publishes the compact success it could not commit', { timeout: 20_000 }, async () => {
    // Poisoned writer: the compact ran, the append reached memory, the flush
    // failed. The success stays unpublished on every read — live replay and
    // snapshot — because the canonical log does not hold it.
    let summarizerArrived!: () => void
    const arrived = new Promise<void>((resolve) => { summarizerArrived = resolve })
    // The parked summarizer never resolves the success path; `flushFailed`
    // merely marks that the barrier may proceed to fail (the flush spy below
    // supplies the actual error).
    let flushFailed: (() => void) | undefined
    const provider = gatedSummarizer(async () => {
      summarizerArrived()
      await new Promise<void>((resolve) => { flushFailed = resolve })
    })
    root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-sse-poison-'))
    server = await createWebServer({ home: root, configFile: path.join(root, 'p.json'), providers: [provider] })
    const base = server.url
    const wsId = (await (await fetch(`${base}/api/workspaces`)).json() as { id: string }[])[0]!.id
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const eventsUrl = `${route}/events`
    const send = async (content: string): Promise<void> => {
      await fetch(`${route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
    }
    await send('first')
    await readBatch(eventsUrl, 10_000, (envelope) => hasEvent('turn/end')([envelope]))
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    // The raw promise is kept: the test asserts on its rejection itself.
    const compactDone = fetch(`${route}/compact`, { method: 'POST' })
    const settled = compactDone.then(async (r) => `resolved:${r.status}:${(await r.text().catch(() => '')).slice(0, 120)}` as const, (error: unknown) => `rejected:${String(error)}` as const)
    await arrived
    const flushSpy = vi.spyOn(FileSessionStore.prototype, 'flush').mockImplementation(async function (this: FileSessionStore, sessionId: SessionId) {
      if (sessionId === id) throw new Error('disk gone')
      return storeFlush.call(this, sessionId)
    })
    try {
      flushFailed?.()
      // The route answers 409 with the storage failure (or the fetch rejects
      // outright on an abrupt connection drop): either way the compaction
      // could not commit.
      const outcome = await Promise.race([settled, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8_000))])
      expect(outcome === 'timeout' ? 'timeout' : outcome.startsWith('rejected:') || outcome.includes('disk gone') ? 'failed' : outcome).toBe('failed')
      // Live replay and a fresh snapshot must both refuse the uncommitted success.
      expect(hasCompactionEnd(await readBatch(eventsUrl, 800))).toBe(false)
      expect(hasCompactionEnd(await readBatch(eventsUrl, 800))).toBe(false)
    } finally {
      flushSpy.mockRestore()
    }
  })
})
