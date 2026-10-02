import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentDefinitionService,
  AgentsService,
  ChildExecutor,
  Kernel,
  LlmService,
  ToolsService,
  WorkspaceService,
  bundledDefinition,
  fileSessions,
} from 'dnt-harness'
import { agentScope } from '../../src/harness/agent/scope.ts'
import { agentTool, type DelegationDeps } from '../../src/web/agent-delegation.ts'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

interface Harness {
  readonly kernel: Kernel
  readonly executor: ChildExecutor
  readonly definitions: AgentDefinitionService
  readonly workspaceId: string
  readonly callerRootId: string
  readonly siblingRootId: string
}

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

async function boot(): Promise<Harness> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-agent-tool-ownership-'))
  homes.push(home)
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  const workspaces = new WorkspaceService(home)
  await workspaces.boot()
  await kernel.ctx.sessions.boot()
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(new FakeScriptedLlm([{ toolCalls: [{ name: 'Read', args: { path: 'blocked.ts' } }] }]))
  kernel.ctx.tools.register({
    name: 'Read',
    description: 'Blocks until cancelled.',
    requiresRoot: false,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, execution) {
      await new Promise<void>((resolve) => {
        if (execution.signal?.aborted === true) resolve()
        else execution.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return 'cancelled'
    },
  })
  const caller = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  const sibling = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  return {
    kernel,
    executor: new ChildExecutor(kernel.ctx),
    definitions: new AgentDefinitionService(home),
    workspaceId: workspaces.defaultWorkspace as unknown as string,
    callerRootId: caller.id as unknown as string,
    siblingRootId: sibling.id as unknown as string,
  }
}

function toolFor(harness: Harness) {
  const deps: DelegationDeps = {
    definitions: harness.definitions,
    executor: harness.executor,
    session: async (id) => harness.kernel.ctx.sessions.has(id) ? harness.kernel.ctx.sessions.load(id) : undefined,
    childModelFor: () => undefined,
    providers: () => [],
    modelsOf: () => [],
  }
  return agentTool(deps)
}

async function executeAsCaller(harness: Harness, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await agentScope.run(
    { sessionId: harness.callerRootId as never, workspaceId: harness.workspaceId as never },
    () => toolFor(harness).execute(args, {} as never),
  )
  return JSON.parse(String(result)) as Record<string, unknown>
}

describe('Agent tool child ownership', () => {
  it('does not wait for or cancel a sibling root child, while direct workspace executor access remains available to HTTP', async () => {
    const harness = await boot()
    try {
      const siblingChild = await harness.executor.spawn({
        workspaceId: harness.workspaceId as never,
        parentSessionId: harness.siblingRootId as never,
        parentTurnId: 'sibling-turn',
        definition: bundledDefinition('explorer'),
        packet: { prompt: 'Read the blocked file.', requiredResult: 'status' },
      })

      const waited = await executeAsCaller(harness, { action: 'wait', childIds: [siblingChild.childSessionId], timeoutMs: 1 })
      expect(waited).toMatchObject({ children: [] })

      const cancelled = await executeAsCaller(harness, { action: 'cancel', childIds: [siblingChild.childSessionId] })
      expect(cancelled).toEqual({ children: [] })

      const [stillRunning] = await harness.executor.wait(
        harness.workspaceId as never,
        [siblingChild.childSessionId],
        { timeoutMs: 1 },
      )
      expect(stillRunning?.status).toBe('running')
    } finally {
      await harness.executor.cancelAllOfRoot(harness.siblingRootId as never)
      await harness.kernel.stop()
    }
  }, 15_000)

  it('lists only the caller root children and does not reconcile a sibling root child', async () => {
    const harness = await boot()
    try {
      const packet = { prompt: 'Read the blocked file.', requiredResult: 'status' }
      const ownChild = await harness.executor.spawn({
        workspaceId: harness.workspaceId as never,
        parentSessionId: harness.callerRootId as never,
        parentTurnId: 'caller-turn',
        definition: bundledDefinition('explorer'),
        packet,
      })
      const siblingChild = await harness.executor.spawn({
        workspaceId: harness.workspaceId as never,
        parentSessionId: harness.siblingRootId as never,
        parentTurnId: 'sibling-turn',
        definition: bundledDefinition('explorer'),
        packet,
      })

      const listed = (await executeAsCaller(harness, { action: 'list' })) as { children: Array<{ childSessionId: string }> }
      expect(listed.children.map((child) => child.childSessionId)).toEqual([ownChild.childSessionId])

      const reconciled = await executeAsCaller(harness, { action: 'reconcile', childIds: [siblingChild.childSessionId] })
      expect(reconciled).toEqual({ children: [] })
    } finally {
      await harness.executor.cancelAllOfRoot(harness.callerRootId as never)
      await harness.executor.cancelAllOfRoot(harness.siblingRootId as never)
      await harness.kernel.stop()
    }
  }, 15_000)
})
