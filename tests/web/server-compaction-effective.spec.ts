/**
 * Effective compaction through the real web server (rollout switch ON): the
 * exact request of the last completed turn is captured, persisted, and one
 * handoff summary replaces the old folding. Real server, real log on disk,
 * scripted provider.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'

const SUMMARY = 'EFFECTIVE HANDOFF SUMMARY'
const LEGACY_MARK = 'Primary Request and Intent'

function provider(options: { replies?: readonly string[]; tool?: boolean } = {}): { provider: LlmProvider; requests: ModelRequest[] } {
  const requests: ModelRequest[] = []
  let turn = 0
  const llm: LlmProvider = {
    name: 'scripted',
    models: ['scripted'],
    stream(request) {
      requests.push(request)
      const text = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      const handoff = text.includes(COMPACTION_HANDOFF_MARKER)
      const legacy = text.includes(LEGACY_MARK)
      return (async function* (): AsyncIterable<StreamEvent> {
        yield { type: 'delta', delta: handoff ? SUMMARY : legacy ? 'LEGACY SUMMARY' : (options.replies?.[turn++] ?? 'turn reply') }
        yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      })()
    },
  }
  return { provider: llm, requests }
}

const servers: WebServer[] = []
const homes = new Map<WebServer, string>()
afterAll(async () => {
  for (const server of servers) await server.close().catch(() => {})
  for (const server of servers) {
    const home = homes.get(server)
    if (home !== undefined) await fs.rm(home, { recursive: true, force: true }).catch(() => {})
  }
})

async function start(llm: LlmProvider, limits: Partial<HarnessLimits>): Promise<{ server: WebServer; home: string; base: string; wsId: string }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-effective-'))
  const server = await createWebServer({ home, providers: [llm], configFile: path.join(home, 'p.json'), limits })
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

async function completedMessage(base: string, wsId: string, id: string, logPath: string, content: string, turns: number): Promise<void> {
  const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) })
  expect(response.ok).toBe(true)
  await until(async () => {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '')
    const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
    const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
    return ended === turns && sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
  })
}

const readLog = async (logPath: string): Promise<Record<string, unknown>[]> =>
  (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

describe('effective compaction through the web server', () => {
  it('compacts with ONE handoff request instead of folding the transcript', async () => {
    const { provider: llm, requests } = provider({ replies: ['answer one', 'answer two', 'answer three'] })
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first question', 1)
    await completedMessage(base, wsId, id, logPath, 'second question', 2)
    const before = requests.length

    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    const body = await response.json() as { coversSeq: number; summaryChars: number; path?: string }
    expect(body.summaryChars).toBe(SUMMARY.length)
    expect(body.path).toBe('exact')

    const summaryCalls = requests.slice(before)
    expect(summaryCalls).toHaveLength(1)
    const sent = summaryCalls[0]!
    // It carries the live conversation — the user's own words — not a flattened transcript.
    expect(sent.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('first question'))).toBe(true)
    expect(sent.messages.some((m) => m.role === 'assistant' && m.content === 'answer two')).toBe(true)
    expect(String(sent.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
    expect(sent.messages.every((m) => typeof m.content !== 'string' || !m.content.includes('<conversation>'))).toBe(true)

    const log = await readLog(logPath)
    const end = log.findLast((event) => event.type === 'compaction/end')!
    expect(end).toMatchObject({ summary: SUMMARY, adoption: { v: 1 } })
    // A durable reference to the snapshot it came from.
    expect(log.some((event) => event.type === 'context/snapshot')).toBe(true)
  })

  it('reports the size of the window the new checkpoint leaves, not a fixed fraction of the old one', async () => {
    // The handoff is 12k characters (~3k tokens). The provider reported 1k prompt tokens for the
    // whole tiny conversation, so the checkpoint makes the window bigger: a fixed 20% of 1k
    // (200 tokens) would claim the opposite.
    const big = 'x'.repeat(12_000)
    const requests: ModelRequest[] = []
    const llm: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      stream(request) {
        requests.push(request)
        const text = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
        return (async function* (): AsyncIterable<StreamEvent> {
          yield { type: 'delta', delta: text.includes(COMPACTION_HANDOFF_MARKER) ? big : 'turn reply' }
          yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'one exchange', 1)
    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).status).toBe(200)
    const end = (await readLog(logPath)).findLast((event) => event.type === 'compaction/end') as { tokensBefore?: number; tokensAfter?: number }
    expect(end.tokensBefore).toBe(1_000)
    expect(end.tokensAfter).toBeGreaterThan(2_500)
  })

  it('restores the task list and the CURRENT file the conversation worked on, durably, and the next request carries them', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-restore-project-')))
    const requests: ModelRequest[] = []
    let step = 0
    const llm: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      stream(request) {
        requests.push(request)
        const text = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
        return (async function* (): AsyncIterable<StreamEvent> {
          if (text.includes(COMPACTION_HANDOFF_MARKER)) {
            yield { type: 'delta', delta: SUMMARY }
          } else if (step === 0) {
            step = 1
            yield { type: 'toolCalls', calls: [
              { id: 'todo-1', name: 'TodoWrite', args: { todos: [{ content: 'Finish the migration', status: 'in_progress', activeForm: 'Finishing' }] } },
              { id: 'read-1', name: 'Read', args: { path: 'notes.txt' } },
            ] }
            yield { type: 'usage', usage: { inputTokens: 500, outputTokens: 10 } }
            yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
            return
          } else {
            yield { type: 'delta', delta: 'all done' }
          }
          yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    await fs.writeFile(path.join(root, 'notes.txt'), 'version ONE of the notes\n')
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true })
    const projectId = String((await (await fetch(`${base}/api/workspaces/${wsId}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'P', path: root }) })).json() as { id: string }).id)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId }) })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'migrate the data', 1)
    // The file changes after the model read it.
    await fs.writeFile(path.join(root, 'notes.txt'), `version TWO of the notes\n${'p'.repeat(14_000)}\n`)

    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).status).toBe(200)
    const log = await readLog(logPath)
    const restoration = log.find((event) => event.type === 'compaction/restoration') as { body: string; coversSeq: number } | undefined
    expect(restoration?.body).toContain('Finish the migration')
    expect(restoration?.body).toContain('version TWO of the notes')
    expect(restoration?.body).not.toContain('version ONE')
    const order = log.map((event) => event.type).filter((type) => String(type).startsWith('compaction/') && type !== 'compaction/job')
    expect(order).toEqual(['compaction/start', 'compaction/restoration', 'compaction/end'])
    // The restored file (~3.5k tokens) rides in the next request, so the window it leaves
    // cannot be smaller than that, even though the log only ever held the short first read.
    const end = log.findLast((event) => event.type === 'compaction/end') as { tokensAfter?: number }
    expect(end.tokensAfter).toBeGreaterThan(3_000)

    await completedMessage(base, wsId, id, logPath, 'continue', 2)
    const joined = requests.at(-1)!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    expect(joined).toContain('Finish the migration')
    expect(joined).toContain('version TWO of the notes')

    // The browser gets what happened to each piece of state, never the restored file text itself:
    // a fresh connection must not replay up to 25k tokens of file contents it has no use for.
    const abort = new AbortController()
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/events`, { signal: abort.signal })
    const reader = response.body!.getReader()
    let text = ''
    while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
    abort.abort()
    const envelope = JSON.parse(text.split('\n\n')[0]!.split('\n').find((line) => line.startsWith('data: '))!.slice(6)) as { events: Record<string, unknown>[] }
    const wire = envelope.events.find((event) => event.type === 'compaction/restoration')
    expect(wire).toBeDefined()
    expect(wire).not.toHaveProperty('body')
    expect(wire!['sections']).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'file', name: 'notes.txt', status: 'included' }), expect.objectContaining({ kind: 'todo' })]))
    expect(JSON.stringify(envelope)).not.toContain('version TWO of the notes')
    await fs.rm(root, { recursive: true, force: true })
  })

  it('the next request reads the checkpoint, and the turn that closed after it is still verbatim', async () => {
    const { provider: llm, requests } = provider({ replies: ['answer one', 'answer two'] })
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first question', 1)
    expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(200)
    await completedMessage(base, wsId, id, logPath, 'continue please', 2)
    const next = requests.at(-1)!
    const joined = next.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    expect(joined).toContain(SUMMARY)
    expect(joined).toContain('continue please')
  })

  it('compacting again at the same boundary is a no-op: no model call, no new lifecycle events', async () => {
    const { provider: llm, requests } = provider()
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'only exchange', 1)
    const first = await (await fetch(`${route}/compact`, { method: 'POST' })).json() as { coversSeq: number }
    const calls = requests.length
    // The canonical lifecycle, not the progress events: a no-op still reports that it began and ended.
    const lifecycle = async (): Promise<number> => (await readLog(logPath)).filter((event) => event.type !== 'compaction/job').length
    const events = await lifecycle()
    const again = await (await fetch(`${route}/compact`, { method: 'POST' })).json() as { coversSeq: number }
    expect(again.coversSeq).toBe(first.coversSeq)
    expect(requests.length).toBe(calls)
    expect(await lifecycle()).toBe(events)
  })

  it('a session whose turns were never captured answers 409 with a fingerprint, calls nothing, and a confirmed echo runs the recovery', async () => {
    const { provider: llm, requests } = provider()
    // First server writes a real session, then goes away. The turns were produced by an older
    // host: nothing was captured and no snapshot exists. A second server over the same home must
    // ask for recovery rather than fold on its own.
    const first = await start(llm, {})
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'old question', 1)
    await first.server.close()
    homes.delete(first.server)
    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)
    const route = `${server.url}/api/workspaces/${first.wsId}/sessions/${id}`
    const calls = requests.length
    const response = await fetch(`${route}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    const body = await response.json() as { error?: string; recovery?: { cutoff: number; sourceDigest: string; estimatedCalls: number } }
    expect(body.recovery).toMatchObject({ cutoff: expect.any(Number), sourceDigest: expect.any(String), estimatedCalls: expect.any(Number) })
    expect(requests.length).toBe(calls)
    // A stale echo is refused and calls nothing.
    const stale = await fetch(`${route}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: { ...body.recovery, sourceDigest: 'stale' } }) })
    expect(stale.status).toBe(409)
    expect(requests.length).toBe(calls)
    // The honest echo runs the proven fold.
    const confirmed = await fetch(`${route}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: body.recovery }) })
    expect(confirmed.status).toBe(200)
    expect(requests.slice(calls).some((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(LEGACY_MARK)))).toBe(true)
  })

  it('after a RESTART the snapshot is reloaded from its sidecar: one handoff request, no recovery prompt', async () => {
    const { provider: llm, requests } = provider({ replies: ['answer one'] })
    const first = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'before the restart', 1)
    expect((await readLog(logPath)).some((event) => event.type === 'context/snapshot')).toBe(true)
    await first.server.close()

    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)
    const calls = requests.length
    const response = await fetch(`${server.url}/api/workspaces/${first.wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json() as { path?: string }).path).toBe('exact')
    const summaryCalls = requests.slice(calls)
    expect(summaryCalls).toHaveLength(1)
    expect(String(summaryCalls[0]!.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
  })

  it('after a restart with the sidecar GONE it asks for recovery instead of guessing', async () => {
    const { provider: llm, requests } = provider({ replies: ['answer one'] })
    const first = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'before the restart', 1)
    await first.server.close()
    await fs.rm(path.join(first.home, 'workspaces', id, 'snapshots'), { recursive: true, force: true })

    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)
    const calls = requests.length
    const response = await fetch(`${server.url}/api/workspaces/${first.wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ recovery: { cutoff: expect.any(Number), sourceDigest: expect.any(String) } })
    expect(requests.length).toBe(calls)
  })

  it('with the rollout switch OFF it behaves exactly as before: the legacy fold, no snapshot', async () => {
    const { provider: llm, requests } = provider()
    const { home, base, wsId } = await start(llm, {})
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    const before = requests.length
    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).status).toBe(200)
    const sent = requests.slice(before)
    expect(sent.length).toBeGreaterThanOrEqual(1)
    expect(sent.every((r) => r.messages.every((m) => typeof m.content !== 'string' || !m.content.includes(COMPACTION_HANDOFF_MARKER)))).toBe(true)
    expect((await readLog(logPath)).some((event) => event.type === 'context/snapshot')).toBe(false)
  })
})
