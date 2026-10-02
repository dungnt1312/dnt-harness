import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readApiKey } from '../src/bins/env.ts'
import {
  AgentsService,
  AgentDefinitionService,
  ChildExecutor,
  DeepSeekProvider,
  Kernel,
  LlmService,
  ToolsService,
  WorkspaceService,
  attachApproval,
  fileSessions,
  fsTools,
  type SessionEvent,
} from '../src/index.ts'

loadRepoEnv()

const interesting = new Set(['tool/call', 'tool/result', 'assistant/message', 'turn/end', 'turn/error'])

async function main(): Promise<void> {
  const apiKey = readApiKey()
  if (apiKey === undefined) throw new Error('missing DEEPSEEK_API_KEY')

  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-explore-'))
  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(home))
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  const workspaces = new WorkspaceService(home)
  await workspaces.boot()
  await kernel.ctx.sessions.boot()
  attachApproval(kernel.ctx, { defaultMode: 'allow', askUser: async () => false })
  for (const tool of fsTools()) kernel.ctx.tools.register(tool)
  kernel.ctx.tools.setRootResolver(() => ({ root: process.cwd(), deniedRoots: [home] }))
  kernel.ctx.llm.register(new DeepSeekProvider(apiKey))

  const root = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  const executor = new ChildExecutor(kernel.ctx)
  const explorer = (await new AgentDefinitionService(home).resolve(workspaces.defaultWorkspace, 'explorer')).definition

  kernel.ctx.on('session/event', (_emitter, event: SessionEvent) => {
    if (!interesting.has(event.type)) return
    if (event.type === 'tool/call') {
      process.stdout.write(`[tool] ${event.call.name} ${JSON.stringify(event.call.args).slice(0, 200)}\n`)
    } else if (event.type === 'tool/result') {
      process.stdout.write(`[${event.ok ? 'ok' : 'fail'}] ${event.output.slice(0, 180).replaceAll('\n', ' ')}\n`)
    } else if (event.type === 'assistant/message') {
      process.stdout.write(`\n----- child summary -----\n${event.content}\n`)
    } else if (event.type === 'turn/error') {
      process.stdout.write(`[turn ${event.kind}] ${event.message}\n`)
    } else if (event.type === 'turn/end') {
      process.stdout.write(`[turn/end] ${event.reason}\n`)
    }
  })

  const handle = await executor.spawn({
    workspaceId: workspaces.defaultWorkspace,
    parentSessionId: root.id,
    parentTurnId: 'explore-1',
    definition: explorer,
    model: { provider: 'deepseek', model: 'deepseek-chat' },
    packet: {
      objective:
        'Survey how multi-agent works in this repository. Read src/harness/agents, src/web/agent-delegation.ts, and the Delegation section of docs/harness.md. Report the bundled roles, spawn limits, the one-level rule, and how the Agent tool is driven.',
      constraints: ['read only', 'do not invent APIs', 'cite file paths'],
      references: ['src/harness/agents', 'src/web/agent-delegation.ts', 'docs/harness.md'],
      requiredResult: 'A short Vietnamese summary under 250 words with file paths.',
    },
  })
  process.stdout.write(`spawned ${handle.childSessionId} as ${handle.definitionName}\n`)
  const settled = (await executor.wait(workspaces.defaultWorkspace, [handle.childSessionId], { timeoutMs: 120000 }))[0]
  process.stdout.write(`\nsettled status=${settled?.status} error=${settled?.error ?? ''}\n`)
  await kernel.stop()
  await fs.rm(home, { recursive: true, force: true })
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
})
