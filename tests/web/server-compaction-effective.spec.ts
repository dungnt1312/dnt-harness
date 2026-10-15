/**
 * Effective compaction through the real web server (rollout switch ON): the
 * exact request of the last completed turn is captured, persisted, and one
 * handoff summary replaces the old folding. Real server, real log on disk,
 * scripted provider.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'
import { AttachmentStore } from '../../src/harness/attachments/store.ts'
import { ProviderError, type ModelCompletion, type ModelRequest, type StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'
import { COMPACTION_HANDOFF_MARKER } from '../../src/web/compaction-generator.ts'

const SUMMARY = 'EFFECTIVE HANDOFF SUMMARY'
const LEGACY_MARK = 'Primary Request and Intent'
const STOP: ModelCompletion = { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
const joined = (request: ModelRequest): string => request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')

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

async function start(llm: LlmProvider | readonly LlmProvider[], limits: Partial<HarnessLimits>, home?: string): Promise<{ server: WebServer; home: string; base: string; wsId: string }> {
  home ??= await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-effective-'))
  const server = await createWebServer({ home, providers: [llm].flat(), configFile: path.join(home, 'p.json'), limits })
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

/** A home whose providers.json configures `scripted` too, so its context override can be PATCHed live. */
async function configuredHome(contextTokens?: number): Promise<string> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-effective-'))
  await fs.writeFile(path.join(home, 'p.json'), JSON.stringify({
    version: 2,
    defaults: { provider: 'scripted', model: 'scripted', thinkingLevel: null },
    providers: [{ id: 'scripted', name: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['scripted'], enabled: true,
      ...(contextTokens !== undefined ? { modelSettings: { scripted: { contextTokens } } } : {}) }],
    aliases: [], aliasGeneration: 0,
  }))
  return home
}

/** One completed exchange that references an attachment, so every later context build loads attachments. */
async function exchangeWithAttachment(base: string, wsId: string, id: string, logPath: string): Promise<void> {
  const upload = await fetch(`${base}/api/workspaces/${wsId}/attachments`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': 'a.txt' }, body: new TextEncoder().encode('ATTACHMENT A') })
  expect(upload.status).toBe(201)
  const ref = await upload.json() as { id: string }
  await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'with file', attachments: [ref] }) })
  await until(async () => {
    const log = await fs.readFile(logPath, 'utf8').catch(() => '')
    const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
    const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
    return ended === 1 && sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
  })
}

describe('compaction fails closed on an unverified fit, and on a context that changed under the preview', () => {
  it.each([
    // Effective: the preview is the only attachment reader. Legacy: the fold reads the delta first.
    ['effective', true, 0],
    ['legacy', false, 1],
  ] as const)('%s: a preview whose preparation throws', async (name, effective, spared) => {
    const { provider: llm } = provider()
    const { home, base, wsId } = await start(llm, effective ? { compactionEffectiveEnabled: true } : {})
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await exchangeWithAttachment(base, wsId, id, logPath)
    let calls = 0
    const original = AttachmentStore.prototype.load
    const load = vi.spyOn(AttachmentStore.prototype, 'load').mockImplementation(function (this: AttachmentStore, ...args) {
      if (calls++ >= spared) throw new Error('attachment store offline')
      return original.apply(this, args)
    })
    try {
      const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
      const ends = (await readLog(logPath)).filter((event) => event.type === 'compaction/end')
      if (name === 'effective') {
        // No positive evidence that the next request fits: nothing is adopted.
        expect(response.status).toBe(409)
        expect(ends.some((event) => event.error === undefined)).toBe(false)
        expect(ends.at(-1)).toMatchObject({ error: expect.any(String) })
        expect(ends.some((event) => event.contextAfter !== undefined)).toBe(false)
      } else {
        // Legacy keeps its behavior: success, with the measurement marked unavailable.
        expect(response.status).toBe(200)
        expect(ends.at(-1)).toMatchObject({ contextEffect: 'replaced', measurement: { unavailableReason: 'preview-failed' } })
        expect(ends.at(-1)!.contextAfter).toBeUndefined()
      }
    } finally { load.mockRestore() }
  })

  it.each([
    ['effective', true, 0],
    ['legacy', false, 1],
  ] as const)('%s: an operator context override changed while the preview awaited fails with "context revision changed"; unchanged commits', async (_name, effective, spared) => {
    const { provider: llm } = provider()
    const { home, base, wsId } = await start(llm, effective ? { compactionEffectiveEnabled: true } : {}, await configuredHome(100_000))
    const run = async (change: boolean): Promise<{ status: number; body: { error?: string }; ends: Record<string, unknown>[] }> => {
      const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
      const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
      await exchangeWithAttachment(base, wsId, id, logPath)
      let calls = 0
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const waiting = new Promise<void>((resolve) => { entered = resolve })
      const original = AttachmentStore.prototype.load
      const load = vi.spyOn(AttachmentStore.prototype, 'load').mockImplementation(async function (this: AttachmentStore, ...args) {
        if (calls++ >= spared) { entered(); await gate }
        return original.apply(this, args)
      })
      try {
        const pending = fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
        await waiting
        if (change) {
          const patched = await fetch(`${base}/api/providers/scripted`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modelSettings: { scripted: { contextTokens: 64_000 } } }) })
          expect(patched.status).toBe(200)
        }
        release()
        const response = await pending
        return { status: response.status, body: await response.json() as { error?: string }, ends: (await readLog(logPath)).filter((event) => event.type === 'compaction/end') }
      } finally { load.mockRestore() }
    }
    const unchanged = await run(false)
    expect(unchanged.status).toBe(200)
    expect(unchanged.ends.at(-1)!.error).toBeUndefined()
    const changed = await run(true)
    expect(changed.status).toBe(409)
    expect(changed.body.error).toMatch(/context revision changed/)
    expect(changed.ends.some((event) => event.error === undefined)).toBe(false)
  })
})

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

  it('a session whose turns were never captured is rebuilt from the log: ONE handoff request, no fold, no trace', async () => {
    const { provider: llm, requests } = provider({ replies: ['old answer'] })
    // First server writes a real session, then goes away. The turns were produced by an older
    // host: nothing was captured and no snapshot exists. A second server over the same home
    // rebuilds the request from the log instead of folding the transcript.
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
    const before = await readLog(logPath)
    const calls = requests.length
    const response = await fetch(`${route}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect((await response.json() as { path?: string }).path).toBe('reconstructed')
    const sent = requests.slice(calls)
    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
    expect(sent.some((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(LEGACY_MARK)))).toBe(false)
    expect(sent[0]!.messages.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('old question'))).toBe(true)
    // The final answer rides once, as the answer, never also as history.
    expect(sent[0]!.messages.filter((m) => m.role === 'assistant' && m.content === 'old answer')).toHaveLength(1)
    const after = await readLog(logPath)
    const job = after.findLast((event) => event.type === 'compaction/job')
    expect(job).toMatchObject({ stage: 'ended', outcome: 'compacted', path: 'reconstructed' })
    // Rebuilding the request leaves no trace: no manifest, no body, only the compaction's own events.
    const count = (log: Record<string, unknown>[], type: string): number => log.filter((event) => event.type === type).length
    expect(count(after, 'context/manifest')).toBe(count(before, 'context/manifest'))
    expect(count(after, 'context/body')).toBe(count(before, 'context/body'))
    expect(after.slice(before.length).every((event) => String(event.type).startsWith('compaction/'))).toBe(true)
  })

  it('a stopped last turn does not force a fold: the completed turn before it is summarized, the stopped one stays verbatim', async () => {
    const requests: ModelRequest[] = []
    let turn = 0
    const llm: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      stream(request, options) {
        requests.push(request)
        const text = request.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
        const handoff = text.includes(COMPACTION_HANDOFF_MARKER)
        const call = handoff ? -1 : turn++
        return (async function* (): AsyncIterable<StreamEvent> {
          if (call === 1) {
            // The second turn hangs until the user presses Stop.
            await new Promise<void>((_resolve, reject) => {
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
            })
          }
          yield { type: 'delta', delta: handoff ? SUMMARY : call === 0 ? 'answer one' : 'turn reply' }
          yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const first = await start(llm, {})
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const firstRoute = `${first.base}/api/workspaces/${first.wsId}/sessions/${id}`
    const logPath = path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'first question', 1)
    expect((await fetch(`${firstRoute}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'second question STOPPED' }) })).ok).toBe(true)
    await until(async () => (requests.length >= 2 ? true : undefined))
    await fetch(`${firstRoute}/stop`, { method: 'POST' })
    await until(async () => {
      const log = await readLog(logPath)
      const ends = log.filter((event) => event.type === 'turn/end')
      const sessions = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`)).json() as { id: string; status: string }[]
      return ends.length === 2 && sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
    })
    await first.server.close()
    homes.delete(first.server)
    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)

    const log = await readLog(logPath)
    const ends = log.filter((event) => event.type === 'turn/end') as { seq: number; reason: string }[]
    expect(ends.map((end) => end.reason)).toEqual(['completed', 'cancelled'])
    const calls = requests.length
    const response = await fetch(`${server.url}/api/workspaces/${first.wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'reconstructed', coversSeq: ends[0]!.seq })
    const sent = requests.slice(calls)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.messages.some((m) => typeof m.content === 'string' && m.content.includes('second question STOPPED'))).toBe(false)

    await completedMessage(server.url, first.wsId, id, logPath, 'third question', 3)
    const joined = requests.at(-1)!.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
    expect(joined).toContain(SUMMARY)
    expect(joined).toContain('second question STOPPED')
  })

  it('an older client that still posts a recovery echo is served the same way: the body changes nothing', async () => {
    const { provider: llm } = provider()
    const first = await start(llm, {})
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    await completedMessage(first.base, first.wsId, id, path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl'), 'old question', 1)
    await first.server.close()
    homes.delete(first.server)
    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)
    const response = await fetch(`${server.url}/api/workspaces/${first.wsId}/sessions/${id}/compact`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery: { cutoff: 1, sourceDigest: 'stale', estimatedCalls: 6 } }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'reconstructed' })
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

  it('after a restart with the sidecar GONE it rebuilds the request from the log: one handoff request', async () => {
    const { provider: llm, requests } = provider({ replies: ['answer one'] })
    const first = await start(llm, { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(first.home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'before the restart', 1)
    await first.server.close()
    // Regression: compaction sidecars must not land under workspaces/ (boot adopts them as workspaces).
    expect((await fs.readdir(path.join(first.home, 'workspaces'))).filter((name) => name.startsWith('session-'))).toEqual([])
    await fs.rm(path.join(first.home, 'compaction', id, 'snapshots'), { recursive: true, force: true })

    const server = await createWebServer({ home: first.home, providers: [llm], configFile: path.join(first.home, 'p.json'), limits: { compactionEffectiveEnabled: true } })
    servers.push(server)
    homes.set(server, first.home)
    const calls = requests.length
    const response = await fetch(`${server.url}/api/workspaces/${first.wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'reconstructed' })
    const summaryCalls = requests.slice(calls)
    expect(summaryCalls).toHaveLength(1)
    expect(String(summaryCalls[0]!.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
  })

  it('the handoff and its condense request go to the SESSION\'s provider and model, not the global default', async () => {
    const seen: { name: string; request: ModelRequest }[] = []
    const make = (name: string, model: string): LlmProvider => ({
      name,
      models: [model],
      stream(request) {
        seen.push({ name, request })
        const text = joined(request)
        const reply = text.includes(COMPACTION_HANDOFF_MARKER) ? 'h'.repeat(30_000) : text.includes('Compress this coding-session handoff') ? SUMMARY : 'turn reply'
        return (async function* (): AsyncIterable<StreamEvent> {
          yield { type: 'delta', delta: reply }
          yield { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 20 } }
          yield STOP
        })()
      },
    })
    // alpha/a1 is the global default; the session picks beta/b1.
    const { home, base, wsId } = await start([make('alpha', 'a1'), make('beta', 'b1')], { compactionEffectiveEnabled: true })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    expect((await fetch(`${route}/model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'beta', model: 'b1' }) })).status).toBe(200)
    await completedMessage(base, wsId, id, path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl'), 'first question', 1)
    const before = seen.length
    const response = await fetch(`${route}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'exact', summaryChars: SUMMARY.length })
    const sent = seen.slice(before)
    expect(sent).toHaveLength(2)
    for (const { name, request } of sent) {
      expect(name).toBe('beta')
      expect(request).toMatchObject({ providerName: 'beta', model: 'b1' })
    }
  })

  it('a transient provider error before any output is retried: the handoff still takes one logical request', async () => {
    let failures = 1
    let handoffs = 0
    const llm: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      stream(request) {
        const handoff = joined(request).includes(COMPACTION_HANDOFF_MARKER)
        if (handoff) handoffs++
        return (async function* (): AsyncIterable<StreamEvent> {
          if (handoff && failures-- > 0) throw new ProviderError('gateway reset', { transient: true })
          yield { type: 'delta', delta: handoff ? SUMMARY : 'turn reply' }
          yield STOP
        })()
      },
    }
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true, stepRetryBaseMs: 1 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first question', 1)
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'exact' })
    expect(handoffs).toBe(2)
    expect((await readLog(logPath)).findLast((event) => event.type === 'compaction/job')).toMatchObject({ stage: 'ended', outcome: 'compacted', requests: 2 })
  })

  it('a non-retryable provider error fails the handoff at once, without a retry or a fold', async () => {
    let handoffs = 0
    const llm: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      stream(request) {
        const handoff = joined(request).includes(COMPACTION_HANDOFF_MARKER)
        if (handoff) handoffs++
        return (async function* (): AsyncIterable<StreamEvent> {
          if (handoff) throw new ProviderError('bad request', { status: 400 })
          yield { type: 'delta', delta: 'turn reply' }
          yield STOP
        })()
      },
    }
    const { home, base, wsId } = await start(llm, { compactionEffectiveEnabled: true, stepRetryBaseMs: 1 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    await completedMessage(base, wsId, id, path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl'), 'first question', 1)
    expect((await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).status).toBe(409)
    expect(handoffs).toBe(1)
  })

  it('a session near the auto-compact threshold with no capture is rebuilt and summarized in ONE request, not folded', async () => {
    const WINDOW = 60_000
    const { provider: llm, requests } = provider({ replies: ['short answer', 'long answer'] })
    // An operator context override on the scripted provider makes the window small.
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-effective-'))
    await fs.writeFile(path.join(home, 'p.json'), JSON.stringify({
      version: 2,
      defaults: { provider: 'scripted', model: 'scripted', thinkingLevel: null },
      providers: [{ id: 'scripted', name: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', models: ['scripted'], enabled: true, modelSettings: { scripted: { contextTokens: WINDOW } } }],
      aliases: [], aliasGeneration: 0,
    }))
    const first = await start(llm, {}, home)
    const { id } = await (await fetch(`${first.base}/api/workspaces/${first.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${first.base}/api/workspaces/${first.wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', first.wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(first.base, first.wsId, id, logPath, 'hello', 1)
    const budget = async (): Promise<{ usedTokens: number; availableTokens: number }> => ((await (await fetch(`${route}/manifest`)).json()) as { budget: { usedTokens: number; availableTokens: number } }).budget
    const baseline = await budget()
    expect(baseline.availableTokens).toBe(WINDOW - 4_096 - 1_024)
    // Fill the conversation to ~85% of the window, as the automatic trigger would see it.
    const fill = Math.floor(0.85 * baseline.availableTokens) - baseline.usedTokens
    await completedMessage(first.base, first.wsId, id, logPath, 'w'.repeat(fill * 4), 2)
    const pressure = (await budget()).usedTokens / baseline.availableTokens
    expect(pressure).toBeGreaterThan(0.8)
    expect(pressure).toBeLessThan(0.9)
    await first.server.close()
    homes.delete(first.server)

    const second = await start(llm, { compactionEffectiveEnabled: true }, home)
    const calls = requests.length
    const response = await fetch(`${second.base}/api/workspaces/${second.wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ path: 'reconstructed' })
    const sent = requests.slice(calls)
    expect(sent).toHaveLength(1)
    expect(String(sent[0]!.messages.at(-1)!.content)).toContain(COMPACTION_HANDOFF_MARKER)
  })

  it('the capture is the dispatched request: session controls stamped, no tools in a zero-tool mode', async () => {
    const seen: ModelRequest[] = []
    const make = (name: string, model: string): LlmProvider => ({
      name,
      models: [model],
      stream(request) {
        seen.push(request)
        return (async function* (): AsyncIterable<StreamEvent> { yield { type: 'delta', delta: 'turn reply' }; yield STOP })()
      },
    })
    // alpha/a1 is the global default; the session picks beta/b1.
    const { home, base, wsId } = await start([make('alpha', 'a1'), make('beta', 'b1')], { compactionEffectiveEnabled: true })
    const zero = ['---', 'name: Zero', 'history: compact', 'toolExposure: []', 'workspaceInstructions: false', 'skills: off', 'memoryPinned: false', 'memoryRetrieval: false', '---', '', 'No tools.'].join('\n')
    expect((await fetch(`${base}/api/workspaces/${wsId}/modes/zero`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: zero }) })).status).toBe(200)
    const snapshotOf = async (modeId?: string): Promise<{ request: ModelRequest }> => {
      const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
      const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
      expect((await fetch(`${route}/model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'beta', model: 'b1', thinkingLevel: 'high' }) })).status).toBe(200)
      if (modeId !== undefined) expect((await fetch(`${route}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId }) })).status).toBe(200)
      const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
      await completedMessage(base, wsId, id, logPath, 'question', 1)
      await until(async () => ((await readLog(logPath)).some((event) => event.type === 'context/snapshot') ? true : undefined))
      const dir = path.join(home, 'compaction', id, 'snapshots')
      const file = (await fs.readdir(dir)).find((name) => name.endsWith('.json'))!
      return JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as { request: ModelRequest }
    }
    const tooled = await snapshotOf()
    expect(tooled.request).toMatchObject({ model: 'b1', providerName: 'beta' })
    expect(seen.at(-1)).toMatchObject({ model: 'b1', providerName: 'beta' })
    expect(seen.at(-1)!.thinkingLevel).toBe('high')
    expect(tooled.request.thinkingLevel).toBe(seen.at(-1)!.thinkingLevel)
    expect(tooled.request.tools).toEqual(seen.at(-1)!.tools)
    const bare = await snapshotOf('zero')
    expect(bare.request).toMatchObject({ model: 'b1', providerName: 'beta' })
    expect(bare.request.tools).toBeUndefined()
    expect(seen.at(-1)!.tools).toBeUndefined()
  })

  it('a session with a model and no provider is budgeted on the same window compaction uses', async () => {
    const { provider: llm } = provider()
    const { server, home, base, wsId } = await start(llm, {})
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    // A legacy log can name a model without a provider; compaction sizes glm-4.7 by its 200k catalog window.
    const session = server.kernel.ctx.sessions.get(id as never)!
    session.append({ type: 'session/model', provider: null, model: 'glm-4.7' })
    await session.durable()
    expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(200)
    const manifest = await (await fetch(`${route}/manifest`)).json() as { budget: { contextLimitTokens: number } }
    expect(manifest.budget.contextLimitTokens).toBe(200_000)
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
