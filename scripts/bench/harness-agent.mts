/**
 * dnt-harness benchmark runner.
 *
 * Boots the same composition headless.ts uses (kernel + sessions/llm/tools/
 * agents/workspaces/modes/memory, fs + bash + todo tools, mode exposure gate,
 * allow-all approval) but takes the provider/model/mode from the environment
 * and writes a metrics JSON instead of rendering to stdout.
 *
 * Env:
 *   BENCH_BASE_URL   OpenAI-compatible base URL (POSTs `${base}/chat/completions`)
 *   BENCH_API_KEY    bearer token (any string; the local proxy ignores it)
 *   BENCH_MODEL      model id sent to the provider
 *   BENCH_PROVIDER   provider registry name (default 'bench')
 *   BENCH_MODE       bundled mode id (default 'autonomous')
 *   BENCH_TIMEOUT_MS wall-clock cap for the whole turn (default 240000)
 *
 * Args: --root DIR --data-dir DIR --message TEXT --metrics FILE [--events FILE]
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  AgentsService,
  Kernel,
  LlmService,
  ToolsService,
  WorkspaceService,
  attachApproval,
  bashTool,
  bashOutputTool,
  killShellTool,
  fileSessions,
  fsTools,
  newInputId,
  OpenAiCompletionsProvider,
  ModesService,
  MemoryService,
  DEFAULT_MODE_ID,
  type Agent,
  type Session,
  type SessionEvent,
} from '../../src/index.ts'
import { DEFAULT_LIMITS } from '../../src/harness/limits.ts'
import { createProcessSessionEventBridge } from '../../src/harness/processes/session-event-bridge.ts'
import { ProcessRegistry } from '../../src/harness/processes/registry.ts'
import { todoWriteTool } from '../../src/harness/tools/todo.ts'
import { memoryRoots, memoryGuidance, memoryGuidanceAccess, memoryIndexes } from '../../src/harness/memory/context.ts'
import { buildContext } from '../../src/harness/context/builder.ts'
import { latestCalibration } from '../../src/harness/context/calibration.ts'
import { renderEnvironmentContext } from '../../src/harness/context/environment.ts'
import { resolveModelBudget } from '../../src/harness/context/budget.ts'
import { agentScope } from '../../src/harness/agent/scope.ts'
import { defaultSecretRoots } from '../../src/capabilities/fs/secret-roots.ts'

interface Args {
  root: string
  dataDir: string
  message: string
  metrics: string
  events: string | undefined
}

function parseArgs(argv: readonly string[]): Args {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key?.startsWith('--')) out[key.slice(2)] = argv[i + 1] ?? ''
  }
  if (out['root'] === undefined || out['data-dir'] === undefined || out['message'] === undefined || out['metrics'] === undefined) {
    throw new Error('usage: --root DIR --data-dir DIR --message TEXT --metrics FILE [--events FILE]')
  }
  return { root: out['root'], dataDir: out['data-dir'], message: out['message'], metrics: out['metrics'], events: out['events'] }
}

const env = (name: string, fallback?: string): string => process.env[name] ?? fallback ?? ''

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const model = env('BENCH_MODEL', 'deepseek-v4.1-flash-free')
  const providerName = env('BENCH_PROVIDER', 'bench')
  const modeId = env('BENCH_MODE', 'autonomous')
  const timeoutMs = Number(env('BENCH_TIMEOUT_MS', '240000'))
  const started = Date.now()

  const kernel = new Kernel()
  kernel.ctx.plugin(fileSessions(args.dataDir))
  kernel.ctx.provide('limits', DEFAULT_LIMITS)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)

  const workspaces = new WorkspaceService(args.dataDir)
  await workspaces.boot()
  kernel.ctx.provide('workspaces', workspaces)
  await kernel.ctx.sessions.boot()
  const workspaceId = workspaces.defaultWorkspace
  const canonicalRoot = await fs.realpath(path.resolve(args.root))
  const project = workspaces.listProjects(workspaceId).find((record) => record.path === canonicalRoot)
    ?? await workspaces.createProject(workspaceId, path.basename(canonicalRoot), canonicalRoot)
  const scope = { workspaceId, projectId: project.id }

  const memory = new MemoryService(args.dataDir)
  const modes = new ModesService(args.dataDir)
  const resolvedModeId = (await modes.selectedId(workspaceId)) ?? DEFAULT_MODE_ID
  const mode = await modes.resolve(workspaceId, modeId === 'selected' ? resolvedModeId : modeId)
  const memoryEnabled = mode.definition.sources.memoryPinned && mode.definition.sources.memoryRetrieval
  const roots = memoryEnabled ? memoryRoots(memory, scope) : []
  const memoryAccess = mode.definition.toolExposure.some((name) => ['Write', 'Edit', 'ApplyPatch'].includes(name)) ? 'write' as const : 'read' as const

  // Mode exposure gate (prepend = runs first).
  kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    if (!mode.definition.toolExposure.includes(payload.call.name)) return { kind: 'deny', reason: `tool '${payload.call.name}' is not exposed by the selected mode` }
    return next()
  }, true)

  // Non-interactive approval: everything the mode exposes is allowed.
  attachApproval(kernel.ctx, {
    defaultMode: 'allow',
    askUser: async () => true,
    authorityResolver: () => ({ kind: 'allow' }),
    forceAsk: () => false,
    policy: {},
  })

  for (const tool of fsTools()) kernel.ctx.tools.register(tool)
  const processEvents = createProcessSessionEventBridge(kernel.ctx.sessions)
  const processes = new ProcessRegistry(processEvents)
  kernel.ctx.provide('processes', processes)
  kernel.ctx.provide('process-events', processEvents)
  kernel.ctx.tools.register(bashTool({ timeoutMs: DEFAULT_LIMITS.toolTimeoutMs, processes }))
  kernel.ctx.tools.register(bashOutputTool({ processes }))
  kernel.ctx.tools.register(killShellTool({ processes }))
  kernel.ctx.tools.register(todoWriteTool())
  kernel.ctx.tools.setRootResolver(() => ({
    root: canonicalRoot,
    deniedRoots: [path.resolve(args.dataDir), ...defaultSecretRoots(homedir())],
    hostStorageRoot: path.resolve(args.dataDir),
    memoryRoots: roots,
    additionalRoots: roots.map((folder) => ({ path: folder, access: memoryAccess })),
  }))

  kernel.ctx.llm.register(new OpenAiCompletionsProvider({
    name: providerName,
    apiKey: env('BENCH_API_KEY', 'bench'),
    baseUrl: env('BENCH_BASE_URL', 'http://127.0.0.1:6536/v1'),
    models: [model],
  }))

  const session: Session = kernel.ctx.sessions.create(workspaceId)
  session.append({ type: 'session/project', projectId: project.id })
  await session.durable()

  let offeredTools = 0
  const agent = kernel.ctx.agents.create(session, scope)
  kernel.ctx.on('agent/context', async (projected, next) => {
    const schemas = kernel.ctx.tools.schemas().filter((schema) => mode.definition.toolExposure.includes(schema.name))
    offeredTools = schemas.length
    const pinnedMemory = memoryEnabled ? await memoryIndexes(memory, scope) : []
    const guidanceAccess = memoryGuidanceAccess(schemas.map((schema) => schema.name))
    if (roots.length > 0 && guidanceAccess !== undefined) pinnedMemory.unshift(memoryGuidance(roots, guidanceAccess))
    const environment = renderEnvironmentContext({
      now: new Date(), platform: process.platform, arch: process.arch, nodeVersion: process.version, workspacePath: canonicalRoot,
    })
    const calibration = latestCalibration(session.events, { model, provider: providerName })
    const assembled = buildContext({
      events: session.events, mode, modeRevision: 0,
      model, providerName, schemas, activeSkills: [], pinnedMemory,
      budget: resolveModelBudget({ model }),
      ...(environment !== undefined ? { environment } : {}),
      ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
      ...(calibration !== undefined ? { calibration } : {}),
      fileScope: { primary: canonicalRoot, additional: roots.map((folder) => ({ path: folder, access: memoryAccess })), outsideAsks: false },
    })
    const contextId = randomUUID()
    const turnId = agentScope.getStore()?.turnId
    if (turnId !== undefined) session.append({ type: 'context/manifest', turnId, manifest: { ...assembled.manifest, contextId } })
    return next({ ...projected, providerName, model, contextId, messages: assembled.messages, tools: schemas, outputCeilingTokens: assembled.maxOutputTokens })
  }, true)

  const events: SessionEvent[] = []
  kernel.ctx.on('session/event', (emitter, event) => { if (emitter === session) events.push(event) })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; agent.stop() }, timeoutMs)

  const inputId = newInputId()
  session.append({ type: 'input/queued', inputId, content: args.message })
  await session.durable()
  for (const item of kernel.ctx.sessions.pendingInputs(session)) agent.enqueueAccepted(item)

  let runError: string | undefined
  try {
    await (agent as Agent).run()
  } catch (error) {
    runError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  } finally {
    clearTimeout(timer)
  }
  const wallMs = Date.now() - started

  // ── derive metrics from the durable log ────────────────────────────────
  const count = (type: SessionEvent['type']): number => events.filter((event) => event.type === type).length
  const toolSequence: string[] = []
  const failedTools: string[] = []
  for (const event of events) {
    if (event.type === 'tool/call') toolSequence.push(event.call.name)
    if (event.type === 'tool/result' && !event.ok) failedTools.push(event.callId)
  }
  const turnEndReasons = events.filter((event) => event.type === 'turn/end').map((event) => (event as { reason: string }).reason)
  const errors = events.filter((event) => event.type === 'turn/error').map((event) => (event as { kind: string; message: string }).message)
  const assistantTexts = events.filter((event) => event.type === 'assistant/message').map((event) => (event as { content: string }).content)
  const finalText = assistantTexts.length === 0 ? '' : assistantTexts[assistantTexts.length - 1]!

  const facts = new Map<string, { inputTokens: number; outputTokens: number; cachedInputTokens: number; startedAt: number | undefined }>()
  for (const event of events) {
    if (event.type !== 'model/attempt' && event.type !== 'execution/uncertain' && event.type !== 'execution/reconciled') continue
    const fact = (event as { fact: { attemptId: string; usage?: { inputTokens: number; outputTokens?: number; cachedInputTokens?: number }; startedAt?: number } }).fact
    if (fact.usage === undefined) continue
    facts.set(fact.attemptId, {
      inputTokens: fact.usage.inputTokens,
      outputTokens: fact.usage.outputTokens ?? 0,
      cachedInputTokens: fact.usage.cachedInputTokens ?? 0,
      startedAt: fact.startedAt,
    })
  }
  const usageList = [...facts.values()]
  const sum = (pick: (u: (typeof usageList)[number]) => number): number => usageList.reduce((acc, u) => acc + pick(u), 0)
  const firstRequestInputTokens = usageList.length === 0 ? 0 : usageList.reduce((a, b) => ((a.startedAt ?? Infinity) <= (b.startedAt ?? Infinity) ? a : b)).inputTokens

  const metrics = {
    harness: 'dnt-harness',
    model, provider: providerName, mode: mode.definition.id,
    ok: runError === undefined && !timedOut,
    timedOut, runError, wallMs,
    turns: count('turn/start'), steps: count('step/start'), assistantMessages: count('assistant/message'),
    toolCalls: toolSequence.length, failedToolResults: failedTools.length, toolSequence,
    turnEndReasons, errors, offeredTools,
    inputTokens: sum((u) => u.inputTokens),
    outputTokens: sum((u) => u.outputTokens),
    cachedInputTokens: sum((u) => u.cachedInputTokens),
    totalTokens: sum((u) => u.inputTokens + u.outputTokens),
    modelCalls: usageList.length,
    firstRequestInputTokens,
    finalText,
  }

  await fs.writeFile(args.metrics, JSON.stringify(metrics, null, 2))
  if (args.events !== undefined) {
    const lines = events.map((event) => JSON.stringify(event)).join('\n')
    await fs.writeFile(args.events, lines)
  }
  process.stdout.write(`BENCH_RESULT ${JSON.stringify(metrics)}\n`)

  // ── teardown ───────────────────────────────────────────────────────────
  try { await kernel.ctx.agents.stopAll({ timeoutMs: 5000 }) } catch { /* best effort */ }
  try { processes.closeAdmission(); await processes.disposeAll() } catch { /* best effort */ }
  try { await processEvents.flushAll() } catch { /* best effort */ }
  try { await kernel.stop() } catch { /* best effort */ }
  process.exit(0)
}

main().catch((error: unknown) => {
  process.stderr.write(`bench: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
