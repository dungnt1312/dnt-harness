/**
 * G1 web-host behaviors: transport-retry deduplication, the pending-input
 * bound, refusal to delete a running session, approval replay on reconnect,
 * and durable persistence across a full server restart.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebEnvelope, type WebServer } from 'mini-dsh'

let root = ''

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g1-web-'))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** A provider whose first call never resolves: holds a turn open on demand. */
function hangProvider(): LlmProvider {
  return {
    name: 'hang',
    models: ['hang'],
    async *stream() {
      await new Promise(() => {})
      yield { type: 'delta', delta: 'never' }
    },
  }
}

describe('input acceptance over REST', () => {
  it('the same clientRequestId in a DIFFERENT session is a different input', async () => {
    const server = await createWebServer({ root, providers: [hangProvider()] })
    try {
      const a = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      const b = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      const first = await post(server.url, `/api/sessions/${a.id}/messages`, { content: 'go', clientRequestId: 'shared-id' })
      expect(first.status).toBe(202)
      const second = await post(server.url, `/api/sessions/${b.id}/messages`, { content: 'go', clientRequestId: 'shared-id' })
      // Session B's input must queue normally, not be swallowed by A's id.
      expect(second.status).toBe(202)
      const secondBody = (await second.json()) as { duplicate?: boolean }
      expect(secondBody.duplicate).toBeUndefined()
    } finally {
      await server.close()
    }
  })

  it('the same clientRequestId never creates a second execution', async () => {
    const server = await createWebServer({ root, providers: [hangProvider()] })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      const first = await post(server.url, `/api/sessions/${id}/messages`, { content: 'once', clientRequestId: 'retry-1' })
      expect(first.status).toBe(202)
      const firstBody = (await first.json()) as { inputId: string }

      const retry = await post(server.url, `/api/sessions/${id}/messages`, { content: 'once', clientRequestId: 'retry-1' })
      expect(retry.status).toBe(200)
      const retryBody = (await retry.json()) as { inputId: string; duplicate: boolean }
      expect(retryBody.duplicate).toBe(true)
      expect(retryBody.inputId).toBe(firstBody.inputId)

      // The retry created no second queue entry. Wait until the hung agent
      // claims the original input; under parallel-suite load that scheduling
      // is asynchronous.
      let pending = -1
      for (let i = 0; i < 30; i++) {
        const listing = (await (await fetch(`${server.url}/api/sessions`)).json()) as { id: string; pendingInputs: number }[]
        pending = listing.find((row) => row.id === id)?.pendingInputs ?? -1
        if (pending === 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect(pending).toBe(0)
    } finally {
      await server.close()
    }
  })

  it('the pending-input bound rejects with 429 instead of queueing unbounded', async () => {
    const server = await createWebServer({ root, providers: [hangProvider()], limits: { maxPendingInputs: 2 } })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      expect((await post(server.url, `/api/sessions/${id}/messages`, { content: 'one' })).status).toBe(202)
      // Ensure the first input belongs to the active turn before filling the
      // bounded pending queue.
      for (let i = 0; i < 30; i++) {
        const listing = (await (await fetch(`${server.url}/api/sessions`)).json()) as { id: string; pendingInputs: number }[]
        if (listing.find((row) => row.id === id)?.pendingInputs === 0) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      expect((await post(server.url, `/api/sessions/${id}/messages`, { content: 'two' })).status).toBe(202)
      expect((await post(server.url, `/api/sessions/${id}/messages`, { content: 'three' })).status).toBe(202)
      const fourth = await post(server.url, `/api/sessions/${id}/messages`, { content: 'four' })
      expect(fourth.status).toBe(429)

      // Stop ends the run; queued inputs stay pending, not auto-executed.
      await post(server.url, `/api/sessions/${id}/stop`)
      await new Promise((resolve) => setTimeout(resolve, 120))
      const listing = (await (await fetch(`${server.url}/api/sessions`)).json()) as { id: string; pendingInputs: number; status: string }[]
      const row = listing.find((item) => item.id === id)
      expect(row?.pendingInputs).toBe(2)
      expect(row?.status).toBe('idle')
    } finally {
      await server.close()
    }
  })

  it('input accepted during cancellation survives: nothing is lost, nothing auto-runs', async () => {
    const server = await createWebServer({ root, providers: [hangProvider()] })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      await post(server.url, `/api/sessions/${id}/messages`, { content: 'first' })
      // Accept a second input while the first turn hangs: it queues.
      const during = await post(server.url, `/api/sessions/${id}/messages`, { content: 'queued while hung' })
      expect(during.status).toBe(202)
      // Stop ends the run — the queued input stays queued, never auto-runs.
      await post(server.url, `/api/sessions/${id}/stop`)

      await new Promise((resolve) => setTimeout(resolve, 150))
      const listing = (await (await fetch(`${server.url}/api/sessions`)).json()) as { id: string; pendingInputs: number; status: string }[]
      const row = listing.find((item) => item.id === id)
      expect(row?.status).toBe('idle')
      expect(row?.pendingInputs).toBe(1)
    } finally {
      await server.close()
    }
  })

  describe('steer', () => {
    /** First request hangs until aborted; every later one answers at once. */
    function steerableProvider(): LlmProvider {
      let calls = 0
      return {
        name: 'hang',
        models: ['hang'],
        async *stream(_request, options) {
          calls += 1
          if (calls === 1) {
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
          }
          yield { type: 'delta', delta: `reply ${calls}` }
        },
      }
    }
    type LogEvent = { type: string; reason?: string; content?: string; delivery?: string }
    const ws = (id: string, action: string): string => `/api/workspaces/default/sessions/${id}/${action}`
    async function events(base: string, id: string): Promise<LogEvent[]> {
      const response = await fetch(`${base}${ws(id, 'events')}`)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      let buffer = ''
      try {
        while (!buffer.includes('\n\n')) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += new TextDecoder().decode(value)
        }
      } finally {
        await reader.cancel()
      }
      const line = buffer.split('\n').find((row) => row.startsWith('data: '))
      return (JSON.parse(line!.slice('data: '.length)) as { events: LogEvent[] }).events
    }
    async function settle(base: string, id: string, until: (log: LogEvent[]) => boolean): Promise<LogEvent[]> {
      for (let i = 0; i < 60; i++) {
        const log = await events(base, id)
        if (until(log)) return log
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return events(base, id)
    }
    const ends = (log: LogEvent[]): string[] => log.flatMap((e) => e.type === 'turn/end' ? [e.reason ?? ''] : [])
    const users = (log: LogEvent[]): string[] => log.flatMap((e) => e.type === 'user/message' ? [e.content ?? ''] : [])
    const stepping = (log: LogEvent[]): boolean => log.some((e) => e.type === 'step/start')

    it('delivery:steer stops the running turn and runs the old queue plus the new message', async () => {
      const server = await createWebServer({ root, providers: [steerableProvider()] })
      try {
        const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
        await post(server.url, ws(id, 'messages'), { content: 'first' })
        await settle(server.url, id, stepping)
        expect((await post(server.url, ws(id, 'messages'), { content: 'queued' })).status).toBe(202)
        const steered = await post(server.url, ws(id, 'messages'), { content: 'instead', delivery: 'steer' })
        expect(steered.status).toBe(202)
        expect(await steered.json()).toMatchObject({ queued: false, delivery: 'steer' })

        const log = await settle(server.url, id, (l) => ends(l).length >= 2)
        expect(ends(log)).toEqual(['steered', 'completed'])
        expect(users(log)).toEqual(['first', 'queued', 'instead'])
        expect(log.find((e) => e.type === 'input/queued' && e.content === 'instead')?.delivery).toBe('steer')
      } finally {
        await server.close()
      }
    })

    it('a duplicate steer never stops the turn the first request started', async () => {
      const server = await createWebServer({ root, providers: [hangProvider()] })
      try {
        const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
        await post(server.url, ws(id, 'messages'), { content: 'go', clientRequestId: 'r1' })
        await settle(server.url, id, stepping)
        const dup = await post(server.url, ws(id, 'messages'), { content: 'go', clientRequestId: 'r1', delivery: 'steer' })
        expect(dup.status).toBe(200)
        expect(await dup.json()).toMatchObject({ duplicate: true })
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(ends(await events(server.url, id))).toEqual([])
        await post(server.url, ws(id, 'stop'))
      } finally {
        await server.close()
      }
    })

    it('a refused steer (429) leaves the running turn alone', async () => {
      const server = await createWebServer({ root, providers: [hangProvider()], limits: { maxPendingInputs: 1 } })
      try {
        const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
        await post(server.url, ws(id, 'messages'), { content: 'go' })
        await settle(server.url, id, stepping)
        expect((await post(server.url, ws(id, 'messages'), { content: 'fills the queue' })).status).toBe(202)
        expect((await post(server.url, ws(id, 'messages'), { content: 'too many', delivery: 'steer' })).status).toBe(429)
        await new Promise((resolve) => setTimeout(resolve, 120))
        expect(ends(await events(server.url, id))).toEqual([])
        await post(server.url, ws(id, 'stop'))
      } finally {
        await server.close()
      }
    })

    it('an unknown delivery is a 400', async () => {
      const server = await createWebServer({ root, providers: [hangProvider()] })
      try {
        const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
        expect((await post(server.url, ws(id, 'messages'), { content: 'x', delivery: 'now' })).status).toBe(400)
      } finally {
        await server.close()
      }
    })

    it('POST /steer runs input a stop left queued; with nothing pending it stops nothing', async () => {
      const server = await createWebServer({ root, providers: [steerableProvider()] })
      try {
        const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
        await post(server.url, ws(id, 'messages'), { content: 'first' })
        await settle(server.url, id, stepping)
        // Empty queue: Send now must not act as a hidden Stop.
        expect(await (await post(server.url, ws(id, 'steer'))).json()).toEqual({ steered: false, pending: 0 })
        await post(server.url, ws(id, 'messages'), { content: 'left behind' })
        await post(server.url, ws(id, 'stop'))
        let log = await settle(server.url, id, (l) => ends(l).length >= 1)
        expect(ends(log)).toEqual(['cancelled'])
        expect(users(log)).toEqual(['first'])

        const now = await post(server.url, ws(id, 'steer'))
        expect(now.status).toBe(202)
        expect(await now.json()).toEqual({ steered: true, pending: 1 })
        log = await settle(server.url, id, (l) => ends(l).length >= 2)
        expect(ends(log)).toEqual(['cancelled', 'completed'])
        expect(users(log)).toEqual(['first', 'left behind'])
      } finally {
        await server.close()
      }
    })
  })

  it('deleting a running session is refused; deleting a stopped one works', async () => {
    const server = await createWebServer({ root, providers: [hangProvider()] })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      await post(server.url, `/api/sessions/${id}/messages`, { content: 'keep running' })
      const busy = await fetch(`${server.url}/api/sessions/${id}`, { method: 'DELETE' })
      expect(busy.status).toBe(409)

      await post(server.url, `/api/sessions/${id}/stop`)
      await new Promise((resolve) => setTimeout(resolve, 120))
      const settled = await fetch(`${server.url}/api/sessions/${id}`, { method: 'DELETE' })
      expect(settled.status).toBe(200)
    } finally {
      await server.close()
    }
  })
})

describe('approval replay and durability', () => {
  it('a reconnecting client still sees the pending approval question', async () => {
    const gated: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream() {
        yield { type: 'toolCalls', calls: [{ id: 'c1', name: 'write', args: { path: 'replay.txt', content: 'x' } }] }
      },
    }
    const server = await createWebServer({ root, providers: [gated] })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      await post(server.url, `/api/sessions/${id}/messages`, { content: 'write it' })

      // First client sees the question ride the live stream…
      const first = await fetch(`${server.url}/api/sessions/${id}/events`)
      const firstReader = (first.body as ReadableStream).getReader()
      const approvalId = await readUntilApproval(firstReader)
      expect(approvalId).not.toBeNull()

      // …and a fresh reconnect (a browser reload) restores actionable state.
      const second = await fetch(`${server.url}/api/sessions/${id}/events`)
      const secondReader = (second.body as ReadableStream).getReader()
      const replayed = await readUntilApproval(secondReader)
      expect(replayed).toBe(approvalId)

      // Answering through the replayed question completes the round-trip.
      const allow = await post(server.url, `/api/approvals/${approvalId ?? ''}`, { allow: true })
      expect(allow.status).toBe(200)
      firstReader.cancel().catch(() => {})
      secondReader.cancel().catch(() => {})
    } finally {
      await server.close()
    }
  })
})

/** Read one session's SSE until a session event matches; returns it. */
async function waitUntil(
  server: { url: string },
  id: string,
  match: (event: { type: string; reason?: string }) => boolean,
): Promise<{ type: string; reason?: string } | undefined> {
  const response = await fetch(`${server.url}/api/sessions/${id}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5_000
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now()
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine === undefined) continue
        const envelope = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
        if (envelope.kind === 'session' && match(envelope.event as { type: string })) {
          return envelope.event as { type: string; reason?: string }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  return undefined
}

/** Connect and return the events from the first snapshot frame. */
async function readSnapshotEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Array<{ type: string; reason?: string; decision?: string; ok?: boolean }>> {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
    ])
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    const boundary = buffer.indexOf('\n\n')
    if (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
      if (dataLine === undefined) continue
      const envelope = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
      if (envelope.kind === 'snapshot') return envelope.events as never
    }
  }
  return []
}

/** Read frames until an approval envelope arrives; returns its id. */
async function readUntilApproval(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
    ])
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      boundary = buffer.indexOf('\n\n')
      const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
      if (dataLine === undefined) continue
      const envelope = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
      if (envelope.kind === 'approval') return envelope.approvalId
    }
  }
  return null
}

describe('approval lifecycle over REST', () => {
  it('an expired approval stops being answerable: late decisions get 404 and no replay', async () => {
    let asked = false
    const gated: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream() {
        if (!asked) {
          asked = true
          yield { type: 'toolCalls', calls: [{ id: 'c1', name: 'write', args: { path: 'expired.txt', content: 'x' } }] }
          return
        }
        yield { type: 'delta', delta: 'the write failed' }
      },
    }
    const server = await createWebServer({ root, providers: [gated], limits: { approvalExpiryMs: 150 } })
    try {
      const { id } = (await (await post(server.url, '/api/sessions')).json()) as { id: string }
      await post(server.url, `/api/sessions/${id}/messages`, { content: 'write it' })
      const reader = (await fetch(`${server.url}/api/sessions/${id}/events`)).body?.getReader()
      if (reader === undefined) throw new Error('no sse body')
      const approvalId = await readUntilApproval(reader)
      expect(approvalId).not.toBeNull()

      // Wait past the expiry: the question retires itself.
      await new Promise((resolve) => setTimeout(resolve, 400))
      const late = await post(server.url, `/api/approvals/${approvalId ?? ''}`, { allow: true })
      expect(late.status).toBe(404)
      reader.cancel().catch(() => {})

      // The turn already ended while we waited: the log shows the expired
      // decision, the denied result, and a clean completed turn.
      const snapshotReader = ((await fetch(`${server.url}/api/sessions/${id}/events`)).body as ReadableStream).getReader()
      const snapshotEvents = await readSnapshotEvents(snapshotReader)
      snapshotReader.cancel().catch(() => {})
      const decision = snapshotEvents.findLast((event) => event.type === 'approval/decision')
      expect(decision?.type === 'approval/decision' && decision.decision).toBe('expired')
      const result = snapshotEvents.findLast((event) => event.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.ok).toBe(false)
      const end = snapshotEvents.findLast((event) => event.type === 'turn/end')
      expect(end?.type === 'turn/end' && end.reason).toBe('completed')
      await expect(fs.readFile(path.join(root, 'expired.txt'), 'utf8')).rejects.toThrow()
    } finally {
      await server.close()
    }
  })
})

describe('restart persistence', () => {
  it('sessions persist to the data dir and reopen with full history and title', async () => {
    const home = path.join(root, 'data-restart')
    let first: WebServer | undefined
    let id = ''
    try {
      first = await createWebServer({
        root,
        home,
        configFile: path.join(root, 'providers-restart.json'),
        providers: [{
          name: 'scripted',
          models: ['scripted'],
          async *stream() {
            yield { type: 'delta', delta: 'remembered ' }
            yield { type: 'delta', delta: 'reply' }
          },
        }],
      })
      const created = (await (await post(first.url, '/api/sessions')).json()) as { id: string }
      id = created.id
      await post(first.url, `/api/sessions/${id}/messages`, { content: 'will you remember' })
      await new Promise((resolve) => setTimeout(resolve, 200))
      await fetch(`${first.url}/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'persistent chat' }),
      })
    } finally {
      await first?.close()
    }

    let second: WebServer | undefined
    try {
      second = await createWebServer({
        root,
        home,
        configFile: path.join(root, 'providers-restart.json'),
        providers: [{ name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'x' } } }],
      })
      // Visible before any load — boot listed the stored summaries.
      const listing = (await (await fetch(`${second.url}/api/sessions`)).json()) as { id: string; title: string }[]
      const row = listing.find((item) => item.id === id)
      expect(row?.title).toBe('persistent chat')

      // Lazy load restores the whole log for rendering.
      const response = await fetch(`${second.url}/api/sessions/${id}/events`)
      const reader = (response.body as ReadableStream).getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let snapshot: WebEnvelope | undefined
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
          if (dataLine !== undefined) {
            snapshot = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
            break
          }
        }
      }
      reader.cancel().catch(() => {})
      expect(snapshot?.kind).toBe('snapshot')
      const events = snapshot?.kind === 'snapshot' ? snapshot.events : []
      const types = events.map((event) => event.type)
      expect(types).toContain('user/message')
      expect(types).toContain('assistant/message')
      expect(types).toContain('input/queued')
      // The turn was completed before shutdown: no interrupted marker.
      const end = events.findLast((event) => event.type === 'turn/end')
      expect(end?.type === 'turn/end' && end.reason).toBe('completed')
      // Renames are canonical events, so the rebuilt projection agrees.
      expect(events.some((event) => event.type === 'session/title')).toBe(true)
    } finally {
      await second?.close()
    }
  })

  it('a derived title survives a restart without any rename', async () => {
    const home = path.join(root, 'data-derived-title')
    let first: WebServer | undefined
    let id = ''
    try {
      first = await createWebServer({
        root,
        home,
        configFile: path.join(root, 'providers-derived-title.json'),
        providers: [{ name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'ok' } } }],
      })
      const created = (await (await post(first.url, '/api/sessions')).json()) as { id: string }
      id = created.id
      await post(first.url, `/api/sessions/${id}/messages`, { content: 'Explain the storage layer' })
      await new Promise((resolve) => setTimeout(resolve, 200))
    } finally {
      await first?.close()
    }

    let second: WebServer | undefined
    try {
      second = await createWebServer({
        root,
        home,
        configFile: path.join(root, 'providers-derived-title.json'),
        providers: [{ name: 'scripted', models: ['scripted'], async *stream() { yield { type: 'delta', delta: 'ok' } } }],
      })
      // The regression: this listing is served from storage with no session
      // loaded and no rename ever recorded, so a title that only existed in
      // memory came back as "New conversation".
      const listing = (await (await fetch(`${second.url}/api/sessions`)).json()) as { id: string; title: string }[]
      expect(listing.find((item) => item.id === id)?.title).toBe('Explain the storage layer')
    } finally {
      await second?.close()
    }
  })
})
