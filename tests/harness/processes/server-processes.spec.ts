/**
 * Server wiring for background processes: REST routes, the durable event
 * bridge (process/start + process/exit on the session log), silent dispose
 * on session delete, and the first-read reconcile that closes ids a restart
 * left open with a synthetic `interrupted` exit.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebEnvelope, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from '../../support/fake-llm.ts'

let root = ''
let server: WebServer
let baseUrl = ''
let startCount = 0

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-proc-'))
})

afterAll(async () => {
  await server?.close()
  await fs.rm(root, { recursive: true, force: true })
})

/** Start a server with the scripted provider against the temp data home. */
async function start(steps: readonly (string | { toolCalls: readonly { name: string; args: Record<string, unknown> }[] })[], provider?: LlmProvider): Promise<void> {
  // The data home allows one live owner: retire the previous server first.
  await server?.close()
  server = await createWebServer({ home: root, providers: [provider ?? new FakeScriptedLlm(steps)], configFile: path.join(root, `providers-${startCount++}.json`) })
  baseUrl = server.url
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''
  private closed = false

  constructor(response: Response) {
    const body = response.body
    if (body === null) throw new Error('test setup: no SSE body')
    this.reader = body.getReader()
  }

  async until(until: (envelope: WebEnvelope) => boolean, timeoutMs = 15_000): Promise<WebEnvelope[]> {
    const seen: WebEnvelope[] = []
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timeout waiting for envelope; saw ${JSON.stringify(seen.map((e) => e.kind))}`)
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

  dispose(): void {
    if (!this.closed) {
      this.closed = true
      void this.reader.cancel()
    }
  }
}

async function post(pathname: string, body?: unknown): Promise<Response> {
  return await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

/** Project-scoped session: the only setup that grants the Bash tool a root. */
async function bootProjectSession(): Promise<{ ws: string; sessionId: string; projectPath: string }> {
  const listed = (await (await fetch(`${baseUrl}/api/workspaces`)).json()) as { id: string }[]
  const existing = listed[0]?.id
  const ws = existing ?? ((await (await post('/api/workspaces', { name: 'proc-test' })).json()) as { id: string }).id
  const projectPath = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-proc-p-'))
  const project = (await (await post(`/api/workspaces/${ws}/projects`, { path: projectPath })).json()) as { id: string }
  const session = (await (await post(`/api/workspaces/${ws}/sessions`, { projectId: project.id })).json()) as { id: string }
  return { ws, sessionId: session.id, projectPath }
}

interface Booted {
  ws: string
  sessionId: string
  sse: SseReader
}

/** Run one scripted turn that starts `sleep 60` in the background. */
async function runBackgroundTurn(): Promise<Booted> {
  await start([
    { toolCalls: [{ name: 'Bash', args: { command: 'sleep 60', run_in_background: true } }] },
    'started in the background',
  ])
  const { ws, sessionId } = await bootProjectSession()
  const sse = new SseReader(await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/events`))
  void post(`/api/workspaces/${ws}/sessions/${sessionId}/messages`, { content: 'run sleep 60 in the background' })
  const approvalFrame = await sse.until((envelope) => envelope.kind === 'approval')
  const question = approvalFrame.find((e) => e.kind === 'approval')
  if (question?.kind !== 'approval') throw new Error('test setup: no approval frame')
  const allow = await post(`/api/approvals/${question.approvalId}`, { allow: true })
  expect(allow.status).toBe(200)
  await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
  return { ws, sessionId, sse }
}

describe('background process routes', () => {
  it('GET lists an empty snapshot for a fresh session', async () => {
    await start(['idle'])
    const { ws, sessionId } = await bootProjectSession()
    const res = await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('POST stop on an unknown id is 404; an unknown session is 404', async () => {
    await start(['idle'])
    const { ws, sessionId } = await bootProjectSession()
    expect((await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes/proc_missing/stop`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/sess_missing/processes/proc_x/stop`, { method: 'POST' })).status).toBe(404)
  })

  it('a background Bash call appends process/start, lists in GET, stops with 200 then 409', async () => {
    const { ws, sessionId, sse } = await runBackgroundTurn()
    try {
      const rows = (await (await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes`)).json()) as { id: string; status: string }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe('running')

      const stop = await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes/${rows[0]?.id}/stop`, { method: 'POST' })
      expect(stop.status).toBe(200)
      expect(await stop.json()).toMatchObject({ stopped: true })

      const envelopes = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'process/exit')
      const exit = envelopes.find((e): e is Extract<WebEnvelope, { kind: 'session' }> & { event: { type: 'process/exit'; termination?: string } } => e.kind === 'session' && e.event.type === 'process/exit')
      expect(exit?.event.termination).toBe('killed')

      const again = await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes/${rows[0]?.id}/stop`, { method: 'POST' })
      expect(again.status).toBe(409)
    } finally {
      sse.dispose()
    }
  }, 30_000)

  it('GET detail returns one process with its captured output; unknown id is 404', async () => {
    const { ws, sessionId, sse } = await runBackgroundTurn()
    try {
      const rows = (await (await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes`)).json()) as { id: string; status: string }[]
      const detail = await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes/${rows[0]?.id}`)
      expect(detail.status).toBe(200)
      const body = (await detail.json()) as { id: string; status: string; command: string; output: string; outputTruncated: boolean }
      expect(body.id).toBe(rows[0]?.id)
      expect(body.status).toBe('running')
      expect(body.command).toContain('sleep')
      expect(typeof body.output).toBe('string')
      expect(body.outputTruncated).toBe(false)
      expect((await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes/proc_missing`)).status).toBe(404)
    } finally {
      sse.dispose()
    }
  }, 30_000)

  it('deleting a session succeeds while a background process runs (silent dispose)', async () => {
    const { ws, sessionId, sse } = await runBackgroundTurn()
    try {
      const rows = (await (await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/processes`)).json()) as { id: string }[]
      expect(rows).toHaveLength(1)
      // turn/end is emitted before the driver's final idle transition.
      // Await the runner, not merely the SSE record, before testing idle deletion.
      const driver = server.kernel.ctx.agents.create(await server.kernel.ctx.sessions.load(sessionId as never))
      const deadline = Date.now() + 5000
      while (driver.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
      expect(driver.busy).toBe(false)
      const del = await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      expect((await del.json()).deleted).toBe(true)
    } finally {
      sse.dispose()
    }
  }, 30_000)

  it('a restart left-open process/start is closed as interrupted on first read', async () => {
    // Server 1: start a real background process; its log keeps the start open.
    const first = await runBackgroundTurn()
    first.sse.dispose()
    const { ws, sessionId } = first
    await server.close()

    // Server 2 on the same data home: fresh registry, same durable log. The
    // first events read must surface a synthetic interrupted exit — it lands
    // before the snapshot is framed, so the snapshot itself carries it.
    await start(['idle after restart'])
    const sse = new SseReader(await fetch(`${baseUrl}/api/workspaces/${ws}/sessions/${sessionId}/events`))
    try {
      const envelopes = await sse.until((envelope) => {
        if (envelope.kind === 'session' && envelope.event.type === 'process/exit') return true
        const events = (envelope as { events?: { type: string }[] }).events
        return envelope.kind !== 'session' && Array.isArray(events) && events.some((event) => event.type === 'process/exit')
      })
      const exits = envelopes.flatMap((envelope) => {
        if (envelope.kind === 'session' && envelope.event.type === 'process/exit') {
          return [envelope.event as { termination?: string }]
        }
        const events = (envelope as { events?: { type: string; termination?: string }[] }).events
        return events?.filter((event) => event.type === 'process/exit') ?? []
      })
      expect(exits.at(-1)?.termination).toBe('interrupted')
    } finally {
      sse.dispose()
    }
  }, 30_000)
})
