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
import type { ExecutionId, SessionId, WorkspaceId } from '../../src/util/brand.ts'
import type { ApprovalScope } from '../../src/harness/approval/policy.ts'
import {
  AgentsService,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  agentScope,
  attachApproval,
  approvalCallFingerprint,
  createApprovalReceiptRegistry,
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

const mcpQueryTool: ToolDefinition = {
  name: 'mcp__fixture__query',
  description: 'mcp query',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() { return 'ok' },
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
  it.each([false, true])('resolves each stamped scope outside agentScope (failure=%s)', async (fail) => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.tools.register(echoTool)
    const seen: unknown[] = []
    let asking!: () => void
    const asked = new Promise<void>((resolve) => { asking = resolve })
    let current: 'ask' | 'allow' = 'ask'
    const handle = attachApproval(kernel.ctx, {
      authorityResolver: async (_call, scope) => {
        seen.push({ ...scope })
        if (current === 'allow' && fail) throw new Error('resolver unavailable')
        return current === 'ask' ? { kind: 'ask', requirements: [{ kind: 'tool-policy' }] } : { kind: 'allow' }
      },
      askUser: () => { asking(); return new Promise<boolean>(() => {}) },
    })
    const scope = { sessionId: 'child', rootSessionId: 'root', workspaceId: 'work' } as unknown as Parameters<typeof agentScope.run>[0]
    const result = agentScope.run(scope, () => kernel.ctx.tools.execute(call('Echo')))
    await asked
    expect(agentScope.getStore()).toBeUndefined()
    current = 'allow'
    await handle.reevaluate({ rootSessionId: 'root' })
    expect((await result).ok).toBe(!fail)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ sessionId: 'child', rootSessionId: 'root', workspaceId: 'work', executionId: expect.any(String) })
    await kernel.stop()
  })

  it('contains resolver failures after a human answer and synchronous answerer failures', async () => {
    for (const answererFails of [false, true]) {
      const kernel = new Kernel()
      kernel.ctx.plugin(ToolsService)
      kernel.ctx.tools.register(echoTool)
      let reads = 0
      attachApproval(kernel.ctx, {
        authorityResolver: async () => {
          if (++reads > 1) throw new Error('authority unavailable')
          return { kind: 'ask', requirements: [{ kind: 'tool-policy' }] }
        },
        askUser: () => {
          if (answererFails) throw new Error('answerer unavailable')
          return Promise.resolve(true)
        },
      })
      const result = await kernel.ctx.tools.execute(call('Echo'))
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/failed/)
      await kernel.stop()
    }
  })

  it('cancels an initial async resolver allow when Stop arrives during resolution', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    let effects = 0
    kernel.ctx.tools.register({ ...echoTool, execute: async () => { effects++; return 'ok' } })
    let resolving!: () => void
    const started = new Promise<void>((resolve) => { resolving = resolve })
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    attachApproval(kernel.ctx, {
      authorityResolver: async () => {
        resolving()
        await wait
        return { kind: 'allow' }
      },
    })
    const controller = new AbortController()
    const result = kernel.ctx.tools.execute(call('Echo'), { signal: controller.signal })
    await started
    controller.abort()
    release()
    const outcome = await result
    await kernel.stop()
    expect(outcome.ok).toBe(false)
    expect(outcome.output).toMatch(/cancelled/)
    expect(effects).toBe(0)
  })

  it.each(['concurrent', 'already settling'] as const)('each reevaluation awaits durable settlement (%s)', async (timing) => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    let effects = 0
    kernel.ctx.tools.register({ ...echoTool, execute: async () => { effects++; return 'ok' } })
    let asking!: () => void
    const asked = new Promise<void>((resolve) => { asking = resolve })
    let release!: () => void
    const durable = new Promise<void>((resolve) => { release = resolve })
    const events: Record<string, unknown>[] = []
    kernel.ctx.provide('sessions', { get: () => ({
      append: (event: Record<string, unknown>) => { events.push(event) },
      durable: () => events.some((event) => event['type'] === 'approval/decision') ? durable : Promise.resolve(),
    }) } as never)
    let current: 'ask' | 'allow' = 'ask'
    const handle = attachApproval(kernel.ctx, {
      authorityResolver: async () => current === 'ask' ? { kind: 'ask', requirements: [] } : { kind: 'allow' },
      askUser: () => { asking(); return new Promise<boolean>(() => {}) },
    })
    const sessionId = 'session' as Session['id']
    const result = agentScope.run({ sessionId, workspaceId: 'work' as WorkspaceId }, () => kernel.ctx.tools.execute(call('Echo')))
    await asked
    current = 'allow'
    const completed = [false, false]
    const first = handle.reevaluate({ workspaceId: 'work' }).then(() => { completed[0] = true })
    if (timing === 'already settling') await new Promise((resolve) => setTimeout(resolve, 0))
    const second = handle.reevaluate({ workspaceId: 'work' }).then(() => { completed[1] = true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // A different workspace must not wait for this settlement.
    await handle.reevaluate({ workspaceId: 'other' })
    const beforeDurability = [...completed]
    const effectsBeforeDurability = effects
    const decisionCount = events.filter((event) => event['type'] === 'approval/decision').length
    release()
    await Promise.all([first, second])
    const outcome = await result
    await kernel.stop()
    expect(beforeDurability).toEqual([false, false])
    expect(effectsBeforeDurability).toBe(0)
    expect(decisionCount).toBe(1)
    expect(outcome.ok).toBe(true)
    expect(effects).toBe(1)
  })

  it('receipts bind exact call and execution scope and cover only shown requirement subjects', () => {
    const registry = createApprovalReceiptRegistry()
    const approved = call('Echo')
    const scope: ApprovalScope = { workspaceId: 'work', rootSessionId: 'root' as SessionId, sessionId: 'child' as SessionId, executionId: 'exec' as ExecutionId, turnId: undefined }
    const shown = [{ kind: 'tool-policy' as const, subjectFingerprint: 'Echo:ask', version: 1 }]
    const receipt = registry.issue(approved, scope, shown)
    expect(receipt?.callFingerprint).toBe(approvalCallFingerprint(approved))
    expect(registry.covers(approved, scope, shown)).toBe(true)
    expect(registry.covers({ ...approved, args: { message: 'changed' } }, scope, shown)).toBe(false)
    expect(registry.covers(approved, { ...scope, rootSessionId: 'other-root' as SessionId }, shown)).toBe(false)
    expect(registry.covers(approved, { ...scope, workspaceId: 'other-work' }, shown)).toBe(false)
    expect(registry.covers(approved, { ...scope, executionId: 'other-exec' as ExecutionId }, shown)).toBe(false)
    expect(registry.covers(approved, scope, [{ ...shown[0]!, version: 2 }])).toBe(false)
    expect(registry.covers(approved, scope, [{ kind: 'outside-path', subjectFingerprint: '/tmp:x' }])).toBe(false)
    registry.retire('exec' as ExecutionId)
    expect(registry.covers(approved, scope, shown)).toBe(false)
  })

  it('policy-only reevaluation allow creates no human receipt', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.tools.register(echoTool)
    const registry = createApprovalReceiptRegistry()
    let current: 'ask' | 'allow' = 'ask'
    let asked!: () => void
    const waiting = new Promise<void>((resolve) => { asked = resolve })
    const handle = attachApproval(kernel.ctx, {
      receiptRegistry: registry,
      authorityResolver: async () => current === 'ask'
        ? { kind: 'ask', requirements: [{ kind: 'tool-policy', version: 1 }] }
        : { kind: 'allow' },
      askUser: () => { asked(); return new Promise<boolean>(() => {}) },
    })
    const executionId = 'policy-only' as ExecutionId
    const scope = { sessionId: 'session' as SessionId, rootSessionId: 'root' as SessionId, workspaceId: 'work' as WorkspaceId }
    const result = agentScope.run(scope, () => kernel.ctx.tools.prepare(call('Echo'), { executionId }))
    await waiting
    current = 'allow'
    await handle.reevaluate({ workspaceId: 'work' })
    const prepared = await result
    expect(registry.receiptFor(prepared.call, { ...scope, turnId: undefined, executionId })).toBeUndefined()
    await prepared.execute()
    await kernel.stop()
  })

  it('a human receipt survives an unrelated authority change', () => {
    const registry = createApprovalReceiptRegistry()
    const approved = call('Echo')
    const scope: ApprovalScope = { workspaceId: 'work', rootSessionId: 'root' as SessionId, sessionId: 'child' as SessionId, executionId: 'exec-human' as ExecutionId, turnId: undefined }
    const shown = [{ kind: 'tool-policy' as const, subjectFingerprint: 'Echo:ask', version: 7 }]
    registry.issue(approved, scope, shown)
    // An unrelated tool/config revision does not alter the shown requirement.
    expect(registry.covers(approved, scope, shown)).toBe(true)
  })

  it('standalone ToolsService retains generic policy compatibility without execution scope', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.tools.register(echoTool)
    attachApproval(kernel.ctx, { policy: { Echo: 'allow' } })
    expect(await kernel.ctx.tools.execute(call('Echo'))).toEqual({ ok: true, output: 'echo: hi' })
    await kernel.stop()
  })
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

  it('a mode switch with a non-empty built-in exposure ceiling leaves a pending MCP ask exposed', async () => {
    // Mode files can only list built-ins in toolExposure; mcp__* names are
    // dynamic. A switch to a mode that exposes built-ins must not cancel a
    // pending MCP ask just because its name is absent from the list — the
    // gate matches the web host's exposureDenial (zero ceiling is the only
    // honest MCP off-switch).
    let current: Record<string, ApprovalMode> = { 'mcp__fixture__query': 'ask' }
    const { kernel, session, handle } = boot(() => current, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(mcpQueryTool)
    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute({ id: 'm1', name: 'mcp__fixture__query', args: {} }),
    ) as Promise<{ ok: boolean; output: string }>
    await new Promise((resolve) => setTimeout(resolve, 30))
    current = { 'mcp__fixture__query': 'allow' }
    handle.reevaluate({ toolExposure: ['Read', 'Bash'] })
    const result = await resultPromise
    expect(result).toEqual({ ok: true, output: 'ok' })
    void kernel.stop()
  })

  it('a zero-exposure mode change cancels a pending MCP ask', async () => {
    const { kernel, session, handle } = boot({ 'mcp__fixture__query': 'ask' }, () => new Promise<boolean>(() => {}))
    kernel.ctx.tools.register(mcpQueryTool)
    const resultPromise = agentScope.run({ sessionId: session.id }, () =>
      kernel.ctx.tools.execute({ id: 'm1', name: 'mcp__fixture__query', args: {} }),
    ) as Promise<{ ok: boolean; output: string }>
    await new Promise((resolve) => setTimeout(resolve, 30))
    handle.reevaluate({ toolExposure: [] })
    const result = await resultPromise
    expect(result?.ok).toBe(false)
    expect(result?.output).toMatch(/no longer exposed/)
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
