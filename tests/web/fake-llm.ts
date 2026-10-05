/**
 * Test doubles standing in for real OpenAI-completions endpoints:
 *
 * - {@link FakeScriptedLlm} is an inline `LlmProvider` playing a script — the
 *   deterministic workhorse that replaced the old mock provider inside specs.
 * - {@link FakeOpenAiServer} is a wire-level `node:http` fake serving
 *   `/models` and `/chat/completions` (SSE and buffered), so provider CRUD,
 *   Test connection, and Sync-models paths run against real HTTP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { LlmProvider, ModelRequest, StreamEvent, ToolCall } from '../../src/harness/llm/types.ts'

/** One scripted turn: plain text, or tool calls with optional lead-in text. */
export type ScriptStep =
  | string
  | {
      readonly content?: string
      readonly thinking?: string
      readonly toolCalls?: readonly { readonly name: string; readonly args: Record<string, unknown> }[]
    }

function isToolStep(step: ScriptStep): step is Exclude<ScriptStep, string> {
  return typeof step === 'object'
}

/** Inline scripted provider; requests are ignored — determinism is the point. */
export class FakeScriptedLlm implements LlmProvider {
  readonly name = 'scripted'
  readonly models: readonly string[] = ['scripted']
  private index = 0

  constructor(private readonly steps: readonly ScriptStep[]) {}

  async *stream(_request: ModelRequest): AsyncIterable<StreamEvent> {
    const last = this.steps[this.steps.length - 1]
    const step = this.steps[this.index] ?? last
    if (step === undefined) throw new Error('fake llm: no scripted steps')
    this.index = Math.min(this.index + 1, Math.max(this.steps.length - 1, 0))

    const reply = typeof step === 'string' ? step : (step.content ?? '')
    if (!isToolStep(step)) {
      yield* words(reply)
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      return
    }
    if (step.thinking !== undefined && step.thinking !== '') {
      yield* words(step.thinking, true)
    }
    if (reply !== '') yield* words(reply)
    if (step.toolCalls !== undefined) {
      const calls: ToolCall[] = step.toolCalls.map((call, position) => ({
        id: `call-${this.index}-${position}`,
        name: call.name,
        args: call.args,
      }))
      yield { type: 'toolCalls', calls }
    }
    yield { type: 'completion', finishReason: step.toolCalls !== undefined ? 'tool_calls' : 'stop', transport: 'done', policy: 'strict', transportSettled: true }
  }
}

async function* words(text: string, thinking = false): AsyncIterable<StreamEvent> {
  if (text === '') return
  const parts = text.match(/\S+\s*/g) ?? [text]
  for (const word of parts) {
    if (thinking) yield { type: 'delta', delta: word, thinking: true }
    else yield { type: 'delta', delta: word }
  }
}

interface ParsedRequest {
  readonly url: string
  readonly method: string
  readonly body: Record<string, unknown>
  /** Absent when the caller sent no Authorization header at all. */
  readonly authorization: string | undefined
}

/** Wire-level fake. `push()` queues turns; each completions call consumes one. */
export class FakeOpenAiServer {
  private readonly server = createServer((req, res) => {
    void this.dispatch(req, res)
  })
  private queue: ScriptStep[] = []
  private buffer: ScriptStep[] = []
  readonly seenRequests: ParsedRequest[] = []
  url = ''

  constructor(steps: readonly ScriptStep[] = []) {
    this.queue = [...steps]
  }

  push(...steps: readonly ScriptStep[]): void {
    this.queue.push(...steps)
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = this.server.address() as AddressInfo
    this.url = `http://127.0.0.1:${address.port}`
    return this.url
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.closeAllConnections()
      this.server.close(() => resolve())
    })
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>
    } catch {
      body = {}
    }
    const record = {
      url: req.url ?? '/',
      method: req.method ?? '',
      body,
      authorization: req.headers.authorization,
    }
    this.seenRequests.push(record)

    // Buffer everything before responding so tiny payloads arrive whole.
    const flushed = Buffer.concat([])

    if ((req.method === 'GET') && (record.url.endsWith('/models'))) {
      const payload = JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }, { id: 'gpt-5.6-terra' }] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(payload)
      return
    }

    if (req.method === 'POST' && record.url.endsWith('/chat/completions')) {
      if (body['stream'] !== true) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
        }))
        return
      }
      const step = this.queue.shift() ?? this.queue.at(-1)
      void flushed
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (step === undefined) {
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const text = typeof step === 'string' ? step : (step.content ?? '')
      for (const word of text.match(/\S+\s*/g) ?? []) {
        this.frame(res, { choices: [{ delta: { content: word } }] })
      }
      if (!isToolStep(step)) {
        // The adapter derives the completion from a frame carrying
        // finish_reason; EOF alone is an incomplete stream now.
        this.frame(res, { choices: [{ delta: {}, finish_reason: 'stop' }] })
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      const thought = step.thinking ?? ''
      for (const word of thought.match(/\S+\s*/g) ?? []) {
        this.frame(res, { choices: [{ delta: { reasoning_content: word } }] })
      }
      const calls = step.toolCalls ?? []
      calls.forEach((call, position) => {
        const id = `call-${position}`
        const argsJson = JSON.stringify(call.args)
        const half = Math.max(1, Math.floor(argsJson.length / 2))
        // Fragment exactly like OpenAI does: identity first, arguments in pieces keyed by index.
        this.frame(res, { choices: [{ delta: { tool_calls: [{ index: position, id, type: 'function', function: { name: call.name, arguments: '' } }] } }] })
        this.frame(res, { choices: [{ delta: { tool_calls: [{ index: position, function: { arguments: argsJson.slice(0, half) } }] } }] })
        this.frame(res, { choices: [{ delta: { tool_calls: [{ index: position, function: { arguments: argsJson.slice(half) } }] } }] })
      })
      this.frame(res, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'no such route' }))
  }

  private frame(res: ServerResponse, payload: unknown): void {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  /** Turns already served (shifted off the queue) — assertion aid. */
  get served(): readonly ScriptStep[] {
    return this.buffer
  }
}
