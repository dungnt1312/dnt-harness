/**
 * The web host half: an HTTP server exposing the harness over REST + SSE,
 * scoped to workspaces (G2).
 *
 * Every session belongs to exactly one workspace, fixed at creation; all
 * workspace-scoped routes live under `/api/workspaces/:wid/...` and a
 * session id from a foreign workspace fails closed (404, never a leak).
 * The three live controls — model, permission policy, and (in G3) mode —
 * are workspace-scoped state resolved through the ambient agent scope at
 * execution time, so a running Turn keeps its own workspace's controls no
 * matter which tab the user is looking at.
 *
 * File tools are granted the bound project's working folder per execution;
 * a session without a project has no filesystem grant at all (memory-mode
 * hosts may grant a fallback root). Application storage is denied to tools.
 * Writer coordination leases one write-capable execution per project
 * folder — application-local, never an OS sandbox claim.
 *
 * The client renders from the durable log — `GET .../events` streams a
 * snapshot, live `session/event` broadcasts, and still-pending approval
 * questions — answered by `POST /api/approvals/:id`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { bearerAllows, ControlPlaneAuthService, isPublicPath, SESSION_COOKIE } from './control-plane-auth.ts'
import { promises as fs, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentsService } from '../harness/agent/service.ts'
import { agentScope } from '../harness/agent/scope.ts'
import type { Agent } from '../harness/agent/agent.ts'
import { attachApproval, type ApprovalHandle, type ApprovalMode } from '../harness/approval/policy.ts'
import { DangerousCommandsStore } from '../harness/guard/store.ts'
import { attachDangerousCommandGuard } from '../harness/guard/guard.ts'
import { DEFAULT_LIMITS, type HarnessLimits } from '../harness/limits.ts'
import { LlmService } from '../harness/llm/service.ts'
import { OpenAiCompletionsProvider } from '../harness/llm/openai.ts'
import { isThinkingLevel, resolveContextLimit } from '../harness/llm/model-catalog.ts'
import type { LlmProvider, ToolCall } from '../harness/llm/types.ts'
import { fileSessions, SessionsService } from '../harness/session/service.ts'
import type { Session } from '../harness/session/session.ts'
import { sessionModelOf, type SessionEvent } from '../harness/session/events.ts'
import { deriveTitle } from '../harness/session/title.ts'
import { newInputId, type ProjectId, type SessionId, type WorkspaceId } from '../util/brand.ts'
import { ToolsService } from '../harness/tools/service.ts'
import { bashTool } from '../capabilities/shell/bash.ts'
import { fsTools } from '../capabilities/fs/tools.ts'
import { listProjectEntries, readProjectFile, searchProjectFiles, ProjectFileError } from './project-files.ts'
import {
  AttachmentError,
  AttachmentStore,
  isImageMediaType,
  isSupportedMediaType,
  normalizeMediaType,
  sniffImageMediaType,
  type AttachmentRef,
} from '../harness/attachments/store.ts'
import {
  createTerminalService,
  TerminalError,
  type PtySpawner,
  type TerminalExitReason,
  type TerminalInfo,
  type TerminalService,
} from './terminals.ts'
import { Kernel } from '../kernel/registry.ts'
import {
  loadProviderStore,
  maskKey,
  saveProviderStore,
  repairDefaults,
  type ModelDefaults,
  slugify,
  type ModelSettings,
  type ProviderConfig,
} from './provider-store.ts'
import { ScopeError, WorkspaceService, type ProjectRecord, type WorkspaceRecord } from '../harness/workspace/service.ts'
import { ModesService, ModeError, DEFAULT_MODE_ID, BUNDLED_MODES, type ResolvedMode } from '../harness/modes/service.ts'
import { AgentDefinitionService, AgentDefinitionError } from '../harness/agents/definition-service.ts'
import {
  McpConfigStore,
  McpConfigError,
  parseMcpConfig,
  parseHooksConfig,
  importClaudeMcp,
  importCodexMcp,
  resolveSecretRefs,
  mcpToolName,
  RESERVED_TOOL_NAMES,
  auditHash,
  authSecretRef,
  type McpConfig,
  type McpServerConfig,
} from '../harness/mcp/config.ts'
import { McpServerClient, McpTransportError, type McpToolDescriptor } from '../harness/mcp/client.ts'
import { configRevision, upsertServer, withServerEnabled, withoutServer } from '../harness/mcp/config-v2.ts'
import { clearAuditFault, dispatchToolCall, faultIsOpen } from '../harness/mcp/execution-coordinator.ts'
import { McpExecutionJournal } from '../harness/mcp/execution-journal.ts'
import { MutationStore, readFileIfPresent } from '../harness/mcp/mutation-store.ts'
import { DataHomeLock } from '../harness/mcp/ownership-lock.ts'
import { ManagedOAuth } from '../harness/mcp/oauth.ts'
import { OAuthStore } from '../harness/mcp/oauth-store.ts'
import { containmentCapability } from '../harness/mcp/process-controller.ts'
import { stageMcpOutcome } from '../harness/mcp/staged-outcome.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { runHook, isBlockingDecision, isFailureDecision } from '../harness/hooks/runner.ts'
import type { HooksConfig } from '../harness/mcp/config.ts'
import { ChildExecutor, SpawnError, type ChildModel, type TaskPacket } from '../harness/agents/executor.ts'
import { agentTool, ChildModelError, projectInheritedMessages, resolveChildModel } from './agent-delegation.ts'
import { importClaudeDefinition } from '../harness/agents/compatibility/claude.ts'
import { SkillsService, SkillError } from '../harness/skills/service.ts'
import { MemoryService, MemoryError } from '../harness/memory/service.ts'
import { memoryTools } from '../harness/memory/tools.ts'
import { buildContext, type ContextManifest, type ActiveSkill, type MemorySnippet } from '../harness/context/builder.ts'
import { CheckpointStore } from '../harness/context/compaction.ts'
import { DEFAULT_BUDGET, type ResolvedBudget } from '../harness/context/budget.ts'

declare module 'mini-dsh' {
  interface Events {
    /**
     * G4 writer handoff: a write-capable child is starting, so the root
     * session's held project leases release at this safe boundary (the
     * root's next write call re-acquires only after the child settles).
     */
    'agent/child-writer-handoff'(payload: { readonly rootSessionId: SessionId; readonly childSessionId: SessionId }): Promise<void>
    /**
     * A tool call is waiting for a human answer on one session; emitted by
     * the web approval bridge and consumed by that session's SSE stream.
     */
    'web/approval'(payload: {
      readonly sessionId: SessionId
      readonly approvalId: string
      readonly call: ToolCall
      readonly guardWarning?: string
      /** Present when the waiting session is a child; root streams relay this. */
      readonly parentSessionId?: SessionId
      /** The child's agent definition, so a relayed question names its asker. */
      readonly definitionName?: string
      /** MCP (or other) tools annotated as requiring a human each call. */
      readonly interactive?: boolean
      /** Epoch ms when this question expires undecided. */
      readonly expiresAt: number
    }): void
    /** A pending question was settled (answer, expiry, stop, or policy). */
    'web/approval-settled'(payload: {
      readonly sessionId: SessionId
      readonly approvalId: string
      readonly parentSessionId?: SessionId
    }): void
    /**
     * A turn failed (e.g. a rejected API call) on one session; the reason is
     * broadcast so the UI can surface it instead of a bare `turn/end: failed`.
     */
    'web/turn-error'(payload: { readonly sessionId: SessionId; readonly message: string }): void
  }
}

/** The synthetic workspace owning memory-mode sessions. */
const MEMORY_WORKSPACE = 'default' as WorkspaceId

/** The bundled default mode definition (controls initialize with it). */
function BUNDLED_DEFAULT() {
  return BUNDLED_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? BUNDLED_MODES[0]!
}

/** One frame on the SSE stream: log snapshot, live session event, a pending approval question, or a turn failure. */
export type WebEnvelope =
  | { readonly kind: 'snapshot'; readonly events: SessionEvent[] }
  | { readonly kind: 'session'; readonly event: SessionEvent }
  | {
    readonly kind: 'approval'
    readonly approvalId: string
    readonly call: ToolCall
    /** Dangerous-command guard note shown beside the question. */
    readonly guardWarning?: string
    /** True when Always-allow cannot skip future asks (interactive MCP). */
    readonly interactive?: boolean
    /** Set when this question belongs to a child of the streamed session. */
    readonly childSessionId?: string
    /** The child's agent definition name, alongside `childSessionId`. */
    readonly definitionName?: string
    /**
     * Epoch ms when the question expires undecided. Absent on questions
     * rebuilt from a log snapshot, which carries no deadline.
     */
    readonly expiresAt?: number
  }
  | { readonly kind: 'approval-settled'; readonly approvalId: string }
  | { readonly kind: 'error'; readonly message: string }

/** Options for {@link createWebServer}. */
export interface WebServerOptions {
  /**
   * Data home: `<home>/workspaces/<ws>/sessions/...` holds the durable
   * logs; workspace/project metadata lives beside them. Omitted keeps
   * sessions memory-only under a synthetic `default` workspace (tests).
   */
  readonly home?: string
  /**
   * Workspace root granted to file tools in memory mode when a session has
   * no project (legacy permissive behavior for tests). Unused with `home`.
   */
  readonly root?: string
  /**
   * Providers registered verbatim on top of the config file (injection seam
   * used by bins for env-configured entries and by tests for scripts).
   */
  readonly providers?: readonly LlmProvider[]
  /** Provider config file; defaults to `<homedir>/.mini-dsh/providers.json`. */
  readonly configFile?: string
  /** Create a `deepseek` entry from `DEEPSEEK_API_KEY` when the config has none. */
  readonly seedDeepseekFromEnv?: boolean
  /** Initial `(provider, model)` override. It is process-local for backwards compatibility and is not persisted. */
  readonly activeModel?: { readonly provider?: string; readonly model?: string }
  /** Test seam for durable provider-store writes; production uses atomic saveProviderStore. */
  readonly providerStoreWriter?: (file: string, store: import('./provider-store.ts').ProviderStore) => Promise<void>
  /** Test seam for exclusive legacy-policy retirement operations. */
  readonly policyRetirement?: {
    readonly copyExclusive?: (source: string, target: string) => Promise<void>
    readonly unlink?: (file: string) => Promise<void>
    readonly delay?: (ms: number) => Promise<void>
  }
  /** Mode for tools the selected mode's map does not name; defaults to `ask`. */
  readonly defaultMode?: ApprovalMode
  /**
   * Answer selected-mode prompts as allow while preserving explicit denies.
   * Host `blockedTools`, mode exposure, child ceilings, and MCP
   * `requiresUserInteraction` still apply.
   */
  readonly yolo?: boolean
  /** Harness limits override (watchdogs, resource caps, and queue bounds). */
  readonly limits?: Partial<HarnessLimits>
  /** Host-level tool deny patterns (supports `*`); cannot be widened by mode/workspace/child/approval. */
  readonly blockedTools?: readonly string[]
  /** Read-only user skill layer (e.g. `~/.claude/skills`); workspace skills shadow it by name. */
  readonly userSkillsDir?: string
  /** Directory of built client assets; defaults to the repo's `web-dist/`. */
  readonly staticDir?: string
  /** Port to listen on; `0` (default) picks an ephemeral port. */
  readonly port?: number
  /**
   * Bind address; defaults to `127.0.0.1`. A non-loopback address is refused.
   * This build has no authenticated TLS profile, so `unsafeNetworkBind` does
   * not open one. Terminals stay loopback-only.
   */
  readonly host?: string
  /**
   * Local control-plane authentication. Production enables it. Tests leave it
   * off so existing route suites keep their current contract; an explicit
   * `true` is what the auth suite and the web bin use. Non-loopback stays
   * refused either way: this build has no authenticated TLS profile.
   */
  readonly controlPlaneAuth?: boolean
  /**
   * Ignored. Kept so older callers still type-check. A non-loopback bind is
   * refused because there is no authenticated TLS profile.
   */
  readonly unsafeNetworkBind?: boolean
  /**
   * Extra `Host` header values this server answers to, beyond the loopback
   * literals and its own bind address.
   *
   * Every request is checked against this allowlist because a browser will
   * happily send requests to a name that resolves to `127.0.0.1` — DNS
   * rebinding — and treat the response as same-origin. Binding to loopback
   * does not prevent that; refusing unknown `Host` values does. Set this when
   * the host legitimately answers to a LAN name or sits behind a proxy.
   */
  readonly allowedHosts?: readonly string[]
  /**
   * Interactive Workbench terminals. Enabled by default, and served only on a
   * loopback bind: a terminal reachable from the network is remote code
   * execution for anyone who can open the page. `spawner` is a test seam.
   */
  readonly terminals?: {
    readonly enabled?: boolean
    readonly spawner?: PtySpawner
    /**
     * Where a terminal opens when no project is named. Defaults to the host
     * process's own working directory — where `npm run web` was started, which
     * is what a user expects a terminal to open in. It is deliberately
     * separate from `root`: that field grants file tools their scope, and a
     * terminal must not be able to widen it.
     */
    readonly defaultCwd?: string
  }
}

/**
 * Terminal stream frames. Deliberately a separate type from {@link WebEnvelope}:
 * terminal traffic is ephemeral and never enters the durable session log, so it
 * must not be able to travel the session stream by accident. Payloads are
 * base64 because PTY output is a byte stream that JSON cannot carry verbatim.
 */
export type TerminalEnvelope =
  | { readonly kind: 'snapshot'; readonly terminals: readonly TerminalSnapshot[] }
  | { readonly kind: 'created'; readonly terminal: TerminalInfo }
  | { readonly kind: 'data'; readonly terminalId: string; readonly data: string }
  | {
      readonly kind: 'exit'
      readonly terminalId: string
      readonly exitCode: number
      readonly reason: TerminalExitReason
    }

/** A terminal plus the scrollback a reconnecting client needs to catch up. */
export interface TerminalSnapshot extends TerminalInfo {
  /** Base64 of the retained scrollback. */
  readonly scrollback: string
}

/** A running web server: its URL plus a graceful shutdown. */
export interface WebServer {
  readonly url: string
  readonly port: number
  readonly kernel: Kernel
  readonly auth: ControlPlaneAuthService
  close(): Promise<void>
}

interface SessionEntry {
  readonly session: Session
  readonly agent: Agent
  /** Ownership is fixed at creation. */
  readonly workspaceId: WorkspaceId
  /** Optional project binding (within the workspace; the file-tool grant). */
  projectId: ProjectId | undefined
  /** Set when the session is deleted; open SSE streams end themselves. */
  closed?: boolean
}

interface PendingApproval {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  /** Browser principal that started the turn, when control-plane auth is on. */
  readonly principalId?: string
  readonly call: ToolCall
  readonly parentSessionId?: SessionId
  /** The asking child's agent definition, when this is a child's question. */
  readonly definitionName?: string
  readonly interactive: boolean
  /** Epoch ms from the policy's own timer — the one deadline the UI shows. */
  readonly expiresAt: number
  /** Dangerous-command guard note, replayed on every (re)connect. */
  readonly guardWarning?: string
  resolve(allow: boolean): void
}

/**
 * Effective permission is the selected mode's own map. `--yolo` answers every
 * question for the operator; it never lifts an explicit deny, which is a
 * prohibition rather than a prompt.
 */
function effectivePolicy(
  defaults: Readonly<Record<string, ApprovalMode>>,
  yolo: boolean,
): Record<string, ApprovalMode> {
  if (!yolo) return { ...defaults }
  return Object.fromEntries(
    Object.entries(defaults).map(([tool, mode]) => [tool, mode === 'deny' ? 'deny' : 'allow']),
  )
}

function toolRequiresInteraction(
  call: ToolCall,
  workspaceId: WorkspaceId | undefined,
  descriptors: ReadonlyMap<string, { readonly requiresUserInteraction?: boolean }>,
): boolean {
  if (!call.name.startsWith('mcp__')) return false
  if (workspaceId === undefined) return true
  return descriptors.get(`${workspaceId}:${call.name}`)?.requiresUserInteraction === true
}

/**
 * Mode failures as HTTP: a stale hash is recoverable by re-reading (409), an
 * unknown id is 404, and everything else is content the caller must fix.
 */
function sendModeError(
  error: unknown,
  send: (status: number, body: unknown) => void,
  fail: (error: unknown) => void,
): void {
  if (!(error instanceof ModeError)) {
    fail(error)
    return
  }
  send(error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400, { error: error.message })
}

function approvalEnvelope(approvalId: string, waiting: PendingApproval, viewerSessionId: SessionId): Extract<WebEnvelope, { kind: 'approval' }> {
  return {
    kind: 'approval',
    approvalId,
    call: waiting.call,
    expiresAt: waiting.expiresAt,
    ...(waiting.interactive ? { interactive: true } : {}),
    ...(waiting.guardWarning !== undefined ? { guardWarning: waiting.guardWarning } : {}),
    ...(waiting.parentSessionId !== undefined && viewerSessionId === waiting.parentSessionId
      ? {
        childSessionId: waiting.sessionId,
        ...(waiting.definitionName !== undefined ? { definitionName: waiting.definitionName } : {}),
      }
      : {}),
  }
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json',
}

/** The live controls, scoped to one workspace. */
interface WorkspaceControls {
  /** The selected mode id (G3, third live control). */
  modeId: string
  /** Bumped on every mode change; manifests record it. */
  modeRevision: number
  /** The cached definition adopted at selection (not hot-reloaded). */
  modeDefinition: ResolvedMode
}

/** One provider as exposed over REST — never carries the raw API key. */
export interface PublicProvider {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly keyMasked: string
  readonly models: readonly string[]
  /** Per-model operator overrides (context window, vision, thinking default). */
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
}

function publicProvider(entry: ProviderConfig): PublicProvider {
  return {
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    enabled: entry.enabled,
    keyMasked: maskKey(entry.apiKey),
    models: [...entry.models],
    ...(entry.modelSettings !== undefined ? { modelSettings: entry.modelSettings } : {}),
  }
}

/** Boot the harness on a kernel and expose it over HTTP. */
export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  const boundHost = options.host ?? '127.0.0.1'
  const loopbackBind = boundHost === '127.0.0.1' || boundHost === '::1' || boundHost === 'localhost'
  // Refused before anything is constructed: an unauthenticated API on a
  // network address is tool execution for anyone who can reach the port, and
  // the `Host` allowlist is a browser defence only — a direct client sends
  // whatever `Host` it likes.
  // There is no authenticated TLS profile in this build. Auth on plain HTTP
  // does not make a network bind safe, so non-loopback stays refused.
  if (!loopbackBind) {
    throw new Error(
      `refusing to bind '${boundHost}': non-loopback requires a separately configured authenticated TLS profile, which this build does not provide. Keep the bind on loopback.`,
    )
  }

  const kernel = new Kernel()
  if (options.home !== undefined) {
    kernel.ctx.plugin(fileSessions(options.home))
  } else {
    kernel.ctx.plugin(SessionsService)
  }
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)

  const limits: HarnessLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  kernel.ctx.provide('limits', limits)

  // ── workspace registry ───────────────────────────────────────
  const workspaces = new WorkspaceService(options.home ?? process.cwd())
  if (options.home !== undefined) {
    await workspaces.boot()
    for (const ws of workspaces.list({ includeArchived: true })) {
      await retireWorkspacePolicyFile(workspaces.workspaceDir(ws.id), ws, options.policyRetirement)
    }
  }
  kernel.ctx.provide('workspaces', workspaces)
  const deniedRoots = options.home !== undefined ? [options.home] : undefined
  // G3 resource services: workspace-owned modes/skills/memory. Memory-mode
  // hosts bind them to a fresh temp home so tests stay hermetic.
  const resourceHome = options.home ?? (await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-resources-')))
  const modes = new ModesService(resourceHome)
  const skills = new SkillsService(resourceHome, undefined, options.userSkillsDir)
  const memory = new MemoryService(resourceHome)
  const checkpoints = new CheckpointStore(path.join(resourceHome, 'workspaces'))
  kernel.ctx.provide('modes', modes)
  kernel.ctx.provide('skills', skills)
  kernel.ctx.provide('memory', memory)
  // Composer attachments: content-addressed blobs beside the workspace's other
  // resources, so a memory-mode host gets a hermetic temp home like the rest.
  const attachments = new AttachmentStore(resourceHome, { maxBytes: limits.maxAttachmentBytes })
  const agentDefinitions = new AgentDefinitionService(resourceHome)
  const childExecutor = new ChildExecutor(kernel.ctx)
  kernel.ctx.provide('agent-definitions', agentDefinitions)

  // G5: MCP servers + hooks, workspace-scoped. Each (workspace, enabled
  // server) gets one McpServerClient; tools register as `mcp__server__tool`.
  const mcpStore = new McpConfigStore(resourceHome)
  const ownerLock = await DataHomeLock.acquire(resourceHome)
  const mutations = new MutationStore(resourceHome)
  await mutations.recover()
  const mcpGeneration = new Map<string, number>()
  const configWatch = new Map<string, string>()
  const drifted = new Set<string>()
  const generationOf = (workspaceId: string): number => mcpGeneration.get(workspaceId) ?? 1
  const journals = new Map<string, McpExecutionJournal>()
  const auditFaultFile = path.join(resourceHome, 'mcp-audit-fault.json')
  const oauthKeyFile = path.join(resourceHome, 'oauth.master.key')
  let oauthKey: Buffer
  try {
    oauthKey = await fs.readFile(oauthKeyFile)
    if (oauthKey.length !== 32) throw new Error('oauth master key must be 32 bytes')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    oauthKey = randomBytes(32)
    await fs.writeFile(oauthKeyFile, oauthKey, { mode: 0o600 })
  }
  const oauth = new ManagedOAuth(new OAuthStore(path.join(resourceHome, 'oauth'), oauthKey))
  const sessionPrincipals = new Map<string, string>()
  const mcpClients = new Map<string, McpServerClient>() // `${wsId}:${server}`
  const mcpClientGeneration = new Map<string, number>()
  /** Singleton connection promises prevent duplicate processes per workspace/server. */
  const mcpConnecting = new Map<string, Promise<McpServerClient>>()
  /** Disable/close cancellation epochs prevent late connection publication. */
  const mcpCancelled = new Set<string>()
  let mcpHostClosing = false
  /** Per-workspace live descriptor snapshots used by dynamic schema resolvers. */
  const mcpDescriptors = new Map<string, McpToolDescriptor>() // `${wsId}:${fullName}`
  /** Model schemas are registered once by full public name; execution dispatches by workspace scope. */
  const mcpRegistered = new Set<string>()
  kernel.ctx.provide('mcp-store', mcpStore)

  // ── provider registry ────────────────────────────────────────
  const configFile = options.configFile ?? path.join(homedir(), '.mini-dsh', 'providers.json')
  const storedProviders = loadProviderStore(configFile)
  let list: ProviderConfig[] = [...storedProviders.providers]
  let durableDefaults: ModelDefaults = storedProviders.defaults
  let runtimeModelOverride: { readonly provider: string; readonly model: string } | undefined
  let defaults: ModelDefaults = durableDefaults
  if (list.length === 0 && options.seedDeepseekFromEnv === true) {
    const key = process.env['DEEPSEEK_API_KEY']?.trim()
    if (key !== undefined && key !== '') {
      list = [{
        id: 'deepseek',
        name: 'deepseek',
        baseUrl: process.env['DEEPSEEK_BASE_URL']?.trim() || 'https://api.deepseek.com',
        apiKey: key,
        models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro'],
        enabled: true,
      }]
      durableDefaults = repairDefaults(durableDefaults, list)
      defaults = durableDefaults
      await saveProviderStore(configFile, { version: 2, defaults: durableDefaults, providers: list })
    }
  }

  const disposers = new Map<string, () => void>()

  /** Live workspace mode state, lazily initialized on first selection. */
  const controls = new Map<WorkspaceId, WorkspaceControls>()
  const controlsFor = (workspaceId: WorkspaceId): WorkspaceControls => {
    let state = controls.get(workspaceId)
    if (state === undefined) {
      const bundledDefault = BUNDLED_DEFAULT()
      state = {
        modeId: DEFAULT_MODE_ID,
        modeRevision: 1,
        modeDefinition: { definition: bundledDefault, source: 'bundled' },
      }
      controls.set(workspaceId, state)
    }
    return state
  }

  const instantiate = (entry: ProviderConfig): LlmProvider =>
    new OpenAiCompletionsProvider({
      name: entry.id,
      apiKey: entry.apiKey,
      baseUrl: entry.baseUrl,
      ...(entry.models.length > 0 ? { models: entry.models } : {}),
    })

  const injectionNames = (): readonly string[] =>
    (options.providers ?? []).map((provider) => provider.name)

  // A key is not part of usability: local gateways (llama.cpp, LM Studio, a
  // proxy on localhost) serve the OpenAI shape with no auth at all.
  const isUsableConfigured = (entry: ProviderConfig): boolean => entry.enabled

  const usableIds = (): readonly string[] => [
    ...injectionNames(),
    ...list.filter(isUsableConfigured).map((entry) => entry.id),
  ]

  const repairGlobalDefaults = (candidate: ModelDefaults, candidateList: readonly ProviderConfig[] = list): ModelDefaults => {
    // Test/bin injected providers are a non-durable registry overlay and have
    // always taken precedence over on-disk configurations. Never let an old
    // disk selection point a host using that explicit overlay elsewhere.
    const injectedProviders = options.providers ?? []
    if (injectedProviders.length > 0) {
      const selected = injectedProviders.find((provider) => provider.name === candidate.provider)
      if (selected !== undefined && candidate.model !== null && (selected.models ?? []).includes(candidate.model)) return candidate
      for (const provider of injectedProviders) {
        const model = provider.models?.[0]
        if (model !== undefined) return { provider: provider.name, model, thinkingLevel: candidate.thinkingLevel }
      }
    }
    if (candidate.provider !== null && candidate.model !== null) {
      const configured = candidateList.find((entry) => entry.id === candidate.provider)
      if (configured?.enabled && configured.models.includes(candidate.model)) return candidate
    }
    return repairDefaults(candidate, candidateList)
  }

  /** Re-register every provider source; called after any registry mutation. */
  const syncRegistrations = (): void => {
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    for (const provider of options.providers ?? []) {
      disposers.set(provider.name, kernel.ctx.llm.register(provider))
    }
    for (const entry of list) {
      if (!isUsableConfigured(entry) || disposers.has(entry.id)) continue
      disposers.set(entry.id, kernel.ctx.llm.register(instantiate(entry)))
    }
  }

  const validateProviderModel = (providerId: string, model?: string): { provider: string; model: string | undefined } => {
    const id = providerId
    if (id === '' || !usableIds().includes(id)) throw new Error(`no usable provider '${providerId}'`)
    const available = kernel.ctx.llm.providerModels(id)
    if (model !== undefined && available.length > 0 && !available.includes(model)) {
      throw new Error(`unknown model '${model}' for provider '${id}'; available: ${available.join(', ')}`)
    }
    return { provider: id, model }
  }

  syncRegistrations()
  durableDefaults = repairGlobalDefaults(durableDefaults)
  defaults = durableDefaults
  // Historical activeModel was an in-memory startup choice. Preserve that
  // behavior deliberately: it overrides this process only and is never
  // written back over the operator's durable global default.
  if (options.activeModel !== undefined) {
    const provider = options.activeModel.provider ?? defaults.provider
    const model = options.activeModel.model ?? defaults.model
    if (provider === null || model === null || provider === undefined || model === undefined) {
      throw new Error('activeModel needs a complete provider/model pair when no durable default exists')
    }
    validateProviderModel(provider, model)
    runtimeModelOverride = { provider, model }
    defaults = { provider, model, thinkingLevel: durableDefaults.thinkingLevel }
  }
  /** Ensure workspace policy/mode controls exist; model defaults are global. */
  const seedWorkspaceControls = (workspaceId: WorkspaceId, _seed?: { provider?: string; model?: string }): void => {
    controlsFor(workspaceId)
  }
  seedWorkspaceControls(options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE, options.activeModel)


  interface EffectiveSessionModel {
    readonly provider: string | null | undefined
    readonly model: string | null | undefined
    /** `null` delegates to the selected model's configured default. */
    readonly thinkingLevel: string | null | undefined
    readonly source: 'session' | 'global'
  }

  const resolveEffectiveModel = (session: Session, workspaceId: WorkspaceId): EffectiveSessionModel => {
    const preference = sessionModelOf(session.events)
    // A session/model event is a complete ownership boundary. In particular,
    // snapshot null is an explicit blank — it must never re-inherit a later
    // global choice. Only a legacy log (hasEvent false) live-inherits global
    // defaults. A delegated child carries its own stamped event, so the pair
    // it runs on resolves here like any other session's.
    const provider = preference.hasEvent ? preference.provider : defaults.provider
    const model = preference.hasEvent ? preference.model : defaults.model
    // Explicit null means configured model default, whereas an omitted field
    // in a session update intentionally retains its previous value.
    const thinkingLevel = preference.hasEvent ? preference.thinkingLevel : defaults.thinkingLevel
    return { provider, model, thinkingLevel, source: preference.hasEvent ? 'session' : 'global' }
  }

  /**
   * The pair a delegated child runs on: the caller's choice, else the role's
   * own `model:`, else the parent conversation's selection. Resolved here and
   * stamped into the child's log at spawn, so the child never re-inherits a
   * later global default and a role may name a model that lives on a
   * different provider than its parent.
   */
  const childModelFor = (
    parent: Session,
    workspaceId: WorkspaceId,
    requested?: string,
    definitionModel?: string,
  ): ChildModel | undefined =>
    resolveChildModel(requested, definitionModel, {
      parent: resolveEffectiveModel(parent, workspaceId),
      providers: usableIds(),
      modelsOf: (provider) => kernel.ctx.llm.providerModels(provider),
      // Provider/model validation already reports what is available; it just
      // has to reach the caller as a 400/tool failure, not a host error.
      validate: (provider, model) => {
        try {
          validateProviderModel(provider, model)
        } catch (error) {
          throw new ChildModelError(String(error instanceof Error ? error.message : error))
        }
      },
    })

  // ── per-session entries ──────────────────────────────────────
  const sessions = new Map<SessionId, SessionEntry>()
  // A failed session/model durability barrier leaves an in-memory event that
  // cannot truthfully be served. Fence the session until host restart/reload.
  const unavailableSessions = new Set<SessionId>()

  // Legacy folder grants (memory mode only), scoped to THIS server.
  const legacyFolders = new Map<SessionId, string | undefined>()
  const legacyFolderDefault = { current: options.root }

  // The file-tool grant resolves per execution from the ambient scope: the
  // bound project's folder — or, in memory mode, the server root. A
  // workspace-mode session without a project has NO filesystem grant.
  kernel.ctx.tools.setRootResolver(() => {
    const scope = agentScope.getStore()
    if (scope?.projectId !== undefined) {
      try {
        const project = workspaces.getProject(scope.projectId, scope.workspaceId)
        return {
          root: project.path,
          ...(deniedRoots !== undefined ? { deniedRoots } : {}),
        }
      } catch {
        return undefined
      }
    }
    // Memory mode: legacy folder grants (per-session override, then the
    // server's current default, then the configured root).
    if (deniedRoots === undefined && scope !== undefined) {
      const granted = legacyFolders.get(scope.sessionId) ?? legacyFolderDefault.current
      if (granted !== undefined) return { root: granted }
    }
    return undefined
  })

  for (const tool of fsTools()) {
    kernel.ctx.tools.register(tool)
  }
  kernel.ctx.tools.register(bashTool({ timeoutMs: limits.toolTimeoutMs }))

  // Writer coordination (G2): one write-capable TURN per project folder.
  // The first write-capable gate acquires the root; it is HELD until the
  // turn settles (`agent/turn-settled` fires on every terminalization), so
  // two turns cannot interleave writes between tool calls. Direct
  // executions outside a running agent keep the per-call shape.
  // Application-local only — external editors and unrestricted shell
  // writes elsewhere are outside its reach (documented, not claimed away).
  const WRITE_CAPABLE = new Set(['Write', 'Edit', 'Bash'])
  const heldLeases = new Map<SessionId, Set<string>>() // sessionId -> roots
  kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    if (!WRITE_CAPABLE.has(payload.call.name) || payload.exec.root === '') return next()
    const sessionId = agentScope.getStore()?.sessionId
    if (sessionId === undefined) return next()
    const perTurn = heldLeases.get(sessionId as SessionId)
    if (perTurn?.has(payload.exec.root) === true) return next() // already held for this turn
    try {
      await workspaces.acquireRoot(payload.exec.root, sessionId)
    } catch (error) {
      if (error instanceof ScopeError) {
        return { kind: 'deny', reason: `project busy: ${error.message}` }
      }
      throw error
    }
    const entry = sessions.get(sessionId as SessionId)
    if (entry !== undefined && entry.agent.busy) {
      // Inside a live turn: hold the lease until the turn settles.
      const sid = sessionId as SessionId
      const held = heldLeases.get(sid) ?? new Set<string>()
      held.add(payload.exec.root)
      heldLeases.set(sid, held)
      return next()
    }
    try {
      return await next()
    } finally {
      await workspaces.releaseRoot(payload.exec.root, sessionId)
    }
  })
  kernel.ctx.on('agent/turn-settled', async (state) => {
    void state
    // The event fires inside the agent scope: release exactly the settling
    // session's leases.
    const sessionId = agentScope.getStore()?.sessionId
    if (sessionId === undefined) return
    const roots = heldLeases.get(sessionId)
    if (roots === undefined) return
    for (const root of roots) {
      await workspaces.releaseRoot(root, sessionId)
    }
    heldLeases.delete(sessionId)
  })

  // G4 writer handoff: when a write-capable child spawns, the root's held
  // leases release at this safe boundary so the child cannot deadlock on a
  // lease its parent still holds while waiting for it.
  kernel.ctx.on('agent/child-writer-handoff', async (payload) => {
    const roots = heldLeases.get(payload.rootSessionId)
    if (roots === undefined) return
    for (const root of roots) {
      await workspaces.releaseRoot(root, payload.rootSessionId)
    }
    heldLeases.delete(payload.rootSessionId)
  })

  // Turn-local skill snapshots: the FIRST load in a turn pins content and
  // hash for the whole turn — external edits apply to FUTURE loads, never
  // to a running turn (no mid-turn hot reload). Cleared at turn-settled.
  const skillSnapshots = new Map<SessionId, Map<string, ActiveSkill>>()
  kernel.ctx.on('agent/turn-settled', async () => {
    const settled = agentScope.getStore()?.sessionId
    if (settled !== undefined) {
      skillSnapshots.delete(settled)
      // A root turn's per-turn spawn budget ends with the turn.
      childExecutor.releaseTurns(settled)
    }
  })

  // Automatic compaction (G3): when enabled, a completed boundary whose
  // projected log exceeds the threshold compacts once. Failures surface
  // (console) and never loop — the next boundary may try again.
  kernel.ctx.on('agent/turn-settled', async () => {
    if (limits.automaticCompactionChars <= 0) return
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.workspaceId === undefined) return
    try {
      const entry = depsRef.current?.sessions.get(scope.sessionId)
      if (entry === undefined) return
      const projected = entry.session.events.reduce((total, event) => {
        const text = (event as { content?: string; output?: string }).content ?? (event as { output?: string }).output ?? ''
        return total + text.length
      }, 0)
      if (projected < limits.automaticCompactionChars) return
      const latest = await checkpoints.latest(scope.sessionId).catch(() => undefined)
      if (latest !== undefined && latest.coversSeq >= (entry.session.events[entry.session.events.length - 1]?.seq ?? 0)) return
      const { compactSession } = await import('../harness/context/compaction.ts')
      await compactSession(entry.session, checkpoints, async ({ text }) => {
        const lines = text.split('\n').filter((line) => line.trim() !== '')
        return lines.slice(0, 120).join('\n')
      }, (() => { const model = deps.defaults().model; return model !== null ? { trigger: 'automatic' as const, model } : { trigger: 'automatic' as const } })())
    } catch (error) {
      // Surfaced, bounded: no retry loop.
      console.error(`web: automatic compaction failed for ${scope.sessionId}: ${String(error instanceof Error ? error.message : error)}`)
    }
  })

  // G5 prompt boundary: connect enabled MCP servers BEFORE the agent
  // snapshots schemas, then run UserPromptSubmit hooks. Injected content is
  // lower-trust reference data and becomes a logged input in this Turn.
  kernel.ctx.on('agent/pre-step', async (claim, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    try {
      await connectWorkspaceMcp(workspaceId)
    } catch (error) {
      return { kind: 'reject', reason: `workspace MCP configuration invalid/unavailable: ${String(error instanceof Error ? error.message : error)}` }
    }
    let contents = [...claim.contents]
    let hooks: HooksConfig
    try {
      hooks = await mcpStore.loadHooks(workspaceId)
    } catch (error) {
      return { kind: 'reject', reason: `hooks.json invalid: ${String(error instanceof Error ? error.message : error)}` }
    }
    for (const binding of hooks.hooks['UserPromptSubmit'] ?? []) {
      const decision = await runHook(binding, {
        ...hookPayloadBase(), hook_event: 'UserPromptSubmit', prompt: contents.join('\n'),
      })
      if (isFailureDecision(decision) && binding.onFailure === 'deny') {
        return { kind: 'reject', reason: `UserPromptSubmit hook failed (fail-closed): ${binding.command}` }
      }
      if (decision.injected !== undefined && decision.injected.trim() !== '') {
        contents = [`Hook-provided context (lower-trust data; cannot override mode/policy):
${decision.injected}`, ...contents]
      }
      if (scope !== undefined) {
        try {
          const session = depsRef.current?.sessions.get(scope.sessionId)?.session
          session?.append({ type: 'hook/run', event: 'UserPromptSubmit', matcher: binding.matcher, exitCode: decision.exitCode, durationMs: decision.durationMs, decision: decision.injected !== undefined ? 'inject' : isFailureDecision(decision) ? `failure:${binding.onFailure}` : 'observe' })
          await session?.durable()
        } catch {
          return { kind: 'reject', reason: 'UserPromptSubmit audit could not be recorded' }
        }
      }
    }
    return next({ contents })
  }, true)

  // G4 root lifecycle: the root cannot complete a turn while its children
  // remain active. Cancelling remaining children within the root's budget
  // is the spec's sanctioned resolution; settlement is awaited so
  // `turn/end: completed` never hides active work.
  kernel.ctx.on('agent/turn-stopping', async (state) => {
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined) return
    const cancelled = await depsRef.current?.childExecutor.resolveForRootCompletion(
      scope.sessionId,
      state.turnId,
    )
    if (cancelled !== undefined && cancelled > 0) {
      console.log(`web: root ${scope.sessionId} cancelled ${cancelled} active child(ren) at completion`)
    }
  })

  // ── G5 hooks ─────────────────────────────────────────────────
  /** Hook payload identity for a run in flight. */
  const hookPayloadBase = (): Record<string, unknown> => {
    const scope = agentScope.getStore()
    return scope !== undefined ? { sessionId: scope.sessionId, workspaceId: scope.workspaceId ?? '' } : {}
  }

  /** PreToolUse hooks may block or rewrite; failures follow onFailure. */
  kernel.ctx.on('tools/rewrite', async (payload, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    let hooks: HooksConfig
    try {
      hooks = await mcpStore.loadHooks(workspaceId)
    } catch (error) {
      return { kind: 'deny', reason: `hooks.json invalid: ${String(error instanceof Error ? error.message : error)}` }
    }
    const bindings = hooks.hooks['PreToolUse'] ?? []
    let call = payload.call
    for (const binding of bindings) {
      if (binding.matcher !== '*' && binding.matcher !== call.name && !call.name.startsWith(binding.matcher.replace(/\*$/, ''))) continue
      const decision = await runHook(binding, {
        ...hookPayloadBase(),
        hook_event: 'PreToolUse',
        tool: call.name,
        args: call.args,
      })
      // Durable audit BEFORE authorization/side effects. If the security-
      // relevant decision cannot be recorded, fail closed.
      if (scope !== undefined) {
        try {
          const session = depsRef.current?.sessions.get(scope.sessionId)?.session
          session?.append({
            type: 'hook/run', event: 'PreToolUse', matcher: binding.matcher,
            exitCode: decision.exitCode, durationMs: decision.durationMs,
            decision: isBlockingDecision(decision) ? 'block' : isFailureDecision(decision) ? `failure:${binding.onFailure}` : decision.updatedInput !== undefined ? 'rewrite' : 'allow',
          })
          await session?.durable()
        } catch {
          return { kind: 'deny', reason: 'PreToolUse audit could not be recorded (fail-closed)', call }
        }
      }
      if (isBlockingDecision(decision)) {
        return { kind: 'deny', reason: `hook ${binding.command} blocked '${call.name}'`, call }
      }
      if (isFailureDecision(decision) && binding.onFailure === 'deny') {
        return { kind: 'deny', reason: `hook ${binding.command} failed (fail-closed)`, call }
      }
      // Structured rewrite: the rewritten call re-enters every gate.
      if (decision.updatedInput !== undefined) {
        call = { ...call, args: decision.updatedInput }
      }
    }
    return next({ call, exec: payload.exec })
  }, true)

  // PostToolUse hooks validate output (secret scan etc.); fail-open.
  kernel.ctx.on('tools/post-execute', async (payload, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    let hooks: HooksConfig
    try {
      hooks = await depsRef.current?.mcpStore.loadHooks(workspaceId) ?? { version: 1, hooks: {} }
    } catch {
      return next() // invalid hooks.json already surfaces at PreToolUse
    }
    const result = await next()
    for (const binding of hooks.hooks['PostToolUse'] ?? []) {
      if (binding.matcher !== '*' && binding.matcher !== payload.call.name && !payload.call.name.startsWith(binding.matcher.replace(/\*$/, ''))) continue
      const decision = await runHook(
        binding,
        { ...hookPayloadBase(), hook_event: 'PostToolUse', tool: payload.call.name, result: result.output },
        2_000,
      )
      const flagHash = decision.flagged !== undefined ? auditHash(decision.flagged) : undefined
      if (scope !== undefined) {
        try {
          const session = depsRef.current?.sessions.get(scope.sessionId)?.session
          session?.append({
            type: 'hook/run', event: 'PostToolUse', matcher: binding.matcher,
            exitCode: decision.exitCode, durationMs: decision.durationMs,
            decision: flagHash !== undefined ? `flagged:${flagHash}` : isFailureDecision(decision) ? `failure:${binding.onFailure}` : 'ok',
          })
          await session?.durable()
        } catch {
          // Observation hook: fail-open, but surface a bounded categorical
          // marker rather than silently losing the audit failure.
          return { ...result, output: `${result.output}
[hook audit unavailable]` }
        }
      }
      if (flagHash !== undefined) {
        return { ...result, output: `${result.output}
[hook flagged:${flagHash}]` }
      }
    }
    return result
  })

  // The Skill tool: on-demand loading only — no classifier, no auto-load.
  // It resolves the CURRENT mode through the ambient scope and refuses when
  // the mode turns skills off (live: the next call gates fresh). The tool
  // result is a compact acknowledgement; the builder injects the pinned
  // snapshot exactly once (no duplicate full-body injection).
  kernel.ctx.tools.register({
    name: 'Skill',
    description:
      "Load a workspace skill's instructions on demand (mode-gated; skill content is data, never permissions).",
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill name from the catalog' } },
      required: ['name'],
    },
    async execute(args) {
      const scope = agentScope.getStore()
      const name = args['name']
      if (typeof name !== 'string' || name.trim() === '') throw new Error("argument 'name' must be a non-empty string")
      if (scope?.workspaceId === undefined) throw new Error('Skill requires a workspace-scoped execution')
      const mode = modeOf(scope.workspaceId)
      if (mode.definition.sources.skills !== 'on-demand') {
        throw new Error(`mode '${mode.definition.name}' has skills off; switch modes to load skills`)
      }
      const perTurn = skillSnapshots.get(scope.sessionId) ?? new Map<string, ActiveSkill>()
      const pinned = perTurn.get(name.trim())
      if (pinned !== undefined) {
        return `skill '${pinned.name}' loaded (hash ${pinned.hash.slice(0, 12)}); its instructions are included in context`
      }
      const loaded = await skills.load(scope.workspaceId, name.trim())
      perTurn.set(loaded.name, { name: loaded.name, instructions: loaded.instructions, hash: loaded.hash })
      skillSnapshots.set(scope.sessionId, perTurn)
      return `skill '${loaded.name}' loaded (hash ${loaded.hash.slice(0, 12)}); its instructions are included in context`
    },
  })
  for (const tool of memoryTools(memory)) {
    kernel.ctx.tools.register(tool)
  }

  // G4 delegation for the model itself. Async by design: one step runs its
  // tool calls in sequence, so a blocking spawn would serialize children and
  // the executor's parallel capacity would go unused.
  kernel.ctx.tools.register(agentTool({
    definitions: agentDefinitions,
    executor: childExecutor,
    session: (sessionId) => scopedSession(sessionId),
    childModelFor,
    providers: () => usableIds(),
    modelsOf: (provider) => kernel.ctx.llm.providerModels(provider),
  }))

  /** Cancel/await an in-flight or connected server, then remove descriptors. */
  async function cancelMcpConnection(workspaceId: WorkspaceId, serverName: string): Promise<void> {
    const key = `${workspaceId}:${serverName}`
    mcpCancelled.add(key)
    const connecting = mcpConnecting.get(key)
    if (connecting !== undefined) {
      const client = await connecting.catch(() => undefined)
      await client?.disconnect().catch(() => {})
    }
    await mcpClients.get(key)?.disconnect().catch(() => {})
    mcpClients.delete(key)
    for (const descriptorKey of mcpDescriptors.keys()) {
      if (descriptorKey.startsWith(`${workspaceId}:mcp__${serverName}__`)) mcpDescriptors.delete(descriptorKey)
    }
  }

  async function journalFor(workspaceId: string): Promise<McpExecutionJournal> {
    const existing = journals.get(workspaceId)
    if (existing !== undefined) return existing
    const journal = new McpExecutionJournal(
      path.join(resourceHome, 'workspaces', workspaceId, 'mcp', 'executions.jsonl'),
      () => ownerLock.assertHeld(),
    )
    await journal.open()
    await journal.terminalizeUnresolved()
    journals.set(workspaceId, journal)
    return journal
  }

  async function fenceWorkspace(workspaceId: WorkspaceId): Promise<void> {
    mcpGeneration.set(workspaceId, generationOf(workspaceId) + 1)
    for (const key of mcpConnecting.keys()) {
      if (key.startsWith(`${workspaceId}:`)) mcpCancelled.add(key)
    }
    for (const [key, client] of [...mcpClients]) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      client.retire()
      await client.disconnect().catch(() => {})
      mcpClients.delete(key)
      mcpClientGeneration.delete(key)
    }
  }

  async function commitMcpConfig(workspaceId: WorkspaceId, next: McpConfig): Promise<void> {
    const target = mcpStore.mcpPath(workspaceId)
    const backup = await readFileIfPresent(target)
    const id = await mutations.begin({ mutation: 'config', workspaceId, target, backup })
    await fenceWorkspace(workspaceId)
    try {
      await mcpStore.saveMcp(workspaceId, next)
      await mutations.commit(id)
      configWatch.set(workspaceId, await fileDigest(workspaceId))
      drifted.delete(workspaceId)
    } catch (error) {
      await mutations.abort(id)
      throw error
    }
  }

  async function fileDigest(workspaceId: string): Promise<string> {
    try {
      const raw = await fs.readFile(mcpStore.mcpPath(workspaceId))
      return createHash('sha256').update(raw).digest('hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }

  /** An outside edit of mcp.json fences dispatch until Settings accepts the file. */
  async function observeConfig(workspaceId: string): Promise<void> {
    const hash = await fileDigest(workspaceId)
    const previous = configWatch.get(workspaceId)
    if (previous !== undefined && previous !== hash) {
      drifted.add(workspaceId)
      configWatch.set(workspaceId, hash)
      await fenceWorkspace(workspaceId as WorkspaceId)
      return
    }
    configWatch.set(workspaceId, hash)
  }

  async function acknowledgeDrift(workspaceId: string): Promise<void> {
    configWatch.set(workspaceId, await fileDigest(workspaceId))
    drifted.delete(workspaceId)
  }

  async function testMcpServer(workspaceId: WorkspaceId, serverName: string): Promise<readonly string[]> {
    const config = await mcpStore.loadMcp(workspaceId)
    const serverConfig = config.servers[serverName]
    if (serverConfig === undefined) throw new McpConfigError('not-found', `no MCP server '${serverName}'`)
    if (serverConfig.resourceLimits?.enforcement === 'hard') {
      const report = await containmentCapability()
      if (report.level !== 'hard') throw new McpTransportError(report.detail)
    }
    const secrets = await mcpStore.loadSecrets(workspaceId)
    const resolvedEnv: Record<string, string> = {}
    for (const [key, ref] of Object.entries(serverConfig.env ?? {})) {
      resolvedEnv[key] = resolveSecretRefs(ref, secrets, `connection test env.${key}`)
    }
    const resolvedHeaders: Record<string, string> = {}
    for (const [key, ref] of Object.entries(serverConfig.headers ?? {})) {
      resolvedHeaders[key] = resolveSecretRefs(ref, secrets, `connection test header.${key}`)
    }
    const secretRef = authSecretRef(serverConfig.auth)
    const bearerToken = secretRef === undefined ? undefined : resolveSecretRefs(secretRef, secrets, 'connection test auth')
    const client = new McpServerClient(serverName, serverConfig, { env: resolvedEnv, bearerToken, headers: resolvedHeaders }, () => {})
    try {
      const tools = await client.listTools()
      return tools.map((tool) => tool.name)
    } finally {
      await client.disconnect()
    }
  }

  /**
   * Bring one MCP server up and register its tools (effect-disposed via the
   * registry). A secret reference missing from secrets.json surfaces here.
   */
  async function ensureMcpServer(workspaceId: WorkspaceId, serverName: string): Promise<McpServerClient> {
    const key = `${workspaceId}:${serverName}`
    const currentGeneration = generationOf(workspaceId)
    const existing = mcpClients.get(key)
    if (existing !== undefined && mcpClientGeneration.get(key) !== currentGeneration) {
      existing.retire()
      void existing.disconnect()
      mcpClients.delete(key)
      mcpClientGeneration.delete(key)
    } else if (existing !== undefined && existing.state !== 'disabled') return existing
    const inFlight = mcpConnecting.get(key)
    if (inFlight !== undefined) return inFlight
    if (mcpHostClosing || mcpCancelled.has(key)) throw new McpTransportError(`MCP server '${serverName}' connection is cancelled`)
    // Publish the promise synchronously before the first await: exactly one
    // process/HTTP session exists per (workspace, server).
    const generationAtStart = generationOf(workspaceId)
    const connecting = (async (): Promise<McpServerClient> => {
      let client: McpServerClient | undefined
      try {
        const config = await mcpStore.loadMcp(workspaceId)
        const serverConfig: McpServerConfig | undefined = config.servers[serverName]
        if (serverConfig === undefined || !serverConfig.enabled) {
          throw new McpConfigError('not-found', `MCP server '${serverName}' is not enabled in this workspace`)
        }
        const secrets = await mcpStore.loadSecrets(workspaceId)
        const resolvedEnv: Record<string, string> = {}
        for (const [envKey, ref] of Object.entries(serverConfig.env ?? {})) {
          resolvedEnv[envKey] = resolveSecretRefs(ref, secrets, `mcp.json server '${serverName}' env.${envKey}`)
        }
        const resolvedHeaders: Record<string, string> = {}
        for (const [header, ref] of Object.entries(serverConfig.headers ?? {})) {
          resolvedHeaders[header] = resolveSecretRefs(ref, secrets, `mcp.json server '${serverName}' headers.${header}`)
        }
        const secretRef = authSecretRef(serverConfig.auth)
        const storedToken = serverConfig.auth?.type === 'managed_oauth'
          ? await oauth.accessToken(workspaceId, serverName)
          : undefined
        if (serverConfig.auth?.type === 'managed_oauth' && storedToken === undefined) {
          throw new McpTransportError(`MCP server '${serverName}' requires managed OAuth authorization`)
        }
        const bearerToken = storedToken ?? (secretRef === undefined
          ? undefined
          : resolveSecretRefs(secretRef, secrets, `mcp.json server '${serverName}' auth`))
        client = new McpServerClient(serverName, serverConfig, { env: resolvedEnv, bearerToken, headers: resolvedHeaders }, (event) => {
          // Redacted diagnostics: category/server only — no server-returned
          // raw error detail or secret-bearing payload.
          if (event.isError) console.warn(`mcp [${serverName}] ${event.kind}: operation failed`)
        })
        if (mcpCancelled.has(key) || generationAtStart !== generationOf(workspaceId)) {
          throw new McpTransportError(`MCP server '${serverName}' connection was cancelled before start`)
        }
        mcpClients.set(key, client)
        mcpClientGeneration.set(key, generationAtStart)
        await client.listTools()
        await reconcileMcpTools(workspaceId, serverName, client)
        client.startHealthChecks(async () => {
          await reconcileMcpTools(workspaceId, serverName, client as McpServerClient)
        })
        const latest = await mcpStore.loadMcp(workspaceId)
        if (mcpHostClosing || mcpCancelled.has(key) || generationAtStart !== generationOf(workspaceId) || latest.servers[serverName]?.enabled !== true) {
          await client.disconnect()
          throw new McpTransportError(`MCP server '${serverName}' connection was cancelled before publication`)
        }
        mcpClients.set(key, client)
        mcpClientGeneration.set(key, generationAtStart)
        return client
      } catch (error) {
        await client?.disconnect().catch(() => {})
        if (client !== undefined && mcpClients.get(key) === client) {
          mcpClients.delete(key)
          mcpClientGeneration.delete(key)
        }
        throw error
      } finally {
        mcpConnecting.delete(key)
      }
    })()
    mcpConnecting.set(key, connecting)
    return connecting
  }

  
/**
 * An omitted or empty allowedTools list exposes every tool the server
 * discovered. A non-empty list is an exposure filter, not a permission grant.
 * Names may be the server tool or the public mcp__server__tool name.
 */
function mcpToolExposed(allowed: readonly string[] | undefined, toolName: string, fullName: string): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  return allowed.includes(toolName) || allowed.includes(fullName)
}

/** Register `mcp__server__tool` tools through the effect-disposed seam. */
  async function reconcileMcpTools(workspaceId: WorkspaceId, serverName: string, client: McpServerClient): Promise<void> {
    const config = await mcpStore.loadMcp(workspaceId)
    const serverConfig: McpServerConfig | undefined = config.servers[serverName]
    const allowed = serverConfig?.allowedTools
    const currentFullNames = new Set(client.cachedTools().map((tool) => mcpToolName(serverName, tool.name)))
    // Remove tools that disappeared from the latest tools/list snapshot.
    for (const key of mcpDescriptors.keys()) {
      if (!key.startsWith(`${workspaceId}:mcp__${serverName}__`)) continue
      const fullName = key.slice(`${workspaceId}:`.length)
      if (!currentFullNames.has(fullName)) mcpDescriptors.delete(key)
    }
    const seenNames = new Set<string>()
    for (const tool of client.cachedTools()) {
      if (tool.name.trim() === '' || seenNames.has(tool.name)) {
        throw new McpConfigError('invalid', `MCP server '${serverName}' returned duplicate/empty tool name '${tool.name}'`)
      }
      seenNames.add(tool.name)
      const fullName = mcpToolName(serverName, tool.name)
      if (RESERVED_TOOL_NAMES.has(fullName) || RESERVED_TOOL_NAMES.has(tool.name)) {
        throw new McpConfigError('reserved-name', `tool name '${fullName}' collides with a reserved built-in identity`)
      }
      if (!mcpToolExposed(allowed, tool.name, fullName)) continue
      // Server annotation: interaction always asks via forceAsk; readOnlyHint
      // is display only and NEVER drives auto-allow. Do not write into the
      // workspace override map — that would fight Always-allow and persist.
      mcpDescriptors.set(`${workspaceId}:${fullName}`, tool)
      if (mcpRegistered.has(fullName)) continue
      mcpRegistered.add(fullName)
      kernel.ctx.tools.register({
        name: fullName,
        description: `[MCP:${serverName}] ${tool.description ?? tool.name}${tool.requiresUserInteraction === true ? ' (interactive — always asks)' : ''}`,
        requiresRoot: false,
        parameters: tool.inputSchema as { type: 'object'; properties: Record<string, unknown> },
        schema: () => {
          const scope = agentScope.getStore()
          if (scope?.workspaceId === undefined) return undefined
          const descriptor = mcpDescriptors.get(`${scope.workspaceId}:${fullName}`)
          if (descriptor === undefined) return undefined
          return {
            description: `[MCP:${serverName}] ${descriptor.description ?? descriptor.name}`,
            parameters: descriptor.inputSchema as { type: 'object'; properties: Record<string, unknown> },
          }
        },
        async execute(args, exec) {
          const scope = agentScope.getStore()
          if (scope?.workspaceId === undefined) {
            throw new Error(`MCP tool '${fullName}' requires a workspace-scoped execution`)
          }
          // Absolute workspace isolation: resolve the client from the
          // CURRENT immutable execution workspace, never the workspace that
          // first registered this public schema.
          await observeConfig(scope.workspaceId)
          if (drifted.has(scope.workspaceId)) {
            throw new Error(`MCP config for this workspace changed outside Settings. Reload it before calling tools.`)
          }
          const scopedConfig = await mcpStore.loadMcp(scope.workspaceId)
          const scopedServer = scopedConfig.servers[serverName]
          if (scopedServer === undefined || !scopedServer.enabled) {
            throw new Error(`MCP server '${serverName}' is not enabled in this workspace`)
          }
          const allowedHere = scopedServer.allowedTools
          if (!mcpToolExposed(allowedHere, tool.name, fullName)) {
            throw new Error(`MCP tool '${fullName}' is not exposed in this workspace`)
          }
          const scopedClient = await ensureMcpServer(scope.workspaceId, serverName)
          const timeoutMs = scopedServer.timeoutMs ?? 15_000
          const started = Date.now()
          const invocationId = exec.toolCallId && exec.toolCallId !== '' ? exec.toolCallId : randomUUID()
          const journal = await journalFor(scope.workspaceId)
          const dispatched = await dispatchToolCall({
            journal,
            intent: {
              invocationId,
              workspaceId: scope.workspaceId,
              server: serverName,
              tool: tool.name,
              argsHash: auditHash(args),
              generation: generationOf(scope.workspaceId),
              epoch: ownerLock.epoch,
              configRevision: scopedConfig.revision ?? 1,
              secretRevision: 1,
            },
            call: async () => {
              const result = await scopedClient.callTool(tool.name, args, timeoutMs, exec.signal)
              const text = JSON.stringify(result.content) ?? ''
              return { text, isError: result.isError }
            },
          }, auditFaultFile)
          const text = dispatched.output.length > 60_000
            ? `${dispatched.output.slice(0, 60_000)}\n… [truncated ${dispatched.output.length - 60_000} chars]`
            : dispatched.output
          const session = depsRef.current?.sessions.get(scope.sessionId)?.session
          if (session !== undefined) {
            session.append({
              type: 'mcp/call',
              server: serverName,
              tool: tool.name,
              argsHash: auditHash(args),
              resultHash: auditHash(text),
              durationMs: Date.now() - started,
              isError: dispatched.outcome !== 'success',
            })
            await session.durable().catch(() => undefined)
          }
          if (exec.toolCallId !== undefined && exec.toolCallId !== '') {
            stageMcpOutcome(exec.toolCallId, { outcome: dispatched.outcome, invocationId, ok: dispatched.outcome === 'success' })
          }
          return text
        },
      })
    }
  }

  /** Connect every enabled server for a workspace; invalid config surfaces. */
  async function connectWorkspaceMcp(workspaceId: WorkspaceId): Promise<void> {
    // Strict validation of all workspace-owned G5 config at the boundary.
    // Any invalid file rejects the Turn before model/tool execution — no
    // partial built-in execution with a broken MCP/hooks/secrets config.
    const config = await mcpStore.loadMcp(workspaceId)
    await mcpStore.loadHooks(workspaceId)
    await mcpStore.loadSecrets(workspaceId)
    for (const server of Object.values(config.servers)) {
      if (!server.enabled) continue
      await ensureMcpServer(workspaceId, server.name)
    }
  }

  /**
   * The workspace's CURRENT mode, resolved at selection and cached — mode
   * definition files are not hot-reloaded (G3); the cache is what gates,
   * assembles, and pins the manifest hash.
   */
  function modeOf(workspaceId: WorkspaceId): ResolvedMode {
    const state = controlsFor(workspaceId)
    return state.modeDefinition
  }

  /** Re-validate and adopt a mode file into the workspace's live control. */
  async function adoptMode(workspaceId: WorkspaceId, modeId: string): Promise<ResolvedMode> {
    const resolved = await modes.resolve(workspaceId, modeId)
    const state = controlsFor(workspaceId)
    state.modeId = modeId
    state.modeDefinition = resolved
    state.modeRevision += 1
    kernel.ctx.tools.bumpPolicyRevision()
    return resolved
  }

  // G3 tool gate: the mode's exposure is a HARD ceiling — the FIRST
  // pre-execute listener denies unexposed tools even from stale model
  // batches, before approval is ever consulted.
  kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    // Mandatory host restrictions are the outermost hard deny and never
    // pass through approval. Glob patterns are anchored (`*` = any chars).
    for (const pattern of options.blockedTools ?? []) {
      const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)
      if (regex.test(payload.call.name)) {
        return { kind: 'deny', reason: `host blockedTools denies '${payload.call.name}'` }
      }
    }
    const scope = agentScope.getStore()
    if (scope?.workspaceId === undefined) return next()
    const mode = modeOf(scope.workspaceId)
    const isMcp = payload.call.name.startsWith('mcp__')
    if (isMcp) {
      // G5 mode ceiling: Chat exposes none; Explorer sees none regardless
      // of grant/mode; Plan exposes none unless the workspace explicitly
      // allowlisted the full tool AND its name looks read-safe.
      if (mode.definition.id === 'chat') {
        return { kind: 'deny', reason: `mode 'Chat' exposes no MCP tools` }
      }
      if (scope.childOf?.definition === 'explorer') {
        return { kind: 'deny', reason: `Explorer exposes zero MCP tools` }
      }
      if (mode.definition.id === 'plan') {
        const parts = payload.call.name.split('__')
        const serverName = parts[1] ?? ''
        const toolName = parts.slice(2).join('__')
        const config = await mcpStore.loadMcp(scope.workspaceId)
        const allowed = config.servers[serverName]?.allowedTools
        const readSafe = /^(read|get|list|search|query|fetch|inspect|describe)/i.test(toolName)
        if (!readSafe || !mcpToolExposed(allowed, toolName, payload.call.name)) {
          return { kind: 'deny', reason: `mode 'Plan' does not expose MCP tool '${payload.call.name}' without a read-safe allowlist entry` }
        }
      }
    } else if (!mode.definition.toolExposure.includes(payload.call.name)) {
      return { kind: 'deny', reason: `mode '${mode.definition.name}' does not expose '${payload.call.name}'` }
    }
    // G4 one level: delegation is denied to a child before any ceiling or
    // approval is consulted, whatever its definition happens to list.
    if (scope.childOf !== undefined && payload.call.name === 'Agent') {
      return { kind: 'deny', reason: 'one-level delegation: a child agent cannot delegate' }
    }
    // G4 child ceiling: definition ∩ spawn grant narrows the mode's
    // exposure. A child can never gain a tool its definition lacks — even
    // if the parent later switches to Full access (spawn-time grants never
    // expand; Explorer cannot acquire Bash by a mode switch).
    if (scope.childOf !== undefined && !scope.childOf.toolCeiling.includes(payload.call.name)) {
      return {
        kind: 'deny',
        reason: `agent '${scope.childOf.definition}' does not expose '${payload.call.name}' (definition ceiling)`,
      }
    }
    return next()
  }, true)

  /** Last request's manifest per session — the inspector renders this. */
  const lastManifests = new Map<SessionId, ContextManifest>()
  /** Late-bound deps reference: listeners fire only after boot completes. */
  const depsRef: { current: HandlerDeps | undefined } = { current: undefined }

  /** Resolve a root or child session for a scoped request. Children are owned
   * by ChildExecutor rather than the web session-entry map. */
  async function scopedSession(sessionId: SessionId | undefined): Promise<Session | undefined> {
    if (sessionId === undefined) return undefined
    const loaded = depsRef.current?.sessions.get(sessionId)?.session
    if (loaded !== undefined) return loaded
    if (!kernel.ctx.sessions.has(sessionId)) return undefined
    return kernel.ctx.sessions.load(sessionId).catch(() => undefined)
  }

  /** The open turn's loaded skill names (tool/call events named Skill). */
  function skillsLoadedInTurn(events: readonly SessionEvent[] | undefined): string[] {
    if (events === undefined) return []
    let openTurnId: string | undefined
    const loaded: string[] = []
    for (const event of events) {
      if (event.type === 'turn/start') openTurnId = event.turnId
      else if (event.type === 'turn/end' && event.turnId === openTurnId) openTurnId = undefined
      else if (event.type === 'tool/call' && event.call.name === 'Skill' && openTurnId !== undefined) {
        const name = event.call.args['name']
        if (typeof name === 'string' && !loaded.includes(name)) loaded.push(name)
      }
    }
    return loaded
  }

  /** Workspace INSTRUCTIONS.md, plus the bound project's when present. */
  async function readWorkspaceInstructions(home: string, workspaceId: WorkspaceId, projectId: ProjectId | undefined): Promise<string> {
    const parts: string[] = []
    for (const file of [
      path.join(home, 'workspaces', workspaceId, 'INSTRUCTIONS.md'),
      ...(projectId !== undefined ? [path.join(home, 'workspaces', workspaceId, 'projects', projectId, 'INSTRUCTIONS.md')] : []),
    ]) {
      const text = await fs.readFile(file, 'utf8').catch(() => undefined)
      if (text !== undefined && text.trim() !== '') parts.push(text.trim())
    }
    return parts.join('\n\n')
  }

  // G3 single assembly path: the mode-driven builder replaces the projected
  // request wholesale. Effective permission is the selected mode's map; host
  // restrictions stay above it.
  kernel.ctx.on('agent/context', async (projected, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    const state = controlsFor(workspaceId)
    const session = await scopedSession(scope?.sessionId)
    const effective = session === undefined
      ? { provider: defaults.provider, model: defaults.model, thinkingLevel: defaults.thinkingLevel, source: 'global' as const }
      : resolveEffectiveModel(session, workspaceId)
    const mode = modeOf(workspaceId)

    // Budget from the CURRENT (provider, model) pair: an operator context
    // override is verified; anything else resolves the catalog's documented
    // window (exact ID → known family → 256k default) as a labeled estimate.
    // A live model change recomputes this on the very next request.
    const budget: ResolvedBudget = (() => {
      if (effective.provider === undefined || effective.provider === null || effective.model === undefined || effective.model === null) return DEFAULT_BUDGET
      // Child overrides share this resolver, so context, manifest budget, and
      // request dispatch all reject an unavailable effective pair identically.
      validateProviderModel(effective.provider, effective.model)
      const configured = list
        .find((entry) => entry.id === effective.provider)
        ?.modelSettings?.[effective.model]?.contextTokens
      if (configured !== undefined && Number.isFinite(configured) && configured > 0) {
        return { contextLimitTokens: configured, outputReserveTokens: DEFAULT_BUDGET.outputReserveTokens, marginTokens: DEFAULT_BUDGET.marginTokens, verified: true }
      }
      return { contextLimitTokens: resolveContextLimit(effective.model), outputReserveTokens: DEFAULT_BUDGET.outputReserveTokens, marginTokens: DEFAULT_BUDGET.marginTokens, verified: false }
    })()

    // Exposure-filtered schemas: static mode ceiling + G5 dynamic MCP
    // config/allowlist ceiling (Chat none; Plan read-safe allowlist only;
    // Explorer none; other children require explicit spawn grant).
    const workspaceMcpConfig = await mcpStore.loadMcp(workspaceId)
    let exposed = projected.tools?.filter((schema) => {
      // A child sees only its ceiling, and never the delegation tool: the
      // schemas it carries are exactly what its capability line advertises.
      if (scope?.childOf !== undefined && (schema.name === 'Agent' || !scope.childOf.toolCeiling.includes(schema.name))) return false
      if (!schema.name.startsWith('mcp__')) return mode.definition.toolExposure.includes(schema.name)
      const parts = schema.name.split('__')
      const serverName = parts[1] ?? ''
      const toolName = parts.slice(2).join('__')
      const server = workspaceMcpConfig.servers[serverName]
      if (server === undefined || !server.enabled) return false
      if (!mcpToolExposed(server.allowedTools, toolName, schema.name)) return false
      if (mode.definition.id === 'chat') return false
      if (scope?.childOf?.definition === 'explorer') return false
      if (scope?.childOf !== undefined && !scope.childOf.toolCeiling.includes(schema.name)) return false
      if (mode.definition.id === 'plan') {
        // readOnlyHint never auto-allows permission; Plan uses a conservative
        // name heuristic plus the explicit allowlist above for exposure.
        return /^(read|get|list|search|query|fetch|inspect|describe)/i.test(toolName)
      }
      return true
    }) ?? []
    // Workspace-level instructions load for ANY workspace-scoped session;
    // project instructions join when a project is bound.
    const workspaceInstructions =
      scope?.workspaceId !== undefined && mode.definition.sources.workspaceInstructions
        ? await readWorkspaceInstructions(resourceHome, scope.workspaceId, scope.projectId).catch(() => undefined)
        : undefined

    // Turn-local active skills: the pinned snapshots from this turn's
    // Skill loads — NOT fresh reads, so external edits mid-turn never
    // change what a running turn sees (hash-pinned, no hot reload).
    const activeSkills: ActiveSkill[] = []
    if (mode.definition.sources.skills === 'on-demand' && scope !== undefined) {
      const perTurn = skillSnapshots.get(scope.sessionId) ?? new Map<string, ActiveSkill>()
      // Definition skills preload ONCE for this child Turn, then remain
      // hash-pinned like explicit Skill loads (no mid-turn file reload).
      for (const name of scope.childOf?.skills ?? []) {
        if (perTurn.has(name)) continue
        try {
          const loaded = await skills.load(workspaceId, name)
          perTurn.set(name, { name: loaded.name, instructions: loaded.instructions, hash: loaded.hash })
        } catch {
          // An invalid/missing definition skill surfaces as an omission in
          // the manifest rather than broadening authority.
        }
      }
      if (perTurn.size > 0) skillSnapshots.set(scope.sessionId, perTurn)
      activeSkills.push(...perTurn.values())
    }

    // Pinned memory within scope (project scope when bound).
    const pinnedMemory: MemorySnippet[] = []
    if (mode.definition.sources.memoryPinned && scope?.workspaceId !== undefined) {
      try {
        const entries = await memory.pinned(
          scope.projectId !== undefined
            ? { workspaceId: scope.workspaceId, projectId: scope.projectId }
            : { workspaceId: scope.workspaceId },
        )
        for (const entry of entries.slice(0, 20)) {
          pinnedMemory.push({ id: entry.id, title: entry.title, body: entry.body, hash: entry.hash })
        }
      } catch {
        // Memory failures degrade to omission, never to a wrong request.
      }
    }

    // Compaction summaries only apply when the mode's history reads them.
    let compaction: { summary: string; coversSeq: number } | undefined
    if (mode.definition.sources.history === 'compact' && scope !== undefined) {
      const checkpoint = await checkpoints.latest(scope.sessionId).catch(() => undefined)
      if (checkpoint !== undefined) compaction = { summary: checkpoint.summary, coversSeq: checkpoint.coversSeq }
    }

    const events = session?.events ?? []
    // Attachment bytes are read once per request and cached by the store: the
    // log holds references, and the model needs the content itself.
    const referenced = events.flatMap((event) => (event.type === 'user/message' ? [...(event.attachments ?? [])] : []))
    const loadedAttachments = referenced.length > 0
      ? await attachments.load(workspaceId, referenced, { textLimit: limits.attachmentTextLimit })
      : undefined

    const assembled = buildContext({
      events,
      mode,
      modeRevision: state.modeRevision,
      model: effective.model ?? undefined,
      providerName: effective.provider ?? undefined,
      schemas: exposed,
      ...(workspaceInstructions !== undefined && workspaceInstructions !== '' ? { workspaceInstructions } : {}),
      activeSkills,
      pinnedMemory,
      budget,
      ...(compaction !== undefined ? { compaction } : {}),
      ...(loadedAttachments !== undefined ? { attachments: loadedAttachments } : {}),
      ...(scope?.childOf !== undefined
        ? { child: { definition: scope.childOf.definition, instructions: scope.childOf.instructions } }
        : {}),
      ...(scope?.childOf?.inheritedContext !== undefined ? { inheritedContext: scope.childOf.inheritedContext } : {}),
    })
    if (scope !== undefined) lastManifests.set(scope.sessionId, assembled.manifest)
    // Replace wholesale: when the mode exposes nothing, tools must LEAVE the
    // request — a spread of `projected` would resurrect the full schema list.
    const replacement: typeof projected = { ...projected, messages: assembled.messages }
    if (assembled.tools !== undefined) {
      return next({ ...replacement, tools: assembled.tools })
    }
    const { tools: _dropped, ...withoutTools } = replacement
    void _dropped
    return next(withoutTools)
  }, true)

  // Live model + provider control, scoped to the executing turn's
  // workspace: every step's request is stamped with that workspace's pair.
  // The provider rides as trusted execution metadata — dispatch resolves it
  // by id, never through the process-global selection pointer, so two
  // workspaces on different providers cannot cross streams.
  kernel.ctx.on('agent/request', async (request, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    const state = controlsFor(workspaceId)
    const session = await scopedSession(scope?.sessionId)
    const effective = session === undefined
      ? { provider: defaults.provider, model: defaults.model, thinkingLevel: defaults.thinkingLevel }
      : resolveEffectiveModel(session, workspaceId)
    const model = effective.model ?? undefined
    const provider = effective.provider ?? undefined
    if (provider !== undefined && model !== undefined) validateProviderModel(provider, model)
    // Explicit null session thinking deliberately falls through to this
    // model's configured default, never back to workspace thinking.
    const thinkingLevel = effective.thinkingLevel
      ?? (model !== undefined && provider !== undefined
        ? list.find((entry) => entry.id === provider)?.modelSettings?.[model]?.thinkingLevel
        : undefined)
    return next({
      ...request,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { providerName: provider } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    })
  })

  const pending = new Map<string, PendingApproval>()

  const dangerousStore = new DangerousCommandsStore(resourceHome)
  const dangerousGuard = attachDangerousCommandGuard(kernel.ctx, {
    configSource: async (workspaceId?: string) => {
      const wid = workspaceId
        ?? (agentScope.getStore()?.workspaceId as string | undefined)
        ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE) as string
      const { config } = await dangerousStore.load(wid)
      return config
    },
  })

  const approvalHandle: ApprovalHandle = attachApproval(kernel.ctx, {
    // Live permission control, scoped to the executing turn's workspace.
    // The selected mode is the single policy source; host restrictions and the
    // mode's exposure ceiling are enforced separately at the gate.
    policy: () => {
      const scope = agentScope.getStore()
      const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
      const state = controlsFor(workspaceId)
      return effectivePolicy(state.modeDefinition.definition.permissionDefaults, options.yolo === true)
    },
    defaultMode: options.defaultMode ?? 'ask',
    expiryMs: limits.approvalExpiryMs,
    forceAsk: (call) =>
      dangerousGuard.getMatch(call)?.action === 'ask' ||
      toolRequiresInteraction(call, agentScope.getStore()?.workspaceId, mcpDescriptors),
    askUser: (call, lifecycle) =>
      new Promise<boolean>((resolve) => {
        const scope = agentScope.getStore()
        if (scope === undefined) {
          // No agent in flight: fail closed rather than guessing a session.
          resolve(false)
          return
        }
        // One id everywhere: the durable log, the SSE frame, and this map
        // must agree, or log-derived questions POST 404s.
        const approvalId = lifecycle.approvalId
        const guardMatch = dangerousGuard.getMatch(call)
        const guardWarning = guardMatch?.action === 'ask'
          ? `Dangerous Commands: matched ${guardMatch.presetId ?? guardMatch.ruleId ?? 'rule'} — ${guardMatch.reason}`
          : undefined
        const workspaceId = (scope.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)) as WorkspaceId
        const interactive = toolRequiresInteraction(call, scope.workspaceId, mcpDescriptors)
        const parentSessionId = scope.childOf?.parentSessionId
        const definitionName = scope.childOf?.definition
        const principalId = sessionPrincipals.get(scope.sessionId)
        pending.set(approvalId, {
          sessionId: scope.sessionId,
          workspaceId,
          ...(principalId !== undefined ? { principalId } : {}),
          call,
          interactive,
          expiresAt: lifecycle.expiresAt,
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          ...(definitionName !== undefined ? { definitionName } : {}),
          ...(guardWarning !== undefined ? { guardWarning } : {}),
          resolve,
        })
        // Expiry, stop, or a policy change settles the approval without an
        // answer: retire the question so reconnects never replay it and a
        // late POST /api/approvals gets the truthful 404.
        void lifecycle.done.then(() => {
          if (pending.delete(approvalId)) resolve(false)
          kernel.ctx.emit('web/approval-settled', {
            sessionId: scope.sessionId,
            approvalId,
            ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          })
        })
        kernel.ctx.emit('web/approval', {
          sessionId: scope.sessionId,
          approvalId,
          call,
          expiresAt: lifecycle.expiresAt,
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          ...(definitionName !== undefined ? { definitionName } : {}),
          ...(interactive ? { interactive: true } : {}),
          ...(guardWarning !== undefined ? { guardWarning } : {}),
        })
      }),
  })

  /**
   * Serialize every provider/default mutation. The derivation reads canonical
   * state only after its predecessor commits; disk commit precedes publication.
   * Llm registration/disposal is synchronous and non-throwing by the Kernel
   * contract, so registration publication cannot invalidate a committed store.
   */
  let providerTransactionTail: Promise<void> = Promise.resolve()
  const mutateProviderStore = async <T>(
    derive: (current: { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults }) => { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly result: T } | Promise<{ readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly result: T }>,
    transactionOptions?: { readonly clearRuntimeModelOverride?: boolean },
  ): Promise<T> => {
    let release: (() => void) | undefined
    const predecessor = providerTransactionTail
    providerTransactionTail = new Promise<void>((resolve) => { release = resolve })
    await predecessor
    try {
      const derived = await derive({ providers: list, defaults: durableDefaults })
      const repaired = repairGlobalDefaults(derived.defaults, derived.providers)
      await (options.providerStoreWriter ?? saveProviderStore)(configFile, { version: 2, defaults: repaired, providers: derived.providers })
      list = [...derived.providers]
      durableDefaults = repaired
      if (transactionOptions?.clearRuntimeModelOverride === true) runtimeModelOverride = undefined
      // The process-local startup override is valid only while its selected
      // configured provider remains enabled and advertises that exact model.
      // This publication happens only after the coherent store is committed;
      // failed writes leave both the override and live registry untouched.
      if (runtimeModelOverride !== undefined) {
        const override = runtimeModelOverride
        const selected = list.find((entry) => entry.id === override.provider)
        const injected = (options.providers ?? []).find((provider) => provider.name === override.provider)
        const validConfigured = selected !== undefined && selected.enabled && selected.models.includes(override.model)
        const validInjected = selected === undefined && injected !== undefined && (injected.models ?? []).includes(override.model)
        if (!validConfigured && !validInjected) runtimeModelOverride = undefined
      }
      defaults = runtimeModelOverride === undefined
        ? durableDefaults
        : { ...runtimeModelOverride, thinkingLevel: durableDefaults.thinkingLevel }
      syncRegistrations()
      return derived.result
    } finally {
      release?.()
    }
  }

  const staticDir = options.staticDir
    ?? fileURLToPath(new URL('../../web-dist/', import.meta.url))

  // Terminals are a web-host resource: they touch no kernel service, emit no
  // durable event, and are constructed here only so shutdown can reach them.
  const terminals = createTerminalService(
    options.terminals?.spawner !== undefined ? { spawner: options.terminals.spawner } : {},
  )
  const terminalsEnabled = options.terminals?.enabled ?? true
  // Resolved, not passed through: hosts are commonly started with `--root .`,
  // and a terminal reporting its cwd as "." tells a client nothing about where
  // the shell actually opened.
  const terminalDefaultCwd = path.resolve(options.terminals?.defaultCwd ?? options.root ?? process.cwd())
  // The names this server answers to. A `Host` outside this set is refused
  // before routing, which is what actually stops a rebound DNS name from
  // reaching these APIs from a page the user merely visited.
  const allowedHosts: ReadonlySet<string> = new Set(
    ['127.0.0.1', '::1', 'localhost', boundHost, ...(options.allowedHosts ?? [])].map((value) =>
      value.trim().toLowerCase(),
    ),
  )

  const containment = await containmentCapability()
  const liveStreams: { principalId: string | undefined; close: () => void }[] = []
  const closeStreamsFor = (principalId: string): void => {
    for (const stream of [...liveStreams]) {
      if (stream.principalId === principalId) stream.close()
    }
  }

  const deps: HandlerDeps = {
    kernel,
    sessions,
    unavailableSessions,
    pending,
    staticDir,
    limits,
    approvalHandle,
    dangerousGuard,
    yolo: options.yolo === true,
    workspaces,
    controls,
    controlsFor,
    resolveEffectiveModel,
    validateProviderModel,
    deniedRoots,
    legacyFolders,
    legacyFolderDefault,
    seedWorkspaceControls,
    modes,
    skills,
    memory,
    attachments,
    checkpoints,
    lastManifests,
    adoptMode,
    agentDefinitions,
    childExecutor,
    childModelFor,
    mcpStore,
    mcpClients,
    mcpDescriptors,
    mcpConnecting,
    mcpCancelled,
    connectWorkspaceMcp,
    cancelMcpConnection,
    ensureMcpServer,
    dangerousStore,
    providers: () => list,
    defaults: () => defaults,
    setDefaults: (next) => { defaults = next },
    mutateProviderStore,
    publicSummary: () => list.map(publicProvider),
    terminals,
    terminalsEnabled,
    terminalsLoopback: loopbackBind,
    terminalDefaultCwd,
    allowedHosts,
    auth: new ControlPlaneAuthService({
      enabled: options.controlPlaneAuth === true,
      canonicalOrigin: 'http://127.0.0.1',
    }),
    commitMcpConfig,
    sessionPrincipals,
    oauth,
    generationOf,
    fenceWorkspace,
    closeStreamsFor,
    liveStreams,
    containmentDetail: containment.detail,
    auditFaultFile,
    observeConfig,
    acknowledgeDrift,
    testMcpServer,
    isDrifted: (workspaceId: string) => drifted.has(workspaceId),
    repairAudit: async (workspaceId: string) => {
      const journal = journals.get(workspaceId)
      if (journal?.faulted === true) {
        return { ok: false as const, error: 'execution journal is still faulted; repair the file before clearing the audit block' }
      }
      await clearAuditFault(auditFaultFile)
      return { ok: true as const }
    },
  }
  depsRef.current = deps

  const server = createServer((req, res) => {
    handle(req, res, deps).catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(error instanceof ScopeError ? 404 : 500, { 'content-type': 'application/json' })
      }
      res.end(JSON.stringify({ error: String(error) }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    await kernel.stop()
    await ownerLock.release()
    throw new Error('web: unexpected listen address')
  }

  // With durable storage, stored sessions become visible without loading
  // their histories; the histories load lazily on first touch. Child
  // relationships recover from durable child-meta records (G4): unfinished
  // children surface as interrupted, never re-executed.
  if (options.home !== undefined) {
    await kernel.ctx.sessions.boot()
    const recovered = await childExecutor.recoverFromStorage()
    if (recovered > 0) console.log(`web: recovered ${recovered} child relationship(s) from storage`)
  }

  const publicHost = options.host ?? '127.0.0.1'
  deps.auth.bindOrigin(`http://${publicHost}:${address.port}`)

  return {
    url: `http://${publicHost}:${address.port}`,
    port: address.port,
    kernel,
    auth: deps.auth,
    close: async () => {
      mcpHostClosing = true
      for (const key of mcpConnecting.keys()) mcpCancelled.add(key)
      await Promise.allSettled([...mcpConnecting.values()])
      // SSE connections never drain on their own — a browser holds its
      // EventSource open indefinitely — so close() would hang on them.
      // Force every connection down first, then wait for the listener.
      server.closeAllConnections()
      // PTYs are children of this process: leaving them running would orphan
      // a shell per terminal every time the host restarts.
      terminals.disposeAll()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      for (const client of mcpClients.values()) await client.disconnect()
      mcpClients.clear()
      await ownerLock.release()
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      await kernel.stop()
    },
  }
}

interface HandlerDeps {
  readonly kernel: Kernel
  readonly sessions: Map<SessionId, SessionEntry>
  readonly unavailableSessions: Set<SessionId>
  readonly pending: Map<string, PendingApproval>
  readonly staticDir: string
  readonly limits: HarnessLimits
  readonly approvalHandle: ApprovalHandle
  readonly dangerousGuard: ReturnType<typeof attachDangerousCommandGuard>
  readonly yolo: boolean
  readonly workspaces: WorkspaceService
  readonly controls: Map<WorkspaceId, WorkspaceControls>
  readonly controlsFor: (workspaceId: WorkspaceId) => WorkspaceControls
  readonly resolveEffectiveModel: (session: Session, workspaceId: WorkspaceId) => {
    provider: string | null | undefined
    model: string | null | undefined
    thinkingLevel: string | null | undefined
    source: 'session' | 'global'
  }
  readonly validateProviderModel: (providerId: string, model?: string) => { provider: string; model: string | undefined }
  readonly deniedRoots: readonly string[] | undefined
  readonly legacyFolders: Map<SessionId, string | undefined>
  readonly legacyFolderDefault: { current: string | undefined }
  readonly modes: ModesService
  readonly skills: SkillsService
  readonly memory: MemoryService
  readonly attachments: AttachmentStore
  readonly checkpoints: CheckpointStore
  readonly lastManifests: Map<SessionId, ContextManifest>
  readonly adoptMode: (workspaceId: WorkspaceId, modeId: string) => Promise<ResolvedMode>
  readonly agentDefinitions: AgentDefinitionService
  readonly childExecutor: ChildExecutor
  /** Resolves a child's pair: spawn choice > role definition > parent session. */
  readonly childModelFor: (
    parent: Session,
    workspaceId: WorkspaceId,
    requested?: string,
    definitionModel?: string,
  ) => ChildModel | undefined
  readonly mcpStore: McpConfigStore
  readonly mcpClients: Map<string, McpServerClient>
  readonly mcpDescriptors: Map<string, McpToolDescriptor>
  readonly mcpConnecting: Map<string, Promise<McpServerClient>>
  readonly mcpCancelled: Set<string>
  readonly connectWorkspaceMcp: (workspaceId: WorkspaceId) => Promise<void>
  readonly cancelMcpConnection: (workspaceId: WorkspaceId, serverName: string) => Promise<void>
  readonly ensureMcpServer: (workspaceId: WorkspaceId, serverName: string) => Promise<McpServerClient>
  readonly dangerousStore: DangerousCommandsStore
  readonly seedWorkspaceControls: (workspaceId: WorkspaceId, seed?: { provider?: string; model?: string }) => void
  readonly providers: () => readonly ProviderConfig[]
  readonly defaults: () => ModelDefaults
  readonly setDefaults: (next: ModelDefaults) => void
  readonly mutateProviderStore: <T>(derive: (current: { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults }) => { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly result: T } | Promise<{ readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly result: T }>, options?: { readonly clearRuntimeModelOverride?: boolean }) => Promise<T>
  readonly publicSummary: () => readonly PublicProvider[]
  readonly terminals: TerminalService
  readonly terminalsEnabled: boolean
  readonly terminalsLoopback: boolean
  readonly terminalDefaultCwd: string
  readonly allowedHosts: ReadonlySet<string>
  readonly auth: ControlPlaneAuthService
  readonly commitMcpConfig: (workspaceId: WorkspaceId, next: McpConfig) => Promise<void>
  readonly sessionPrincipals: Map<string, string>
  readonly oauth: ManagedOAuth
  readonly generationOf: (workspaceId: string) => number
  readonly fenceWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  readonly closeStreamsFor: (principalId: string) => void
  readonly liveStreams: { principalId: string | undefined; close: () => void }[]
  readonly containmentDetail: string
  readonly auditFaultFile: string
  readonly observeConfig: (workspaceId: string) => Promise<void>
  readonly acknowledgeDrift: (workspaceId: string) => Promise<void>
  readonly testMcpServer: (workspaceId: WorkspaceId, serverName: string) => Promise<readonly string[]>
  readonly isDrifted: (workspaceId: string) => boolean
  readonly repairAudit: (workspaceId: string) => Promise<{ ok: true } | { ok: false; error: string }>
}

/**
 * Cross-site write defence: a foreign page cannot READ our responses, but a
 * `text/plain` POST is not preflighted, so without this check any site the
 * user visits can drive the state-changing routes blind. Browsers send
 * `Origin` on every unsafe method, so an origin whose `host:port` is not
 * this server's is refused; a missing `Origin` (curl, tests, the CLI) is
 * left alone, and `null` (opaque origin) is refused.
 */
function crossSiteWrite(req: IncomingMessage): boolean {
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') return false
  const origin = req.headers.origin
  if (origin === undefined || origin === '') return false
  if (origin === 'null') return true
  try {
    const presented = new URL(origin)
    const host = (req.headers.host ?? '').trim().toLowerCase()
    // `Host` may omit the port when it is the scheme default. Compare both
    // forms so a canonical origin is not refused for a cosmetic mismatch.
    return presented.host.toLowerCase() !== host && presented.hostname.toLowerCase() !== host
  } catch {
    return true
  }
}

/** The hostname part of a `Host` header, lowercased, with the port and any IPv6 brackets removed. */
function requestHostname(raw: string | undefined): string | undefined {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === '') return undefined
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? undefined : value.slice(1, end)
  }
  const colon = value.indexOf(':')
  return colon === -1 ? value : value.slice(0, colon)
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const { pathname } = url

  // DNS rebinding defence, applied before routing and to static assets too —
  // the page itself is what would carry an attacker's script. A browser sends
  // the attacker's name in `Host` even when it resolves to loopback, so
  // refusing names this server does not answer to is what closes the hole;
  // binding to 127.0.0.1 never did.
  const hostname = requestHostname(req.headers.host)
  if (hostname === undefined || !deps.allowedHosts.has(hostname)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: `this host does not answer to '${hostname ?? '(no Host header)'}'; reach it by its bind address or set allowedHosts`,
    }))
    return
  }

  if (crossSiteWrite(req)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'cross-site request refused: this API only accepts writes from its own page' }))
    return
  }

  if (pathname === '/api/health' || pathname === '/api/auth/state' || pathname === '/api/auth/pair' || pathname === '/api/auth/logout') {
    await handleAuth(req, res, pathname, deps)
    return
  }

  if ((pathname === '/api/mcp/oauth/callback') && (req.method === 'GET' || req.method === 'POST')) {
    await handleOAuthDeposit(req, res, deps)
    return
  }

  if (pathname.startsWith('/api/') && deps.auth.enabled && !isPublicPath(pathname, req.method ?? 'GET')) {
    const decision = deps.auth.authenticate(req.headers, req.method ?? 'GET')
    if (!decision.ok) {
      res.writeHead(decision.status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: decision.reason }))
      return
    }
    if (decision.principal.kind === 'bearer' && !bearerAllows(pathname, decision.principal.scopes)) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'bearer token does not include this scope' }))
      return
    }
    ;(req as IncomingMessage & { miniDshPrincipalId?: string; miniDshGeneration?: number }).miniDshPrincipalId = decision.principal.id
    ;(req as IncomingMessage & { miniDshGeneration?: number }).miniDshGeneration = decision.principal.generation
    const generation = req.headers['last-event-id']
    if (typeof generation === 'string' && generation.startsWith('gen=') && generation.slice(4) !== String(decision.principal.generation)) {
      res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'session generation was revoked' }))
      return
    }
  }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, pathname, deps, url.searchParams)
    return
  }
  if (req.method === 'GET') {
    await serveStatic(res, pathname, deps.staticDir)
    return
  }
  res.writeHead(405, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: 'method not allowed' }))
}

/**
 * Pairing and session lifecycle. `/api/auth/pair` is public and accepts only a
 * JSON body: no cookie is read, no query string is honored, and the response
 * is not cacheable. A redeemed code sets the session cookie.
 */
async function handleOAuthDeposit(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  const send = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  try {
    let state = ''
    let code = ''
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      state = url.searchParams.get('state') ?? ''
      code = url.searchParams.get('code') ?? ''
    } else {
      const body = await readJson(req)
      state = typeof body['state'] === 'string' ? body['state'] : ''
      code = typeof body['code'] === 'string' ? body['code'] : ''
    }
    await deps.oauth.deposit(state, code)
    send(200, 'Authorization code received. Return to mini-dsh and finish connecting the server.')
  } catch {
    send(400, 'Authorization callback was rejected.')
  }
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, pathname: string, deps: HandlerDeps): Promise<void> {
  const send = (status: number, body: unknown, extra?: Record<string, string>): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra })
    res.end(JSON.stringify(body))
  }
  if (pathname === '/api/health' && req.method === 'GET') {
    send(200, { ok: true })
    return
  }
  if (pathname === '/api/auth/state' && req.method === 'GET') {
    send(200, { required: deps.auth.enabled, paired: !deps.auth.enabled || !deps.auth.pairingPending })
    return
  }
  if (pathname === '/api/auth/pair' && req.method === 'POST') {
    if (!deps.auth.enabled) {
      send(404, { error: 'control-plane authentication is not enabled' })
      return
    }
    if (req.headers.cookie !== undefined || new URL(req.url ?? '/', 'http://localhost').search !== '') {
      send(400, { error: 'pairing accepts only a JSON body' })
      return
    }
    const body = await readJson(req)
    const code = body['code']
    if (typeof code !== 'string' || code === '') {
      send(400, { error: 'pairing requires a code' })
      return
    }
    const redeemed = deps.auth.redeemPairingCode(code)
    if (!redeemed.ok) {
      send(redeemed.status, { error: redeemed.reason })
      return
    }
    send(200, { csrf: redeemed.csrf }, { 'set-cookie': deps.auth.cookieHeader(redeemed.sessionId) })
    return
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const decision = deps.auth.authenticate(req.headers, 'POST')
    if (!decision.ok) {
      send(decision.status, { error: decision.reason })
      return
    }
    if (decision.principal.kind === 'browser') deps.auth.revokeBrowserSession(decision.principal.id)
    else deps.auth.revokeBearer(decision.principal.id)
    deps.closeStreamsFor(decision.principal.id)
    for (const [approvalId, waiting] of deps.pending) {
      if (waiting.principalId === decision.principal.id) {
        deps.pending.delete(approvalId)
        waiting.resolve(false)
      }
    }
    send(200, { revoked: true }, { 'set-cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
    return
  }
  send(404, { error: 'no such auth route' })
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: HandlerDeps,
  query: URLSearchParams = new URLSearchParams(),
): Promise<void> {
  const send = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const fail = (error: unknown): void => {
    if (error instanceof ScopeError) {
      const status = error.code === 'workspace-not-empty' || error.code === 'project-active' || error.code === 'last-workspace' ? 409
        : error.code === 'root-invalid' || error.code === 'root-overlap' ? 400
          : 404
      send(status, { error: error.message })
      return
    }
    send(500, { error: String(error instanceof Error ? error.message : error) })
  }

  try {
    // ── workspaces ───────────────────────────────────────────
    if (pathname === '/api/workspaces') {
      if (req.method === 'GET') {
        const rows = deps.workspaces.list({ includeArchived: true }).map((ws) => {
          let running = 0
          let approvals = 0
          for (const entry of deps.sessions.values()) {
            if (entry.workspaceId !== ws.id) continue
            if (entry.agent.busy) running += 1
          }
          for (const waiting of deps.pending.values()) {
            if (waiting.workspaceId === ws.id) approvals += 1
          }
          return { ...ws, running, approvals, default: deps.workspaces.defaultWorkspace === ws.id }
        })
        send(200, rows)
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const name = typeof body['name'] === 'string' ? body['name'] : ''
        const created = await deps.workspaces.create(name)
        deps.seedWorkspaceControls(created.id)
        send(201, { ...created, default: false })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const workspaceMatch = /^\/api\/workspaces\/([^/]+)$/.exec(pathname)
    if (workspaceMatch !== null) {
      const wsId = decodeURIComponent(workspaceMatch[1] ?? '') as WorkspaceId
      if (req.method === 'PATCH') {
        const body = await readJson(req)
        let updated = deps.workspaces.get(wsId)
        if (typeof body['name'] === 'string') updated = await deps.workspaces.rename(wsId, body['name'])
        if (typeof body['archived'] === 'boolean') {
          // Archiving requires settled execution: no running sessions.
          if (body['archived'] === true) {
            for (const entry of deps.sessions.values()) {
              if (entry.workspaceId === wsId && entry.agent.busy) {
                send(409, { error: 'workspace has running sessions; stop them before archiving' })
                return
              }
            }
          }
          updated = await deps.workspaces.setArchived(wsId, body['archived'])
        }
        send(200, { ...updated, default: deps.workspaces.defaultWorkspace === wsId })
        return
      }
      if (req.method === 'DELETE') {
        await deps.workspaces.delete(wsId)
        send(200, { deleted: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── workspace-scoped sessions ────────────────────────────
    const wsSessionsMatch = /^\/api\/workspaces\/([^/]+)\/sessions$/.exec(pathname)
    if (wsSessionsMatch !== null) {
      const wsId = decodeURIComponent(wsSessionsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false) // unknown workspaces fail closed
      if (req.method === 'GET') {
        send(200, listSessions(wsId, deps))
        return
      }
      if (req.method === 'POST') {
        deps.workspaces.requireActive(wsId) // archived: no new sessions
        const body = await readJson(req)
        const rawProject = body['projectId']
        let projectId: ProjectId | undefined
        if (rawProject !== undefined && rawProject !== null && rawProject !== '') {
          if (typeof rawProject !== 'string') {
            send(400, { error: "'projectId' must be a string" })
            return
          }
          try {
            deps.workspaces.getProject(rawProject as ProjectId, wsId)
          } catch (error) {
            fail(error)
            return
          }
          projectId = rawProject as ProjectId
        }
        const session = deps.kernel.ctx.sessions.create(wsId)
        const defaults = deps.defaults()
        // Snapshot global defaults so later changes apply to future sessions
        // only. The global pair tracks the model actually in use (a
        // conversation model change repoints it), so a new conversation opens
        // on what the operator was last chatting with. Explicit null thinking
        // preserves "use model default".
        session.append({
          type: 'session/model',
          provider: defaults.provider,
          model: defaults.model,
          // Null is an intentional snapshot: use the selected model default,
          // even if the global default gains a thinking override later.
          thinkingLevel: defaults.thinkingLevel,
        })
        try {
          await session.durable()
        } catch (error) {
          await deps.kernel.ctx.sessions.delete(session.id).catch(() => {})
          send(500, { error: `session model snapshot could not be persisted: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        // G5: bring this workspace's enabled MCP servers up on first use.
        void deps.connectWorkspaceMcp(wsId).catch((error) => console.error(`web: MCP config/start failed for ${wsId}: ${String(error instanceof Error ? error.message : error)}`))
        if (projectId !== undefined) {
          // Canonical, rebuildable record of the binding.
          session.append({ type: 'session/project', projectId })
          await session.durable().catch(() => {})
        }
        deps.sessions.set(session.id, {
          session,
          agent: deps.kernel.ctx.agents.create(session, { workspaceId: wsId, ...(projectId !== undefined ? { projectId } : {}) }),
          workspaceId: wsId,
          projectId,
        })
        // SessionStart hooks are audit-only; failure follows each binding's
        // onFailure but cannot grant permissions.
        try {
          const hooks = await deps.mcpStore.loadHooks(wsId)
          for (const binding of hooks.hooks['SessionStart'] ?? []) {
            const decision = await runHook(binding, { hook_event: 'SessionStart', sessionId: session.id, workspaceId: wsId })
            session.append({ type: 'hook/run', event: 'SessionStart', matcher: binding.matcher, exitCode: decision.exitCode, durationMs: decision.durationMs, decision: isFailureDecision(decision) ? `failure:${binding.onFailure}` : 'audit' })
          }
          await session.durable()
        } catch (error) {
          // SessionStart is part of the hook lifecycle contract: do not
          // acknowledge a started session whose hook audit was lost.
          deps.sessions.delete(session.id)
          await deps.kernel.ctx.sessions.delete(session.id).catch(() => {})
          send(500, { error: `SessionStart hook/audit failed: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        send(201, { id: session.id, workspaceId: wsId, ...(projectId !== undefined ? { projectId } : {}) })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const wsSessionMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)(?:\/(events|messages|stop))?$/.exec(pathname)
    if (wsSessionMatch !== null) {
      const wsId = decodeURIComponent(wsSessionMatch[1] ?? '') as WorkspaceId
      const action = wsSessionMatch[3]
      const entry = await findSession(decodeURIComponent(wsSessionMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        // Unknown ids and foreign-workspace ids are indistinguishable: 404.
        send(404, { error: 'no such session' })
        return
      }
      if (deps.unavailableSessions.has(entry.session.id)) {
        send(503, { error: 'session unavailable after durable storage failure; restart the host to reload canonical history' })
        return
      }
      if (action === undefined) {
        // Destructive session mutation requires a live workspace; reads and
        // Stop (settlement) stay available on archived ones.
        if (req.method === 'DELETE' || req.method === 'PATCH') {
          try {
            requireWorkspace(deps, wsId, true)
          } catch (error) {
            fail(error)
            return
          }
        }
        if (req.method === 'DELETE') {
          if (entry.agent.busy) {
            send(409, { error: 'session is running; stop it before deleting' })
            return
          }
          try {
            const hooks = await deps.mcpStore.loadHooks(wsId)
            for (const binding of hooks.hooks['SessionEnd'] ?? []) {
              const decision = await runHook(binding, { hook_event: 'SessionEnd', sessionId: entry.session.id, workspaceId: wsId })
              entry.session.append({ type: 'hook/run', event: 'SessionEnd', matcher: binding.matcher, exitCode: decision.exitCode, durationMs: decision.durationMs, decision: isFailureDecision(decision) ? `failure:${binding.onFailure}` : 'audit' })
            }
            await entry.session.durable()
          } catch (error) {
            send(500, { error: `SessionEnd hook/audit failed; session kept: ${String(error instanceof Error ? error.message : error)}` })
            return
          }
          // Children spawned over HTTP can outlive an idle root: stop them
          // first, so none keeps running against a deleted conversation.
          await deps.childExecutor.cancelAllOfRoot(entry.session.id)
          deps.sessions.delete(entry.session.id)
          deps.kernel.ctx.agents.forget(entry.session.id)
          await deps.kernel.ctx.sessions.delete(entry.session.id)
          forgetSessionState(entry.session.id, deps)
          entry.closed = true
          send(200, { deleted: true })
          return
        }
        if (req.method === 'PATCH') {
          const body = await readJson(req)
          const outcome = await patchSession(entry, body, deps)
          if (!outcome.ok) {
            send(outcome.status, { error: outcome.error })
            return
          }
          send(200, outcome.payload)
          return
        }
        send(405, { error: 'method not allowed' })
        return
      }
      if (action === 'events' && req.method === 'GET') {
        streamEvents(req, res, entry, deps)
        return
      }
      if (action === 'stop' && req.method === 'POST') {
        // Root Stop cleans up descendants first, then the root: stopped is
        // reported once children are cancelled (cleanup confirmed).
        entry.agent.stop()
        const cleaned = await deps.childExecutor.cancelAllOfRoot(entry.session.id)
        send(202, { stopped: true, ...(cleaned > 0 ? { childrenCancelled: cleaned } : {}) })
        return
      }
      if (action === 'messages' && req.method === 'POST') {
        const outcome = await acceptMessage(entry, req, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        send(outcome.status, outcome.body)
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const agentCatalog = /^\/api\/workspaces\/([^/]+)\/agents$/.exec(pathname)
    if (agentCatalog !== null) {
      const wsId = decodeURIComponent(agentCatalog[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method !== 'GET') { send(405, { error: 'method not allowed' }); return }
      send(200, await deps.agentDefinitions.list(wsId))
      return
    }

    // ── G4 agent definitions + delegation ────────────────────
    const wsAgentsMatch = /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)$/.exec(pathname)
    if (wsAgentsMatch !== null) {
      const wsId = decodeURIComponent(wsAgentsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const name = decodeURIComponent(wsAgentsMatch[2] ?? '')
      if (req.method === 'POST') {
        // Delegation: an existing ROOT session spawns a child with a task
        // packet. One level only — children run through the same loop with
        // a childOf scope stamp and no spawn capability of their own.
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const packetBody = body['task']
        if (packetBody === null || typeof packetBody !== 'object' || Array.isArray(packetBody)) {
          send(400, { error: "body needs a 'task' object" })
          return
        }
        // Shape only: whether the brief is usable is decided once, by the
        // executor (SpawnError 'packet' → 400).
        const packet = packetBody as Record<string, unknown>
        const inherit = body['inherit'] ?? 'none'
        if (inherit !== 'none' && inherit !== 'brief') {
          send(400, { error: "'inherit' must be 'none' or 'brief'" })
          return
        }
        const rootId = typeof body['rootSessionId'] === 'string' ? body['rootSessionId'] : ''
        const parent = rootId !== '' ? await findSession(rootId, wsId, deps) : undefined
        if (parent === undefined) {
          send(404, { error: 'no such root session' })
          return
        }
        // Captured synchronously right after the parent resolves, before any
        // await: a parent message appended later can never leak in.
        const inheritedContext = inherit === 'brief' ? projectInheritedMessages(parent.session.events) : undefined
        try {
          const resolved = await deps.agentDefinitions.resolve(wsId, name)
          const parentTurn = [...parent.session.events].reverse().find((event) => event.type === 'turn/start')
          const task: TaskPacket = {
            ...(typeof packet['prompt'] === 'string' ? { prompt: packet['prompt'] } : {}),
            ...(typeof packet['objective'] === 'string' ? { objective: packet['objective'] } : {}),
            // Same normalization as the Agent tool: blank entries dropped.
            constraints: Array.isArray(packet['constraints']) ? (packet['constraints'] as unknown[]).map(String).filter((entry) => entry.trim() !== '') : [],
            references: Array.isArray(packet['references']) ? (packet['references'] as unknown[]).map(String).filter((entry) => entry.trim() !== '') : [],
            requiredResult: typeof packet['requiredResult'] === 'string' && packet['requiredResult'].trim() !== ''
              ? packet['requiredResult'].trim()
              : 'bounded summary with file references',
          }
          const spawnRequest = {
            workspaceId: wsId,
            parentSessionId: parent.session.id,
            parentTurnId: parentTurn !== undefined && parentTurn.type === 'turn/start' ? String(parentTurn.turnId) : 'ad-hoc',
            definition: resolved.definition,
            packet: task,
            ...(inheritedContext !== undefined ? { inherit: 'brief' as const, inheritedContext } : {}),
          }
          const model = deps.childModelFor(
            parent.session,
            wsId,
            typeof body['model'] === 'string' ? body['model'] : undefined,
            resolved.definition.model,
          )
          const handle = await deps.childExecutor.spawn({
            ...spawnRequest,
            ...(parent.projectId !== undefined ? { projectId: parent.projectId } : {}),
            ...(Array.isArray(body['grantTools']) ? { grantTools: (body['grantTools'] as unknown[]).map(String) } : {}),
            ...(model !== undefined ? { model } : {}),
          })
          send(202, {
            ...handle,
            ...(inheritedContext !== undefined ? { inheritedChars: inheritedContext.length } : {}),
            ...(typeof task.prompt === 'string' && task.prompt.trim() !== '' && typeof task.objective === 'string' && task.objective.trim() !== ''
              ? { note: "both 'prompt' and 'objective' were given; the prompt is the brief" }
              : {}),
          })
        } catch (error) {
          if (error instanceof SpawnError) {
            send(error.code === 'capacity' ? 429 : error.code === 'packet' || error.code === 'inherit' ? 400 : 404, { error: error.message })
            return
          }
          if (error instanceof ChildModelError) {
            send(400, { error: error.message })
            return
          }
          if (error instanceof AgentDefinitionError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'GET' && name === 'children') {
        const rootId = query.get('root') ?? ''
        const parent = await findSession(rootId, wsId, deps)
        if (parent === undefined) {
          send(404, { error: 'no such root session' })
          return
        }
        send(200, await deps.childExecutor.childrenOfRoot(parent.session.id, wsId))
        return
      }
      if (req.method === 'GET') {
        try {
          send(200, await deps.agentDefinitions.resolve(wsId, name))
        } catch (error) {
          if (error instanceof AgentDefinitionError && error.code === 'not-found') {
            send(404, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'DELETE') {
        requireWorkspace(deps, wsId, true)
        await deps.agentDefinitions.delete(wsId, name)
        send(200, { deleted: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Child lifecycle: wait/result/cancel by child session id.
    const wsChildMatch = /^\/api\/workspaces\/([^/]+)\/children\/([^/]+)(?:\/(cancel))?$/.exec(pathname)
    if (wsChildMatch !== null) {
      const wsId = decodeURIComponent(wsChildMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const childId = decodeURIComponent(wsChildMatch[2] ?? '') as SessionId
      const isCancel = wsChildMatch[3] === 'cancel'
      try {
        if (isCancel && req.method === 'POST') {
          const handle = await deps.childExecutor.cancel(wsId, childId)
          if (handle === undefined) {
            send(404, { error: 'no such child' })
            return
          }
          send(200, handle)
          return
        }
        if (!isCancel && req.method === 'GET') {
          const waitRaw = Number(query.get('waitMs') ?? '30000')
          const [handle] = await deps.childExecutor.wait(wsId, [childId], {
            timeoutMs: Number.isFinite(waitRaw) ? Math.min(waitRaw, 120_000) : 30_000,
          })
          if (handle === undefined) {
            send(404, { error: 'no such child' })
            return
          }
          send(200, handle)
          return
        }
        send(405, { error: 'method not allowed' })
      } catch (error) {
        if (error instanceof SpawnError) {
          send(404, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    // Claude/Codex definition import: explicit, provenance-preserving,
    // never executes content; blocking fields prevent auto-activation.
    const wsAgentImport = /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/import$/.exec(pathname)
    if (wsAgentImport !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(wsAgentImport[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const targetName = decodeURIComponent(wsAgentImport[2] ?? '')
      const body = await readJson(req)
      const content = body['content']
      if (typeof content !== 'string' || content.trim() === '') {
        send(400, { error: "body needs a non-empty string 'content'" })
        return
      }
      try {
        const dialect = typeof body['dialect'] === 'string' ? body['dialect'] : 'claude'
        if (dialect === 'mini-dsh') {
          // A native document (the Settings create/copy form): saved verbatim
          // after the strict native parse, so mini-dsh-only keys such as
          // `inheritable` survive the round-trip.
          const saved = await deps.agentDefinitions.save(wsId, targetName, content)
          const keys = Object.keys(saved.definition).filter((key) => key !== 'instructions' && key !== 'name')
          send(201, { definition: saved, imported: keys, warnings: [], active: true })
          return
        }
        const result =
          dialect === 'codex'
            ? await import('../harness/agents/compatibility/claude.ts').then((mod) =>
                mod.importCodexDefinition(content, typeof body['sourceVersion'] === 'string' ? body['sourceVersion'] : undefined),
              )
            : importClaudeDefinition(content)
        const blockedFields = (result as { blocked?: readonly string[] }).blocked ?? []
        if (blockedFields.length > 0) {
          // Quarantine: a definition with unresolved blocking fields is
          // NEVER saved as executable. The operator resolves the fields and
          // re-imports; the parsed preview comes back for that purpose.
          send(422, {
            error: `definition blocked by unresolved fields: ${blockedFields.join(', ')}`,
            blocked: blockedFields,
            warnings: result.warnings,
            preview: result.definition,
          })
          return
        }
        const saved = await deps.agentDefinitions.save(wsId, targetName, serializeDefinition(result.definition))
        send(201, {
          definition: saved,
          imported: (result as { imported?: readonly string[] }).imported ?? [],
          warnings: result.warnings,
          active: true,
        })
      } catch (error) {
        if (error instanceof AgentDefinitionError) {
          send(error.code === 'blocked' ? 422 : error.code === 'not-found' ? 404 : 400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    // ── G5 MCP/hook management routes ────────────────────────
    const oauthMatch = /^\/api\/workspaces\/([^/]+)\/mcp\/([^/]+)\/oauth\/(begin|complete|revoke)$/.exec(pathname)
    if (oauthMatch !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(oauthMatch[1] ?? '') as WorkspaceId
      const serverName = decodeURIComponent(oauthMatch[2] ?? '')
      const action = oauthMatch[3]
      requireWorkspace(deps, wsId, true)
      const principalId = (req as IncomingMessage & { miniDshPrincipalId?: string }).miniDshPrincipalId ?? 'local'
      const body = await readJson(req)
      try {
        if (action === 'begin') {
          const scopes = Array.isArray(body['scopes']) ? body['scopes'].filter((item): item is string => typeof item === 'string') : []
          const started = await deps.oauth.begin({
            workspaceId: wsId,
            server: serverName,
            principalId,
            resource: String(body['resource'] ?? ''),
            authorizationEndpoint: String(body['authorizationEndpoint'] ?? ''),
            tokenEndpoint: String(body['tokenEndpoint'] ?? ''),
            clientId: String(body['clientId'] ?? ''),
            redirectUri: String(body['redirectUri'] ?? ''),
            scopes,
          })
          send(200, { authorizationUrl: started.authorizationUrl })
          return
        }
        if (action === 'complete') {
          await deps.oauth.complete({
            state: String(body['state'] ?? ''),
            principalId,
            workspaceId: wsId,
            server: serverName,
          })
          send(200, { connected: true })
          return
        }
        await deps.fenceWorkspace(wsId)
        const revoked = await deps.oauth.revoke(wsId, serverName, typeof body['revocationEndpoint'] === 'string' ? body['revocationEndpoint'] : undefined)
        send(200, revoked)
      } catch (error) {
        send(400, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const wsMcpImportMatch = /^\/api\/workspaces\/([^/]+)\/mcp\/import$/.exec(pathname)
    if (wsMcpImportMatch !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(wsMcpImportMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const body = await readJson(req)
      const content = body['content']
      if (typeof content !== 'string' || content.trim() === '') {
        send(400, { error: "body needs a non-empty string 'content'" })
        return
      }
      try {
        const dialect = body['dialect'] === 'codex' ? 'codex' : 'claude'
        const imported = dialect === 'codex'
          ? importCodexMcp(content, typeof body['sourceVersion'] === 'string' ? body['sourceVersion'] : '')
          : importClaudeMcp(content)
        const existing = await deps.mcpStore.loadMcp(wsId)
        let merged = existing
        for (const [name, server] of Object.entries(imported.servers)) {
          merged = upsertServer(merged, name, { ...server, enabled: false })
        }
        await deps.commitMcpConfig(wsId, merged)
        send(201, {
          imported: Object.keys(imported.servers),
          enabled: [],
          provenance: dialect,
          spawned: false,
        })
      } catch (error) {
        if (error instanceof McpConfigError) {
          send(400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    const mcpOps = /^\/api\/workspaces\/([^/]+)\/mcp\/(audit-repair|acknowledge-drift)$/.exec(pathname)
    if (mcpOps !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(mcpOps[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const op = mcpOps[2]
      if (op === 'acknowledge-drift') {
        await deps.acknowledgeDrift(wsId)
        const config = await deps.mcpStore.loadMcp(wsId)
        send(200, { stale: false, revision: configRevision(config) })
        return
      }
      const repaired = await deps.repairAudit(wsId)
      if (!repaired.ok) {
        send(409, { error: repaired.error })
        return
      }
      send(200, { cleared: true })
      return
    }

    const wsMcpMatch = /^\/api\/workspaces\/([^/]+)\/mcp(?:\/([^/]+)(?:\/(enable|disable|reconnect|test))?)?$/.exec(pathname)
    if (wsMcpMatch !== null) {
      const wsId = decodeURIComponent(wsMcpMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const serverName = wsMcpMatch[2] !== undefined ? decodeURIComponent(wsMcpMatch[2]) : undefined
      const action = wsMcpMatch[3]
      try {
        if (req.method === 'GET' && serverName === undefined) {
          await deps.observeConfig(wsId)
          const config = await deps.mcpStore.loadMcp(wsId)
          const revision = configRevision(config)
          const auditFault = await faultIsOpen(deps.auditFaultFile)
          const rows = []
          for (const server of Object.values(config.servers)) {
            const client = deps.mcpClients.get(`${wsId}:${server.name}`)
            const discovered = (client?.cachedTools() ?? []).map((tool) => tool.name)
            const unmatchedAllowlist = (server.allowedTools ?? []).filter((name) => !name.includes('*') && !discovered.includes(name))
            rows.push({
              name: server.name,
              transport: server.transport,
              enabled: server.enabled,
              status: !server.enabled ? 'disabled' : client?.state ?? 'connecting',
              breakerOpenUntil: client !== undefined && client.breakerOpenUntil > Date.now() ? client.breakerOpenUntil : null,
              containment: deps.containmentDetail,
              generation: deps.generationOf(wsId),
              auditFault,
              revision,
              stale: deps.isDrifted(wsId),
              discoveredTools: discovered,
              ...(server.allowedTools !== undefined ? { allowedTools: server.allowedTools } : {}),
              unmatchedAllowlist,
            })
          }
          send(200, rows)
          return
        }
        if (req.method === 'GET' && serverName !== undefined && action === undefined) {
          // Stored config for editing: the form merges its fields into this so
          // settings it does not show (env, headers, imported extras) survive.
          const serverConfig = (await deps.mcpStore.loadMcp(wsId)).servers[serverName]
          if (serverConfig === undefined) {
            send(404, { error: `no MCP server '${serverName}'` })
            return
          }
          send(200, JSON.parse(JSON.stringify(serverConfig)))
          return
        }
        if (req.method === 'DELETE' && serverName !== undefined && action === undefined) {
          requireWorkspace(deps, wsId, true)
          const config = await deps.mcpStore.loadMcp(wsId)
          if (config.servers[serverName] === undefined) {
            send(404, { error: `no MCP server '${serverName}'` })
            return
          }
          // Stop the process and drop its tool schemas before the config forgets it.
          await deps.cancelMcpConnection(wsId, serverName)
          await deps.commitMcpConfig(wsId, withoutServer(config, serverName))
          send(200, { deleted: serverName })
          return
        }
        if (req.method === 'POST' && serverName !== undefined && action === undefined) {
          // Register/update a server (config + provenance, no auto-spawn).
          requireWorkspace(deps, wsId, true)
          const body = await readJson(req)
          const config = await deps.mcpStore.loadMcp(wsId)
          const expected = body['expectedRevision']
          if (typeof expected === 'string' && expected !== configRevision(config)) {
            send(409, { error: 'mcp.json changed since it was loaded; reload before saving', revision: configRevision(config) })
            return
          }
          const { expectedRevision: _expected, ...serverBody } = body
          void _expected
          const name = typeof body['name'] === 'string' && body['name'] !== '' ? body['name'] : serverName
          const merged = upsertServer(config, name, serverBody)
          await deps.commitMcpConfig(wsId, merged)
          send(201, { saved: name, enabled: merged.servers[name]?.enabled === true, activated: false })
          return
        }
        if (req.method === 'POST' && serverName !== undefined && (action === 'enable' || action === 'disable' || action === 'reconnect' || action === 'test')) {
          requireWorkspace(deps, wsId, true)
          const config = await deps.mcpStore.loadMcp(wsId)
          const serverConfig = config.servers[serverName]
          if (serverConfig === undefined) {
            send(404, { error: `no MCP server '${serverName}'` })
            return
          }
          if (action === 'test') {
            const tools = await deps.testMcpServer(wsId, serverName)
            const stored = await deps.mcpStore.loadMcp(wsId)
            send(200, {
              tested: true,
              published: false,
              enabled: stored.servers[serverName]?.enabled === true,
              tools,
            })
            return
          }
          if (action === 'disable') {
            await deps.commitMcpConfig(wsId, withServerEnabled(config, serverName, false))
            await deps.cancelMcpConnection(wsId, serverName)
            send(200, { status: 'disabled' })
            return
          }
          if (serverConfig.resourceLimits?.enforcement === 'hard') {
            const report = await containmentCapability()
            if (report.level !== 'hard') {
              send(409, { error: report.detail })
              return
            }
          }
          const enabledNext = withServerEnabled(config, serverName, true)
          await deps.commitMcpConfig(wsId, enabledNext)
          if (action === 'reconnect') await deps.cancelMcpConnection(wsId, serverName)
          deps.mcpCancelled.delete(`${wsId}:${serverName}`)
          // Fresh/singleton connect; ensureMcpServer lists + reconciles tools.
          const client = await deps.ensureMcpServer(wsId, serverName)
          send(200, { status: client.state })
          return
        }
        send(405, { error: 'method not allowed' })
      } catch (error) {
        if (error instanceof McpConfigError || error instanceof McpTransportError) {
          send(error instanceof McpConfigError ? 400 : 502, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    const wsHooksMatch = /^\/api\/workspaces\/([^/]+)\/hooks$/.exec(pathname)
    if (wsHooksMatch !== null) {
      const wsId = decodeURIComponent(wsHooksMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method === 'GET') {
        send(200, await deps.mcpStore.loadHooks(wsId))
        return
      }
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        parseHooksConfig(JSON.stringify(body)) // strict validate
        await deps.mcpStore.saveHooks(wsId, body as unknown as HooksConfig)
        send(200, { saved: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const wsSecretsMatch = /^\/api\/workspaces\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(pathname)
    if (wsSecretsMatch !== null) {
      const wsId = decodeURIComponent(wsSecretsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true) // secrets management is a mutation
      const key = wsSecretsMatch[2] !== undefined ? decodeURIComponent(wsSecretsMatch[2]) : undefined
      if (req.method === 'GET' && key === undefined) {
        // Masked display: key names only, never values.
        const secrets = await deps.mcpStore.loadSecrets(wsId)
        send(200, Object.keys(secrets).map((name) => ({ name })))
        return
      }
      if (req.method === 'PUT' && key !== undefined) {
        const body = await readJson(req)
        if (typeof body['value'] !== 'string') {
          send(400, { error: "body needs a string 'value'" })
          return
        }
        const secrets = await deps.mcpStore.loadSecrets(wsId)
        secrets[key] = body['value']
        await deps.fenceWorkspace(wsId)
        await deps.mcpStore.saveSecrets(wsId, secrets)
        // Rotation reconnects AFFECTED enabled servers before responding.
        const config = await deps.mcpStore.loadMcp(wsId)
        const ref = `\${${key}}`
        const affected = Object.values(config.servers).filter((server) => {
          if (!server.enabled) return false
          const values = [
            ...Object.values(server.env ?? {}),
            ...Object.values(server.headers ?? {}),
            ...(authSecretRef(server.auth) !== undefined ? [authSecretRef(server.auth) as string] : []),
          ]
          return values.includes(ref)
        })
        try {
          for (const server of affected) {
            await deps.cancelMcpConnection(wsId, server.name)
            deps.mcpCancelled.delete(`${wsId}:${server.name}`)
            await deps.ensureMcpServer(wsId, server.name)
          }
        } catch (error) {
          send(502, { error: `secret rotated but affected MCP server failed to reconnect: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        send(200, { rotated: key, reconnected: affected.map((server) => server.name) })
        return
      }
      if (req.method === 'DELETE' && key !== undefined) {
        const secrets = await deps.mcpStore.loadSecrets(wsId)
        delete secrets[key]
        await deps.fenceWorkspace(wsId)
        await deps.mcpStore.saveSecrets(wsId, secrets)
        send(200, { deleted: key })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── legacy unscoped session routes (memory-mode 'default') ──
    if (pathname === '/api/sessions') {
      if (req.method === 'GET') {
        send(200, listSessions(implicitWorkspace(deps), deps))
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const rawFolder = body['folder']
        // Memory-mode sessions may bind a fallback folder via `folder`
        // (legacy behavior for tests); it is not a project record.
        let folder: string | undefined
        if (typeof rawFolder === 'string' && rawFolder.trim() !== '') {
          const abs = path.resolve(rawFolder)
          try {
            if (!(await fs.stat(abs)).isDirectory()) throw new Error('not a directory')
            folder = abs
          } catch {
            send(400, { error: `no such directory '${rawFolder}'` })
            return
          }
        }
        const wsId = implicitWorkspace(deps)
        const session = deps.kernel.ctx.sessions.create(wsId)
        deps.sessions.set(session.id, {
          session,
          agent: deps.kernel.ctx.agents.create(session, { workspaceId: wsId }),
          workspaceId: wsId,
          projectId: undefined,
        })
        deps.legacyFolders.set(session.id, folder)
        send(201, { id: session.id, ...(folder !== undefined ? { folder } : {}) })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const legacySessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(events|messages|stop))?$/.exec(pathname)
    if (legacySessionMatch !== null) {
      const action = legacySessionMatch[2]
      const entry = await findSession(decodeURIComponent(legacySessionMatch[1] ?? ''), implicitWorkspace(deps), deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      if (action === undefined) {
        if (req.method === 'DELETE') {
          if (entry.agent.busy) {
            send(409, { error: 'session is running; stop it before deleting' })
            return
          }
          await deps.childExecutor.cancelAllOfRoot(entry.session.id)
          deps.sessions.delete(entry.session.id)
          deps.kernel.ctx.agents.forget(entry.session.id)
          await deps.kernel.ctx.sessions.delete(entry.session.id)
          forgetSessionState(entry.session.id, deps)
          entry.closed = true
          deps.legacyFolders.delete(entry.session.id)
          send(200, { deleted: true })
          return
        }
        if (req.method === 'PATCH') {
          const body = await readJson(req)
          const outcome = await patchSession(entry, body, deps)
          if (!outcome.ok) {
            send(outcome.status, { error: outcome.error })
            return
          }
          send(200, outcome.payload)
          return
        }
        send(405, { error: 'method not allowed' })
        return
      }
      if (action === 'events' && req.method === 'GET') {
        streamEvents(req, res, entry, deps)
        return
      }
      if (action === 'stop' && req.method === 'POST') {
        entry.agent.stop()
        send(202, { stopped: true })
        return
      }
      if (action === 'messages' && req.method === 'POST') {
        const outcome = await acceptMessage(entry, req, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        send(outcome.status, outcome.body)
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── legacy folder grant (memory mode only) ───────────────
    const legacyFolderGlobal = /^\/api\/folder$/.exec(pathname)
    if (legacyFolderGlobal !== null && req.method === 'PUT' && deps.deniedRoots === undefined) {
      const body = await readJson(req)
      const raw = body['path']
      if (typeof raw !== 'string' || raw.trim() === '') {
        send(400, { error: "needs a non-empty string 'path'" })
        return
      }
      const abs = path.resolve(raw)
      try {
        if (!(await fs.stat(abs)).isDirectory()) throw new Error()
        deps.legacyFolderDefault.current = abs
        send(200, { folder: abs })
      } catch {
        send(400, { error: `no such directory '${raw}'` })
      }
      return
    }
    const legacyFolderSession = /^\/api\/sessions\/([^/]+)\/folder$/.exec(pathname)
    if (legacyFolderSession !== null && req.method === 'PUT' && deps.deniedRoots === undefined) {
      const entry = await findSession(decodeURIComponent(legacyFolderSession[1] ?? ''), MEMORY_WORKSPACE, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      const body = await readJson(req)
      const raw = body['path']
      if (typeof raw !== 'string') {
        send(400, { error: "body needs a string 'path' (empty resets to inherit)" })
        return
      }
      if (raw.trim() === '') {
        deps.legacyFolders.set(entry.session.id, undefined)
        send(200, { folder: null })
        return
      }
      const abs = path.resolve(raw)
      try {
        if (!(await fs.stat(abs)).isDirectory()) throw new Error()
        deps.legacyFolders.set(entry.session.id, abs)
        send(200, { folder: abs })
      } catch {
        send(400, { error: `no such directory '${raw}'` })
      }
      return
    }

    // ── global provider/model defaults ───────────────────────
    if (pathname === '/api/model-defaults') {
      if (req.method === 'GET') {
        send(200, deps.defaults())
        return
      }
      if (req.method === 'PUT') {
        const outcome = await putModelDefaults(req, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        send(200, deps.defaults())
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── legacy meta/model/policy → memory workspace ──────────
    if (pathname === '/api/meta' && req.method === 'GET') {
      send(200, workspaceMeta(implicitWorkspace(deps), deps, deps.legacyFolderDefault.current))
      return
    }
    if (pathname === '/api/model' && req.method === 'PUT') {
      const outcome = putModel(implicitWorkspace(deps), req, deps)
      const resolved = await outcome
      if (!resolved.ok) {
        send(resolved.status, { error: resolved.error })
        return
      }
      const defaults = deps.defaults()
      send(200, { provider: defaults.provider, model: defaults.model })
      return
    }
    if (pathname === '/api/thinking' && req.method === 'PUT') {
      const wsId = implicitWorkspace(deps)
      const outcome = await putThinking(wsId, req, deps)
      if (!outcome.ok) {
        send(outcome.status, { error: outcome.error })
        return
      }
      send(200, { thinkingLevel: deps.defaults().thinkingLevel })
      return
    }
    // ── workspace-scoped controls ────────────────────────────
    const wsModelMatch = /^\/api\/workspaces\/([^/]+)\/model$/.exec(pathname)
    if (wsModelMatch !== null && req.method === 'PUT') {
      const wsId = decodeURIComponent(wsModelMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const outcome = await putModel(wsId, req, deps)
      if (!outcome.ok) {
        send(outcome.status, { error: outcome.error })
        return
      }
      const defaults = deps.defaults()
      send(200, { provider: defaults.provider, model: defaults.model })
      return
    }

    const wsThinkingMatch = /^\/api\/workspaces\/([^/]+)\/thinking$/.exec(pathname)
    if (wsThinkingMatch !== null && req.method === 'PUT') {
      const wsId = decodeURIComponent(wsThinkingMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const outcome = await putThinking(wsId, req, deps)
      if (!outcome.ok) {
        send(outcome.status, { error: outcome.error })
        return
      }
      send(200, { thinkingLevel: deps.defaults().thinkingLevel })
      return
    }

    const wsMetaMatch = /^\/api\/workspaces\/([^/]+)\/meta$/.exec(pathname)
    if (wsMetaMatch !== null && req.method === 'GET') {
      const wsId = decodeURIComponent(wsMetaMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      send(200, workspaceMeta(wsId, deps))
      return
    }

    // ── G3 live mode control ─────────────────────────────────
    const wsModeMatch = /^\/api\/workspaces\/([^/]+)\/mode$/.exec(pathname)
    if (wsModeMatch !== null) {
      const wsId = decodeURIComponent(wsModeMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method === 'GET') {
        const rows = await deps.modes.list(wsId)
        const state = deps.controlsFor(wsId)
        // The picker lists enabled modes only; the authoring catalog below is
        // where a mode is disabled and re-enabled.
        const disabled = new Set(await deps.modes.disabledIds(wsId))
        send(200, {
          modes: rows.filter((row) => !disabled.has(row.definition.id)).map((row) => ({ id: row.definition.id, name: row.definition.name, source: row.source })),
          selected: state.modeId,
          revision: state.modeRevision,
        })
        return
      }
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const modeId = body['modeId']
        if (typeof modeId !== 'string' || modeId.trim() === '') {
          send(400, { error: "body needs a non-empty string 'modeId'" })
          return
        }
        if ((await deps.modes.disabledIds(wsId)).includes(modeId.trim())) {
          send(400, { error: `mode '${modeId.trim()}' is disabled in this workspace; enable it before selecting it` })
          return
        }
        try {
          // Selection validates the definition; the validated snapshot is
          // what gates execution (mode files are not hot-reloaded).
          const resolved = await deps.adoptMode(wsId, modeId.trim())
          // Pending approvals re-evaluate against the new exposure, scoped
          // to THIS workspace: newly unexposed calls cancel truthfully,
          // newly allowed asks proceed through the serialized final gate,
          // still-ask calls remain pending; other workspaces are untouched.
          const effective = effectivePolicy(resolved.definition.permissionDefaults, deps.yolo)
          deps.approvalHandle.reevaluate({ workspaceId: wsId, toolExposure: resolved.definition.toolExposure, policy: effective })
          send(200, { modeId: resolved.definition.id, name: resolved.definition.name, revision: deps.controlsFor(wsId).modeRevision })
        } catch (error) {
          if (error instanceof ModeError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── Mode authoring (the selection control above is a separate concern) ──
    const wsModeEnabled = /^\/api\/workspaces\/([^/]+)\/modes\/([^/]+)\/enabled$/.exec(pathname)
    if (wsModeEnabled !== null && req.method === 'PUT') {
      const wsId = decodeURIComponent(wsModeEnabled[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const modeId = decodeURIComponent(wsModeEnabled[2] ?? '')
      const body = await readJson(req)
      if (typeof body['enabled'] !== 'boolean') {
        send(400, { error: "body needs a boolean 'enabled'" })
        return
      }
      if (!body['enabled'] && deps.controlsFor(wsId).modeId === modeId) {
        send(409, { error: `mode '${modeId}' is selected; select another mode before disabling it` })
        return
      }
      try {
        await deps.modes.setEnabled(wsId, modeId, body['enabled'])
        send(200, { id: modeId, enabled: body['enabled'] })
      } catch (error) {
        sendModeError(error, send, fail)
      }
      return
    }

    const wsModeDuplicate = /^\/api\/workspaces\/([^/]+)\/modes\/([^/]+)\/duplicate$/.exec(pathname)
    if (wsModeDuplicate !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(wsModeDuplicate[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const sourceId = decodeURIComponent(wsModeDuplicate[2] ?? '')
      const body = await readJson(req)
      const newId = body['newId']
      if (typeof newId !== 'string' || newId.trim() === '') {
        send(400, { error: "body needs a non-empty string 'newId'" })
        return
      }
      try {
        // The service owns the id rules and the bundled-id refusal; repeating
        // them here would be a second place for them to drift.
        const copy = await deps.modes.duplicate(wsId, sourceId, newId.trim())
        send(200, { id: copy.definition.id, name: copy.definition.name, source: copy.source, hash: copy.hash })
      } catch (error) {
        sendModeError(error, send, fail)
      }
      return
    }

    const wsModesMatch = /^\/api\/workspaces\/([^/]+)\/modes(?:\/([^/]+))?$/.exec(pathname)
    if (wsModesMatch !== null) {
      const wsId = decodeURIComponent(wsModesMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const modeId = wsModesMatch[2] !== undefined ? decodeURIComponent(wsModesMatch[2]) : undefined
      if (req.method === 'GET' && modeId === undefined) {
        const rows = await deps.modes.list(wsId)
        const disabled = new Set(await deps.modes.disabledIds(wsId))
        // Permissions and exposure travel with the catalog: the settings list
        // states what each mode grants without a read per row. `enabled`
        // marks what the composer picker offers.
        send(200, rows.map((row) => ({
          id: row.definition.id,
          name: row.definition.name,
          source: row.source,
          enabled: !disabled.has(row.definition.id),
          toolExposure: row.definition.toolExposure,
          permissionDefaults: row.definition.permissionDefaults,
        })))
        return
      }
      if (req.method === 'GET' && modeId !== undefined) {
        try {
          send(200, await deps.modes.load(wsId, modeId))
        } catch (error) {
          sendModeError(error, send, fail)
        }
        return
      }
      if (req.method === 'PUT' && modeId !== undefined) {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const content = body['content']
        if (typeof content !== 'string' || content.trim() === '') {
          send(400, { error: "body needs a non-empty string 'content' (raw mode Markdown)" })
          return
        }
        try {
          const saved = await deps.modes.save(wsId, modeId, content, typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined)
          send(200, { id: saved.definition.id, name: saved.definition.name, hash: saved.hash })
        } catch (error) {
          sendModeError(error, send, fail)
        }
        return
      }
      if (req.method === 'DELETE' && modeId !== undefined) {
        requireWorkspace(deps, wsId, true)
        try {
          await deps.modes.delete(wsId, modeId)
          send(200, { deleted: true })
        } catch (error) {
          sendModeError(error, send, fail)
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── G3 skills ────────────────────────────────────────────
    const wsSkillsMatch = /^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(pathname)
    if (wsSkillsMatch !== null) {
      const wsId = decodeURIComponent(wsSkillsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const skillName = wsSkillsMatch[2] !== undefined ? decodeURIComponent(wsSkillsMatch[2]) : undefined
      if (req.method === 'GET' && skillName === undefined) {
        send(200, await deps.skills.list(wsId))
        return
      }
      if (req.method === 'PUT' && skillName !== undefined) {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const content = body['content']
        if (typeof content !== 'string' || content.trim() === '') {
          send(400, { error: "body needs a non-empty string 'content' (raw SKILL.md)" })
          return
        }
        try {
          const saved = await deps.skills.save(wsId, skillName, content, typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined)
          send(200, { name: saved.name, hash: saved.hash })
        } catch (error) {
          if (error instanceof SkillError) {
            send(error.code === 'conflict' ? 409 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'DELETE' && skillName !== undefined) {
        requireWorkspace(deps, wsId, true)
        await deps.skills.delete(wsId, skillName)
        send(200, { deleted: true })
        return
      }
      if (req.method === 'GET' && skillName !== undefined) {
        // One skill's raw instructions + hash: the settings editor loads
        // real content so saves are never blind overwrites.
        try {
          const loaded = await deps.skills.load(wsId, skillName)
          send(200, { name: loaded.name, title: loaded.title, description: loaded.description, source: loaded.source, hash: loaded.hash, instructions: loaded.instructions })
        } catch (error) {
          if (error instanceof SkillError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── G3 memory ────────────────────────────────────────────
    const wsMemoryMatch = /^\/api\/workspaces\/([^/]+)\/memory(?:\/([^/]+))?$/.exec(pathname)
    if (wsMemoryMatch !== null) {
      const wsId = decodeURIComponent(wsMemoryMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const entryId = wsMemoryMatch[2] !== undefined ? decodeURIComponent(wsMemoryMatch[2]) : undefined
      const scope = { workspaceId: wsId }
      if (req.method === 'GET' && entryId === undefined) {
        const hits = await deps.memory.search(scope, typeof query.get('q') === 'string' ? (query.get('q') ?? '') : '')
        send(200, hits)
        return
      }
      if (req.method === 'POST' && entryId === undefined) {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        try {
          const created = await deps.memory.create(scope, {
            id: typeof body['id'] === 'string' ? body['id'] : '',
            title: typeof body['title'] === 'string' ? body['title'] : '',
            body: typeof body['body'] === 'string' ? body['body'] : '',
            ...(body['pinned'] === true ? { pinned: true } : {}),
          })
          send(201, created)
        } catch (error) {
          if (error instanceof MemoryError) {
            send(error.code === 'conflict' ? 409 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'GET' && entryId !== undefined) {
        try {
          send(200, await deps.memory.read(scope, entryId))
        } catch (error) {
          if (error instanceof MemoryError && error.code === 'not-found') {
            send(404, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'PATCH' && entryId !== undefined) {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        if (typeof body['expectedHash'] !== 'string') {
          send(400, { error: "body needs 'expectedHash' from the last read" })
          return
        }
        try {
          const updated = await deps.memory.update(scope, {
            id: entryId,
            expectedHash: body['expectedHash'],
            ...(typeof body['title'] === 'string' ? { title: body['title'] } : {}),
            ...(typeof body['body'] === 'string' ? { body: body['body'] } : {}),
            ...(body['pinned'] === true ? { pinned: true } : body['pinned'] === false ? { pinned: false } : {}),
          })
          send(200, updated)
        } catch (error) {
          if (error instanceof MemoryError) {
            send(error.code === 'conflict' ? 409 : error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'DELETE' && entryId !== undefined) {
        requireWorkspace(deps, wsId, true)
        await deps.memory.forget(scope, entryId)
        send(200, { forgotten: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── per-session model control ─────────────────────────────
    const wsSessionModelMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/model$/.exec(pathname)
    if (wsSessionModelMatch !== null) {
      const wsId = decodeURIComponent(wsSessionModelMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsSessionModelMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      if (deps.unavailableSessions.has(entry.session.id)) {
        send(503, { error: 'session unavailable after durable storage failure; restart the host to reload canonical history' })
        return
      }
      if (req.method === 'GET') {
        const effective = deps.resolveEffectiveModel(entry.session, wsId)
        send(200, {
          provider: effective.provider ?? null,
          model: effective.model ?? null,
          thinkingLevel: effective.thinkingLevel ?? null,
          source: effective.source,
        })
        return
      }
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true)
        const outcome = await putSessionModel(entry, req, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        const effective = deps.resolveEffectiveModel(entry.session, wsId)
        send(200, {
          provider: effective.provider ?? null,
          model: effective.model ?? null,
          thinkingLevel: effective.thinkingLevel ?? null,
          source: 'session',
        })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── G3 context manifest inspector + manual compaction ────
    const wsManifestMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/manifest$/.exec(pathname)
    if (wsManifestMatch !== null && req.method === 'GET') {
      const wsId = decodeURIComponent(wsManifestMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsManifestMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      const manifest = deps.lastManifests.get(entry.session.id)
      if (manifest === undefined) {
        // This is a valid state for a newly created or historical conversation,
        // not a missing endpoint. Returning 204 keeps the inspector quiet.
        res.writeHead(204)
        res.end()
        return
      }
      send(200, manifest)
      return
    }

    const wsCompactMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/compact$/.exec(pathname)
    if (wsCompactMatch !== null && req.method === 'POST') {
      const wsId = decodeURIComponent(wsCompactMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsCompactMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      try {
        const hooks = await deps.mcpStore.loadHooks(wsId)
        for (const binding of hooks.hooks['PreCompact'] ?? []) {
          const decision = await runHook(binding, { hook_event: 'PreCompact', sessionId: entry.session.id, workspaceId: wsId })
          entry.session.append({ type: 'hook/run', event: 'PreCompact', matcher: binding.matcher, exitCode: decision.exitCode, durationMs: decision.durationMs, decision: isBlockingDecision(decision) ? 'block' : isFailureDecision(decision) ? `failure:${binding.onFailure}` : 'allow' })
          await entry.session.durable()
          if (isBlockingDecision(decision) || (isFailureDecision(decision) && binding.onFailure === 'deny')) {
            send(409, { error: `PreCompact hook blocked compaction: ${binding.command}` })
            return
          }
        }
        const { compactSession } = await import('../harness/context/compaction.ts')
        const checkpoint = await compactSession(entry.session, deps.checkpoints, async ({ text }) => {
          // Bounded extractive summarizer: the host-side default keeps the
          // first lines of every exchange (no model call, no side effects).
          const lines = text.split('\n').filter((line) => line.trim() !== '')
          return lines.slice(0, 120).join('\n')
        }, (() => {
          const model = deps.defaults().model
          return model !== null ? { trigger: 'manual' as const, model } : { trigger: 'manual' as const }
        })())
        send(200, { coversSeq: checkpoint.coversSeq, summaryChars: checkpoint.summary.length })
      } catch (error) {
        send(409, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    // ── projects ─────────────────────────────────────────────
    const wsProjectsMatch = /^\/api\/workspaces\/([^/]+)\/projects$/.exec(pathname)
    if (wsProjectsMatch !== null) {
      const wsId = decodeURIComponent(wsProjectsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method === 'GET') {
        send(200, deps.workspaces.listProjects(wsId))
        return
      }
      if (req.method === 'POST') {
        requireWorkspace(deps, wsId, true) // archived: no new projects
        const body = await readJson(req)
        const name = typeof body['name'] === 'string' ? body['name'] : ''
        const projectPath = body['path']
        if (typeof projectPath !== 'string' || projectPath.trim() === '') {
          send(400, { error: "body needs a non-empty string 'path'" })
          return
        }
        const created = await deps.workspaces.createProject(wsId, name, projectPath)
        send(201, created)
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── sidebar project order (drag to reorder) ────────────────
    // Matched before the /:pid route below, which would otherwise capture
    // 'order' as a project id.
    const wsProjectOrderMatch = /^\/api\/workspaces\/([^/]+)\/projects\/order$/.exec(pathname)
    if (wsProjectOrderMatch !== null) {
      const wsId = decodeURIComponent(wsProjectOrderMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true) // archived: no project mutations
        const body = await readJson(req)
        const order = Array.isArray(body['order']) ? body['order'] : null
        if (order === null || order.some((id) => typeof id !== 'string')) {
          send(400, { error: "body needs 'order' as an array of project ids" })
          return
        }
        send(200, await deps.workspaces.reorderProjects(wsId, order as ProjectId[]))
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── composer attachments ──────────────────────────────────
    // Upload takes raw bytes with the name in a header: the store validates
    // the type against the bytes and answers with the reference a message
    // carries. Reading back serves the stored bytes for previews; the type is
    // sniffed rather than trusted from a caller.
    const wsAttachmentsMatch = /^\/api\/workspaces\/([^/]+)\/attachments(?:\/([^/]+))?$/.exec(pathname)
    if (wsAttachmentsMatch !== null) {
      const wsId = decodeURIComponent(wsAttachmentsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const id = wsAttachmentsMatch[2]
      try {
        if (id === undefined && req.method === 'POST') {
          requireWorkspace(deps, wsId, true) // archived: no new content
          const name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')).trim()
          const bytes = await readBytes(req, deps.limits.maxAttachmentBytes)
          const stored = await deps.attachments.put(wsId, {
            name: name === '' ? 'attachment' : name,
            mediaType: String(req.headers['content-type'] ?? ''),
            bytes,
          })
          send(201, stored)
          return
        }
        if (id !== undefined && req.method === 'GET') {
          const bytes = await deps.attachments.read(wsId, decodeURIComponent(id))
          res.writeHead(200, {
            'content-type': sniffImageMediaType(bytes) ?? 'text/plain; charset=utf-8',
            'content-length': bytes.length,
            // Content-addressed: the bytes behind an id can never change.
            'cache-control': 'private, max-age=31536000, immutable',
          })
          res.end(bytes)
          return
        }
        send(405, { error: 'method not allowed' })
      } catch (error) {
        if (!(error instanceof AttachmentError)) throw error
        send(400, { error: error.message })
      }
      return
    }

    // ── interactive terminals (workbench Terminal) ─────────────
    // A user-driven shell, not an agent tool: no approval gate, no durable
    // event, no session ownership. Gated on a loopback bind because the page
    // that reaches these routes can run anything the host user can.
    const wsTerminalsMatch = /^\/api\/workspaces\/([^/]+)\/terminals(?:\/(.+))?$/.exec(pathname)
    if (wsTerminalsMatch !== null) {
      const wsId = decodeURIComponent(wsTerminalsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (!deps.terminalsEnabled) {
        send(404, { error: 'terminals are disabled on this host' })
        return
      }
      if (!deps.terminalsLoopback) {
        send(403, {
          error: 'terminals are served only on a loopback bind; a network-reachable terminal is remote code execution',
        })
        return
      }
      const rest = wsTerminalsMatch[2]
      try {
        // `events` is checked before the id routes: otherwise it reads as a
        // terminal id and the stream endpoint disappears.
        if (rest === 'events' && req.method === 'GET') {
          streamTerminals(req, res, wsId, deps)
          return
        }
        if (rest === undefined) {
          if (req.method === 'GET') {
            const probe = await deps.terminals.probe()
            send(200, {
              terminals: deps.terminals.list(wsId),
              shells: deps.terminals.shells(),
              max: 4,
              available: probe.available,
              ...(probe.available ? {} : { unavailable: probe.hint }),
            })
            return
          }
          if (req.method === 'POST') {
            requireWorkspace(deps, wsId, true) // archived: no new work
            const body = await readJson(req)
            const cwd = await resolveTerminalCwd(wsId, body, deps)
            if (cwd.ok === false) {
              send(cwd.status, { error: cwd.error })
              return
            }
            const startCols = terminalDimension(body['cols'])
            const startRows = terminalDimension(body['rows'])
            const info = await deps.terminals.create({
              workspaceId: wsId,
              cwd: cwd.path,
              ...(typeof body['projectId'] === 'string' && body['projectId'] !== '' ? { projectId: body['projectId'] as ProjectId } : {}),
              ...(typeof body['shellId'] === 'string' ? { shellId: body['shellId'] as never } : {}),
              ...(startCols !== undefined ? { cols: startCols } : {}),
              ...(startRows !== undefined ? { rows: startRows } : {}),
            })
            send(201, info)
            return
          }
          send(405, { error: 'method not allowed' })
          return
        }
        const action = /^([^/]+)\/(input|resize)$/.exec(rest)
        if (action !== null) {
          const id = decodeURIComponent(action[1] ?? '')
          if (deps.terminals.get(id)?.workspaceId !== wsId) {
            send(404, { error: `unknown terminal '${id}'` })
            return
          }
          if (req.method !== 'POST') {
            send(405, { error: 'method not allowed' })
            return
          }
          const body = await readJson(req)
          if (action[2] === 'input') {
            const data = body['data']
            if (typeof data !== 'string') {
              send(400, { error: "'data' must be a base64 string" })
              return
            }
            deps.terminals.write(id, Buffer.from(data, 'base64').toString('utf8'))
            send(202, { accepted: true })
            return
          }
          // `NaN < 1` is false, so a bare range check lets NaN and Infinity
          // through to node-pty, which throws a plain Error and turns a bad
          // request into a 500.
          const cols = terminalDimension(body['cols'])
          const rows = terminalDimension(body['rows'])
          if (cols === undefined || rows === undefined) {
            send(400, { error: "'cols' and 'rows' must be finite numbers between 1 and 1000" })
            return
          }
          deps.terminals.resize(id, cols, rows)
          send(200, deps.terminals.get(id))
          return
        }
        const id = decodeURIComponent(rest)
        if (deps.terminals.get(id)?.workspaceId !== wsId) {
          send(404, { error: `unknown terminal '${id}'` })
          return
        }
        if (req.method === 'DELETE') {
          deps.terminals.kill(id)
          send(200, { killed: true })
          return
        }
        send(405, { error: 'method not allowed' })
      } catch (error) {
        if (!(error instanceof TerminalError)) throw error
        const status = error.code === 'unavailable' ? 501 : error.code === 'not-found' ? 404 : 400
        send(status, { error: error.message })
      }
      return
    }

    // ── read-only project browsing (workbench Files) ───────────
    const wsProjectFilesMatch = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/(files|file|search)$/.exec(pathname)
    if (wsProjectFilesMatch !== null) {
      const wsId = decodeURIComponent(wsProjectFilesMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const project = deps.workspaces.getProject(decodeURIComponent(wsProjectFilesMatch[2] ?? '') as ProjectId, wsId)
      if (req.method !== 'GET') {
        send(405, { error: 'method not allowed' })
        return
      }
      try {
        const target = query.get('path') ?? ''
        const kind = wsProjectFilesMatch[3]
        if (kind === 'search') {
          const rawLimit = Number.parseInt(query.get('limit') ?? '', 10)
          send(200, await searchProjectFiles(
            project.path,
            query.get('q') ?? '',
            deps.deniedRoots,
            Number.isNaN(rawLimit) ? undefined : rawLimit,
          ))
          return
        }
        send(200, kind === 'files'
          ? await listProjectEntries(project.path, target, deps.deniedRoots)
          : await readProjectFile(project.path, target, deps.deniedRoots))
      } catch (error) {
        if (!(error instanceof ProjectFileError)) throw error
        send(400, { error: error.message })
      }
      return
    }

    const wsProjectMatch = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)$/.exec(pathname)
    if (wsProjectMatch !== null) {
      const wsId = decodeURIComponent(wsProjectMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const pid = decodeURIComponent(wsProjectMatch[2] ?? '') as ProjectId
      if (req.method === 'PATCH') {
        requireWorkspace(deps, wsId, true) // archived: no project mutations
        const body = await readJson(req)
        let updated: ProjectRecord = deps.workspaces.getProject(pid, wsId)
        if (typeof body['name'] === 'string' && body['name'].trim() !== '') {
          updated = await deps.workspaces.renameProject(pid, wsId, body['name'])
        }
        if (typeof body['path'] === 'string') {
          // Retargeting requires idle execution on the project.
          for (const entry of deps.sessions.values()) {
            if (entry.projectId === pid && entry.agent.busy) {
              send(409, { error: 'project has running sessions; stop them before changing the folder' })
              return
            }
          }
          updated = await deps.workspaces.setProjectPath(pid, wsId, body['path'])
        }
        send(200, updated)
        return
      }
      if (req.method === 'DELETE') {
        requireWorkspace(deps, wsId, true)
        deps.workspaces.getProject(pid, wsId)
        // A registered root cannot be removed while any durable conversation
        // references it. Never append a detachment event as a side effect.
        for (const summary of deps.kernel.ctx.sessions.summaries()) {
          if (deps.kernel.ctx.sessions.workspaceOf(summary.id) !== wsId) continue
          const session = deps.sessions.get(summary.id)?.session ?? await deps.kernel.ctx.sessions.load(summary.id)
          if (session !== undefined && boundProject(session) === pid) {
            send(409, { error: 'Project is bound to conversations. Delete those conversations explicitly before removing this registration; existing project bindings cannot be changed.' })
            return
          }
        }
        await deps.workspaces.deleteProject(pid, wsId)
        send(200, { deleted: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── filesystem browser (folder picker) ────────────────────
    // Directory NAMES only — the client's "Choose folder…" picker navigates
    // real machine folders because a browser never reveals absolute paths.
    // Localhost-bound like the rest of the API; no file contents leak.
    if (req.method === 'GET' && pathname === '/api/fs/dirs') {
      const raw = query.get('path') ?? ''
      const abs = path.resolve(raw.trim() === '' ? homedir() : raw)
      let entries: Dirent[]
      try {
        const stat = await fs.stat(abs)
        if (!stat.isDirectory()) {
          send(400, { error: `'${raw}' is not a directory` })
          return
        }
        entries = await fs.readdir(abs, { withFileTypes: true })
      } catch (error) {
        send(400, { error: `cannot open '${abs}': ${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const dirs: { name: string; path: string }[] = []
      for (const entry of entries) {
        if (entry.isDirectory()) {
          dirs.push({ name: entry.name, path: path.join(abs, entry.name) })
        } else if (entry.isSymbolicLink()) {
          // Symlinked folders count as navigable; broken links are skipped.
          const target = await fs.stat(path.join(abs, entry.name)).then((s) => s.isDirectory(), () => false)
          if (target) dirs.push({ name: entry.name, path: path.join(abs, entry.name) })
        }
      }
      const up = path.dirname(abs)
      dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      if (process.platform === 'win32' && path.parse(abs).root === abs) {
        // A drive root cannot go higher; offer the machine's other drives so
        // the picker can move between them.
        const drives = (await Promise.all('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(async (letter) => {
          const drive = `${letter}:\\`
          const ok = await fs.stat(drive).then((s) => s.isDirectory(), () => false)
          return ok ? { name: drive, path: drive } : null
        }))).filter((drive): drive is { name: string; path: string } => drive !== null)
        dirs.unshift(...drives.filter((drive) => drive.path.toLowerCase() !== abs.toLowerCase()))
      }
      send(200, { path: abs, parent: up === abs ? null : up, dirs })
      return
    }

    // ── dangerous command guard ────────────────────────────────
    // Workspace-scoped: GET requires workspaceId query, PUT requires
    // workspaceId in body and an active workspace. Global routes use
    // /global suffix for the shared default.
    if (pathname === '/api/guard/dangerous-commands') {
      if (req.method === 'GET') {
        const rawId = query.get('workspaceId')
        if (typeof rawId !== 'string' || rawId.trim() === '') {
          send(400, { error: "query needs 'workspaceId'" })
          return
        }
        const wid = rawId.trim() as WorkspaceId
        try {
          requireWorkspace(deps, wid, false)
        } catch (error) {
          fail(error)
          return
        }
        const result = await deps.dangerousStore.load(wid)
        send(200, result)
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const rawId = body['workspaceId']
        if (typeof rawId !== 'string' || rawId.trim() === '') {
          send(400, { error: "body needs 'workspaceId'" })
          return
        }
        const wid = rawId.trim() as WorkspaceId
        try {
          requireWorkspace(deps, wid, true)
        } catch (error) {
          fail(error)
          return
        }
        const config = body['config']
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          send(400, { error: "body needs 'config' object" })
          return
        }
        const expectedHash = typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined
        try {
          const result = await deps.dangerousStore.save(wid, config as never, expectedHash)
          // Invalidate guard cache so re-evaluation reflects the new config.
          deps.dangerousGuard.clearForWorkspace(wid)
          deps.approvalHandle.reevaluate({ workspaceId: wid })
          send(200, result)
        } catch (error) {
          const msg = String(error instanceof Error ? error.message : error)
          if (/conflict/i.test(msg)) { send(409, { error: msg }); return }
          send(400, { error: msg })
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    if (pathname === '/api/guard/dangerous-commands/global') {
      if (req.method === 'GET') {
        const result = await deps.dangerousStore.loadGlobal()
        send(200, result)
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const config = body['config']
        if (config === null || typeof config !== 'object' || Array.isArray(config)) {
          send(400, { error: "body needs 'config' object" })
          return
        }
        const expectedHash = typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined
        try {
          const result = await deps.dangerousStore.saveGlobal(config as never, expectedHash)
          for (const ws of deps.workspaces.list({ includeArchived: true })) {
            const hasFile = await deps.dangerousStore.hasWorkspaceFile(ws.id)
            if (!hasFile) {
              deps.dangerousGuard.clearForWorkspace(ws.id)
              deps.approvalHandle.reevaluate({ workspaceId: ws.id })
            }
          }
          send(200, result)
        } catch (error) {
          const msg = String(error instanceof Error ? error.message : error)
          if (/conflict/i.test(msg)) { send(409, { error: msg }); return }
          send(400, { error: msg })
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // ── provider registry (app-wide; selection is per workspace) ──
    if (req.method === 'GET' && pathname === '/api/providers') {
      send(200, deps.providers().map(publicProvider))
      return
    }

    if (req.method === 'POST' && pathname === '/api/providers') {
      const body = await readJson(req)
      const created = await createProvider(deps, body)
      if (!created.ok) {
        send(created.status, { error: created.error })
        return
      }
      send(201, publicProvider(created.entry))
      return
    }

    const providerMatch = /^\/api\/providers\/([^/]+)$/.exec(pathname)
    if (req.method === 'PATCH' && providerMatch !== null) {
      const id = decodeURIComponent(providerMatch[1] ?? '')
      const body = await readJson(req)
      const patched = await patchProvider(deps, id, body)
      if (!patched.ok) {
        send(patched.status, { error: patched.error })
        return
      }
      send(200, publicProvider(patched.entry))
      return
    }

    if (req.method === 'DELETE' && providerMatch !== null) {
      const id = decodeURIComponent(providerMatch[1] ?? '')
      const deleted = await deps.mutateProviderStore(({ providers, defaults }) => {
        if (!providers.some((entry) => entry.id === id)) return { providers, defaults, result: false }
        return { providers: providers.filter((entry) => entry.id !== id), defaults, result: true }
      })
      if (!deleted) { send(404, { error: `no provider '${id}'` }); return }
      send(200, { deleted: true })
      return
    }

    const testMatch = /^\/api\/providers\/([^/]+)\/test$/.exec(pathname)
    if (req.method === 'POST' && testMatch !== null) {
      const entry = deps.providers().find((e) => e.id === decodeURIComponent(testMatch[1] ?? ''))
      if (entry === undefined) {
        send(404, { error: 'no such provider' })
        return
      }
      // An optional body names the exact model to ping, so the Settings model
      // list can verify one row. Without it the provider's first model stands
      // in — and `test` when it advertises none yet, which is how a freshly
      // added provider checks its endpoint and key before any sync.
      const body = await readJson(req).catch(() => ({})) as Record<string, unknown>
      const requested = body['model']
      if (requested !== undefined && (typeof requested !== 'string' || requested === '')) {
        send(400, { error: "'model' must be a non-empty string" })
        return
      }
      let model: string
      if (typeof requested === 'string') {
        // Fail loud on an unadvertised id: a silent upstream 404 would read as
        // "the model is broken" when the id is simply wrong.
        try {
          deps.validateProviderModel(entry.id, requested)
        } catch (error) {
          send(400, { error: String(error instanceof Error ? error.message : error) })
          return
        }
        model = requested
      } else {
        model = entry.models[0] ?? 'test'
      }
      const outcome = await pingCompletions(entry, model)
      send(outcome.ok ? 200 : 502, outcome)
      return
    }

    // Probe only: what the endpoint offers, with nothing written. The browser
    // merges the answer into its draft and saves through the ordinary PATCH,
    // so a sync the operator has not confirmed cannot change stored models.
    const providerModelsMatch = /^\/api\/providers\/([^/]+)\/models$/.exec(pathname)
    if (req.method === 'GET' && providerModelsMatch !== null) {
      const entry = deps.providers().find((candidate) => candidate.id === decodeURIComponent(providerModelsMatch[1] ?? ''))
      if (entry === undefined) {
        send(404, { ok: false, error: 'no such provider' })
        return
      }
      const outcome = await fetchEndpointModels(entry)
      send(outcome.ok ? 200 : outcome.status, outcome.ok ? { ok: true, models: outcome.models } : { ok: false, error: outcome.error })
      return
    }

    const syncMatch = /^\/api\/providers\/([^/]+)\/sync$/.exec(pathname)
    if (req.method === 'POST' && syncMatch !== null) {
      const id = decodeURIComponent(syncMatch[1] ?? '')
      try {
        const outcome = await deps.mutateProviderStore<{ ok: true; models: string[] } | { ok: false; status: number; error: string }>(async ({ providers, defaults }) => {
          const entry = providers.find((candidate) => candidate.id === id)
          if (entry === undefined) return { providers, defaults, result: { ok: false as const, status: 404, error: 'no such provider' } }
          const probe = await fetchEndpointModels(entry)
          if (!probe.ok) return { providers, defaults, result: { ok: false as const, status: probe.status, error: probe.error } }
          const models = probe.models
          return {
            providers: providers.map((candidate) => candidate.id === id ? { ...candidate, models } : candidate),
            defaults,
            result: { ok: true as const, models },
          }
        })
        if (!outcome.ok) { send(outcome.status, { ok: false, error: outcome.error }); return }
        send(200, { ok: true, models: outcome.models })
      } catch (error) {
        send(502, { ok: false, error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    // Approvals bind to the authenticated principal. The UUID alone is not a bearer.
    const approvalMatch = /^\/api\/approvals\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && approvalMatch !== null) {
      const approvalId = approvalMatch[1] ?? ''
      const waiting = deps.pending.get(approvalId)
      if (deps.auth.enabled) {
        const decision = deps.auth.authenticate(req.headers, 'POST')
        if (!decision.ok || decision.principal.kind !== 'browser') {
          send(401, { error: 'approval answers require the browser session that owns the workspace' })
          return
        }
        const owner = waiting?.principalId
        if (owner !== undefined && owner !== decision.principal.id) {
          send(403, { error: 'approval belongs to a different principal' })
          return
        }
      }
      if (waiting === undefined) {
        // Unknown ids include expired, invalidated, and already-settled
        // approvals: a stale decision can never execute a tool.
        send(404, { error: 'no such approval' })
        return
      }
      const body = await readJson(req)
      const allow = body['allow']
      if (typeof allow !== 'boolean') {
        send(400, { error: 'body needs a boolean allow' })
        return
      }
      // Deleting must win the entry: a false return means expiry, stop, or a
      // policy change settled it while the body was being read — the answer
      // is late and the 404 is the truthful response.
      if (!deps.pending.delete(approvalId)) {
        send(404, { error: 'no such approval' })
        return
      }
      waiting.resolve(allow)
      send(200, { answered: true })
      return
    }

    send(404, { error: 'no such route' })
  } catch (error) {
    fail(error)
  }
}

// ── session operation helpers ──────────────────────────────────

/** Serialize a definition to canonical Markdown/frontmatter for import. */
function serializeDefinition(definition: import('../harness/agents/definition-service.ts').AgentDefinition): string {
  const fm = [
    `name: ${JSON.stringify(definition.name)}`,
    `description: ${JSON.stringify(definition.description)}`,
    `tools: ${JSON.stringify(definition.tools)}`,
    `disallowedTools: ${JSON.stringify(definition.disallowedTools)}`,
    ...(definition.skills !== undefined ? [`skills: ${JSON.stringify(definition.skills)}`] : []),
    ...(definition.model !== undefined ? [`model: ${JSON.stringify(definition.model)}`] : []),
    ...(definition.maxTurns !== undefined ? [`maxTurns: ${definition.maxTurns}`] : []),
    ...(definition.inheritable !== undefined ? [`inheritable: ${definition.inheritable}`] : []),
  ]
  return `---\n${fm.join('\n')}\n---\n\n${definition.instructions.trim()}\n`
}

/** The workspace owning sessions when the caller does not address one. */
function implicitWorkspace(deps: HandlerDeps): WorkspaceId {
  return deps.deniedRoots !== undefined ? defaultWorkspaceId(deps) : MEMORY_WORKSPACE
}

/** Operational lookup: the synthetic memory workspace bypasses the registry. */
function requireWorkspace(deps: HandlerDeps, workspaceId: WorkspaceId, active: boolean): void {
  if (workspaceId === MEMORY_WORKSPACE && deps.deniedRoots === undefined) return
  if (active) deps.workspaces.requireActive(workspaceId)
  else deps.workspaces.get(workspaceId)
}

/**
 * One PATCH surface for the conversation's own metadata: `pinned` when the
 * body carries it, the title otherwise. Pins, like renames, are canonical
 * events — a rebuild from `events.jsonl` alone reproduces them.
 */
async function patchSession(
  entry: SessionEntry,
  body: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true; payload: Record<string, unknown> }> {
  if ('pinned' in body) {
    if (typeof body['pinned'] !== 'boolean') return { ok: false, status: 400, error: 'pinned must be a boolean' }
    entry.session.append({ type: 'session/pinned', pinned: body['pinned'] })
    try {
      await entry.session.durable()
    } catch (error) {
      return { ok: false, status: 500, error: `pin could not be recorded: ${String(error instanceof Error ? error.message : error)}` }
    }
    await deps.kernel.ctx.sessions.flushSummary(entry.session).catch(() => {})
    return { ok: true, payload: { id: entry.session.id, pinned: entry.session.pinned } }
  }
  const outcome = await renameSession(entry, body['title'], deps)
  return outcome.ok ? { ok: true, payload: { id: entry.session.id, title: outcome.title } } : outcome
}

async function renameSession(
  entry: SessionEntry,
  title: unknown,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true; title: string }> {
  if (typeof title !== 'string') {
    return { ok: false, status: 400, error: 'body needs a string title (empty to reset to the derived title)' }
  }
  const trimmed = title.trim()
  // Renames are canonical events, not just summary state, so a rebuild from
  // events.jsonl alone reproduces the title.
  entry.session.append({ type: 'session/title', title: trimmed === '' ? null : trimmed.slice(0, 80) })
  try {
    await entry.session.durable()
  } catch (error) {
    return { ok: false, status: 500, error: `rename could not be recorded: ${String(error instanceof Error ? error.message : error)}` }
  }
  // The summary is rebuildable: a failure here degrades the projection,
  // not the canonical fact, so the rename still succeeds.
  await deps.kernel.ctx.sessions.flushSummary(entry.session).catch(() => {})
  return { ok: true, title: entry.session.customTitle ?? deriveTitle(entry.session.events) ?? 'New conversation' }
}

/** Validate the attachment references a submitted message claims to carry. */
function parseAttachments(
  raw: unknown,
  maxPerMessage: number,
): { ok: false; status: number; error: string } | { ok: true; refs: readonly AttachmentRef[] } {
  if (raw === undefined) return { ok: true, refs: [] }
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'attachments must be an array' }
  if (raw.length > maxPerMessage) {
    return { ok: false, status: 400, error: `a message may carry at most ${maxPerMessage} attachments` }
  }
  const refs: AttachmentRef[] = []
  for (const item of raw as unknown[]) {
    if (item === null || typeof item !== 'object') {
      return { ok: false, status: 400, error: 'each attachment must be an object' }
    }
    const row = item as Record<string, unknown>
    const id = row['id']
    const name = row['name']
    const mediaType = row['mediaType']
    const bytes = row['bytes']
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
      return { ok: false, status: 400, error: 'each attachment needs the id returned by the upload' }
    }
    if (typeof name !== 'string' || name.trim() === '' || typeof mediaType !== 'string') {
      return { ok: false, status: 400, error: 'each attachment needs a name and mediaType' }
    }
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
      return { ok: false, status: 400, error: 'each attachment needs its stored size in bytes' }
    }
    if (!isSupportedMediaType(mediaType)) {
      return { ok: false, status: 400, error: `'${name}' has unsupported type '${normalizeMediaType(mediaType)}'` }
    }
    refs.push({ id, name, mediaType: normalizeMediaType(mediaType), bytes })
  }
  return { ok: true, refs }
}

async function acceptMessage(
  entry: SessionEntry,
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true; status: number; body: Record<string, unknown> }> {
  // A child session is driven by the ChildExecutor only. Accepting input here
  // would run it as a plain root Agent — no role prompt, no tool ceiling, no
  // one-level guard — so the durable child record refuses it outright.
  if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
    return { ok: false, status: 409, error: 'this is a child agent session; it is executor-managed and cannot receive messages or be resumed directly' }
  }
  const body = await readJson(req)
  const content = body['content']
  if (typeof content !== 'string') {
    return { ok: false, status: 400, error: 'body needs a string content' }
  }
  const parsedAttachments = parseAttachments(body['attachments'], deps.limits.maxAttachmentsPerMessage)
  if (!parsedAttachments.ok) return parsedAttachments
  const refs = parsedAttachments.refs
  // An attachment is a message on its own; only a wholly empty submission is
  // refused.
  if (content.trim() === '' && refs.length === 0) {
    return { ok: false, status: 400, error: 'body needs a non-empty string content' }
  }
  // Archived workspaces cannot start new work (memory ws exempt).
  requireWorkspace(deps, entry.workspaceId, true)
  for (const ref of refs) {
    try {
      await deps.attachments.verify(entry.workspaceId, ref)
    } catch (error) {
      if (!(error instanceof AttachmentError)) throw error
      return { ok: false, status: 400, error: error.message }
    }
  }
  const principalId = (req as IncomingMessage & { miniDshPrincipalId?: string }).miniDshPrincipalId
  if (principalId !== undefined) deps.sessionPrincipals.set(entry.session.id, principalId)
  if (deps.unavailableSessions.has(entry.session.id)) {
    return { ok: false, status: 503, error: 'session unavailable after durable storage failure; restart the host to reload canonical history' }
  }
  const effectiveModel = deps.resolveEffectiveModel(entry.session, entry.workspaceId)
  if (effectiveModel.model === undefined || effectiveModel.model === null || effectiveModel.provider === undefined || effectiveModel.provider === null) {
    return { ok: false, status: 400, error: 'no provider/model configured for this session; manage providers in settings' }
  }
  try {
    deps.validateProviderModel(effectiveModel.provider, effectiveModel.model)
  } catch (error) {
    return { ok: false, status: 400, error: `configured session provider/model is unavailable: ${String(error instanceof Error ? error.message : error)}` }
  }

  // Transport-retry dedup, resolved against the canonical log: a
  // clientRequestId already accepted by THIS session returns the original
  // input instead of queueing a second execution. Per-session and
  // restart-safe by construction.
  const clientRequestId = typeof body['clientRequestId'] === 'string' && body['clientRequestId'] !== ''
    ? body['clientRequestId']
    : undefined
  if (clientRequestId !== undefined) {
    const prior = entry.session.events.find(
      (event) => event.type === 'input/queued' && event.clientRequestId === clientRequestId,
    )
    if (prior?.type === 'input/queued') {
      return { ok: true, status: 200, body: { inputId: prior.inputId, duplicate: true } }
    }
  }

  // Re-adopt anything accepted but never consumed (a stop left it queued,
  // or a previous run failed): accepted input is never lost.
  const stillPending = deps.kernel.ctx.sessions.pendingInputs(entry.session)
  for (const item of stillPending) {
    entry.agent.enqueueAccepted(item)
  }

  if (stillPending.length >= deps.limits.maxPendingInputs) {
    return { ok: false, status: 429, error: `too many queued inputs (limit ${deps.limits.maxPendingInputs})` }
  }

  // Durable acceptance before the driver sees the input.
  const inputId = newInputId()
  entry.session.append({
    type: 'input/queued',
    inputId,
    ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    content,
    ...(refs.length > 0 ? { attachments: refs } : {}),
  })
  try {
    await entry.session.durable()
  } catch (error) {
    return { ok: false, status: 500, error: `input could not be durably accepted: ${String(error instanceof Error ? error.message : error)}` }
  }

  const wasBusy = entry.agent.busy
  entry.agent.enqueueAccepted({ content, inputId, ...(refs.length > 0 ? { attachments: refs } : {}) })
  if (!wasBusy) {
    // Fire-and-forget: the reply (and any failure, which closes the turn
    // durably) reaches the client through the SSE stream.
    void entry.agent.run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`web: agent run failed for ${entry.session.id}: ${message}`)
      deps.kernel.ctx.emit('web/turn-error', { sessionId: entry.session.id, message })
    })
  }
  return { ok: true, status: 202, body: { inputId, queued: wasBusy } }
}

async function putSessionModel(
  entry: SessionEntry,
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true }> {
  const body = await readJson(req)
  const provider = body['provider']
  const model = body['model']
  const thinkingLevel = body['thinkingLevel']
  if ((provider !== undefined && provider !== null && typeof provider !== 'string')
    || (model !== undefined && model !== null && typeof model !== 'string')) {
    return { ok: false, status: 400, error: "body accepts optional string|null 'provider' and 'model'" }
  }
  if (thinkingLevel !== undefined && thinkingLevel !== null && !isThinkingLevel(thinkingLevel)) {
    return { ok: false, status: 400, error: "'thinkingLevel' must be off|minimal|low|medium|high|xhigh|max, or null" }
  }
  if (provider === undefined && model === undefined && thinkingLevel === undefined) {
    return { ok: false, status: 400, error: "body needs at least one of 'provider', 'model', or 'thinkingLevel'" }
  }
  const prior = sessionModelOf(entry.session.events)
  // A legacy session's first mutation snapshots today's global pair. Once a
  // session/model event exists, its fields are the whole source of truth:
  // null is an explicit blank, never a request to re-inherit global defaults.
  const global = deps.defaults()
  const priorProvider = prior.hasEvent ? prior.provider : global.provider
  const priorModel = prior.hasEvent ? prior.model : global.model
  const resultingProvider = provider === undefined ? priorProvider : provider
  const resultingModel = model === undefined ? priorModel : model
  const hasProvider = resultingProvider !== undefined && resultingProvider !== null
  const hasModel = resultingModel !== undefined && resultingModel !== null
  if (hasProvider !== hasModel) {
    return { ok: false, status: 400, error: 'provider and model must both be configured or both be blank' }
  }
  if (hasProvider && hasModel) {
    try {
      deps.validateProviderModel(resultingProvider, resultingModel)
    } catch (error) {
      return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
    }
  }
  entry.session.append({
    type: 'session/model',
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  })
  try {
    await entry.session.durable()
  } catch (error) {
    // Session.append cannot roll back its in-memory event. Fence this instance
    // instead of ever serving or executing from uncommitted state.
    deps.unavailableSessions.add(entry.session.id)
    return { ok: false, status: 500, error: `session model could not be persisted; session is unavailable until restart: ${String(error instanceof Error ? error.message : error)}` }
  }
  // The global default is the "model last chosen" pointer: repoint it whenever
  // a conversation adopts a model, so the NEXT conversation opens on it without
  // the operator re-picking. Only an explicit pair does this — a thinking-only
  // edit is conversation-scoped and must never repoint the global model. This
  // is a convenience pointer, so a failed write must not fail the model switch
  // that already committed durably to this session.
  if ((provider !== undefined || model !== undefined) && hasProvider && hasModel) {
    const steady = deps.defaults()
    if (steady.provider !== resultingProvider || steady.model !== resultingModel) {
      await deps.mutateProviderStore(({ providers, defaults }) => ({
        providers,
        defaults: { provider: resultingProvider, model: resultingModel, thinkingLevel: defaults.thinkingLevel },
        result: undefined,
      }), { clearRuntimeModelOverride: true }).catch((error: unknown) => {
        console.error(`web: global default could not follow session ${entry.session.id}: ${String(error instanceof Error ? error.message : error)}`)
      })
    }
  }
  return { ok: true }
}

async function putModel(
  _workspaceId: WorkspaceId,
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true }> {
  const body = await readJson(req)
  const rawModel = body['model']
  const rawProvider = body['provider']
  if ((rawModel !== undefined && typeof rawModel !== 'string') || (rawProvider !== undefined && typeof rawProvider !== 'string')) {
    return { ok: false, status: 400, error: "body accepts optional strings 'model' and 'provider'" }
  }
  const current = deps.defaults()
  const provider = rawProvider ?? current.provider
  if (provider === null || provider === undefined || provider === '') return { ok: false, status: 400, error: 'no provider configured yet' }
  // The model is never inferred from the provider: an operator switching
  // providers must name the model, so a stale guess can never be billed or run.
  if (rawModel === undefined || rawModel === '') return { ok: false, status: 400, error: "body needs a non-empty string 'model'" }
  const model = rawModel
  try {
    deps.validateProviderModel(provider, model)
  } catch (error) {
    return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
  }
  const next: ModelDefaults = { provider, model, thinkingLevel: current.thinkingLevel }
  try {
    await deps.mutateProviderStore(({ providers, defaults }) => ({ providers, defaults: { provider: next.provider, model: next.model, thinkingLevel: defaults.thinkingLevel }, result: undefined })), { clearRuntimeModelOverride: true }
    return { ok: true }
  } catch (error) {
    return { ok: false, status: 500, error: `global model defaults could not be persisted: ${String(error instanceof Error ? error.message : error)}` }
  }
}

async function putModelDefaults(req: IncomingMessage, deps: HandlerDeps): Promise<{ ok: false; status: number; error: string } | { ok: true }> {
  const body = await readJson(req)
  const provider = body['provider']; const model = body['model']; const thinkingLevel = body['thinkingLevel']
  if (!Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'model')) return { ok: false, status: 400, error: "body needs complete 'provider' and 'model' pair" }
  if ((provider !== null && typeof provider !== 'string') || (model !== null && typeof model !== 'string') || (thinkingLevel !== undefined && thinkingLevel !== null && !isThinkingLevel(thinkingLevel))) {
    return { ok: false, status: 400, error: "body needs provider/model strings or null, plus documented thinkingLevel or null" }
  }
  if ((provider === null) !== (model === null) || (provider === '' || model === '')) return { ok: false, status: 400, error: 'provider and model must both be configured or both be blank' }
  const next: ModelDefaults = { provider, model, thinkingLevel: thinkingLevel === undefined ? deps.defaults().thinkingLevel : thinkingLevel }
  if (provider !== null && model !== null) {
    try { deps.validateProviderModel(provider, model) } catch (error) { return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) } }
  }
  try {
    await deps.mutateProviderStore(({ providers, defaults }) => ({
      providers,
      defaults: { provider: next.provider, model: next.model, thinkingLevel: thinkingLevel === undefined ? defaults.thinkingLevel : next.thinkingLevel },
      result: undefined,
    })), { clearRuntimeModelOverride: true }
    return { ok: true }
  } catch (error) {
    return { ok: false, status: 500, error: `global model defaults could not be persisted: ${String(error instanceof Error ? error.message : error)}` }
  }
}

/**
 * The workspace thinking-level override: `null` (or absent) clears back to
 * the model's configured default; any string must be a documented level.
 */
async function putThinking(
  _workspaceId: WorkspaceId,
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true }> {
  const body = await readJson(req)
  const raw = body['level']
  if (raw !== undefined && raw !== null && !isThinkingLevel(raw)) {
    return { ok: false, status: 400, error: "body needs 'level' to be one of off|minimal|low|medium|high|xhigh|max, or null to use the model default" }
  }
  try {
    await deps.mutateProviderStore(({ providers, defaults }) => ({
      providers,
      defaults: { ...defaults, thinkingLevel: raw ?? null },
      result: undefined,
    }))
    return { ok: true }
  } catch (error) {
    return { ok: false, status: 500, error: `global thinking default could not be persisted: ${String(error instanceof Error ? error.message : error)}` }
  }
}

// ── workspace helpers ──────────────────────────────────────────

function listSessions(workspaceId: WorkspaceId, deps: HandlerDeps): Record<string, unknown>[] {
  const fallbackWs = defaultWorkspaceId(deps)
  const rows: Record<string, unknown>[] = []
  for (const summary of deps.kernel.ctx.sessions.summaries()) {
    const owner = deps.kernel.ctx.sessions.workspaceOf(summary.id)
    // Unowned (fixed-store test) sessions report under the fallback.
    if (owner !== undefined ? owner !== workspaceId : workspaceId !== fallbackWs) continue
    const entry = deps.sessions.get(summary.id)
    rows.push({
      id: summary.id,
      // Custom title wins; otherwise the derived title the summary projected
      // from the first user message. Both are durable, so a session listed
      // straight from storage shows the same title it shows once loaded.
      title: summary.title ?? summary.derivedTitle ?? (entry !== undefined ? deriveTitle(entry.session.events) : null) ?? 'New conversation',
      // Empty summaries use a current-time fallback, not a durable fact.
      ...(summary.eventCount > 0 ? { createdAt: summary.createdAt, updatedAt: summary.updatedAt } : {}),
      eventCount: summary.eventCount,
      folder: entry !== undefined ? (deps.legacyFolders.get(summary.id) ?? null) : null,
      projectId: entry?.projectId ?? summary.projectId ?? null,
      // A loaded session's own log is fresher than its projected summary.
      pinned: entry?.session.pinned ?? summary.pinned ?? false,
      status: entry?.agent.status ?? 'idle',
      activity: entry?.agent.activity ?? null,
      pendingInputs: entry !== undefined ? deps.kernel.ctx.sessions.pendingInputs(entry.session).length : 0,
    })
  }
  return rows
}

function defaultWorkspaceId(deps: HandlerDeps): WorkspaceId {
  try {
    return deps.workspaces.defaultWorkspace
  } catch {
    return MEMORY_WORKSPACE
  }
}

function workspaceMeta(workspaceId: WorkspaceId, deps: HandlerDeps, folder?: string): Record<string, unknown> {
  const state = deps.controlsFor(workspaceId)
  // Resolved by provider id: the global selection pointer is irrelevant.
  const defaults = deps.defaults()
  const models = defaults.provider === null ? [] : deps.kernel.ctx.llm.providerModels(defaults.provider)
  let workspace: { id: string; name: string; archived: boolean } = {
    id: workspaceId,
    name: 'Default',
    archived: false,
  }
  try {
    const record = deps.workspaces.get(workspaceId)
    workspace = { id: record.id, name: record.name, archived: record.archived }
  } catch {
    // memory-mode synthetic workspace
  }
  let projects: ProjectRecord[] = []
  try {
    projects = deps.workspaces.listProjects(workspaceId)
  } catch {
    projects = []
  }
  return {
    workspace,
    provider: defaults.provider ?? '',
    model: defaults.model ?? '',
    models,
    /** Global thinking override; null = the model's configured default. */
    thinkingLevel: defaults.thinkingLevel,
    permissionDefaults: state.modeDefinition.definition.permissionDefaults,
    ...(deps.yolo ? { yolo: true } : {}),
    mode: { id: state.modeDefinition.definition.id, name: state.modeDefinition.definition.name, revision: state.modeRevision },
    projects,
    providers: deps.providers().map(publicProvider),
    ...(folder !== undefined ? { folder } : {}),
  }
}

/** A deleted session leaves no per-session index behind (manifest, child indexes). */
function forgetSessionState(sessionId: SessionId, deps: HandlerDeps): void {
  deps.lastManifests.delete(sessionId)
  for (const childId of deps.childExecutor.forgetRoot(sessionId)) deps.lastManifests.delete(childId)
}

/**
 * Resolve a session entry with an ownership check: the session must belong
 * to the addressed workspace. Unknown ids and foreign-workspace ids both
 * resolve to `undefined` — indistinguishable, fail closed.
 */
async function findSession(rawId: string, workspaceId: WorkspaceId, deps: HandlerDeps): Promise<SessionEntry | undefined> {
  const id = rawId as SessionId
  const known = deps.sessions.get(id)
  if (known !== undefined) {
    return known.workspaceId === workspaceId ? known : undefined
  }
  const owner = deps.kernel.ctx.sessions.workspaceOf(id)
  if (!deps.kernel.ctx.sessions.has(id) || owner !== workspaceId) return undefined
  const session = await deps.kernel.ctx.sessions.load(id)
  const projectId = owner !== undefined ? boundProject(session) : undefined
  const entry: SessionEntry = {
    session,
    agent: deps.kernel.ctx.agents.create(session, {
      workspaceId,
      ...(projectId !== undefined ? { projectId } : {}),
    }),
    workspaceId,
    projectId,
  }
  // A child session is executor-managed: it is viewable here, but it never
  // joins the root registry — registration would let the writer lease treat a
  // running child as a root turn and hold the project lease for its whole run.
  if (!session.events.some((event) => event.type === 'session/child-meta')) deps.sessions.set(id, entry)
  return entry
}

/**
 * Reconstruct a loaded session's project binding from its durable
 * `session/project` record — metadata is rebuildable from the log.
 */
function boundProject(session: Session): ProjectId | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type === 'session/project') {
      return event.projectId === null ? undefined : (event.projectId as ProjectId)
    }
  }
  return undefined
}

// ── provider helpers ───────────────────────────────────────────

async function createProvider(
  deps: HandlerDeps,
  body: Record<string, unknown>,
): Promise<{ ok: false; status: number; error: string } | { ok: true; entry: ProviderConfig }> {
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  const baseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim() : ''
  const apiKey = typeof body['apiKey'] === 'string' ? body['apiKey'].trim() : ''
  if (name === '') return { ok: false, status: 400, error: "body needs a non-empty string 'name'" }
  if (baseUrl === '' || !/^https?:\/\//.test(baseUrl)) return { ok: false, status: 400, error: `'${baseUrl}' is not an http(s) URL` }
  const models = Array.isArray(body['models']) ? (body['models'] as unknown[]).filter((model): model is string => typeof model === 'string') : []
  const entry = await deps.mutateProviderStore(({ providers, defaults }) => {
    const base = slugify(name); let id = base; let bump = 2
    while (providers.some((candidate) => candidate.id === id)) id = `${base}-${bump++}`
    const created: ProviderConfig = {
      id, name, baseUrl: baseUrl.replace(/\/$/, ''), apiKey, models, enabled: true,
      ...((): { modelSettings?: Record<string, ModelSettings> } => {
        const sanitized = sanitizeModelSettings(body['modelSettings'] ?? body['contextLimits'])
        return sanitized !== undefined ? { modelSettings: sanitized } : {}
      })(),
    }
    return { providers: [...providers, created], defaults, result: created }
  })
  return { ok: true, entry }
}

async function patchProvider(
  deps: HandlerDeps,
  id: string,
  body: Record<string, unknown>,
): Promise<{ ok: false; status: number; error: string } | { ok: true; entry: ProviderConfig }> {
  const requestedName = typeof body['name'] === 'string' ? body['name'].trim() : undefined
  const requestedBaseUrl = typeof body['baseUrl'] === 'string' ? body['baseUrl'].trim() : undefined
  if (requestedBaseUrl !== undefined && requestedBaseUrl !== '' && !/^https?:\/\//.test(requestedBaseUrl)) {
    return { ok: false, status: 400, error: `'${requestedBaseUrl}' is not an http(s) URL` }
  }
  const models = Array.isArray(body['models']) ? body['models'].filter((model): model is string => typeof model === 'string') : undefined
  const patched = await deps.mutateProviderStore(({ providers, defaults }) => {
    const current = providers.find((entry) => entry.id === id)
    if (current === undefined) return { providers, defaults, result: undefined }
    let entry = current
    if (requestedName !== undefined && requestedName !== '') entry = { ...entry, name: requestedName }
    if (requestedBaseUrl !== undefined && requestedBaseUrl !== '') entry = { ...entry, baseUrl: requestedBaseUrl.replace(/\/$/, '') }
    if (typeof body['apiKey'] === 'string') entry = { ...entry, apiKey: body['apiKey'].trim() }
    if (typeof body['enabled'] === 'boolean') entry = { ...entry, enabled: body['enabled'] }
    if (models !== undefined) entry = { ...entry, models }
    if (isRecord(body['modelSettings']) || isRecord(body['contextLimits'])) {
      const sanitized = sanitizeModelSettings(body['modelSettings'] ?? body['contextLimits'])
      if (sanitized !== undefined) entry = { ...entry, modelSettings: sanitized }
      else { const { modelSettings: _dropped, ...rest } = entry; void _dropped; entry = rest }
    }
    return { providers: providers.map((candidate) => candidate.id === id ? entry : candidate), defaults, result: entry }
  })
  return patched === undefined ? { ok: false, status: 404, error: `no provider '${id}'` } : { ok: true, entry: patched }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize REST modelSettings input: keep only finite positive context
 * overrides, boolean vision flags, and documented thinking levels. Entries
 * that sanitize to nothing are dropped.
 */
function sanitizeModelSettings(raw: unknown): Record<string, ModelSettings> | undefined {
  if (!isRecord(raw)) return undefined
  const parsed: Record<string, ModelSettings> = {}
  for (const [model, entry] of Object.entries(raw)) {
    if (model === '' || !isRecord(entry)) continue
    const settings: ModelSettings = {
      ...(typeof entry['contextTokens'] === 'number' && Number.isInteger(entry['contextTokens']) && entry['contextTokens'] > 0
        ? { contextTokens: entry['contextTokens'] }
        : {}),
      ...(typeof entry['vision'] === 'boolean' ? { vision: entry['vision'] } : {}),
      ...(isThinkingLevel(entry['thinkingLevel']) ? { thinkingLevel: entry['thinkingLevel'] } : {}),
    }
    if (Object.keys(settings).length > 0) parsed[model] = settings
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

/**
 * Authorization for one configured endpoint. A keyless entry sends no header
 * at all: local gateways reject `Bearer ` with an empty token, and omitting it
 * is what an unauthenticated endpoint expects.
 */
function authHeaders(entry: ProviderConfig): Record<string, string> {
  return entry.apiKey === '' ? {} : { authorization: `Bearer ${entry.apiKey}` }
}

/**
 * Ask one endpoint what it offers. Shared by the read-only probe and by the
 * persisting sync so both report the same list and the same failures.
 */
async function fetchEndpointModels(
  entry: ProviderConfig,
): Promise<{ ok: true; models: string[] } | { ok: false; status: number; error: string }> {
  try {
    const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/models`, {
      headers: authHeaders(entry),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return { ok: false, status: 502, error: `HTTP ${response.status}` }
    const models = extractModelIds(await response.json())
    if (models.length === 0) return { ok: false, status: 502, error: 'model list came back empty' }
    return { ok: true, models }
  } catch (error) {
    return { ok: false, status: 502, error: String(error instanceof Error ? error.message : error) }
  }
}

/**
 * Fire one tiny non-streaming completion against `model`; returns an
 * operator-readable verdict. The caller resolves which model to name — this
 * never guesses one, because a ping that silently used a different model would
 * report the wrong row as verified.
 */
async function pingCompletions(entry: ProviderConfig, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${entry.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(entry) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}` }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}

/** Accept OpenAI `{data:[{id}]}` plus bare-array `[{id}]` / `["id"]` shapes. */
export function extractModelIds(parsed: unknown): string[] {
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['data'])
      ? (parsed as Record<string, unknown>)['data'] as unknown[]
      : []
  const ids: string[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      ids.push(row)
    } else if (row !== null && typeof row === 'object' && typeof (row as Record<string, unknown>)['id'] === 'string') {
      ids.push((row as Record<string, unknown>)['id'] as string)
    }
  }
  return ids
}

// ── shared helpers ─────────────────────────────────────────────

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MAX_BODY_BYTES = 1_000_000

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      throw new Error('request body too large')
    }
    chunks.push(chunk as Buffer)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  if (body === '') return {}
  const parsed: unknown = JSON.parse(body)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/**
 * Read a raw request body under an explicit cap. Attachments arrive as bytes,
 * not JSON, so base64 never doubles what crosses the socket.
 */
async function readBytes(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > maxBytes) {
      req.destroy()
      throw new AttachmentError(`upload exceeds the ${maxBytes} byte limit`)
    }
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Write one SSE `data:` frame and flush it. */
function writeFrame(res: ServerResponse, envelope: WebEnvelope): void {
  res.write(`data: ${JSON.stringify(envelope)}\n\n`)
}

/** A terminal geometry value, or `undefined` when it is not a usable one. */
function terminalDimension(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined
  const value = Math.floor(raw)
  return value >= 1 && value <= 1_000 ? value : undefined
}

/**
 * Where a new terminal opens: the named project's folder, or the workspace
 * root. The user can `cd` elsewhere afterwards — the same honest limit the
 * Bash tool already carries, since path confinement guards file tools, not
 * shell access.
 */
async function resolveTerminalCwd(
  workspaceId: WorkspaceId,
  body: Record<string, unknown>,
  deps: HandlerDeps,
): Promise<{ ok: true; path: string } | { ok: false; status: number; error: string }> {
  let target: string
  const projectId = body['projectId']
  if (typeof projectId === 'string' && projectId !== '') {
    try {
      target = deps.workspaces.getProject(projectId as ProjectId, workspaceId).path
    } catch (error) {
      if (!(error instanceof ScopeError)) throw error
      return { ok: false, status: 404, error: error.message }
    }
  } else {
    // A workspace owns no path — only its projects do — so an unbound
    // terminal opens in the host's configured default folder.
    target = deps.terminalDefaultCwd
  }
  try {
    const stats = await fs.stat(target)
    if (!stats.isDirectory()) return { ok: false, status: 400, error: `'${target}' is not a directory` }
  } catch {
    return { ok: false, status: 400, error: `'${target}' does not exist` }
  }
  return { ok: true, path: target }
}

/**
 * Stream every terminal in one workspace over a single connection.
 *
 * One stream, not one per terminal: browsers cap HTTP/1.1 at about six
 * connections per origin and the chat stream already holds one, so a
 * per-terminal stream would starve the REST calls that drive the same page.
 */
function streamTerminals(req: IncomingMessage, res: ServerResponse, workspaceId: WorkspaceId, deps: HandlerDeps): void {
  const streamGeneration = (req as IncomingMessage & { miniDshGeneration?: number }).miniDshGeneration ?? deps.auth.currentGeneration()
  if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'session generation was revoked' }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  // The service bounds one 16 ms window, which still permits tens of MB/s of
  // sustained output. A browser that cannot keep up would otherwise have that
  // backlog accumulate in this socket's write queue, so the slow consumer is
  // handled here, where the queue actually lives: past the watermark, output
  // frames are dropped and the gap is stated once.
  const WRITE_WATERMARK_BYTES = 4_000_000
  let dropping = false
  const frame = (envelope: TerminalEnvelope): void => {
    const droppable = envelope.kind === 'data'
    if (droppable && res.writableLength > WRITE_WATERMARK_BYTES) {
      if (!dropping) {
        dropping = true
        res.write(`data: ${JSON.stringify({
          kind: 'data',
          terminalId: envelope.terminalId,
          data: Buffer.from('\r\n[output dropped: reader too slow]\r\n', 'utf8').toString('base64'),
        } satisfies TerminalEnvelope)}\n\n`)
      }
      return
    }
    dropping = false
    res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  }
  const encode = (data: string): string => Buffer.from(data, 'utf8').toString('base64')

  frame({
    kind: 'snapshot',
    terminals: deps.terminals.list(workspaceId).map((info) => ({
      ...info,
      scrollback: encode(deps.terminals.scrollback(info.id)),
    })),
  })

  const dispose = deps.terminals.subscribe(workspaceId, (event) => {
    frame(event.kind === 'data' ? { ...event, data: encode(event.data) } : event)
  })
  const heartbeat = setInterval(() => {
    if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
      clearInterval(heartbeat)
      dispose()
      res.end()
      return
    }
    res.write(': ping\n\n')
  }, 25_000)
  heartbeat.unref?.()
  const principalId = (req as IncomingMessage & { miniDshPrincipalId?: string }).miniDshPrincipalId
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    dispose()
    res.end()
  }
  deps.liveStreams.push({ principalId, close })

  req.on('close', () => {
    clearInterval(heartbeat)
    dispose()
  })
}

/**
 * Stream one session: snapshot the current log, relay live events, then
 * re-expose still-pending approval questions (a browser reload mid-question
 * restores actionable state) until the client disconnects. Listeners are
 * disposed on close so a dropped tab never leaks registrations.
 */
function streamEvents(req: IncomingMessage, res: ServerResponse, entry: SessionEntry, deps: HandlerDeps): void {
  const streamGeneration = (req as IncomingMessage & { miniDshGeneration?: number }).miniDshGeneration ?? deps.auth.currentGeneration()
  // A reconnect that authenticated under an older generation must not receive
  // the snapshot. Logout increments the generation before this handler runs
  // only when the cookie was already rejected; this covers a generation that
  // moved between authenticate() and the first write.
  if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'session generation was revoked' }))
    return
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const { session } = entry

  writeFrame(res, { kind: 'snapshot', events: [...session.events] })
  for (const [approvalId, waiting] of deps.pending) {
    if (waiting.sessionId === session.id || waiting.parentSessionId === session.id) {
      writeFrame(res, approvalEnvelope(approvalId, waiting, session.id))
    }
  }

  const disposeSession = deps.kernel.ctx.on('session/event', (emitter, event) => {
    if (emitter.id === session.id) writeFrame(res, { kind: 'session', event })
  })
  const disposeApproval = deps.kernel.ctx.on('web/approval', (payload) => {
    if (payload.sessionId === session.id || payload.parentSessionId === session.id) {
      const waiting = deps.pending.get(payload.approvalId)
      if (waiting !== undefined) {
        writeFrame(res, approvalEnvelope(payload.approvalId, waiting, session.id))
        return
      }
      writeFrame(res, {
        kind: 'approval',
        approvalId: payload.approvalId,
        call: payload.call,
        expiresAt: payload.expiresAt,
        ...(payload.interactive === true ? { interactive: true } : {}),
        ...(payload.guardWarning !== undefined ? { guardWarning: payload.guardWarning } : {}),
        ...(payload.parentSessionId === session.id
          ? {
            childSessionId: payload.sessionId,
            ...(payload.definitionName !== undefined ? { definitionName: payload.definitionName } : {}),
          }
          : {}),
      })
    }
  })
  const disposeApprovalSettled = deps.kernel.ctx.on('web/approval-settled', (payload) => {
    if (payload.sessionId === session.id || payload.parentSessionId === session.id) {
      writeFrame(res, { kind: 'approval-settled', approvalId: payload.approvalId })
    }
  })
  const disposeError = deps.kernel.ctx.on('web/turn-error', (payload) => {
    if (payload.sessionId === session.id) writeFrame(res, { kind: 'error', message: payload.message })
  })
  const principalId = (req as IncomingMessage & { miniDshPrincipalId?: string }).miniDshPrincipalId
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  const close = (): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    disposeSession()
    disposeApproval()
    disposeApprovalSettled()
    disposeError()
    res.end()
  }
  deps.liveStreams.push({ principalId, close })

  heartbeat = setInterval(() => {
    if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
      close()
      return
    }
    // A deleted session must end its streams: no more frames can ever come.
    if (entry.closed === true) {
      clearInterval(heartbeat)
      disposeSession()
      disposeApproval()
      disposeApprovalSettled()
      disposeError()
      writeFrame(res, { kind: 'error', message: 'session deleted' })
      res.end()
      return
    }
    res.write(': ping\n\n')
  }, 2_000)

  req.on('close', () => {
    clearInterval(heartbeat)
    disposeSession()
    disposeApproval()
    disposeApprovalSettled()
    disposeError()
  })
}

/** Serve the built client: `/` (and unknown paths) fall back to index.html for the router. */
async function serveStatic(res: ServerResponse, pathname: string, staticDir: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const abs = path.resolve(staticDir, relative)
  if (abs !== path.resolve(staticDir) && !abs.startsWith(`${path.resolve(staticDir)}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden' }))
    return
  }
  try {
    const content = await fs.readFile(abs)
    // The shell and the service worker must revalidate so a rebuilt client takes over promptly.
    const revalidate = relative === 'index.html' || relative === 'sw.js'
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[path.extname(abs)] ?? 'application/octet-stream',
      ...(revalidate ? { 'cache-control': 'no-cache' } : {}),
    })
    res.end(content)
  } catch {
    // Unknown non-API path: serve the app shell so client-side state stands up.
    try {
      const shell = await fs.readFile(path.join(staticDir, 'index.html'))
      res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'] ?? 'text/html', 'cache-control': 'no-cache' })
      res.end(shell)
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'client not built; run npm run build:web' }))
    }
  }
}

/** Retire a valid legacy override without ever interpreting it as active policy. */
async function retireWorkspacePolicyFile(
  workspaceDir: string,
  workspace: Pick<WorkspaceRecord, 'id' | 'name'>,
  seam: WebServerOptions['policyRetirement'] = {},
): Promise<void> {
  const source = path.join(workspaceDir, 'policy.json')
  let raw: string
  try {
    raw = await fs.readFile(source, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn(`web: could not inspect retired policy for workspace '${workspace.id}' (${workspace.name}): ${String(error instanceof Error ? error.message : error)}`)
    return
  }

  let entries: Record<string, ApprovalMode> | undefined
  let empty = false
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; policy?: unknown }
    const candidate = parsed.policy
    if (parsed.v === 1 && candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const values = Object.values(candidate as Record<string, unknown>)
      if (values.length === 0) empty = true
      else if (values.every((value) => value === 'allow' || value === 'ask' || value === 'deny')) {
        entries = candidate as Record<string, ApprovalMode>
      }
    }
  } catch {
    // Warning below identifies the retained malformed file.
  }
  if (entries === undefined) {
    if (empty) console.warn(`web: workspace '${workspace.id}' (${workspace.name}) retained empty policy.json; it does not apply`)
    else if (raw.trim() !== '') console.warn(`web: workspace '${workspace.id}' (${workspace.name}) retained malformed policy.json; it does not apply`)
    return
  }

  const migrated = path.join(workspaceDir, 'policy.json.migrated')
  const copyExclusive = seam.copyExclusive ?? ((from: string, to: string) => fs.copyFile(from, to, fs.constants.COPYFILE_EXCL))
  const unlink = seam.unlink ?? fs.unlink
  const delay = seam.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (let attempt = 0; ; attempt++) {
    try {
      // COPYFILE_EXCL is atomic no-replace on both Windows and POSIX. The
      // source remains until this succeeds, so a target collision cannot lose
      // either file and a failed copy is always recoverable on the next boot.
      await copyExclusive(source, migrated)
      try {
        await unlink(source)
      } catch (error) {
        console.warn(`web: workspace '${workspace.id}' (${workspace.name}) copied retired policy but could not remove policy.json; both files were preserved: ${String(error instanceof Error ? error.message : error)}`)
        return
      }
      console.warn(`web: workspace '${workspace.id}' (${workspace.name}) retired policy overrides that no longer apply: ${JSON.stringify(entries)}`)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') {
        console.warn(`web: workspace '${workspace.id}' (${workspace.name}) retains policy.json because policy.json.migrated already exists`)
        return
      }
      if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY')) {
        console.warn(`web: could not retire policy for workspace '${workspace.id}' (${workspace.name}): ${String(error instanceof Error ? error.message : error)}`)
        return
      }
      await delay(100 * (attempt + 1))
    }
  }
}
