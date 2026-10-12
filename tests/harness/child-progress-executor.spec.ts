/**
 * A running child's handle carries progress (elapsed, counts, last activity,
 * advisory health) so the parent can tell a slow child from a stuck one; a
 * settled handle never does.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentsService, ChildExecutor, Kernel, LlmService, ToolsService, WorkspaceService, bundledDefinition, fileSessions } from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

let home = ''
beforeAll(async () => { home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-child-progress-')) })
afterAll(async () => { await fs.rm(home, { recursive: true, force: true }) })

async function boot() {
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const ws = new WorkspaceService(home)
  await ws.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm([{ toolCalls: [{ name: 'Read', args: {} }] }]))
  // Read blocks until aborted: the child stays running inside the tool.
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
  return { kernel, executor: new ChildExecutor(kernel.ctx), workspaceId: ws.defaultWorkspace as never, rootSessionId: root.id as never }
}

describe('running child handles carry progress', () => {
  it('reports the open tool while running and drops progress once settled', async () => {
    const h = await boot()
    const worker = bundledDefinition('worker')
    const spawned = await h.executor.spawn({
      workspaceId: h.workspaceId, parentSessionId: h.rootSessionId, parentTurnId: 'turn-1',
      definition: worker, exposureCeiling: worker.tools,
      packet: { prompt: 'Inspect the repository.', requiredResult: 'a short answer' },
    })
    let [running] = await h.executor.wait(h.workspaceId, [spawned.childSessionId], { timeoutMs: 50 })
    for (let i = 0; i < 80 && running?.progress?.lastActivity.kind !== 'tool'; i++) {
      ;[running] = await h.executor.wait(h.workspaceId, [spawned.childSessionId], { timeoutMs: 25 })
    }
    expect(running?.status).toBe('running')
    expect(running?.progress).toMatchObject({ toolCalls: 1, lastActivity: { kind: 'tool', name: 'Read' }, health: 'active' })
    expect(running?.progress?.elapsedMs).toBeGreaterThanOrEqual(0)

    const cancelled = await h.executor.cancel(h.workspaceId, spawned.childSessionId)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.progress).toBeUndefined()
    await h.kernel.stop()
  }, 15_000)

  it('a long wait returns early when a child starts waiting on an approval', async () => {
    const h = await boot()
    const worker = bundledDefinition('worker')
    const spawned = await h.executor.spawn({
      workspaceId: h.workspaceId, parentSessionId: h.rootSessionId, parentTurnId: 'turn-1',
      definition: worker, exposureCeiling: worker.tools,
      packet: { prompt: 'Inspect the repository.', requiredResult: 'a short answer' },
    })
    const started = Date.now()
    const waiting = h.executor.wait(h.workspaceId, [spawned.childSessionId], { timeoutMs: 10_000 })
    await new Promise((resolve) => setTimeout(resolve, 100))
    // Approvals expire in minutes; a 30 min wait must not sit on one.
    h.kernel.ctx.sessions.get(spawned.childSessionId as never).append({ type: 'approval/request', approvalId: 'a1', call: { id: 'c1', name: 'Bash', args: {} } } as never)
    const [handle] = await waiting
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(handle?.status).toBe('running')
    expect(handle?.progress?.health).toBe('awaiting-approval')
    await h.executor.cancel(h.workspaceId, spawned.childSessionId)
    await h.kernel.stop()
  }, 15_000)
})
