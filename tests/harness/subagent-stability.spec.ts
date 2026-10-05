/**
 * What keeps a long delegated run alive: a request the provider rejected as
 * too large is asked again smaller, a stalled stream retries instead of
 * killing the run, a child that did not finish still reports what it did, and
 * a root that stops calling tools joins the children it left running instead
 * of cancelling them.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
afterEach(() => vi.useRealTimers())
import {
  AgentsService,
  ChildExecutor,
  Kernel,
  LlmService,
  ProviderError,
  SessionsService,
  ToolsService,
  WorkspaceService,
  bundledDefinition,
  fileSessions,
  type ChildHandle,
  type LlmProvider,
  type ModelRequest,
  type SpawnRequest,
  type StreamEvent,
} from 'dnt-harness'
import { MAX_SQUEEZE_LEVEL, squeezeBudget, DEFAULT_BUDGET } from '../../src/harness/context/budget.ts'
import { isContextExceeded } from '../../src/harness/llm/openai.ts'
import { agentScope } from '../../src/harness/agent/scope.ts'
import { agentTool, formatChildReports, type DelegationDeps } from '../../src/web/agent-delegation.ts'
import { AgentDefinitionService } from 'dnt-harness'
import { FakeScriptedLlm, type ScriptStep } from '../support/fake-llm.ts'

describe('context-exceeded recovery', () => {
  it('classifies the usual provider wordings as "does not fit", and only on request errors', () => {
    for (const detail of [
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.",
      'context_length_exceeded',
      'Prompt is too long: 210000 tokens > 200000 maximum',
      'Input is too long for the model',
      'Request exceeds the model limit',
    ]) expect(isContextExceeded(400, detail), detail).toBe(true)
    expect(isContextExceeded(413, 'payload too large')).toBe(true)
    expect(isContextExceeded(401, 'context_length_exceeded')).toBe(false)
    expect(isContextExceeded(400, 'invalid api key')).toBe(false)
    expect(isContextExceeded(500, 'prompt is too long')).toBe(false)
  })

  it('every squeeze level shrinks the budget, and the last level is final', () => {
    const sizes = Array.from({ length: MAX_SQUEEZE_LEVEL + 1 }, (_unused, level) => squeezeBudget(DEFAULT_BUDGET, level).contextLimitTokens)
    expect(sizes[0]).toBe(DEFAULT_BUDGET.contextLimitTokens)
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeLessThan(sizes[i - 1]!)
    expect(squeezeBudget(DEFAULT_BUDGET, 99).contextLimitTokens).toBe(sizes.at(-1))
    expect(squeezeBudget(DEFAULT_BUDGET, undefined)).toBe(DEFAULT_BUDGET)
  })

  /** A provider that rejects requests until they are small enough, then answers. */
  function pickyProvider(fits: (request: ModelRequest) => boolean, seen: ModelRequest[]): LlmProvider {
    return {
      name: 'picky',
      async *stream(request): AsyncIterable<StreamEvent> {
        seen.push(request)
        if (!fits(request)) throw new ProviderError('picky: HTTP 400: context_length_exceeded', { contextExceeded: true })
        yield { type: 'delta', delta: 'fits now' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    }
  }

  function boot(provider: LlmProvider) {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.llm.register(provider)
    kernel.ctx.llm.use(provider.name)
    const session = kernel.ctx.sessions.create()
    return { kernel, session, agent: kernel.ctx.agents.create(session) }
  }

  it('a request rejected as too large is re-assembled with a squeeze hint and the turn completes', async () => {
    const seen: ModelRequest[] = []
    const { kernel, session, agent } = boot(pickyProvider((request) => (request.squeeze ?? 0) >= 2, seen))
    // The host's context builder reads `squeeze`; here a listener plays its part.
    kernel.ctx.on('agent/context', async (projected, next) => next({ ...projected, messages: projected.messages.slice(0, 1) }), true)

    agent.send('hello')
    await agent.run()

    expect(seen.map((request) => request.squeeze ?? 0)).toEqual([0, 1, 2])
    expect(session.events.some((event) => event.type === 'turn/error')).toBe(false)
    expect(session.events.filter((event) => event.type === 'assistant/message')).toHaveLength(1)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('completed')
    void kernel.stop()
  })

  it('a request that never fits fails as a provider error once the squeeze levels are spent', async () => {
    const seen: ModelRequest[] = []
    const { kernel, session, agent } = boot(pickyProvider(() => false, seen))

    agent.send('hello')
    await agent.run()

    expect(seen).toHaveLength(MAX_SQUEEZE_LEVEL + 1)
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({ kind: 'provider' })
    void kernel.stop()
  })
})

describe('stalled stream', () => {
  it('an abort-ignoring stalled attempt retains ownership and is not retried', async () => {
    vi.useFakeTimers()
    let requests = 0
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { streamFirstEventMs: 40, stepRetryBaseMs: 1 })
    kernel.ctx.llm.register({
      name: 'sometimes-silent',
      async *stream(): AsyncIterable<StreamEvent> {
        requests += 1
        if (requests === 1) await new Promise(() => {})
        yield { type: 'delta', delta: 'second try works' }
        yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)

    agent.send('hello')
    const running = agent.run()
    await vi.advanceTimersByTimeAsync(10_100)
    await running

    expect(requests).toBe(1)
    expect(kernel.ctx.llm.admission('sometimes-silent').active).toBe(1)
    expect(kernel.ctx.llm.admission('sometimes-silent').uncertain.size).toBe(1)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('failed')
    void kernel.stop()
  }, 5_000)

  it('a user stop during a stalled attempt is a stop, never retried', async () => {
    let requests = 0
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { streamFirstEventMs: 60_000 })
    kernel.ctx.llm.register({
      name: 'silent',
      async *stream(): AsyncIterable<StreamEvent> {
        requests += 1
        await new Promise(() => {})
        yield { type: 'delta', delta: 'never' }
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)

    agent.send('hello')
    const running = agent.run()
    await new Promise((resolve) => setTimeout(resolve, 30))
    agent.stop()
    await running

    expect(requests).toBe(1)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('cancelled')
    void kernel.stop()
  }, 5_000)
})

describe('turn continuation', () => {
  function boot(replies: readonly ScriptStep[]) {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    const seen: ModelRequest[] = []
    const script = new FakeScriptedLlm(replies)
    kernel.ctx.llm.register({
      name: 'scripted',
      models: ['scripted'],
      stream: (request, options) => {
        seen.push(request)
        return script.stream(request, options)
      },
    })
    const session = kernel.ctx.sessions.create()
    return { kernel, session, agent: kernel.ctx.agents.create(session), seen }
  }

  it('a listener that owes the model a report gives it one more step before the turn closes', async () => {
    const { kernel, session, agent, seen } = boot(['first answer', 'answer using the report'])
    let asked = 0
    kernel.ctx.on('agent/turn-continuation', async () => {
      asked += 1
      return asked === 1 ? 'Delegated agents finished: the config is in vite.config.ts' : undefined
    })

    agent.send('hello')
    await agent.run()

    expect(asked).toBe(2) // asked again after the extra step — nothing is owed then
    expect(seen).toHaveLength(2)
    const second = JSON.stringify(seen[1]?.messages)
    expect(second).toContain('the config is in vite.config.ts')
    // One turn, two steps; the report is a logged user message of that turn.
    expect(session.events.filter((event) => event.type === 'turn/start')).toHaveLength(1)
    expect(session.events.filter((event) => event.type === 'step/start')).toHaveLength(2)
    expect(session.events.filter((event) => event.type === 'user/message')).toHaveLength(2)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('completed')
    void kernel.stop()
  })

  it('a failing continuation listener cannot fail the turn', async () => {
    const { kernel, session, agent } = boot(['done'])
    kernel.ctx.on('agent/turn-continuation', async () => { throw new Error('join exploded') })

    agent.send('hello')
    await agent.run()

    expect(session.events.some((event) => event.type === 'turn/error')).toBe(false)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('completed')
    void kernel.stop()
  })

  it('a stop while the listener waits closes the turn as cancelled and spends no extra step', async () => {
    const { kernel, session, agent, seen } = boot(['done'])
    kernel.ctx.on('agent/turn-continuation', async (state) => {
      await new Promise<void>((resolve) => state.signal?.addEventListener('abort', () => resolve(), { once: true }))
      return 'a report that must be ignored after a stop'
    })

    agent.send('hello')
    const running = agent.run()
    await new Promise((resolve) => setTimeout(resolve, 30))
    agent.stop()
    await running

    expect(seen).toHaveLength(1)
    const end = session.events.findLast((event) => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('cancelled')
    void kernel.stop()
  })
})

// ── the executor: partial results and the turn join ───────────────────────

let home = ''
const kernels: Kernel[] = []
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-stability-'))
})
afterAll(async () => {
  // Children flush their logs asynchronously; stop every kernel and retry the
  // removal instead of racing a writer that is still finishing.
  await Promise.all(kernels.map((kernel) => kernel.stop().catch(() => {})))
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface ExecutorHarness {
  readonly kernel: Kernel
  readonly executor: ChildExecutor
  readonly workspaceId: never
  readonly rootSessionId: never
}

async function bootExecutor(script: readonly ScriptStep[], options: { readonly slowMs?: number } = {}): Promise<ExecutorHarness> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const ws = new WorkspaceService(home)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm(script))
  for (const name of ['Read', 'Glob', 'Grep', 'Write', 'Edit']) {
    kernel.ctx.tools.register({
      name,
      description: `fake ${name}`,
      requiresRoot: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        if (options.slowMs !== undefined) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, options.slowMs)
            exec.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
          })
        }
        return `${name} ok`
      },
    })
  }
  const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
  kernels.push(kernel)
  return {
    kernel,
    executor: new ChildExecutor(kernel.ctx),
    workspaceId: ws.defaultWorkspace as never,
    rootSessionId: root.id as never,
  }
}

function spawnRequest(harness: ExecutorHarness, turn = 'turn-1'): SpawnRequest {
  return {
    workspaceId: harness.workspaceId,
    parentSessionId: harness.rootSessionId,
    parentTurnId: turn,
    definition: bundledDefinition('worker'),
    exposureCeiling: bundledDefinition('worker').tools,
    packet: { prompt: 'Do the work.', requiredResult: 'a short answer' },
  }
}

const read = (path: string): ScriptStep => ({ content: 'Reading it.', toolCalls: [{ name: 'Read', args: { path } }] })

describe('partial results', () => {
  it('a cancelled child hands back what it got done, flagged as not a result', async () => {
    const harness = await bootExecutor([read('a.ts'), { content: 'Now editing.', toolCalls: [{ name: 'Edit', args: { path: 'b.ts' } }] }, read('c.ts')], { slowMs: 150 })
    const handle = await harness.executor.spawn(spawnRequest(harness))
    await new Promise((resolve) => setTimeout(resolve, 250))
    const cancelled = await harness.executor.cancel(harness.workspaceId, handle.childSessionId)

    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.result).toBeUndefined()
    expect(cancelled?.partial?.filesTouched).toEqual(expect.arrayContaining(['a.ts']))
    expect(cancelled?.partial?.report).not.toBe('')
    expect(cancelled?.error).toMatch(/did not complete/)
  })

  it('a completed child has a result and no partial', async () => {
    const harness = await bootExecutor(['All done.'])
    const handle = await harness.executor.spawn(spawnRequest(harness))
    const [settled] = await harness.executor.wait(harness.workspaceId, [handle.childSessionId], { timeoutMs: 5_000 })
    expect(settled?.status).toBe('completed')
    expect(settled?.result?.report).toBe('All done.')
    expect(settled?.partial).toBeUndefined()
  })
})

describe('joining the children of a turn', () => {
  it('waits for unreported children and returns their final handles', async () => {
    const harness = await bootExecutor([read('a.ts'), 'Finished the task.'], { slowMs: 60 })
    const handle = await harness.executor.spawn(spawnRequest(harness))
    const joined = await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-1', { timeoutMs: 10_000 })

    expect(joined.map((child) => child.childSessionId)).toEqual([handle.childSessionId])
    expect(joined[0]?.status).toBe('completed')
    expect(joined[0]?.result?.report).toBe('Finished the task.')
    // It was reported: a second join of the same turn owes nothing.
    expect(await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-1', { timeoutMs: 10 })).toEqual([])
  })

  it('a child the model already waited on is not delivered a second time', async () => {
    const harness = await bootExecutor(['Done quickly.'])
    const handle = await harness.executor.spawn(spawnRequest(harness))
    const [settled] = await harness.executor.wait(harness.workspaceId, [handle.childSessionId], { timeoutMs: 5_000 })
    harness.executor.markReported([settled!.childSessionId])

    expect(await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-1', { timeoutMs: 10 })).toEqual([])
  })

  it('only the named turn is joined', async () => {
    const harness = await bootExecutor(['Done.'])
    await harness.executor.spawn(spawnRequest(harness, 'turn-1'))
    expect(await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-2', { timeoutMs: 10 })).toEqual([])
  })

  it('past the deadline a still-running child is cancelled and reports its partial work', async () => {
    const harness = await bootExecutor([read('a.ts'), read('b.ts'), read('c.ts'), read('d.ts'), 'never reached'], { slowMs: 400 })
    const handle = await harness.executor.spawn(spawnRequest(harness))
    const joined = await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-1', { timeoutMs: 700 })

    expect(joined).toHaveLength(1)
    expect(joined[0]?.childSessionId).toBe(handle.childSessionId)
    expect(joined[0]?.status).toBe('cancelled')
    expect(joined[0]?.partial?.filesTouched.length).toBeGreaterThan(0)
  })

  it('a user stop ends the join at once and leaves cleanup to Stop', async () => {
    const harness = await bootExecutor([read('a.ts'), read('b.ts'), 'done'], { slowMs: 2_000 })
    const handle = await harness.executor.spawn(spawnRequest(harness))
    const controller = new AbortController()
    const started = Date.now()
    const joining = harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-1', { timeoutMs: 60_000, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const joined = await joining

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(joined).toEqual([])
    // Not cancelled by the join: it is still running until Stop's own cleanup.
    expect(harness.executor.runningChildrenOfRoot(harness.rootSessionId)).toContain(handle.childSessionId)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId)
  })
})

describe('child reports handed back to the model', () => {
  const base = { definitionName: 'worker', childSessionId: 'child-1' as never, startedAt: 0 }

  it('renders a completed child as its report and the files it touched', () => {
    const text = formatChildReports([{ ...base, status: 'completed', result: { report: 'The bug is in a.ts.', filesTouched: ['a.ts'] } } as ChildHandle])
    expect(text).toContain('worker (child-1) — completed')
    expect(text).toContain('The bug is in a.ts.')
    expect(text).toContain('Files touched: a.ts')
  })

  it('renders a child that did not finish with its error and a verify-first warning on partial work', () => {
    const text = formatChildReports([{
      ...base,
      status: 'cancelled',
      error: 'the child did not complete (cancelled); its full log is session child-1',
      partial: { report: 'Half way through the migration.', filesTouched: ['db.ts'] },
    } as ChildHandle])
    expect(text).toContain('cancelled')
    expect(text).toContain('did not complete')
    expect(text).toContain('Half way through the migration.')
    expect(text).toMatch(/unverified/)
  })

  it('renders every child in order', () => {
    const text = formatChildReports([
      { ...base, childSessionId: 'c1' as never, status: 'completed', result: { report: 'first', filesTouched: [] } } as ChildHandle,
      { ...base, childSessionId: 'c2' as never, status: 'failed', error: 'boom' } as ChildHandle,
    ])
    expect(text.indexOf('c1')).toBeLessThan(text.indexOf('c2'))
    expect(text).toContain('boom')
  })
})

describe('the Agent tool wait', () => {
  const done = { childSessionId: 'child-1', status: 'completed', definitionName: 'worker', startedAt: 0, result: { report: 'finished before the wait', filesTouched: [] } }

  function toolWith(executor: Record<string, unknown>) {
    const deps: DelegationDeps = {
      definitions: new AgentDefinitionService(home),
      executor: { activeOfRoot: () => 0, childrenOfRoot: async () => [], cancel: async () => undefined, reconcile: async () => undefined, spawn: async () => done, ...executor } as never,
      session: async () => ({ events: [] }) as never,
      childModelFor: () => undefined,
      providers: () => [],
      modelsOf: () => [],
      admissionResolver: async ({ candidates }) => candidates,
    }
    return agentTool(deps)
  }
  const inTurn = <T>(fn: () => T): T => agentScope.run({ sessionId: 'root' as never, rootSessionId: 'root' as never, turnId: 'turn-1' as never, workspaceId: 'ws' as never }, fn)

  it('without ids it also returns a child that finished before the wait, and marks it reported', async () => {
    const waited: unknown[][] = []
    const reported: unknown[] = []
    const tool = toolWith({
      runningChildrenOfRoot: () => [],
      owedChildrenOfTurn: () => ['child-1'],
      wait: async (_ws: string, ids: unknown[]) => { waited.push(ids); return [done] },
      markReported: (ids: unknown[]) => { reported.push(...ids) },
    })
    const raw = await inTurn(() => tool.execute({ action: 'wait' }, {} as never))

    expect(waited).toEqual([['child-1']])
    expect(JSON.parse(String(raw)).children[0].result.report).toBe('finished before the wait')
    // Handed to the model by the wait itself — closing the turn must not repeat it.
    expect(reported).toEqual(['child-1'])
  })

  it('does not mark a child that is still running as reported', async () => {
    const reported: unknown[] = []
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async () => [{ ...done, status: 'running', result: undefined }],
      markReported: (ids: unknown[]) => { reported.push(...ids) },
    })
    await inTurn(() => tool.execute({ action: 'wait', timeoutMs: 10 }, {} as never))
    expect(reported).toEqual([])
  })

  it('passes a user stop to the executor wait so it returns at once', async () => {
    let seen: AbortSignal | undefined
    const tool = toolWith({
      runningChildrenOfRoot: () => ['child-1'],
      wait: async (_ws: string, _ids: unknown[], options: { signal?: AbortSignal }) => { seen = options.signal; return [] },
    })
    const controller = new AbortController()
    await inTurn(() => tool.execute({ action: 'wait' }, { signal: controller.signal } as never))
    expect(seen).toBe(controller.signal)
  })
})
