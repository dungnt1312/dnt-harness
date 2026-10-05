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
import { agentScope } from '../../src/harness/agent/scope.ts'

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

  it('a rewrite listener can rewrite the call arguments before authorization', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    kernel.ctx.on('tools/rewrite', async (payload, next) => {
      return next({ call: { ...payload.call, args: { message: 'rewritten' } } })
    })

    const result = await kernel.ctx.tools.execute(call('echo', { message: 'original' }))
    expect(result).toEqual({ ok: true, output: 'echo: rewritten' })
    void kernel.stop()
  })
})

describe('finalized rewrite identity', () => {
  it.each([
    ['Write', 'Read', false, true],
    ['Write', 'missing', false, false],
    ['Read', 'Write', true, false],
    ['Write', 'Read', true, true],
  ])('%s -> %s uses final implementation and root requirements', async (original, target, rootRequired, allowed) => {
    const kernel = boot()
    const ran: string[] = []
    for (const name of ['Write', 'Read']) kernel.ctx.tools.register({
      ...echoTool, name, requiresRoot: name === 'Write' && rootRequired,
      async execute() { ran.push(name); return name },
    })
    const cleaned: boolean[] = []
    const posts: string[] = []
    kernel.ctx.tools.setApprovedPathResolver(async (_call, allow) => { cleaned.push(allow); return undefined })
    kernel.ctx.on('tools/post-execute', async ({ call }, next) => { posts.push(call.name); return next() })
    kernel.ctx.on('tools/rewrite', async ({ call }, next) => next({ call: { ...call, name: target } }))
    const prepared = await kernel.ctx.tools.prepare(call(original))
    expect(prepared.call.name).toBe(target)
    expect((await prepared.execute()).ok).toBe(allowed)
    expect(ran).toEqual(allowed ? [target] : [])
    expect(posts).toEqual([target])
    expect(cleaned).toEqual([allowed])
    await kernel.stop()
  })

  it('unknown original tools fail closed without rewrite recovery', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    let rewrote = false
    kernel.ctx.on('tools/rewrite', async ({ call }, next) => {
      rewrote = true
      return next({ call: { ...call, name: 'echo' } })
    })
    expect((await kernel.ctx.tools.execute(call('missing'))).ok).toBe(false)
    expect(rewrote).toBe(false)
    await kernel.stop()
  })

  it.each(['forward-restored', 'return-masked'])('rejects intermediate %s authorization rewrites before another gate sees them', async (style) => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    const seen: string[] = []
    const cleaned: boolean[] = []
    kernel.ctx.tools.setApprovedPathResolver(async (_call, allowed) => { cleaned.push(allowed); return undefined })
    kernel.ctx.on('tools/pre-execute', async ({ call }, next) => {
      const result = await next()
      return { ...result, call }
    })
    kernel.ctx.on('tools/pre-execute', async ({ call }, next) => {
      const changed = { ...call, args: { message: 'unauthorized' } }
      if (style === 'return-masked') return { kind: 'allow', call: changed }
      try { return await next({ call: changed }) } catch { return { kind: 'allow', call } }
    })
    kernel.ctx.on('tools/pre-execute', async ({ call }, next) => {
      seen.push(String(call.args['message']))
      return next({ call: { ...call, args: { message: 'original' } } })
    })
    const prepared = await kernel.ctx.tools.prepare(call('echo', { message: 'original' }))
    expect((await prepared.execute()).output).toMatch(/authorization.*rewrite/i)
    expect(seen).toEqual([])
    expect(cleaned).toEqual([false])
    await kernel.stop()
  })

  it('drops pending approved-path state when rewrite middleware throws', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    const cleaned: boolean[] = []
    kernel.ctx.tools.setApprovedPathResolver(async (_call, allowed) => { cleaned.push(allowed); return undefined })
    kernel.ctx.on('tools/rewrite', async () => { throw new Error('rewrite failed') })
    await expect(kernel.ctx.tools.prepare(call('echo'))).rejects.toThrow('rewrite failed')
    expect(cleaned).toEqual([false])
    await kernel.stop()
  })

  it.each(['forward', 'return', 'deny'])('rejects pre-execute %s rewrites and cleans up denied intent', async (style) => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    const cleaned: [string, boolean][] = []
    kernel.ctx.tools.setApprovedPathResolver(async (call, allowed) => { cleaned.push([String(call.args['message']), allowed]); return undefined })
    kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      const changed = { ...payload.call, args: { message: 'unauthorized' } }
      if (style === 'forward') return next({ call: changed })
      if (style === 'deny') return { kind: 'deny', reason: 'veto', call: changed }
      return { kind: 'allow', call: changed }
    })
    const prepared = await kernel.ctx.tools.prepare(call('echo', { message: 'original' }))
    expect(prepared.call.args).toEqual({ message: 'original' })
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/authorization.*rewrite/i)
    expect(cleaned).toEqual([['original', false]])
    await kernel.stop()
  })

  it('freezes and detaches the call a rewrite denial carries', async () => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    const owned = { message: 'x', nested: { v: 1 } }
    kernel.ctx.on('tools/rewrite', async ({ call }) => ({ kind: 'deny', reason: 'veto', call: { ...call, args: owned } }))
    const prepared = await kernel.ctx.tools.prepare(call('echo', { message: 'o' }))
    owned.nested.v = 2
    owned.message = 'mutated'
    expect(prepared.call.args).toEqual({ message: 'x', nested: { v: 1 } })
    expect(Object.isFrozen(prepared.call.args)).toBe(true)
    expect(Object.isFrozen(prepared.call.args['nested'])).toBe(true)
    expect((await prepared.execute()).output).toBe('denied: veto')
    await kernel.stop()
  })

  it.each(['swapped-exec', 'swapped-root', 'malformed-empty', 'malformed-call'])('rejects a forwarded %s payload before another gate sees it', async (style) => {
    const kernel = boot()
    kernel.ctx.tools.register(echoTool)
    const seen: string[] = []
    const cleaned: boolean[] = []
    kernel.ctx.tools.setApprovedPathResolver(async (_call, allowed) => { cleaned.push(allowed); return undefined })
    kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      if (style === 'swapped-exec') return next({ call: payload.call, exec: { ...payload.exec, executionId: 'exec-other' as never } })
      if (style === 'swapped-root') return next({ call: payload.call, exec: { ...payload.exec, root: '/elsewhere' } })
      if (style === 'malformed-empty') return next({} as never)
      return next({ call: null } as never)
    })
    kernel.ctx.on('tools/pre-execute', async (payload, next) => { seen.push(payload.exec.executionId ?? ''); return next() })
    const prepared = await kernel.ctx.tools.prepare(call('echo', { message: 'o' }))
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(style.startsWith('malformed') ? /malformed/ : /authorization.*rewrite/i)
    expect(seen).toEqual([])
    expect(cleaned).toEqual([false])
    await kernel.stop()
  })

  it('a rejected forward closes the chain: retrying through next() never opens a question', async () => {
    const asked: string[] = []
    const kernel = boot({ policy: { echo: 'ask' }, askUser: async (c) => { asked.push(c.name); return true } })
    kernel.ctx.tools.register(echoTool)
    kernel.ctx.on('tools/pre-execute', async (payload, next) => {
      await next({ call: { ...payload.call, args: { message: 'unauthorized' } } })
      return next(payload)
    }, true)
    const prepared = await kernel.ctx.tools.prepare(call('echo', { message: 'original' }))
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/authorization.*rewrite/i)
    expect(asked).toEqual([])
    await kernel.stop()
  })

  it('pre-execute cannot mutate the host execution identity or additional-root grants in place', async () => {
    const kernel = boot()
    const grants = [{ path: '/granted', access: 'read' as const }]
    kernel.ctx.tools.setRootResolver(() => ({ root: '/workspace', additionalRoots: grants }))
    let executed: unknown
    let runtimeStateFrozen: unknown
    kernel.ctx.tools.register({
      ...echoTool,
      async execute(_args, exec) {
        executed = {
          root: exec.root,
          sessionId: exec.sessionId,
          additionalRoots: exec.additionalRoots?.map((root) => ({ ...root })),
        }
        return 'ok'
      },
    })
    const mutationErrors: unknown[] = []
    kernel.ctx.on('tools/pre-execute', async ({ exec }, next) => {
      runtimeStateFrozen = {
        signal: exec.signal === undefined ? undefined : Object.isFrozen(exec.signal),
        observations: exec.observations === undefined ? undefined : Object.isFrozen(exec.observations),
      }
      for (const mutate of [
        () => { (exec as { root: string }).root = '/elsewhere' },
        () => { (exec as { sessionId?: string }).sessionId = 'other' },
        () => { (exec.additionalRoots as Array<{ path: string; access: 'read' | 'write' }>).push({ path: '/extra', access: 'write' }) },
        () => { (exec.additionalRoots?.[0] as { path: string }).path = '/elsewhere' },
        () => { (exec.additionalRoots?.[0] as { access: 'read' | 'write' }).access = 'write' },
      ]) {
        try { mutate() } catch (error) { mutationErrors.push(error) }
      }
      return next()
    })
    const scope = { sessionId: 'session-a', rootSessionId: 'root-a', workspaceId: 'workspace-a' } as unknown as Parameters<typeof agentScope.run>[0]
    const controller = new AbortController()
    const result = await agentScope.run(scope, () => kernel.ctx.tools.execute(call('echo', { message: 'original' }), { signal: controller.signal }))
    expect(result).toEqual({ ok: true, output: 'ok' })
    expect(mutationErrors).toHaveLength(5)
    expect(executed).toEqual({
      root: '/workspace',
      sessionId: 'session-a',
      additionalRoots: [{ path: '/granted', access: 'read' }],
    })
    expect(grants).toEqual([{ path: '/granted', access: 'read' }])
    expect(runtimeStateFrozen).toEqual({ signal: false, observations: false })
    await kernel.stop()
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
