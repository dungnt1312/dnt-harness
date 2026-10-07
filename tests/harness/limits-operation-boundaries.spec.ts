/**
 * Live limits reach new operations without restarting services: each model
 * request, tool body, and child Bash execution captures one policy at its
 * boundary and keeps it while a newer revision is published mid-flight.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  ProcessRegistry,
  ProviderError,
  SessionsService,
  ToolsService,
  agentScope,
  attachApproval,
  bashTool,
  resolveLimits,
  type HarnessLimits,
  type LimitsReader,
  type LimitsSnapshot,
  type LlmProvider,
  type ToolDefinition,
  type ToolExecution,
} from 'dnt-harness'

/** A mutable stand-in for the host config service: stable reader, frozen revisions. */
function liveLimits(initial: Partial<HarnessLimits>): { reader: LimitsReader; publish(patch: Partial<HarnessLimits>): void } {
  const freeze = (revision: number, values: Partial<HarnessLimits>): LimitsSnapshot =>
    Object.freeze({ revision, values: Object.freeze({ ...resolveLimits(values) }) })
  let snapshot = freeze(0, initial)
  return {
    reader: { read: () => snapshot },
    publish(patch) { snapshot = freeze(snapshot.revision + 1, { ...snapshot.values, ...patch }) },
  }
}

const registries: ProcessRegistry[] = []
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.disposeAll())) })

describe('limits operation boundaries', () => {
  it('logical request retries keep one snapshot', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    const live = liveLimits({ stepRetries: 1, stepRetryBaseMs: 1 })
    kernel.ctx.provide('limits-reader', live.reader)
    let requests = 0
    const provider: LlmProvider = {
      name: 'flaky',
      async *stream() {
        requests += 1
        // Publish while request A waits out its transient-failure backoff.
        if (requests === 1) live.publish({ stepRetries: 10 })
        throw new ProviderError('flaky: stream ended without any model output', { transient: true })
      },
    }
    kernel.ctx.llm.register(provider)
    kernel.ctx.llm.use('flaky')
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    try {
      agent.send('a')
      await agent.run()
      // Request A: first attempt + its own single retry, despite the update.
      expect(requests).toBe(2)
      agent.send('b')
      await agent.run()
      // Request B follows the new policy, still under the four-attempt ceiling.
      expect(requests).toBe(6)
    } finally {
      await kernel.stop()
    }
  })

  it('tool output limit captures at body start', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    const live = liveLimits({ toolOutputLimit: 20 })
    kernel.ctx.provide('limits-reader', live.reader)
    const seen: { body: ToolExecution; post?: ToolExecution }[] = []
    let holdBody: (() => void) | undefined
    let bodyStarted!: () => void
    const started = new Promise<void>((resolve) => { bodyStarted = resolve })
    const probe: ToolDefinition = {
      name: 'Probe',
      description: 'records its execution envelope',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        seen.push({ body: exec })
        if (seen.length === 1) {
          await new Promise<void>((resolve) => { holdBody = resolve; bodyStarted() })
        }
        return 'x'.repeat(100).slice(0, exec.outputLimit)
      },
    }
    kernel.ctx.tools.register(probe)
    kernel.ctx.on('tools/post-execute', async (payload, next) => {
      const entry = seen.find((candidate) => candidate.body.executionId === payload.exec.executionId)
      if (entry !== undefined) entry.post = payload.exec
      return next()
    })
    let approve!: (allowed: boolean) => void
    let asked!: () => void
    const askedA = new Promise<void>((resolve) => { asked = resolve })
    let asks = 0
    attachApproval(kernel.ctx, {
      policy: { Probe: 'ask' },
      askUser: () => {
        asks += 1
        if (asks > 1) return Promise.resolve(true)
        asked()
        return new Promise<boolean>((resolve) => { approve = resolve })
      },
    })
    try {
      const resultA = kernel.ctx.tools.execute({ id: 'a', name: 'Probe', args: {} })
      await askedA
      live.publish({ toolOutputLimit: 40 })
      approve(true)
      await started
      live.publish({ toolOutputLimit: 60 })
      holdBody!()
      const a = await resultA
      expect(a).toEqual({ ok: true, output: 'x'.repeat(40) })
      expect(seen[0]!.body.outputLimit).toBe(40)
      expect(seen[0]!.body.limitsSnapshot).toMatchObject({ revision: 1, values: { toolOutputLimit: 40 } })
      expect(Object.isFrozen(seen[0]!.body.limitsSnapshot)).toBe(true)
      // Post-execute observes the same captured envelope, never a recapture.
      expect(seen[0]!.post).toBe(seen[0]!.body)

      const b = await kernel.ctx.tools.execute({ id: 'b', name: 'Probe', args: {} })
      expect(b).toEqual({ ok: true, output: 'x'.repeat(60) })
      expect(seen[1]!.body.outputLimit).toBe(60)
      expect(seen[1]!.body.limitsSnapshot?.revision).toBe(2)
    } finally {
      await kernel.stop()
    }
  })

  it('preparation does not pin a runtime limits snapshot', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    const live = liveLimits({ toolOutputLimit: 20 })
    kernel.ctx.provide('limits-reader', live.reader)
    let body: ToolExecution | undefined
    kernel.ctx.tools.register({
      name: 'Probe',
      description: 'records its execution envelope',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) { body = exec; return 'ok' },
    })
    let prepared: ToolExecution | undefined
    kernel.ctx.on('tools/pre-execute', async (payload, next) => { prepared = payload.exec; return next() })
    try {
      const call = await kernel.ctx.tools.prepare({ id: 'p', name: 'Probe', args: {} })
      expect(prepared?.limitsSnapshot).toBeUndefined()
      live.publish({ toolOutputLimit: 50 })
      await call.execute()
      expect(body?.outputLimit).toBe(50)
      expect(body?.limitsSnapshot?.revision).toBe(1)
    } finally {
      await kernel.stop()
    }
  })

  it('child background budget is pinned', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    const live = liveLimits({ toolTimeoutMs: 50, subagentBackgroundBashMaxMs: 111_000 })
    kernel.ctx.provide('limits-reader', live.reader)
    kernel.ctx.tools.setRootResolver(() => ({ root: process.cwd() }))
    const registry = new ProcessRegistry()
    registries.push(registry)
    const register = registry.tryRegister.bind(registry)
    // Publish once the child command is running, before it commits to background.
    vi.spyOn(registry, 'tryRegister').mockImplementation((input) => {
      const admitted = register(input)
      live.publish({ subagentBackgroundBashMaxMs: 222_000 })
      return admitted
    })
    const commit = vi.spyOn(registry, 'commitBackground')
    kernel.ctx.tools.register(bashTool({ processes: registry, limits: live.reader }))
    const scope = {
      sessionId: 'child',
      rootSessionId: 'root',
      childOf: { parentSessionId: 'root', parentTurnId: 'turn', definition: 'general', instructions: '', toolCeiling: ['Bash'] },
    } as unknown as Parameters<typeof agentScope.run>[0]
    try {
      const result = await agentScope.run(scope, () => kernel.ctx.tools.execute({ id: 'bg', name: 'Bash', args: { command: 'true; sleep 5' } }))
      expect(result.output).toMatch(/background process started/)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit.mock.calls[0]![2]).toEqual({ maxRuntimeMs: 111_000 })
    } finally {
      await kernel.stop()
    }
  })

  it('child background budget is read at body start, after an approval wait', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    const live = liveLimits({ toolTimeoutMs: 50, subagentBackgroundBashMaxMs: 111_000 })
    kernel.ctx.provide('limits-reader', live.reader)
    kernel.ctx.tools.setRootResolver(() => ({ root: process.cwd() }))
    const registry = new ProcessRegistry()
    registries.push(registry)
    const register = registry.tryRegister.bind(registry)
    vi.spyOn(registry, 'tryRegister').mockImplementation((input) => {
      const admitted = register(input)
      live.publish({ subagentBackgroundBashMaxMs: 333_000 })
      return admitted
    })
    const commit = vi.spyOn(registry, 'commitBackground')
    kernel.ctx.tools.register(bashTool({ processes: registry, limits: live.reader }))
    let approve!: (allowed: boolean) => void
    let asked!: () => void
    const askedOnce = new Promise<void>((resolve) => { asked = resolve })
    attachApproval(kernel.ctx, {
      policy: { Bash: 'ask' },
      askUser: () => { asked(); return new Promise<boolean>((resolve) => { approve = resolve }) },
    })
    const scope = {
      sessionId: 'child',
      rootSessionId: 'root',
      childOf: { parentSessionId: 'root', parentTurnId: 'turn', definition: 'general', instructions: '', toolCeiling: ['Bash'] },
    } as unknown as Parameters<typeof agentScope.run>[0]
    try {
      const running = agentScope.run(scope, () => kernel.ctx.tools.execute({ id: 'bg', name: 'Bash', args: { command: 'true; sleep 5' } }))
      await askedOnce
      live.publish({ subagentBackgroundBashMaxMs: 222_000 })
      approve(true)
      const result = await running
      expect(result.output).toMatch(/background process started/)
      expect(commit).toHaveBeenCalledTimes(1)
      expect(commit.mock.calls[0]![2]).toEqual({ maxRuntimeMs: 222_000 })
    } finally {
      await kernel.stop()
    }
  })

  it('a kernel without limits leaves each tool its own output default', async () => {
    const envelopes = async (legacy?: object): Promise<{ prepared?: ToolExecution; body?: ToolExecution }> => {
      const kernel = new Kernel()
      kernel.ctx.plugin(ToolsService)
      if (legacy !== undefined) kernel.ctx.provide('limits', legacy)
      const seen: { prepared?: ToolExecution; body?: ToolExecution } = {}
      kernel.ctx.tools.register({
        name: 'Probe',
        description: 'records its execution envelope',
        parameters: { type: 'object', properties: {}, required: [] },
        async execute(_args, exec) { seen.body = exec; return 'ok' },
      })
      kernel.ctx.on('tools/pre-execute', async (payload, next) => { seen.prepared = payload.exec; return next() })
      try {
        await kernel.ctx.tools.execute({ id: 'p', name: 'Probe', args: {} })
      } finally {
        await kernel.stop()
      }
      return seen
    }
    const bare = await envelopes()
    expect(bare.prepared?.outputLimit).toBeUndefined()
    expect(bare.body?.outputLimit).toBeUndefined()
    const unrelated = await envelopes({ streamIdleMs: 5_000 })
    expect(unrelated.prepared?.outputLimit).toBeUndefined()
    expect(unrelated.body?.outputLimit).toBeUndefined()
    const configured = await envelopes({ toolOutputLimit: 25 })
    expect(configured.prepared?.outputLimit).toBe(25)
    expect(configured.body?.outputLimit).toBe(25)
  })

  it('an unreadable limits source fails the call without throwing from prepare', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.provide('limits-reader', {})
    let ran = false
    kernel.ctx.tools.register({
      name: 'Probe',
      description: 'must not run',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() { ran = true; return 'ran' },
    })
    try {
      const prepared = await kernel.ctx.tools.prepare({ id: 'p', name: 'Probe', args: {} })
      const result = await prepared.execute()
      expect(result.ok).toBe(false)
      expect(result.output).toMatch(/^error: .*limits-reader/)
      expect(ran).toBe(false)
    } finally {
      await kernel.stop()
    }
  })
})
