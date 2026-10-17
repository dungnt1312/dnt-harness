/**
 * Phase 04 (plans/261017-runtime-provider-hardening), spec §9 PH-3: request
 * errors are classified at the adapter boundary from bounded known formats,
 * so a real shared-window overflow still recovers by squeezing while an
 * output-cap rejection is terminal and never retried with the same payload.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentsService, Kernel, LlmService, OpenAiCompletionsProvider, ProviderError, SessionsService } from 'dnt-harness'
import { classifyRequestError, isContextExceeded } from '../../src/harness/llm/openai.ts'
import { MAX_SQUEEZE_LEVEL } from '../../src/harness/context/budget.ts'

afterEach(() => { vi.unstubAllGlobals() })

const VLLM_WINDOW = "'max_tokens' or 'max_completion_tokens' is too large: 1024. This model's maximum context length is 8192 tokens and your request has 8000 input tokens (1024 > 8192 - 8000)."
const OPENAI_WINDOW = "This model's maximum context length is 8192 tokens. However, you requested 9024 tokens (8000 in the messages, 1024 in the completion). Please reduce the length of the messages or completion."
const PURE_CAP = 'max_tokens is too large: 32000. This model supports at most 4096 completion tokens, whereas you provided 32000.'
const BOTH = `${PURE_CAP} Also: This model's maximum context length is 8192 tokens. However, you requested 40000 tokens (8000 in the messages, 32000 in the completion).`

describe('PH3-D: classifier table', () => {
  const table: [number, string, string][] = [
    // shared window (recoverable), including max_tokens wording with window arithmetic
    [400, VLLM_WINDOW, 'context_exceeded'],
    [400, OPENAI_WINDOW, 'context_exceeded'],
    [400, 'Prompt is too long: 210000 tokens > 200000 maximum', 'context_exceeded'],
    [502, OPENAI_WINDOW, 'context_exceeded'],
    // payload size
    [413, 'Request Entity Too Large', 'payload_too_large'],
    [400, 'payload too large', 'payload_too_large'],
    // independent output maximum: terminal, also through relays and alongside an overflow
    [400, PURE_CAP, 'output_cap_rejected'],
    [400, 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-3-haiku', 'output_cap_rejected'],
    [400, '`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model', 'output_cap_rejected'],
    [400, 'Range of max_tokens should be [1, 8192]', 'output_cap_rejected'],
    [400, "Invalid 'max_completion_tokens': integer above maximum value. Expected a value <= 16384, but got 32000 instead.", 'output_cap_rejected'],
    [422, 'The requested max_output_tokens is out of range: valid range is 1 to 65537 (exclusive)', 'output_cap_rejected'],
    [502, PURE_CAP, 'output_cap_rejected'],
    [400, BOTH, 'output_cap_rejected'],
    // missing required cap
    [400, 'max_tokens is required', 'missing_required_cap'],
    [400, "Missing required parameter: 'max_tokens'.", 'missing_required_cap'],
    [422, 'max_tokens: field required', 'missing_required_cap'],
    // `max_tokens is too large` alone proves neither overflow nor output-only
    [400, 'max_tokens is too large: 32000', 'request'],
    // status gates: auth, quota, rate limit, origin 500 are never an overflow
    [401, 'context_length_exceeded', 'auth'],
    [403, OPENAI_WINDOW, 'auth'],
    [429, 'Rate limit reached', 'rate_limit'],
    [429, 'You exceeded your current quota', 'quota'],
    [500, 'prompt is too long', 'server_error'],
    [503, 'busy', 'server_error'],
    [400, 'insufficient_quota', 'quota'],
    // localized / unknown wording and malformed bodies: a plain request error
    [400, 'Die Anfrage ist ungültig', 'request'],
    [400, '{"error": {"message": ', 'request'],
    [400, '', 'request'],
  ]
  for (const [status, detail, expected] of table) {
    it(`${status} ${detail.slice(0, 60) || '(empty)'} → ${expected}`, () => {
      expect(classifyRequestError(status, detail)).toBe(expected)
      expect(isContextExceeded(status, detail)).toBe(expected === 'context_exceeded' || expected === 'payload_too_large')
    })
  }

  it('only reads a bounded prefix of the error body', () => {
    expect(classifyRequestError(400, `${'x'.repeat(20_000)} context_length_exceeded`)).toBe('request')
  })
})

/** SSE body for one successful completion. */
function sse(text: string): Response {
  return new Response(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const error = (status: number, message: string): Response => new Response(JSON.stringify({ error: { message } }), { status })

function boot(provider: OpenAiCompletionsProvider, trim: boolean) {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(provider)
  kernel.ctx.llm.use(provider.name)
  // Plays the context builder: each squeeze level sends a smaller history.
  kernel.ctx.on('agent/context', async (projected, next) => next({
    ...projected,
    messages: trim && (projected.squeeze ?? 0) >= 1 ? projected.messages.slice(-1) : [{ role: 'user', content: 'x'.repeat(24_000) }, ...projected.messages],
  }), true)
  const session = kernel.ctx.sessions.create()
  return { kernel, session, agent: kernel.ctx.agents.create(session) }
}

describe('PH3: recovery through the real adapter and turn loop', () => {
  it('PH3-A: window 8192 / input 8000 / output 1024 is reassembled smaller and completes', async () => {
    const bodies: { messages: unknown[]; max_tokens?: number }[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { messages: unknown[]; max_tokens?: number }
      bodies.push(body)
      return body.messages.length > 1 ? error(400, VLLM_WINDOW) : sse('fits')
    }))
    const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'], maxOutputTokens: { m: 1_024 } })
    const { kernel, session, agent } = boot(provider, true)
    agent.send('hello')
    await agent.run()
    expect(bodies).toHaveLength(2)
    // The authoritative cap is never "relearned" from shared-window room.
    expect(bodies.map((body) => body.max_tokens)).toEqual([1_024, 1_024])
    expect(session.events.some((event) => event.type === 'turn/error')).toBe(false)
    expect(session.events.findLast((event) => event.type === 'turn/end')).toMatchObject({ reason: 'completed' })
    void kernel.stop()
  })

  it('PH3-B/C: an output maximum (even beside an overflow) is one request, no squeeze, history kept', async () => {
    for (const message of [PURE_CAP, BOTH]) {
      let calls = 0
      vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return error(400, message) }))
      const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'], maxOutputTokens: { m: 32_000 } })
      const { kernel, session, agent } = boot(provider, true)
      agent.send('hello')
      await agent.run()
      expect(calls, message.slice(0, 40)).toBe(1)
      expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider' })
      // The user's input is still in the log: nothing was trimmed away.
      expect(session.events.some((event) => event.type === 'user/message')).toBe(true)
      void kernel.stop()
    }
  })

  it('a guessed cap: the corrective resend and the squeeze share one attempt budget', async () => {
    const statuses: number[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { max_tokens?: number }
      // The 32k guess is refused with a readable limit; afterwards the window keeps overflowing.
      const response = body.max_tokens === 32_000 ? error(400, PURE_CAP) : error(400, OPENAI_WINDOW)
      statuses.push(body.max_tokens ?? 0)
      return response
    }))
    const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] })
    const { kernel, session, agent } = boot(provider, false)
    agent.send('hello')
    await agent.run()
    // Four physical attempts in total (the logical-request ceiling): the guess,
    // its corrective resend, and squeezes until the budget is spent.
    expect(statuses).toHaveLength(4)
    expect(statuses.slice(0, 2)).toEqual([32_000, 4_096])
    expect(statuses.length).toBeLessThanOrEqual(MAX_SQUEEZE_LEVEL + 1)
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider' })
    const attempts = session.events.filter((event) => event.type === 'model/attempt' && (event as { fact: { state: string } }).fact.state === 'start')
    expect(attempts.length).toBeLessThanOrEqual(4)
    void kernel.stop()
  })

  it('review M1: the corrective resend is its own logged attempt with consistent numbering', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return calls === 1 ? error(400, PURE_CAP) : sse('ok') }))
    const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] })
    const { kernel, session, agent } = boot(provider, false)
    agent.send('hello')
    await agent.run()
    expect(calls).toBe(2)
    const facts = session.events.filter((event) => event.type === 'model/attempt').map((event) => (event as unknown as { fact: { attempt: number; attemptId: string; state: string; reason?: string; requestId: string } }).fact)
    expect(facts.map((fact) => [fact.attempt, fact.state, fact.reason])).toEqual([[1, 'start', undefined], [1, 'end', 'unknown'], [2, 'start', undefined], [2, 'end', undefined]])
    expect(new Set(facts.map((fact) => fact.requestId)).size).toBe(1)
    expect(facts[0]!.attemptId).not.toBe(facts[2]!.attemptId)
    expect(session.events.findLast((event) => event.type === 'turn/end')).toMatchObject({ reason: 'completed' })
    void kernel.stop()
  })

  it('review M4: independent output maximum + window arithmetic in one message is pinned as a terminal cap rejection', () => {
    // Chosen behaviour (spec §9 PH3-C): when an independent output maximum is
    // ALSO violated, trimming history cannot make the request valid, so the
    // cap rejection wins over the overflow — no squeeze loop.
    expect(classifyRequestError(400, BOTH)).toBe('output_cap_rejected')
    expect(isContextExceeded(400, BOTH)).toBe(false)
    // Window arithmetic alone (vLLM wording, no independent maximum) stays recoverable.
    expect(classifyRequestError(400, VLLM_WINDOW)).toBe('context_exceeded')
    // Order of the two clauses does not change the outcome.
    const reversed = `This model's maximum context length is 8192 tokens. However, you requested 40000 tokens (8000 in the messages, 32000 in the completion). ${PURE_CAP}`
    expect(classifyRequestError(400, reversed)).toBe('output_cap_rejected')
  })

  it('PH3-E: when the squeeze levels are spent the failure is explicit and no tool runs', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return error(400, OPENAI_WINDOW) }))
    const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'], maxOutputTokens: { m: 1_024 } })
    const { kernel, session, agent } = boot(provider, false)
    agent.send('hello')
    await agent.run()
    expect(calls).toBe(MAX_SQUEEZE_LEVEL + 1)
    const failure = session.events.find((event) => event.type === 'turn/error')
    expect(failure).toMatchObject({ kind: 'provider' })
    expect(session.events.some((event) => event.type === 'tool/call')).toBe(false)
    void kernel.stop()
  })

  it('an SSE gateway error carrying a pure cap rejection is terminal, not transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify({ error: { message: PURE_CAP } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
    const provider = new OpenAiCompletionsProvider({ name: 'gw', apiKey: '', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] })
    let caught: unknown
    try { for await (const _ of provider.stream({ messages: [] })) void _ } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(ProviderError)
    expect(caught).toMatchObject({ transient: false, contextExceeded: false, classification: 'output_cap_rejected' })
  })
})
