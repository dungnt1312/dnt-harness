/**
 * Phase 05 (plans/261017-runtime-provider-hardening), spec §10 PH-4: reasoning
 * round-trip for routes that require it (native DeepSeek thinking + tools).
 *
 * The fake gateway below plays a strict DeepSeek endpoint over real HTTP/SSE:
 * it streams `reasoning_content`, and on every request carrying `tools` it
 * rejects (HTTP 400, DeepSeek's own wording) an assistant message whose
 * reasoning is missing or differs from what it streamed. `all` enforces every
 * prior assistant turn (the documented rule); `loop` only the active tool loop.
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
import { hmacCredentialHasher } from '../../src/harness/llm/effective-model.ts'
import {
  capturedReasoning, DEEPSEEK_REASONING_PROFILE, handoffAnswerReasoning, isNativeDeepSeekEndpoint, isReasoningPayload, normalizeReasoningProfile,
  planReasoningReplay, reasoningSourceKey, resolveReasoningProfile, StreamRedactor,
} from '../../src/harness/llm/reasoning.ts'
import { clientEvent } from '../../src/web/server.ts'
import { parseProviderStore } from '../../src/web/provider-store.ts'
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

// ── fake strict DeepSeek gateway ─────────────────────────────────────

type Reply = { reasoning?: readonly string[]; content?: string; calls?: readonly { id: string; name: string; args: Record<string, unknown> }[]; finish?: 'stop' | 'tool_calls' | 'length' }
interface WireMsg { role: string; content?: unknown; reasoning_content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string }
interface Gateway { url: string; bodies: { messages: WireMsg[]; tools?: unknown[]; model: string }[]; close(): Promise<void> }

const keyOf = (message: { content?: unknown; tool_calls?: { id: string }[] }): string =>
  message.tool_calls !== undefined && message.tool_calls.length > 0 ? `calls:${message.tool_calls.map((call) => call.id).join(',')}` : `text:${String(message.content ?? '')}`

async function gateway(enforce: 'all' | 'loop', script: (n: number, body: Gateway['bodies'][number]) => Reply): Promise<Gateway> {
  const bodies: Gateway['bodies'] = []
  const streamed = new Map<string, string>()
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw) as Gateway['bodies'][number]
    bodies.push(body)
    if (Array.isArray(body.tools) && body.tools.length > 0) {
      let from = 0
      if (enforce === 'loop') for (let i = body.messages.length - 1; i >= 0; i--) if (body.messages[i]!.role === 'user') { from = i + 1; break }
      for (const message of body.messages.slice(from)) {
        if (message.role !== 'assistant') continue
        const expected = streamed.get(keyOf(message))
        const got = message.reasoning_content
        if (typeof got !== 'string' || (expected !== undefined && got !== expected)) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API.', type: 'invalid_request_error' } }))
          return
        }
      }
    }
    const reply = script(bodies.length, body)
    const frames: unknown[] = []
    for (const piece of reply.reasoning ?? []) frames.push({ choices: [{ index: 0, delta: { reasoning_content: piece } }] })
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

const HASHER = hmacCredentialHasher(Buffer.alloc(32, 5))
const probe: ToolDefinition = {
  name: 'Probe', description: 'read-only probe', readOnly: true,
  parameters: { type: 'object', properties: { q: { type: 'string' } } },
  execute: async (args) => `probe:${String(args['q'])}`,
}

function strictProvider(url: string, options: { apiKey?: string; models?: readonly string[]; profile?: typeof DEEPSEEK_REASONING_PROFILE } = {}): OpenAiCompletionsProvider {
  // A local fake is not `api.deepseek.com`: the explicit override is what makes it strict (precedence rule).
  return new OpenAiCompletionsProvider({ name: 'ds', apiKey: options.apiKey ?? 'sk-test-key-1', baseUrl: url, models: options.models ?? ['deepseek-v4-pro'], credentialHasher: HASHER, reasoning: options.profile ?? DEEPSEEK_REASONING_PROFILE })
}

function boot(provider: LlmProvider, home?: string): { kernel: Kernel } {
  const kernel = new Kernel()
  kernel.ctx.plugin(home === undefined ? SessionsService : fileSessions(home))
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.tools.register(probe)
  kernel.ctx.llm.register(provider)
  kernel.ctx.llm.use(provider.name)
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

// ── PH4-A ────────────────────────────────────────────────────────────

describe('PH4-A: strict gateway, thinking → parallel tools → replay → final answer (real adapter + agent loop)', () => {
  it('request 2 carries the real reasoning beside the right tool ids and the turn completes', async () => {
    const gw = await gateway('all', (n) => n === 1
      // A surrogate pair split across two deltas: the record must re-join it.
      ? { reasoning: ['I need two probes ', '\ud83e', '\udde0 then answer.'], calls: [{ id: 'call_a', name: 'Probe', args: { q: 'a' } }, { id: 'call_b', name: 'Probe', args: { q: 'b' } }] }
      : { reasoning: ['Both probes answered.'], content: 'final: a+b' })
    closers.push(gw.close)
    const { kernel } = boot(strictProvider(gw.url))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'probe a and b')

    expect(gw.bodies).toHaveLength(2)
    const second = gw.bodies[1]!
    const replayed = assistantWire(second)
    expect(replayed).toHaveLength(1)
    expect(replayed[0]!.reasoning_content).toBe('I need two probes \ud83e\udde0 then answer.')
    expect(replayed[0]!.tool_calls!.map((call) => call.id)).toEqual(['call_a', 'call_b'])
    expect(second.messages.filter((message) => message.role === 'tool').map((message) => [message.tool_call_id, message.content])).toEqual([['call_a', 'probe:a'], ['call_b', 'probe:b']])
    const [first, final] = assistants(session)
    expect(first!.reasoning).toMatchObject({ text: 'I need two probes 🧠 then answer.', complete: true })
    expect(first!.content).toBe('')
    expect(final!.content).toBe('final: a+b')
    expect(final!.reasoning?.text).toBe('Both probes answered.')
    // The thinking never joins the answer text.
    expect(final!.content).not.toContain('Both probes')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
  })

  it('a proven-complete reply without thinking is replayed as "" only because the profile requires the field', async () => {
    const gw = await gateway('all', (n) => n === 1 ? { calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const { kernel } = boot(strictProvider(gw.url))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(assistantWire(gw.bodies[1]!)[0]!.reasoning_content).toBe('')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
  })

  it('a generic endpoint (no profile) records and sends no reasoning, even for a deepseek-named model', async () => {
    const gw = await gateway('loop', (n) => n === 1 ? { reasoning: ['hmm'], calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'ok' })
    closers.push(gw.close)
    const generic = new OpenAiCompletionsProvider({ name: 'relay', apiKey: '', baseUrl: gw.url, models: ['deepseek-v4-pro'] })
    const { kernel } = boot(generic)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    // The strict gateway rejects it: the model id alone never enables replay.
    expect(gw.bodies).toHaveLength(2)
    expect(assistantWire(gw.bodies[1]!)[0]).not.toHaveProperty('reasoning_content')
    expect(assistants(session)[0]!.reasoning).toBeUndefined()
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider', message: expect.stringContaining('reasoning replay') })
  })
})

// ── PH4-B ────────────────────────────────────────────────────────────

describe('PH4-B: restart / fork keep lineage; route or credential switch never leaks', () => {
  it('after a restart and in a fork, every prior turn is replayed with its own reasoning', async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'ph4b-'))
    closers.push(() => fs.rm(home, { recursive: true, force: true }))
    let call = 0
    const gw = await gateway('all', (_n, body) => {
      const last = body.messages.at(-1)!
      if (last.role === 'tool') return { reasoning: [`answer after ${last.tool_call_id}`], content: `done ${last.tool_call_id}` }
      call += 1
      return { reasoning: [`plan ${call}`], calls: [{ id: `c${call}`, name: 'Probe', args: { q: String(call) } }] }
    })
    closers.push(gw.close)

    const workspaces = new WorkspaceService(home)
    await workspaces.boot()
    const first = boot(strictProvider(gw.url), home)
    await first.kernel.ctx.sessions.boot()
    const session = first.kernel.ctx.sessions.create(workspaces.defaultWorkspace)
    await turn(first.kernel, session, 'one')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    const id = session.id
    await session.durable()
    await first.kernel.stop()

    // A new process: same store, same per-install hasher → same route identity.
    const second = boot(strictProvider(gw.url), home)
    closers.push(() => second.kernel.stop())
    await second.kernel.ctx.sessions.boot()
    const restored = await second.kernel.ctx.sessions.load(id)
    expect(assistants(restored).every((message) => message.reasoning?.complete === true)).toBe(true)
    await turn(second.kernel, restored, 'two')
    expect(lastEnd(restored)).toMatchObject({ reason: 'completed' })
    const replay = gw.bodies.at(-1)!
    expect(assistantWire(replay).map((message) => message.reasoning_content)).toEqual(['plan 1', 'answer after c1', 'plan 2'])

    const fork = await second.kernel.ctx.sessions.fork(restored)
    await turn(second.kernel, fork, 'three')
    expect(lastEnd(fork)).toMatchObject({ reason: 'completed' })
    expect(assistantWire(gw.bodies.at(-1)!).map((message) => message.reasoning_content)).toEqual(['plan 1', 'answer after c1', 'plan 2', 'answer after c2', 'plan 3'])
  })

  it('a credential rotation or model switch replays nothing from the old route', async () => {
    let call = 0
    const gw = await gateway('loop', (_n, body) => {
      const last = body.messages.at(-1)!
      if (last.role === 'tool') return { reasoning: ['wrap up'], content: 'done' }
      call += 1
      return { reasoning: [`SECRET-PLAN-${call}`], calls: [{ id: `c${call}`, name: 'Probe', args: { q: 'x' } }] }
    })
    closers.push(gw.close)
    const models = ['deepseek-v4-pro', 'deepseek-flash']
    const { kernel } = boot(strictProvider(gw.url, { apiKey: 'sk-account-one', models }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'one')
    expect(assistants(session)[0]!.reasoning?.text).toBe('SECRET-PLAN-1')

    // Rotated key: hosts re-instantiate the provider under the same name.
    kernel.ctx.llm.register(strictProvider(gw.url, { apiKey: 'sk-account-two', models }))
    const before = gw.bodies.length
    await turn(kernel, session, 'two')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    expect(gw.bodies.slice(before).every((body) => !JSON.stringify(body).includes('SECRET-PLAN-1'))).toBe(true)
    // Only the new account's own reasoning is replayed, inside its tool loop.
    expect(assistantWire(gw.bodies.at(-1)!).at(-1)!.reasoning_content).toBe('SECRET-PLAN-2')

    // Model switch on the same provider: the route identity carries the model.
    kernel.ctx.on('agent/request', async (request, next) => next({ ...request, model: 'deepseek-flash' }), true)
    const switchedFrom = gw.bodies.length
    await turn(kernel, session, 'three')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    const after = gw.bodies.slice(switchedFrom).map((body) => JSON.stringify(body))
    expect(after.every((text) => !text.includes('SECRET-PLAN-1') && !text.includes('SECRET-PLAN-2'))).toBe(true)
    expect(assistantWire(gw.bodies.at(-1)!).at(-1)!.reasoning_content).toBe('SECRET-PLAN-3')
  })
})

// ── PH4-C / PH4-D (scripted provider: deterministic attempt boundaries) ──

const SOURCE = 'route-1'
const done = (finishReason: 'stop' | 'tool_calls' | 'length'): StreamEvent => ({ type: 'completion', finishReason, transport: 'done', policy: 'strict', transportSettled: true, reasoningSource: SOURCE })

function scripted(attempts: ((attempt: number) => AsyncIterable<StreamEvent>)): { provider: LlmProvider; count: () => number } {
  let attempt = 0
  return { provider: { name: 'scripted-reasoner', stream: () => attempts(++attempt) }, count: () => attempt }
}

describe('PH4-C/D: per-attempt capture', () => {
  it('an abandoned attempt never mixes its thinking into the retry that succeeds', async () => {
    const { provider, count } = scripted(async function* (attempt) {
      if (attempt === 1) {
        yield { type: 'delta', delta: 'ABANDONED-THOUGHT ', thinking: true }
        throw new ProviderError('stream reset', { transient: true })
      }
      yield { type: 'delta', delta: 'good thought', thinking: true }
      yield { type: 'delta', delta: 'answer' }
      yield done('stop')
    })
    const { kernel } = boot(provider)
    closers.push(() => kernel.stop())
    kernel.ctx.provide('limits', { stepRetryBaseMs: 1 })
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    expect(count()).toBe(2)
    expect(session.events.some((event) => event.type === 'step/abandoned')).toBe(true)
    expect(assistants(session)).toHaveLength(1)
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'good thought', complete: true, source: SOURCE })
  })

  it('length → complete:false, never replayed; error/cancel publish no reasoning; no tool runs from a partial batch', async () => {
    const executed: string[] = []
    const { provider } = scripted(async function* (attempt) {
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
    const { kernel } = boot(provider)
    closers.push(() => kernel.stop())
    kernel.ctx.on('tools/pre-execute', async (payload, next) => { executed.push(payload.call.id); return next() }, true)
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    const [cut, ok] = assistants(session)
    expect(cut!.reasoning).toEqual({ text: 'cut thought', complete: false, source: SOURCE })
    expect(ok!.reasoning?.complete).toBe(true)
    expect(executed).toEqual([])
    const plan = planReasoningReplay(session.deriveMessages(), SOURCE, 'conversation')
    // The cut reply is outside the active loop (a notice followed it): omitted, not fabricated, not blocking.
    expect([...plan.eligible].map((index) => session.deriveMessages()[index]!.content)).toEqual(['ok'])
    expect(plan.missing).toBe(0)

    for (const failure of ['error', 'cancel'] as const) {
      // Deterministic cancel: the provider itself requests the stop right after
      // its thinking chunk, then would complete — the stop must win.
      let stopNow: () => void = () => {}
      const { provider: p } = scripted(async function* () {
        yield { type: 'delta', delta: 'half a thought ', thinking: true }
        if (failure === 'error') throw new ProviderError('boom', { transient: false })
        stopNow()
        yield { type: 'delta', delta: 'more', thinking: true }
        yield done('stop')
      })
      const k = boot(p)
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

  it('secret-shaped reasoning is masked before persistence and marked not byte-faithful', async () => {
    const { provider } = scripted(async function* () {
      yield { type: 'delta', delta: 'the key is sk-live-abcdefghijklmnop ok', thinking: true }
      yield { type: 'delta', delta: 'done' }
      yield done('stop')
    })
    const { kernel } = boot(provider)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'the key is [redacted] ok', complete: true, source: SOURCE, redacted: true })
  })

  it('M3: a secret split across thinking deltas is masked in the durable chunks too', async () => {
    const { provider } = scripted(async function* () {
      for (const piece of ['token sk-li', 've-abcdef', 'ghijklmnop and ', 'Bearer abcdefgh', 'ijklmn end']) yield { type: 'delta', delta: piece, thinking: true }
      yield { type: 'delta', delta: 'done' }
      yield done('stop')
    })
    const { kernel } = boot(provider)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'hi')
    const chunks = session.events.filter((event) => event.type === 'assistant/chunk' && event.thinking === true).map((event) => (event as { delta: string }).delta).join('')
    expect(chunks).toBe('token [redacted] and [redacted] end')
    expect(JSON.stringify(session.events)).not.toMatch(/live-abc|abcdefghijklmn/)
    expect(assistants(session)[0]!.reasoning).toEqual({ text: 'token [redacted] and [redacted] end', complete: true, source: SOURCE, redacted: true })
  })

  it('M2: an over-long source is hashed and an empty one records nothing, so the log always reads back', async () => {
    const long = `route-${'x'.repeat(2_000)}`
    const record = capturedReasoning('t', true, long)!
    expect(record.source).toMatch(/^h:[0-9a-f]{64}$/)
    expect(isReasoningPayload(record)).toBe(true)
    expect(reasoningSourceKey(record.source)).toBe(record.source)
    expect(capturedReasoning('t', true, '')).toBeUndefined()
    // The adapter files and plans under the same key, so replay still matches.
    expect(reasoningSourceKey(long)).toBe(record.source)
    // Captured with the route's own key: masked even when not token-shaped.
    expect(capturedReasoning('uses KEYXYZ123 here', true, SOURCE, { apiKey: 'KEYXYZ123' })).toEqual({ text: 'uses [redacted] here', complete: true, source: SOURCE, redacted: true })

    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ph4m2-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const { provider } = scripted(async function* () {
      yield { type: 'delta', delta: 'thought', thinking: true }
      yield { type: 'delta', delta: 'answer' }
      yield { ...done('stop'), reasoningSource: long } as StreamEvent
    })
    const workspaces = new WorkspaceService(dir)
    await workspaces.boot()
    const { kernel } = boot(provider, dir)
    await kernel.ctx.sessions.boot()
    const session = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
    await turn(kernel, session, 'hi')
    await session.durable()
    await kernel.stop()
    const file = path.join(dir, 'workspaces', workspaces.defaultWorkspace, 'sessions', session.id, 'events.jsonl')
    const read = await readEventLog(file)
    const stored = read.events.find((event) => event.type === 'assistant/message') as Extract<SessionEvent, { type: 'assistant/message' }>
    expect(stored.reasoning?.source).toBe(record.source)
  })
})

describe('M3: StreamRedactor', () => {
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
    // A run longer than the carry cap is emitted (redacted) instead of held forever.
    const long = new StreamRedactor()
    expect(long.push('x'.repeat(600)).length).toBe(600)
  })
})

describe('H1: relays that stream thinking under another field', () => {
  it('a profile field override parses delta.reasoning, records the real text and replays it under that field', async () => {
    const bodies: { messages: Record<string, unknown>[] }[] = []
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw) as { messages: Record<string, unknown>[] }
      bodies.push(body)
      const first = bodies.length === 1
      const frames = first
        ? [{ choices: [{ index: 0, delta: { reasoning: 'RELAY-THOUGHT' } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'Probe', arguments: '{"q":"z"}' } }] }, finish_reason: 'tool_calls' }] }]
        : [{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }]
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const { kernel } = boot(strictProvider(url, { profile: normalizeReasoningProfile({ field: 'reasoning', required: true }) }))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    // UI chunks still flow.
    expect(session.events.some((event) => event.type === 'assistant/chunk' && event.thinking === true && event.delta === 'RELAY-THOUGHT')).toBe(true)
    expect(assistants(session)[0]!.reasoning).toMatchObject({ text: 'RELAY-THOUGHT', complete: true })
    const replayed = bodies[1]!.messages.find((message) => message['role'] === 'assistant')!
    expect(replayed['reasoning']).toBe('RELAY-THOUGHT')
    expect(replayed).not.toHaveProperty('reasoning_content')
  })

  it('thinking under a key the route does not parse is unproven: no record, never "" in its place', async () => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drain */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const frames = [{ choices: [{ index: 0, delta: { reasoning: 'LOST-THOUGHT' } }] }, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'r1', type: 'function', function: { name: 'Probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }]
      res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    // Default field `reasoning_content`, but the relay streams `reasoning`.
    const p = strictProvider(url)
    const events: StreamEvent[] = []
    for await (const event of p.stream({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'q' }], tools: SCHEMAS })) events.push(event)
    const completion = events.find((event) => event.type === 'completion')
    expect(completion).not.toHaveProperty('reasoningSource')
    // Through the loop: nothing recorded, and the next tool-loop request is refused before the network.
    const { kernel } = boot(p)
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(assistants(session)[0]!.reasoning).toBeUndefined()
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider', message: expect.stringContaining('lack complete reasoning') })
  })
})

// ── PH4-E ────────────────────────────────────────────────────────────

describe('PH4-E: legacy logs and the strict pre-network gate', () => {
  it('a legacy log line without reasoning still reads; a malformed reasoning record is a schema error', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ph4e-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const file = path.join(dir, 'events.jsonl')
    const legacy = { v: 1, seq: 1, timestamp: 1, type: 'assistant/message', stepId: 's', content: 'old', toolCalls: [{ id: 'c', name: 'Probe', args: {} }] }
    await fs.writeFile(file, `${JSON.stringify(legacy)}\n`)
    expect((await readEventLog(file)).events).toHaveLength(1)
    await fs.writeFile(file, `${JSON.stringify({ ...legacy, reasoning: { text: 1, complete: true, source: 's' } })}\n`)
    await expect(readEventLog(file)).rejects.toThrow(/invalid reasoning record/)
    await fs.writeFile(file, `${JSON.stringify({ ...legacy, reasoning: { text: 't', complete: true, source: 's', extra: 1 } })}\n`)
    await expect(readEventLog(file)).rejects.toThrow(/invalid reasoning record/)
  })

  it('a legacy DeepSeek session opens and a new user turn works when old turns are outside the gate', async () => {
    const gw = await gateway('loop', (_n, body) => body.messages.at(-1)!.role === 'tool' ? { reasoning: ['fine'], content: 'new answer' } : { reasoning: ['new plan'], calls: [{ id: 'n1', name: 'Probe', args: { q: 'n' } }] })
    closers.push(gw.close)
    const { kernel } = boot(strictProvider(gw.url))
    closers.push(() => kernel.stop())
    const session = kernel.ctx.sessions.create()
    // Pre-upgrade history: a whole tool turn with no reasoning anywhere.
    session.append({ type: 'turn/start', turnId: 't0' as never })
    session.append({ type: 'user/message', turnId: 't0' as never, content: 'old question' })
    session.append({ type: 'assistant/message', stepId: 's0' as never, content: '', toolCalls: [{ id: 'old', name: 'Probe', args: {} }] })
    session.append({ type: 'tool/call', stepId: 's0' as never, call: { id: 'old', name: 'Probe', args: {} } })
    session.append({ type: 'tool/result', stepId: 's0' as never, callId: 'old', ok: true, output: 'probe:old' })
    session.append({ type: 'assistant/message', stepId: 's1' as never, content: 'old answer' })
    session.append({ type: 'turn/end', turnId: 't0' as never, reason: 'completed' })
    await turn(kernel, session, 'new question')
    expect(lastEnd(session)).toMatchObject({ reason: 'completed' })
    const wire = assistantWire(gw.bodies.at(-1)!)
    // Legacy turns are omitted, never fabricated with "" or another turn's text.
    expect(wire.slice(0, 2).every((message) => !('reasoning_content' in message))).toBe(true)
    expect(wire.at(-1)!.reasoning_content).toBe('new plan')
  })

  it('missing in-loop reasoning fails before the network with an actionable message', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    const provider = new OpenAiCompletionsProvider({ name: 'deepseek', apiKey: 'sk-k-12345678', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-pro'], credentialHasher: HASHER })
    const messages: ModelMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'Probe', args: {} }] },
      { role: 'tool', content: 'r', toolCallId: 'c' },
    ]
    const tools = [{ name: 'Probe', description: 'p', parameters: { type: 'object' as const, properties: {} } }]
    const drain = async (request: Parameters<typeof provider.stream>[0]) => { for await (const event of provider.stream(request)) void event }
    await expect(drain({ model: 'deepseek-v4-pro', messages, tools })).rejects.toThrow(/lack complete reasoning.*new session.*reset/)
    // Partial or another route's reasoning is just as missing.
    const partial: ModelMessage[] = [messages[0]!, { ...messages[1]!, reasoning: { text: 't', complete: false, source: provider.reasoningReplay('deepseek-v4-pro')!.source } }, messages[2]!]
    await expect(drain({ model: 'deepseek-v4-pro', messages: partial, tools })).rejects.toThrow(/lack complete reasoning/)
    const foreign: ModelMessage[] = [messages[0]!, { ...messages[1]!, reasoning: { text: 't', complete: true, source: 'other-route' } }, messages[2]!]
    await expect(drain({ model: 'deepseek-v4-pro', messages: foreign, tools })).rejects.toThrow(/lack complete reasoning/)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('the gate stops a mid-loop route switch before its request; the endpoint 400 text is made actionable', async () => {
    const gw = await gateway('all', (n) => n === 1 ? { reasoning: ['p'], calls: [{ id: 'c1', name: 'Probe', args: { q: 'x' } }] } : { content: 'never' })
    closers.push(gw.close)
    const { kernel } = boot(strictProvider(gw.url, { models: ['deepseek-v4-pro', 'deepseek-flash'] }))
    closers.push(() => kernel.stop())
    let step = 0
    kernel.ctx.on('agent/request', async (request, next) => next(++step >= 2 ? { ...request, model: 'deepseek-flash' } : request), true)
    const session = kernel.ctx.sessions.create()
    await turn(kernel, session, 'go')
    expect(gw.bodies).toHaveLength(1)
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider', message: expect.stringContaining('start a new session') })

    // A legacy assistant turn the endpoint itself refuses (strict `all`): one request, no retry, hint attached.
    const legacy = await gateway('all', () => ({ content: 'never' }))
    closers.push(legacy.close)
    const p = strictProvider(legacy.url)
    const tools = [{ name: 'Probe', description: 'p', parameters: { type: 'object' as const, properties: {} } }]
    const run = async () => { for await (const event of p.stream({ model: 'deepseek-v4-pro', tools, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'b' }] })) void event }
    await expect(run()).rejects.toThrow(/requires reasoning replay this history cannot provide; start a new session/)
    expect(legacy.bodies).toHaveLength(1)
  })

  it('a request without tools never carries the field and is never gated (DeepSeek ignores it there)', async () => {
    const gw = await gateway('all', () => ({ content: 'chat' }))
    closers.push(gw.close)
    const p = strictProvider(gw.url)
    const messages: ModelMessage[] = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'x', reasoning: { text: 'r', complete: true, source: p.reasoningReplay('deepseek-v4-pro')!.source } }, { role: 'user', content: 'b' }]
    for await (const event of p.stream({ model: 'deepseek-v4-pro', messages })) void event
    expect(JSON.stringify(gw.bodies[0])).not.toContain('reasoning_content')
  })
})

describe('compatibility profile: typed, normalized at the store boundary, precedence', () => {
  it('rejects reserved / malformed fields and unknown keys; only api.deepseek.com is detected', () => {
    for (const field of ['role', 'content', 'tool_calls', 'name', 'tool_call_id', '__proto__', 'constructor', 'prototype', 'prefix', 'type', 'id']) expect(() => normalizeReasoningProfile({ field, required: true })).toThrow(/reserved/)
    expect(() => normalizeReasoningProfile({ field: '_hidden', required: true })).toThrow(/identifier/)
    expect(() => normalizeReasoningProfile(JSON.parse('{"field":"__proto__","required":true}'))).toThrow(/reserved/)
    expect(() => normalizeReasoningProfile({ field: 'a b', required: true })).toThrow(/identifier/)
    expect(() => normalizeReasoningProfile({ required: true, body: { x: 1 } })).toThrow(/unknown key/)
    expect(() => normalizeReasoningProfile({ required: 'yes' })).toThrow(/boolean/)
    expect(normalizeReasoningProfile({ required: true })).toEqual(DEEPSEEK_REASONING_PROFILE)
    expect(normalizeReasoningProfile({ field: 'reasoning', required: true, replayWindow: 'tool-loop' })).toEqual({ field: 'reasoning', required: true, replayWindow: 'tool-loop' })
    expect(isNativeDeepSeekEndpoint('https://api.deepseek.com')).toBe(true)
    expect(isNativeDeepSeekEndpoint('https://relay.example/deepseek')).toBe(false)
    expect(isNativeDeepSeekEndpoint('https://api.deepseek.com.evil.example')).toBe(false)
    expect(resolveReasoningProfile(undefined, 'https://api.deepseek.com')).toEqual(DEEPSEEK_REASONING_PROFILE)
    expect(resolveReasoningProfile(undefined, 'https://openrouter.ai/api/v1')).toBeUndefined()
    // Explicit override wins both ways.
    expect(resolveReasoningProfile({ ...DEEPSEEK_REASONING_PROFILE, required: false }, 'https://api.deepseek.com')).toBeUndefined()
    expect(resolveReasoningProfile(DEEPSEEK_REASONING_PROFILE, 'http://127.0.0.1:1')).toEqual(DEEPSEEK_REASONING_PROFILE)
  })

  it('provider-store keeps a valid typed override and drops an invalid one with a secret-free warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = (reasoning: unknown) => parseProviderStore(JSON.stringify({ version: 2, defaults: {}, providers: [{ id: 'r', name: 'r', baseUrl: 'http://x', apiKey: 'sk-STORE-SECRET-123456', models: ['m'], reasoning }] })).providers[0]!
    expect(store({ required: true }).reasoning).toEqual(DEEPSEEK_REASONING_PROFILE)
    expect(warn).not.toHaveBeenCalled()
    expect(store({ field: 'content', required: true }).reasoning).toBeUndefined()
    expect(store({ required: true, extra: 'sk-VALUE-NOT-LOGGED-1' }).reasoning).toBeUndefined()
    expect(store(undefined).reasoning).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n')
    expect(logged).toContain("provider 'r'")
    expect(logged).not.toMatch(/sk-STORE|sk-VALUE/)
    warn.mockRestore()
  })

  it('the strict gate and the endpoint refusal carry distinct internal classifications (public reason unchanged)', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const p = new OpenAiCompletionsProvider({ name: 'deepseek', apiKey: 'sk-k-12345678', baseUrl: 'https://api.deepseek.com', models: ['deepseek-v4-pro'], credentialHasher: HASHER })
    const caught = await (async () => { try { for await (const event of p.stream({ model: 'deepseek-v4-pro', tools: SCHEMAS, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'Probe', args: {} }] }, { role: 'tool', content: 'r', toolCallId: 'c' }] })) void event } catch (error) { return error } })()
    expect(caught).toMatchObject({ classification: 'reasoning_replay_missing', reason: 'unknown', retryable: false })
    vi.unstubAllGlobals()
    const refused = await gateway('all', () => ({ content: 'x' }))
    closers.push(refused.close)
    const strict = strictProvider(refused.url)
    const rejected = await (async () => { try { for await (const event of strict.stream({ model: 'deepseek-v4-pro', tools: SCHEMAS, messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'old' }, { role: 'user', content: 'b' }] })) void event } catch (error) { return error } })()
    expect(rejected).toMatchObject({ classification: 'reasoning_replay_rejected', reason: 'unknown' })
  })
})

// ── PH4-F: estimate, aging, compaction dual-read ─────────────────────

const mode: ModeDefinition = {
  id: 'ph4f', name: 'ph4f', instructions: '',
  sources: { history: 'compact', workspaceInstructions: false, skills: 'off', memoryPinned: false, memoryRetrieval: false },
  toolExposure: ['Probe'], permissionDefaults: {},
}
const SCHEMAS = [{ name: 'Probe', description: 'p', parameters: { type: 'object' as const, properties: {} } }]
const rows = (list: Record<string, unknown>[]): SessionEvent[] => list.map((row, index) => ({ seq: index + 1, timestamp: index + 1, ...row }) as unknown as SessionEvent)
const THOUGHT = 'x'.repeat(3_000)
const reasoned = (text = THOUGHT) => ({ text, complete: true, source: SOURCE })
const loopLog = (reasoning: unknown) => rows([
  { type: 'turn/start', turnId: 't1' },
  { type: 'user/message', turnId: 't1', content: 'q' },
  { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Probe', args: {} }], ...(reasoning !== undefined ? { reasoning } : {}) },
  { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Probe', args: {} } },
  { type: 'tool/result', stepId: 's1', callId: 'c1', ok: true, output: 'r' },
])
const build = (events: SessionEvent[], replay?: { source: string; window: 'conversation' | 'tool-loop' }, extra: Partial<Parameters<typeof buildContext>[0]> = {}) => buildContext({
  events, mode: { definition: mode, source: 'workspace' }, modeRevision: 1, model: 'm', providerName: 'p',
  schemas: SCHEMAS, activeSkills: [], pinnedMemory: [], budget: DEFAULT_BUDGET, ...(replay !== undefined ? { reasoningReplay: replay } : {}), ...extra,
})

describe('PH4-F: budgets, aging and compaction', () => {
  it('the context estimate counts replayed reasoning, and only for the matching route', () => {
    const events = loopLog(reasoned())
    const withReplay = build(events, { source: SOURCE, window: 'conversation' })
    const generic = build(events)
    const otherRoute = build(events, { source: 'other', window: 'conversation' })
    expect(withReplay.manifest.budget.usedTokens - generic.manifest.budget.usedTokens).toBe(estimateTokens(THOUGHT))
    expect(otherRoute.manifest.budget.usedTokens).toBe(generic.manifest.budget.usedTokens)
    expect(withReplay.messages.find((message) => message.role === 'assistant')?.reasoning?.text).toBe(THOUGHT)
    expect(generic.messages.some((message) => message.reasoning !== undefined)).toBe(false)
    // No tools in the request: DeepSeek ignores the field, so none is carried or counted.
    expect(build(events, { source: SOURCE, window: 'conversation' }, { schemas: [], mode: { definition: { ...mode, toolExposure: [] }, source: 'workspace' } }).messages.some((message) => message.reasoning !== undefined)).toBe(false)
    const closed = rows([...events.map(({ seq: _s, timestamp: _t, ...rest }) => rest), { type: 'turn/end', turnId: 't1', reason: 'completed' }])
    expect(estimateConversationTokens({ events: closed, reasoningReplay: { source: SOURCE, window: 'conversation' } }) - estimateConversationTokens({ events: closed })).toBe(estimateTokens(THOUGHT))
  })

  it('aging: a covered answer retained beside the summary never resurrects its reasoning; tool-loop window drops older turns', () => {
    const covered = rows([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'assistant/message', stepId: 's1', content: 'covered answer', reasoning: reasoned('OLD-REASONING') },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'compaction/start', trigger: 'manual' },
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summary: 'SUMMARY', summaryChars: 7, durationMs: 1 },
      { type: 'turn/start', turnId: 't2' },
      { type: 'user/message', turnId: 't2', content: 'next' },
    ])
    const built = build(covered, { source: SOURCE, window: 'conversation' }, { compaction: { summary: 'SUMMARY', coversSeq: 4 } })
    expect(built.messages.some((message) => message.content === 'covered answer')).toBe(true)
    expect(JSON.stringify(built.messages)).not.toContain('OLD-REASONING')
    const loop = rows([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'assistant/message', stepId: 's1', content: 'a1', reasoning: reasoned('OLDER') },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'turn/start', turnId: 't2' },
      { type: 'user/message', turnId: 't2', content: 'q2' },
    ])
    expect(JSON.stringify(build(loop, { source: SOURCE, window: 'tool-loop' }).messages)).not.toContain('OLDER')
    expect(JSON.stringify(build(loop, { source: SOURCE, window: 'conversation' }).messages)).toContain('OLDER')
  })

  const identity: SnapshotIdentity = { provider: 'p', model: 'm', modeHash: 'h', grantsHash: 'g', providerGeneration: 1, policyVersion: 1, prefixHash: 'x' }
  const completed = (reasoning: unknown) => rows([
    ...loopLog(reasoning).map(({ seq: _s, timestamp: _t, ...rest }) => rest),
    { type: 'assistant/message', stepId: 's2', content: 'final', ...(reasoning !== undefined ? { reasoning: reasoned('FINAL') } : {}) },
    { type: 'turn/end', turnId: 't1', reason: 'completed' },
  ])
  const snapshotOf = (events: SessionEvent[], replay?: { source: string; window: 'conversation' }): EffectiveCompactionSnapshot | undefined => {
    const full = build(events, replay)
    const request = { ...full, messages: full.messages.slice(0, -1) }
    const answer = full.messages.at(-1)!
    return reconstructSnapshot({
      sessionId: 'sess1', events, turnId: 't1', request: { messages: request.messages, tools: SCHEMAS, model: 'm', providerName: 'p' },
      projection: { ...full.compactionProjection, sources: full.compactionProjection.sources.slice(0, -1) },
      finalAnswer: answer, identity, newId: () => 'snap1',
    })
  }

  it('a pre-upgrade (v1) log keeps its v1 digest; its v1 snapshot loads without re-summarization', async () => {
    const events = completed(undefined)
    // The v1 rows exactly as the pre-phase-05 digest wrote them.
    const v1 = sha256(canonicalJson([1,
      ['u', 'q', null], ['a', 's1', '', ['c1']], ['c', 's1', { id: 'c1', name: 'Probe', args: {} }], ['r', 's1', 'c1', true, 'r'], ['a', 's2', 'final', null]]))
    expect(sourceDigest(events, 7)).toBe(v1)
    const snapshot = snapshotOf(events)!
    expect(snapshot.v).toBe(1)
    expect(validateSnapshot(snapshot, events)).toEqual({ ok: true })
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ph4f-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const store = new CompactionSnapshotStore(() => dir)
    const ref = await store.put(snapshot)
    expect(await store.load('sess1', ref, events)).toEqual(snapshot)
  })

  it('v2 round-trips; a reasoning change invalidates it; a mislabelled version is refused', async () => {
    const events = completed(reasoned())
    const snapshot = snapshotOf(events, { source: SOURCE, window: 'conversation' })!
    expect(snapshot.v).toBe(2)
    expect(snapshot.finalAnswer.reasoning?.text).toBe('FINAL')
    expect(snapshot.request.messages.find((message) => message.role === 'assistant')?.reasoning?.text).toBe(THOUGHT)
    expect(validateSnapshot(snapshot, events)).toEqual({ ok: true })
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'ph4f2-'))
    closers.push(() => fs.rm(dir, { recursive: true, force: true }))
    const store = new CompactionSnapshotStore(() => dir)
    expect(await store.load('sess1', await store.put(snapshot), events)).toEqual(snapshot)
    // Same content, different reasoning → digest (cache/hash) changes.
    const changed = completed(reasoned('y'.repeat(3_000)))
    expect(sourceDigest(changed, 7)).not.toBe(sourceDigest(events, 7))
    expect(validateSnapshot(snapshot, changed)).toEqual({ ok: false, reason: 'source-digest-mismatch' })
    expect(validateSnapshot({ ...snapshot, v: 1 }, events)).toEqual({ ok: false, reason: 'unsupported-schema' })
    // A final answer whose reasoning differs from the log is never promoted (compared only for v2).
    expect(reconstructSnapshot({
      sessionId: 'sess1', events, turnId: 't1', request: snapshot.request, projection: snapshot.projection,
      finalAnswer: { ...snapshot.finalAnswer, reasoning: reasoned('forged') }, identity, newId: () => 'snap2',
    })).toBeUndefined()
  })

  it('M1: the retain budget is sized without the reasoning it strips', () => {
    const answer = 'a'.repeat(300)
    const covered = rows([
      { type: 'turn/start', turnId: 't1' },
      { type: 'user/message', turnId: 't1', content: 'q' },
      { type: 'assistant/message', stepId: 's1', content: answer, reasoning: reasoned('r'.repeat(30_000)) },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'compaction/start', trigger: 'manual' },
      { type: 'compaction/end', trigger: 'manual', coversSeq: 4, summary: 'SUMMARY', summaryChars: 7, durationMs: 1 },
      { type: 'turn/start', turnId: 't2' },
      { type: 'user/message', turnId: 't2', content: 'next' },
    ])
    // Budget fits the answer and the (time-stamped) request with room to spare,
    // but far below the 10k-token reasoning: it must not push the answer out.
    const built = build(covered, { source: SOURCE, window: 'conversation' }, { compaction: { summary: 'SUMMARY', coversSeq: 4 }, compactionRetainTokens: estimateTokens(answer) + 200 })
    expect(built.messages.some((message) => message.content === answer)).toBe(true)
  })

  it('no-tools request: the builder carries and counts no reasoning even for the matching route', () => {
    const events = loopLog(reasoned())
    const noTools = build(events, { source: SOURCE, window: 'conversation' }, { schemas: [], mode: { definition: { ...mode, toolExposure: [] }, source: 'workspace' } })
    const generic = build(events, undefined, { schemas: [], mode: { definition: { ...mode, toolExposure: [] }, source: 'workspace' } })
    expect(noTools.messages.some((message) => message.reasoning !== undefined)).toBe(false)
    expect(noTools.manifest.budget.usedTokens).toBe(generic.manifest.budget.usedTokens)
  })

  it('M4: one handoff rule — conversation keeps, tool-loop / other route / no tools drop the final answer reasoning', () => {
    const answer: ModelMessage = { role: 'assistant', content: 'final', reasoning: reasoned('FINAL') }
    const prefix: ModelMessage[] = [{ role: 'user', content: 'q' }]
    expect(handoffAnswerReasoning(prefix, answer, { source: SOURCE, window: 'conversation' }, true)?.text).toBe('FINAL')
    expect(handoffAnswerReasoning(prefix, answer, { source: SOURCE, window: 'tool-loop' }, true)).toBeUndefined()
    expect(handoffAnswerReasoning(prefix, answer, { source: 'other', window: 'conversation' }, true)).toBeUndefined()
    expect(handoffAnswerReasoning(prefix, answer, { source: SOURCE, window: 'conversation' }, false)).toBeUndefined()
    expect(handoffAnswerReasoning(prefix, answer, undefined, true)).toBeUndefined()
    expect(handoffAnswerReasoning(prefix, { ...answer, reasoning: { ...answer.reasoning!, complete: false } }, { source: SOURCE, window: 'conversation' }, true)).toBeUndefined()
  })

  it('summarizer route gate: through a strict adapter, the final answer reasoning is sent only when the route matches', async () => {
    const gw = await gateway('loop', () => ({ content: 'SUMMARY' }))
    closers.push(gw.close)
    const p = strictProvider(gw.url)
    const source = p.reasoningReplay('deepseek-v4-pro')!.source
    const previous = { model: 'deepseek-v4-pro', tools: SCHEMAS, messages: [{ role: 'user' as const, content: 'q' }] }
    const stream = (request: Parameters<typeof p.stream>[0]) => p.stream(request)
    for (const [label, recorded, expected] of [['match', source, 'MINE'], ['foreign', 'other-route', undefined]] as const) {
      const answer: ModelMessage = { role: 'assistant', content: 'a', reasoning: { text: 'MINE', complete: true, source: recorded } }
      const reasoning = handoffAnswerReasoning(previous.messages, answer, p.reasoningReplay('deepseek-v4-pro'), true)
      await createCacheAwareCompactionSummarizer(stream, previous, reasoning !== undefined ? { ...answer, reasoning } : 'a')()
      const sent = gw.bodies.at(-1)!.messages.find((message) => message.role === 'assistant')!
      expect(sent.reasoning_content, label).toBe(expected)
    }
  })

  it('the cache-aware summarizer replays the final answer with its reasoning only in message form', async () => {
    const seen: ModelMessage[][] = []
    const stream = async function* (request: { messages: readonly ModelMessage[] }): AsyncIterable<StreamEvent> {
      seen.push([...request.messages])
      yield { type: 'delta', delta: 'S' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    }
    await createCacheAwareCompactionSummarizer(stream, { messages: [{ role: 'user', content: 'q' }] }, { role: 'assistant', content: 'a', reasoning: reasoned('R') })()
    await createCacheAwareCompactionSummarizer(stream, { messages: [{ role: 'user', content: 'q' }] }, 'a')()
    expect(seen[0]![1]).toEqual({ role: 'assistant', content: 'a', reasoning: reasoned('R') })
    expect(seen[1]![1]).toEqual({ role: 'assistant', content: 'a' })
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

