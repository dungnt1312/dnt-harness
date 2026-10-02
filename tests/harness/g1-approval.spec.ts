/**
 * G1 approval semantics: expiry never approves implicitly, a stop cancels
 * waiters, a live policy change gates pending approvals (an answer cannot
 * override a deny), and approval traffic is recorded as durable session
 * events bound to the exact call.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  agentScope,
  attachApproval,
  type ApprovalHandle,
  type ApprovalMode,
  type PolicySource,
  type Session,
  type ToolCall,
  type ToolDefinition,
} from 'dnt-harness'

const echoTool: ToolDefinition = {
  name: 'Echo',
  description: 'echo its message argument',
  parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
  async execute(args) {
    return `echo: ${String(args['message'])}`
  },
}

function call(name: string): ToolCall {
  return { id: 'call-1', name, args: { message: 'hi' } }
}

const rootTmp = path.join(tmpdir(), 'dnt-harness-approval-files')

function boot(policy: PolicySource, askUser?: (c: ToolCall) => Promise<boolean>): {
  kernel: Kernel
  session: Session
  handle: ApprovalHandle
} {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  const session = kernel.ctx.sessions.create()
  const handle = attachApproval(kernel.ctx, {
    policy,
    expiryMs: 150,
    ...(askUser !== undefined ? { askUser } : {}),
  })
  return { kernel, session, handle }
}

describe('approval lifecycle', () => {
  it('an undecided approval expires and never approves implicitly', async () => {
    const { kernel, session } = boot({ Echo: 'ask' }, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(echoTool)
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(call('Echo'))
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/expired/)
    void kernel.stop()
  }, 5_000)

  it('a stop cancels the waiter: the tool result says cancelled', async () => {
    const controller = new AbortController()
    const { kernel, session } = boot({ Echo: 'ask' }, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(echoTool)
    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute(call('Echo'), { signal: controller.signal }),
    ) as Promise<{ ok: boolean; output: string }>
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/cancelled/)
    void kernel.stop()
  })

  it('a live policy change gates a pending approval: an answer cannot override a deny', async () => {
    let current: Record<string, ApprovalMode> = { Echo: 'ask' }
    let releaseAnswer: ((allow: boolean) => void) | undefined
    const { kernel, session, handle } = boot(
      () => current,
      // The human is still thinking when the policy flips to deny.
      () => new Promise<boolean>((resolve) => {
        releaseAnswer = resolve
      }),
    )
    kernel.ctx.tools.register(echoTool)

    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute(call('Echo')),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    current = { Echo: 'deny' }
    // The operator changes the live permission control; pending questions
    // re-evaluate and the pending ask settles denied.
    handle.reevaluate({})
    const result = (await resultPromise) as { ok: boolean; output: string }
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/policy now denies/)
    // The late human answer cannot execute anything either.
    releaseAnswer?.(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    void kernel.stop()
  })

  it('an allowed call runs when the policy still says ask', async () => {
    const { kernel, session } = boot({ Echo: 'ask' }, () => Promise.resolve(true))
    kernel.ctx.tools.register(echoTool)
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(call('Echo'))
    })
    expect(result).toEqual({ ok: true, output: 'echo: hi' })
    void kernel.stop()
  })

  it('approval questions and decisions land in the durable session log', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(echoTool)
    attachApproval(kernel.ctx, { policy: { Echo: 'ask' }, askUser: () => Promise.resolve(true) })

    await agentScope.run({ sessionId: session.id }, async () => {
      await kernel.ctx.tools.execute(call('Echo'))
    })
    await session.durable()

    const request = session.events.find((e) => e.type === 'approval/request')
    expect(request?.type === 'approval/request' && request.call.name).toBe('Echo')
    expect(request?.type === 'approval/request' && request.call.args).toEqual({ message: 'hi' })
    const decision = session.events.find((e) => e.type === 'approval/decision')
    expect(decision?.type === 'approval/decision' && decision.decision).toBe('allow')
    void kernel.stop()
  })

  it('an expired Write approval leaves the target file unchanged', async () => {
    const { kernel, session } = boot({ Write: 'ask' }, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register({
      name: 'Write',
      description: 'write a file',
      requiresRoot: true,
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      async execute(args, exec) {
        const { resolveGrantedPath } = await import('../../src/capabilities/fs/tools.ts')
        const abs = await resolveGrantedPath(exec.root, String(args['path']))
        const { promises: fs } = await import('node:fs')
        await fs.writeFile(abs, String(args['content']), 'utf8')
        return `wrote ${String(args['path'])}`
      },
    })
    kernel.ctx.tools.setRootResolver(() => ({ root: process.cwd() }))

    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute({ id: 'call-w', name: 'Write', args: { path: 'expired-write-target.txt', content: 'never' } })
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/expired/)
    // The side effect never ran: no file, no partial write.
    const { promises: fs } = await import('node:fs')
    await expect(fs.access(path.join(rootTmp, 'expired-write-target.txt'))).rejects.toThrow()
    void kernel.stop()
  })

  it('a denied Edit leaves the target file unchanged', async () => {
    const { kernel, session } = boot({ Edit: 'deny' })
    kernel.ctx.tools.register({
      name: 'Edit',
      description: 'edit a file',
      requiresRoot: true,
      parameters: { type: 'object', properties: { path: { type: 'string' }, old: { type: 'string' }, new: { type: 'string' } }, required: ['path', 'old', 'new'] },
      async execute() {
        throw new Error('the tool body must never run on denial')
      },
    })
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute({ id: 'call-e', name: 'Edit', args: { path: 'x', old: 'a', new: 'b' } })
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/denied/)
    void kernel.stop()
  })

  it('the catch-all * applies after exact and mcp__server__* lookups', async () => {
    const { kernel, session } = boot({ '*': 'deny' })
    kernel.ctx.tools.register(echoTool)
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(call('Echo'))
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/policy denies 'Echo'/)
    void kernel.stop()
  })

  it('mcp__server__* wins over the catch-all *', async () => {
    const mcpTool: ToolDefinition = {
      name: 'mcp__fixture__query',
      description: 'mcp query',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() { return 'ok' },
    }
    const { kernel, session } = boot({ '*': 'deny', 'mcp__fixture__*': 'allow' })
    kernel.ctx.tools.register(mcpTool)
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute({ id: 'm1', name: 'mcp__fixture__query', args: {} })
    })
    expect(result).toEqual({ ok: true, output: 'ok' })
    void kernel.stop()
  })

  it('an already-aborted signal cancels before waiting for a human', async () => {
    const started = Date.now()
    const controller = new AbortController()
    controller.abort()
    const { kernel, session } = boot({ Echo: 'ask' }, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(echoTool)
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute(call('Echo'), { signal: controller.signal })
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/cancelled/)
    expect(Date.now() - started).toBeLessThan(1000)
    void kernel.stop()
  })

  it('a live policy change to allow settles a pending ask without a human answer', async () => {
    let current: Record<string, ApprovalMode> = { Echo: 'ask' }
    const { kernel, session, handle } = boot(() => current, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(echoTool)
    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute(call('Echo')),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    current = { Echo: 'allow' }
    // Deliberately outside agentScope: an Always-allow arrives on an HTTP
    // request with no agent in flight, and the decision still has to be
    // recorded against the session that asked.
    handle.reevaluate({})
    const result = (await resultPromise) as { ok: boolean; output: string }
    expect(result).toEqual({ ok: true, output: 'echo: hi' })
    await session.durable()
    const decision = session.events.find((e) => e.type === 'approval/decision')
    expect(decision?.type === 'approval/decision' && decision.decision).toBe('allow')
    const request = session.events.find((e) => e.type === 'approval/request')
    expect(decision?.type === 'approval/decision' && decision.approvalId)
      .toBe(request?.type === 'approval/request' ? request.approvalId : undefined)
    void kernel.stop()
  })

  it('a policy change to deny records its decision too', async () => {
    let current: Record<string, ApprovalMode> = { Echo: 'ask' }
    const { kernel, session, handle } = boot(() => current, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(echoTool)
    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute(call('Echo')),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    current = { Echo: 'deny' }
    handle.reevaluate({})
    await resultPromise
    await session.durable()
    const decision = session.events.find((e) => e.type === 'approval/decision')
    expect(decision?.type === 'approval/decision' && decision.decision).toBe('deny')
    void kernel.stop()
  })

  it('the answerer receives the expiry deadline for the question it must ask', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    kernel.ctx.tools.register(echoTool)
    const before = Date.now()
    let deadline = 0
    attachApproval(kernel.ctx, {
      policy: { Echo: 'ask' },
      expiryMs: 60_000,
      askUser: (_call, lifecycle) => {
        deadline = lifecycle.expiresAt
        return Promise.resolve(true)
      },
    })
    await agentScope.run({ sessionId: session.id }, async () => {
      await kernel.ctx.tools.execute(call('Echo'))
    })
    // A transport has to show the window it is asking inside, so the
    // deadline comes from the policy's own timer, not a second estimate.
    expect(deadline).toBeGreaterThanOrEqual(before + 60_000)
    void kernel.stop()
  })

  it('legacy lowercase permission keys normalize to canonical built-in tools', async () => {
    const { kernel, session } = boot({ glob: 'deny' })
    kernel.ctx.tools.register({
      name: 'Glob',
      description: 'list files',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return 'no matches'
      },
    })
    let result: { ok: boolean; output: string } | undefined
    await agentScope.run({ sessionId: session.id }, async () => {
      result = await kernel.ctx.tools.execute({ id: 'call-g', name: 'glob', args: {} })
    })
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/policy denies 'Glob'/)
    void kernel.stop()
  })
})
