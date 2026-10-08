/**
 * The one-shot/REPL headless runner: composes the harness plugins on the
 * kernel — durable sessions, llm, tools, approval — mounts the filesystem
 * and bash capability tools, binds one agent to one durable session, and
 * streams replies and tool traffic to stdout.
 *
 * History persists under `--data-dir` (default `<cwd>/.dnt-harness/data`),
 * so a later run with the same data dir can resume where this one left
 * off. A `DEEPSEEK_API_KEY` registers the DeepSeek provider; without one
 * the REPL still starts and a model call fails when no provider is
 * registered. Approval: `--yolo` allows every call; otherwise reads/globs
 * are allowed and write/edit/bash prompt on stderr before running.
 * Approval questions and decisions are recorded in the session log like
 * any other durable fact.
 *
 * Usage:
 *   tsx src/bins/headless.ts --message "hello"
 *   tsx src/bins/headless.ts            # interactive REPL, 'exit' quits
 */
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { loadRepoEnv, readApiKey, resolveAppHome } from './env.ts'
import {
  AgentsService,
  DeepSeekProvider,
  Kernel,
  LlmService,
  ToolsService,
  attachApproval,
  bashTool,
  bashOutputTool,
  killShellTool,
  fileSessions,
  fsTools,
  newInputId,
  WorkspaceService,
  type ApprovalOptions,
  type Agent,
  type Session,
  type SessionEvent,
  type SessionsService,
  DataHomeLock,
  OwnershipError,
} from '../index.ts'
import { DEFAULT_LIMITS } from '../harness/limits.ts'
import { createProcessSessionEventBridge } from '../harness/processes/session-event-bridge.ts'
import { runCleanup, boundedCleanup } from '../harness/processes/shutdown.ts'
import { ProcessRegistry } from '../harness/processes/registry.ts'
import { todoWriteTool } from '../harness/tools/todo.ts'
import { promises as fs } from 'node:fs'
import { MemoryService } from '../harness/memory/service.ts'
import { memoryRoots, memoryGuidance, memoryGuidanceAccess, memoryIndexes } from '../harness/memory/context.ts'
import { ModesService, DEFAULT_MODE_ID } from '../harness/modes/service.ts'
import { buildContext } from '../harness/context/builder.ts'
import { renderEnvironmentContext } from '../harness/context/environment.ts'
import { DEFAULT_BUDGET } from '../harness/context/budget.ts'
import { resolvePermission } from '../harness/approval/resolution.ts'
import { attachDangerousCommandGuard } from '../harness/guard/guard.ts'
import { DangerousCommandsStore } from '../harness/guard/store.ts'
import { defaultSecretRoots } from '../capabilities/fs/secret-roots.ts'
import { homedir } from 'node:os'

loadRepoEnv()

interface CliOptions {
  readonly yolo: boolean
  readonly root: string
  readonly dataDir: string
  readonly message: string | undefined
}

function parseArgs(argv: readonly string[]): CliOptions {
  let yolo = false
  let root = process.cwd()
  let dataDir = path.join(resolveAppHome(process.cwd()), 'data')
  let message: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yolo') yolo = true
    else if (arg === '--root') root = argv[i + 1] ?? root
    else if (arg === '--data-dir') dataDir = argv[i + 1] ?? dataDir
    else if (arg === '--message') message = argv[i + 1]
  }
  return { yolo, root, dataDir, message }
}

/** Render one session's durable stream to stdout as events arrive. */
function render(event: SessionEvent): void {
  switch (event.type) {
    case 'model/attempt':
      break
    case 'execution/uncertain':
      process.stdout.write(`[provider ownership unresolved] attempt ${event.fact.attempt}; replacement execution fenced\n`)
      break
    case 'execution/reconciled':
      process.stdout.write(`[provider locally settled] attempt ${event.fact.attempt}; ownership released\n`)
      break
    case 'assistant/chunk':
      process.stdout.write(event.delta)
      break
    case 'assistant/message':
      process.stdout.write('\n')
      break
    case 'tool/call':
      process.stdout.write(`\n[tool] ${event.call.name}(${JSON.stringify(event.call.args)})\n`)
      break
    case 'tool/result': {
      if (event.recovery === true) {
        process.stdout.write(`[tool?] ${event.output}\n`)
        break
      }
      const output = event.output.length > 400 ? `${event.output.slice(0, 400)}\n… [truncated]` : event.output
      process.stdout.write(`[${event.ok ? 'tool→' : 'tool✗'}] ${output}\n`)
      break
    }
    case 'step/abandoned':
      process.stdout.write(`\n[attempt discarded, retrying] ${event.reason}\n`)
      break
    case 'turn/error':
      process.stdout.write(`[turn ${event.kind}] ${event.message}\n`)
      break
    case 'turn/end':
      if (event.reason === 'rejected') process.stdout.write('[turn rejected]\n')
      if (event.reason === 'empty') process.stdout.write('[turn closed empty]\n')
      if (event.reason === 'interrupted') process.stdout.write('[turn interrupted by restart]\n')
      if (event.reason === 'limit') process.stdout.write('[turn hit a limit]\n')
      break
    default:
      break
  }
}

/** Prompt on stderr for approval of one tool call. */
async function askUser(call: { name: string; args: Record<string, unknown> }): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(`allow '${call.name}'(${JSON.stringify(call.args)})? [y/N] `)
    return answer.trim().toLowerCase().startsWith('y')
  } finally {
    rl.close()
  }
}

async function main(): Promise<void> {
  const { yolo, root, dataDir, message } = parseArgs(process.argv.slice(2))
  const apiKey = readApiKey()
  // One writer per data home: a web host (or another CLI) on the same
  // directory would append independent sequence numbers to shared logs.
  let ownerLock: DataHomeLock
  try {
    ownerLock = await DataHomeLock.acquire(dataDir)
  } catch (error) {
    if (error instanceof OwnershipError) {
      process.stderr.write(`dnt-harness: ${error.message}; another dnt-harness process owns '${dataDir}'. Stop it or pass --data-dir.\n`)
      process.exitCode = 1
      return
    }
    throw error
  }

  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(dataDir))
  kernel.ctx.provide('limits', DEFAULT_LIMITS)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  // One data home, workspace-scoped sessions: the CLI works inside the
  // home's Default workspace (stable id, idempotently migrated).
  const workspaces = new WorkspaceService(dataDir)
  await workspaces.boot()
  kernel.ctx.provide('workspaces', workspaces)
  await kernel.ctx.sessions.boot()
  const workspaceId = workspaces.defaultWorkspace
  const canonicalRoot = await fs.realpath(path.resolve(root))
  const project = workspaces.listProjects(workspaceId).find((record) => record.path === canonicalRoot)
    ?? await workspaces.createProject(workspaceId, path.basename(canonicalRoot), canonicalRoot)
  const scope = { workspaceId, projectId: project.id }
  const memory = new MemoryService(dataDir)
  const modes = new ModesService(dataDir)
  const mode = await modes.resolve(workspaceId, await modes.selectedId(workspaceId) ?? DEFAULT_MODE_ID)
  const memoryEnabled = mode.definition.sources.memoryPinned && mode.definition.sources.memoryRetrieval
  const roots = memoryEnabled ? memoryRoots(memory, scope) : []
  const memoryAccess = mode.definition.toolExposure.includes('Write') || mode.definition.toolExposure.includes('Edit') ? 'write' as const : 'read' as const
  kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    if (!mode.definition.toolExposure.includes(payload.call.name)) return { kind: 'deny', reason: `tool '${payload.call.name}' is not exposed by the selected mode` }
    if (resolvePermission(mode.definition.permissionDefaults, payload.call.name) === 'deny') return { kind: 'deny', reason: `tool '${payload.call.name}' is denied by the selected mode` }
    return next()
  }, true)
  // Dangerous Commands: the same workspace config the web host edits (same
  // data home). Registered AFTER the exposure gate with prepend, so it runs
  // first: a `deny` rule refuses the Bash call outright; an `ask` rule forces
  // an approval even when the mode (or --yolo) allows Bash — the same
  // contract as the web host, where yolo never answers a guard question.
  const dangerousStore = new DangerousCommandsStore(dataDir)
  const dangerousGuard = attachDangerousCommandGuard(kernel.ctx, {
    configSource: async (requested?: string) => {
      const { config, hash } = await dangerousStore.load(requested ?? workspaceId)
      return { config, hash, revision: hash }
    },
  })
  const options: ApprovalOptions = {
    defaultMode: yolo ? 'allow' : 'ask', askUser,
    forceAsk: (call, approvalScope) => dangerousGuard.getMatch(call, approvalScope.executionId)?.action === 'ask',
    policy: Object.fromEntries(Object.entries(mode.definition.permissionDefaults).map(([name, permission]) => [name, yolo && permission !== 'deny' ? 'allow' : permission])),
  }
  attachApproval(kernel.ctx, options)
  for (const tool of fsTools()) {
    kernel.ctx.tools.register(tool)
  }
  const processEvents = createProcessSessionEventBridge(kernel.ctx.sessions)
  const processes = new ProcessRegistry(processEvents)
  kernel.ctx.provide('processes', processes)
  kernel.ctx.provide('process-events', processEvents)
  kernel.ctx.tools.register(bashTool({ timeoutMs: DEFAULT_LIMITS.toolTimeoutMs, processes }))
  kernel.ctx.tools.register(bashOutputTool({ processes }))
  kernel.ctx.tools.register(killShellTool({ processes }))
  kernel.ctx.tools.register(todoWriteTool())
  kernel.ctx.tools.setRootResolver(() => ({ root: canonicalRoot, deniedRoots: [path.resolve(dataDir), ...defaultSecretRoots(homedir())], hostStorageRoot: path.resolve(dataDir), memoryRoots: roots, additionalRoots: roots.map((folder) => ({ path: folder, access: memoryAccess })) }))
  if (apiKey !== undefined) {
    kernel.ctx.llm.register(new DeepSeekProvider(apiKey, process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'))
  } else {
    process.stderr.write('no DEEPSEEK_API_KEY; model calls fail until a provider is registered.\n')
  }

  const session: Session = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  session.append({ type: 'session/project', projectId: project.id })
  await session.durable()
  kernel.ctx.on('session/event', (emitter, event) => {
    if (emitter === session) render(event)
  })

  const agent = kernel.ctx.agents.create(session, scope)
  kernel.ctx.on('agent/context', async (projected, next) => {
    const schemas = kernel.ctx.tools.schemas().filter((schema) => mode.definition.toolExposure.includes(schema.name))
    const pinnedMemory = memoryEnabled ? await memoryIndexes(memory, scope) : []
    const guidanceAccess = memoryGuidanceAccess(schemas.map((schema) => schema.name))
    if (roots.length > 0 && guidanceAccess !== undefined) pinnedMemory.unshift(memoryGuidance(roots, guidanceAccess))
    const environment = renderEnvironmentContext({
      now: new Date(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      workspacePath: canonicalRoot,
    })
    const assembled = buildContext({
      events: session.events, mode, modeRevision: 0,
      model: projected.model, providerName: projected.providerName,
      schemas, activeSkills: [], pinnedMemory, budget: DEFAULT_BUDGET,
      ...(environment !== undefined ? { environment } : {}),
      ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
      fileScope: { primary: canonicalRoot, additional: roots.map((folder) => ({ path: folder, access: memoryAccess })), outsideAsks: !yolo },
    })
    return next({ ...projected, messages: assembled.messages, tools: schemas })
  }, true)

  /** Durably accept one input, adopt anything still pending, then run. */
  const acceptAndRun = async (text: string): Promise<void> => {
    const inputId = newInputId()
    session.append({ type: 'input/queued', inputId, content: text })
    await session.durable()
    const sessions: SessionsService = kernel.ctx.sessions
    for (const item of sessions.pendingInputs(session)) {
      agent.enqueueAccepted(item)
    }
    await (agent as Agent).run()
  }

  try {
    if (message !== undefined) {
      await acceptAndRun(message)
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      while (true) {
        const line = await rl.question('> ')
        const text = line.trim()
        if (text === 'exit' || text === 'quit') break
        if (text === '') continue
        await acceptAndRun(text)
      }
      rl.close()
    }
  } finally {
    processes.closeAdmission()
    const agentDrivers = kernel.ctx.agents
    let teardownSafe = true
    await runCleanup([
      () => agentDrivers.stopAll(),
      () => processes.disposeAll(),
      async () => { try { await boundedCleanup(() => processEvents.flushAll()) } catch (error) { teardownSafe = false; throw error } },
      async () => { try { await boundedCleanup(() => kernel.stop()) } catch (error) { teardownSafe = false; throw error } },
      () => { if (!teardownSafe || !agentDrivers.persistenceSafe) throw new Error('ownership retained: canonical writers unresolved'); return ownerLock.release() },
    ])
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`dnt-harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
