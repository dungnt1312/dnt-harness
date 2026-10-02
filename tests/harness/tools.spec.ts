/**
 * The tool pipeline: registry effects, schema listing, the guarded
 * execution path (`tools/pre-execute` deny/rewrite, `tools/post-execute`
 * transform), and the approval policy riding on pre-execute.
 */
import { describe, expect, it } from 'vitest'
import {
  Kernel,
  ToolsService,
  attachApproval,
  type ApprovalOptions,
  type ToolCall,
  type ToolDefinition,
} from 'dnt-harness'

function call(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: 'call-1', name, args }
}

const echoTool: ToolDefinition = {
  name: 'echo',
  description: 'echo its message argument',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  async execute(args) {
    const message = args['message']
    if (typeof message !== 'string') throw new Error("argument 'message' must be a string")
    return `echo: ${message}`
  },
}

/** Boot a kernel with the tools service (and optionally approval) mounted. */
function boot(approval?: ApprovalOptions): Kernel {
  const kernel = new Kernel()
  kernel.ctx.plugin(ToolsService)
  if (approval !== undefined) {
    kernel.ctx.plugin((ctx) => {
      attachApproval(ctx, approval)
    })
  }
  return kernel
}

describe('tool registry', () => {
  it('registers as an effect and lists schemas for request assembly', () => {
    const kernel = boot()
    const dispose = kernel.ctx.tools.register(echoTool)
    expect(kernel.ctx.tools.schemas().map((schema) => schema.name)).toEqual(['echo'])

    dispose()
    expect(kernel.ctx.tools.schemas()).toEqual([])
    void kernel.stop()
  })

  it('a duplicate registration fails loud', () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    expect(() => kernel.ctx.tools.register(echoTool)).toThrow(/already registered/)
    void kernel.stop()
  })

  it('an unknown tool becomes a failed result, not an exception', async () => {
    const kernel = boot()
    const result = await kernel.ctx.tools.execute(call('missing'))
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/unknown tool 'missing'/)
    void kernel.stop()
  })

  it('a throwing tool becomes a failed result the model can see', async () => {
    const kernel = boot()
    kernel.ctx.tools.register({
      ...echoTool,
      name: 'boom',
      async execute() {
        throw new Error('exploded')
      },
    })
    const result = await kernel.ctx.tools.execute(call('boom'))
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/error: Error: exploded/)
    void kernel.stop()
  })
})

describe('tools/pre-execute', () => {
  it('a veto denies the call with a reason', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    kernel.ctx.on('tools/pre-execute', async () => {
      return { kind: 'deny', reason: 'not on my watch' }
    })

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(result).toEqual({ ok: false, output: 'denied: not on my watch' })
    void kernel.stop()
  })

  it('a listener can rewrite the call arguments downstream', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      return next({ call: { ...payload.call, args: { message: 'rewritten' } } })
    })

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'original' }))
    expect(result).toEqual({ ok: true, output: 'echo: rewritten' })
    void kernel.stop()
  })
})

describe('tools/post-execute', () => {
  it('a listener can transform the result the model sees', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    kernel.ctx.on('tools/post-execute', async (payload, next) => {
      const result = await next()
      return { ...result, output: `[wrapped] ${result.output}` } as typeof result
    })

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(result).toEqual({ ok: true, output: '[wrapped] echo: hi' })
    void kernel.stop()
  })
})

describe('approval policy', () => {
  it('allow mode lets the call through', async () => {
    const kernel = boot({ policy: { echo: 'allow' }, defaultMode: 'deny' })
    kernel.ctx.tools.register(echoTool)

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(result).toEqual({ ok: true, output: 'echo: hi' })
    void kernel.stop()
  })

  it('deny mode blocks with a policy reason', async () => {
    const kernel = boot({ policy: { echo: 'deny' } })
    kernel.ctx.tools.register(echoTool)

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(result).toEqual({ ok: false, output: "denied: policy denies 'echo'" })
    void kernel.stop()
  })

  it('ask mode consults the answerer: yes allows, no denies', async () => {
    const answers: boolean[] = [true, false]
    const asked: string[] = []
    const kernel = boot({
      policy: { echo: 'ask' },
      askUser: async (c) => {
        asked.push(c.name)
        return answers.shift() ?? false
      },
    })
    kernel.ctx.tools.register(echoTool)

    const allowed = await kernel.ctx.tools.execute(call('echo', { message: 'a' }))
    expect(allowed).toEqual({ ok: true, output: 'echo: a' })

    const denied = await kernel.ctx.tools.execute(call('echo', { message: 'b' }))
    expect(denied).toEqual({ ok: false, output: "denied: the user denied 'echo'" })
    expect(asked).toEqual(['echo', 'echo'])
    void kernel.stop()
  })

  it('ask mode without an answerer fails closed', async () => {
    const kernel = boot({ policy: { echo: 'ask' } })
    kernel.ctx.tools.register(echoTool)

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/no askUser answerer is configured/)
    void kernel.stop()
  })

  it('unmounted approval removes its listener', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    const fiber = kernel.ctx.plugin((ctx) => {
      attachApproval(ctx, { policy: { echo: 'deny' } })
    })
    kernel.ctx.tools.register(echoTool)

    const denied = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(denied.ok).toBe(false)

    await fiber.dispose()
    const allowed = await kernel.ctx.tools.execute(call('echo', { message: 'hi' }))
    expect(allowed).toEqual({ ok: true, output: 'echo: hi' })
    void kernel.stop()
  })
})
