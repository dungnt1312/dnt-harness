/**
 * Provider-agnostic reasoning round-trip (opencode model): any provider that
 * streams reasoning gets it back on later assistant messages, under the field
 * it arrived in; configuration only overrides. The fake gateway plays an
 * interleaved-thinking endpoint over real HTTP/SSE: it streams under a chosen
 * field and, when `strict`, rejects (HTTP 400, DeepSeek's wording) an
 * assistant message whose reasoning differs from what it streamed or whose
 * field is missing.
 */
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentsService, Kernel, LlmService, OpenAiCompletionsProvider, ProviderError, SessionsService, ToolsService, fileSessions,
  WorkspaceService,
  type LlmProvider, type ModelMessage, type Session, type SessionEvent, type StreamEvent, type ToolDefinition,
} from 'dnt-harness'
import {
  capturedReasoning, defaultRequireReasoning, isReasoningPayload, legacyReasoningCompatibility, normalizeReasoningCompatibility,
  REASONING_REPLAY_REJECTED, reasoningSourceFor, reasoningSourceKey, StreamRedactor, wireReasoning,
} from '../../src/harness/llm/reasoning.ts'
import type { ReasoningCompatibility } from '../../src/harness/llm/reasoning.ts'
import { clientEvent } from '../../src/web/server.ts'
import { loadProviderStore, parseProviderStore, saveProviderStore } from '../../src/web/provider-store.ts'
import { buildContext, estimateConversationTokens } from '../../src/harness/context/builder.ts'
import { DEFAULT_BUDGET, estimateTokens } from '../../src/harness/context/budget.ts'
import { canonicalJson, sha256, sourceDigest } from '../../src/harness/context/compaction-digest.ts'
import { validateSnapshot, type EffectiveCompactionSnapshot, type SnapshotIdentity } from '../../src/harness/context/compaction-snapshot.ts'
import { CompactionSnapshotStore } from '../../src/harness/storage/compaction-snapshot-store.ts'
import { readEventLog } from '../../src/harness/storage/events-jsonl.ts'
import { reconstructSnapshot } from '../../src/web/compaction-capture.ts'
import { projectInheritedMessages } from '../../src/web/agent-delegation.ts'
import { createCacheAwareCompactionSummarizer } from '../../src/web/llm-summarizer.ts'
import type { ModeDefinition } from '../../src/harness/modes/types.ts'

// ── fake interleaved-thinking gateway ────────────────────────────────

type Reply = { reasoning?: readonly string[]; content?: string; calls?: readonly { id: string; name: string; args: Record<string, unknown> }[]; finish?: 'stop' | 'tool_calls' | 'length' }
type WireMsg = Record<string, unknown> & { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }
interface Gateway { url: string; bodies: { messages: WireMsg[]; tools?: unknown[]; model: string }[]; close(): Promise<void> }

const keyOf = (message: { content?: unknown; tool_calls?: { id: string }[] }): string =>
  message.tool_calls !== undefined && message.tool_calls.length > 0 ? `calls:${message.tool_calls.map((call) => call.id).join(',')}` : `text:${String(message.content ?? '')}`

async function gateway(options: { field?: string; strict?: boolean }, script: (n: number, body: Gateway['bodies'][number]) => Reply): Promise<Gateway> {
  const field = options.field ?? 'reasoning_content'
  const bodies: Gateway['bodies'] = []
  const streamed = new Map<string, string>()
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw) as Gateway['bodies'][number]
    bodies.push(body)
    if (options.strict === true) {
      for (const message of body.messages) {
        if (message.role !== 'assistant') continue
        const expected = streamed.get(keyOf(message))
        const got = message[field]
        if (typeof got !== 'string' || (expected !== undefined && got !== expected)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `The \`${field}\` in the thinking mode must be passed back to the API.`, type: 'invalid_request_error' } }))
          return
        }
      }
    }
    const reply = script(bodies.length, body)
    const frames: unknown[] = []
    for (const piece of reply.reasoning ?? []) frames.push({ choices: [{ index: 0, delta: { [field]: piece } }] })
    if (reply.content !== undefined) frames.push({ choices: [{ index: 0, delta: { content: reply.content } }] })
    ;(reply.calls ?? []).forEach((call, index) => frames.push({ choices: [{ index: 0, delta: { tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] }))
    const finish = reply.finish ?? ((reply.calls?.length ?? 0) > 0 ? 'tool_calls' : 'stop')
    frames.push({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    if (finish !== 'length') streamed.set((reply.calls?.length ?? 0) > 0 ? `calls:${reply.calls!.map((call) => call.id).join(',')}` : `text:${reply.content ?? ''}`, (reply.reasoning ?? []).join(''))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}`, bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

// ── harness ──────────────────────────────────────────────────────────

const probe: ToolDefinition = {
  name: 'Probe', description: 'read-only probe', readOnly: true,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  execute: async (args) => `probe:${String(args['q'])}`,
}
const SCHEMAS = [{ name: 'Probe', description: 'p', parameters: { type: 'object' as const, properties: {} } }]

/** A generic OpenAI-compatible endpoint: no host detection, no configuration needed. */
function provider(url: string, options: { name?: string; apiKey?: string; models?: readonly string[]; compatibility?: ReasoningCompatibility } = {}): OpenAiCompletionsProvider {
  return new OpenAiCompletionsProvider({
    name: options.name ?? 'relay', apiKey: options.apiKey ?? 'sk-test-key-1', baseUrl: url, models: options.models ?? ['thinker-1'],
    ...(options.compatibility !== undefined ? { compatibility: options.compatibility } : {}),
  })
}

function boot(llm: LlmProvider, home?: string): { kernel: Kernel } {
  const kernel = new Kernel()
  kernel.ctx.plugin(home === undefined ? SessionsService : fileSessions(home))
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.tools.register(probe)
  kernel.ctx.llm.register(llm)
  kernel.ctx.llm.use(llm.name)
  return { kernel }
}

async function turn(kernel: Kernel, session: Session, text: string): Promise<void> {
  const agent = kernel.ctx.agents.create(session) // idempotent per session
  agent.send(text)
  await agent.run()
}

const assistants = (session: Session) => session.events.filter((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message')
const lastEnd = (session: Session) => session.events.findLast((event) => event.type === 'turn/end')
const assistantWire = (body: Gateway['bodies'][number]) => body.messages.filter((message) => message.role === 'assistant')

const closers: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const close of closers.splice(0)) await close().catch(() => {})
})

// ── round-trip through the real adapter + agent loop ─────────────────

describe('round-trip: any OpenAI-compatible provider, field learned from the stream', () => {
  it.each(['reasoning_content', 'reasoning', 'reasoning_text'])('a generic endpoint streaming `%s` gets it back under the same field, beside the right tool ids', async (field) => {
    const gw = await gateway({ field, strict: true }, (n) => n === 1
      // A surrogate pair split across two deltas: the record must re-join it.
      ? { reasoning: ['I need two probes ', '\ud83e', '\udde0 then answer.'], calls: [{ id: 'call_a', name: 'Probe', args: { q: 'a' } }, { id: 'call_b', name: 'Probe', args: { q: 'b' } }] }
      : { reasoning: ['Both probes answered.'], content: 'final: a+b' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'probe a and b')

    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    const replayed = assistantWire(gw.bodies[1]!)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]![field]).toBe('I need two probes \ud83e\udde0 then answer.')
    for (const other of ['reasoning_content', 'reasoning', 'reasoning_text'].filter((key) => key !== field)) expect(replayed[0]).not.toHaveProperty(other)
    expect(replayed[0]!.tool_calls!.map((call) => call.id)).toEqual(['call_a', 'call_b'])
    const [first, final] = assistants(session)
    expect(first!.reasoning).toMatchObject({ text: 'I need two probes 🧠 then answer.', field, complete: true, source: reasoningSourceFor('relay', 'thinker-1') })
    expect(final!.content).toBe('final: a+b')
    expect(final!.reasoning?.text).toBe('Both probes answered.')
    // The thinking never joins the answer text.
    expect(final!.content).not.toContain('Both probes')
  })

  it('an endpoint that never streams reasoning never receives a reasoning field', async () => {
    const gw = await gateway({}, (n) => n === 1 ? { calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    expect(JSON.stringify(gw.bodies[1])).not.toMatch(/reasoning/)
    expect(assistants(session)[0]!.reasoning).toBeUndefined()
  })

  it('requests without tools carry the reasoning too (stable prefix)', async () => {
    const gw = await gateway({ strict: true }, () => ({ reasoning: ['chat thought'], content: 'chat answer' }))
    closers.push(gw.close)
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService); kernel.ctx.plugin(LlmService); kernel.ctx.plugin(ToolsService); kernel.ctx.plugin(AgentsService)
    const llm = provider(gw.url)
    kernel.ctx.llm.register(llm); kernel.ctx.llm.use(llm.name)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'one')
    await turn(kernel, session, 'two')
    expect(gw.bodies[1]!.tools).toBeUndefined()
    expect(assistantWire(gw.bodies[1]!)[0]!['reasoning_content']).toBe('chat thought')
  })

  it('DeepSeek routes send "" for turns without reasoning; other routes omit the field', async () => {
    const gw = await gateway({ strict: true }, (n) => n === 1 ? { calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url, { models: ['deepseek-v4-pro'] }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    expect(assistantWire(gw.bodies[1]!)[0]!['reasoning_content']).toBe('')
    // Nothing was streamed, so nothing was stored as if it had been.
    expect(assistants(session)[0]!.reasoning).toBeUndefined()
  })

  it('a configured field wins on the wire even when the stream used a common one', async () => {
    const gw = await gateway({ field: 'reasoning_content' }, (n) => n === 1 ? { reasoning: ['C'], calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url, { compatibility: { reasoningField: 'vendor_reasoning' } }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(assistants(session)[0]!.reasoning?.field).toBe('reasoning_content')
    const replayed = assistantWire(gw.bodies[1]!)[0]!
    expect(replayed['vendor_reasoning']).toBe('C')
    expect(replayed).not.toHaveProperty('reasoning_content')
  })

  it('requireReasoning: false on a DeepSeek route omits the empty field', async () => {
    const gw = await gateway({}, (n) => n === 1 ? { calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url, { models: ['deepseek-v4-pro'], compatibility: { requireReasoning: false } }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(assistantWire(gw.bodies[1]!)[0]).not.toHaveProperty('reasoning_content')
  })

  it('a configured field is read first and written on every assistant message', async () => {
    const gw = await gateway({ field: 'vendor_reasoning', strict: true }, (n) => n === 1 ? { reasoning: ['V'], calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url, { compatibility: { reasoningField: 'vendor_reasoning' } }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    expect(assistantWire(gw.bodies[1]!)[0]!['vendor_reasoning']).toBe('V')
    expect(assistants(session)[0]!.reasoning?.field).toBe('vendor_reasoning')
  })
})

describe('lineage: restart, fork, key rotation, model switch', () => {
  it('after a restart and in a fork, every prior turn is replayed with its own reasoning', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'reasoning-lineage-'))
    closers.push(() => fs.rm(home, { recursive: true, force: true }))
    let call = 0
    const gw = await gateway({ strict: true }, (_n, body) => {
      const last = body.messages.at(-1)!
      if (last.role === 'tool') return { reasoning: [`answer after ${last.tool_call_id}`], content: `done ${last.tool_call_id}` }
      call += 1
      return { reasoning: [`plan ${call}`], calls: [{ id: `c${call}`, name: 'Probe', args: { q: String(call) } }] }
    })
    closers.push(gw.close)
    const workspaces = new WorkspaceService(home)
    await workspaces.boot()
    const first = boot(provider(gw.url), home)
    await first.kernel.ctx.sessions.boot()
    const session = first.kernel.ctx.sessions.create(workspaces.defaultWorkspace)
    await turn(first.kernel, session, 'one')
    const id = session.id
    await session.durable()
    await first.kernel.stop()

    const second = boot(provider(gw.url), home)
    closers.push(() => second.kernel.stop())
    await second.kernel.ctx.sessions.boot()
    const restored = await second.kernel.ctx.sessions.load(id)
    await turn(second.kernel, restored, 'two')
    expect(lastEnd(restored)).toMatchObject({ reason: 'completed' })
    expect(assistantWire(gw.bodies.at(-1)!).map((message) => message['reasoning_content'])).toEqual(['plan 1', 'answer after c1', 'plan 2'])

    const fork = await second.kernel.ctx.sessions.fork(restored)
    await turn(second.kernel, fork, 'three')
    expect(lastEnd(fork)).toMatchObject({ reason: 'completed' })
    expect(assistantWire(gw.bodies.at(-1)!).map((message) => message['reasoning_content'])).toEqual(['plan 1', 'answer after c1', 'plan 2', 'answer after c2', 'plan 3'])
  })

  it('a key rotation keeps replaying; a model switch carries the text under the new route\'s field', async () => {
    const gw = await gateway({ field: 'reasoning' }, (_n, body) => body.messages.at(-1)!.role === 'tool' ? { reasoning: ['wrap'], content: 'done' } : { reasoning: ['PLAN'], calls: [{ id: `c${body.messages.length}`, name: 'Probe', args: {} }] })
    closers.push(gw.close)
    const models = ['thinker-1', 'thinker-2']
    const { kernel } = boot(provider(gw.url, { apiKey: 'sk-account-one', models }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'one')
    kernel.ctx.llm.register(provider(gw.url, { apiKey: 'sk-account-two', models }))
    await turn(kernel, session, 'two')
    // Same provider/model, new key: still replayed under the observed field.
    expect(assistantWire(gw.bodies.at(-1)!)[0]!['reasoning']).toBe('PLAN')

    kernel.ctx.on('agent/request', async (request, next) => next({ ...request, model: 'thinker-2' }), true)
    await turn(kernel, session, 'three')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    const first = assistantWire(gw.bodies.at(-1)!)[0]!
    // Readable text crosses the switch (opencode parity); the old route's field does not.
    expect(first['reasoning_content']).toBe('PLAN')
    expect(first).not.toHaveProperty('reasoning')
  })

  it('a non-string value under a loose reasoning key is ignored, never fatal', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      const frames = [{ choices: [{ index: 0, delta: { reasoning: { summary: 'structured' }, content: 'ok' }, finish_reason: 'stop' }] }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const p = provider(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    const events: StreamEvent[] = []
    for await (const event of p.stream({ model: 'thinker-1', messages: [{ role: 'user', content: 'q' }] })) events.push(event)
    expect(events.filter((event) => event.type === 'delta')).toEqual([{ type: 'delta', delta: 'ok' }])
  })
})

// ── per-attempt capture (scripted provider: deterministic boundaries) ──

// No model on the request and none advertised: the same `default` the adapter falls back to.
const SOURCE = reasoningSourceFor('scripted-reasoner', 'default')
const done = (finishReason: 'stop' | 'tool_calls' | 'length'): StreamEvent => ({ type: 'completion', finishReason, transport: 'done', policy: 'strict', transportSettled: true })

function scripted(attempts: ((attempt: number) => AsyncIterable<StreamEvent>)): { provider: LlmProvider; count: () => number } {
  let attempt = 0
  return { provider: { name: 'scripted-reasoner', stream: () => attempts(++attempt) }, count: () => attempt }
}

describe('per-attempt capture', () => {
  it('a provider that names no source still gets its thinking recorded under provider/model', async () => {
    const { provider: p } = scripted(async function* () {
      yield { type: 'delta', delta: 'thought', thinking: true }
      yield { type: 'delta', delta: 'answer' }
      yield done('stop')
    })
    const { kernel } = boot(p)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'thought', complete: true, source: SOURCE })
  })

  it('an abandoned attempt never mixes its thinking into the retry that succeeds', async () => {
    const { provider: p, count } = scripted(async function* (attempt) {
      if (attempt === 1) {
        yield { type: 'delta', delta: 'ABANDONED-THOUGHT ', thinking: true }
        throw new ProviderError('stream reset', { transient: true })
      }
      yield { type: 'delta', delta: 'good thought', thinking: true }
      yield { type: 'delta', delta: 'answer' }
      yield done('stop')
    })
    const { kernel } = boot(p)
    closers.push(() => kernel.stop())
    kernel.ctx.provide('limits', { stepRetryBaseMs: 1 })
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    expect(count()).toBe(2)
    expect(session.events.some((event) => event.type === 'step/abandoned')).toBe(true)
    expect(assistants(session)).toHaveLength(1)
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'good thought', complete: true, source: SOURCE })
  })

  it('length → complete:false and never replayed; error/cancel publish nothing; no tool runs from a partial batch', async () => {
    const executed: string[] = []
    const { provider: p } = scripted(async function* (attempt) {
      if (attempt === 1) {
        yield { type: 'delta', delta: 'cut thought', thinking: true }
        yield { type: 'delta', delta: 'partial text' }
        yield { type: 'toolCalls', calls: [{ id: 'x', name: 'Probe', args: { q: 'never' } }] }
        yield done('length')
        return
      }
      yield { type: 'delta', delta: 'resumed', thinking: true }
      yield { type: 'delta', delta: 'ok' }
      yield done('stop')
    })
    const { kernel } = boot(p)
    closers.push(() => kernel.stop())
    kernel.ctx.on('tools/pre-execute', async (payload, next) => { executed.push(payload.call.id); return next() }, true)
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    const [cut, ok] = assistants(session)
    expect(cut!.reasoning).toEqual({ text: 'cut thought', complete: false, source: SOURCE })
    expect(ok!.reasoning?.complete).toBe(true)
    expect(executed).toEqual([])
    const policy = { requireReasoning: false, source: SOURCE }
    expect(wireReasoning({ role: 'assistant', content: 'partial text', reasoning: cut!.reasoning! }, policy)).toBeUndefined()

    for (const failure of ['error', 'cancel'] as const) {
      let stopNow: () => void = () => {}
      const { provider: q } = scripted(async function* () {
        yield { type: 'delta', delta: 'half a thought ', thinking: true }
        if (failure === 'error') throw new ProviderError('boom', { transient: false })
        stopNow()
        yield { type: 'delta', delta: 'more', thinking: true }
        yield done('stop')
      })
      const k = boot(q)
      closers.push(() => k.kernel.stop())
      const s = k.kernel.ctx.sessions.create()
      const agent = k.kernel.ctx.agents.create(s)
      stopNow = () => agent.stop()
      agent.send('hi')
      await agent.run()
      expect(assistants(s), failure).toHaveLength(0)
      if (failure === 'cancel') expect(lastEnd(s)).toMatchObject({ reason: 'cancelled' })
    }
  })

  it('a secret split across thinking deltas is masked in the chunks and the record', async () => {
    const { provider: p } = scripted(async function* () {
      for (const piece of ['token sk-li', 've-abcdef', 'ghijklmnop and ', 'Bearer abcdefgh', 'ijklmn end']) yield { type: 'delta', delta: piece, thinking: true }
      yield { type: 'delta', delta: 'done' }
      yield done('stop')
    })
    const { kernel } = boot(p)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    const chunks = session.events.filter((event) => event.type === 'assistant/chunk' && event.thinking === true).map((event) => (event as { delta: string }).delta).join('')
    expect(chunks).toBe('token [redacted] and [redacted] end')
    expect(JSON.stringify(session.events)).not.toMatch(/live-abc|abcdefghijklmn/)
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'token [redacted] and [redacted] end', complete: true, source: SOURCE, redacted: true })
  })

  it('records always read back: long sources are hashed, empty ones and bad fields are refused', async () => {
    const long = `route-${'x'.repeat(2_000)}`
    const record = capturedReasoning('t', true, long)!
    expect(record.source).toMatch(/^h:[0-9a-f]{64}$/)
    expect(isReasoningPayload(record)).toBe(true)
    expect(reasoningSourceKey(record.source)).toBe(record.source)
    expect(capturedReasoning('t', true, '')).toBeUndefined()
    expect(capturedReasoning('t', true, SOURCE, { field: 'content' })).toEqual({ text: 't', complete: true, source: SOURCE })
    expect(capturedReasoning('uses KEYXYZ123 here', true, SOURCE, { apiKey: 'KEYXYZ123' })).toEqual({ text: 'uses [redacted] here', complete: true, source: SOURCE, redacted: true })

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'reasoning-log-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'events.jsonl')
    const legacy = { v: 1, seq: 1, timestamp: 1, type: 'assistant/message', stepId: 's', content: 'old', toolCalls: [{ id: 'c', name: 'Probe', args: {} }] }
    // Pre-upgrade records (no field) and current ones both read; malformed ones are schema errors.
    for (const reasoning of [undefined, { text: 't', complete: true, source: 's' }, { text: 't', field: 'reasoning', complete: true, source: 's' }]) {
      await fs.writeFile(file, `${JSON.stringify({ ...legacy, ...(reasoning !== undefined ? { reasoning } : {}) })}\n`)
      expect((await readEventLog(file)).events).toHaveLength(1)
    }
    for (const reasoning of [{ text: 1, complete: true, source: 's' }, { text: 't', complete: true, source: 's', extra: 1 }, { text: 't', field: 'role', complete: true, source: 's' }]) {
      await fs.writeFile(file, `${JSON.stringify({ ...legacy, reasoning })}\n`)
      await expect(readEventLog(file)).rejects.toThrow(/invalid reasoning record/)
    }
  })
})

describe('StreamRedactor', () => {
  it('holds only the trailing token run, masks split secrets and the route key, and flushes the rest', () => {
    const r = new StreamRedactor('MYKEY12345')
    const out = ['plain text sk-', 'abcdefghij', 'kl, then MYKEY', '12345 done', ' tail'].map((piece) => r.push(piece)).join('') + r.flush()
    expect(out).toBe('plain text [redacted], then [redacted] done tail')
    expect(r.changed).toBe(true)
    const clean = new StreamRedactor()
    expect(clean.push('hello ')).toBe('hello ')
    expect(clean.push('world')).toBe('')
    expect(clean.flush()).toBe('world')
    expect(clean.changed).toBe(false)
    const long = new StreamRedactor()
    expect(long.push('x'.repeat(600)).length).toBe(600)
  })
})

// ── wire policy and configuration ────────────────────────────────────

describe('wire field selection (opencode lowerAssistantMessage order)', () => {
  const own = reasoningSourceFor('p', 'm')
  const message = (reasoning?: Partial<NonNullable<ModelMessage['reasoning']>>): ModelMessage => ({ role: 'assistant', content: 'a', ...(reasoning !== undefined ? { reasoning: { text: 'R', complete: true, source: own, ...reasoning } } : {}) })

  it('configured field → observed field (same route) → reasoning_content; "" only when required', () => {
    expect(wireReasoning(message({ field: 'reasoning' }), { configuredField: 'vendor', requireReasoning: true, source: own })).toEqual({ field: 'vendor', text: 'R' })
    expect(wireReasoning(message({}), { configuredField: 'vendor', requireReasoning: true, source: own })).toEqual({ field: 'vendor', text: 'R' })
    expect(wireReasoning(message(undefined), { configuredField: 'vendor', requireReasoning: true, source: own })).toEqual({ field: 'vendor', text: '' })
    expect(wireReasoning(message(undefined), { configuredField: 'vendor', requireReasoning: false, source: own })).toBeUndefined()
    expect(wireReasoning(message({ field: 'reasoning_text' }), { requireReasoning: false, source: own })).toEqual({ field: 'reasoning_text', text: 'R' })
    expect(wireReasoning(message({ field: 'reasoning_text' }), { requireReasoning: false, source: reasoningSourceFor('p', 'other') })).toEqual({ field: 'reasoning_content', text: 'R' })
    expect(wireReasoning(message({}), { requireReasoning: false, source: own })).toEqual({ field: 'reasoning_content', text: 'R' })
    expect(wireReasoning(message(undefined), { requireReasoning: true, source: own })).toEqual({ field: 'reasoning_content', text: '' })
    expect(wireReasoning(message(undefined), { requireReasoning: false, source: own })).toBeUndefined()
    expect(wireReasoning(message({ complete: false }), { requireReasoning: false, source: own })).toBeUndefined()
    // A stored field that is not a usable key (forged log or snapshot) falls back.
    expect(wireReasoning(message({ field: 'role' }), { requireReasoning: false, source: own })).toEqual({ field: 'reasoning_content', text: 'R' })
    expect(wireReasoning(message({ field: 'reasoning' }), { requireReasoning: false, replay: false, source: own })).toBeUndefined()
    expect(wireReasoning(message({ field: 'reasoning' }), { requireReasoning: true, replay: false, source: own })).toEqual({ field: 'reasoning_content', text: '' })
  })

  it('requireReasoning defaults on for DeepSeek (name, host or model) and when a field is configured', () => {
    expect(defaultRequireReasoning({ provider: 'deepseek', baseUrl: 'http://x', model: 'm' })).toBe(true)
    expect(defaultRequireReasoning({ provider: 'p', baseUrl: 'https://api.deepseek.com', model: 'm' })).toBe(true)
    expect(defaultRequireReasoning({ provider: 'p', baseUrl: 'http://x', model: 'DeepSeek-V4' })).toBe(true)
    expect(defaultRequireReasoning({ provider: 'p', baseUrl: 'http://x', model: 'm', configuredField: 'reasoning' })).toBe(true)
    expect(defaultRequireReasoning({ provider: 'p', baseUrl: 'https://openrouter.ai/api/v1', model: 'kimi-k2' })).toBe(false)
  })

  it('compatibility is validated; legacy `reasoning` profiles migrate; invalid entries are dropped with a secret-free warning', () => {
    for (const field of ['role', 'content', 'tool_calls', '__proto__', 'constructor', 'id', '_hidden', 'a b']) expect(() => normalizeReasoningCompatibility({ reasoningField: field })).toThrow(/identifier/)
    expect(() => normalizeReasoningCompatibility({ requireReasoning: 'yes' })).toThrow(/boolean/)
    expect(normalizeReasoningCompatibility({ reasoningField: 'reasoning', requireReasoning: false, maxTokensField: 'max_tokens' })).toEqual({ reasoningField: 'reasoning', requireReasoning: false })
    expect(() => normalizeReasoningCompatibility({ reasoningField: 'reasoning_details' })).toThrow(/identifier/)
    expect(() => normalizeReasoningCompatibility({ replayReasoning: 1 })).toThrow(/boolean/)
    expect(legacyReasoningCompatibility({ required: true })).toEqual({ requireReasoning: true })
    expect(legacyReasoningCompatibility({ field: 'reasoning', required: true, replayWindow: 'tool-loop' })).toEqual({ reasoningField: 'reasoning', requireReasoning: true })
    // `required: false` used to turn replay off entirely; it still does.
    expect(legacyReasoningCompatibility({ field: 'reasoning', required: false })).toEqual({ replayReasoning: false })
    expect(() => new OpenAiCompletionsProvider({ name: 'x', apiKey: '', baseUrl: 'http://x', compatibility: { reasoningField: 'content' } })).toThrow(/identifier/)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = (extra: Record<string, unknown>) => parseProviderStore(JSON.stringify({ version: 2, defaults: {}, providers: [{ id: 'r', name: 'r', baseUrl: 'http://x', apiKey: 'sk-STORE-SECRET-123456', models: ['m'], ...extra }] })).providers[0]!
    expect(store({ compatibility: { reasoningField: 'reasoning' } }).compatibility).toEqual({ reasoningField: 'reasoning' })
    expect(store({ reasoning: { field: 'reasoning', required: true } }).compatibility).toEqual({ reasoningField: 'reasoning', requireReasoning: true })
    expect(store({}).compatibility).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
    const invalid = store({ compatibility: { reasoningField: 'content' } })
    expect(invalid.compatibility).toBeUndefined()
    expect(invalid.rawCompatibility).toEqual({ reasoningField: 'content' })
    expect(store({ reasoning: { required: 'sk-VALUE-NOT-LOGGED-1' } }).compatibility).toBeUndefined()
    expect(store({ compatibility: { requireReasoning: true }, reasoning: { required: false } }).compatibility).toEqual({ requireReasoning: true })
    expect(warn).toHaveBeenCalledTimes(3)
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain("provider 'r'")
    expect(logged).not.toMatch(/sk-STORE|sk-VALUE/)
    warn.mockRestore()
  })

  it('saving the store keeps compatibility, migrates the legacy key, and never erases an unusable value', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'reasoning-store-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'providers.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const entry = (id: string, extra: Record<string, unknown>) => ({ id, name: id, baseUrl: 'http://x', apiKey: '', models: ['m'], ...extra })
    await fs.writeFile(file, JSON.stringify({ version: 2, defaults: {}, aliases: [], aliasGeneration: 0, providers: [
      entry('legacy', { reasoning: { field: 'reasoning', required: true } }),
      entry('modern', { compatibility: { reasoningField: 'reasoning', supportsStore: false } }),
      entry('broken', { compatibility: { reasoningField: 'content' } }),
    ] }))
    await saveProviderStore(file, loadProviderStore(file))
    const disk = JSON.parse(await fs.readFile(file, 'utf8')) as { providers: Record<string, unknown>[] }
    const byId = Object.fromEntries(disk.providers.map((provider) => [provider['id'], provider]))
    expect(byId['legacy']).toMatchObject({ compatibility: { reasoningField: 'reasoning', requireReasoning: true } })
    expect(byId['legacy']).not.toHaveProperty('reasoning')
    // Keys dnt does not use (shared opencode config) survive the rewrite.
    expect(byId['modern']!['compatibility']).toEqual({ reasoningField: 'reasoning', supportsStore: false })
    expect(byId['broken']!['compatibility']).toEqual({ reasoningField: 'content' })
    for (const provider of disk.providers) expect(provider).not.toHaveProperty('rawCompatibility')
    const reloaded = loadProviderStore(file).providers
    expect(reloaded.find((provider) => provider.id === 'modern')!.compatibility).toEqual({ reasoningField: 'reasoning' })
    warn.mockRestore()
  })

  it('replayReasoning: false never sends recorded reasoning back', async () => {
    const gw = await gateway({}, (n) => n === 1 ? { reasoning: ['R'], calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(provider(gw.url, { compatibility: { replayReasoning: false } }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    // Still recorded (so the operator can turn replay back on), never sent.
    expect(assistants(session)[0]!.reasoning?.text).toBe('R')
    expect(JSON.stringify(gw.bodies[1])).not.toMatch(/reasoning/)
  })

  it('an endpoint refusing history without reasoning is classified, made actionable and not retried', async () => {
    const gw = await gateway({ strict: true }, () => ({ content: 'never' }))
    closers.push(gw.close)
    const p = provider(gw.url)
    const caught = await (async () => {
      try { for await (const event of p.stream({ model: 'thinker-1', tools: SCHEMAS, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'b' }] })) void event } catch (error) { return error }
    })()
    expect(caught).toMatchObject({ classification: 'reasoning_replay_rejected', reason: 'unknown' })
    expect(String((caught as Error).message)).toMatch(/start a new session/)
    expect(gw.bodies).toHaveLength(1)
    expect(REASONING_REPLAY_REJECTED.test('reasoning_details must be sent back')).toBe(true)
    expect(REASONING_REPLAY_REJECTED.test('extra fields not permitted: reasoning_content')).toBe(false)
  })
})

// ── budgets, aging and compaction ────────────────────────────────────

const mode: ModeDefinition = {
  id: 'reasoning', name: 'reasoning', instructions: '',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: ['Probe'], permissionDefaults: {},
}
const rows = (list: Record<string, unknown>[]): SessionEvent[] => list.map((row, index) => ({ seq: index + 1, timestamp: index + 1, ...row }) as unknown as SessionEvent)
const THOUGHT = 'x'.repeat(3_000)
const reasoned = (text = THOUGHT, complete = true) => ({ text, complete, source: SOURCE })
const loopLog = (reasoning: unknown) => rows([
  { type: 'turn/start', turnId: 't1' },
  { type: 'user/message', turnId: 't1', content: 'q' },
  { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Probe', args: {} }], ...(reasoning !== undefined ? { reasoning } : {}) },
  { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Probe', args: {} } },
  { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: 'r' },
])
const build = (events: SessionEvent[], extra: Partial<Parameters<typeof buildContext>[0]> = {}) => buildContext({
  events, mode: { definition: mode, source: 'workspace' }, modeRevision: 1, model: 'm', providerName: 'p',
  schemas: SCHEMAS, activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET, ...extra,
})

describe('budgets, aging and compaction', () => {
  it('complete reasoning is carried and counted; a cut-off record is neither', () => {
    const withReasoning = build(loopLog(reasoned()))
    const without = build(loopLog(undefined))
    const cut = build(loopLog(reasoned(THOUGHT, false)))
    expect(withReasoning.manifest.budget.usedTokens - without.manifest.budget.usedTokens).toBe(estimateTokens(THOUGHT))
    expect(withReasoning.messages.find((message) => message.role === 'assistant')?.reasoning?.text).toBe(THOUGHT)
    expect(cut.messages.some((message) => message.reasoning !== undefined)).toBe(false)
    expect(cut.manifest.budget.usedTokens).toBe(without.manifest.budget.usedTokens)
    const close = (events: SessionEvent[]) => rows([...events.map(({ seq: _s, timestamp: _t, ...rest }) => rest), { type: 'turn/end', turnId: 't1', reason: 'completed' }])
    expect(estimateConversationTokens({ events: close(loopLog(reasoned())) }) - estimateConversationTokens({ events: close(loopLog(undefined)) })).toBe(estimateTokens(THOUGHT))
  })

  it('aging: a covered answer retained beside the summary never resurrects its reasoning, and is sized without it', () => {
    const answer = 'a'.repeat(300)
    const covered = rows([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'assistant/message', stepId: 's1', content: answer, reasoning: reasoned(`OLD-${'r'.repeat(30_000)}`) },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'compaction/start', trigger: 'manual' },
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summary: 'SUMMARY', summaryChars: 7, durationMs: 1 },
      { type: 'turn/start', turnId: 't2' },
      { type: 'user/message', turnId: 't2', content: 'next' },
    ])
    const built = build(covered, { compaction: { summary: 'SUMMARY', coversSeq: 4 }, compactionRetainTokens: estimateTokens(answer) + 200 })
    expect(built.messages.some((message) => message.content === answer)).toBe(true)
    expect(JSON.stringify(built.messages)).not.toContain('OLD-')
  })

  const identity: SnapshotIdentity = { provider: 'p', model: 'm', modeHash: 'h', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' }
  const completed = (reasoning: unknown) => rows([
    ...loopLog(reasoning).map(({ seq: _s, timestamp: _t, ...rest }) => rest),
    { type: 'assistant/message', stepId: 's2', content: 'final', ...(reasoning !== undefined ? { reasoning: reasoned('FINAL') } : {}) },
    { type: 'turn/end', turnId: 't1', reason: 'completed' },
  ])
  const snapshotOf = (events: SessionEvent[]): EffectiveCompactionSnapshot | undefined => {
    const full = build(events)
    return reconstructSnapshot({
      sessionId: 'sess1', events, turnId: 't1', request: { messages: full.messages.slice(0, -1), tools: SCHEMAS, model: 'm', providerName: 'p' },
      projection: { ...full.compactionProjection, sources: full.compactionProjection.sources.slice(0, -1) },
      finalAnswer: full.messages.at(-1)!, identity, newId: () => 'snap1',
    })
  }

  it('a pre-upgrade (v1) log keeps its v1 digest; its v1 snapshot loads without re-summarization', async () => {
    const events = completed(undefined)
    const v1 = sha256(canonicalJson([1,
      ['u', 'q', null], ['a', 's1', '', ['c1']], ['c', 's1', { id: 'c1', name: 'Probe', args: {} }], ['r', 's1', 'c1', true, 'r'], ['a', 's2', 'final', null]]))
    expect(sourceDigest(events, 7)).toBe(v1)
    const snapshot = snapshotOf(events)!
    expect(snapshot.v).toBe(1)
    expect(validateSnapshot(snapshot, events)).toEqual({ ok: true })
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'reasoning-snap1-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const store = new CompactionSnapshotStore(() => dir)
    expect(await store.load('sess1', await store.put(snapshot), events)).toEqual(snapshot)
  })

  it('v2 round-trips; a reasoning change invalidates it; a mislabelled version or forged answer is refused', async () => {
    const events = completed(reasoned())
    const snapshot = snapshotOf(events)!
    expect(snapshot.v).toBe(2)
    expect(snapshot.finalAnswer.reasoning?.text).toBe('FINAL')
    expect(validateSnapshot(snapshot, events)).toEqual({ ok: true })
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'reasoning-snap2-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const store = new CompactionSnapshotStore(() => dir)
    expect(await store.load('sess1', await store.put(snapshot), events)).toEqual(snapshot)
    const changed = completed(reasoned('y'.repeat(3_000)))
    expect(sourceDigest(changed, 7)).not.toBe(sourceDigest(events, 7))
    expect(validateSnapshot(snapshot, changed)).toEqual({ ok: false, reason: 'source-digest-mismatch' })
    expect(validateSnapshot({ ...snapshot, v: 1 }, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
    expect(reconstructSnapshot({
      sessionId: 'sess1', events, turnId: 't1', request: snapshot.request, projection: snapshot.projection,
      finalAnswer: { ...snapshot.finalAnswer, reasoning: reasoned('forged') }, identity, newId: () => 'snap2',
    })).toBeUndefined()
  })

  it('the cache-aware summarizer replays the final answer with its reasoning in message form', async () => {
    const gw = await gateway({ field: 'reasoning' }, () => ({ content: 'SUMMARY' }))
    closers.push(gw.close)
    const p = provider(gw.url)
    const previous = { model: 'thinker-1', tools: SCHEMAS, messages: [{ role: 'user' as const, content: 'q' }] }
    const answer: ModelMessage = { role: 'assistant', content: 'a', reasoning: { text: 'MINE', field: 'reasoning', complete: true, source: reasoningSourceFor('relay', 'thinker-1') } }
    await createCacheAwareCompactionSummarizer((request) => p.stream(request), previous, answer)()
    expect(gw.bodies.at(-1)!.messages.find((message) => message.role === 'assistant')!['reasoning']).toBe('MINE')
    await createCacheAwareCompactionSummarizer((request) => p.stream(request), previous, 'a')()
    expect(JSON.stringify(gw.bodies.at(-1))).not.toMatch(/reasoning/)
  })
})

describe('consumer matrix', () => {
  it('delegation never inherits reasoning text', () => {
    const events = rows([
      { type: 'user/message', turnId: 't', content: 'hello' },
      { type: 'assistant/message', stepId: 's', content: 'visible answer', reasoning: reasoned('HIDDEN-REASONING') },
    ])
    const inherited = projectInheritedMessages(events)
    expect(inherited).toContain('visible answer')
    expect(inherited).not.toContain('HIDDEN-REASONING')
  })

  it('SSE frames strip the stored reasoning record; other events pass unchanged', () => {
    const [message, chunk] = rows([
      { type: 'assistant/message', stepId: 's', content: 'visible', reasoning: reasoned('HIDDEN') },
      { type: 'assistant/chunk', stepId: 's', delta: 'thinking shown in UI', thinking: true },
    ])
    const framed = clientEvent(message!)
    expect(framed).toMatchObject({ type: 'assistant/message', content: 'visible' })
    expect(framed).not.toHaveProperty('reasoning')
    expect(JSON.stringify(framed)).not.toContain('HIDDEN')
    expect(clientEvent(chunk!)).toBe(chunk)
  })
})
