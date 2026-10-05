/**
 * The final authority gate: a call admitted at preparation is re-checked
 * immediately before its side effect, so authority that narrowed while it
 * waited (an approval, a stale batch) refuses it truthfully.
 */
import { describe, expect, it } from 'vitest'
import {
  Kernel,
  ToolsService,
  createApprovalReceiptRegistry,
  type ApprovalScope,
  type AskRequirement,
  type ToolDefinition,
} from 'dnt-harness'

function boot(): { kernel: Kernel; ran: string[] } {
  const kernel = new Kernel()
  kernel.ctx.plugin(ToolsService)
  const ran: string[] = []
  const tool: ToolDefinition = {
    name: 'Write',
    description: 'write',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args) {
      ran.push(String(args['path']))
      return 'written'
    },
  }
  kernel.ctx.tools.register(tool)
  return { kernel, ran }
}

describe('tool final gate', () => {
  it('snapshots nested rewrite input for authorization, durable intent, final gate and body', async () => {
    const { kernel } = boot()
    const args = { nested: { values: ['original'] } }
    const seen: unknown[] = []
    kernel.ctx.tools.register({
      name: 'Read', description: 'read', parameters: { type: 'object', properties: {} },
      async execute(input) { seen.push(input); return JSON.stringify(input) },
    })
    kernel.ctx.on('tools/rewrite', async ({ call }, next) => next({ call: { ...call, name: 'read', args } }))
    kernel.ctx.on('tools/pre-execute', async ({ call }, next) => { seen.push(call.args); return next() })
    kernel.ctx.on('tools/final-gate', async ({ call }) => { seen.push(call.args); return undefined })
    const prepared = await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: {} })
    args.nested.values[0] = 'mutated'
    expect(() => (prepared.call.args['nested'] as typeof args.nested).values.push('injected')).toThrow()
    expect(Object.isFrozen(prepared.call)).toBe(true)
    expect((await prepared.execute()).output).toBe(JSON.stringify({ nested: { values: ['original'] } }))
    expect(seen).toEqual([prepared.call.args, prepared.call.args, prepared.call.args])
    expect(seen.every((input) => input === prepared.call.args)).toBe(true)
    await kernel.stop()
  })

  it('a narrowing between preparation and execution refuses the side effect', async () => {
    const { kernel, ran } = boot()
    let narrowed = false
    kernel.ctx.on('tools/final-gate', async (payload) => (narrowed ? `mode no longer exposes '${payload.call.name}'` : undefined))
    const prepared = await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'a.txt' } })
    narrowed = true // e.g. the root switched to Plan while this call awaited approval
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toBe("denied: mode no longer exposes 'Write'")
    expect(ran).toEqual([])
    await kernel.stop()
  })

  it('an unchanged authority lets the call run, and the gate sees its execution id', async () => {
    const { kernel, ran } = boot()
    const seen: (string | undefined)[] = []
    kernel.ctx.on('tools/final-gate', async (payload) => {
      seen.push(payload.exec.executionId)
      return undefined
    })
    const prepared = await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'b.txt' } })
    const result = await prepared.execute()
    expect(result.ok).toBe(true)
    expect(ran).toEqual(['b.txt'])
    expect(seen).toEqual([prepared.executionId])
    await kernel.stop()
  })

  it('prepared execution is single-use and cannot duplicate a side effect', async () => {
    const { kernel, ran } = boot()
    const prepared = await kernel.ctx.tools.prepare({ id: 'same-model-id', name: 'Write', args: { path: 'once.txt' } })
    expect((await prepared.execute()).ok).toBe(true)
    const duplicate = await prepared.execute()
    expect(duplicate.ok).toBe(false)
    expect(duplicate.output).toMatch(/already been executed/)
    expect(ran).toEqual(['once.txt'])
    await kernel.stop()
  })

  it('stop landing while the async final gate waits prevents an unstarted body', async () => {
    const { kernel, ran } = boot()
    const controller = new AbortController()
    let entered!: () => void
    const gateEntered = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gateRelease = new Promise<void>((resolve) => { release = resolve })
    kernel.ctx.on('tools/final-gate', async () => { entered(); await gateRelease; return undefined })
    const prepared = await kernel.ctx.tools.prepare({ id: 'c-stop-gate', name: 'Write', args: { path: 'never-gate.txt' } }, { signal: controller.signal })
    const resultPromise = prepared.execute()
    await gateEntered
    controller.abort()
    release()
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/stop requested before dispatch/)
    expect(ran).toEqual([])
    await kernel.stop()
  })

  it('stop after preparation but before dispatch prevents an unstarted body', async () => {
    const { kernel, ran } = boot()
    const controller = new AbortController()
    const prepared = await kernel.ctx.tools.prepare({ id: 'c-stop', name: 'Write', args: { path: 'never.txt' } }, { signal: controller.signal })
    controller.abort()
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/stop requested before dispatch/)
    expect(ran).toEqual([])
    await kernel.stop()
  })

  it('retires an approved receipt when a later pre-execute listener denies', async () => {
    const { kernel, ran } = boot()
    const registry = createApprovalReceiptRegistry()
    const requirements: readonly AskRequirement[] = [{ kind: 'tool-policy', subjectFingerprint: 'Write:ask', version: 1 }]
    let approvedScope: ApprovalScope | undefined
    let receiptIssued = false
    kernel.ctx.tools.setAuthorityRetirer((executionId) => registry.retire(executionId))
    kernel.ctx.on('tools/pre-execute', async ({ call, exec }, next) => {
      approvedScope = {
        sessionId: 'session' as ApprovalScope['sessionId'],
        rootSessionId: 'root' as ApprovalScope['rootSessionId'],
        turnId: undefined,
        executionId: exec.executionId,
        workspaceId: 'work',
      }
      receiptIssued = registry.issue(call, approvedScope, requirements) !== undefined
      return next()
    })
    kernel.ctx.on('tools/pre-execute', async ({ call }) => ({ kind: 'deny', reason: 'live policy denies this call', call }))

    const prepared = await kernel.ctx.tools.prepare({ id: 'approved-then-denied', name: 'Write', args: { path: 'never.txt' } })
    expect(receiptIssued).toBe(true)
    expect(approvedScope?.executionId).toBe(prepared.executionId)
    expect(registry.covers(prepared.call, approvedScope!, requirements)).toBe(false)
    const result = await prepared.execute()
    expect(result).toEqual({ ok: false, output: 'denied: live policy denies this call' })
    expect(ran).toEqual([])
    await kernel.stop()
  })

  it('retires execution authority on abandoned preparation and non-dispatch exits', async () => {
    const { kernel } = boot()
    const retired: string[] = []
    kernel.ctx.tools.setAuthorityRetirer((executionId) => retired.push(executionId))

    const stop = new AbortController()
    const stopped = await kernel.ctx.tools.prepare({ id: 'stop', name: 'Write', args: {} }, { signal: stop.signal })
    stop.abort()
    await stopped.execute()

    kernel.ctx.on('tools/final-gate', async ({ call }) => call.id === 'deny' ? 'narrowed' : undefined)
    const denied = await kernel.ctx.tools.prepare({ id: 'deny', name: 'Write', args: {} })
    await denied.execute()

    kernel.ctx.tools.register({ name: 'Rooted', description: 'rooted', requiresRoot: true, parameters: { type: 'object', properties: {} }, execute: async () => 'no' })
    const rooted = await kernel.ctx.tools.prepare({ id: 'root', name: 'Rooted', args: {} })
    await rooted.execute()

    kernel.ctx.tools.setApprovedPathResolver(async (call) => {
      if (call.id === 'resolver') throw new Error('grant persistence failed')
      return undefined
    })
    const resolverFailed = await kernel.ctx.tools.prepare({ id: 'resolver', name: 'Write', args: {} })
    await resolverFailed.execute()

    const dispose = kernel.ctx.on('tools/rewrite', async ({ call }, next) => {
      if (call.id === 'rewrite') throw new Error('rewrite failed')
      return next()
    })
    const beforeRewrite = new Set(retired)
    await expect(kernel.ctx.tools.prepare({ id: 'rewrite', name: 'Write', args: {} })).rejects.toThrow(/rewrite failed/)
    await dispose()
    const rewriteExecutionId = retired.find((executionId) => !beforeRewrite.has(executionId))

    expect(retired).toEqual([
      stopped.executionId,
      denied.executionId,
      rooted.executionId,
      resolverFailed.executionId,
      rewriteExecutionId,
      rewriteExecutionId,
    ])
    expect(new Set(retired).size).toBe(5)
    await kernel.stop()
  })

  it('a throwing gate fails closed', async () => {
    const { kernel, ran } = boot()
    kernel.ctx.on('tools/final-gate', async () => { throw new Error('policy store unreadable') })
    const result = await (await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'c.txt' } })).execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/final authority check failed: policy store unreadable/)
    expect(ran).toEqual([])
    await kernel.stop()
  })
})
