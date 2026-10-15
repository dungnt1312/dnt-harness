/**
 * A background child over the real web host: the root's turn closes without
 * waiting for it, the child keeps running, and its report later wakes the idle
 * root as a continuation — never a user message, never a second time.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, messageText, withoutSentStamp, type LlmProvider, type WebServer } from 'dnt-harness'

const servers: WebServer[] = []
afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
})

async function post(base: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

async function snapshot(base: string, workspaceId: string, sessionId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${base}/api/workspaces/${workspaceId}/sessions/${sessionId}/events`)
  const reader = (response.body as ReadableStream).getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return []
      buffer += decoder.decode(chunk.value, { stream: true })
      const boundary = buffer.indexOf('\n\n')
      if (boundary < 0) continue
      const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
      if (data === undefined) continue
      const envelope = JSON.parse(data.slice(6)) as { kind: string; events?: Record<string, unknown>[] }
      return envelope.kind === 'snapshot' ? (envelope.events ?? []) : []
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('condition not met in time')
}

describe('background child over the web host', () => {
  it('outlives the root turn and wakes the idle root once with its report', async () => {
    let releaseChild: () => void = () => {}
    const childMayFinish = new Promise<void>((resolve) => { releaseChild = resolve })
    const rootSeen: string[] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      async *stream(request) {
        const system = request.messages.filter((message) => message.role === 'system').map((message) => messageText(message.content)).join('\n')
        const last = request.messages.at(-1)
        const text = last === undefined ? '' : withoutSentStamp(messageText(last.content))
        if (system.includes('You implement')) {
          // The child (bundled worker role): finishes only when released.
          await childMayFinish
          yield { type: 'delta', delta: 'BACKGROUND-REPORT' }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        rootSeen.push(text)
        if (last?.role === 'user' && text === 'start it') {
          yield { type: 'toolCalls', calls: [{ id: 'a1', name: 'Agent', args: { definition: 'worker', prompt: 'Long job.', background: true } }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
          return
        }
        yield { type: 'delta', delta: `root answer ${rootSeen.length}` }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bg-wake-'))
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'providers.json') })
    servers.push(server)
    const base = server.url
    const wsId = ((await (await fetch(`${base}/api/workspaces`)).json()) as { id: string }[])[0]!.id
    await fetch(`${base}/api/workspaces/${wsId}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const folder = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-bg-wake-project-'))
    const projectId = ((await (await post(base, `/api/workspaces/${wsId}/projects`, { name: 'p', path: folder })).json()) as { id: string }).id
    const session = (await (await post(base, `/api/workspaces/${wsId}/sessions`, { projectId })).json()) as { id: string }

    await post(base, `/api/workspaces/${wsId}/sessions/${session.id}/messages`, { content: 'start it' })
    // The root's turn completes while the child is still blocked.
    await waitFor(async () => (await snapshot(base, wsId, session.id)).filter((event) => event.type === 'turn/end').length >= 1)
    const first = await snapshot(base, wsId, session.id)
    expect(first.find((event) => event.type === 'turn/end')).toMatchObject({ reason: 'completed' })
    expect(first.some((event) => event.type === 'agent/child-result')).toBe(false)

    releaseChild()
    await waitFor(async () => (await snapshot(base, wsId, session.id)).filter((event) => event.type === 'turn/end').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const events = await snapshot(base, wsId, session.id)
    const report = events.filter((event) => event.type === 'user/message' && String(event.content).includes('BACKGROUND-REPORT'))
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ origin: 'continuation' })
    expect(events.find((event) => event.type === 'input/queued' && event.origin === 'child')).toBeTruthy()
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(2)
    expect(rootSeen.at(-1)).toContain('BACKGROUND-REPORT')
  }, 30_000)
})
