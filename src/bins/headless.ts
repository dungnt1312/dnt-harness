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
  const options: ApprovalOptions = yolo
    ? { defaultMode: 'allow', askUser }
    : {
        defaultMode: 'ask',
        askUser,
        policy: { Read: 'allow', Glob: 'allow', Grep: 'allow', Write: 'ask', Edit: 'ask', Bash: 'ask' },
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
  kernel.ctx.tools.setRootResolver(() => ({ root, deniedRoots: [dataDir] }))
  if (apiKey !== undefined) {
    kernel.ctx.llm.register(new DeepSeekProvider(apiKey, process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'))
  } else {
    process.stderr.write('no DEEPSEEK_API_KEY; model calls fail until a provider is registered.\n')
  }

  const session: Session = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  kernel.ctx.on('session/event', (emitter, event) => {
    if (emitter === session) render(event)
  })

  const agent = kernel.ctx.agents.create(session, { workspaceId: workspaces.defaultWorkspace })

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
