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
 *   bun src/bins/headless.ts --message "hello"
 *   bun src/bins/headless.ts --provider ocproxy --model deepseek-v4.1-flash-free --message "hello"
 *   bun src/bins/headless.ts            # interactive REPL, 'exit' quits
 *
 * Model selection: `--provider`/`--model` (`--model provider/model` is
 * accepted too), else the same `providers.json` store the web host uses
 * (`--config` points at a different file), else the legacy
 * `DEEPSEEK_API_KEY` provider. `--thinking <level>` is validated against the
 * selected model before it reaches the wire.
 */
import { createInterface } from 'node:readline/promises'
import path from 'node:path'
import { loadRepoEnv, readApiKey, resolveAppHome } from './env.ts'
import {
  AgentsService,
  DEEPSEEK_MODELS,
  DeepSeekProvider,
  Kernel,
  LlmService,
  OpenAiCompletionsProvider,
  ToolsService,
  attachApproval,
  bashTool,
  bashOutputTool,
  killShellTool,
  fileSessions,
  fsTools,
  newInputId,
  THINKING_LEVELS,
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
import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs'
import { MemoryService } from '../harness/memory/service.ts'
import { memoryRoots, memoryGuidance, memoryGuidanceAccess, memoryIndexes } from '../harness/memory/context.ts'
import { ModesService, DEFAULT_MODE_ID } from '../harness/modes/service.ts'
import { buildContext } from '../harness/context/builder.ts'
import { latestCalibration } from '../harness/context/calibration.ts'
import { agentScope } from '../harness/agent/scope.ts'
import { randomUUID } from 'node:crypto'
import { renderEnvironmentContext } from '../harness/context/environment.ts'
import { credentialGeneration, resolveEffectiveModel, type EffectiveProvider } from '../harness/llm/effective-model.ts'
import { loadCredentialHasher } from '../harness/llm/credential-secret.ts'
import { resolvePermission } from '../harness/approval/resolution.ts'
import { attachDangerousCommandGuard } from '../harness/guard/guard.ts'
import { DangerousCommandsStore } from '../harness/guard/store.ts'
import { liftsReadOnlyBash, riskyBashMatch } from '../harness/modes/bash-policy.ts'
import { defaultSecretRoots } from '../capabilities/fs/secret-roots.ts'
import { homedir } from 'node:os'
import { loadProviderStore, maxOutputTokenOverrides, repairDefaults } from '../web/provider-store.ts'

loadRepoEnv()

interface CliOptions {
  readonly yolo: boolean
  readonly root: string
  readonly dataDir: string
  readonly message: string | undefined
  /** Provider store consulted for the effective provider/model selection. */
  readonly config: string
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly thinking: string | undefined
}

function parseArgs(argv: readonly string[]): CliOptions {
  let yolo = false
  let root = process.cwd()
  let dataDir = path.join(resolveAppHome(process.cwd()), 'data')
  let message: string | undefined
  // Mirrors the web host's provider store, so the CLI and the UI select from
  // the same file unless `--config` points somewhere else.
  let config = path.join(resolveAppHome(), 'providers.json')
  let provider: string | undefined
  let model: string | undefined
  let thinking: string | undefined
  // The value after a flag, consumed so it is never read as a flag itself. A
  // following `--flag` is not a value: `--model --yolo` reports a missing
  // model instead of sending the model `--yolo` and also enabling yolo.
  const value = (i: number): string | undefined => {
    const next = argv[i + 1]
    return next === undefined || next.startsWith('--') ? undefined : next
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--yolo') { yolo = true; continue }
    const next = value(i)
    if (arg === '--root') root = next ?? root
    else if (arg === '--data-dir') dataDir = next ?? dataDir
    else if (arg === '--message') message = argv[i + 1]
    else if (arg === '--config') config = next ?? config
    // A selection flag with no value is reported, not silently dropped.
    else if (arg === '--provider') provider = next ?? ''
    else if (arg === '--model') model = next ?? ''
    else if (arg === '--thinking') thinking = next ?? ''
    else continue
    // `--message` takes the next argument verbatim, even one starting `--`.
    if (arg === '--message' ? argv[i + 1] !== undefined : next !== undefined) i++
  }
  return { yolo, root, dataDir, message, config, provider, model, thinking }
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
  const { yolo, root, dataDir, message, config, provider: flagProvider, model: flagModel, thinking: flagThinking } = parseArgs(process.argv.slice(2))
  const apiKey = readApiKey()
  // Providers come from the same store the web host edits, plus the legacy env
  // key — never from an implicit mock. Loaded before any resource is taken so
  // a bad flag exits without holding the data home.
  let store: ReturnType<typeof loadProviderStore>
  try {
    store = loadProviderStore(config)
  } catch (error) {
    process.stderr.write(`dnt-harness: cannot read provider config '${config}': ${(error as Error).message}\n`)
    process.exitCode = 1
    return
  }
  if (store.providers.length === 0 && existsSync(config) && statSync(config).isFile() && readFileSync(config, 'utf8').trim() !== '') {
    // A file that exists but yields nothing is unreadable, not empty: say so
    // instead of the generic "no provider configured".
    process.stderr.write(`dnt-harness: provider config '${config}' could not be parsed (expected the version 2 store); treating it as empty.\n`)
  }
  const enabled = store.providers.filter((entry) => entry.enabled)
  // The env key is sugar for a store with no DeepSeek entry at all: a
  // `deepseek` entry, even a disabled one, is the operator's decision.
  const legacyKey = apiKey !== undefined && store.providers.some((entry) => entry.id === 'deepseek') ? undefined : apiKey
  if (enabled.length === 0 && legacyKey === undefined) {
    process.stderr.write(`no provider configured (${config}) and no DEEPSEEK_API_KEY; model calls fail until one is registered.\n`)
  }
  for (const [flag, value] of [['--provider', flagProvider], ['--model', flagModel], ['--thinking', flagThinking]] as const) {
    if (value === '') {
      process.stderr.write(`dnt-harness: ${flag} needs a value.\n`)
      process.exitCode = 1
      return
    }
  }

  // The one effective selection, resolved once: explicit flags, then the
  // store's defaults, then the legacy env provider. It is stamped on every
  // request, so a run never depends on whichever model the provider happens
  // to advertise first. Only providers that will actually be registered are
  // candidates: an enabled store entry, or the legacy env provider.
  const storedDefaults = repairDefaults(store.defaults, store.providers)
  const legacyBaseUrl = process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'
  // Keys route-identity credential fingerprints; shared with the web host via the store's directory.
  const credentialHasher = loadCredentialHasher(path.dirname(config)).hash
  // Resolver input per candidate: the key itself stays here, only its opaque
  // generation travels into the resolved facts.
  const candidates = new Map<string, EffectiveProvider>(
    enabled.map((entry) => [entry.id, { id: entry.id, baseUrl: entry.baseUrl, models: entry.models, ...(entry.modelSettings !== undefined ? { modelSettings: entry.modelSettings } : {}), credentialGeneration: credentialGeneration(entry.apiKey, credentialHasher) }]),
  )
  if (legacyKey !== undefined) candidates.set('deepseek', { id: 'deepseek', baseUrl: legacyBaseUrl, models: DEEPSEEK_MODELS, credentialGeneration: credentialGeneration(legacyKey, credentialHasher) })
  let selectedProvider = flagProvider
  let selectedModel = flagModel
  if (selectedProvider === undefined && selectedModel !== undefined) {
    // `--model <provider>/<model>` sugar, resolved only against a registered
    // provider id: real model ids may contain slashes of their own.
    const cut = selectedModel.indexOf('/')
    if (cut > 0 && candidates.has(selectedModel.slice(0, cut))) {
      selectedProvider = selectedModel.slice(0, cut)
      selectedModel = selectedModel.slice(cut + 1)
    }
  }
  if (selectedProvider !== undefined && !candidates.has(selectedProvider)) {
    const known = [...candidates.keys()]
    process.stderr.write(`dnt-harness: provider '${selectedProvider}' is not configured or not enabled${known.length > 0 ? ` (available: ${known.join(', ')})` : ''}.\n`)
    process.exitCode = 1
    return
  }
  const defaultProvider = storedDefaults.provider !== null && storedDefaults.provider !== undefined && candidates.has(storedDefaults.provider) ? storedDefaults.provider : undefined
  if (selectedModel !== undefined && selectedProvider === undefined) {
    // A bare model still needs a provider: the default one when it advertises
    // the model, else the first that does.
    const advertises = (id: string): boolean => candidates.get(id)?.models.includes(selectedModel!) === true
    selectedProvider = defaultProvider !== undefined && advertises(defaultProvider)
      ? defaultProvider
      : [...candidates.keys()].find(advertises)
  }
  selectedProvider = selectedProvider ?? defaultProvider ?? (legacyKey !== undefined ? 'deepseek' : undefined)
  selectedModel = selectedModel ?? (defaultProvider !== undefined && defaultProvider === selectedProvider ? storedDefaults.model ?? undefined : candidates.get(selectedProvider ?? '')?.models[0])
  // Every fact that follows from the pair comes from the shared resolver, as in
  // the web host: advertised-model validation (an unknown or mistyped model
  // fails here, not upstream), the expressible thinking level (a flag is
  // strict, a stored level is a preference), and the context budget with the
  // operator's per-model override.
  const resolved = resolveEffectiveModel({
    ...(selectedProvider !== undefined && candidates.has(selectedProvider) ? { provider: candidates.get(selectedProvider)! } : {}),
    ...(selectedModel !== undefined ? { model: selectedModel } : {}),
    thinking: flagThinking !== undefined ? { level: flagThinking, strict: true } : { level: storedDefaults.thinkingLevel },
  })
  if (!resolved.ok) {
    const message = resolved.error.code === 'invalid_thinking' ? `--thinking must be one of ${THINKING_LEVELS.join(', ')}` : resolved.error.message
    process.stderr.write(`dnt-harness: ${message}.\n`)
    process.exitCode = 1
    return
  }
  const selectedThinking = resolved.value.thinking
  if (selectedProvider === undefined) {
    process.stderr.write(`no provider selected: pass --provider or configure ${config}.\n`)
  } else if (selectedModel === undefined) {
    process.stderr.write(`no model selected for provider '${selectedProvider}', which advertises none: pass --model.\n`)
  }
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
  const memoryAccess = mode.definition.toolExposure.some((name) => ['Write', 'Edit', 'ApplyPatch'].includes(name)) ? 'write' as const : 'read' as const
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
  const policy: Record<string, 'allow' | 'ask' | 'deny'> = Object.fromEntries(Object.entries(mode.definition.permissionDefaults).map(([name, permission]) => [name, yolo && permission !== 'deny' ? 'allow' : permission]))
  const options: ApprovalOptions = {
    defaultMode: yolo ? 'allow' : 'ask', askUser,
    // Same Bash mode properties as the web host: read-only commands lift an
    // ask, risky ones (Autonomous) force one.
    authorityResolver: (call) => {
      const permission = resolvePermission(policy, call.name, { defaultMode: yolo ? 'allow' : 'ask' })
      if (permission === 'deny') return { kind: 'deny', reason: `policy denies '${call.name}'` }
      if (permission === 'ask' && !liftsReadOnlyBash(mode.definition, call)) return { kind: 'ask', requirements: [{ kind: 'tool-policy' }] }
      return { kind: 'allow' }
    },
    forceAsk: (call, approvalScope) => dangerousGuard.getMatch(call, approvalScope.executionId)?.action === 'ask'
      || (!yolo && riskyBashMatch(mode.definition, call) !== null),
    policy,
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
  // Providers come from the same store the web host edits, plus the legacy
  // env key — never from an implicit mock.
  for (const entry of enabled) {
    kernel.ctx.llm.register(new OpenAiCompletionsProvider({
      name: entry.id,
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      ...(entry.models.length > 0 ? { models: entry.models } : {}),
      maxOutputTokens: maxOutputTokenOverrides(entry),
      credentialHasher,
    }))
  }
  if (legacyKey !== undefined) {
    kernel.ctx.llm.register(new DeepSeekProvider(legacyKey, legacyBaseUrl, { credentialHasher }))
  }

  const session: Session = kernel.ctx.sessions.create(workspaces.defaultWorkspace)
  session.append({ type: 'session/project', projectId: project.id })
  await session.durable()
  kernel.ctx.on('session/event', (emitter, event) => {
    if (emitter === session) render(event)
  })

  // The operator's context override wins over the catalog, as in the web host.
  const budget = resolved.value.budget

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
    // The provider's last report calibrates the budget, as in the web host.
    const calibration = latestCalibration(session.events, { model: selectedModel, provider: selectedProvider })
    const assembled = buildContext({
      events: session.events, mode, modeRevision: 0,
      model: selectedModel, providerName: selectedProvider,
      schemas, activeSkills: [], pinnedMemory, budget,
      ...(environment !== undefined ? { environment } : {}),
      ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
      ...(calibration !== undefined ? { calibration } : {}),
      fileScope: { primary: canonicalRoot, additional: roots.map((folder) => ({ path: folder, access: memoryAccess })), outsideAsks: !yolo },
    })
    // Calibration pairs a provider report with its manifest by contextId, so the request carries one and its manifest is logged.
    const contextId = randomUUID()
    const turnId = agentScope.getStore()?.turnId
    if (turnId !== undefined) session.append({ type: 'context/manifest', turnId, manifest: { ...assembled.manifest, contextId } })
    return next({
      ...projected,
      ...(selectedProvider !== undefined ? { providerName: selectedProvider } : {}),
      ...(selectedModel !== undefined ? { model: selectedModel } : {}),
      ...(selectedThinking !== undefined ? { thinkingLevel: selectedThinking } : {}),
      // Stable per conversation: every request of this session carries the
      // same affinity, so provider-side prefix caches stay reusable.
      sessionAffinity: session.id,
      contextId,
      messages: assembled.messages,
      tools: schemas,
      outputCeilingTokens: assembled.maxOutputTokens,
    })
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
