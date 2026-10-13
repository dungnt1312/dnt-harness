/**
 * A reply that hits the model's output-token limit (finish `length`) no longer
 * fails the turn: the partial text is kept, a cut-off tool call never runs,
 * and the model is told to continue in smaller pieces, a bounded number of times.
 */
import { describe, expect, it, vi } from 'vitest'
import { AgentsService, Kernel, LlmService, SessionsService, ToolsService, type StreamEvent } from 'dnt-harness'
import { MAX_TRUNCATION_RECOVERIES, TRUNCATION_NOTICE } from '../../src/harness/agent/agent.ts'

type Reply = (attempt: number) => StreamEvent[]
const done = (finishReason: 'stop' | 'tool_calls' | 'length'): StreamEvent => ({ type: 'completion', finishReason, transport: 'done', policy: 'strict', transportSettled: true })

async function run(reply: Reply) {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.provide('limits', { stepRetries: 1, stepRetryBaseMs: 1 })
  const body = vi.fn(async () => 'written')
  kernel.ctx.tools.register({ name: 'Write', description: 'test', parameters: { type: 'object', properties: {} }, execute: body })
  let attempts = 0
  const requests: unknown[] = []
  kernel.ctx.llm.register({ name: 'p', async *stream(request): AsyncIterable<StreamEvent> {
    requests.push(request)
    attempts++
    yield* reply(attempts)
  } })
  const session = kernel.ctx.sessions.create()
  const agent = kernel.ctx.agents.create(session)
  agent.send('write the plan')
  await agent.run()
  await kernel.stop()
  const outcome = session.events.findLast(e => e.type === 'turn/end')?.reason
  return { outcome, session, body, attempts, requests }
}

describe('output-token limit recovery', () => {
  it('drops a cut-off tool call, tells the model, and finishes the turn', async () => {
    const { outcome, session, body, attempts } = await run(attempt => attempt === 1
      ? [{ type: 'delta', delta: 'Writing the plan.' }, { type: 'toolCalls', calls: [{ id: 'w', name: 'Write', args: {} }] }, done('length')]
      : [{ type: 'delta', delta: 'Done in pieces.' }, done('stop')])
    expect(outcome).toBe('completed')
    expect(attempts).toBe(2)
    expect(body).not.toHaveBeenCalled()
    expect(session.events.some(e => e.type === 'tool/call')).toBe(false)
    const notice = session.events.find(e => e.type === 'user/message' && e.content === TRUNCATION_NOTICE)
    expect(notice).toMatchObject({ origin: 'context' })
    const history = session.deriveMessages()
    expect(history.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(history[1]).toEqual({ role: 'assistant', content: 'Writing the plan.' })
  })

  it('writes no empty assistant message when the cut-off reply had no answer text', async () => {
    const { outcome, session } = await run(attempt => attempt === 1
      ? [{ type: 'delta', delta: 'thinking…', thinking: true }, done('length')]
      : [{ type: 'delta', delta: 'ok' }, done('stop')])
    expect(outcome).toBe('completed')
    expect(session.deriveMessages().map(m => m.role)).toEqual(['user', 'user', 'assistant'])
  })

  it('fails the turn once the recovery budget is spent', async () => {
    const { outcome, session, attempts } = await run(() => [{ type: 'delta', delta: 'again' }, done('length')])
    expect(outcome).toBe('failed')
    expect(attempts).toBe(MAX_TRUNCATION_RECOVERIES + 1)
    expect(session.events.findLast(e => e.type === 'turn/error')).toMatchObject({ kind: 'provider', message: expect.stringContaining('length') })
  })
})
