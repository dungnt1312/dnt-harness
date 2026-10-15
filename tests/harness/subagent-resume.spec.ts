/**
 * Talking to a child after spawn: a message queued for (or steering) a
 * running child, a finished child resumed as a new run — in process and
 * after a restart, from the snapshot pinned at spawn — and the refusals that
 * keep a resume from widening or racing anything.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentsService,
  ChildExecutor,
  Kernel,
  LlmService,
  ToolsService,
  WorkspaceService,
  bundledDefinition,
  fileSessions,
  type SpawnRequest,
} from 'dnt-harness'
import { FakeScriptedLlm, type ScriptStep } from '../support/fake-llm.ts'

let home = ''
const kernels: Kernel[] = []
beforeAll(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-resume-')) })
afterAll(async () => {
  await Promise.all(kernels.map((kernel) => kernel.stop().catch(() => {})))
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface Harness {
  readonly kernel: Kernel
  readonly executor: ChildExecutor
  readonly workspaceId: never
  readonly rootSessionId: never
  readonly seen: string[][]
}

/** A kernel on `dir`; the LLM records the user messages of every request. */
async function boot(dir: string, script: readonly ScriptStep[], options: { readonly slowMs?: number; readonly rootSessionId?: string } = {}): Promise<Harness> {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  const ws = new WorkspaceService(dir)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  const seen: string[][] = []
  const llm = new FakeScriptedLlm(script)
  kernel.ctx.llm.register({
    name: llm.name,
    models: llm.models,
    stream(request, streamOptions) {
      seen.push(request.messages.filter((message) => message.role === 'user').map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
      return llm.stream(request, streamOptions)
    },
  })
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
  const rootSessionId = options.rootSessionId ?? kernel.ctx.sessions.create(ws.defaultWorkspace).id
  kernels.push(kernel)
  return { kernel, executor: new ChildExecutor(kernel.ctx), workspaceId: ws.defaultWorkspace as never, rootSessionId: rootSessionId as never, seen }
}

function spawnRequest(harness: Harness, turn = 'turn-1', overrides: Partial<SpawnRequest> = {}): SpawnRequest {
  return {
    workspaceId: harness.workspaceId,
    parentSessionId: harness.rootSessionId,
    parentTurnId: turn,
    definition: bundledDefinition('worker'),
    exposureCeiling: bundledDefinition('worker').tools,
    packet: { prompt: 'Do the work.', requiredResult: 'a short answer' },
    ...overrides,
  }
}

const read = (file: string): ScriptStep => ({ content: 'Reading it.', toolCalls: [{ name: 'Read', args: { path: file } }] })

async function settle(harness: Harness, id: string) {
  const [handle] = await harness.executor.wait(harness.workspaceId, [id as never], { timeoutMs: 10_000 })
  return handle
}

describe('messaging a finished child', () => {
  it('resumes it as a new run whose handle carries only the new result', async () => {
    const harness = await boot(home, ['First answer.', 'Second answer.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    expect((await settle(harness, spawned.childSessionId))?.result?.report).toBe('First answer.')

    const resumed = await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Now do more.', 'queue')
    expect(resumed.status).not.toBe('completed')
    const done = await settle(harness, spawned.childSessionId)
    expect(done?.status).toBe('completed')
    expect(done?.result?.report).toBe('Second answer.')
    // The child saw its own history: the brief and the follow-up.
    expect(harness.seen.at(-1)?.some((text) => text.includes('Do the work.'))).toBe(true)
    expect(harness.seen.at(-1)?.at(-1)).toContain('Now do more.')
  })

  it('a resumed run that touched no files reports no files from the earlier run', async () => {
    const harness = await boot(home, [read('a.ts'), 'Done reading.', 'Nothing to touch.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    expect((await settle(harness, spawned.childSessionId))?.result?.filesTouched).toEqual(['a.ts'])
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Summarize.', 'queue')
    const done = await settle(harness, spawned.childSessionId)
    expect(done?.result?.report).toBe('Nothing to touch.')
    expect(done?.result?.filesTouched).toEqual([])
  })

  it('the resumed run is owed to the calling turn, not the spawning one', async () => {
    const harness = await boot(home, ['First.', 'Second.'], { slowMs: 0 })
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await settle(harness, spawned.childSessionId)
    harness.executor.markReported([spawned.childSessionId])
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Again.', 'queue')
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-1')).toEqual([])
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([spawned.childSessionId])
  })

  it('refuses a turn that is closing', async () => {
    const harness = await boot(home, ['First.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await settle(harness, spawned.childSessionId)
    await harness.executor.closeTurn(harness.rootSessionId, 'turn-1')
    await expect(harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-1', spawned.childSessionId as never, 'More.', 'queue'))
      .rejects.toThrow(/closing/)
  })
})

describe('messaging a running child', () => {
  it('queue: the message runs as the child\'s next turn after the current one', async () => {
    const harness = await boot(home, [read('a.ts'), 'First turn done.', 'Handled the follow-up.'], { slowMs: 200 })
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const handle = await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-1', spawned.childSessionId as never, 'Also check b.ts.', 'queue')
    expect(handle.status).toBe('running')
    const done = await settle(harness, spawned.childSessionId)
    expect(done?.status).toBe('completed')
    expect(done?.result?.report).toBe('Handled the follow-up.')
    const child = await harness.kernel.ctx.sessions.load(spawned.childSessionId)
    const ends = child.events.filter((event) => event.type === 'turn/end').map((event) => event.type === 'turn/end' && event.reason)
    expect(ends).toEqual(['completed', 'completed'])
  })

  it('steer: the current child turn ends steered and the message runs at once', async () => {
    const harness = await boot(home, [read('a.ts'), 'Steered answer.'], { slowMs: 2_000 })
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await new Promise((resolve) => setTimeout(resolve, 80))
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-1', spawned.childSessionId as never, 'Stop that, do this.', 'steer')
    const done = await settle(harness, spawned.childSessionId)
    expect(done?.status).toBe('completed')
    expect(done?.result?.report).toBe('Steered answer.')
    const child = await harness.kernel.ctx.sessions.load(spawned.childSessionId)
    const ends = child.events.filter((event) => event.type === 'turn/end').map((event) => event.type === 'turn/end' && event.reason)
    expect(ends).toEqual(['steered', 'completed'])
  })

  it('a message racing the end of a run is never stranded: it runs, as this run or a resume', async () => {
    const harness = await boot(home, ['Ends at once.', 'Handled the late message.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    // Poll until the run is past running but before (or during) settlement.
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        void harness.executor.childrenOfRoot(harness.rootSessionId, harness.workspaceId).then((children) => {
          if (children[0]?.status !== 'running' && children[0]?.status !== 'queued' && children[0]?.status !== 'dispatching') resolve()
          else setTimeout(tick, 1)
        })
      }
      tick()
    })
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Late.', 'queue')
    const done = await settle(harness, spawned.childSessionId)
    expect(done?.result?.report).toBe('Handled the late message.')
  })

  it('the message is durable in the child log before it is delivered', async () => {
    const harness = await boot(home, [read('a.ts'), 'Done.', 'Follow-up done.'], { slowMs: 200 })
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await new Promise((resolve) => setTimeout(resolve, 80))
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-1', spawned.childSessionId as never, 'Durable please.', 'queue')
    const canonical = await harness.kernel.ctx.sessions.readCanonicalEvents?.(spawned.childSessionId as never)
    expect(canonical?.some((event) => event.type === 'input/queued' && event.content === 'Durable please.')).toBe(true)
    await settle(harness, spawned.childSessionId)
  })
})

describe('resume after a restart', () => {
  it('a completed child resumes on a fresh executor with its pinned ceiling', async () => {
    const dir = await fs.mkdtemp(path.join(home, 'restart-'))
    const first = await boot(dir, ['Before restart.'])
    const spawned = await first.executor.spawn(spawnRequest(first, 'turn-1', {
      definition: { ...bundledDefinition('worker'), tools: ['Read', 'Grep'] },
      exposureCeiling: ['Read', 'Grep', 'Write'],
    }))
    await settle(first, spawned.childSessionId)
    await first.kernel.stop()

    const second = await boot(dir, ['After restart.'], { rootSessionId: first.rootSessionId })
    await second.executor.recoverFromStorage()
    let ceiling: readonly string[] | undefined
    second.kernel.ctx.on('agent/context', async (request, next) => {
      const { agentScope } = await import('../../src/harness/agent/scope.ts')
      ceiling ??= agentScope.getStore()?.childOf?.toolCeiling
      return next(request)
    }, true)
    await second.executor.message(second.workspaceId, second.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Continue.', 'queue')
    const done = await settle(second, spawned.childSessionId)
    expect(done?.status).toBe('completed')
    expect(done?.result?.report).toBe('After restart.')
    expect(ceiling).toEqual(['Read', 'Grep'])
    expect(second.seen.at(-1)?.some((text) => text.includes('Do the work.'))).toBe(true)
  })

  it('a resume admitted but cut by a restart reads interrupted, never the earlier completed', async () => {
    const dir = await fs.mkdtemp(path.join(home, 'cut-'))
    const first = await boot(dir, ['Before.', read('slow.ts'), 'Never.'], { slowMs: 5_000 })
    const spawned = await first.executor.spawn(spawnRequest(first))
    await settle(first, spawned.childSessionId)
    await first.executor.message(first.workspaceId, first.rootSessionId, 'turn-2', spawned.childSessionId as never, 'Long job.', 'queue')
    await new Promise((resolve) => setTimeout(resolve, 150))
    // Simulated crash: a new process over the same storage, the old runner never settles.
    const second = await boot(dir, ['x'], { rootSessionId: first.rootSessionId })
    await second.executor.recoverFromStorage()
    const [listed] = (await second.executor.childrenOfRoot(second.rootSessionId, second.workspaceId))
      .filter((child) => child.childSessionId === spawned.childSessionId)
    expect(listed?.status).toBe('interrupted')
    expect(listed?.result).toBeUndefined()
    await first.executor.cancel(first.workspaceId, spawned.childSessionId as never)
  })
})

describe('refusals', () => {
  it('a child of another root is not found', async () => {
    const harness = await boot(home, ['Done.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await settle(harness, spawned.childSessionId)
    const other = harness.kernel.ctx.sessions.create(harness.workspaceId)
    await expect(harness.executor.message(harness.workspaceId, other.id as never, 'turn-9', spawned.childSessionId as never, 'Hi.', 'queue'))
      .rejects.toThrow(/no such child/)
  })

  it('a legacy child without a pinned snapshot cannot be resumed', async () => {
    const harness = await boot(home, ['Done.'])
    const spawned = await harness.executor.spawn(spawnRequest(harness))
    await settle(harness, spawned.childSessionId)
    // Strip the snapshot the way an old log would look.
    const child = await harness.kernel.ctx.sessions.load(spawned.childSessionId)
    const meta = child.events.find((event) => event.type === 'session/child-meta') as { toolCeiling?: unknown } | undefined
    if (meta !== undefined) delete meta.toolCeiling
    await expect(harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', spawned.childSessionId as never, 'More.', 'queue'))
      .rejects.toThrow(/cannot be resumed/)
  })
})
