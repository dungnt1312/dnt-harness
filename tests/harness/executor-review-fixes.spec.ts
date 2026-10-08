/**
 * Review fixes for the G4 executor and definition registry: name validation
 * and containment, closeTurn/cancelAllOfRoot joining the admission writer,
 * bounded closing guards, and keepOpen batches surviving a failed join.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentDefinitionError,
  AgentDefinitionService,
  AgentsService,
  ChildExecutor,
  Kernel,
  LlmService,
  SpawnError,
  ToolsService,
  WorkspaceService,
  bundledDefinition,
  fileSessions,
  type AgentDefinition,
  type SpawnRequest,
} from 'dnt-harness'
import { FakeScriptedLlm, type ScriptStep } from '../support/fake-llm.ts'

let home = ''

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-exec-review-'))
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

async function boot(script: readonly ScriptStep[]): Promise<Harness> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const ws = new WorkspaceService(home)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm(script))
  // Read blocks until aborted: children stay active until cancelled.
  kernel.ctx.tools.register({
    name: 'Read', description: 'gate', requiresRoot: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, exec) {
      await new Promise<void>((resolve) => {
        if (exec.signal?.aborted === true) resolve()
        else exec.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'read'
    },
  })
  const root = kernel.ctx.sessions.create(ws.defaultWorkspace)
  return {
    kernel,
    executor: new ChildExecutor(kernel.ctx),
    workspaceId: ws.defaultWorkspace as unknown as string,
    rootSessionId: root.id as unknown as string,
  }
}

const worker = bundledDefinition('worker')

function request(harness: Harness, definition: AgentDefinition, overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    workspaceId: harness.workspaceId as never,
    parentSessionId: harness.rootSessionId as never,
    parentTurnId: 'turn-1',
    definition,
    exposureCeiling: definition.tools,
    packet: { prompt: 'Inspect the repository.', requiredResult: 'a short answer' },
    ...overrides,
  }
}

/** A resolver that parks admission until released. */
function gate(): { resolver: SpawnRequest['admissionResolver']; started: Promise<void>; release: () => void } {
  let release!: () => void
  const barrier = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const startedP = new Promise<void>((resolve) => { started = resolve })
  return {
    resolver: async ({ candidates }) => { started(); await barrier; return candidates },
    started: startedP,
    release,
  }
}

function parentEvents(harness: Harness) {
  return harness.kernel.ctx.sessions.get(harness.rootSessionId as never).events
}

describe('definition names are validated and contained', () => {
  it('delete refuses traversal names and leaves outside files alone', async () => {
    const service = new AgentDefinitionService(home)
    const ws = 'ws-x'
    const outside = path.join(home, 'workspaces', ws, 'skills', 'foo.md')
    await fs.mkdir(path.dirname(outside), { recursive: true })
    await fs.writeFile(outside, 'keep me')
    // Claude Code agent file names may be capitalized (`Explore.md`); only
    // path-shaped or empty names are refused.
    for (const name of ['../skills/foo', '..', 'a/b', '.hidden', '']) {
      await expect(service.delete(ws as never, name)).rejects.toMatchObject({ code: 'invalid' })
    }
    expect(await fs.readFile(outside, 'utf8')).toBe('keep me')
    // Bundled behavior unchanged.
    await expect(service.delete(ws as never, 'explorer')).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('resolve reports unsafe names as not-found and still resolves bundled roles', async () => {
    const service = new AgentDefinitionService(home)
    const ws = 'ws-x'
    await fs.mkdir(path.join(home, 'workspaces', ws, 'skills'), { recursive: true })
    await fs.writeFile(path.join(home, 'workspaces', ws, 'skills', 'foo.md'), '---\nname: foo\ndescription: d\n---\n\nbody')
    const error = await service.resolve(ws as never, '../skills/foo').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AgentDefinitionError)
    expect((error as AgentDefinitionError).code).toBe('not-found')
    expect((await service.resolve(ws as never, 'worker')).source).toBe('bundled')
  })
})

describe('admission fencing', () => {
  it('closeTurn waits for an admitted spawn still awaiting its resolver, which then refuses', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const parked = gate()
    const spawning = harness.executor.spawn(request(harness, worker, { admissionResolver: parked.resolver, exposureCeiling: undefined }))
    await parked.started
    const closing = harness.executor.closeTurn(harness.rootSessionId as never, 'turn-1')
    parked.release()
    const error = await spawning.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SpawnError)
    expect((error as Error).message).toMatch(/turn is closing/)
    await closing
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    // Nothing spawned: no empty durable marker.
    expect(parentEvents(harness).some((event) => event.type === 'turn/closing')).toBe(false)
    await harness.kernel.stop()
  }, 15_000)

  it('cancelAllOfRoot fences a spawn waiting before it became active', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const parked = gate()
    const spawning = harness.executor.spawn(request(harness, worker, { admissionResolver: parked.resolver, exposureCeiling: undefined }))
    await parked.started
    const stopping = harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    parked.release()
    const handle = await spawning
    expect(await stopping).toBe(1)
    const [settled] = await harness.executor.wait(harness.workspaceId as never, [handle.childSessionId], { timeoutMs: 3_000 })
    expect(settled?.status).toBe('cancelled')
    expect(harness.executor.activeOfRoot(harness.rootSessionId as never)).toBe(0)
    await harness.kernel.stop()
  }, 15_000)
})

describe('closing guards are bounded', () => {
  it('releaseTurns drops the guard of a terminal turn; the durable turn/end still refuses late spawns', async () => {
    const harness = await boot(['done'])
    const root = harness.rootSessionId as never
    const closing = (harness.executor as unknown as { closingTurns: Set<string> }).closingTurns
    await harness.executor.closeTurn(root, 'turn-x')
    // A turn still between closing and its end keeps its guard.
    await harness.executor.releaseTurns(root)
    expect(closing.has(`${harness.rootSessionId}:turn-x`)).toBe(true)
    const parent = harness.kernel.ctx.sessions.get(root)
    parent.append({ type: 'turn/end', turnId: 'turn-x' as never, reason: 'completed' })
    await parent.durable()
    await harness.executor.releaseTurns(root)
    expect(closing.size).toBe(0)
    // No turn/start in the log (never spawned), yet turn/end refuses it.
    await expect(harness.executor.spawn(request(harness, worker, { parentTurnId: 'turn-x' })))
      .rejects.toThrow(/closing or already closed/)
    expect(harness.executor.activeOfRoot(root)).toBe(0)
    await harness.kernel.stop()
  }, 15_000)
})

describe('manual keepOpen batches', () => {
  it('a failed join leaves the batch open and earlier children running', async () => {
    const harness = await boot([{ toolCalls: [{ name: 'Read', args: {} }] }])
    const base = request(harness, worker)
    const { parentTurnId: _ignored, ...manual } = base
    const first = await harness.executor.spawnManual(manual, () => false, { keepOpen: true })
    const error = await harness.executor.spawnManual(
      { ...manual, packet: { prompt: '   ', requiredResult: 'x' } },
      () => false,
      { turnId: first.turnId, keepOpen: true },
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SpawnError)
    const events = parentEvents(harness)
    expect(events.some((event) => (event.type === 'turn/closing' || event.type === 'turn/end') && event.turnId === first.turnId)).toBe(false)
    const [live] = await harness.executor.wait(harness.workspaceId as never, [first.handle.childSessionId], { timeoutMs: 1 })
    expect(['queued', 'dispatching', 'running']).toContain(live?.status)
    // The batch still accepts another child.
    const third = await harness.executor.spawnManual(manual, () => false, { turnId: first.turnId, keepOpen: true })
    expect(third.turnId).toBe(first.turnId)
    await harness.executor.cancelAllOfRoot(harness.rootSessionId as never)
    await harness.kernel.stop()
  }, 15_000)
})
