/**
 * Background children: they outlive the turn that spawned them, report back
 * through the host's notification hook exactly once, and a report that could
 * not be delivered (Stop, a full queue, a wait already watching) stays owed to
 * the root's next join or wait instead of being lost or doubled.
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
  parseAgentDefinition,
  type ChildHandle,
  type SpawnRequest,
} from 'dnt-harness'
import { FakeScriptedLlm, type ScriptStep } from '../support/fake-llm.ts'

let home = ''
const kernels: Kernel[] = []
beforeAll(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-background-')) })
afterAll(async () => {
  await Promise.all(kernels.map((kernel) => kernel.stop().catch(() => {})))
  await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function boot(script: readonly ScriptStep[], options: { readonly slowMs?: number; readonly deliver?: boolean; readonly dir?: string; readonly rootSessionId?: string } = {}) {
  const dir = options.dir ?? home
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dir))
  const ws = new WorkspaceService(dir)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm(script))
  kernel.ctx.tools.register({
    name: 'Read',
    description: 'fake Read',
    requiresRoot: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, exec) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.slowMs ?? 0)
        exec.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      return 'Read ok'
    },
  })
  const rootSessionId = options.rootSessionId ?? kernel.ctx.sessions.create(ws.defaultWorkspace).id
  kernels.push(kernel)
  const notified: ChildHandle[] = []
  const executor = new ChildExecutor(kernel.ctx, undefined, async (_root, handle) => {
    notified.push(handle)
    return options.deliver ?? true
  })
  return { kernel, executor, notified, workspaceId: ws.defaultWorkspace as never, rootSessionId: rootSessionId as never }
}

type Harness = Awaited<ReturnType<typeof boot>>

function spawnRequest(harness: Harness, background: boolean, turn = 'turn-1'): SpawnRequest {
  return {
    workspaceId: harness.workspaceId,
    parentSessionId: harness.rootSessionId,
    parentTurnId: turn,
    definition: bundledDefinition('worker'),
    exposureCeiling: ['Read'],
    packet: { prompt: 'Do the work.', requiredResult: 'a short answer' },
    background,
  }
}

const read: ScriptStep = { content: 'Reading.', toolCalls: [{ name: 'Read', args: { path: 'a.ts' } }] }
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('background children', () => {
  it('survive the spawning turn and are not owed to its join', async () => {
    const harness = await boot([read, 'Background done.'], { slowMs: 300 })
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-1')).toEqual([])
    await harness.executor.closeTurn(harness.rootSessionId, 'turn-1')
    expect(await harness.executor.resolveForRootCompletion(harness.rootSessionId, 'turn-1')).toBe(0)
    await until(() => harness.notified.length > 0)
    expect(harness.notified[0]).toMatchObject({ childSessionId: handle.childSessionId, status: 'completed', result: { report: 'Background done.' } })
  })

  it('a foreground child of the same turn is still cancelled at completion', async () => {
    const harness = await boot([read, 'Never.'], { slowMs: 2_000 })
    await harness.executor.spawn(spawnRequest(harness, false))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await harness.executor.closeTurn(harness.rootSessionId, 'turn-1')
    expect(await harness.executor.resolveForRootCompletion(harness.rootSessionId, 'turn-1')).toBe(1)
    expect(harness.notified).toEqual([])
  })

  it('notifies once, and a report already delivered is not owed again', async () => {
    const harness = await boot(['Quick.'])
    await harness.executor.spawn(spawnRequest(harness, true))
    await until(() => harness.notified.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.notified).toHaveLength(1)
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([])
  })

  it('a wait watching the child delivers the report itself: no notification', async () => {
    const harness = await boot([read, 'Waited for.'], { slowMs: 200 })
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    const [settled] = await harness.executor.wait(harness.workspaceId, [handle.childSessionId], { timeoutMs: 5_000 })
    expect(settled?.result?.report).toBe('Waited for.')
    harness.executor.markReported([handle.childSessionId])
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.notified).toEqual([])
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([])
  })

  it('root Stop cancels it without a notification; its report is owed to the next turn', async () => {
    const harness = await boot([read, 'Never.'], { slowMs: 2_000 })
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await harness.executor.cancelAllOfRoot(harness.rootSessionId)).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(harness.notified).toEqual([])
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([handle.childSessionId])
    const joined = await harness.executor.joinTurnChildren(harness.workspaceId, harness.rootSessionId, 'turn-2', { timeoutMs: 100 })
    expect(joined.map((child) => child.status)).toEqual(['cancelled'])
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-3')).toEqual([])
  })

  it('a join while delivery is in flight does not hand the report over twice', async () => {
    let release: (delivered: boolean) => void = () => {}
    const harness = await boot(['Racing.'])
    ;(harness.executor as unknown as { onBackgroundSettled: (root: unknown, handle: ChildHandle) => Promise<boolean> }).onBackgroundSettled = async (_root, handle) => {
      harness.notified.push(handle)
      return new Promise<boolean>((resolve) => { release = resolve })
    }
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    await until(() => harness.notified.length > 0)
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([])
    release(false)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Not delivered after all: owed again.
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([handle.childSessionId])
  })

  it('a role marked background runs in the background without the spawn saying so', async () => {
    const harness = await boot([read, 'Role background.'], { slowMs: 200 })
    const request = spawnRequest(harness, false)
    const { background: _omit, ...withoutFlag } = request
    await harness.executor.spawn({ ...withoutFlag, definition: { ...bundledDefinition('worker'), background: true } })
    expect(await harness.executor.resolveForRootCompletion(harness.rootSessionId, 'turn-1')).toBe(0)
    await until(() => harness.notified.length > 0)
    expect(harness.notified[0]?.result?.report).toBe('Role background.')
  })

  it('an undeliverable report stays owed to the next join', async () => {
    const harness = await boot(['Nobody heard.'], { deliver: false })
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    await until(() => harness.notified.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([handle.childSessionId])
  })

  it('after a restart an undelivered report is owed again; a delivered one is not', async () => {
    const dir = await fs.mkdtemp(path.join(home, 'restart-'))
    const first = await boot(['Lost in the crash.'], { dir, deliver: false })
    const lost = await first.executor.spawn(spawnRequest(first, true))
    await until(() => first.notified.length === 1)
    // A second child whose report the host did queue, the way queueHostInput records it.
    const delivered = await first.executor.spawn(spawnRequest(first, true))
    await until(() => first.notified.length === 2)
    const root = await first.kernel.ctx.sessions.load(first.rootSessionId)
    root.append({ type: 'input/queued', inputId: 'in-1', content: 'report', origin: 'child', childSessionId: delivered.childSessionId })
    await root.durable()
    await first.kernel.stop()

    const second = await boot(['x'], { dir, rootSessionId: first.rootSessionId })
    await second.executor.recoverFromStorage()
    expect(second.executor.owedChildrenOfTurn(second.rootSessionId, 'turn-9')).toEqual([lost.childSessionId])
    const joined = await second.executor.joinTurnChildren(second.workspaceId, second.rootSessionId, 'turn-9', { timeoutMs: 100 })
    expect(joined.map((child) => child.result?.report)).toEqual(['Lost in the crash.'])
    expect(second.executor.owedChildrenOfTurn(second.rootSessionId, 'turn-10')).toEqual([])
    // The report the host had queued is already the root's: not offered again.
    expect(joined.every((child) => child.childSessionId !== delivered.childSessionId)).toBe(true)
  })

  it('stays background when resumed', async () => {
    const harness = await boot(['First.', 'Second.'])
    const handle = await harness.executor.spawn(spawnRequest(harness, true))
    await until(() => harness.notified.length === 1)
    await harness.executor.message(harness.workspaceId, harness.rootSessionId, 'turn-2', handle.childSessionId as never, 'Again.', 'queue')
    expect(harness.executor.owedChildrenOfTurn(harness.rootSessionId, 'turn-2')).toEqual([])
    await until(() => harness.notified.length === 2)
    expect(harness.notified[1]?.result?.report).toBe('Second.')
  })
})

describe('background frontmatter', () => {
  it('is enforced instead of reported as unsupported', () => {
    const definition = parseAgentDefinition('bg', '---\ndescription: d\nbackground: true\n---\nDo things.')
    expect(definition.background).toBe(true)
    expect(definition.unsupported ?? []).not.toContain('background')
  })

  it('must be a boolean', () => {
    expect(() => parseAgentDefinition('bg', '---\ndescription: d\nbackground: soon\n---\nDo things.')).toThrow(/background/)
  })
})
