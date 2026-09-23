/**
 * The web host half: REST endpoints, the SSE stream (snapshot replay plus
 * live events), and the approval bridge routing questions to the right
 * session through the ambient agent scope.
 */
import { promises as fs } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  createWebServer,
  type LlmProvider,
  type ModelRequest,
  type WebEnvelope,
  type WebServer,
} from 'mini-dsh'
import { FakeOpenAiServer, FakeScriptedLlm } from './fake-llm.ts'

let root = ''
let server: WebServer
let baseUrl = ''
let startCount = 0

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-web-'))
})

afterAll(async () => {
  await server?.close()
  await fs.rm(root, { recursive: true, force: true })
})

/** Start a server with the scripted provider against the temp workspace. */
async function start(
  steps: readonly (string | { toolCalls: readonly { name: string; args: Record<string, unknown> }[] })[],
  provider?: LlmProvider,
  extra?: Partial<Parameters<typeof createWebServer>[0]>,
): Promise<void> {
  server = await createWebServer({ root, providers: [provider ?? new FakeScriptedLlm(steps)], configFile: path.join(root, `providers-${startCount++}.json`), ...extra })
  baseUrl = server.url
}

/** One persistent SSE reader: reusable `until` calls share the stream. */
class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''

  constructor(response: Response) {
    const body = response.body
    if (body === null) throw new Error('test setup: no SSE body')
    this.reader = body.getReader()
  }

  /** Read until `until` matches; returns everything seen on this call. */
  async until(until: (envelope: WebEnvelope) => boolean, timeoutMs = 5_000): Promise<WebEnvelope[]> {
    const seen: WebEnvelope[] = []
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        throw new Error(`timeout waiting for envelope; saw ${JSON.stringify(seen.map((e) => e.kind))}`)
      }
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) return seen
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      let boundary = this.buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        boundary = this.buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine === undefined) continue
        const envelope = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
        seen.push(envelope)
        if (until(envelope)) return seen
      }
    }
  }
}

/** POST JSON and return the response, failing loud on 5xx transport errors. */
async function post(pathname: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  return fetch(`${baseUrl}${pathname}`, init)
}

async function patch(pathname: string, body?: unknown): Promise<Response> {
  const init: RequestInit = {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }
  return fetch(`${baseUrl}${pathname}`, init)
}

/** A provider emitting chunk-by-chunk with a tiny delay, for stop tests. */
function slowProvider(): LlmProvider {
  return {
    name: 'slow',
    models: ['slow'],
    async *stream(): AsyncIterable<{ type: 'delta'; delta: string }> {
      for (const word of ['one', 'two', 'three', 'four', 'five']) {
        await new Promise((resolve) => setTimeout(resolve, 40))
        yield { type: 'delta', delta: `${word} ` }
      }
    },
  }
}

describe('web server', () => {
  it('reports provider, model, folder, and offered models through /api/meta', async () => {
    await start(['x'])
    const meta = (await (await fetch(`${baseUrl}/api/meta`)).json()) as {
      provider: string
      model: string
      folder: string
      models: string[]
    }
    expect(meta.provider).toBe('scripted')
    expect(meta.model).toBe('scripted')
    expect(meta.models).toEqual(['scripted'])
    expect(meta.folder).toBe(root)
  })

  it('switching the model stamps every request through agent/request', async () => {
    const seen: ModelRequest[] = []
    const recorder: LlmProvider = {
      name: 'recorder',
      models: ['fast', 'smart'],
      stream(request) {
        seen.push(request)
        return new FakeScriptedLlm(['answered']).stream(request)
      },
    }
    await start(['answered'], recorder)
    const initial = (await (await fetch(`${baseUrl}/api/meta`)).json()) as { model: string }
    expect(initial.model).toBe('fast')

    const switched = await fetch(`${baseUrl}/api/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'smart' }),
    })
    expect(switched.status).toBe(200)

    const unknown = await fetch(`${baseUrl}/api/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope' }),
    })
    expect(unknown.status).toBe(400)

    // A provider switch must name the model: inferring one would silently run
    // and bill a model the operator never picked.
    const omitted = await fetch(`${baseUrl}/api/model`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'recorder' }),
    })
    expect(omitted.status).toBe(400)

    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'go' })
    await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    expect(seen.at(-1)?.model).toBe('smart')
  })

  it('switching the folder re-scopes the filesystem tools', async () => {
    await start([{ toolCalls: [{ name: 'read', args: { path: 'note.txt' } }] }, 'read it'])
    const other = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-web-other-'))
    await fs.writeFile(path.join(other, 'note.txt'), 'content in the new folder', 'utf8')

    const bad = await fetch(`${baseUrl}/api/folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: path.join(root, 'missing') }),
    })
    expect(bad.status).toBe(400)

    const switched = await fetch(`${baseUrl}/api/folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: other }),
    })
    expect(switched.status).toBe(200)

    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'read the note' })
    const envelopes = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const result = envelopes.find((e) => e.kind === 'session' && e.event.type === 'tool/result')
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.ok).toBe(true)
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.output).toBe('content in the new folder')

    const meta = (await (await fetch(`${baseUrl}/api/meta`)).json()) as { folder: string }
    expect(meta.folder).toBe(other)
    await fs.rm(other, { recursive: true, force: true })
  })

  it('creates and lists sessions, deriving a title from the first message', async () => {
    await start(['hello there'])
    const created = await post('/api/sessions')
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }

    const listed = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string }>
    expect(listed.map((s) => s.id)).toContain(id)
    expect(listed.find((s) => s.id === id)?.title).toBe('New conversation')


    await post(`/api/sessions/${id}/messages`, { content: 'first question' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const titled = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string }>
    expect(titled.find((s) => s.id === id)?.title).toBe('first question')
  })

  it('streams snapshot then live events, ending with a completed turn', async () => {
    await start(['the reply'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'hello' })
    const envelopes = await sse.until(
      (envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end',
    )

    expect(envelopes[0]?.kind).toBe('snapshot')
    // Streaming chunks are collapsed: their count is a provider detail.
    const kinds = envelopes
      .filter((e) => e.kind === 'session' && e.event.type !== 'assistant/chunk')
      .map((e) => (e.kind === 'session' ? e.event.type : ''))
    expect(kinds).toEqual([
      'input/queued',
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const chunks = envelopes.filter((e) => e.kind === 'session' && e.event.type === 'assistant/chunk')
    expect(chunks.length).toBeGreaterThan(0)
  })

  it('an approval question rides the stream; allowing it completes the tool round-trip', async () => {
    await start([
      { toolCalls: [{ name: 'write', args: { path: 'approved.txt', content: 'data' } }] },
      'written and verified',
    ])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'write the file' })
    const approvalFrame = await sse.until((envelope) => envelope.kind === 'approval')
    const question = approvalFrame.find((e) => e.kind === 'approval')
    expect(question?.kind === 'approval' && question.call.name).toBe('Write')

    const allow = await post(`/api/approvals/${question?.kind === 'approval' ? question.approvalId : ''}`, { allow: true })
    expect(allow.status).toBe(200)

    const rest = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const toolResult = rest.find((e) => e.kind === 'session' && e.event.type === 'tool/result')
    expect(toolResult?.kind === 'session' && toolResult.event.type === 'tool/result' && toolResult.event.ok).toBe(true)
    const content = await fs.readFile(path.join(root, 'approved.txt'), 'utf8')
    expect(content).toBe('data')
  })

  it('denying an approval surfaces the reason as a failed tool result', async () => {
    await start([
      { toolCalls: [{ name: 'write', args: { path: 'blocked.txt', content: 'x' } }] },
      'acknowledged',
    ])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'try to write' })
    const approvalFrame = await sse.until((envelope) => envelope.kind === 'approval')
    const question = approvalFrame.find((e) => e.kind === 'approval')

    await post(`/api/approvals/${question?.kind === 'approval' ? question.approvalId : ''}`, { allow: false })

    const rest = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const toolResult = rest.find((e) => e.kind === 'session' && e.event.type === 'tool/result')
    expect(toolResult?.kind === 'session' && toolResult.event.type === 'tool/result' && toolResult.event.ok).toBe(false)
    expect(toolResult?.kind === 'session' && toolResult.event.type === 'tool/result' && toolResult.event.output).toMatch(
      /the user denied 'Write'/,
    )
    await expect(fs.readFile(path.join(root, 'blocked.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('a second answer to a settled approval is a 404', async () => {
    await start([{ toolCalls: [{ name: 'write', args: { path: 'once.txt', content: 'x' } }] }, 'done'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'go' })
    const approvalFrame = await sse.until((envelope) => envelope.kind === 'approval')
    const question = approvalFrame.find((e) => e.kind === 'approval')
    const approvalId = question?.kind === 'approval' ? question.approvalId : ''

    expect((await post(`/api/approvals/${approvalId}`, { allow: true })).status).toBe(200)
    expect((await post(`/api/approvals/${approvalId}`, { allow: true })).status).toBe(404)
  })

  it('the streamed approval id is the durable log id: the client can answer by it', async () => {
    await start([{ toolCalls: [{ name: 'write', args: { path: 'one-id.txt', content: 'x' } }] }, 'done'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'write the file' })
    // The approval/request session frame precedes the approval frame, so one
    // until() captures both halves of the id contract.
    const envelopes = await sse.until((envelope) => envelope.kind === 'approval')
    const frame = envelopes.find((e) => e.kind === 'approval')
    const request = envelopes.find((e) => e.kind === 'session' && e.event.type === 'approval/request')
    // Regression: the bridge used to mint its own id, so every approval card
    // rebuilt from the log posted a 404.
    const logId = frame?.kind === 'approval'
      ? (request?.kind === 'session' && request.event.type === 'approval/request' ? request.event.approvalId : '')
      : ''
    expect(frame?.kind === 'approval').toBe(true)
    expect(logId).not.toBe('')
    expect(frame?.kind === 'approval' && frame.approvalId === logId).toBe(true)
    expect((await post(`/api/approvals/${logId}`, { allow: true })).status).toBe(200)
  })

  it('a fresh SSE connection replays the full log as a snapshot', async () => {
    await start(['reply one'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    await post(`/api/sessions/${id}/messages`, { content: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 150))

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    const envelopes = await sse.until((envelope) => envelope.kind === 'snapshot')
    const snapshot = envelopes[0]
    expect(snapshot?.kind === 'snapshot' && snapshot.events.map((e) => e.type)).toContain('assistant/message')
  })

  it('unknown routes and sessions fail loud', async () => {
    await start(['x'])
    expect((await fetch(`${baseUrl}/api/nope`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/sessions/missing/events`)).status).toBe(404)
    const bad = await post(`/api/sessions/missing/messages`, { content: 'hi' })
    expect(bad.status).toBe(404)
  })

  it('renaming a session stores a custom title; empty resets to the derived one', async () => {
    await start(['hello there'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    await post(`/api/sessions/${id}/messages`, { content: 'first question' })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const renamed = await patch(`/api/sessions/${id}`, { title: '  my favorite chat  ' })
    expect(renamed.status).toBe(200)
    const titled = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string }>
    expect(titled.find((s) => s.id === id)?.title).toBe('my favorite chat')

    const reset = await patch(`/api/sessions/${id}`, { title: '' })
    expect(reset.status).toBe(200)
    const resetList = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string }>
    expect(resetList.find((s) => s.id === id)?.title).toBe('first question')

    const bad = await patch(`/api/sessions/${id}`, { title: 42 })
    expect(bad.status).toBe(400)
  })

  it('pinning a session is recorded on the session itself and reported by the listing', async () => {
    await start(['hello there'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    const listed = async (): Promise<boolean | undefined> => {
      const rows = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; pinned?: boolean }>
      return rows.find((row) => row.id === id)?.pinned
    }
    expect(await listed()).toBe(false)

    const pinned = await patch(`/api/sessions/${id}`, { pinned: true })
    expect(pinned.status).toBe(200)
    expect(await pinned.json()).toMatchObject({ id, pinned: true })
    expect(await listed()).toBe(true)

    // A pin carries no title, and must not reset the one the session has.
    await patch(`/api/sessions/${id}`, { title: 'kept through pinning' })
    await patch(`/api/sessions/${id}`, { pinned: false })
    const rows = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string; title: string; pinned?: boolean }>
    expect(rows.find((row) => row.id === id)).toMatchObject({ title: 'kept through pinning', pinned: false })

    expect((await patch(`/api/sessions/${id}`, { pinned: 'yes' })).status).toBe(400)
  })

  it('deleting a session removes it and closes its SSE stream', async () => {
    await start(['x'])
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    const deleted = await fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect((await deleted.json())).toEqual({ deleted: true })

    const list = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as Array<{ id: string }>
    expect(list.map((s) => s.id)).not.toContain(id)
    expect((await fetch(`${baseUrl}/api/sessions/${id}/events`)).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/sessions/${id}/stop`, { method: 'POST' })).status).toBe(404)

    const envelopes = await sse.until((envelope) => envelope.kind === 'error', 8_000)
    const error = envelopes.find((e) => e.kind === 'error')
    expect(error?.kind === 'error' && error.message).toBe('session deleted')
  })

  it('stopping a running turn closes it durably with reason cancelled', async () => {
    await start(['unused'], slowProvider())
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }

    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'go slow' })
    await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'assistant/chunk')

    const stopped = await post(`/api/sessions/${id}/stop`)
    expect(stopped.status).toBe(202)

    const rest = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const end = rest.find((e) => e.kind === 'session' && e.event.type === 'turn/end')
    expect(end?.kind === 'session' && end.event.type === 'turn/end' && end.event.reason).toBe('cancelled')
  })

  it('thinking deltas stream as marked chunks and never reach model history', async () => {
    const seen: ModelRequest[] = []
    const recorder: LlmProvider = {
      name: 'recorder',
      models: ['m1'],
      stream(request) {
        seen.push(request)
        return new FakeScriptedLlm([
          {
            thinking: 'the user wants a summary; I should list files first',
            content: 'here is the summary',
            toolCalls: [],
          },
        ]).stream(request)
      },
    }
    await start(['unused'], recorder)
    const { id } = (await (await post('/api/sessions')).json()) as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'summarize' })

    const envelopes = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const thinkingChunks = envelopes.filter((e) => e.kind === 'session' && e.event.type === 'assistant/chunk' && e.event.thinking === true)
    expect(thinkingChunks.length).toBeGreaterThan(0)

    // A second turn produces a second request whose history includes the
    // assembled assistant message — and proves the thinking text never joins it.
    void post(`/api/sessions/${id}/messages`, { content: 'go on' })
    await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const last = seen.at(-1)
    expect(last?.messages.map((m) => m.role)).toContain('assistant')
    const history = last?.messages.map((m) => m.content).join(' ') ?? ''
    expect(history).toContain('here is the summary')
    expect(history).not.toContain('I should list files first')
  })
})

// ── provider registry over real HTTP ────────────────────────────────────────

describe('provider registry', () => {
  it('creates, syncs, tests, switches, disables, and deletes providers', async () => {
    const fake = new FakeOpenAiServer()
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-crud.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config })
      const base = s.url
      const meta0 = (await (await fetch(`${base}/api/meta`)).json()) as { providers: { id: string }[] }
      expect(meta0.providers).toEqual([])

      const created = await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Clip Proxy One', baseUrl: `${fakeBase}/v1`, apiKey: 'sk-test-1234' }),
      })
      expect(created.status).toBe(201)
      const entry = (await created.json()) as { id: string; keyMasked: string }
      expect(entry.id).toBe('clip-proxy-one')
      expect(entry.keyMasked).toBe('••••1234')

      // Raw key never leaves the server.
      const listed = (await (await fetch(`${base}/api/providers`)).json()) as { apiKey?: string }[]
      expect(listed[0] && 'apiKey' in listed[0]).toBe(false)

      // Validation: bad URL and duplicate-name slug-uniqueness.
      const bad = await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x', baseUrl: 'ftp://nope', apiKey: 'k' }),
      })
      expect(bad.status).toBe(400)

      // The probe answers with the endpoint's list and stores nothing: the
      // browser offers the operator a choice before anything is replaced.
      const probed = await fetch(`${base}/api/providers/clip-proxy-one/models`)
      expect(probed.status).toBe(200)
      expect((await probed.json() as { models: string[] }).models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
      const untouched = JSON.parse(await fs.readFile(config, 'utf8')) as { providers?: { models: string[] }[] }
      expect(untouched.providers?.[0]?.models).toEqual([])
      expect((await fetch(`${base}/api/providers/nope/models`)).status).toBe(404)

      // Sync pulls the fake /models list and persists into the config file.
      const synced = await fetch(`${base}/api/providers/clip-proxy-one/sync`, { method: 'POST' })
      expect(synced.status).toBe(200)
      const syncBody = (await synced.json()) as { ok: boolean; models: string[] }
      expect(syncBody.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])
      const persisted = JSON.parse(await fs.readFile(config, 'utf8')) as { providers?: { models: string[] }[] }
      expect(persisted.providers?.[0]?.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])

      // Test connection issues a buffered completion ping against the fake.
      const tested = await fetch(`${base}/api/providers/clip-proxy-one/test`, { method: 'POST' })
      expect(tested.status).toBe(200)
      const ping = fake.seenRequests.find((request) => request.url.endsWith('/chat/completions'))
      expect(ping !== undefined && ping.body['stream']).toBe(false)

      // Per-model test names the row's model on the wire; an unadvertised id
      // fails at the boundary instead of surfacing a confusing upstream 404.
      const perModel = await fetch(`${base}/api/providers/clip-proxy-one/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-terra' }),
      })
      expect(perModel.status).toBe(200)
      const pings = fake.seenRequests.filter((request) => request.url.endsWith('/chat/completions'))
      expect(pings.at(-1)?.body['model']).toBe('gpt-5.6-terra')
      const bogus = await fetch(`${base}/api/providers/clip-proxy-one/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'not-offered' }),
      })
      expect(bogus.status).toBe(400)

      // Switching active pair rides the same PUT as before.
      const switched = await fetch(`${base}/api/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'clip-proxy-one', model: 'gpt-5.6-sol' }),
      })
      expect(switched.status).toBe(200)
      const metaSwitched = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string; models: string[] }
      expect(metaSwitched.provider).toBe('clip-proxy-one')
      expect(metaSwitched.model).toBe('gpt-5.6-sol')
      expect(metaSwitched.models).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra'])

      // Unknown model inside an advertised list fails loud.
      const badModel = await fetch(`${base}/api/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'not-offered' }),
      })
      expect(badModel.status).toBe(400)

      // Disabling makes the pair unusable for selection.
      const disabled = await fetch(`${base}/api/providers/clip-proxy-one`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      expect(disabled.status).toBe(200)
      const unusable = await fetch(`${base}/api/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'clip-proxy-one', model: 'gpt-5.6-sol' }),
      })
      expect(unusable.status).toBe(400)

      const deleted = await fetch(`${base}/api/providers/clip-proxy-one`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      const again = await fetch(`${base}/api/providers/clip-proxy-one`, { method: 'DELETE' })
      expect(again.status).toBe(404)
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('tests one named model, rejecting an id the provider does not advertise', async () => {
    const fake = new FakeOpenAiServer()
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-model-test.json')
    let s: WebServer | undefined
    try {
      await fs.writeFile(config, JSON.stringify({
        version: 2,
        defaults: { provider: 'gateway', model: 'gpt-5.6-sol', thinkingLevel: null },
        providers: [{ id: 'gateway', name: 'gateway', baseUrl: `${fakeBase}/v1`, apiKey: '', models: ['gpt-5.6-sol', 'gpt-5.6-terra'], enabled: true }],
      }), 'utf8')
      s = await createWebServer({ root, configFile: config })
      const base = s.url

      // The named model is exactly what reaches the wire.
      const named = await fetch(`${base}/api/providers/gateway/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-5.6-terra' }),
      })
      expect(named.status).toBe(200)
      expect(fake.seenRequests.filter((request) => request.url.endsWith('/chat/completions')).at(-1)?.body['model']).toBe('gpt-5.6-terra')

      // An id the provider does not advertise fails before any upstream call.
      const before = fake.seenRequests.length
      const bogus = await fetch(`${base}/api/providers/gateway/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'not-offered' }),
      })
      expect(bogus.status).toBe(400)
      expect(fake.seenRequests.length).toBe(before)

      // A malformed body is a client error, never a silent first-model ping.
      const malformed = await fetch(`${base}/api/providers/gateway/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: '' }),
      })
      expect(malformed.status).toBe(400)

      // No body keeps the footer control working on the first advertised model.
      const footer = await fetch(`${base}/api/providers/gateway/test`, { method: 'POST' })
      expect(footer.status).toBe(200)
      expect(fake.seenRequests.filter((request) => request.url.endsWith('/chat/completions')).at(-1)?.body['model']).toBe('gpt-5.6-sol')
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('repairs the active model when a sync drops it from the advertised list', async () => {
    const fake = new FakeOpenAiServer()
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-resync.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config })
      const base = s.url
      await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Resync',
          baseUrl: `${fakeBase}/v1`,
          apiKey: 'sk-resync-9999',
          models: ['legacy-a', 'legacy-b'],
        }),
      })
      await fetch(`${base}/api/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'resync', model: 'legacy-b' }),
      })

      // The fake advertises a completely different list; the selected
      // 'legacy-b' disappears and must not survive as a stale pointer.
      const synced = await fetch(`${base}/api/providers/resync/sync`, { method: 'POST' })
      expect(synced.status).toBe(200)
      const meta = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string }
      expect(meta.provider).toBe('resync')
      expect(meta.model).toBe('gpt-5.6-sol')
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('makes a freshly added provider chattable: sync picks a model and messages queue', async () => {
    const fake = new FakeOpenAiServer(['hello from the proxy'])
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-firstrun.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config, defaultMode: 'allow' })
      const base = s.url

      // The real first-run flow: name + URL + key only, models come from Sync.
      const created = await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'First Run', baseUrl: `${fakeBase}/v1`, apiKey: 'sk-first-0001' }),
      })
      expect(created.status).toBe(201)

      await fetch(`${base}/api/providers/first-run/sync`, { method: 'POST' })

      // Sync taught the provider its models, so the active pair must be
      // complete — an empty model is what left the composer disabled.
      const meta = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string }
      expect(meta.provider).toBe('first-run')
      expect(meta.model).toBe('gpt-5.6-sol')

      const session = (await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json()) as { id: string }
      const queued = await fetch(`${base}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      })
      expect(queued.status).toBe(202)

      // Let the turn settle before the fake goes away, so tearing down the
      // endpoint mid-flight does not surface as an unrelated error log.
      await fetch(`${base}/api/sessions/${session.id}/stop`, { method: 'POST' })
      await new Promise((resolve) => setTimeout(resolve, 120))
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('treats a keyless local endpoint as usable', async () => {
    const fake = new FakeOpenAiServer(['local reply'])
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-keyless.json')
    let s: WebServer | undefined
    try {
      // A localhost gateway that authenticates by nothing at all: the entry is
      // stored with an empty key and must still register and be selectable.
      await fs.writeFile(config, JSON.stringify({
        version: 2,
        defaults: { provider: 'local-gw', model: 'auto', thinkingLevel: null },
        providers: [{
          id: 'local-gw',
          name: 'local-gw',
          baseUrl: `${fakeBase}/v1`,
          apiKey: '',
          models: ['auto', 'auto-thinking'],
          enabled: true,
        }],
      }), 'utf8')

      s = await createWebServer({ root, configFile: config, defaultMode: 'allow' })
      const base = s.url
      const meta = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string }
      expect(meta.provider).toBe('local-gw')
      expect(meta.model).toBe('auto')

      const session = (await (await fetch(`${base}/api/sessions`, { method: 'POST' })).json()) as { id: string }
      const queued = await fetch(`${base}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'hi' }),
      })
      expect(queued.status).toBe(202)

      await fetch(`${base}/api/sessions/${session.id}/stop`, { method: 'POST' })
      await new Promise((resolve) => setTimeout(resolve, 120))

      // The wire call must omit Authorization rather than send "Bearer ".
      const call = fake.seenRequests.find((request) => request.url.endsWith('/chat/completions'))
      expect(call?.authorization).toBeUndefined()
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('accepts a provider created without an API key', async () => {
    const fake = new FakeOpenAiServer()
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-keyless-create.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config })
      const base = s.url
      const created = await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Local GW', baseUrl: `${fakeBase}/v1` }),
      })
      expect(created.status).toBe(201)
      const entry = (await created.json()) as { id: string; keyMasked: string }
      expect(entry.id).toBe('local-gw')
      expect(entry.keyMasked).toBe('')

      await fetch(`${base}/api/providers/local-gw/sync`, { method: 'POST' })
      const meta = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string }
      expect(meta.provider).toBe('local-gw')
      expect(meta.model).toBe('gpt-5.6-sol')
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('keeps the active provider selected in the registry after another entry is added', async () => {
    const fake = new FakeOpenAiServer()
    const fakeBase = await fake.start()
    const config = path.join(root, 'providers-reselect.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config })
      const base = s.url
      const add = (name: string, models: readonly string[]): Promise<Response> =>
        fetch(`${base}/api/providers`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, baseUrl: `${fakeBase}/v1`, apiKey: `sk-${name}-0001`, models }),
        })

      await add('Alpha', ['alpha-1'])
      await add('Beta', ['beta-1', 'beta-2'])
      await fetch(`${base}/api/model`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'beta', model: 'beta-2' }),
      })

      // Adding a third entry re-registers every provider; the selection must
      // survive that churn, models included.
      await add('Gamma', ['gamma-1'])
      const meta = (await (await fetch(`${base}/api/meta`)).json()) as { provider: string; model: string; models: string[] }
      expect(meta.provider).toBe('beta')
      expect(meta.model).toBe('beta-2')
      expect(meta.models).toEqual(['beta-1', 'beta-2'])
    } finally {
      await s?.close()
      await fake.stop()
    }
  })

  it('seeds a deepseek entry from env on first boot when asked', async () => {
    const previous = process.env['DEEPSEEK_API_KEY']
    process.env['DEEPSEEK_API_KEY'] = 'env-seed-key'
    const config = path.join(root, 'providers-seed.json')
    let s: WebServer | undefined
    try {
      s = await createWebServer({ root, configFile: config, seedDeepseekFromEnv: true })
      const list = (await (await fetch(`${s.url}/api/providers`)).json()) as { id: string; keyMasked: string }[]
      expect(list[0]?.id).toBe('deepseek')
      expect(list[0]?.keyMasked).toBe('••••-key')
      const persisted = JSON.parse(await fs.readFile(config, 'utf8')) as { providers?: { id: string }[] }
      expect(persisted.providers?.[0]?.id).toBe('deepseek')
    } finally {
      if (previous === undefined) delete process.env['DEEPSEEK_API_KEY']
      else process.env['DEEPSEEK_API_KEY'] = previous
      await s?.close()
    }
  })
})

// ── per-session workspace folders ───────────────────────────────────────────

describe('per-session folders', () => {
  it('scopes filesystem tools to each session folder via the ambient agent scope', async () => {
    const dirA = path.join(root, 'proj-a')
    const dirB = path.join(root, 'proj-b')
    await fs.mkdir(dirA, { recursive: true })
    await fs.mkdir(dirB, { recursive: true })

    // Each tool step is followed by a terminal text answer: Agent asks the
    // provider again after every tool result, so two entries would otherwise
    // clamp at B and make session A write twice.
    const steps = [
      { toolCalls: [{ name: 'write', args: { path: 'mark.txt', content: 'from-A' } }] },
      'A completed',
      { toolCalls: [{ name: 'write', args: { path: 'mark.txt', content: 'from-B' } }] },
      'B completed',
    ]
    await start(steps, undefined, { defaultMode: 'allow', yolo: true })

    const madeA = (await (await post('/api/sessions', { folder: dirA })).json()) as { id: string; folder: string }
    expect(madeA.folder).toBe(path.resolve(dirA))
    const madeB = (await (await post('/api/sessions', { folder: dirB })).json()) as { id: string }
    const listing = (await (await fetch(`${baseUrl}/api/sessions`)).json()) as { id: string; folder: string | null }[]
    expect(listing.find((row) => row.id === madeA.id)?.folder).toBe(path.resolve(dirA))

    const sseA = new SseReader(await fetch(`${baseUrl}/api/sessions/${madeA.id}/events`))
    void post(`/api/sessions/${madeA.id}/messages`, { content: 'mark A' })
    const framesA = await sseA.until((envelope) =>
      envelope.kind === 'session' && envelope.event.type === 'tool/result')
    const resultA = framesA.find((e): e is Extract<WebEnvelope, { kind: 'session' }> =>
      e.kind === 'session' && e.event.type === 'tool/result')
    expect(resultA?.event.type).toBe('tool/result')
    if (resultA?.event.type === 'tool/result') expect(resultA.event.ok).toBe(true)
    expect(await fs.readFile(path.join(dirA, 'mark.txt'), 'utf8')).toBe('from-A')

    const sseB = new SseReader(await fetch(`${baseUrl}/api/sessions/${madeB.id}/events`))
    void post(`/api/sessions/${madeB.id}/messages`, { content: 'mark B' })
    await sseB.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'tool/result')
    expect(await fs.readFile(path.join(dirB, 'mark.txt'), 'utf8')).toBe('from-B')

    // Session-scoped override beats switching mid-flight for one session only.
    const retarget = await fetch(`${baseUrl}/api/sessions/${madeB.id}/folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    })
    expect(retarget.status).toBe(200)
    const reset = await fetch(`${baseUrl}/api/sessions/${madeB.id}/folder`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '' }),
    })
    expect(reset.status).toBe(200)
  })
})

describe('folder picker directory browsing', () => {
  it('lists only child directories, sorted, with the parent; files and missing paths fail closed', async () => {
    await start([])
    const outer = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-dirs-'))
    try {
      await fs.mkdir(path.join(outer, 'beta'))
      await fs.mkdir(path.join(outer, 'Alpha'))
      await fs.writeFile(path.join(outer, 'file.txt'), 'x')
      await fs.mkdir(path.join(outer, 'Alpha', 'inner'))

      const res = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(outer)}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { path: string; parent: string | null; dirs: { name: string; path: string }[] }
      expect(body.path).toBe(outer)
      expect(body.parent).toBe(path.dirname(outer))
      expect(body.dirs.map((dir) => dir.name)).toEqual(['Alpha', 'beta'])

      const inner = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(body.dirs[0]!.path)}`)
      expect(inner.status).toBe(200)
      const innerBody = (await inner.json()) as { dirs: { name: string }[] }
      expect(innerBody.dirs.map((dir) => dir.name)).toEqual(['inner'])

      const file = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(outer, 'file.txt'))}`)
      expect(file.status).toBe(400)
      const missing = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(outer, 'nope'))}`)
      expect(missing.status).toBe(400)
    } finally {
      await fs.rm(outer, { recursive: true, force: true })
    }
  })

  it('defaults to the home directory when no path is given', async () => {
    await start([])
    const res = await fetch(`${baseUrl}/api/fs/dirs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { path: string; parent: string | null; dirs: unknown[] }
    expect(body.path).toBe(path.resolve(homedir()))
    expect(Array.isArray(body.dirs)).toBe(true)
  })
})

describe('static PWA files', () => {
  it('serves the manifest, icons, and a revalidating service worker and shell', async () => {
    const staticDir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-static-'))
    try {
      await fs.mkdir(path.join(staticDir, 'icons'))
      await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html>')
      await fs.writeFile(path.join(staticDir, 'sw.js'), 'self.addEventListener("fetch", () => {})')
      await fs.writeFile(path.join(staticDir, 'manifest.webmanifest'), '{"name":"mini-dsh"}')
      await fs.writeFile(path.join(staticDir, 'icons', 'icon-192.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      await start([], undefined, { staticDir })

      const manifest = await fetch(`${baseUrl}/manifest.webmanifest`)
      expect(manifest.headers.get('content-type')).toContain('application/manifest+json')
      expect(await manifest.json()).toEqual({ name: 'mini-dsh' })

      const icon = await fetch(`${baseUrl}/icons/icon-192.png`)
      expect(icon.headers.get('content-type')).toBe('image/png')

      const worker = await fetch(`${baseUrl}/sw.js`)
      expect(worker.headers.get('content-type')).toContain('text/javascript')
      expect(worker.headers.get('cache-control')).toBe('no-cache')

      const shell = await fetch(`${baseUrl}/some/client/route`)
      expect(shell.headers.get('content-type')).toContain('text/html')
      expect(shell.headers.get('cache-control')).toBe('no-cache')
    } finally {
      await fs.rm(staticDir, { recursive: true, force: true })
    }
  })
})
