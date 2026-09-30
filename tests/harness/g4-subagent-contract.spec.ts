/**
 * The subagent contract on top of the G4 executor: lifecycle ownership and
 * compensation, the result contract (last tool-free message or an honest
 * error), the prose brief, inherited parent context, per-conversation
 * capacity, and the Agent tool's role catalog and guidance.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentDefinitionService,
  AgentsService,
  ChildExecutor,
  Kernel,
  LlmService,
  MAX_REPORT_CHARS,
  ToolsService,
  WorkspaceService,
  bundledDefinition,
  fileSessions,
  normalizeBrief,
  type AgentDefinition,
  type SpawnRequest,
} from 'mini-dsh'
import { agentScope } from '../../src/harness/agent/scope.ts'
import { agentTool, projectInheritedMessages, type DelegationDeps } from '../../src/web/agent-delegation.ts'
import { FakeScriptedLlm, type ScriptStep } from '../support/fake-llm.ts'

let home = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-contract-'))
})

afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

interface Harness {
  readonly kernel: Kernel
  readonly executor: ChildExecutor
  readonly workspaceId: string
  readonly rootSessionId: string
}

/** Fake file tools: Read blocks until aborted when `blocking`, others echo. */
function registerFakeTools(kernel: Kernel, blocking = false): void {
  for (const name of ['Read', 'Glob', 'Grep', 'Write', 'Edit']) {
    kernel.ctx.tools.register({
      name,
      description: `fake ${name}`,
      requiresRoot: false,
      parameters: { type: 'object', properties: {}, required: [] },
      async execute(_args, exec) {
        if (blocking && name === 'Read') {
          await new Promise<void>((resolve) => {
            if (exec.signal?.aborted === true) resolve()
            else exec.signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        return `${name} ok`
      },
    })
  }
}

async function boot(script: readonly ScriptStep[], options: { readonly blocking?: boolean; readonly dir?: string } = {}): Promise<Harness> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(options.dir ?? home))
  const ws = new WorkspaceService(options.dir ?? home)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm(script))
  registerFakeTools(kernel, options.blocking === true)
  const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
  return {
    kernel,
    executor: new ChildExecutor(kernel.ctx),
    workspaceId: ws.defaultWorkspace as unknown as string,
    rootSessionId: root.id as unknown as string,
  }
}

function request(harness: Harness, definition: AgentDefinition, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    workspaceId: harness.workspaceId as never,
    parentSessionId: harness.rootSessionId as never,
    parentTurnId: 'turn-1',
    definition,
    packet: { prompt: 'Inspect the repository.', requiredResult: 'a short answer' },
    ...overrides,
  }
}

async function settle(harness: Harness, childSessionId: string) {
  const [handle] = await harness.executor.wait(harness.workspaceId as never, [childSessionId as never], { timeoutMs: 5_000 })
  return handle
}

function childEvents(harness: Harness, childSessionId: string) {
  return harness.kernel.ctx.sessions.get(childSessionId as never).events
}

const explorer = bundledDefinition('explorer')
const worker = bundledDefinition('worker')

describe('result contract', () => {
  it('reports the last tool-free message, never narration that accompanied tool calls', async () => {
    const harness = await boot([
      { content: 'checking A', toolCalls: [{ name: 'Read', args: { path: 'a.ts' } }] },
      { content: 'checking B', toolCalls: [{ name: 'Glob', args: { pattern: '**/*.ts' } }, { name: 'Grep', args: { pattern: 'x', path: 'src' } }] },
      'Answer: X',
    ])
    const handle = await harness.executor.spawn(request(harness, explorer))
    const settled = await settle(harness, handle.childSessionId)
    expect(settled?.status).toBe('completed')
    expect(settled?.result?.report).toBe('Answer: X')
    // Files, not scopes: Glob has no path and Grep's path is a directory.
    expect(settled?.result?.filesTouched).toEqual(['a.ts'])
    expect(settled?.result?.truncated).toBeUndefined()
    await harness.kernel.stop()
  }, 15_000)

  it('lists every file a worker wrote', async () => {
    const harness = await boot([
      { toolCalls: [{ name: 'Write', args: { path: 'one.ts', content: 'x' } }, { name: 'Edit', args: { path: 'two.ts', old: 'a', new: 'b' } }] },
      'Wrote one.ts and two.ts.',
    ])
    const handle = await harness.executor.spawn(request(harness, worker))
    const settled = await settle(harness, handle.childSessionId)
    expect(settled?.result?.filesTouched).toEqual(['one.ts', 'two.ts'])
    await harness.kernel.stop()
  }, 15_000)

  it('truncates the FINAL message with an explicit marker and flag', async () => {
    // Few, long tokens keep the scripted stream fast.
    const long = `Answer: ${Array.from({ length: 50 }, () => 'y'.repeat(999)).join(' ')}`
    const harness = await boot([{ content: 'x'.repeat(5_000), toolCalls: [{ name: 'Read', args: { path: 'a.ts' } }] }, long])
    const handle = await harness.executor.spawn(request(harness, explorer))
    const settled = await settle(harness, handle.childSessionId)
    const report = settled?.result?.report ?? ''
    expect(settled?.result?.truncated).toBe(true)
    expect(report.startsWith('Answer: yyy')).toBe(true)
    expect(report).toContain(`[truncated ${long.length - MAX_REPORT_CHARS} chars]`)
    expect(report.length).toBeLessThan(MAX_REPORT_CHARS + 64)
    await harness.kernel.stop()
  }, 20_000)

  it('a completed child without a final report says so, stably, and names its log', async () => {
    const harness = await boot([{ content: '', toolCalls: [{ name: 'Read', args: { path: 'a.ts' } }] }, ''])
    const handle = await harness.executor.spawn(request(harness, explorer))
    const settled = await settle(harness, handle.childSessionId)
    expect(settled?.status).toBe('completed')
    expect(settled?.result).toBeUndefined()
    expect(settled?.error).toBe(`the child produced no final report; its full log is session ${handle.childSessionId}`)
    const first = await harness.executor.childrenOfRoot(harness.rootSessionId as never)
    const second = await harness.executor.childrenOfRoot(harness.rootSessionId as never)
    expect(second).toEqual(first)
    await harness.kernel.stop()
  }, 15_000)

  it('a cancelled child has no result and an error naming its session', async () => {
    const harness = await boot([{ content: 'looking', toolCalls: [{ name: 'Read', args: { path: 'a.ts' } }] }], { blocking: true })
    const handle = await harness.executor.spawn(request(harness, explorer))
    const cancelled = await harness.executor.cancel(harness.workspaceId as never, handle.childSessionId)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.result).toBeUndefined()
    expect(cancelled?.error).toContain('did not complete (cancelled)')
    expect(cancelled?.error).toContain(`session ${handle.childSessionId}`)
    await harness.kernel.stop()
  }, 15_000)

  it('treats a resolving run with a failed terminal turn as failed, never as a result', async () => {
    const harness = await boot(['unused'])
    const agents = harness.kernel.ctx.get('agents') as { create: (session: { append(event: unknown): unknown }) => unknown }
    const original = agents.create
    agents.create = (session) => ({
      send: () => {},
      stop: () => {},
      async run() {
        session.append({ type: 'turn/start', turnId: 'failed-turn' })
        session.append({ type: 'assistant/message', stepId: 'failed-step', content: 'do not return this', toolCalls: [] })
        session.append({ type: 'turn/end', turnId: 'failed-turn', reason: 'failed' })
      },
    })
    const handle = await harness.executor.spawn(request(harness, explorer))
    agents.create = original
    const settled = await settle(harness, handle.childSessionId)
    expect(settled).toMatchObject({ status: 'failed' })
    expect(settled?.result).toBeUndefined()
    expect(settled?.error).toContain('terminal turn ended failed')
    await harness.kernel.stop()
  }, 15_000)

  it('a settled child stays queryable after its in-memory entry is evicted, and across a restart', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-evict-'))
    try {
      const harness = await boot(['the answer'], { dir })
      const handle = await harness.executor.spawn(request(harness, explorer))
      await settle(harness, handle.childSessionId)
      const listed = await harness.executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never)
      expect(listed.map((child) => [child.status, child.result?.report])).toEqual([['completed', 'the answer']])
      expect(await harness.executor.cancel(harness.workspaceId as never, handle.childSessionId)).toMatchObject({ status: 'completed' })
      await harness.kernel.stop()

      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(dir))
      await kernel.ctx.sessions.boot()
      const executor = new ChildExecutor(kernel.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      const recovered = await executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never)
      expect(recovered.map((child) => [child.status, child.result?.report])).toEqual([['completed', 'the answer']])
      await kernel.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('lifecycle boundary', () => {
  it('rejects a foreign workspace or project before any child state exists', async () => {
    const harness = await boot(['done'])
    const before = harness.kernel.ctx.sessions.summaries().length
    await expect(harness.executor.spawn(request(harness, explorer, { workspaceId: 'ws-foreign' as never }))).rejects.toMatchObject({ code: 'ownership' })
    await expect(harness.executor.spawn(request(harness, explorer, { projectId: 'proj-foreign' as never }))).rejects.toMatchObject({ code: 'ownership' })
    await expect(harness.executor.spawn(request(harness, explorer, { parentSessionId: 'no-such-root' as never }))).rejects.toMatchObject({ code: 'ownership' })
    expect(harness.kernel.ctx.sessions.summaries().length).toBe(before)
    await harness.kernel.stop()
  }, 15_000)

  it('retains a child when canonical storage proves a rejected parent durable wrapper committed its spawn', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    root.durable = async () => { throw new Error('disk full') }
    const handle = await harness.executor.spawn(request(harness, explorer))
    expect(handle.status).toBe('running')
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 20_000)

  it('removes a never-launched uncertain spawn after a transient canonical read failure then canonical absence', async () => {
    const harness = await boot(['done'])
    const sessions = harness.kernel.ctx.sessions as unknown as {
      storeFor(workspaceId: string): { append(id: string, event: { type: string }): Promise<void> }
      readCanonicalEvents(id: string): Promise<readonly unknown[] | undefined>
      has(id: string): boolean
    }
    const store = sessions.storeFor(harness.workspaceId)
    const append = store.append.bind(store)
    store.append = async (id, event) => {
      if (id === harness.rootSessionId && event.type === 'agent/child-spawn') {
        throw new Error('spawn write acknowledgement lost before persistence')
      }
      await append(id, event)
    }
    const readCanonicalEvents = sessions.readCanonicalEvents.bind(sessions)
    sessions.readCanonicalEvents = async () => { throw new Error('canonical storage temporarily unavailable') }

    const handle = await harness.executor.spawn(request(harness, explorer))
    expect(handle.status).toBe('uncertain')
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)

    sessions.readCanonicalEvents = readCanonicalEvents
    expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId)).toBeUndefined()
    expect(sessions.has(handle.childSessionId)).toBe(false)
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    expect(await harness.executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never)).toEqual([])
    // A second operator retry cannot release the already removed reservation.
    expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId)).toBeUndefined()
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    await harness.kernel.stop()
  }, 15_000)

  it('canonically accepts a committed spawn when a non-poisoned durable wrapper rejects after success', async () => {
    const harness = await boot(['done'])
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    const durable = root.durable.bind(root)
    root.durable = async () => {
      await durable()
      throw new Error('post-success wrapper rejection')
    }

    const handle = await harness.executor.spawn(request(harness, explorer))
    expect(handle.status).toBe('running')
    expect(await settle(harness, handle.childSessionId)).toMatchObject({ status: 'completed', result: { report: 'done' } })
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    await harness.kernel.stop()
  }, 15_000)

  it('a launch failure after the relationship is durable settles a queryable failed child', async () => {
    const harness = await boot(['done'])
    const agents = harness.kernel.ctx.get('agents') as { create: (...args: unknown[]) => unknown }
    const original = agents.create
    agents.create = () => { throw new Error('agent factory exploded') }
    const handle = await harness.executor.spawn(request(harness, explorer))
    agents.create = original
    expect(handle.status).toBe('failed')
    expect(handle.error).toContain('launch failed: agent factory exploded')
    expect(handle.error).toContain(`session ${handle.childSessionId}`)
    const listed = await harness.executor.childrenOfRoot(harness.rootSessionId as never)
    expect(listed.find((child) => child.childSessionId === handle.childSessionId)).toMatchObject({ status: 'failed' })
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    await harness.kernel.stop()
  }, 15_000)

  it('reconciles a poisoned parent against canonical storage when the persisted spawn append rejects, including after restart', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-spawn-append-reject-'))
    try {
      const harness = await boot(['done'], { dir })
      const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never)
      const store = harness.kernel.ctx.sessions.storeFor(harness.workspaceId as never) as {
        append(id: string, event: { type: string }): Promise<void>
      }
      const append = store.append.bind(store)
      let rejectAfterPersist = true
      store.append = async (id, event) => {
        await append(id, event)
        if (id === harness.rootSessionId && event.type === 'agent/child-spawn' && rejectAfterPersist) {
          rejectAfterPersist = false
          throw new Error('spawn append acknowledgement lost')
        }
      }

      const handle = await harness.executor.spawn(request(harness, explorer))
      expect(root.poisoned).toBe(true)
      expect(handle.status).toBe('running')
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)
      expect(await harness.executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never))
        .toMatchObject([{ childSessionId: handle.childSessionId, status: 'running' }])
      // The child log can complete, but a poisoned parent without a durable
      // result must remain uncertain rather than inventing a failed outcome.
      expect(await settle(harness, handle.childSessionId)).toMatchObject({ status: 'uncertain' })
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)
      await harness.kernel.stop()

      const restarted = new Kernel()
      restarted.ctx.plugin(fileSessions(dir))
      await restarted.ctx.sessions.boot()
      const executor = new ChildExecutor(restarted.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      // A child terminal turn is not a durable parent result. Restart must
      // preserve uncertainty rather than manufacture a completed deliverable.
      expect(await executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never))
        .toMatchObject([{ childSessionId: handle.childSessionId, status: 'uncertain' }])
      // Retry is a canonical settlement: concurrent callers repair exactly one
      // parent terminal record and every caller observes that result.
      const settled = await Promise.all([
        executor.reconcile(harness.workspaceId as never, handle.childSessionId),
        executor.reconcile(harness.workspaceId as never, handle.childSessionId),
      ])
      expect(settled).toEqual([
        expect.objectContaining({ status: 'completed', result: { report: 'done', filesTouched: [] } }),
        expect.objectContaining({ status: 'completed', result: { report: 'done', filesTouched: [] } }),
      ])
      const parentEvents = restarted.ctx.sessions.get(harness.rootSessionId as never).events
      expect(parentEvents.filter((event) => event.type === 'agent/child-result' && event.childSessionId === handle.childSessionId)).toHaveLength(1)
      await restarted.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('releases capacity when a poisoned parent has canonically persisted the result append, including after restart', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-result-append-reject-'))
    try {
      const harness = await boot(['done'], { dir })
      const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never)
      const handle = await harness.executor.spawn(request(harness, explorer))
      const store = harness.kernel.ctx.sessions.storeFor(harness.workspaceId as never) as {
        append(id: string, event: { type: string }): Promise<void>
      }
      const append = store.append.bind(store)
      let rejectAfterPersist = true
      store.append = async (id, event) => {
        await append(id, event)
        if (id === harness.rootSessionId && event.type === 'agent/child-result' && rejectAfterPersist) {
          rejectAfterPersist = false
          throw new Error('result append acknowledgement lost')
        }
      }

      expect(await settle(harness, handle.childSessionId)).toMatchObject({ status: 'completed', result: { report: 'done' } })
      expect(root.poisoned).toBe(true)
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
      await harness.kernel.stop()

      const restarted = new Kernel()
      restarted.ctx.plugin(fileSessions(dir))
      await restarted.ctx.sessions.boot()
      const executor = new ChildExecutor(restarted.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      expect(await executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never))
        .toMatchObject([{ childSessionId: handle.childSessionId, status: 'completed', result: { report: 'done' } }])
      await restarted.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('reconciles a poisoned parent result in-process and releases capacity only after the canonical result is proven', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-result-reconcile-'))
    try {
      const harness = await boot(['done'], { dir })
      const handle = await harness.executor.spawn(request(harness, explorer))
      const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
      const originalDurable = root.durable.bind(root)
      root.durable = async () => { throw new Error('parent is poisoned') }
      const sessions = harness.kernel.ctx.sessions as unknown as {
        readCanonicalEvents(id: string): Promise<readonly unknown[] | undefined>
      }
      const readCanonicalEvents = sessions.readCanonicalEvents.bind(sessions)
      sessions.readCanonicalEvents = async () => { throw new Error('canonical read unavailable') }

      const settled = await settle(harness, handle.childSessionId)
      expect(settled?.status).toBe('uncertain')
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)

      sessions.readCanonicalEvents = readCanonicalEvents
      root.durable = originalDurable

      expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId)).toMatchObject({ status: 'completed', result: { report: 'done' } })
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
      await harness.kernel.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('does not share an owning reconciliation promise with a foreign workspace caller', async () => {
    const harness = await boot(['done'])
    const handle = await harness.executor.spawn(request(harness, explorer))
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    const durable = root.durable.bind(root)
    root.durable = async () => { throw new Error('parent is poisoned') }
    const sessions = harness.kernel.ctx.sessions as unknown as {
      readCanonicalEvents(id: string): Promise<readonly unknown[] | undefined>
    }
    const canonical = sessions.readCanonicalEvents.bind(sessions)
    sessions.readCanonicalEvents = async () => { throw new Error('canonical read unavailable') }
    expect(await settle(harness, handle.childSessionId)).toMatchObject({ status: 'uncertain' })

    root.durable = durable
    let releaseRead: () => void = () => {}
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve })
    let readStarted: () => void = () => {}
    const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve })
    sessions.readCanonicalEvents = async (id) => {
      if (id === harness.rootSessionId) {
        readStarted()
        await readReleased
      }
      return canonical(id)
    }
    const owning = harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId)
    await readStartedPromise

    // Authorization must occur before joining the per-child single-flight task.
    await expect(harness.executor.reconcile('ws-foreign' as never, handle.childSessionId)).resolves.toBeUndefined()
    releaseRead()
    expect(await owning).toMatchObject({ status: 'completed', result: { report: 'done' } })
    await harness.kernel.stop()
  }, 15_000)

  it('does not reconcile a retained child while its runner is finishing', async () => {
    const harness = await boot(['unused'])
    const agents = harness.kernel.ctx.get('agents') as { create: (session: { append(event: unknown): unknown }) => unknown }
    let releaseRun: () => void = () => {}
    const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })
    let releaseAfterTerminal: () => void = () => {}
    const afterTerminalReleased = new Promise<void>((resolve) => { releaseAfterTerminal = resolve })
    let terminalWritten: () => void = () => {}
    const terminalReady = new Promise<void>((resolve) => { terminalWritten = resolve })
    agents.create = (session) => ({
      send: () => {},
      stop: () => {},
      async run() {
        await runReleased
        session.append({ type: 'turn/start', turnId: 'completed-turn' })
        session.append({ type: 'assistant/message', stepId: 'completed-step', content: 'completed report', toolCalls: [] })
        session.append({ type: 'turn/end', turnId: 'completed-turn', reason: 'completed' })
        terminalWritten()
        await afterTerminalReleased
      },
    })
    const handle = await harness.executor.spawn(request(harness, explorer))
    releaseRun()
    await terminalReady

    // The child has a terminal event but `run()` is still in progress.
    // Reconciliation must neither append a result nor release capacity.
    expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId)).toMatchObject({ status: 'running' })
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)

    releaseAfterTerminal()
    const settled = await settle(harness, handle.childSessionId)
    expect(settled?.status).toBe('completed')
    const parentEvents = harness.kernel.ctx.sessions.get(harness.rootSessionId as never).events
    expect(parentEvents.filter((event) => event.type === 'agent/child-result' && event.childSessionId === handle.childSessionId)).toHaveLength(1)
    await harness.kernel.stop()
  }, 15_000)

  it('never durably completes a parent when its completed child log cannot flush', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-child-flush-'))
    try {
      const harness = await boot(['unused'], { dir })
      const agents = harness.kernel.ctx.get('agents') as { create: (session: { append(event: unknown): unknown }) => unknown }
      let releaseRun: () => void = () => {}
      const runReleased = new Promise<void>((resolve) => { releaseRun = resolve })
      agents.create = (session) => ({
        send: () => {},
        stop: () => {},
        async run() {
          await runReleased
          session.append({ type: 'turn/start', turnId: 'completed-turn' })
          session.append({ type: 'assistant/message', stepId: 'completed-step', content: 'completed report', toolCalls: [] })
          session.append({ type: 'turn/end', turnId: 'completed-turn', reason: 'completed' })
        },
      })
      const handle = await harness.executor.spawn(request(harness, explorer))
      const child = harness.kernel.ctx.sessions.get(handle.childSessionId as never) as unknown as { durable(): Promise<void> }
      const durable = child.durable.bind(child)
      child.durable = async () => { throw new Error('child disk full') }
      releaseRun()

      // A failed child-log barrier gives no durable terminal fact. Retain it as
      // repairable uncertainty and keep its slot rather than inventing failure.
      expect(await settle(harness, handle.childSessionId)).toMatchObject({ status: 'uncertain' })
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(1)
      expect(harness.kernel.ctx.sessions.get(harness.rootSessionId as never).events
        .some((event) => event.type === 'agent/child-result' && event.childSessionId === handle.childSessionId)).toBe(false)

      // Once the canonical child terminal turn is readable, repair settles the
      // parent exactly once and releases the retained reservation exactly once.
      child.durable = durable
      expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId))
        .toMatchObject({ status: 'completed', result: { report: 'completed report' } })
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
      expect(await harness.executor.reconcile(harness.workspaceId as never, handle.childSessionId))
        .toMatchObject({ status: 'completed' })
      expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
      expect(harness.kernel.ctx.sessions.get(harness.rootSessionId as never).events
        .filter((event) => event.type === 'agent/child-result' && event.childSessionId === handle.childSessionId)).toHaveLength(1)
      await harness.kernel.stop()

      const restarted = new Kernel()
      restarted.ctx.plugin(fileSessions(dir))
      await restarted.ctx.sessions.boot()
      const executor = new ChildExecutor(restarted.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      expect(await executor.reconcile(harness.workspaceId as never, handle.childSessionId))
        .toMatchObject({ status: 'completed', result: { report: 'completed report' } })
      await restarted.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('releases capacity when a non-poisoned durable wrapper rejects after its terminal result was canonically committed', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const first = await harness.executor.spawn(request(harness, explorer))
    const second = await harness.executor.spawn(request(harness, explorer))
    const third = await harness.executor.spawn(request(harness, explorer))
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    const durable = root.durable.bind(root)
    root.durable = async () => { await durable(); throw new Error('post-success terminal rejection') }
    expect(await harness.executor.cancel(harness.workspaceId as never, third.childSessionId)).toMatchObject({ status: 'cancelled' })
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(2)
    root.durable = durable
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await Promise.all([settle(harness, first.childSessionId), settle(harness, second.childSessionId)])
    await harness.kernel.stop()
  }, 20_000)

  it('releases retained reservations exactly once when root deletion succeeds before forgetRoot', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const children = await Promise.all([0, 1, 2].map(() => harness.executor.spawn(request(harness, explorer))))
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    const durable = root.durable.bind(root)
    root.durable = async () => { await durable(); throw new Error('post-success terminal rejection') }
    await harness.executor.cancel(harness.workspaceId as never, children[2]!.childSessionId)
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(2)
    expect(harness.executor.forgetRoot(harness.rootSessionId as never)).toEqual([])
    root.durable = durable

    await harness.kernel.ctx.sessions.delete(harness.rootSessionId as never)
    expect(harness.executor.forgetRoot(harness.rootSessionId as never).sort()).toEqual(children.map((child) => child.childSessionId).sort())
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    expect(harness.executor.forgetRoot(harness.rootSessionId as never)).toEqual([])
    await harness.kernel.stop()
  }, 20_000)

  it('does not list an active child after its root is deleted', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    await harness.executor.spawn(request(harness, explorer))
    await harness.kernel.ctx.sessions.delete(harness.rootSessionId as never)
    expect(await harness.executor.childrenOfRoot(harness.rootSessionId as never)).toEqual([])
    expect(await harness.executor.childrenOfRoot(harness.rootSessionId as never, harness.workspaceId as never)).toEqual([])
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 15_000)

  it('a child inside its spawn window lists as queued, never as settled', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never) as unknown as { durable(): Promise<void> }
    const durable = root.durable.bind(root)
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => { open = resolve })
    root.durable = async () => { await gate; await durable() }
    const pending = harness.executor.spawn(request(harness, explorer))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const listed = await harness.executor.childrenOfRoot(harness.rootSessionId as never)
    expect(listed.map((child) => child.status)).toEqual(['queued'])
    root.durable = durable
    open()
    await pending
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 15_000)

  it('a session the parent never recorded is not a child; an unrecorded run without a completed turn is interrupted', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-commit-'))
    try {
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(dir))
      const ws = new WorkspaceService(dir)
      await ws.boot()
      await kernel.ctx.sessions.boot()
      const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
      const leftover = kernel.ctx.sessions.create(ws.defaultWorkspace)
      leftover.append({ type: 'session/child-meta', parentSessionId: root.id, parentTurnId: 't', definition: 'explorer', brief: 'x' })
      await leftover.durable()
      const silent = kernel.ctx.sessions.create(ws.defaultWorkspace)
      silent.append({ type: 'session/child-meta', parentSessionId: root.id, parentTurnId: 't', definition: 'explorer', brief: 'y' })
      await silent.durable()
      root.append({ type: 'agent/child-spawn', childSessionId: silent.id, parentTurnId: 't', definition: 'explorer', brief: 'y' })
      await root.durable()

      const executor = new ChildExecutor(kernel.ctx)
      expect(await executor.recoverFromStorage()).toBe(1)
      expect(await executor.wait(ws.defaultWorkspace, [leftover.id], { timeoutMs: 10 })).toEqual([])
      const listed = await executor.childrenOfRoot(root.id, ws.defaultWorkspace)
      expect(listed.map((child) => [child.childSessionId, child.status])).toEqual([[silent.id, 'interrupted']])
      await kernel.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('recovery skips a child whose parent session is missing', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-orphan-'))
    try {
      const kernel = new Kernel()
      kernel.ctx.plugin(fileSessions(dir))
      const ws = new WorkspaceService(dir)
      await ws.boot()
      await kernel.ctx.sessions.boot()
      const orphan = kernel.ctx.sessions.create(ws.defaultWorkspace)
      orphan.append({ type: 'session/child-meta', parentSessionId: 'gone', parentTurnId: 't', definition: 'explorer', brief: 'x' })
      await orphan.durable()
      const executor = new ChildExecutor(kernel.ctx)
      expect(await executor.recoverFromStorage()).toBe(0)
      await kernel.stop()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('direct wait refuses a committed child whose parent was deleted', async () => {
    const harness = await boot(['done'])
    const handle = await harness.executor.spawn(request(harness, explorer))
    await settle(harness, handle.childSessionId)
    await harness.kernel.ctx.sessions.delete(harness.rootSessionId as never)
    expect(await harness.executor.wait(harness.workspaceId as never, [handle.childSessionId as never], { timeoutMs: 10 })).toEqual([])
    await harness.kernel.stop()
  }, 15_000)

  it('direct wait refuses a committed child whose parent project no longer matches', async () => {
    const harness = await boot(['done'])
    const projectId = 'project-a'
    const root = harness.kernel.ctx.sessions.get(harness.rootSessionId as never)
    root.append({ type: 'session/project', projectId })
    await root.durable()
    const handle = await harness.executor.spawn(request(harness, explorer, { projectId: projectId as never }))
    await settle(harness, handle.childSessionId)
    root.append({ type: 'session/project', projectId: 'project-b' })
    await root.durable()
    expect(await harness.executor.wait(harness.workspaceId as never, [handle.childSessionId as never], { timeoutMs: 10 })).toEqual([])
    await harness.kernel.stop()
  }, 15_000)
})

describe('capacity', () => {
  it('per-turn budget counts attempts, not completions, until the turn hook releases it', async () => {
    const harness = await boot(['done'])
    for (let i = 0; i < 8; i++) {
      const handle = await harness.executor.spawn(request(harness, explorer))
      await settle(harness, handle.childSessionId)
    }
    await expect(harness.executor.spawn(request(harness, explorer))).rejects.toThrow(/8 children per turn/)
    harness.executor.releaseTurns(harness.rootSessionId as never)
    const fresh = await harness.executor.spawn(request(harness, explorer))
    await settle(harness, fresh.childSessionId)
    await harness.kernel.stop()
  }, 30_000)

  it('concurrent spawns cannot race past a conversation\'s limit, and one conversation cannot starve another', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const other = harness.kernel.ctx.sessions.create(harness.workspaceId as never).id as unknown as string
    const [mine, theirs] = await Promise.all([
      Promise.allSettled([0, 1, 2, 3, 4, 5, 6].map(() => harness.executor.spawn(request(harness, explorer)))),
      Promise.allSettled([0, 1, 2, 3, 4, 5].map(() => harness.executor.spawn(request(harness, explorer, { parentSessionId: other as never })))),
    ])
    expect(mine.filter((result) => result.status === 'fulfilled')).toHaveLength(6)
    const refused = mine.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.reason).toMatchObject({ code: 'capacity', message: expect.stringMatching(/for this conversation/) })
    expect(theirs.every((result) => result.status === 'fulfilled')).toBe(true)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.executor.cancelAllOfRoot(other as never)
    await harness.kernel.stop()
  }, 20_000)

  it('root slots are independent; host dispatch capacity queues rather than denying another root', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }], { blocking: true })
    const roots = [harness.rootSessionId, ...[1, 2, 3].map(() => harness.kernel.ctx.sessions.create(harness.workspaceId as never).id as unknown as string)]
    for (const rootId of roots) {
      for (let i = 0; i < 6; i++) await harness.executor.spawn(request(harness, explorer, { parentSessionId: rootId as never }))
      expect(harness.executor.activeOfRoot(rootId as never)).toBe(6)
    }
    await expect(harness.executor.spawn(request(harness, explorer, { parentSessionId: roots[0] as never }))).rejects.toThrow(/for this conversation/)
    const all = await Promise.all(roots.map((rootId) => harness.executor.childrenOfRoot(rootId as never)))
    expect(all.flat()).toHaveLength(24)
    expect(all.flat().filter((child) => child.status === 'queued').length).toBeGreaterThan(0)
    for (const rootId of roots) {
      await harness.executor.cancelAllOfRoot(rootId as never)
      expect(harness.executor.activeOfRoot(rootId as never)).toBe(0)
    }
    await harness.kernel.stop()
  }, 30_000)
})

describe('brief and inheritance', () => {
  it('normalizes the brief: prose first, then the structured objective', () => {
    expect(normalizeBrief({ prompt: '  prose  ', objective: 'form', requiredResult: 'r' })).toBe('prose')
    expect(normalizeBrief({ prompt: '   ', objective: ' form ', requiredResult: 'r' })).toBe('form')
    expect(normalizeBrief({ requiredResult: 'r' })).toBeUndefined()
  })

  it('a prose brief is the child\'s opener; the role lives in the system prompt, not the message', async () => {
    const harness = await boot(['ok'])
    const handle = await harness.executor.spawn(request(harness, explorer, { packet: { prompt: 'Find the auth module.', requiredResult: 'paths' } }))
    await settle(harness, handle.childSessionId)
    const opener = childEvents(harness, handle.childSessionId).find((event) => event.type === 'user/message')
    expect(opener?.type === 'user/message' && opener.content).toBe('Find the auth module.\n\n## Required result\n\npaths')
    const meta = childEvents(harness, handle.childSessionId).find((event) => event.type === 'session/child-meta')
    expect(meta).toMatchObject({ brief: 'Find the auth module.' })
    const spawnRecord = harness.kernel.ctx.sessions.get(harness.rootSessionId as never).events.find((event) => event.type === 'agent/child-spawn')
    expect(spawnRecord).toMatchObject({ brief: 'Find the auth module.' })
    await harness.kernel.stop()
  }, 15_000)

  it('the structured form renders without empty sections', async () => {
    const harness = await boot(['ok'])
    const handle = await harness.executor.spawn(request(harness, explorer, {
      packet: { objective: 'Map modules', constraints: [], references: [], requiredResult: 'list' },
    }))
    await settle(harness, handle.childSessionId)
    const opener = childEvents(harness, handle.childSessionId).find((event) => event.type === 'user/message')
    const content = opener?.type === 'user/message' ? opener.content : ''
    expect(content).toBe('## Task\n\nMap modules\n\n## Required result\n\nlist')
    expect(content).not.toContain('<definition')
    expect(content).not.toContain('(none)')
    await harness.kernel.stop()
  }, 15_000)

  it('refuses a packet with no brief, and inconsistent inherit fields, as packet errors', async () => {
    const harness = await boot(['ok'])
    await expect(harness.executor.spawn(request(harness, explorer, { packet: { prompt: ' ', objective: '', requiredResult: 'r' } })))
      .rejects.toMatchObject({ code: 'packet', message: expect.stringMatching(/'prompt'.*'objective'/) })
    await expect(harness.executor.spawn(request(harness, explorer, { inherit: 'brief' }))).rejects.toMatchObject({ code: 'packet' })
    await expect(harness.executor.spawn(request(harness, explorer, { inheritedContext: 'x' }))).rejects.toMatchObject({ code: 'packet' })
    await harness.kernel.stop()
  }, 15_000)

  it('a role with inheritable:false refuses inherited context by name', async () => {
    const harness = await boot(['ok'])
    const sealed = { ...explorer, name: 'sealed', inheritable: false }
    await expect(harness.executor.spawn(request(harness, sealed, { inherit: 'brief', inheritedContext: 'User: hi' })))
      .rejects.toMatchObject({ code: 'inherit', message: expect.stringContaining("'sealed'") })
    await harness.kernel.stop()
  }, 15_000)

  it('records inheritance as audit metadata only — never the inherited text', async () => {
    const harness = await boot(['ok'])
    const inherited = 'User: the secret plan lives in plan-7.md'
    const handle = await harness.executor.spawn(request(harness, explorer, { inherit: 'brief', inheritedContext: inherited }))
    await settle(harness, handle.childSessionId)
    const meta = childEvents(harness, handle.childSessionId).find((event) => event.type === 'session/child-meta')
    expect(meta).toMatchObject({ inherit: 'brief', inheritedChars: inherited.length })
    expect(meta?.type === 'session/child-meta' && meta.inheritedHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(childEvents(harness, handle.childSessionId))).not.toContain('plan-7.md')
    await harness.kernel.stop()
  }, 15_000)

  it('projects recent messages only, newest kept, in order, within the cap', () => {
    const at = (seq: number) => ({ seq, timestamp: seq })
    const events = [
      { type: 'user/message', content: 'first question', ...at(1) },
      { type: 'assistant/message', stepId: 's1', content: 'let me look', toolCalls: [{ id: 'c', name: 'Read', args: { path: 'a.ts' } }], ...at(2) },
      { type: 'tool/call', stepId: 's1', call: { id: 'c', name: 'Read', args: { path: 'a.ts' } }, ...at(3) },
      { type: 'tool/result', stepId: 's1', callId: 'c', output: 'SECRET FILE BODY', ok: true, ...at(4) },
      { type: 'assistant/message', stepId: 's2', content: 'a.ts exports the router', ...at(5) },
      { type: 'user/message', content: 'now delegate', ...at(6) },
    ] as never
    const projected = projectInheritedMessages(events)
    expect(projected).toBe('User: first question\n\nAssistant: a.ts exports the router\n\nUser: now delegate')
    expect(projected).not.toContain('SECRET FILE BODY')
    expect(projected).not.toContain('let me look')
    const big = Array.from({ length: 400 }, (_, i) => ({ type: 'user/message', content: `m${i} ${'z'.repeat(500)}`, ...at(i + 1) })) as never
    const capped = projectInheritedMessages(big, 12_000)
    expect(capped.length).toBeLessThanOrEqual(12_000)
    expect(capped.endsWith(`m399 ${'z'.repeat(500)}`)).toBe(true)
    expect(capped).not.toContain('m0 ')
  })
})

describe('the Agent tool', () => {
  const fakeExecutor = () => {
    const spawned: SpawnRequest[] = []
    return {
      spawned,
      executor: {
        async spawn(req: SpawnRequest) {
          spawned.push(req)
          return { childSessionId: 'child-1', status: 'running', definitionName: req.definition.name, startedAt: 0 }
        },
        activeOfRoot: () => 1,
        runningChildrenOfRoot: () => [],
        childrenOfRoot: async () => [],
        wait: async () => [],
        cancel: async () => undefined,
        reconcile: async (_workspaceId: string, _childSessionId: string) => undefined,
      },
    }
  }

  function deps(definitions: AgentDefinitionService, executor: unknown, events: readonly unknown[] = []): DelegationDeps {
    return {
      definitions,
      executor: executor as never,
      session: async () => ({ events }) as never,
      childModelFor: () => undefined,
      providers: () => [],
      modelsOf: () => [],
    }
  }

  const run = <T>(workspaceId: string, fn: () => T): T => agentScope.run({ sessionId: 'root' as never, rootSessionId: 'root' as never, turnId: 'turn-active' as never, workspaceId: workspaceId as never }, fn)

  it('spawns from a prose prompt, reports dropped grants and the per-conversation count', async () => {
    const { executor, spawned } = fakeExecutor()
    const tool = agentTool(deps(new AgentDefinitionService(home), executor))
    const raw = await run('ws-tool', () => tool.execute({ action: 'spawn', definition: 'reviewer', prompt: 'Review src/a.ts', objective: 'old form', grantTools: ['Read', 'Write'] }, {} as never))
    const result = JSON.parse(String(raw)) as Record<string, unknown>
    expect(spawned[0]?.packet.prompt).toBe('Review src/a.ts')
    expect(result['active']).toBe('1/6')
    expect(result['droppedGrants']).toEqual(['Write'])
    expect(String(result['note'])).toContain("the prompt is the brief")
    expect(result['inheritedChars']).toBeUndefined()
  })

  it('captures inherited context at spawn and reports its size', async () => {
    const { executor, spawned } = fakeExecutor()
    const events = [{ type: 'user/message', content: 'look at plan-7.md', seq: 1, timestamp: 1 }]
    const tool = agentTool(deps(new AgentDefinitionService(home), executor, events))
    const raw = await run('ws-tool', () => tool.execute({ action: 'spawn', definition: 'explorer', prompt: 'Summarize it', inherit: 'brief' }, {} as never))
    expect(spawned[0]).toMatchObject({ inherit: 'brief', inheritedContext: 'User: look at plan-7.md' })
    expect(JSON.parse(String(raw))).toMatchObject({ inheritedChars: 'User: look at plan-7.md'.length })
    await expect(run('ws-tool', () => tool.execute({ action: 'spawn', definition: 'explorer', prompt: 'x', inherit: 'all' }, {} as never))).rejects.toThrow(/'inherit'/)
  })

  it('reconciles only child ids owned by the calling root through the Agent tool', async () => {
    const { executor } = fakeExecutor()
    const tool = agentTool(deps(new AgentDefinitionService(home), executor))
    const raw = await run('ws-tool', () => tool.execute({ action: 'reconcile', childIds: ['root-child', 'foreign-child'] }, {} as never))
    expect(JSON.parse(String(raw))).toEqual({ children: [] })
  })

  it('describes the delegation trade-off and the writer boundary honestly', () => {
    const { executor } = fakeExecutor()
    const tool = agentTool(deps(new AgentDefinitionService(home), executor))
    const description = run('ws-tool', () => tool.schema?.()?.description ?? '')
    expect(description).toContain('Delegate when the work is separable')
    expect(description).toContain('share the project filesystem')
    expect(description).toContain('re-read before writing')
    expect(description).not.toMatch(/one at a time|serializ/i)
    for (const role of ['explorer', 'worker', 'reviewer', 'verifier']) expect(description).toContain(`${role} (`)
  })

  it('caches role listings per workspace, so custom roles never leak across workspaces', async () => {
    const roleHome = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-g4-roles-'))
    try {
      const definitions = new AgentDefinitionService(roleHome)
      await definitions.save('ws-a', 'alpha-role', '---\ndescription: "alpha only"\n---\n\nA.')
      await definitions.save('ws-b', 'beta-role', '---\ndescription: "beta only"\n---\n\nB.')
      const { executor } = fakeExecutor()
      const tool = agentTool(deps(definitions, executor))
      const describeIn = (ws: string): string => run(ws, () => tool.schema?.()?.description ?? '')
      const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50))
      describeIn('ws-a')
      await tick()
      describeIn('ws-b')
      await tick()
      expect(describeIn('ws-a')).toContain('alpha-role')
      expect(describeIn('ws-a')).not.toContain('beta-role')
      expect(describeIn('ws-b')).toContain('beta-role')
      expect(describeIn('ws-b')).not.toContain('alpha-role')
      const catalog = JSON.parse(String(await run('ws-a', () => tool.execute({ action: 'catalog' }, {} as never)))) as { roles: { name: string }[] }
      expect(catalog.roles.map((role) => role.name).sort()).toEqual(['alpha-role', 'explorer', 'reviewer', 'verifier', 'worker'])
    } finally {
      await fs.rm(roleHome, { recursive: true, force: true })
    }
  })
})
