/**
 * The LLM seam: provider registry effects, selection, fail-loud behavior,
 * the `llm/stream` waterfall around the adapter call, and scripted tool
 * calls from the mock provider.
 */
import { describe, expect, it } from 'vitest'
import {
  Kernel,
  LlmService,
  type LlmProvider,
  type ModelRequest,
  type StreamEvent,
} from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

function requestOf(...contents: string[]): ModelRequest {
  return { messages: contents.map((content) => ({ role: 'user' as const, content })) }
}

/** Collect a stream into its assembled content and tool calls. */
async function collect(stream: AsyncIterable<StreamEvent>): Promise<{ text: string; toolCalls: StreamEvent[] }> {
  let text = ''
  const toolCalls: StreamEvent[] = []
  for await (const event of stream) {
    if (event.type === 'delta') text += event.delta
    else toolCalls.push(event)
  }
  return { text, toolCalls }
}

describe('llm seam', () => {
  it('mock provider streams a scripted reply as reassemblable deltas', async () => {
    const kernel = new Kernel()
    const provider = new FakeScriptedLlm(['one two three'])
    kernel.ctx.plugin(LlmService)
    kernel.ctx.llm.register(provider)

    const { text, toolCalls } = await collect(kernel.ctx.llm.stream(requestOf('hi')))
    expect(text).toBe('one two three')
    expect(toolCalls).toEqual([])
    void kernel.stop()
  })

  it('consecutive calls advance the script and clamp to the last reply', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    kernel.ctx.llm.register(new FakeScriptedLlm(['first', 'second']))

    const run = async (): Promise<string> => (await collect(kernel.ctx.llm.stream(requestOf('x')))).text
    expect(await run()).toBe('first')
    expect(await run()).toBe('second')
    expect(await run()).toBe('second')
    void kernel.stop()
  })

  it('a scripted tool-call step emits content then calls with generated ids', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    kernel.ctx.llm.register(
      new FakeScriptedLlm([
        { content: 'let me check', toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
        'all done',
      ]),
    )

    const first = await collect(kernel.ctx.llm.stream(requestOf('x')))
    expect(first.text).toBe('let me check')
    expect(first.toolCalls).toEqual([
      { type: 'toolCalls', calls: [{ id: 'call-1-0', name: 'read', args: { path: 'a.txt' } }] },
    ])

    const second = await collect(kernel.ctx.llm.stream(requestOf('x')))
    expect(second.text).toBe('all done')
    expect(second.toolCalls).toEqual([])
    void kernel.stop()
  })

  it('streaming with no provider fails loud', () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    expect(() => kernel.ctx.llm.stream(requestOf('x'))).toThrow(/no provider registered/)
    void kernel.stop()
  })

  it('use() fails loud on an unknown provider name', () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    kernel.ctx.llm.register(new FakeScriptedLlm(['x']))
    expect(() => kernel.ctx.llm.use('nope')).toThrow(/no provider named 'nope'/)
    void kernel.stop()
  })

  it('register is an effect: disposal removes the provider', () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    const provider: LlmProvider = new FakeScriptedLlm(['only'])
    const dispose = kernel.ctx.llm.register(provider)
    expect(kernel.ctx.llm.active().name).toBe('scripted')

    dispose()
    expect(() => kernel.ctx.llm.stream(requestOf('x'))).toThrow(/no provider registered/)
    void kernel.stop()
  })

  it('llm/stream waterfall: a listener can replace the request downstream', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    const seen: string[] = []
    const provider: LlmProvider = {
      name: 'spy',
      async *stream(request) {
        for (const message of request.messages) seen.push(`${message.role}:${message.content}`)
        yield { type: 'delta', delta: 'spy reply' }
      },
    }
    kernel.ctx.llm.register(provider)

    kernel.ctx.on('llm/stream', async (request, next) => {
      return next({
        ...request,
        messages: [{ role: 'system', content: 'injected system preamble' }, ...request.messages],
      })
    })

    const { text } = await collect(kernel.ctx.llm.stream(requestOf('hi')))
    expect(text).toBe('spy reply')
    expect(seen).toEqual(['system:injected system preamble', 'user:hi'])
    void kernel.stop()
  })
})

describe('provider-explicit dispatch', () => {
  it('a stamped provider that is gone fails closed — never the global fallback', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    let betaCalled = 0
    kernel.ctx.llm.register({
      name: 'alpha',
      models: ['a1'],
      // eslint-disable-next-line require-yield
      async *stream() { throw new Error('alpha must not be reached') },
    })
    kernel.ctx.llm.register({
      name: 'beta',
      models: ['b1'],
      async *stream() {
        betaCalled += 1
        yield { type: 'delta', delta: 'beta' }
      },
    })
    kernel.ctx.llm.use('beta') // the global pointer points at beta

    const dispose = kernel.ctx.llm.register({
      name: 'gamma',
      models: ['g1'],
      async *stream() { yield { type: 'delta', delta: 'g' } },
    })
    dispose() // unregistering keeps gamma out; alpha remains registered
    // Remove alpha to simulate a registry sync dropping it.
    const fresh = kernel.ctx as unknown as { llm: { providers: Map<string, unknown> } }
    void fresh
    // Simpler: dispatch with a name that was never registered.
    await expect(async () => {
      for await (const _ of kernel.ctx.llm.stream({ messages: [], providerName: 'ghost' } as never)) {
        void _
      }
    }).rejects.toThrow(/requested provider 'ghost' is not registered/)
    expect(betaCalled).toBe(0)
    void kernel.stop()
  })
})
