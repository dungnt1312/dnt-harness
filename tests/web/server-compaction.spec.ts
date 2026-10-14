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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AttemptAdmission, createWebServer, ProviderError, withoutSentStamp, type LlmProvider, type WebServer } from 'dnt-harness'
import type { ModelRequest, StreamEvent } from '../../src/harness/llm/types.ts'
import type { HarnessLimits } from '../../src/harness/limits.ts'

const SUMMARY_TEXT = 'CHECKPOINT SUMMARY TEXT'
/** A marker inside the compaction prompt, so the fake can tell summary calls apart. */
const COMPACT_MARK = 'Primary Request and Intent'

function summarizingProvider(options: {
  replies?: readonly string[]
  summarize?: (request: ModelRequest) => string
  /** Answer a cache-aware summary request with a tool call, forcing the chunk path. */
  chunkOnly?: boolean
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
      if (isSummaryCall && options.chunkOnly === true && request.messages.length > 1) {
        return (async function* (): AsyncIterable<StreamEvent> {
          yield { type: 'toolCalls', calls: [{ id: 'refuse', name: 'Read', args: {} }] }
          yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      }
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
  it.each(['stop', 'delete', 'shutdown', 'success'] as const)('reserves summary ownership and queues follow-up during %s', async (action) => {
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const requests: ModelRequest[] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      stream(request) {
        requests.push(request)
        return (async function* (): AsyncIterable<StreamEvent> {
          if (request.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK))) {
            entered()
            await gate
          }
          yield { type: 'delta', delta: SUMMARY_TEXT }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { server, home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    const compact = fetch(`${route}/compact`, { method: 'POST' }).catch(() => undefined)
    await started
    try {
      expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(409)
      const steeredMessage = await fetch(`${route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'queued', delivery: 'steer' }) })
      expect(steeredMessage.status).toBe(202)
      expect(await steeredMessage.json()).toMatchObject({ queued: true, dispatchBlocked: 'maintenance' })
      const steering = await fetch(`${route}/steer`, { method: 'POST' })
      expect(await steering.json()).toMatchObject({ steered: false, queued: true, dispatchBlocked: 'maintenance' })
      expect(requests).toHaveLength(2)
      if (action === 'stop') await fetch(`${route}/stop`, { method: 'POST' })
      if (action === 'delete') {
        const deleting = fetch(route, { method: 'DELETE' })
        await new Promise((resolve) => setTimeout(resolve, 50))
        release()
        expect((await deleting).status).toBe(200)
      }
      if (action === 'shutdown') {
        const closing = server.close()
        release()
        await closing
      }
    } finally { release() }
    const response = await compact
    if (action !== 'shutdown') expect(response?.status).toBe(action === 'success' ? 200 : 409)
    if (action === 'success') {
      await until(async () => {
        const rows = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
        const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
        return requests.length >= 3 && rows.filter(row => row.type === 'turn/end').length >= 2 && sessions.find(session => session.id === id)?.status === 'idle' ? true : undefined
      })
    } else {
      // Cancellation has settled, so assert canonical evidence of no follow-up execution.
      const rows = (await fs.readFile(logPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(rows.filter(row => row.type === 'turn/start').length).toBeLessThanOrEqual(1)
    }
    expect(requests).toHaveLength(action === 'success' ? 3 : 2)
    expect((await fs.readdir(checkpointsDir(home, id)).catch(() => [])).length).toBe(action === 'success' ? 1 : 0)
  })

  it.each(['stop', 'delete', 'shutdown'] as const)('cancels a hanging PreCompact hook tree on %s and never compacts', async (action) => {
    const { provider, requests } = summarizingProvider()
    const { server, home, base, wsId } = await start(provider)
    const entered = path.join(home, 'hook-entered')
    // The hanging hook's own descendant would write this after 1.5s unless
    // the whole process tree is killed on cancel.
    const effect = path.join(home, 'late-hook-effect')
    const script = `require('node:fs').writeFileSync(${JSON.stringify(entered)}, 'started'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran'), 1500); setInterval(() => {}, 1000)`
    // Hooks are captured per conversation (Claude: at startup), so the
    // settings exist before the conversation starts.
    await fs.writeFile(path.join(home, 'workspaces', wsId, 'settings.json'), JSON.stringify({ hooks: { PreCompact: [
      { hooks: [{ type: 'command', command: `"${process.execPath}" -e ${JSON.stringify(script)}`, timeout: 2 }] },
    ] } }))
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    let settled = false
    const compact = fetch(`${route}/compact`, { method: 'POST' }).then(response => { settled = true; return response }, () => { settled = true; return undefined })
    await until(async () => await fs.stat(entered).then(() => true, () => undefined))
    const cancelling = action === 'shutdown' ? server.close() : fetch(action === 'delete' ? route : `${route}/stop`, { method: action === 'delete' ? 'DELETE' : 'POST' })
    try {
      await until(async () => settled ? true : undefined, 700)
    } finally { await cancelling; await compact }
    await new Promise((resolve) => setTimeout(resolve, 1_800))
    expect(await fs.stat(effect).then(() => true, () => false)).toBe(false)
    expect(requests).toHaveLength(1)
  }, 15_000)

  it('passes text attachment content and image references, then rebuilds a missing checkpoint cache', async () => {
    const chunks: string[] = []
    const { provider, requests } = summarizingProvider({ chunkOnly: true, summarize(request) { chunks.push(conversationChunk(request)); return SUMMARY_TEXT } })
    const { home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const refs = []
    for (const [name, mediaType, bytes] of [
      ['requirements.txt', 'text/plain', Buffer.from('ATTACHED REQUIREMENT: retain deployment gate')],
      ['diagram.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX9sAAAAASUVORK5CYII=', 'base64')],
    ] as const) {
      const upload = await fetch(`${base}/api/workspaces/${wsId}/attachments`, { method: 'POST', headers: { 'content-type': mediaType, 'x-file-name': name }, body: new Uint8Array(bytes) })
      expect(upload.status).toBe(201)
      refs.push(await upload.json())
    }
    await fetch(`${route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'requirements', attachments: refs }) })
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await until(async () => {
      const entries = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
      return entries.find((s) => s.id === id)?.status === 'idle' ? true : undefined
    })
    const response = await fetch(`${route}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    const { coversSeq } = await response.json() as { coversSeq: number }
    expect(chunks.join('')).toContain('ATTACHED REQUIREMENT: retain deployment gate')
    expect(chunks.join('')).toContain('diagram.png')
    await fs.unlink(path.join(checkpointsDir(home, id), `${coversSeq}.json`))
    await completedMessage(base, wsId, id, logPath, 'continue', 2)
    expect(requests.at(-1)!.messages.some((m) => typeof m.content === 'string' && m.content.includes(SUMMARY_TEXT))).toBe(true)
    expect(await fs.readdir(checkpointsDir(home, id))).toContain(`${coversSeq}.json`)
  })

  it.each(['streamFirstEventMs', 'streamIdleMs', 'logicalRequestMs'] as const)('bounds maintenance by configured %s', async (deadline) => {
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      stream(request) {
        return (async function* (): AsyncIterable<StreamEvent> {
          const summary = request.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK))
          if (summary) {
            if (deadline === 'streamIdleMs') yield { type: 'delta', delta: 'partial' }
            await new Promise((resolve) => setTimeout(resolve, 200))
          }
          yield { type: 'delta', delta: SUMMARY_TEXT }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { home, base, wsId } = await start(provider, { [deadline]: 30 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect(await fs.readdir(checkpointsDir(home, id)).catch(() => [])).toEqual([])
  })

  it('automatic pressure uses fresh pre-trim cost and never reuses it after rejected turns', async () => {
    const { provider, requests } = summarizingProvider({ replies: ['x'.repeat(1_100_000), 'small reply'] })
    const { server, home, base, wsId } = await start(provider, { automaticCompactionPressure: 0.85 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    expect(requests).toHaveLength(1)
    await completedMessage(base, wsId, id, logPath, 'second', 2)
    const manifest = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)).json() as { budget: { usedTokens: number; preTrimTokens: number; availableTokens: number } }
    expect(manifest.budget.usedTokens / manifest.budget.availableTokens).toBeLessThan(0.85)
    expect(manifest.budget.preTrimTokens / manifest.budget.availableTokens).toBeGreaterThan(0.85)
    const log = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(log.filter((e) => e.type === 'compaction/start')).toHaveLength(1)
    const summaries = requests.filter((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK)))
    expect(summaries.length).toBeGreaterThan(0)
    // The pressured request was trimmed, so it cannot stand for the whole
    // covered history: compaction must take the full-transcript chunk path.
    expect(summaries.every((r) => r.tools === undefined || r.tools.length === 0)).toBe(true)
    expect(conversationChunk(summaries[0]!)).toContain('first')
    server.kernel.ctx.on('agent/pre-step', () => ({ kind: 'reject', reason: 'synthetic rejection' }), true)
    await completedMessage(base, wsId, id, logPath, 'rejected', 3)
    expect(requests).toHaveLength(2 + summaries.length)
    const later = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(later.filter((e) => e.type === 'compaction/start')).toHaveLength(1)
  })

  it('explicit zero disables automatic compaction', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider, { automaticCompactionPressure: 0 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    await completedMessage(base, wsId, id, path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl'), 'first', 1)
    expect(requests).toHaveLength(1)
    expect(await fs.readdir(checkpointsDir(home, id)).catch(() => [])).toEqual([])
  })

  it('folds every long-source chunk and continues the same session with latest state and retained messages', async () => {
    const longReply = 'synthetic historical detail\n'.repeat(9_000)
    const tailReply = `RECENT RAW TAIL\n${LATEST_STATE}`
    const chunks: string[] = []
    const { provider, requests } = summarizingProvider({
      replies: [longReply, tailReply],
      summarize(request) {
        const chunk = conversationChunk(request)
        // Chunk requests run in parallel and may start in any order; the merge request is not a source chunk.
        const part = /This is part (\d+) of \d+ of one conversation/.exec(String(request.messages[0]!.content))
        if (part !== null) chunks[Number(part[1]) - 1] = chunk
        // A bounded source echo makes late state visible without exceeding the output cap.
        return `SOURCE ECHO\n${chunk.slice(-2_000)}`
      },
    })
    const { home, base, wsId } = await start(provider)
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
    // Covered user requests and the latest covered answer ride verbatim; the
    // long covered answer is represented only by the summary.
    // The summarizer source above carries no `[sent …]` line; the request does,
    // on each typed message, so compare without it.
    const sent = nextRequest.messages.map((message) => message.role === 'user' && typeof message.content === 'string' ? { ...message, content: withoutSentStamp(message.content) } : message)
    expect(sent).toContainEqual({ role: 'user', content: 'synthetic history request' })
    expect(sent).toContainEqual({ role: 'user', content: 'latest state request' })
    expect(sent).toContainEqual({ role: 'assistant', content: tailReply })
    expect(sent.some((message) => message.role === 'assistant' && message.content === longReply)).toBe(false)
    expect(sent).toContainEqual({ role: 'user', content: 'Còn vấn đề gì không' })
    const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string }[]
    expect(sessions.map((session) => session.id)).toEqual([id])
    expect((await fs.readFile(logPath)).subarray(0, original.length)).toEqual(original)
  })

  it('refuses a second-chunk stream failure without publishing or replacing a checkpoint', async () => {
    let failing = false
    let chunkCalls = 0
    const chunks: string[] = []
    const { provider } = summarizingProvider({
      chunkOnly: true,
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
    // `compaction/job` is progress telemetry around the operation; the canonical lifecycle is start then end.
    const appended = after.subarray(original.length).toString('utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.type !== 'compaction/job')
    expect(appended.map((event) => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(appended[1]).toMatchObject({ error: 'provider transport failure', summaryChars: 0 })
    expect(appended[1].summary).toBeUndefined()
  })

  describe('parallel fold over the server', () => {
    const PART = /This is part (\d+) of (\d+) of one conversation/
    /** One long reply, so the fold needs `chunks` parts; `onChunk` runs a chunk request, the rest answer instantly. */
    async function foldSession(onChunk: (request: ModelRequest, signal: AbortSignal | undefined) => AsyncIterable<StreamEvent>, capacity?: number) {
      const summaryRequests = { count: 0, withUsage: 0 }
      const provider: LlmProvider = {
        name: 'scripted', models: ['scripted'],
        stream(request, options) {
          const body = String(request.messages[0]?.content)
          const isSummaryCall = request.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK))
          if (isSummaryCall) summaryRequests.count++
          if (isSummaryCall && request.messages.length > 1) {
            return (async function* (): AsyncIterable<StreamEvent> {
              yield { type: 'toolCalls', calls: [{ id: 'refuse', name: 'Read', args: {} }] }
              yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
            })()
          }
          if (isSummaryCall && PART.test(body)) return onChunk(request, options?.signal)
          return (async function* (): AsyncIterable<StreamEvent> {
            yield { type: 'delta', delta: isSummaryCall ? SUMMARY_TEXT : 'synthetic historical detail\n'.repeat(30_000) }
            if (isSummaryCall) { summaryRequests.withUsage++; yield { type: 'usage', usage: FOLD_USAGE } }
            yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
          })()
        },
      }
      const started = await start(provider)
      if (capacity !== undefined) started.server.kernel.ctx.llm.configureAdmission('scripted', new AttemptAdmission(capacity))
      const { id } = await (await fetch(`${started.base}/api/workspaces/${started.wsId}/sessions`, { method: 'POST' })).json() as { id: string }
      const logPath = path.join(started.home, 'workspaces', started.wsId, 'sessions', id, 'events.jsonl')
      await completedMessage(started.base, started.wsId, id, logPath, 'long history', 1)
      return { ...started, logPath, summaryRequests, compact: () => fetch(`${started.base}/api/workspaces/${started.wsId}/sessions/${id}/compact`, { method: 'POST' }) }
    }
    const FOLD_USAGE = { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 }
    const answered = (summaryRequests?: { withUsage: number }): AsyncIterable<StreamEvent> => (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 20))
      yield { type: 'delta', delta: 'part summary' }
      if (summaryRequests !== undefined) { summaryRequests.withUsage++; yield { type: 'usage', usage: FOLD_USAGE } }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    })()

    it('reports fold progress up to the chunk total, and the ended job counts every request and sums their usage', async () => {
      const counters: { withUsage: number }[] = []
      const { compact, logPath, summaryRequests } = await foldSession(() => answered(counters[0]))
      counters[0] = summaryRequests
      expect((await compact()).status).toBe(200)
      const jobs = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>).filter((event) => event.type === 'compaction/job')
      const progress = jobs.filter((job) => job.stage === 'generating').map((job) => job.progress as { done: number; total: number })
      expect(progress.length).toBeGreaterThan(2)
      expect(progress[0]!.done).toBe(0)
      const total = progress[0]!.total
      expect(total).toBeGreaterThan(1)
      expect(progress.every((p) => p.total === total)).toBe(true)
      expect(progress.map((p) => p.done)).toEqual([...progress.map((p) => p.done)].sort((a, b) => a - b))
      expect(progress.at(-1)!.done).toBe(total)
      const ended = jobs.at(-1)!
      expect(ended).toMatchObject({ stage: 'ended', outcome: 'compacted' })
      // Every request the provider got for the compaction: cache-aware try, chunks, merge.
      expect(ended.requests).toBe(summaryRequests.count)
      const n = summaryRequests.withUsage
      expect(ended.usage).toEqual({ input: 100 * n, cached: 40 * n, output: 10 * n })
    })

    it('a failing chunk aborts the sibling chunk streams and the compaction fails promptly', async () => {
      let arrived = 0
      let aborted = 0
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => { releaseGate = resolve })
      const { compact } = await foldSession((_request, signal) => (async function* () {
        const mine = ++arrived
        if (arrived === 3) releaseGate()
        await gate
        if (mine === 2) throw new Error('synthetic chunk failure')
        // Ends only when the provider request is aborted.
        await new Promise<void>((resolve) => signal!.addEventListener('abort', () => { aborted++; resolve() }, { once: true }))
        yield { type: 'delta', delta: 'unreachable' }
      })())
      const response = await compact()
      expect(response.status).toBe(409)
      expect(arrived).toBe(3)
      await until(async () => aborted === 2 ? true : undefined)
    })

    it('provider capacity 4 folds at most 3 chunks at once', async () => {
      let open = 0
      let max = 0
      const { compact } = await foldSession(() => (async function* () {
        max = Math.max(max, ++open)
        try { yield* answered() } finally { open-- }
      })(), 4)
      expect((await compact()).status).toBe(200)
      expect(max).toBe(3)
    })

    it('provider capacity 2 (parallelism 1) folds sequentially with the accumulated summary: no part chunks, no merge', async () => {
      let parts = 0
      const { compact, summaryRequests } = await foldSession(() => { parts++; return answered() }, 2)
      expect((await compact()).status).toBe(200)
      expect(parts).toBe(0)
      // The cache-aware try, then one request per chunk; nothing extra for a merge.
      expect(summaryRequests.count).toBeGreaterThan(2)
    })
  })

  it('the manual route summarizes through the session pair and the next request reads the checkpoint', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider)

    const created = await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: string }
    const memoryRows = (request: ModelRequest | undefined): string => (request?.messages ?? [])
      .filter((message) => typeof message.content === 'string' && message.content.includes('<untrusted kind="memory"'))
      .map((message) => String(message.content)).join('\n')
    expect((await fetch(`${base}/api/workspaces/${wsId}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'before-note', title: 'Before note', body: 'x' }) })).status).toBe(201)

    await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'first message' }),
    })
    await until(async () => (requests.length > 0 ? true : undefined))
    // A memory write after the first request does not reach this session's
    // copy until the prefix moves anyway — at the new checkpoint below.
    expect(memoryRows(requests[0])).toContain('before-note')
    expect((await fetch(`${base}/api/workspaces/${wsId}/memory`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'after-note', title: 'After note', body: 'y' }) })).status).toBe(201)

    // Compaction refuses an open turn; retry until the turn settles.
    const compacted = await until(async () => {
      const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
      if (response.status === 200) return (await response.json()) as { coversSeq: number; summaryChars: number }
      const body = (await response.json()) as { error?: string }
      if (body.error !== undefined && body.error.includes('completed exchange boundary')) return undefined
      throw new Error(`compact failed: ${response.status} ${body.error ?? ''}`)
    })
    expect(compacted.summaryChars).toBe(SUMMARY_TEXT.length)
    const firstRequest = requests[0]!
    const summaryRequest = requests.find((request, index) => index > 0 && request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK)))!
    expect(summaryRequest.messages.slice(0, firstRequest.messages.length)).toEqual(firstRequest.messages)
    expect(summaryRequest.tools).toEqual(firstRequest.tools)
    expect(summaryRequest.messages.at(-2)).toEqual({ role: 'assistant', content: 'turn reply' })

    // The response and the durable end event both carry the before/after
    // context size, and the meter's manifest already reflects the new size
    // without waiting for another request.
    const sized = compacted as { tokensBefore?: number; tokensAfter?: number }
    expect(sized.tokensBefore).toBeGreaterThan(0)
    expect(sized.tokensAfter).toBeGreaterThanOrEqual(0)
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    const log = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(log.findLast((event) => event.type === 'compaction/end')).toMatchObject({ tokensBefore: sized.tokensBefore, tokensAfter: sized.tokensAfter })
    const meter = (await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)).json()) as ManifestView & { budget: { usedTokens: number } }
    expect(meter.budget.usedTokens).toBe(sized.tokensAfter)

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
    // The checkpoint moved the prefix, so the session re-read its memory index.
    expect(memoryRows(nextRequest)).toContain('after-note')
  })

  it('the automatic pressure trigger compacts at the settled boundary', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider, { automaticCompactionPressure: 0.00001 })

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

  it('a transient summarizer chunk failure retries and still publishes', async () => {
    let summaryCalls = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      stream(request) {
        const isSummaryCall = request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK))
        return (async function* (): AsyncIterable<StreamEvent> {
          if (!isSummaryCall) {
            yield { type: 'delta', delta: 'turn reply' }
          } else if (summaryCalls++ === 0) {
            // First summary attempt dies mid-stream like a gateway blip.
            yield { type: 'delta', delta: 'part' }
            throw new ProviderError('gateway reset mid-stream', { transient: true })
          } else {
            yield { type: 'delta', delta: SUMMARY_TEXT }
          }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { home, base, wsId } = await start(provider, { stepRetryBaseMs: 1 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(summaryCalls).toBe(2)
    const names = await fs.readdir(checkpointsDir(home, id))
    expect(names).toHaveLength(1)
    const checkpoint = JSON.parse(await fs.readFile(path.join(checkpointsDir(home, id), names[0]!), 'utf8')) as { summary: string }
    expect(checkpoint.summary).toBe(SUMMARY_TEXT)
  })

  it('a later failed turn retires the cache prefix so compaction folds the full transcript', async () => {
    let turn = 0
    const requests: ModelRequest[] = []
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      stream(request) {
        requests.push(request)
        const isSummaryCall = request.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK))
        const index = isSummaryCall ? -1 : turn++
        return (async function* (): AsyncIterable<StreamEvent> {
          if (index === 1) throw new ProviderError('hard failure after partial work', { status: 400 })
          yield { type: 'delta', delta: isSummaryCall ? SUMMARY_TEXT : 'turn reply' }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { home, base, wsId } = await start(provider, { stepRetryBaseMs: 1 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'FIRST TURN', 1)
    await completedMessage(base, wsId, id, logPath, 'FAILED TURN', 2)
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(200)
    const summary = requests.find((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes(COMPACT_MARK)))!
    expect(summary.messages).toHaveLength(1)
    expect(conversationChunk(summary)).toContain('FAILED TURN')
  })

  it('re-compacts incrementally: only the delta beyond the prior checkpoint is summarized', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'FIRST EXCHANGE', 1)
    const first = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).json() as { coversSeq: number; summaryChars: number }
    expect(first.coversSeq).toBeGreaterThan(0)
    await completedMessage(base, wsId, id, logPath, 'SECOND EXCHANGE', 2)
    const before = requests.length
    const second = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).json() as { coversSeq: number }
    expect(second.coversSeq).toBeGreaterThan(first.coversSeq)
    // Exactly one summarizer call: no re-folding of the covered prefix.
    const summaryCalls = requests.slice(before).filter((request) => request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK)))
    expect(summaryCalls).toHaveLength(1)
    // The request reuses the last post-checkpoint request, whose compacted-history
    // block contains the prior summary while uncovered history contains only the delta.
    const prompt = summaryCalls[0]!.messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n')
    expect(prompt).toContain('SECOND EXCHANGE')
    expect(prompt).toContain('CHECKPOINT SUMMARY TEXT')
    // The next request consumes the new checkpoint.
    await completedMessage(base, wsId, id, logPath, 'third', 3)
    const manifest = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/manifest`)).json() as ManifestView
    expect(manifest.history.compactedThroughSeq).toBe(second.coversSeq)
  })

  it.each([
    ['contextExceeded flag', () => new ProviderError('too long for window', { contextExceeded: true })],
    ['headers-phase context_exceeded', () => new ProviderError('too long for window', { reason: 'context_exceeded', phase: 'headers' })],
  ])('a summarizer context overflow (%s) fails once without futile retries', async (_label, makeError) => {
    let summaryCalls = 0
    const provider: LlmProvider = {
      name: 'scripted', models: ['scripted'],
      stream(request) {
        const isSummaryCall = request.messages.some((message) => typeof message.content === 'string' && message.content.includes(COMPACT_MARK))
        return (async function* (): AsyncIterable<StreamEvent> {
          if (isSummaryCall) {
            summaryCalls++
            throw makeError()
          }
          yield { type: 'delta', delta: 'turn reply' }
          yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
        })()
      },
    }
    const { home, base, wsId } = await start(provider, { stepRetryBaseMs: 1 })
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    const response = await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toContain('too long for window')
    // One cache-aware attempt plus one bounded fallback; neither path retries a
    // context-exceeded request with identical input.
    expect(summaryCalls).toBe(2)
    const log = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; error?: string }).filter((event) => event.type !== 'compaction/job')
    expect(log.at(-1)).toMatchObject({ type: 'compaction/end' })
    expect(log.at(-1)?.error).toBeDefined()
  })

  it('a no-model compaction that cannot fit a near-cap model summary refuses without lifecycle events', async () => {
    const { provider } = summarizingProvider({ summarize: () => 's'.repeat(23_990) })
    const { home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'first', 1)
    expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(200)
    await completedMessage(base, wsId, id, logPath, 'second exchange that no longer fits', 2)
    // Unset the session pair: compaction falls back to the extractive summarizer.
    expect((await fetch(`${route}/model`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: null, model: null }) })).status).toBe(200)
    const before = (await fs.readFile(logPath, 'utf8')).trim().split('\n').length
    const response = await fetch(`${route}/compact`, { method: 'POST' })
    expect(response.status).toBe(409)
    expect((await response.json() as { error: string }).error).toMatch(/extractive capacity/)
    const after = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    // No canonical lifecycle. The progress events (`compaction/job`) do appear, and say it ended as failed.
    expect(after.slice(before).filter((event) => event.type.startsWith('compaction/') && event.type !== 'compaction/job')).toHaveLength(0)
  })

  it('an incremental compaction loads only attachments beyond the seed', async () => {
    const { provider } = summarizingProvider()
    const { home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const route = `${base}/api/workspaces/${wsId}/sessions/${id}`
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    const upload = async (name: string, text: string): Promise<{ id: string }> => {
      const response = await fetch(`${base}/api/workspaces/${wsId}/attachments`, { method: 'POST', headers: { 'content-type': 'text/plain', 'x-file-name': name }, body: new TextEncoder().encode(text) })
      expect(response.status).toBe(201)
      return await response.json() as { id: string }
    }
    const send = async (content: string, ref: { id: string }, turns: number) => {
      await fetch(`${route}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, attachments: [ref] }) })
      await until(async () => {
        const log = await fs.readFile(logPath, 'utf8').catch(() => '')
        const ended = log.trim().split('\n').filter((line) => line !== '' && JSON.parse(line).type === 'turn/end').length
        const sessions = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`)).json() as { id: string; status: string }[]
        return ended === turns && sessions.find((session) => session.id === id)?.status === 'idle' ? true : undefined
      })
    }
    const a = await upload('a.txt', 'ATTACHMENT A')
    await send('first', a, 1)
    expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(200)
    const b = await upload('b.txt', 'ATTACHMENT B')
    await send('second', b, 2)
    const { AttachmentStore } = await import('../../src/harness/attachments/store.ts')
    const load = vi.spyOn(AttachmentStore.prototype, 'load')
    try {
      expect((await fetch(`${route}/compact`, { method: 'POST' })).status).toBe(200)
      // Only the compaction route ran between spy install and response.
      const ids = load.mock.calls.flatMap((call) => (call[1] as readonly { id: string }[]).map((ref) => ref.id))
      expect(ids).toContain(b.id)
      expect(ids).not.toContain(a.id)
    } finally { load.mockRestore() }
  })

  it('compacting an unchanged boundary is an idempotent no-op', async () => {
    const { provider, requests } = summarizingProvider()
    const { home, base, wsId } = await start(provider)
    const { id } = await (await fetch(`${base}/api/workspaces/${wsId}/sessions`, { method: 'POST' })).json() as { id: string }
    const logPath = path.join(home, 'workspaces', wsId, 'sessions', id, 'events.jsonl')
    await completedMessage(base, wsId, id, logPath, 'only exchange', 1)
    const first = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).json() as { coversSeq: number; summaryChars: number }
    const before = requests.length
    const again = await (await fetch(`${base}/api/workspaces/${wsId}/sessions/${id}/compact`, { method: 'POST' })).json() as { coversSeq: number; summaryChars: number }
    expect(again.coversSeq).toBe(first.coversSeq)
    expect(again.summaryChars).toBe(first.summaryChars)
    // No new summarizer call and no appended lifecycle events.
    expect(requests.length).toBe(before)
    const log = (await fs.readFile(logPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string })
    expect(log.filter((event) => event.type === 'compaction/start')).toHaveLength(1)
    expect(log.filter((event) => event.type === 'compaction/end')).toHaveLength(1)
  })
})
