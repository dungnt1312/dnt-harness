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
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { bearerAllows, CLEARED_SESSION_COOKIE, ControlPlaneAuthService, isPublicPath, readSessionCookie } from './control-plane-auth.ts'
import { OPERATOR_HEADER, publishOperatorChannel } from './operator-channel.ts'
import { promises as fs, type Dirent } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentsService } from '../harness/agent/service.ts'
import { resolveAppHome } from '../harness/app-home.ts'
import { memoryUsageLog, openUsageLog, type UsageLog } from './usage-log.ts'
import { AutomationError, AutomationScheduler, AutomationStore, automationContext, excerpt, hasFutureRuns, nextRuns, parseAutomationInput, planOf, runTitle, type Automation } from './automations.ts'
import { PushError, PushService, type PushSender } from './push.ts'
import { ChannelError, NotifyChannels, type ChannelFetch } from './notify-channels.ts'
import { agentScope, type AgentScope } from '../harness/agent/scope.ts'
import type { GrantedRoot } from '../harness/tools/types.ts'
import { classifyGrantedRoots, classifyTarget, resolveInGrants, within } from '../capabilities/fs/grants.ts'
import { mergeGrants, parseAccess, projectGrants, validateGrantFolder, type GrantPolicy } from './folder-grants.ts'
import { approvedPathOf, attachPathScopeGuard, type PathScopeGuard, type PathScopeMatch } from './path-scope-guard.ts'
import type { Agent } from '../harness/agent/agent.ts'
import { approvalCallFingerprint, attachApproval, createApprovalReceiptRegistry, type ApprovalHandle, type ApprovalMode, type ApprovalScope } from '../harness/approval/policy.ts'
import { resolvePermission } from '../harness/approval/resolution.ts'
import { composeAuthority, type AskRequirement, type AuthorityDecision } from '../harness/tools/authority.ts'
import { DangerousCommandsStore } from '../harness/guard/store.ts'
import { attachDangerousCommandGuard, guardMatchFingerprint } from '../harness/guard/guard.ts'
import { DEFAULT_LIMITS, resolveLimits, type HarnessLimits } from '../harness/limits.ts'
import { LlmService } from '../harness/llm/service.ts'
import { LogicalRequest, classifyTransport } from '../harness/llm/request-lifecycle.ts'
import { OpenAiCompletionsProvider } from '../harness/llm/openai.ts'
import { expressibleThinkingLevel, isThinkingLevel, resolveContextLimit } from '../harness/llm/model-catalog.ts'
import { adaptRequestVision, supportsNativeVision } from '../harness/llm/adaptive-vision.ts'
import { ProviderError } from '../harness/llm/types.ts'
import type { LlmProvider, StreamEvent, TokenUsage, ToolCall } from '../harness/llm/types.ts'
import { fileSessions, SessionsService } from '../harness/session/service.ts'
import type { Session } from '../harness/session/session.ts'
import { sessionGrantsOf, sessionModeOf, sessionModelOf, type SessionEvent, type SessionGrant, type SessionGrants } from '../harness/session/events.ts'
import { deriveTitle } from '../harness/session/title.ts'
import { newInputId, type ProjectId, type SessionId, type TurnId, type WorkspaceId } from '../util/brand.ts'
import { ToolsService } from '../harness/tools/service.ts'
import { bashTool } from '../capabilities/shell/bash.ts'
import { bashOutputTool, killShellTool } from '../capabilities/shell/background-tools.ts'
import { createProcessSessionEventBridge } from '../harness/processes/session-event-bridge.ts'
import { runCleanup, boundedCleanup } from '../harness/processes/shutdown.ts'
import { ProcessRegistry } from '../harness/processes/registry.ts'
import { fsTools } from '../capabilities/fs/tools.ts'
import { listProjectEntries, readProjectFile, searchProjectFiles, ProjectFileError, classifyProjectMedia, resolveProjectMediaPath, MAX_MEDIA_BYTES } from './project-files.ts'
import { gitDiff, gitStatus, ProjectGitError } from './project-git.ts'
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
  type ModelAlias,
  type ModelSettings,
  type ProviderConfig,
  validateModelAliasName,
} from './provider-store.ts'
import { ScopeError, WorkspaceService, type AdditionalDirectory, type ProjectRecord, type WorkspaceRecord } from '../harness/workspace/service.ts'
import { ModesService, ModeError, DEFAULT_MODE_ID, BUNDLED_MODES, type ResolvedMode } from '../harness/modes/service.ts'
import { migrateRootModes } from '../harness/modes/root-migration.ts'
import { AgentDefinitionService, AgentDefinitionError, serializeAgentDefinition } from '../harness/agents/definition-service.ts'
import {
  McpConfigStore,
  McpConfigError,
  parseMcpConfig,
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
import { createExecutionAuthority, mcpToolExposed, projectExposedSchemas } from './execution-authority.ts'
import { configRevision, upsertServer, withServerActivated, withServerEnabled, withoutServer } from '../harness/mcp/config-v2.ts'
import { clearAuditFault, dispatchToolCall, faultIsOpen } from '../harness/mcp/execution-coordinator.ts'
import { McpExecutionJournal } from '../harness/mcp/execution-journal.ts'
import { MutationStore, readFileIfPresent } from '../harness/mcp/mutation-store.ts'
import { recoverMigrations } from '../harness/mcp/migration.ts'
import { DataHomeLock } from '../harness/mcp/ownership-lock.ts'
import { ManagedOAuth } from '../harness/mcp/oauth.ts'
import { OAuthStore } from '../harness/mcp/oauth-store.ts'
import { containmentCapability, resolveCanonicalExecutable } from '../harness/mcp/process-controller.ts'
import { stageMcpOutcome } from '../harness/mcp/staged-outcome.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { loadClaudeMd, renderClaudeMd } from '../harness/instructions/claude-md.ts'
import { HookSettingsError, isHookConfigPath, readWorkspaceHooks, setHookActive, workspaceSettingsPath, writeWorkspaceHooks } from '../harness/hooks/settings.ts'
import { fromClaudeToolInput, toClaudeToolInput } from '../harness/hooks/tool-input.ts'
import { HookHost, hookContextBlock } from './claude-hooks.ts'
import { ChildExecutor, SpawnError, normalizeBrief, type ChildModel, type TaskPacket } from '../harness/agents/executor.ts'
import { agentTool, ChildModelError, describeRoleModel, formatChildReports, projectInheritedMessages, resolveChildModel } from './agent-delegation.ts'
import { importCodexDefinition } from '../harness/agents/compatibility/claude.ts'
import { SkillsService, SkillError } from '../harness/skills/service.ts'
import { protectedRootsForRules, resolveSkillLayers, type SkillLayer } from '../harness/skills/layers.ts'
import { MemoryService, MemoryError } from '../harness/memory/service.ts'
import { memoryGuidance, memoryGuidanceAccess, memoryIndexes } from '../harness/memory/context.ts'
import { todoWriteTool } from '../harness/tools/todo.ts'
import { editImageTool, generateImageTool, type ImageToolOptions } from '../harness/tools/image-tools.ts'
import { describeImageTool } from '../harness/tools/describe-image.ts'
import { loadImageSettings, parseImageSettings, resolveImageApi, saveImageSettings, type ImageGenerationSettings } from './image-generation-store.ts'
import { loadImageUnderstandingSettings, parseImageUnderstandingSettings, resolveVisionApi, saveImageUnderstandingSettings, type ImageUnderstandingSettings } from './image-understanding-store.ts'
import { askUserQuestionTool, validateAnswers, type QuestionOutcome, type UserQuestion } from '../harness/tools/ask-user.ts'
import { buildContext, DEFAULT_BASE_SYSTEM, DEFAULT_CHILD_SYSTEM, type ContextManifest, type ActiveSkill, type MemorySnippet } from '../harness/context/builder.ts'
import { renderEnvironmentContext } from '../harness/context/environment.ts'
import { SystemPromptsStore, type SystemPromptsSnapshot } from '../harness/prompts/store.ts'
import { CheckpointStore } from '../harness/context/compaction.ts'
import { createCompactionSummarizer } from './llm-summarizer.ts'
import { DEFAULT_BUDGET, type ResolvedBudget } from '../harness/context/budget.ts'

declare module 'dnt-harness' {
  interface Events {
    /**
     * A tool call is waiting for a human answer on one session; emitted by
     * the web approval bridge and consumed by that session's SSE stream.
     */
    'web/approval'(payload: {
      readonly sessionId: SessionId
      readonly approvalId: string
      readonly call: ToolCall
      readonly guardWarning?: string
      readonly scopeWarning?: string
      readonly proposedGrant?: string
      readonly proposedAccess?: 'read' | 'write'
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
    /** The model asked the human questions (AskUserQuestion) on one session. */
    'web/question'(payload: {
      readonly sessionId: SessionId
      readonly questionId: string
      readonly parentSessionId?: SessionId
    }): void
    /** A pending AskUserQuestion was answered, declined, expired, or stopped. */
    'web/question-settled'(payload: {
      readonly sessionId: SessionId
      readonly questionId: string
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

/** How long a pre-step waits before trying a server that failed to connect again. */
const MCP_CONNECT_BACKOFF_MS = 30_000

/**
 * Tool names every supported LLM provider accepts. A public name outside
 * this is not sent to the model: one bad name would fail every request.
 */
const PROVIDER_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/** The bundled default mode definition (controls initialize with it). */
function BUNDLED_DEFAULT() {
  return BUNDLED_MODES.find((mode) => mode.id === DEFAULT_MODE_ID) ?? BUNDLED_MODES[0]!
}

/** One frame on the SSE stream: log snapshot, live session event, a pending approval question, or a turn failure. */
export type WebEnvelope =
  | { readonly kind: 'snapshot'; readonly events: SessionEvent[] }
  | { readonly kind: 'resume'; readonly events: SessionEvent[] }
  | { readonly kind: 'session'; readonly event: SessionEvent }
  | {
    readonly kind: 'approval'
    readonly approvalId: string
    readonly call: ToolCall
    /** Dangerous-command guard note shown beside the question. */
    readonly guardWarning?: string
    /** Set when the call targets a path outside every granted folder. */
    readonly scopeWarning?: string
    /** The folder "allow for this session" would grant (root sessions only). */
    readonly proposedGrant?: string
    /** The access that folder would get: the call's own read or write. */
    readonly proposedAccess?: 'read' | 'write'
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
  | {
    readonly kind: 'question'
    readonly questionId: string
    /** The model's tool call id, so the transcript can anchor the card. */
    readonly callId: string
    readonly questions: readonly UserQuestion[]
    readonly expiresAt: number
    readonly childSessionId?: string
    readonly definitionName?: string
  }
  | { readonly kind: 'question-settled'; readonly questionId: string }
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
  /** Provider config file; defaults to `<homedir>/.dnt-harness/providers.json` (or the pre-rename `.mini-dsh`). */
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
  /**
   * Claude Code user folder (`~/.claude`): the user layer for CLAUDE.md,
   * settings.json hooks and agents/. Omitted skips the user layer (tests).
   */
  readonly userClaudeDir?: string
  /** Read-only bundled skill layer shipped with the app; scanned when the dir exists. */
  readonly bundledSkillsDir?: string
  /**
   * Credential locations (e.g. `~/.ssh`) refused to the file tools in every
   * mode and never grantable. Applied only with `home` (durable hosts);
   * memory-mode hosts keep their legacy permissive roots.
   */
  readonly secretRoots?: readonly string[]
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
  /** Automations: whether the scheduler runs (default true). Tests turn it off and use Run now. */
  readonly automations?: { readonly scheduler?: boolean }
  /** Web Push transport seam (tests). */
  readonly pushSender?: PushSender
  /** Telegram/Teams/Discord HTTP seam (tests). */
  readonly channelFetch?: ChannelFetch
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
  /** Host execution identity: per-call state keys never use the model call id. */
  readonly executionId?: string
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
  /** Out-of-grant note, replayed on every (re)connect. */
  readonly scopeWarning?: string
  /** Folder a session-scoped answer grants; absent when not offered. */
  readonly proposedGrant?: string
  readonly proposedAccess?: 'read' | 'write'
  resolve(allow: boolean): void
}

/** One AskUserQuestion call waiting for its human (see `askUserQuestionTool`). */
interface PendingQuestion {
  readonly sessionId: SessionId
  readonly workspaceId: WorkspaceId
  readonly principalId?: string
  readonly callId: string
  readonly questions: readonly UserQuestion[]
  readonly parentSessionId?: SessionId
  readonly definitionName?: string
  readonly expiresAt: number
  settle(outcome: QuestionOutcome): void
}

function questionEnvelope(questionId: string, waiting: PendingQuestion, viewerSessionId: SessionId): Extract<WebEnvelope, { kind: 'question' }> {
  return {
    kind: 'question',
    questionId,
    callId: waiting.callId,
    questions: waiting.questions,
    expiresAt: waiting.expiresAt,
    ...(waiting.parentSessionId !== undefined && viewerSessionId === waiting.parentSessionId
      ? {
        childSessionId: waiting.sessionId,
        ...(waiting.definitionName !== undefined ? { definitionName: waiting.definitionName } : {}),
      }
      : {}),
  }
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
    ...(waiting.scopeWarning !== undefined ? { scopeWarning: waiting.scopeWarning } : {}),
    ...(waiting.proposedGrant !== undefined ? { proposedGrant: waiting.proposedGrant } : {}),
    ...(waiting.proposedAccess !== undefined ? { proposedAccess: waiting.proposedAccess } : {}),
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
    // Streaming chunks ride relaxed appends (one fsync per durability barrier
    // instead of per token); the env opt-out restores strict per-record syncs.
    const relaxedStreamingAppends = process.env['DNT_HARNESS_FSYNC_EVERY_EVENT'] !== '1'
    kernel.ctx.plugin(fileSessions(options.home, { relaxedStreamingAppends }))
  } else {
    kernel.ctx.plugin(SessionsService)
  }
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)

  const limits: HarnessLimits = resolveLimits(options.limits)
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
  // App storage first: `memoryStorageCarveout` keys on it as hostStorageRoot.
  const deniedRoots = options.home !== undefined ? [options.home, ...(options.secretRoots ?? [])] : undefined
  // G3 resource services: workspace-owned modes/skills/memory. Memory-mode
  // hosts bind them to a fresh temp home so tests stay hermetic.
  const resourceHome = options.home ?? (await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-resources-')))
  const modes = new ModesService(resourceHome)
  const skills = new SkillsService(resourceHome, options.bundledSkillsDir, options.userSkillsDir)
  const memory = new MemoryService(resourceHome)
  const checkpoints = new CheckpointStore(path.join(resourceHome, 'workspaces'))
  // Settings → Usage: durable cross-workspace token accounting.
  const usageLog = options.home !== undefined ? await openUsageLog(path.join(options.home, 'usage.jsonl')) : memoryUsageLog()
  // Workspace-authored system prompt replacements (Settings → System Prompts).
  const systemPrompts = new SystemPromptsStore(resourceHome)
  kernel.ctx.provide('modes', modes)
  kernel.ctx.provide('skills', skills)
  kernel.ctx.provide('memory', memory)
  // Composer attachments: content-addressed blobs beside the workspace's other
  // resources, so a memory-mode host gets a hermetic temp home like the rest.
  const attachments = new AttachmentStore(resourceHome, { maxBytes: limits.maxAttachmentBytes })
  // Claude Code subagent layers: bundled < ~/.claude/agents < <ws>/agents <
  // <project>/.claude/agents.
  const agentDefinitions = new AgentDefinitionService(resourceHome, {
    ...(options.userClaudeDir !== undefined ? { userClaudeDir: options.userClaudeDir } : {}),
    projectRootOf: (workspaceId, projectId) => {
      try { return workspaces.getProject(projectId as ProjectId, workspaceId as WorkspaceId).path } catch { return undefined }
    },
  })
  const childExecutor = new ChildExecutor(kernel.ctx)
  kernel.ctx.provide('agent-definitions', agentDefinitions)

  // G5: MCP servers + hooks, workspace-scoped. Each (workspace, enabled
  // server) gets one McpServerClient; tools register as `mcp__server__tool`.
  const mcpStore = new McpConfigStore(resourceHome)
  // Claude Code hooks from settings.json layers (user/workspace/project/local).
  const hookHost = new HookHost({
    home: resourceHome,
    userClaudeDir: options.userClaudeDir,
    projectRootOf: (workspaceId, projectId) => {
      if (projectId === undefined) return undefined
      try { return workspaces.getProject(projectId as ProjectId, workspaceId as WorkspaceId).path } catch { return undefined }
    },
    sessionOf: (sessionId) => {
      const entry = sessions.get(sessionId as SessionId)
      if (entry !== undefined) return entry.session
      try { return kernel.ctx.sessions.get(sessionId as SessionId) } catch { return undefined }
    },
    modeIdOf: (sessionId, workspaceId) => {
      try { return rootModeOf({ sessionId: sessionId as SessionId, workspaceId: workspaceId as WorkspaceId }, workspaceId as WorkspaceId).mode.definition.id } catch { return undefined }
    },
  })
  const ownerLock = await DataHomeLock.acquire(resourceHome)
  const mutations = new MutationStore(resourceHome)
  await mutations.recover()
  // An interrupted `migrate-mcp` run is rolled back to its verified backup
  // before any config is read.
  for (const settled of await recoverMigrations(resourceHome)) {
    console.warn(`web: MCP migration ${settled.backup} was interrupted; ${settled.outcome === 'rolled_back' ? 'restored its backup' : 'it had not changed anything'}`)
  }
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
  /** Last failed connect per `${wsId}:${server}`: shown in Settings, and backs off pre-step retries. */
  const mcpConnectFailures = new Map<string, { readonly at: number; readonly message: string }>()
  let mcpHostClosing = false
  /** Per-workspace live descriptor snapshots used by dynamic schema resolvers. */
  const mcpDescriptors = new Map<string, McpToolDescriptor>() // `${wsId}:${fullName}`
  /** Model schemas are registered once by full public name; execution dispatches by workspace scope. */
  const mcpRegistered = new Set<string>()
  kernel.ctx.provide('mcp-store', mcpStore)

  // ── provider registry ────────────────────────────────────────
  const configFile = options.configFile ?? path.join(resolveAppHome(), 'providers.json')
  const storedProviders = loadProviderStore(configFile)
  let list: ProviderConfig[] = [...storedProviders.providers]
  let aliases: ModelAlias[] = [...storedProviders.aliases]
  let aliasGeneration = storedProviders.aliasGeneration
  let durableDefaults: ModelDefaults = storedProviders.defaults
  let runtimeModelOverride: { readonly provider: string; readonly model: string } | undefined
  let defaults: ModelDefaults = durableDefaults
  // Settings → Providers & Models → Image generation: a provider/model reference beside
  // providers.json, resolved against the live provider list on every call.
  const imageSettingsFile = path.join(path.dirname(configFile), 'image-generation.json')
  let imageSettings: ImageGenerationSettings = loadImageSettings(imageSettingsFile)
  const imageUnderstandingFile = path.join(path.dirname(configFile), 'image-understanding.json')
  let imageUnderstanding: ImageUnderstandingSettings = loadImageUnderstandingSettings(imageUnderstandingFile)
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
      await saveProviderStore(configFile, { version: 2, defaults: durableDefaults, providers: list, aliases, aliasGeneration })
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

  // Restore each workspace's durable selected mode so a restart keeps the
  // operator's choice (e.g. Full access) instead of snapping back to the
  // bundled default. Invalid/missing/disabled selections fall back silently.
  if (options.home !== undefined) {
    for (const ws of workspaces.list({ includeArchived: true })) {
      try {
        const persisted = await modes.selectedId(ws.id)
        if (persisted !== undefined) {
          const resolved = await modes.resolve(ws.id, persisted)
          const state = controlsFor(ws.id)
          state.modeId = persisted
          state.modeDefinition = resolved
          // Keep the initial revision at 1 so the first live switch still
          // bumps to 2; the persisted identity is what matters, not the count.
        }
      } catch {
        // Best-effort: a corrupt selection file never blocks boot.
      }
    }
  }


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
   * The pair host-side maintenance calls run on (compaction summaries): the
   * session's effective selection, resolved like any request's. Undefined
   * when nothing resolves — compaction then falls back to the bounded
   * extractive summarizer instead of refusing to compact.
   */
  const summarizerModelOf = (session: Session): { readonly providerName: string; readonly model: string } | undefined => {
    const effective = resolveEffectiveModel(session, workspaces.defaultWorkspace)
    if (effective.provider === null || effective.provider === undefined || effective.model === null || effective.model === undefined) return undefined
    return { providerName: effective.provider, model: effective.model }
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
      alias: (name) => aliases.find((entry) => entry.name === name),
    })

  // ── per-session entries ──────────────────────────────────────
  const sessions = new Map<SessionId, SessionEntry>()
  // A failed session/model durability barrier leaves an in-memory event that
  // cannot truthfully be served. Fence the session until host restart/reload.
  const unavailableSessions = new Set<SessionId>()

  // Legacy folder grants (memory mode only), scoped to THIS server.
  const legacyFolders = new Map<SessionId, string | undefined>()
  const legacyFolderDefault = { current: options.root }

  // Extra file-tool folders: the project's `additionalDirectories` plus the
  // session's own `session/grants`. Children use the snapshot taken at spawn.
  const staticProtectedRoots = [
    ...(deniedRoots ?? []),
    ...(options.userSkillsDir !== undefined ? [options.userSkillsDir] : []),
    ...(options.bundledSkillsDir !== undefined ? [options.bundledSkillsDir] : []),
  ]
  const grantPolicy: GrantPolicy = { protectedRoots: [...staticProtectedRoots] }
  // Absolute skill-rule folders of EVERY workspace stay ungrantable: the
  // policy is host-wide, so it is recomputed from the union of all
  // workspaces' rules — at startup (persisted rules) and after each rules
  // PUT — never replaced by one workspace's list. A generation counter keeps
  // an older, slower recompute from overwriting a newer one.
  let protectedRootsGeneration = 0
  const refreshSkillProtectedRoots = async (): Promise<void> => {
    const generation = ++protectedRootsGeneration
    const ruleRoots: string[] = []
    let incomplete = false
    for (const ws of workspaces.list({ includeArchived: true })) {
      // One unreadable workspace must not drop every other workspace's
      // folders, nor its own: a failed read marks the pass incomplete.
      const rules = await skills.sources(ws.id).catch(() => undefined)
      if (rules === undefined) {
        incomplete = true
        continue
      }
      for (const root of protectedRootsForRules(rules)) {
        if (!ruleRoots.includes(root)) ruleRoots.push(root)
      }
    }
    if (generation !== protectedRootsGeneration) return
    // Incomplete pass: keep every root already protected (fail closed) and
    // only add; a complete pass replaces, so removed rules unprotect.
    const keep = incomplete ? grantPolicy.protectedRoots.filter((root) => !staticProtectedRoots.includes(root)) : []
    const merged = [...ruleRoots, ...keep.filter((root) => !ruleRoots.includes(root))]
    grantPolicy.protectedRoots.splice(0, grantPolicy.protectedRoots.length, ...staticProtectedRoots, ...merged)
  }
  /** Fail-closed fallback: ADD roots without dropping any (over-protecting is safe). */
  const addSkillProtectedRoots = (roots: readonly string[]): void => {
    for (const root of roots) if (!grantPolicy.protectedRoots.includes(root)) grantPolicy.protectedRoots.push(root)
  }
  await refreshSkillProtectedRoots()
  const grantCache = new WeakMap<readonly SessionEvent[], { length: number; grants: SessionGrants }>()
  const sessionGrants = (session: Session): SessionGrants => {
    const cached = grantCache.get(session.events)
    if (cached !== undefined && cached.length === session.events.length) return cached.grants
    const grants = sessionGrantsOf(session.events)
    grantCache.set(session.events, { length: session.events.length, grants })
    return grants
  }
  const effectiveGrants = (sessionId: SessionId, projectId: ProjectId | undefined, workspaceId: WorkspaceId | undefined): GrantedRoot[] => {
    if (projectId === undefined) return []
    let project: ProjectRecord
    try {
      project = workspaces.getProject(projectId, workspaceId)
    } catch {
      return []
    }
    const lookup = (id: ProjectId): ProjectRecord | undefined => {
      try {
        return workspaces.getProject(id, project.workspaceId)
      } catch {
        return undefined
      }
    }
    const session = sessions.get(sessionId)?.session
    return mergeGrants(projectGrants(project, lookup), session !== undefined ? sessionGrants(session).roots : [])
  }
  const intersectGrants = (snapshot: readonly GrantedRoot[], current: readonly GrantedRoot[]): GrantedRoot[] => {
    const boundaries = mergeGrants(
      snapshot,
      current.filter((root) => snapshot.some((spawned) => within(spawned.path, root.path))),
    )
    return boundaries.flatMap((root) => {
      const spawned = classifyGrantedRoots(snapshot, root.path)
      const live = classifyGrantedRoots(current, root.path)
      if (spawned === undefined || live === undefined) return []
      return [{ path: root.path, access: spawned.access === 'write' && live.access === 'write' ? 'write' as const : 'read' as const }]
    })
  }
  const scopeGrants = (scope: AgentScope): GrantedRoot[] => {
    if (scope.childOf === undefined) return effectiveGrants(scope.sessionId, scope.projectId, scope.workspaceId)
    const currentParent = effectiveGrants(scope.childOf.parentSessionId, scope.projectId, scope.workspaceId)
    return intersectGrants(scope.childOf.grants ?? [], currentParent)
  }
  // Every change to one session's grants runs through one queue, so a
  // composer edit and an approval's "allow for session" never overwrite
  // each other: each derives its list from the durable current value.
  const grantQueues = new Map<SessionId, Promise<unknown>>()
  const mutateSessionGrants = (
    session: Session,
    derive: (current: SessionGrants) => readonly SessionGrant[] | Promise<readonly SessionGrant[]>,
    approvalId?: string,
  ): Promise<SessionGrants> => {
    const previous = grantQueues.get(session.id) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(async () => {
      const current = sessionGrants(session)
      const roots = await derive(current)
      const next: SessionGrants = { revision: current.revision + 1, roots: [...roots] }
      session.append({ type: 'session/grants', revision: next.revision, roots: next.roots, ...(approvalId !== undefined ? { approvalId } : {}) })
      await session.durable()
      return next
    })
    grantQueues.set(session.id, run)
    void run.finally(() => {
      if (grantQueues.get(session.id) === run) grantQueues.delete(session.id)
    }).catch(() => {})
    return run
  }

  // The file-tool grant resolves per execution from the ambient scope: the
  // bound project's folder plus its granted folders — or, in memory mode,
  // the server root. A workspace-mode session without a project has NO
  // filesystem grant.
  kernel.ctx.tools.setRootResolver(() => {
    const scope = agentScope.getStore()
    const mode = scope?.workspaceId !== undefined ? rootModeOf(scope, scope.workspaceId).mode.definition : undefined
    const memoryOn = scope !== undefined && mode?.sources.memoryRetrieval === true && mode.sources.memoryPinned === true
    const roots = memoryOn && scope?.workspaceId !== undefined
      ? [memory.root({ workspaceId: scope.workspaceId }), ...(scope.projectId !== undefined ? [memory.root({ workspaceId: scope.workspaceId, projectId: scope.projectId })] : [])]
      : []
    const childCanWrite = scope?.childOf === undefined || (scope.childOf.toolCeiling.includes('Write') || scope.childOf.toolCeiling.includes('Edit'))
    const memoryGrants = roots.map((root) => ({ path: root, access: childCanWrite ? 'write' as const : 'read' as const }))
    if (scope?.projectId !== undefined) {
      try {
        const project = workspaces.getProject(scope.projectId, scope.workspaceId)
        const additionalRoots = [...scopeGrants(scope), ...memoryGrants]
        return {
          root: project.path,
          ...(additionalRoots.length > 0 ? { additionalRoots } : {}),
          ...(roots.length > 0 ? { memoryRoots: roots } : {}),
          ...(deniedRoots !== undefined ? { deniedRoots, hostStorageRoot: options.home } : {}),
        }
      } catch {
        return undefined
      }
    }
    // Memory mode: legacy folder grants (per-session override, then the
    // server's current default, then the configured root).
    if (deniedRoots === undefined && scope !== undefined) {
      const granted = legacyFolders.get(scope.sessionId) ?? legacyFolderDefault.current
      if (granted !== undefined) return { root: granted, ...(memoryGrants.length > 0 ? { additionalRoots: memoryGrants, memoryRoots: roots } : {}) }
    }
    if (scope !== undefined && roots.length > 0) return { root: '', additionalRoots: memoryGrants, memoryRoots: roots, ...(deniedRoots !== undefined ? { deniedRoots, hostStorageRoot: options.home } : {}) }
    return undefined
  })

  for (const tool of fsTools()) {
    kernel.ctx.tools.register(tool)
  }
  // Background-process registry: host-owned, per session. The bridge appends
  // durable process/* events to the OWNING session's log — a session deleted
  // mid-flight simply has no reader left, and dispose emits nothing anyway.
  const processEvents = createProcessSessionEventBridge(kernel.ctx.sessions)
  const processes = new ProcessRegistry(processEvents)
  kernel.ctx.provide('processes', processes)
  kernel.ctx.provide('process-events', processEvents)
  kernel.ctx.tools.register(bashTool({ timeoutMs: limits.toolTimeoutMs, maxWaitMs: limits.bashMaxWaitMs, processes }))
  kernel.ctx.tools.register(bashOutputTool({ processes }))
  kernel.ctx.tools.register(killShellTool({ processes }))

  // Root sessions share project files, not a writer lease. Native Write/Edit
  // validate observed file state under a short canonical-path lock; Bash and
  // external processes remain shared-state operations without isolation.
  const leaseHeldInside = (folder: string): boolean =>
    [...sessions.values()].some((entry) => entry.agent.busy && entry.projectId !== undefined && within(folder, workspaces.getProject(entry.projectId, entry.workspaceId).path))

  // Turn-local skill snapshots: the FIRST load in a turn pins content and
  // hash for the whole turn — external edits apply to FUTURE loads, never
  // to a running turn (no mid-turn hot reload). Cleared at turn-settled.
  const skillSnapshots = new Map<SessionId, Map<string, ActiveSkill>>()
  kernel.ctx.on('agent/turn-settled', async () => {
    const settled = agentScope.getStore()?.sessionId
    if (settled !== undefined) {
      skillSnapshots.delete(settled)
      // A root turn's per-turn spawn budget ends with the turn. The await
      // serializes with spawn admission so a committing spawn cannot
      // re-create the key this cleanup drops.
      await childExecutor.releaseTurns(settled)
    }
  })

  /**
   * Runs PreCompact hooks for a compaction attempt, appending durable
   * hook/run events. Shared by the manual route and the automatic trigger —
   * hooks gate both. Returns the blocking reason when a hook denies
   * compaction, or undefined when compaction may proceed.
   */
  const runPreCompactHooks = async (session: Session, workspaceId: WorkspaceId, signal?: AbortSignal, trigger: 'manual' | 'auto' = 'manual'): Promise<string | undefined> => {
    signal?.throwIfAborted()
    // Claude semantics: PreCompact observes (exit 2 only shows stderr to the
    // user); `continue: false` is the one way a hook stops the compaction.
    const { verdict } = await hookHost.fire('PreCompact', {
      workspaceId,
      projectId: sessions.get(session.id)?.projectId,
      sessionId: session.id,
      matchValue: trigger,
      input: { trigger, custom_instructions: '' },
      ...(signal !== undefined ? { signal } : {}),
    })
    signal?.throwIfAborted()
    return verdict.stop !== undefined ? `PreCompact hook stopped compaction: ${verdict.stop.reason}` : undefined
  }

  // Reservation is acquired synchronously, before hooks or snapshot loading.
  // Accepted inputs remain in the durable inbox until maintenance settles.
  const compactions = new Map<SessionId, { controller: AbortController; done: Promise<unknown> | undefined }>()
  const manifestTurns = new Map<SessionId, TurnId>()
  const automaticBoundaries = new Map<SessionId, number>()
  let compactionClosing = false
  const cancelCompaction = (sessionId: SessionId): void => {
    compactions.get(sessionId)?.controller.abort(new Error('compaction cancelled'))
  }
  const runCompaction = (entry: SessionEntry, trigger: 'manual' | 'automatic') => {
    if (compactionClosing || entry.closed || compactions.has(entry.session.id)
      || (trigger === 'manual' && entry.agent.busy)
      || kernel.ctx.llm.sessionUncertain(entry.session.id)) {
      return Promise.reject(new Error('compaction requires a completed exchange boundary; session is active or reserved'))
    }
    const reservation = { controller: new AbortController(), done: undefined as Promise<unknown> | undefined }
    compactions.set(entry.session.id, reservation)
    const signal = reservation.controller.signal
    const done = agentScope.exit(async () => {
      try {
        const blocked = await runPreCompactHooks(entry.session, entry.workspaceId, signal, trigger === 'automatic' ? 'auto' : 'manual')
        signal.throwIfAborted()
        if (blocked !== undefined) throw new Error(blocked)
        // Incremental fold: seed from the latest valid canonical checkpoint so
        // only the uncovered delta is summarized, never the covered prefix —
        // and only the delta's attachments need loading.
        const seed = await checkpoints.latest(entry.session.id, entry.session.committedEvents).catch(() => undefined)
        signal.throwIfAborted()
        const fromSeq = seed?.coversSeq ?? 0
        const refs = entry.session.events.flatMap((event) => event.type === 'user/message' && event.seq > fromSeq ? [...(event.attachments ?? [])] : [])
        const loaded = refs.length > 0 ? await attachments.load(entry.workspaceId, refs, { textLimit: limits.attachmentTextLimit }) : undefined
        signal.throwIfAborted()
        const pair = summarizerModelOf(entry.session)
        const summarizer = createCompactionSummarizer((request) => (async function* () {
          // Each summarizer chunk is idempotent from the caller's view: a failed
          // attempt's partial output is discarded (buffered, never yielded), so a
          // transient transport failure may re-ask the same chunk — bounded like
          // the agent loop by stepRetries, with the same exponential backoff.
          const owner = new LogicalRequest({ firstProgressMs: limits.streamFirstEventMs, idleMs: limits.streamIdleMs, totalMs: limits.logicalRequestMs, retryBaseMs: limits.stepRetryBaseMs, maxAttempts: Math.min(4, limits.stepRetries + 1) })
          try {
            for (;;) {
              const buffered: StreamEvent[] = []
              try {
                // Maintenance must not inherit the settled turn's AsyncLocalStorage:
                // context/usage middleware must not replace or account this prompt.
                // The usage tap therefore cannot see it; record its tokens here.
                const startedAt = Date.now()
                for await (const event of agentScope.exit(() => kernel.ctx.llm.stream(request, {
                  signal, requestOwner: owner,
                  attribution: { sessionId: entry.session.id, turnId: `compaction:${entry.session.id}`, stepId: randomUUID() },
                }))) buffered.push(event)
                const usage = buffered.findLast((event) => event.type === 'usage')
                if (usage?.type === 'usage') {
                  usageLog.record({
                    at: Date.now(), startedAt, workspaceId: entry.workspaceId,
                    sessionId: entry.session.id, rootSessionId: entry.session.id,
                    kind: 'compaction',
                    ...(request.providerName !== undefined ? { provider: request.providerName } : {}),
                    model: request.model ?? 'unknown',
                    input: usage.usage.inputTokens, cached: usage.usage.cachedInputTokens ?? 0, output: usage.usage.outputTokens ?? 0,
                  })
                }
                yield* buffered
                return
              } catch (caught) {
                const error = caught instanceof ProviderError ? caught : classifyTransport(caught, 'stream')
                // A context overflow re-sent with identical input can only fail
                // again; the agent loop squeezes, the summarizer cannot.
                if (error.contextExceeded || !owner.canRetry(error, false)) throw error
                await owner.backoff(signal, error.retryAfterMs)
              }
            }
          } finally { owner.dispose() }
        })(), pair)
        const { compactSession, MAX_COMPACTION_SUMMARY_CHARS } = await import('../harness/context/compaction.ts')
        return await compactSession(entry.session, checkpoints, summarizer, {
          trigger, signal, ...(pair !== undefined ? { model: pair.model } : { extractiveCap: MAX_COMPACTION_SUMMARY_CHARS }),
          ...(loaded !== undefined ? { attachments: loaded } : {}),
          ...(seed !== undefined ? { seed } : {}),
        })
      } finally {
        if (compactions.get(entry.session.id) === reservation) compactions.delete(entry.session.id)
        if (!signal.aborted && !compactionClosing && !entry.closed && depsRef.current !== undefined) {
          // Automatic runs are awaited by the driver, which drains its own inbox.
          if (!entry.agent.busy && kernel.ctx.sessions.pendingInputs(entry.session).length > 0) await dispatchInbox(entry, depsRef.current, 'queue')
        }
      }
    })
    reservation.done = done
    return done
  }

  kernel.ctx.on('agent/turn-settled', async ({ turnId, reason }) => {
    if (limits.automaticCompactionPressure <= 0 || reason !== 'completed' || compactionClosing) return
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.workspaceId === undefined || scope.childOf !== undefined) return
    const entry = sessions.get(scope.sessionId)
    if (entry === undefined || entry.closed || manifestTurns.get(scope.sessionId) !== turnId) return
    if (rootModeOf(scope, scope.workspaceId).mode.definition.sources.history !== 'compact') return
    const manifest = lastManifests.get(scope.sessionId)
    if (manifest === undefined) return
    const { usedTokens, availableTokens, preTrimTokens } = manifest.budget
    if (availableTokens <= 0 || (preTrimTokens ?? usedTokens) / availableTokens < limits.automaticCompactionPressure) return
    const boundary = entry.session.events.findLast((event) => event.type === 'turn/end' && event.turnId === turnId)
    if (boundary === undefined || automaticBoundaries.get(scope.sessionId) === boundary.seq) return
    automaticBoundaries.set(scope.sessionId, boundary.seq)
    try {
      await runCompaction(entry, 'automatic')
    } catch (error) {
      console.error(`web: automatic compaction failed for ${scope.sessionId}: ${String(error instanceof Error ? error.message : error)}`)
    }
  })

  const mcpDisabledTurns = new Set<string>()
  const mcpTurnKey = (scope: AgentScope | undefined): string | undefined =>
    scope?.turnId === undefined ? undefined : `${scope.sessionId}:${scope.turnId}`
  const mcpDisabledForTurn = (scope: AgentScope | undefined): boolean => {
    const key = mcpTurnKey(scope)
    return key !== undefined && mcpDisabledTurns.has(key)
  }
  kernel.ctx.on('agent/turn-settled', () => {
    const key = mcpTurnKey(agentScope.getStore())
    if (key !== undefined) mcpDisabledTurns.delete(key)
  })

  // G5 prompt boundary: connect enabled MCP servers BEFORE the agent
  // snapshots schemas, then run UserPromptSubmit hooks. MCP is an optional
  // capability: invalid/unavailable workspace config removes its tools from
  // this Turn but cannot reject chat. Injected hook content is lower-trust
  // reference data and becomes a logged input in this Turn.
  kernel.ctx.on('agent/pre-step', async (claim, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    try {
      await connectWorkspaceMcp(workspaceId)
    } catch (error) {
      const turnKey = mcpTurnKey(scope)
      if (turnKey !== undefined) mcpDisabledTurns.add(turnKey)
      await fenceWorkspace(workspaceId).catch(() => undefined)
      for (const key of mcpDescriptors.keys()) {
        if (key.startsWith(`${workspaceId}:mcp__`)) mcpDescriptors.delete(key)
      }
      console.warn(`web: workspace MCP unavailable in ${workspaceId}; chat continues without MCP tools: ${String(error instanceof Error ? error.message : error)}`)
    }
    const contents = [...claim.contents]
    // Claude: UserPromptSubmit fires for the user's prompt; a subagent's
    // first turn fires SubagentStart instead (matcher = agent type).
    const child = scope?.childOf
    const event = child !== undefined ? 'SubagentStart' as const : 'UserPromptSubmit' as const
    let fired
    try {
      fired = await hookHost.fire(event, {
        workspaceId,
        projectId: scope?.projectId,
        sessionId: scope?.sessionId,
        rootSessionId: scope?.rootSessionId ?? scope?.sessionId,
        ...(child !== undefined ? { matchValue: child.definition } : {}),
        input: child !== undefined
          ? { agent_id: scope?.sessionId ?? '', agent_type: child.definition }
          : { prompt: contents.join('\n') },
        // Stop kills a running hook's process tree instead of waiting it out.
        ...(claim.signal !== undefined ? { signal: claim.signal } : {}),
      })
    } catch {
      if (claim.signal?.aborted === true) return { kind: 'reject', reason: `stopped while ${event} hooks were running` }
      return { kind: 'reject', reason: `${event} hook audit could not be recorded` }
    }
    const { verdict } = fired
    if (verdict.stop !== undefined) return { kind: 'reject', reason: `${event} hook stopped the prompt: ${verdict.stop.reason}` }
    if (event === 'UserPromptSubmit' && verdict.block !== undefined) {
      return { kind: 'reject', reason: `UserPromptSubmit hook blocked the prompt: ${verdict.block.reason}` }
    }
    // Context rides its own channel: logged as `origin: 'context'`, read by
    // the model, shown collapsed — never mixed into the user's own bubble.
    return next({
      contents,
      ...(verdict.additionalContext !== undefined ? { context: [hookContextBlock(event, verdict.additionalContext)] } : {}),
    })
  }, true)

  // G4 root lifecycle, part one: the model stopped calling tools while children
  // it delegated are still running or unreported. Closing the turn would cancel
  // them and lose everything they did, so the root joins them (bounded, and a
  // user Stop ends the wait) and spends one more step on their reports.
  kernel.ctx.on('agent/turn-continuation', async (state) => {
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.workspaceId === undefined || scope.childOf !== undefined) return undefined
    const handles = await depsRef.current?.childExecutor.joinTurnChildren(
      scope.workspaceId,
      scope.sessionId,
      state.turnId,
      { timeoutMs: limits.delegationJoinMs, ...(state.signal !== undefined ? { signal: state.signal } : {}) },
    )
    return handles !== undefined && handles.length > 0 ? formatChildReports(handles) : undefined
  })

  // Claude Stop / SubagentStop hooks: the model finished (and delegated work
  // was joined above — a serial chain stops at the first continuation). A
  // blocking hook's reason becomes the next step's input; `stop_hook_active`
  // tells the hook it already continued this turn, and a hard cap bounds a
  // hook that never lets go.
  const stopHookContinuations = new Map<string, number>()
  const STOP_HOOK_CONTINUATION_CAP = 8
  kernel.ctx.on('agent/turn-continuation', async (state) => {
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.workspaceId === undefined) return undefined
    if (state.signal?.aborted === true) return undefined
    const key = `${scope.sessionId}:${state.turnId}`
    const count = stopHookContinuations.get(key) ?? 0
    const child = scope.childOf
    const event = child !== undefined ? 'SubagentStop' as const : 'Stop' as const
    let verdict
    try {
      ({ verdict } = await hookHost.fire(event, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        sessionId: scope.sessionId,
        rootSessionId: scope.rootSessionId ?? scope.sessionId,
        ...(child !== undefined ? { matchValue: child.definition } : {}),
        input: {
          stop_hook_active: count > 0,
          ...(child !== undefined ? { agent_id: scope.sessionId, agent_type: child.definition } : {}),
        },
        ...(state.signal !== undefined ? { signal: state.signal } : {}),
      }))
    } catch {
      return undefined
    }
    if (verdict.stop !== undefined || verdict.block === undefined || count >= STOP_HOOK_CONTINUATION_CAP) {
      stopHookContinuations.delete(key)
      return undefined
    }
    stopHookContinuations.set(key, count + 1)
    return `${event} hook feedback (the turn continues):\n${verdict.block.reason}`
  })
  kernel.ctx.on('agent/turn-stopping', (state) => {
    const scope = agentScope.getStore()
    if (scope?.sessionId !== undefined) stopHookContinuations.delete(`${scope.sessionId}:${state.turnId}`)
  })

  // G4 root lifecycle, part two: the root cannot complete a turn while its children
  // remain active. Cancelling remaining children within the root's budget
  // is the spec's sanctioned resolution; settlement is awaited so
  // `turn/end: completed` never hides active work.
  kernel.ctx.on('agent/turn-stopping', async (state) => {
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.childOf !== undefined) return
    // Close admission durably before enumerating children: a concurrent HTTP
    // spawn cannot slip in after cleanup has taken its snapshot.
    await depsRef.current?.childExecutor.closeTurn(scope.sessionId, state.turnId)
    const cancelled = await depsRef.current?.childExecutor.resolveForRootCompletion(
      scope.sessionId,
      state.turnId,
    )
    if (cancelled !== undefined && cancelled > 0) {
      console.log(`web: root ${scope.sessionId} cancelled ${cancelled} active child(ren) at completion`)
    }
  })

  // ── Claude Code PreToolUse / PostToolUse hooks ───────────────
  /**
   * Calls a PreToolUse hook answered `permissionDecision: "ask"` for: the
   * approval policy's forceAsk turns an otherwise-allowed call into a prompt.
   * Keyed by execution (or session) + exact call fingerprint.
   */
  const hookAskCalls = new Set<string>()
  /** PreToolUse `additionalContext` waiting for its call's result (same key). */
  const hookToolContext = new Map<string, string>()
  const HOOK_CALL_STATE_CAP = 1_000
  const hookAskKey = (owner: string | undefined, call: ToolCall): string => `${owner ?? ''}:${approvalCallFingerprint(call)}`
  /** Write/Edit aimed at hook settings or hook scripts (see isHookConfigPath). */
  const writesHookConfig = (call: ToolCall): boolean => {
    if (call.name !== 'Write' && call.name !== 'Edit') return false
    const target = call.args['path']
    return typeof target === 'string' && isHookConfigPath(target, options.userClaudeDir !== undefined ? [options.userClaudeDir] : [])
  }

  /**
   * PreToolUse: hooks see the Claude `tool_input` shape and may deny, force
   * an approval prompt, or rewrite the input. `allow` never bypasses mode,
   * policy or the guard — the rewritten call re-enters every gate.
   */
  kernel.ctx.on('tools/rewrite', async (payload, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    let call = payload.call
    let fired
    try {
      fired = await hookHost.fire('PreToolUse', {
        workspaceId,
        projectId: scope?.projectId,
        sessionId: scope?.sessionId,
        rootSessionId: scope?.rootSessionId ?? scope?.sessionId,
        matchValue: call.name,
        input: { tool_name: call.name, tool_input: toClaudeToolInput(call.name, call.args), tool_use_id: call.id },
        ...(payload.exec.signal !== undefined ? { signal: payload.exec.signal } : {}),
      })
    } catch {
      // Durable audit BEFORE authorization/side effects: fail closed.
      return { kind: 'deny', reason: 'PreToolUse hook audit could not be recorded (fail-closed)', call }
    }
    const { verdict } = fired
    if (verdict.stop !== undefined) {
      stopTurnForHook(scope)
      return { kind: 'deny', reason: `PreToolUse hook stopped the turn: ${verdict.stop.reason}`, call }
    }
    if (verdict.block !== undefined) return { kind: 'deny', reason: `PreToolUse hook blocked '${call.name}': ${verdict.block.reason}`, call }
    if (verdict.updatedInput !== undefined) call = { ...call, args: fromClaudeToolInput(call.name, verdict.updatedInput) }
    if (verdict.permission === 'ask') hookAskCalls.add(hookAskKey(payload.exec.executionId ?? scope?.sessionId, call))
    // PreToolUse additionalContext reaches the model with this call's result.
    if (verdict.additionalContext !== undefined) hookToolContext.set(hookAskKey(payload.exec.executionId ?? scope?.sessionId, call), verdict.additionalContext)
    // Post-execute clears both; a preparation that throws never reaches it,
    // so keep them bounded (oldest first).
    while (hookAskCalls.size > HOOK_CALL_STATE_CAP) hookAskCalls.delete(hookAskCalls.values().next().value as string)
    while (hookToolContext.size > HOOK_CALL_STATE_CAP) hookToolContext.delete(hookToolContext.keys().next().value as string)
    return next({ call, exec: payload.exec })
  }, true)

  /**
   * PostToolUse: hooks see `tool_input` and `tool_response`; exit 2 or
   * `decision: "block"` sends the reason to the model beside the result,
   * `additionalContext` rides along as lower-trust data.
   */
  kernel.ctx.on('tools/post-execute', async (payload, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    const result = await next()
    const callKey = hookAskKey(payload.exec.executionId ?? scope?.sessionId, payload.call)
    hookAskCalls.delete(callKey)
    const preContext = hookToolContext.get(callKey)
    hookToolContext.delete(callKey)
    // Claude: a call that never ran (denied by a hook, policy or the user)
    // fires no post hook; one that ran and failed fires PostToolUseFailure.
    const denied = !result.ok && result.output.startsWith('denied:')
    if (denied) {
      // PreToolUse context still reaches the model with the denial.
      return preContext === undefined ? result : { ...result, output: `${result.output}\n\n${hookContextBlock('PreToolUse', preContext)}` }
    }
    const event = result.ok ? 'PostToolUse' as const : 'PostToolUseFailure' as const
    let verdict
    try {
      ({ verdict } = await hookHost.fire(event, {
        workspaceId,
        projectId: scope?.projectId,
        sessionId: scope?.sessionId,
        rootSessionId: scope?.rootSessionId ?? scope?.sessionId,
        matchValue: payload.call.name,
        input: {
          tool_name: payload.call.name,
          tool_input: toClaudeToolInput(payload.call.name, payload.call.args),
          tool_use_id: payload.call.id,
          ...(result.ok ? { tool_response: result.output } : { error: result.output }),
        },
        ...(payload.exec.signal !== undefined ? { signal: payload.exec.signal } : {}),
      }))
    } catch {
      // A stop while post hooks ran: the result stands as it is.
      if (payload.exec.signal?.aborted === true) return result
      // Observation hook: fail-open, but say the audit was lost.
      return { ...result, output: `${result.output}\n[hook audit unavailable]` }
    }
    // Claude `continue: false`: stop the whole turn after this result lands.
    if (verdict.stop !== undefined) stopTurnForHook(scope)
    const notes = [
      ...(preContext !== undefined ? [hookContextBlock('PreToolUse', preContext)] : []),
      ...(verdict.block !== undefined ? [`${event} hook feedback: ${verdict.block.reason}`] : []),
      ...(verdict.stop !== undefined ? [`${event} hook stopped the turn: ${verdict.stop.reason}`] : []),
      ...(verdict.additionalContext !== undefined ? [hookContextBlock(event, verdict.additionalContext)] : []),
    ]
    return notes.length === 0 ? result : { ...result, output: `${result.output}\n\n${notes.join('\n\n')}` }
  })

  /**
   * A hook answered `continue: false`: stop the executing conversation's
   * turn, as Claude Code stops processing. A child stops itself only.
   */
  function stopTurnForHook(scope: AgentScope | undefined): void {
    if (scope === undefined) return
    const entry = sessions.get(scope.sessionId)
    if (entry !== undefined) { entry.agent.stop(); return }
    kernel.ctx.agents.get(scope.sessionId)?.stop()
  }

  // The Skill tool: explicit catalog or on-demand load — no classifier and
  // no auto-load. Legacy `{ name }` calls still mean load.
  kernel.ctx.tools.register({
    name: 'Skill',
    description:
      "Load one skill's instructions on demand (mode-gated; skill content is data, never permissions). The workspace's available skills and their descriptions are already listed in your context; action:'catalog' re-lists or filters them.",
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'catalog | load (default load when name is present)' },
        name: { type: 'string', description: 'load: skill name from the catalog' },
        query: { type: 'string', description: 'catalog: optional name/title/description filter' },
        limit: { type: 'number', description: 'catalog: maximum rows (default 20, max 50)' },
      },
      required: [],
    },
    async execute(args) {
      const scope = agentScope.getStore()
      if (scope?.workspaceId === undefined) throw new Error('Skill requires a workspace-scoped execution')
      const wsId: WorkspaceId = scope.workspaceId
      const action = typeof args['action'] === 'string'
        ? args['action'].trim().toLowerCase()
        : typeof args['name'] === 'string'
          ? 'load'
          : 'catalog'
      if (action === 'catalog' || action === 'list') {
        const query = typeof args['query'] === 'string' ? args['query'].trim().toLowerCase() : ''
        const requestedLimit = typeof args['limit'] === 'number' && Number.isFinite(args['limit']) ? Math.floor(args['limit']) : 20
        const limit = Math.max(1, Math.min(requestedLimit, 50))
        // Hidden skills stay undiscoverable here (the workspace hid them on
        // purpose); a load by exact name still works — demand-only. Layers
        // follow the workspace's rules plus the bound project's folders.
        const all = await skillLayers(skills, workspaces, wsId, scope.projectId).then((layers) => skills.listVisibleIn(wsId, layers))
        const matches = query === ''
          ? all
          : all.filter((entry) => `${entry.name}
${entry.title}
${entry.description}`.toLowerCase().includes(query))
        if (matches.length === 0) return query === '' ? 'no skills available' : `no skills match '${query}'`
        const shown = matches.slice(0, limit)
        const suffix = matches.length > shown.length ? `
… ${matches.length - shown.length} more; refine query or raise limit` : ''
        return shown.map((entry) => `${entry.name} [${entry.source}] ${entry.title}${entry.description === '' ? '' : ` — ${entry.description}`}`).join('\n') + suffix
      }
      if (action !== 'load') throw new Error(`unknown Skill action '${action}'; use catalog or load`)
      const name = args['name']
      if (typeof name !== 'string' || name.trim() === '') throw new Error("argument 'name' must be a non-empty string for Skill load")
      const { mode } = rootModeOf(scope, scope.workspaceId)
      if (mode.definition.sources.skills !== 'on-demand') {
        throw new Error(`mode '${mode.definition.name}' has skills off; switch modes to load skills`)
      }
      const perTurn = skillSnapshots.get(scope.sessionId) ?? new Map<string, ActiveSkill>()
      const pinned = perTurn.get(name.trim())
      if (pinned !== undefined) {
        return `skill '${pinned.name}' loaded (hash ${pinned.hash.slice(0, 12)}); its instructions are included in context`
      }
      try {
        const layers = await skillLayers(skills, workspaces, wsId, scope.projectId)
        const loaded = await skills.loadIn(layers, name.trim())
        perTurn.set(loaded.name, { name: loaded.name, instructions: loaded.instructions, hash: loaded.hash })
        skillSnapshots.set(scope.sessionId, perTurn)
        return `skill '${loaded.name}' loaded (hash ${loaded.hash.slice(0, 12)}); its instructions are included in context`
      } catch (error) {
        if (!(error instanceof SkillError) || error.code !== 'not-found') throw error
        const rows = await skillLayers(skills, workspaces, wsId, scope.projectId).then((layers) => skills.listVisibleIn(wsId, layers))
        const sought = name.trim().toLowerCase()
        const suggestions = rows
          .filter((entry) => entry.name.includes(sought) || sought.includes(entry.name))
          .slice(0, 10)
          .map((entry) => entry.name)
        return `skill '${name.trim()}' not found; ${suggestions.length > 0 ? `similar: ${suggestions.join(', ')}` : 'use Skill action:"catalog" with an optional query'}`
      }
    },
  })
  // Claude-style session task list: full-replacement tool, state IS the log.
  kernel.ctx.tools.register(todoWriteTool())
  // Image tools: results land in the executing workspace's attachment
  // store, so the transcript renders them like any composer image. An edit
  // reads its source from that store or from a granted file (as Read would).
  const imageToolOptions: ImageToolOptions = {
    resolve: () => resolveImageApi(imageSettings, list),
    store: (workspaceId, input) => attachments.put(workspaceId, { name: input.name, mediaType: sniffImageMediaType(input.bytes) ?? 'application/octet-stream', bytes: input.bytes }),
    read: async (workspaceId, id) => {
      const bytes = await attachments.read(workspaceId, id)
      return { bytes, mediaType: sniffImageMediaType(bytes) ?? 'application/octet-stream' }
    },
    resolvePath: (exec, target) => resolveInGrants(exec, target, 'read'),
    maxBytes: limits.maxAttachmentBytes,
  }
  kernel.ctx.tools.register(generateImageTool(imageToolOptions))
  kernel.ctx.tools.register(editImageTool(imageToolOptions))
  kernel.ctx.tools.register(describeImageTool({
    resolve: () => resolveVisionApi(imageUnderstanding, list),
    read: imageToolOptions.read,
    // A tool-owned nested model request: it shares the turn's cancellation but
    // not the outer step's provider-attempt identity.
    stream: (request, exec) => kernel.ctx.llm.stream(request, exec.signal !== undefined ? { signal: exec.signal } : undefined),
  }))

  // AskUserQuestion: the model pauses for a human choice. The question
  // itself is the durable `tool/call`, the answer the `tool/result`; this map
  // only holds the live waiter (a restart ends the turn, so nothing to rebuild).
  const pendingQuestions = new Map<string, PendingQuestion>()
  kernel.ctx.tools.register(askUserQuestionTool({
    ask: (questions, exec) => new Promise<QuestionOutcome>((resolve, reject) => {
      const scope = agentScope.getStore()
      if (scope === undefined) {
        reject(new Error('AskUserQuestion needs an interactive conversation; no human is attached'))
        return
      }
      if (exec.signal?.aborted === true) {
        reject(new Error('cancelled: stop requested while asking the user'))
        return
      }
      // Unguessable capability id: the answer route is transport-global.
      const questionId = `question-${randomUUID()}`
      const parentSessionId = scope.childOf?.parentSessionId
      const definitionName = scope.childOf?.definition
      const principalId = sessionPrincipals.get(scope.sessionId)
      const workspaceId = (scope.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)) as WorkspaceId
      const expiresAt = Date.now() + limits.questionExpiryMs
      let settled = false
      const finish = (apply: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        exec.signal?.removeEventListener('abort', onAbort)
        pendingQuestions.delete(questionId)
        kernel.ctx.emit('web/question-settled', {
          sessionId: scope.sessionId,
          questionId,
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        })
        apply()
      }
      const timer = setTimeout(() => {
        finish(() => resolve({ kind: 'declined', reason: 'no answer before the question expired' }))
      }, limits.questionExpiryMs)
      timer.unref?.()
      const onAbort = (): void => {
        finish(() => reject(new Error('cancelled: stop requested while asking the user')))
      }
      exec.signal?.addEventListener('abort', onAbort, { once: true })
      pendingQuestions.set(questionId, {
        sessionId: scope.sessionId,
        workspaceId,
        ...(principalId !== undefined ? { principalId } : {}),
        callId: exec.toolCallId ?? '',
        questions,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
        ...(definitionName !== undefined ? { definitionName } : {}),
        expiresAt,
        settle: (outcome) => finish(() => resolve(outcome)),
      })
      kernel.ctx.emit('web/question', {
        sessionId: scope.sessionId,
        questionId,
        ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      })
    }),
  }))

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
    aliases: () => aliases.map((alias) => {
      try {
        validateProviderModel(alias.provider, alias.model)
        if (alias.thinkingLevel !== null && expressibleThinkingLevel(alias.model, alias.thinkingLevel) !== alias.thinkingLevel) throw new Error(`unsupported thinking '${alias.thinkingLevel}'`)
        return { ...alias, valid: true }
      } catch (error) { return { ...alias, valid: false, error: String(error instanceof Error ? error.message : error) } }
    }),
    admissionResolver: ({ parentSessionId, workspaceId, definition, candidates }) => admissionExposureCeiling(parentSessionId, workspaceId, definition, candidates),
    grantsOf: (parentSessionId) => {
      const entry = sessions.get(parentSessionId)
      return entry === undefined ? [] : effectiveGrants(parentSessionId, entry.projectId, entry.workspaceId)
    },
  }))

  /** Cancel/await an in-flight or connected server, then remove descriptors. */
  async function cancelMcpConnection(workspaceId: WorkspaceId, serverName: string): Promise<void> {
    const key = `${workspaceId}:${serverName}`
    mcpCancelled.add(key)
    mcpConnectFailures.delete(key)
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
    // A config or secret change may be the fix: try failed servers again now.
    for (const key of [...mcpConnectFailures.keys()]) {
      if (key.startsWith(`${workspaceId}:`)) mcpConnectFailures.delete(key)
    }
    for (const [key, client] of [...mcpClients]) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      client.retire()
      await client.disconnect().catch(() => {})
      mcpClients.delete(key)
      mcpClientGeneration.delete(key)
    }
  }

  /**
   * One queue per workspace for every desired-state write (config and
   * secrets). Each write loads, transforms, and saves inside its turn, so two
   * requests never both read the old file and the later save erase the other.
   */
  const mcpMutationQueue = new Map<WorkspaceId, Promise<void>>()
  function serializeMcpMutation<T>(workspaceId: WorkspaceId, run: () => Promise<T>): Promise<T> {
    const previous = mcpMutationQueue.get(workspaceId) ?? Promise.resolve()
    const next = previous.then(run, run)
    mcpMutationQueue.set(workspaceId, next.then(() => undefined, () => undefined))
    return next
  }

  /** Durable intent → fence → atomic save → commit, for one desired-state file. */
  async function writeDesiredState(workspaceId: WorkspaceId, mutation: 'config' | 'secrets', target: string, save: () => Promise<void>): Promise<void> {
    const backup = await readFileIfPresent(target)
    const id = await mutations.begin({ mutation, workspaceId, target, backup })
    await fenceWorkspace(workspaceId)
    try {
      await save()
      await mutations.commit(id)
    } catch (error) {
      await mutations.abort(id)
      throw error
    }
  }

  /** Apply `transform` to the CURRENT config; it may throw to refuse (stale revision, missing server). */
  function updateMcpConfig(workspaceId: WorkspaceId, transform: (current: McpConfig) => McpConfig): Promise<McpConfig> {
    return serializeMcpMutation(workspaceId, async () => {
      const next = transform(await mcpStore.loadMcp(workspaceId))
      await writeDesiredState(workspaceId, 'config', mcpStore.mcpPath(workspaceId), () => mcpStore.saveMcp(workspaceId, next))
      configWatch.set(workspaceId, await fileDigest(workspaceId))
      drifted.delete(workspaceId)
      return next
    })
  }

  /** Apply `transform` to the CURRENT secrets map (in place). */
  function updateMcpSecrets(workspaceId: WorkspaceId, transform: (secrets: Record<string, string>) => void): Promise<void> {
    return serializeMcpMutation(workspaceId, async () => {
      const secrets = await mcpStore.loadSecrets(workspaceId)
      transform(secrets)
      await writeDesiredState(workspaceId, 'secrets', mcpStore.secretsPath(workspaceId), () => mcpStore.saveSecrets(workspaceId, secrets))
    })
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

  /**
   * Adopt a stable, valid direct edit of mcp.json. The file is an operator-owned
   * configuration surface, so a digest change fences the old runtime but does
   * not require a Settings-only acknowledgement. Invalid or concurrently
   * changing bytes stay fenced and fail closed until a later observation can
   * validate one stable document.
   */
  async function observeConfig(workspaceId: string): Promise<void> {
    await serializeMcpMutation(workspaceId as WorkspaceId, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const hash = await fileDigest(workspaceId)
        const previous = configWatch.get(workspaceId)
        if (previous === hash && !drifted.has(workspaceId)) return
        if (previous !== undefined && previous !== hash) await fenceWorkspace(workspaceId as WorkspaceId)
        try {
          await mcpStore.loadMcp(workspaceId)
        } catch (error) {
          drifted.add(workspaceId)
          throw error
        }
        // An editor may replace the file while validation is in flight. Only
        // acknowledge the exact bytes that were validated.
        if (await fileDigest(workspaceId) !== hash) continue
        configWatch.set(workspaceId, hash)
        drifted.delete(workspaceId)
        return
      }
      drifted.add(workspaceId)
      throw new McpConfigError('invalid', 'mcp.json kept changing while it was being loaded; retry once the file is stable')
    })
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
        const managedOAuth = serverConfig.auth?.type === 'managed_oauth'
        if (managedOAuth && await oauth.accessToken(workspaceId, serverName) === undefined) {
          throw new McpTransportError(`MCP server '${serverName}' requires managed OAuth authorization`)
        }
        const bearerToken = managedOAuth || secretRef === undefined
          ? undefined
          : resolveSecretRefs(secretRef, secrets, `mcp.json server '${serverName}' auth`)
        // Managed OAuth is asked per request: an access token that expires (or
        // that the server revokes) while this client lives is refreshed instead
        // of being sent until the breaker opens.
        const tokenSource = managedOAuth
          ? async (rejected?: string): Promise<string | undefined> => {
            const token = rejected !== undefined
              ? await oauth.replaceRejected(workspaceId, serverName, rejected)
              : await oauth.accessToken(workspaceId, serverName)
            if (token === undefined) throw new Error(`MCP server '${serverName}' requires managed OAuth authorization`)
            return token
          }
          : undefined
        client = new McpServerClient(serverName, serverConfig, { env: resolvedEnv, bearerToken, headers: resolvedHeaders, tokenSource }, (event) => {
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
        mcpConnectFailures.delete(key)
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
      // Skip, never send: providers reject the whole request for one bad name.
      if (!PROVIDER_TOOL_NAME.test(fullName) || tool.name.includes('__')) continue
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
          // The tool pipeline mints this host identity before durable intent;
          // model call ids are transcript metadata and may repeat across roots.
          const invocationId = exec.executionId ?? `mcp-${randomUUID()}`
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
          if (exec.executionId !== undefined) {
            stageMcpOutcome(exec.executionId, { outcome: dispatched.outcome, invocationId, ok: dispatched.outcome === 'success' })
          }
          return text
        },
      })
    }
  }

  /**
   * Connect every enabled server for a workspace. An unreadable or invalid
   * config file disables MCP for the Turn without blocking chat. One server
   * that cannot connect (down, missing secret, OAuth needed) is skipped: its
   * tools stay out of this Turn, the reason is shown in Settings, and the
   * other servers still work. A failed server is retried after
   * {@link MCP_CONNECT_BACKOFF_MS}, so a dead one does not cost every Turn a
   * connect timeout.
   */
  async function connectWorkspaceMcp(workspaceId: WorkspaceId): Promise<void> {
    // Parse strictly so Settings can diagnose malformed workspace-owned MCP or
    // secrets config. The pre-step boundary catches these file-level errors,
    // removes this workspace's MCP descriptors, and continues without MCP.
    const config = await mcpStore.loadMcp(workspaceId)
    await mcpStore.loadSecrets(workspaceId)
    const now = Date.now()
    const attempts = Object.values(config.servers)
      .filter((server) => server.enabled)
      .filter((server) => {
        const key = `${workspaceId}:${server.name}`
        if (mcpClients.has(key) || mcpConnecting.has(key)) return true
        const failed = mcpConnectFailures.get(key)
        return failed === undefined || now - failed.at >= MCP_CONNECT_BACKOFF_MS
      })
      .map(async (server) => {
        const key = `${workspaceId}:${server.name}`
        try {
          await ensureMcpServer(workspaceId, server.name)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          // A disable/close that cancelled this connect is not a failure.
          if (mcpHostClosing || mcpCancelled.has(key)) return
          mcpConnectFailures.set(key, { at: Date.now(), message: message.slice(0, 500) })
          console.warn(`web: MCP server '${server.name}' unavailable in ${workspaceId}; its tools are skipped this turn: ${message}`)
        }
      })
    await Promise.all(attempts)
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

  /**
   * Whether the root's latest durable turn is terminal. `agent.busy` flips
   * idle only after the turn's terminal append settles, so manual-spawn
   * admission checks the durable log to avoid rejecting a spawn offered in
   * that window with a false "active conversation Turn".
   */
  function turnTerminal(session: Session): boolean {
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event?.type === 'turn/end' || event?.type === 'turn/closing') return true
      if (event?.type === 'turn/start') return false
    }
    return true
  }

  /**
   * The mode governing one execution: the ROOT session's latest durable
   * snapshot. A child resolves its root's record, so a root switching mode
   * narrows its own children and nobody else. A legacy root with no snapshot
   * falls back to the workspace default until the migration stamps it.
   */
  function rootModeOf(scope: { readonly sessionId: SessionId; readonly rootSessionId?: SessionId; readonly workspaceId?: WorkspaceId } | undefined, workspaceId: WorkspaceId): { mode: ResolvedMode; revision: number } {
    const rootId = scope?.rootSessionId ?? scope?.sessionId
    const root = rootId !== undefined ? sessions.get(rootId)?.session ?? childRootSession(rootId) : undefined
    const stamped = root !== undefined ? sessionModeOf(root.events) : undefined
    if (stamped !== undefined) {
      return { mode: { definition: stamped.snapshot, source: stamped.source, hash: stamped.hash }, revision: stamped.revision }
    }
    const state = controlsFor(workspaceId)
    return { mode: state.modeDefinition, revision: state.modeRevision }
  }

  /**
   * The ONE host exposure resolver: schema projection, spawn admission, and
   * both tool gates ask it, so they cannot drift. Exposure is a hard ceiling,
   * never a permission grant.
   */
  const executionAuthority = createExecutionAuthority({
    get blockedTools() { return options.blockedTools ?? [] },
    modeOf: (scope, workspaceId) => {
      const owner = (scope.rootSessionId ?? scope.sessionId) as SessionId | undefined
      const { mode, revision } = rootModeOf(owner !== undefined ? { sessionId: owner, rootSessionId: owner } : undefined, workspaceId as WorkspaceId)
      return { mode: mode.definition, revision }
    },
    loadMcp: (workspaceId) => mcpStore.loadMcp(workspaceId),
  })

  /** Spawn admission ceiling; called by the executor at its admission linearization point. */
  async function admissionExposureCeiling(rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[]): Promise<readonly string[]> {
    return executionAuthority.admissionCeiling({ workspaceId, rootSessionId, definition, candidates })
  }

  /**
   * Append one root's mode snapshot. The revision continues the root's own
   * sequence, so a later selection always supersedes an earlier one.
   */
  function stampRootMode(session: Session, resolved: ResolvedMode): Extract<SessionEvent, { type: 'session/mode' }> {
    const previous = sessionModeOf(session.events)
    const snapshot = resolved.definition
    session.append({
      type: 'session/mode',
      modeId: snapshot.id,
      revision: (previous?.revision ?? 0) + 1,
      snapshot,
      source: resolved.source,
      hash: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'),
    })
    return sessionModeOf(session.events) as Extract<SessionEvent, { type: 'session/mode' }>
  }

  /** The mode governing whatever is executing now (ambient scope). */
  function executingMode(): { mode: ResolvedMode; revision: number } {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    return rootModeOf(scope, workspaceId)
  }

  /** A root not registered as a web entry (e.g. loaded only by the executor). */
  function childRootSession(rootId: SessionId): Session | undefined {
    try {
      return kernel.ctx.sessions.get(rootId)
    } catch {
      return undefined
    }
  }

  /** Re-validate and adopt a mode file into the workspace's live control. */
  async function adoptMode(workspaceId: WorkspaceId, modeId: string): Promise<ResolvedMode> {
    const resolved = await modes.resolve(workspaceId, modeId)
    const state = controlsFor(workspaceId)
    state.modeId = modeId
    state.modeDefinition = resolved
    state.modeRevision += 1
    kernel.ctx.tools.bumpPolicyRevision()
    // Durable selection: the next boot restores this workspace to the same
    // mode instead of falling back to the default. Best-effort — a disk
    // failure does not roll back the live adoption.
    try {
      await modes.setSelected(workspaceId, modeId)
    } catch (error) {
      console.warn(`web: could not persist selected mode '${modeId}' for workspace '${workspaceId}': ${String(error instanceof Error ? error.message : error)}`)
    }
    return resolved
  }

  /**
   * Why the executing scope's CURRENT authority refuses this call, or
   * undefined when it is admitted. Shared by the first pre-execute gate and
   * the final gate right before the side effect, so a narrowing that lands
   * while a call waits (approval, stale batch) is enforced identically.
   */
  async function exposureDenial(call: ToolCall, scope: AgentScope | undefined): Promise<string | undefined> {
    return executionAuthority.refusal(scope, call.name)
  }

  const approvalReceipts = createApprovalReceiptRegistry()

  // G3 tool gate: the mode's exposure is a HARD ceiling — the FIRST
  // pre-execute listener denies unexposed tools even from stale model
  // batches, before approval is ever consulted.
  kernel.ctx.on('tools/pre-execute', async (payload, next) => {
    const refused = await exposureDenial(payload.call, agentScope.getStore())
    if (refused !== undefined) return { kind: 'deny', reason: refused }
    return next()
  }, true)
  // The same authority, re-read right before the side effect. This check is
  // non-interactive: a new ask must be retried as a fresh model call.
  kernel.ctx.on('tools/final-gate', async (payload) => {
    const scope: ApprovalScope = Object.freeze({
      sessionId: payload.exec.sessionId,
      rootSessionId: payload.exec.rootSessionId,
      turnId: payload.exec.turnId as TurnId | undefined,
      executionId: payload.exec.executionId,
      workspaceId: payload.exec.workspaceId,
    })
    const decision = await hostAuthority(payload.call, scope)
    if (decision.kind === 'deny') {
      approvalReceipts.retire(scope.executionId)
      pathScope.retire(scope.executionId)
      return decision.reason
    }
    if (decision.kind === 'ask' && !approvalReceipts.covers(payload.call, scope, decision.requirements)) {
      approvalReceipts.retire(scope.executionId)
      pathScope.retire(scope.executionId)
      return `current authority requires fresh approval for '${payload.call.name}'; retry as a new call`
    }
    const outside = pathScope.get(scope.executionId, payload.call)
    if (outside?.grantForSession === true && outside.proposedGrant !== undefined && outside.parentSessionId === undefined && outside.sessionId !== undefined) {
      const session = sessions.get(outside.sessionId as SessionId)?.session
      if (session === undefined) return 'the session grant could not be recorded: session not loaded'
      try {
        const primary = outside.projectId === undefined
          ? undefined
          : workspaces.getProject(outside.projectId as ProjectId, outside.workspaceId as WorkspaceId | undefined).path
        await mutateSessionGrants(session, async (current) => {
          const validated = await validateGrantFolder(outside.proposedGrant, primary, grantPolicy)
          return mergeGrants(current.roots, [{ path: validated, access: outside.intent }])
        }, outside.approvalId)
      } catch (error) {
        return `the session grant could not be recorded: ${String(error instanceof Error ? error.message : error)}`
      }
      // The grant queue wait can outlive the decision above: authority that
      // narrowed (mode, guard, receipts) while this mutation queued must
      // still gate the dispatch, so re-run the final check after persisting.
      const after = await hostAuthority(payload.call, scope)
      if (after.kind === 'deny') {
        approvalReceipts.retire(scope.executionId)
        pathScope.retire(scope.executionId)
        return after.reason
      }
      if (after.kind === 'ask' && !approvalReceipts.covers(payload.call, scope, after.requirements)) {
        approvalReceipts.retire(scope.executionId)
        pathScope.retire(scope.executionId)
        return `current authority requires fresh approval for '${payload.call.name}'; retry as a new call`
      }
    }
    // Admission consumes the evidence. Prepared calls are single-use, so no
    // authorization state survives dispatch or a later call-id collision.
    approvalReceipts.retire(scope.executionId)
    pathScope.retire(scope.executionId)
    return undefined
  })

  /** Last request's manifest per session — the inspector renders this. */
  const lastManifests = new Map<SessionId, ContextManifest>()
  /** Context section hashes already recorded in each session's log (body dedupe). */
  const contextBodies = new Map<SessionId, Set<string>>()
  const contextBodiesFor = (sessionId: SessionId): Set<string> => {
    let seen = contextBodies.get(sessionId)
    if (seen === undefined) {
      seen = new Set()
      contextBodies.set(sessionId, seen)
    }
    return seen
  }
  /** Provider-reported token usage per session (last request + running cache totals). */
  const sessionUsage = new Map<SessionId, SessionUsage>()

  // Tap every scoped completion for its `usage` event: the context meter
  // shows the provider's real prompt size and cache hits, not only the
  // builder's chars/4 estimate. Events pass through untouched.
  //
  // `last` is cleared when the NEXT request is assembled and only rewritten
  // once THIS stream reports usage. Otherwise a manifest fetched between
  // those two points would show the previous prompt count over the new
  // breakdown.
  kernel.ctx.on('llm/stream', (request, next) => {
    const scope = agentScope.getStore()
    const sessionId = scope?.sessionId
    const upstream = next(request)
    if (sessionId === undefined) return upstream
    const startedAt = Date.now()
    return (async function* tap() {
      // Some providers report usage more than once; the last report wins.
      let reported: TokenUsage | undefined
      try {
        for await (const event of upstream) {
          if (event.type === 'usage') {
            recordUsage(sessionUsage, sessionId, event.usage)
            reported = event.usage
          }
          yield event
        }
      } finally {
        if (reported !== undefined) {
          usageLog.record({
            at: Date.now(), startedAt,
            ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
            sessionId, rootSessionId: scope?.rootSessionId ?? sessionId,
            kind: scope?.childOf !== undefined ? 'child' : 'turn',
            ...(request.providerName !== undefined ? { provider: request.providerName } : {}),
            model: request.model ?? 'unknown',
            input: reported.inputTokens, cached: reported.cachedInputTokens ?? 0, output: reported.outputTokens ?? 0,
          })
        }
      }
    })()
  }, true)

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

  /**
   * Claude Code CLAUDE.md layering plus the workspace layer (spec
   * 2026-10-08-claude-format-parity): user < workspace < project < local.
   */
  async function readWorkspaceInstructions(home: string, workspaceId: WorkspaceId, projectId: ProjectId | undefined): Promise<string> {
    let projectRoot: string | undefined
    if (projectId !== undefined) {
      try { projectRoot = workspaces.getProject(projectId, workspaceId).path } catch { projectRoot = undefined }
    }
    const files = await loadClaudeMd({
      ...(options.userClaudeDir !== undefined ? { userDir: options.userClaudeDir } : {}),
      workspaceDir: path.join(home, 'workspaces', workspaceId),
      ...(projectRoot !== undefined ? { projectRoot } : {}),
      // Imports never reach credential roots or app storage (other workspaces).
      deniedRoots: [...(options.secretRoots ?? []), ...(options.home !== undefined ? [options.home] : [])],
    })
    return renderClaudeMd(files)
  }

  /**
   * Git branch for the environment block, cached per project root for the
   * server's lifetime: freshness yields to never stalling assembly, and the
   * Git view remains the source of truth. Read-only flags match
   * project-git.ts (no fsmonitor, no hooks, no pager); any failure or
   * timeout omits the branch line, never the request.
   */
  const gitBranchCache = new Map<string, string | undefined>()
  const ENV_GIT_TIMEOUT_MS = 2_000
  async function cachedGitBranch(root: string): Promise<string | undefined> {
    if (gitBranchCache.has(root)) return gitBranchCache.get(root)
    // A cheap existence check first: non-repos (temp dirs, plain folders)
    // never pay a process spawn, and `git rev-parse` walks parent dirs so
    // the lookup stays correct when the repo root is an ancestor.
    const hasGitDir = await fs.stat(path.join(root, '.git')).then(() => true, () => false)
    const branch = hasGitDir !== true
      ? undefined
      : await new Promise<string | undefined>((resolve) => {
        execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: root,
          timeout: ENV_GIT_TIMEOUT_MS,
          windowsHide: true,
        }, (error, stdout) => {
          if (error !== null) { resolve(undefined); return }
          const name = String(stdout).trim()
          resolve(name === '' || name === 'HEAD' ? undefined : name)
        })
      })
    gitBranchCache.set(root, branch)
    return branch
  }

  /**
   * The trusted environment facts for this request: host clock (minute
   * granularity), platform, and — for a root session whose project folder is
   * known — the workspace path and cached git branch. Children inherit the
   * same facts; nothing here is content-derived.
   */
  async function environmentBlockFor(scope: AgentScope | undefined, fileScope: { root: string } | undefined): Promise<string | undefined> {
    const isChild = scope?.childOf !== undefined
    const workspacePath = isChild ? undefined : fileScope?.root
    const gitBranch = workspacePath !== undefined ? await cachedGitBranch(workspacePath).catch(() => undefined) : undefined
    return renderEnvironmentContext({
      now: new Date(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      ...(workspacePath !== undefined ? { workspacePath } : {}),
      ...(gitBranch !== undefined ? { gitBranch } : {}),
    })
  }

  // G3 single assembly path: the mode-driven builder replaces the projected
  // request wholesale. Effective permission is the selected mode's map; host
  // restrictions stay above it.
  kernel.ctx.on('agent/context', async (projected, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    const session = await scopedSession(scope?.sessionId)
    const effective = session === undefined
      ? { provider: defaults.provider, model: defaults.model, thinkingLevel: defaults.thinkingLevel, source: 'global' as const }
      : resolveEffectiveModel(session, workspaceId)
    const { mode, revision: modeRevision } = rootModeOf(scope, workspaceId)
    // Workspace-authored system prompt replacements (Settings → System
    // Prompts). A read failure degrades to the defaults, like memory.
    const promptOverrides = await systemPrompts.load(workspaceId).catch(() => undefined)

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
    // config/allowlist ceiling (zero-exposure modes none; Plan read-safe
    // allowlist only; Explorer none; other children require explicit spawn
    // grant).
    const exposureScope = { ...(scope ?? { sessionId: undefined }), workspaceId }
    const projectedTools = mcpDisabledForTurn(scope)
      ? (projected.tools ?? []).filter((schema) => !schema.name.startsWith('mcp__'))
      : projected.tools ?? []
    const exposureSnapshot = await executionAuthority.snapshot(exposureScope, workspaceId, projectedTools.some((schema) => schema.name.startsWith('mcp__')))
    let exposed = projectExposedSchemas(exposureSnapshot, exposureScope, projectedTools)
    // Workspace-level instructions load for ANY workspace-scoped session;
    // project instructions join when a project is bound.
    const workspaceInstructions =
      scope?.workspaceId !== undefined && mode.definition.sources.workspaceInstructions
        ? await readWorkspaceInstructions(resourceHome, scope.workspaceId, scope.projectId).catch(() => undefined)
        : undefined

    // Claude-style skill discovery: the catalog (name + one-line description)
    // rides in every request that exposes the Skill tool, so the model can
    // choose to load a skill the user never named. Bodies stay on-demand
    // Skill loads. Gated on the tool's presence so the block never advertises
    // a load path this request does not carry; failures degrade to the old
    // discover-by-catalog-call path.
    const skillCatalog = mode.definition.sources.skills === 'on-demand'
      && scope?.workspaceId !== undefined
      && exposed.some((schema) => schema.name === 'Skill')
      ? await skillLayers(skills, workspaces, scope.workspaceId, scope.projectId)
          .then((layers) => skills.listVisibleIn(scope.workspaceId as WorkspaceId, layers))
          .then((rows) => rows.map((entry) => {
            const description = entry.description === '' ? entry.title : entry.description
            return { name: entry.name, description: description.length > 500 ? `${description.slice(0, 499)}…` : description }
          }))
          .catch(() => undefined)
      : undefined

    // Turn-local active skills: the pinned snapshots from this turn's
    // Skill loads — NOT fresh reads, so external edits mid-turn never
    // change what a running turn sees (hash-pinned, no hot reload).
    const activeSkills: ActiveSkill[] = []
    if (mode.definition.sources.skills === 'on-demand' && scope !== undefined) {
      const perTurn = skillSnapshots.get(scope.sessionId) ?? new Map<string, ActiveSkill>()
      // Definition skills preload ONCE for this child Turn, then remain
      // hash-pinned like explicit Skill loads (no mid-turn file reload).
      // They resolve through the SAME rule layers as the Skill tool (project
      // folders included, disabled rules excluded), never the legacy defaults.
      const pending = (scope.childOf?.skills ?? scope.role?.skills ?? []).filter((name) => !perTurn.has(name))
      const childLayers = pending.length === 0
        ? []
        : await skillLayers(skills, workspaces, workspaceId, scope.projectId)
            .catch(() => skillLayers(skills, workspaces, workspaceId, undefined))
            .catch(() => [] as SkillLayer[])
      for (const name of pending) {
        try {
          const loaded = await skills.loadIn(childLayers, name)
          projected.assemblySignal?.throwIfAborted()
          perTurn.set(name, { name: loaded.name, instructions: loaded.instructions, hash: loaded.hash })
        } catch {
          // An invalid/missing definition skill surfaces as an omission in
          // the manifest rather than broadening authority.
        }
      }
      projected.assemblySignal?.throwIfAborted()
      if (perTurn.size > 0) skillSnapshots.set(scope.sessionId, perTurn)
      activeSkills.push(...perTurn.values())
    }

    // Indexes are reference data, not pinned memory bodies. Load both
    // workspace and current project on every enabled request, including children.
    const pinnedMemory: MemorySnippet[] = []
    if (mode.definition.sources.memoryPinned && mode.definition.sources.memoryRetrieval && scope?.workspaceId !== undefined) {
      pinnedMemory.push(...await memoryIndexes(memory, { workspaceId: scope.workspaceId, ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}) }))
    }

    // Compaction summaries only apply when the mode's history reads them.
    let compaction: { summary: string; coversSeq: number; verifiedAgainst: 'committed-log' } | undefined
    if (mode.definition.sources.history === 'compact' && scope !== undefined) {
      // `latest(id, events)` returns only the canonical checkpoint recovered
      // from the committed log, so the builder need not re-derive it.
      const checkpoint = await checkpoints.latest(scope.sessionId, session?.committedEvents ?? []).catch(() => undefined)
      if (checkpoint !== undefined) compaction = { summary: checkpoint.summary, coversSeq: checkpoint.coversSeq, verifiedAgainst: 'committed-log' }
    }

    projected.assemblySignal?.throwIfAborted()
    const events = session?.events ?? []
    // Attachment bytes are read once per request and cached by the store: the
    // log holds references, and the model needs the content itself.
    const referenced = events.flatMap((event) => (event.type === 'user/message' ? [...(event.attachments ?? [])] : []))
    const loadedAttachments = referenced.length > 0
      ? await attachments.load(workspaceId, referenced, { textLimit: limits.attachmentTextLimit })
      : undefined

    projected.assemblySignal?.throwIfAborted()
    // The same grant the tool pipeline resolves, so the model is told exactly
    // the folders its file tools can reach.
    const fileScope = scope !== undefined ? agentScope.run(scope, () => kernel.ctx.tools.currentGrant()) : undefined
    // Read-only modes get guidance that never asks for a write they cannot make.
    const guidanceAccess = memoryGuidanceAccess(exposed.map((schema) => schema.name))
    if (scope !== undefined && fileScope?.memoryRoots !== undefined && guidanceAccess !== undefined) {
      pinnedMemory.unshift(memoryGuidance(fileScope.memoryRoots, guidanceAccess))
    }
    const environment = await environmentBlockFor(scope, fileScope).catch(() => undefined)
    const assembled = buildContext({
      ...(fileScope !== undefined
        ? {
          fileScope: {
            primary: fileScope.root,
            additional: fileScope.additionalRoots ?? [],
            outsideAsks: options.yolo !== true && mode.definition.outOfGrant !== 'allow',
          },
        }
        : {}),
      ...(environment !== undefined ? { environment } : {}),
      ...(scope?.workspaceId !== undefined ? { harnessWorkspaceDir: path.join(resourceHome, 'workspaces', scope.workspaceId) } : {}),
      events,
      mode,
      modeRevision,
      model: effective.model ?? undefined,
      providerName: effective.provider ?? undefined,
      schemas: exposed,
      ...(workspaceInstructions !== undefined && workspaceInstructions !== '' ? { workspaceInstructions } : {}),
      activeSkills,
      ...(skillCatalog !== undefined ? { skillCatalog } : {}),
      pinnedMemory,
      compactionTailTurns: limits.compactionTailTurns,
      budget,
      ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
      ...(compaction !== undefined ? { compaction } : {}),
      ...(loadedAttachments !== undefined ? { attachments: loadedAttachments } : {}),
      ...(promptOverrides?.base.overridden === true ? { baseSystemOverride: promptOverrides.base.text } : {}),
      ...(promptOverrides?.child.overridden === true ? { childSystemOverride: promptOverrides.child.text } : {}),
      ...(scope?.childOf !== undefined
        ? {
          child: { definition: scope.childOf.definition, instructions: scope.childOf.instructions },
          ...(scope.childOf.definitionSource !== undefined ? { childSource: scope.childOf.definitionSource } : {}),
        }
        : {}),
      ...(scope?.childOf?.inheritedContext !== undefined ? { inheritedContext: scope.childOf.inheritedContext } : {}),
      ...(scope?.childOf === undefined && scope?.role !== undefined
        ? { rootRole: { definition: scope.role.definition, instructions: scope.role.instructions, ...(scope.role.definitionSource !== undefined ? { source: scope.role.definitionSource } : {}) } }
        : {}),
    })
    if (scope !== undefined) {
      lastManifests.set(scope.sessionId, assembled.manifest)
      if (scope.turnId !== undefined) manifestTurns.set(scope.sessionId, scope.turnId)
      // This manifest describes the request about to run, not the previous
      // one. Drop its prompt count until `llm/stream` reports the new usage;
      // the running cache totals stay, because they are session-scoped.
      const usage = sessionUsage.get(scope.sessionId)
      if (usage !== undefined) {
        const { last: _stale, ...totals } = usage
        void _stale
        sessionUsage.set(scope.sessionId, totals)
      }
      // The trajectory reads WHEN context was injected and WHAT it carried:
      // one durable record per request, between `step/start` and the step's
      // answer. It rides the step's existing durability barriers — no extra
      // flush, and a crash that loses it loses the answer it describes too.
      // Raw section bodies ride alongside, deduped by content hash: the first
      // request that carries a given text records it once, later steps with
      // the same text record nothing.
      if (scope.turnId !== undefined && session !== undefined) {
        const seen = contextBodiesFor(scope.sessionId)
        for (const section of assembled.sections) {
          if (seen.has(section.hash)) continue
          seen.add(section.hash)
          session.append({
            type: 'context/body',
            hash: section.hash,
            kind: section.kind,
            ...(section.name !== undefined ? { name: section.name } : {}),
            chars: section.chars,
            body: section.content,
          })
        }
        session.append({ type: 'context/manifest', turnId: scope.turnId, manifest: assembled.manifest })
      }
    }
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
    const stamped = {
      ...request,
      ...(model !== undefined ? { model } : {}),
      ...(provider !== undefined ? { providerName: provider } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    }
    const visionOverride = model !== undefined && provider !== undefined
      ? list.find((entry) => entry.id === provider)?.modelSettings?.[model]?.vision
      : undefined
    return next(adaptRequestVision(stamped, supportsNativeVision(model, visionOverride)))
  })

  const pending = new Map<string, PendingApproval>()

  const dangerousStore = new DangerousCommandsStore(resourceHome)
  const dangerousGuard = attachDangerousCommandGuard(kernel.ctx, {
    configSource: async (workspaceId?: string) => {
      const wid = workspaceId
        ?? (agentScope.getStore()?.workspaceId as string | undefined)
        ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE) as string
      const { config, hash } = await dangerousStore.load(wid)
      return { config, hash, revision: hash }
    },
  })

  // Out-of-grant file paths: classified last in the rewrite chain (after
  // hooks), forced to an approval unless the executing mode allows them.
  const pathScope = attachPathScopeGuard(kernel.ctx, {
    proposeGrant: async (folder) => {
      const scope = agentScope.getStore()
      if (scope?.projectId === undefined) return undefined
      try {
        return await validateGrantFolder(folder, workspaces.getProject(scope.projectId, scope.workspaceId).path, grantPolicy)
      } catch {
        return undefined
      }
    },
  })
  const currentOutsideRequirement = (match: PathScopeMatch, outOfGrant: 'allow' | 'ask' | undefined): boolean => {
    if (options.yolo === true || outOfGrant === 'allow') return false
    if (match.projectId === undefined || match.sessionId === undefined) return true
    const current = match.parentSessionId === undefined
      ? effectiveGrants(match.sessionId as SessionId, match.projectId as ProjectId, match.workspaceId as WorkspaceId | undefined)
      : intersectGrants(
        match.grantSnapshot ?? [],
        effectiveGrants(match.parentSessionId as SessionId, match.projectId as ProjectId, match.workspaceId as WorkspaceId | undefined),
      )
    return classifyTarget({
      root: workspaces.getProject(match.projectId as ProjectId, match.workspaceId as WorkspaceId | undefined).path,
      ...(current.length > 0 ? { additionalRoots: current } : {}),
      ...(deniedRoots !== undefined ? { deniedRoots } : {}),
    }, match.path, match.intent).kind === 'out-of-grant'
  }
  const scopeWarningOf = (match: PathScopeMatch): string =>
    `Outside granted folders: ${match.path} (${match.intent === 'write' ? 'write' : 'read'})`
  kernel.ctx.tools.setAuthorityRetirer((executionId) => {
    approvalReceipts.retire(executionId)
    dangerousGuard.retire(executionId)
    pathScope.retire(executionId)
  })
  // After authorization settles: drop the match; on allow, authorize exactly
  // that path for this call, and grant the folder to the session first when
  // the approver chose "allow for this session".
  kernel.ctx.tools.setApprovedPathResolver(async (call, allowed, exec) => {
    const scope = agentScope.getStore()
    const match = pathScope.take(exec?.executionId ?? scope?.sessionId, call, allowed)
    if (match === undefined) return undefined
    return [approvedPathOf(match)]
  })

  const hostAuthority = async (call: ToolCall, scope: ApprovalScope): Promise<AuthorityDecision> => {
    if (scope.workspaceId === undefined || scope.sessionId === undefined || scope.rootSessionId === undefined || scope.executionId === undefined) {
      return { kind: 'deny', reason: 'required host execution authority scope is missing' }
    }
    const workspaceId = scope.workspaceId
    const sessionId = scope.sessionId
    const rootSessionId = scope.rootSessionId
    const executionId = scope.executionId
    const exposureScope = { ...agentScope.getStore(), workspaceId, sessionId, rootSessionId }
    try {
      return await executionAuthority.stableModeRead(exposureScope, workspaceId, async (mode, revision) => {
        const hardDenial = call.name.startsWith('mcp__') && mcpDisabledForTurn(agentScope.getStore())
          ? 'MCP is unavailable for this Turn because its workspace configuration could not be loaded'
          : await executionAuthority.refusal(exposureScope, call.name)
        const policy = effectivePolicy(mode.permissionDefaults ?? {}, options.yolo === true)
        const normalPermission = resolvePermission(policy, call.name, { defaultMode: options.defaultMode ?? 'ask' })
        const grant = agentScope.getStore() !== undefined ? kernel.ctx.tools.currentGrant() : undefined
        const target = (call.name === 'Write' || call.name === 'Edit') && typeof call.args['path'] === 'string' ? call.args['path'] : undefined
        const memoryWrite = target !== undefined && grant !== undefined && grant.memoryRoots?.some((root) => within(root, path.resolve(grant.root, target))) === true
          && classifyTarget(grant, target, 'write').kind === 'in-grant'
        // Only an `ask` becomes allow for a memory path; `classifyTarget` +
        // `resolveInGrants` restrict that path to `.md` files outside
        // `.git`/`.env`/`secrets`/`skills`/`agents`/`commands`. A deny —
        // exact, legacy-named, or via `*` — already resolved to `deny` in
        // `normalPermission` (canonical lookup), so it can never be lifted.
        const permission = memoryWrite && normalPermission === 'ask' ? 'allow' : normalPermission
        const requirements: AskRequirement[] = []
        if (permission === 'ask') requirements.push({ kind: 'tool-policy', subjectFingerprint: createHash('sha256').update(`${call.name}:ask`).digest('hex') })
        const outside = pathScope.get(executionId, call)
        if (outside !== undefined && currentOutsideRequirement(outside, mode.outOfGrant)) requirements.push({ kind: 'outside-path', subjectFingerprint: createHash('sha256').update(`${outside.path}:${outside.intent}`).digest('hex') })
        const guardEvaluation = await dangerousGuard.evaluate(call, workspaceId, {
          workspaceId,
          sessionId,
          rootSessionId,
          executionId,
          root: '',
        })
        const guard = guardEvaluation.match
        const guardDenial = guard?.action === 'deny'
          ? `blocked by Dangerous Commands: matched ${guard.presetId ?? guard.ruleId ?? 'rule'} — ${guard.reason}`
          : undefined
        if (guard?.action === 'ask') requirements.push({
          kind: 'dangerous-command',
          // Bound to the matched rule/preset identity (id + action + pattern
          // hash), not the whole config: an unrelated guard edit must not
          // invalidate a pending question, while a change to this rule does.
          subjectFingerprint: guardMatchFingerprint(guard),
        })
        if (toolRequiresInteraction(call, workspaceId as WorkspaceId, mcpDescriptors)) requirements.push({ kind: 'interaction', subjectFingerprint: createHash('sha256').update(`${workspaceId}:${call.name}:interaction`).digest('hex') })
        const currentHardDenial = hardDenial ?? guardDenial
        return composeAuthority({
          permission,
          ...(currentHardDenial !== undefined ? { hardDenial: currentHardDenial } : {}),
          requirements,
          scopeMode: 'host',
          facts: {
            workspaceId,
            rootSessionId,
            sessionId,
            executionId,
            callFingerprint: approvalCallFingerprint(call),
            modeRevision: revision,
            guardRevision: guardEvaluation.revision,
            guardHash: guardEvaluation.hash,
          },
        })
      })
    } catch (error) {
      return { kind: 'deny', reason: String(error instanceof Error ? error.message : error) }
    }
  }

  const approvalHandle: ApprovalHandle = attachApproval(kernel.ctx, {
    authorityResolver: hostAuthority,
    receiptRegistry: approvalReceipts,
    defaultMode: options.defaultMode ?? 'ask',
    expiryMs: limits.approvalExpiryMs,
    // The scope is the call's own (stamped on re-evaluation), never whatever
    // happens to be ambient when a settings change re-checks pending asks.
    forceAsk: (call, scope) => {
      const outside = pathScope.get(scope.executionId ?? scope.sessionId, call)
      const mode = scope.workspaceId !== undefined ? rootModeOf({
        sessionId: scope.sessionId as SessionId,
        ...(scope.rootSessionId !== undefined ? { rootSessionId: scope.rootSessionId as SessionId } : {}),
        workspaceId: scope.workspaceId as WorkspaceId,
      }, scope.workspaceId as WorkspaceId).mode.definition : undefined
      return (outside !== undefined && currentOutsideRequirement(outside, mode?.outOfGrant)) ||
        toolRequiresInteraction(call, scope.workspaceId as WorkspaceId | undefined, mcpDescriptors) ||
        // A PreToolUse hook answered `permissionDecision: "ask"`.
        hookAskCalls.has(hookAskKey(scope.executionId ?? scope.sessionId, call)) ||
        // Writing hook configuration changes which shell commands run next:
        // always a human decision, whatever the mode allows for edits.
        writesHookConfig(call)
    },
    requestDetails: (call, scope) => {
      const outside = pathScope.get(scope?.executionId ?? agentScope.getStore()?.sessionId, call)
      if (outside === undefined) return undefined
      return {
        scopeWarning: scopeWarningOf(outside),
        ...(outside.proposedGrant !== undefined ? { proposedGrant: outside.proposedGrant, proposedAccess: outside.intent } : {}),
      }
    },
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
        const guardMatch = dangerousGuard.getMatch(call, lifecycle.executionId)
        const guardWarning = guardMatch?.action === 'ask'
          ? `Dangerous Commands: matched ${guardMatch.presetId ?? guardMatch.ruleId ?? 'rule'} — ${guardMatch.reason}`
          : undefined
        const workspaceId = (scope.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)) as WorkspaceId
        const interactive = toolRequiresInteraction(call, scope.workspaceId, mcpDescriptors)
        const parentSessionId = scope.childOf?.parentSessionId
        const definitionName = scope.childOf?.definition
        const principalId = sessionPrincipals.get(scope.sessionId)
        const outside = pathScope.get(lifecycle.executionId ?? scope.sessionId, call)
        const scopeWarning = outside !== undefined && currentOutsideRequirement(outside, executingMode().mode.definition.outOfGrant) ? scopeWarningOf(outside) : undefined
        const proposedGrant = scopeWarning !== undefined ? outside?.proposedGrant : undefined
        const proposedAccess = proposedGrant !== undefined ? outside?.intent : undefined
        pending.set(approvalId, {
          sessionId: scope.sessionId,
          ...(lifecycle.executionId !== undefined ? { executionId: lifecycle.executionId } : {}),
          workspaceId,
          ...(principalId !== undefined ? { principalId } : {}),
          call,
          interactive,
          expiresAt: lifecycle.expiresAt,
          ...(parentSessionId !== undefined ? { parentSessionId } : {}),
          ...(definitionName !== undefined ? { definitionName } : {}),
          ...(guardWarning !== undefined ? { guardWarning } : {}),
          ...(scopeWarning !== undefined ? { scopeWarning } : {}),
          ...(proposedGrant !== undefined ? { proposedGrant } : {}),
          ...(proposedAccess !== undefined ? { proposedAccess } : {}),
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
          ...(scopeWarning !== undefined ? { scopeWarning } : {}),
          ...(proposedGrant !== undefined ? { proposedGrant } : {}),
          ...(proposedAccess !== undefined ? { proposedAccess } : {}),
        })
        // Claude Notification hook: a permission prompt is waiting. Fire and
        // forget — a notification never gates the approval.
        void hookHost.fire('Notification', {
          workspaceId,
          projectId: scope.projectId,
          sessionId: scope.sessionId,
          rootSessionId: scope.rootSessionId ?? scope.sessionId,
          matchValue: 'permission_prompt',
          input: { message: `Claude needs your permission to use ${call.name}`, notification_type: 'permission_prompt' },
        }).catch(() => undefined)
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
    derive: (current: { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases: readonly ModelAlias[]; readonly aliasGeneration: number }) => { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases?: readonly ModelAlias[]; readonly aliasGeneration?: number; readonly result: T } | Promise<{ readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases?: readonly ModelAlias[]; readonly aliasGeneration?: number; readonly result: T }>,
    transactionOptions?: { readonly clearRuntimeModelOverride?: boolean },
  ): Promise<T> => {
    let release: (() => void) | undefined
    const predecessor = providerTransactionTail
    providerTransactionTail = new Promise<void>((resolve) => { release = resolve })
    await predecessor
    try {
      const derived = await derive({ providers: list, defaults: durableDefaults, aliases, aliasGeneration })
      const repaired = repairGlobalDefaults(derived.defaults, derived.providers)
      const nextAliases = derived.aliases ?? aliases
      const nextAliasGeneration = derived.aliasGeneration ?? aliasGeneration
      await (options.providerStoreWriter ?? saveProviderStore)(configFile, { version: 2, defaults: repaired, providers: derived.providers, aliases: nextAliases, aliasGeneration: nextAliasGeneration })
      list = [...derived.providers]
      aliases = [...nextAliases]
      aliasGeneration = nextAliasGeneration
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

  let shuttingDown = false

  // ── automations + web push ───────────────────────────────────
  // Definitions and run history live beside each workspace's data; push keys
  // and device subscriptions are host-global. Memory-mode hosts keep both in
  // memory so tests stay hermetic.
  const automations = new AutomationStore(options.home !== undefined ? (workspaceId) => workspaces.workspaceDir(workspaceId as WorkspaceId) : undefined)
  const push = new PushService(options.home !== undefined ? path.join(options.home, 'push') : undefined, options.pushSender)
  const channels = new NotifyChannels(options.home !== undefined ? path.join(options.home, 'notify') : undefined, options.channelFetch)
  /** Live runs: session id → run identity, until its first turn settles. */
  const activeRuns = new Map<SessionId, { readonly workspaceId: WorkspaceId; readonly automationId: string; readonly runId: string; readonly dueAt: number | null; readonly title: string; readonly notify: boolean; readonly targets: readonly string[] | null; notifiedWaiting: boolean }>()
  const runUrl = (workspaceId: string, sessionId: string): string => `/workspaces/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}`
  /**
   * Tell the user about a run on the automation's targets: Web Push (short
   * excerpt, opens the session) and the selected channels (fuller text).
   * `kind: 'result'` respects the notify switch; failures and waiting
   * approvals always go out, so a broken or stuck task is never silent.
   */
  const notifyRun = (run: { readonly workspaceId: string; readonly title: string; readonly runId: string; readonly notify: boolean; readonly targets: readonly string[] | null }, sessionId: string | undefined, kind: 'result' | 'alert', text: string): void => {
    if (kind === 'result' && !run.notify) return
    if (run.targets === null || run.targets.includes('push')) {
      void push.send({ title: run.title, body: excerpt(text), url: sessionId !== undefined ? runUrl(run.workspaceId, sessionId) : `/workspaces/${encodeURIComponent(run.workspaceId)}/automations`, tag: run.runId })
    }
    void channels.send({ title: run.title, body: text }, run.targets === null ? null : run.targets.filter((id) => id !== 'push'))
  }
  /**
   * Resolve a role for a root about to run as it (automations): its ceiling
   * is the mode's admission exposure ∩ the definition − disallowed, the same
   * rule a manual subagent spawn applies. A missing role throws: a run never
   * silently widens to the main agent.
   */
  const pinRole = async (workspaceId: WorkspaceId, name: string, rootId: SessionId, projectId: string | null): Promise<RoleRecord> => {
    let resolved
    try {
      resolved = await agentDefinitions.resolve(workspaceId, name, projectId ?? undefined)
    } catch (error) {
      if (error instanceof AgentDefinitionError && error.code === 'not-found') throw new Error(`agent role '${name}' no longer exists`)
      throw error
    }
    const { definition } = resolved
    // MCP tools need an explicit grant on a spawn; a role run has none, so it
    // gets MCP tools only when the role names them itself.
    const candidates = definition.tools
    const exposed = new Set(await admissionExposureCeiling(rootId, workspaceId, definition.name, candidates))
    const disallowed = new Set(definition.disallowedTools)
    const toolCeiling = [...new Set(candidates)].filter((tool) => exposed.has(tool) && !disallowed.has(tool) && tool !== 'Agent')
    return {
      definition: definition.name,
      instructions: definition.instructions,
      ...(resolved.source !== undefined ? { source: resolved.source } : {}),
      toolCeiling,
      ...(definition.skills !== undefined ? { skills: [...definition.skills] } : {}),
    }
  }
  const runAutomation = async (workspaceId: WorkspaceId, automation: Automation, dueAt: number | null): Promise<{ ok: false; status: number; error: string } | { ok: true; runId: string; sessionId?: string; skipped?: true }> => {
    const runId = `run-${randomUUID()}`
    const identity = { workspaceId, title: automation.title, runId, notify: automation.notify, targets: automation.notifyTargets }
    // Never two runs of one automation at once.
    for (const [sessionId, run] of activeRuns) {
      if (run.automationId === automation.id && sessions.get(sessionId) !== undefined) {
        await automations.record(workspaceId, { runId, automationId: automation.id, dueAt, status: 'skipped-busy', sessionId })
        return { ok: true, runId, skipped: true }
      }
    }
    const fail = async (status: number, error: string): Promise<{ ok: false; status: number; error: string }> => {
      await automations.record(workspaceId, { runId, automationId: automation.id, dueAt, status: 'failed', error })
      notifyRun(identity, undefined, 'alert', `Could not start: ${error}`)
      return { ok: false, status, error }
    }
    if (shuttingDown) return fail(503, 'host shutting down')
    let created: Awaited<ReturnType<typeof createRootSession>>
    try {
      created = await createRootSession(deps, workspaceId, {
        projectId: automation.projectId,
        ...(automation.controls !== null ? { controls: automation.controls } : {}),
        modeId: automation.modeId,
        title: runTitle(automation.title, dueAt ?? Date.now()),
        // A role run IS the role: the conversation itself runs with the
        // role's tool ceiling, instructions, skills and model.
        ...(automation.agent !== null ? { role: (rootId: SessionId) => pinRole(workspaceId, automation.agent!, rootId, automation.projectId) } : {}),
      })
    } catch (error) {
      return fail(500, String(error instanceof Error ? error.message : error))
    }
    if (!created.ok) return fail(created.status, created.error)
    const sessionId = created.entry.session.id
    activeRuns.set(sessionId, { ...identity, automationId: automation.id, dueAt, notifiedWaiting: false })
    await automations.record(workspaceId, { runId, automationId: automation.id, dueAt, status: 'started', sessionId })
    // The agent learns it runs unattended and how its reply reaches the user;
    // it joins the prompt as host context, not as user text.
    const mode = rootModeOf({ sessionId, workspaceId }, workspaceId).mode.definition
    const context = automationContext(automation, {
      dueAt,
      channels: automation.notify ? await channels.enabledNames(automation.notifyTargets).catch(() => []) : [],
      push: automation.notifyTargets === null || automation.notifyTargets.includes('push'),
      approvalsBlock: Object.values(mode.permissionDefaults ?? {}).some((value) => value === 'ask'),
    })
    created.entry.agent.inject(context)
    const submitted = await submitMessage(created.entry, deps, { content: automation.prompt, clientRequestId: runId }, undefined)
    if (!submitted.ok) {
      activeRuns.delete(sessionId)
      await automations.record(workspaceId, { runId, automationId: automation.id, dueAt, status: 'failed', sessionId, error: submitted.error })
      notifyRun(identity, sessionId, 'alert', `Could not start: ${submitted.error}`)
      return { ok: false, status: submitted.status, error: submitted.error }
    }
    return { ok: true, runId, sessionId }
  }
  // Run watcher: the first settled turn ends the run; a waiting approval or
  // question pings the user once.
  const lastTurnError = new Map<SessionId, string>()
  disposers.set('automations:session-event', kernel.ctx.on('session/event', (emitter, event) => {
    const run = activeRuns.get(emitter.id)
    if (run === undefined) return
    if (event.type === 'turn/error') {
      lastTurnError.set(emitter.id, event.message)
      return
    }
    if (event.type !== 'turn/end') return
    activeRuns.delete(emitter.id)
    const error = lastTurnError.get(emitter.id)
    lastTurnError.delete(emitter.id)
    if (event.reason === 'completed') {
      let reply = ''
      for (let index = emitter.events.length - 1; index >= 0; index -= 1) {
        const candidate = emitter.events[index]
        if (candidate?.type === 'assistant/message' && candidate.content.trim() !== '') { reply = candidate.content; break }
      }
      const summary = excerpt(reply) || 'Done.'
      void automations.record(run.workspaceId, { runId: run.runId, automationId: run.automationId, dueAt: run.dueAt, status: 'done', sessionId: emitter.id, summary })
      notifyRun(run, emitter.id, 'result', reply.trim() !== '' ? reply.trim() : 'Done.')
    } else {
      const reason = error ?? `run ended: ${event.reason}`
      void automations.record(run.workspaceId, { runId: run.runId, automationId: run.automationId, dueAt: run.dueAt, status: 'failed', sessionId: emitter.id, error: reason })
      notifyRun(run, emitter.id, 'alert', `Failed: ${reason}`)
    }
  }))
  const onWaiting = (payload: { readonly sessionId: SessionId; readonly parentSessionId?: SessionId }): void => {
    const rootId = payload.parentSessionId ?? payload.sessionId
    const run = activeRuns.get(rootId)
    if (run === undefined || run.notifiedWaiting) return
    run.notifiedWaiting = true
    void automations.record(run.workspaceId, { runId: run.runId, automationId: run.automationId, dueAt: run.dueAt, status: 'needs-approval', sessionId: rootId })
    notifyRun(run, rootId, 'alert', 'Waiting for your approval.')
  }
  // A run whose driver crashed before `turn/end` must not stay "busy" forever.
  disposers.set('automations:turn-error', kernel.ctx.on('web/turn-error', (payload) => {
    const run = activeRuns.get(payload.sessionId)
    if (run === undefined) return
    const session = sessions.get(payload.sessionId)?.session
    if (session !== undefined && !turnTerminal(session)) return // the turn/end watcher settles it
    activeRuns.delete(payload.sessionId)
    void automations.record(run.workspaceId, { runId: run.runId, automationId: run.automationId, dueAt: run.dueAt, status: 'failed', sessionId: payload.sessionId, error: payload.message })
    notifyRun(run, payload.sessionId, 'alert', `Failed: ${payload.message}`)
  }))
  disposers.set('automations:approval', kernel.ctx.on('web/approval', onWaiting))
  disposers.set('automations:question', kernel.ctx.on('web/question', onWaiting))
  const scheduler = new AutomationScheduler({
    store: automations,
    workspaces: () => options.home !== undefined ? workspaces.list().map((ws) => ws.id) : [],
    fire: async (workspaceId, automation, dueAt) => {
      const outcome = await runAutomation(workspaceId as WorkspaceId, automation, dueAt)
      return outcome.ok && outcome.skipped !== true
    },
  })

  const deps: HandlerDeps = {
    automations,
    push,
    channels,
    pokeScheduler: () => { void scheduler.poke() },
    runAutomation,
    kernel,
    sessions,
    processes,
    processReconciled: new Set<SessionId>(),
    unavailableSessions,
    pending,
    pendingQuestions,
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
    grants: { policy: grantPolicy, effective: effectiveGrants, session: sessionGrants, mutate: mutateSessionGrants },
    pathScope,
    leaseHeldInside,
    legacyFolders,
    legacyFolderDefault,
    seedWorkspaceControls,
    modes,
    skills,
    ...(options.userSkillsDir !== undefined ? { userSkillsDir: options.userSkillsDir } : {}),
    ...(options.bundledSkillsDir !== undefined ? { bundledSkillsDir: options.bundledSkillsDir } : {}),
    refreshSkillProtectedRoots,
    addSkillProtectedRoots,
    memory,
    attachments,
    imageSettings: () => imageSettings,
    setImageSettings: async (next: ImageGenerationSettings) => {
      await saveImageSettings(imageSettingsFile, next)
      imageSettings = next
    },
    imageUnderstanding: () => imageUnderstanding,
    setImageUnderstanding: async (next: ImageUnderstandingSettings) => {
      await saveImageUnderstandingSettings(imageUnderstandingFile, next)
      imageUnderstanding = next
    },
    checkpoints,
    lastManifests,
    contextBodies,
    sessionUsage,
    usageLog,
    adoptMode,
    stampRootMode,
    rootModeOf,
    admissionExposureCeiling,
    turnTerminal,
    agentDefinitions,
    childExecutor,
    childModelFor,
    summarizerModelOf,
    runPreCompactHooks,
    hookHost,
    runCompaction,
    cancelCompaction,
    compactionPending: (sessionId) => compactions.has(sessionId),
    settleCompaction: async (sessionId) => { await compactions.get(sessionId)?.done?.catch(() => {}) },
    mcpStore,
    mcpClients,
    mcpDescriptors,
    mcpConnecting,
    mcpCancelled,
    mcpConnectFailures,
    connectWorkspaceMcp,
    cancelMcpConnection,
    ensureMcpServer,
    dangerousStore,
    systemPrompts,
    providers: () => list,
    roleModelOf: (definitionModel) => describeRoleModel(definitionModel, {
      parent: { provider: defaults.provider, model: defaults.model },
      providers: usableIds(),
      modelsOf: (provider) => kernel.ctx.llm.providerModels(provider),
      validate: (provider, model) => { validateProviderModel(provider, model) },
      alias: (name) => aliases.find((entry) => entry.name === name),
    }),
    aliases: () => aliases,
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
    updateMcpConfig,
    updateMcpSecrets,
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
      // A faulted journal is reopened from disk: a transient fault (a full
      // disk, a permission since fixed) recovers once the file validates,
      // while a genuinely corrupt file still fails its checks and stays blocked.
      if (journals.get(workspaceId)?.faulted === true) {
        journals.delete(workspaceId)
        try {
          await journalFor(workspaceId)
        } catch (error) {
          return { ok: false as const, error: `execution journal is still faulted (${error instanceof Error ? error.message : String(error)}); repair the file before clearing the audit block` }
        }
      }
      await clearAuditFault(auditFaultFile)
      return { ok: true as const }
    },
  }
  depsRef.current = deps

  // Rebuild and migrate canonical root logs before accepting any request.
  // A workspace default is only an input for roots lacking a mode snapshot;
  // after this point each root owns its own live selection.
  if (options.home !== undefined) {
    await kernel.ctx.sessions.boot()
    const migrated = await migrateRootModes(options.home, kernel.ctx.sessions, modes, (workspaceId) => controlsFor(workspaceId).modeDefinition)
    if (migrated.migrated > 0) console.log(`web: migrated ${migrated.migrated} root mode snapshot(s)`)
    const recovered = await childExecutor.recoverFromStorage()
    if (recovered > 0) console.log(`web: recovered ${recovered} child relationship(s) from storage`)
  }

  const server = createServer((req, res) => {
    if (shuttingDown) { res.writeHead(503); res.end('host shutting down'); return }
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

  const publicHost = options.host ?? '127.0.0.1'
  deps.auth.bindOrigin(`http://${publicHost}:${address.port}`)
  const retireOperatorChannel = deps.auth.enabled && options.home !== undefined
    ? await publishOperatorChannel(options.home, { url: `http://${publicHost}:${address.port}`, key: deps.auth.armOperatorKey() })
    : undefined

  // Automations fire only once the host is fully up (sessions rebuilt, port bound).
  if (options.home !== undefined && options.automations?.scheduler !== false) void scheduler.start()

  let closePromise: Promise<void> | undefined
  return {
    url: `http://${publicHost}:${address.port}`,
    port: address.port,
    kernel,
    auth: deps.auth,
    close: () => closePromise ??= (async () => {
      shuttingDown = true
      scheduler.stop()
      compactionClosing = true
      for (const sessionId of compactions.keys()) cancelCompaction(sessionId)
      processes.closeAdmission()
      kernel.ctx.agents.closeAdmission()
      for (const entry of sessions.values()) entry.agent.stop()
      mcpHostClosing = true
      const agentDrivers = kernel.ctx.agents
      let teardownSafe = true
      await runCleanup([
        async () => { await retireOperatorChannel?.() },
        async () => {
          for (const key of mcpConnecting.keys()) mcpCancelled.add(key)
          await Promise.allSettled([...mcpConnecting.values()])
        },
        () => { server.closeAllConnections(); terminals.disposeAll() },
        () => agentDrivers.stopAll(),
        async () => { await boundedCleanup(async () => { await Promise.allSettled([...compactions.values()].flatMap((reservation) => reservation.done === undefined ? [] : [reservation.done])) }) },
        () => processes.disposeAll(),
        async () => { try { await boundedCleanup(() => checkpoints.close()) } catch (error) { teardownSafe = false; throw error } },
        async () => { try { await boundedCleanup(() => processEvents.flushAll()) } catch (error) { teardownSafe = false; throw error } },
        async () => { await boundedCleanup(() => usageLog.flush()) },
        async () => { await boundedCleanup(() => automations.flush()) },
        () => new Promise<void>((resolve, reject) => server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve())),
        async () => {
          const results = await Promise.allSettled([...mcpClients.values()].map(client => client.disconnect()))
          mcpClients.clear()
          const errors = results.filter(result => result.status === 'rejected')
          if (errors.length) throw new AggregateError(errors, 'MCP teardown failed')
        },
        () => {
          const errors: unknown[] = []
          for (const dispose of disposers.values()) { try { dispose() } catch (error) { errors.push(error) } }
          disposers.clear()
          if (errors.length) throw new AggregateError(errors, 'listener teardown failed')
        },
        async () => { try { await boundedCleanup(() => kernel.stop()) } catch (error) { teardownSafe = false; throw error } },
        () => { if (!teardownSafe || !agentDrivers.persistenceSafe) throw new Error('ownership retained: canonical writers unresolved'); return ownerLock.release() },
      ])
    })(),
  }
}

/** A config save whose `expectedRevision` no longer matches the file it would replace. */
class McpRevisionConflict extends Error {
  constructor() {
    super('mcp.json changed since it was loaded')
    this.name = 'McpRevisionConflict'
  }
}

interface HandlerDeps {
  readonly kernel: Kernel
  readonly sessions: Map<SessionId, SessionEntry>
  /** Host-owned background-process registry (see the bridge near tool registration). */
  readonly processes: ProcessRegistry
  /** Sessions whose event log was already scanned for restart-interrupted processes. */
  readonly processReconciled: Set<SessionId>
  readonly unavailableSessions: Set<SessionId>
  readonly pending: Map<string, PendingApproval>
  /** Live AskUserQuestion waiters, answered by `POST /api/questions/:id`. */
  readonly pendingQuestions: Map<string, PendingQuestion>
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
  /** Pending out-of-grant matches, for session-scoped approval answers. */
  readonly pathScope: PathScopeGuard
  /** True while any turn holds a write lease inside `folder`. */
  readonly leaseHeldInside: (folder: string) => boolean
  /** Extra file-tool folders: effective view, validation policy, serialized session edits. */
  readonly grants: {
    readonly policy: GrantPolicy
    readonly effective: (sessionId: SessionId, projectId: ProjectId | undefined, workspaceId: WorkspaceId | undefined) => GrantedRoot[]
    readonly session: (session: Session) => SessionGrants
    readonly mutate: (
      session: Session,
      derive: (current: SessionGrants) => readonly SessionGrant[] | Promise<readonly SessionGrant[]>,
      approvalId?: string,
    ) => Promise<SessionGrants>
  }
  readonly legacyFolders: Map<SessionId, string | undefined>
  readonly legacyFolderDefault: { current: string | undefined }
  readonly modes: ModesService
  readonly skills: SkillsService
  /** Read-only user skill layer (`~/.claude/skills`), for protected-root refresh. */
  readonly userSkillsDir?: string
  /** Read-only bundled skill layer, for protected-root refresh. */
  readonly bundledSkillsDir?: string
  /** Recompute grant-protected roots from every workspace's skill rules. */
  readonly refreshSkillProtectedRoots: () => Promise<void>
  /** Fail-closed fallback when a recompute fails: add roots, never drop any. */
  readonly addSkillProtectedRoots: (roots: readonly string[]) => void
  readonly memory: MemoryService
  readonly attachments: AttachmentStore
  readonly checkpoints: CheckpointStore
  readonly lastManifests: Map<SessionId, ContextManifest>
  /** Context section hashes already recorded per session's log (body dedupe). */
  readonly contextBodies: Map<SessionId, Set<string>>
  readonly sessionUsage: Map<SessionId, SessionUsage>
  readonly adoptMode: (workspaceId: WorkspaceId, modeId: string) => Promise<ResolvedMode>
  readonly stampRootMode: (session: Session, resolved: ResolvedMode) => Extract<SessionEvent, { type: 'session/mode' }>
  readonly rootModeOf: (scope: { readonly sessionId: SessionId; readonly rootSessionId?: SessionId }, workspaceId: WorkspaceId) => { mode: ResolvedMode; revision: number }
  readonly admissionExposureCeiling: (rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[]) => Promise<readonly string[]>
  /** Whether the root's latest durable turn is terminal; admission reads this because `agent.busy` lags the durable append. */
  readonly turnTerminal: (session: Session) => boolean
  readonly agentDefinitions: AgentDefinitionService
  readonly childExecutor: ChildExecutor
  /** Resolves a child's pair: spawn choice > role definition > parent session. */
  readonly childModelFor: (
    parent: Session,
    workspaceId: WorkspaceId,
    requested?: string,
    definitionModel?: string,
  ) => ChildModel | undefined
  /** Display-only: what a role's `model:` resolves to on this host (aliases mapped). */
  readonly roleModelOf: (definitionModel: string | undefined) => ReturnType<typeof describeRoleModel>
  /** The (provider, model) pair host-side maintenance calls run on; undefined → extractive compaction fallback. */
  /** Durable token accounting behind GET /api/usage. */
  readonly usageLog: UsageLog
  /** Settings → Providers & Models → Image generation (app-wide provider/model reference). */
  readonly imageSettings: () => ImageGenerationSettings
  readonly setImageSettings: (next: ImageGenerationSettings) => Promise<void>
  /** Settings → Providers & Models → Image understanding (DescribeImage model). */
  readonly imageUnderstanding: () => ImageUnderstandingSettings
  readonly setImageUnderstanding: (next: ImageUnderstandingSettings) => Promise<void>
  readonly summarizerModelOf: (session: Session) => { readonly providerName: string; readonly model: string } | undefined
  /** Runs PreCompact hooks (durable hook/run events); returns the blocking reason, or undefined to proceed. */
  readonly runPreCompactHooks: (session: Session, workspaceId: WorkspaceId) => Promise<string | undefined>
  readonly hookHost: HookHost
  readonly runCompaction: (entry: SessionEntry, trigger: 'manual' | 'automatic') => Promise<{ coversSeq: number; summary: string }>
  readonly cancelCompaction: (sessionId: SessionId) => void
  readonly compactionPending: (sessionId: SessionId) => boolean
  readonly settleCompaction: (sessionId: SessionId) => Promise<void>
  readonly mcpStore: McpConfigStore
  readonly mcpClients: Map<string, McpServerClient>
  readonly mcpDescriptors: Map<string, McpToolDescriptor>
  readonly mcpConnecting: Map<string, Promise<McpServerClient>>
  readonly mcpCancelled: Set<string>
  readonly mcpConnectFailures: ReadonlyMap<string, { readonly at: number; readonly message: string }>
  readonly connectWorkspaceMcp: (workspaceId: WorkspaceId) => Promise<void>
  readonly cancelMcpConnection: (workspaceId: WorkspaceId, serverName: string) => Promise<void>
  readonly ensureMcpServer: (workspaceId: WorkspaceId, serverName: string) => Promise<McpServerClient>
  readonly dangerousStore: DangerousCommandsStore
  readonly systemPrompts: SystemPromptsStore
  readonly seedWorkspaceControls: (workspaceId: WorkspaceId, seed?: { provider?: string; model?: string }) => void
  readonly providers: () => readonly ProviderConfig[]
  readonly aliases: () => readonly ModelAlias[]
  readonly defaults: () => ModelDefaults
  readonly setDefaults: (next: ModelDefaults) => void
  readonly mutateProviderStore: <T>(derive: (current: { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases: readonly ModelAlias[]; readonly aliasGeneration: number }) => { readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases?: readonly ModelAlias[]; readonly aliasGeneration?: number; readonly result: T } | Promise<{ readonly providers: readonly ProviderConfig[]; readonly defaults: ModelDefaults; readonly aliases?: readonly ModelAlias[]; readonly aliasGeneration?: number; readonly result: T }>, options?: { readonly clearRuntimeModelOverride?: boolean }) => Promise<T>
  readonly publicSummary: () => readonly PublicProvider[]
  readonly terminals: TerminalService
  readonly terminalsEnabled: boolean
  readonly terminalsLoopback: boolean
  readonly terminalDefaultCwd: string
  readonly allowedHosts: ReadonlySet<string>
  readonly auth: ControlPlaneAuthService
  /** Serialized per workspace; `transform` sees the current config and may throw to refuse. */
  readonly updateMcpConfig: (workspaceId: WorkspaceId, transform: (current: McpConfig) => McpConfig) => Promise<McpConfig>
  readonly updateMcpSecrets: (workspaceId: WorkspaceId, transform: (secrets: Record<string, string>) => void) => Promise<void>
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
  readonly automations: AutomationStore
  readonly push: PushService
  readonly channels: NotifyChannels
  /** Re-plan the scheduler after a definition changed. */
  readonly pokeScheduler: () => void
  /** Start one automation run now (`dueAt` null = Run now). */
  readonly runAutomation: (workspaceId: WorkspaceId, automation: Automation, dueAt: number | null) => Promise<{ ok: false; status: number; error: string } | { ok: true; runId: string; sessionId?: string; skipped?: true }>
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

/** Ordered skill layers for a scope: workspace rules + the bound project's folder.
 *  Module-level so both the agent/context handler and the API routes resolve the
 *  same way; throws when the projectId is not a project of the workspace. */
async function skillLayers(
  skills: SkillsService,
  workspaces: WorkspaceService,
  workspaceId: WorkspaceId,
  projectId: ProjectId | undefined,
): Promise<SkillLayer[]> {
  const rules = await skills.sources(workspaceId)
  let projectPath: string | undefined
  if (projectId !== undefined) projectPath = workspaces.getProject(projectId, workspaceId).path
  const layers = resolveSkillLayers(rules, { workspaceDir: skills.workspaceSkillsDir(workspaceId), ...(projectPath !== undefined ? { projectPath } : {}) })
  // Bundled rides last: every rule layer shadows it, and it stays scannable
  // even under a custom rule list (which never names it).
  const bundled = skills.bundledLayer()
  return bundled !== undefined ? [...layers, bundled] : layers
}

/** Route helper: layers for an optional `?projectId=`; undefined (after a 400) when the id is unknown. */
async function skillLayersForQuery(
  deps: Pick<HandlerDeps, 'skills' | 'workspaces'>,
  wsId: WorkspaceId,
  query: URLSearchParams,
  send: (status: number, body: unknown) => void,
): Promise<SkillLayer[] | undefined> {
  const rawProject = query.get('projectId')
  try {
    return await skillLayers(deps.skills, deps.workspaces, wsId, rawProject !== null && rawProject !== '' ? (rawProject as ProjectId) : undefined)
  } catch {
    send(400, { error: 'unknown projectId' })
    return undefined
  }
}

/**
 * Why a just-saved workspace skill may not be what sessions see: the
 * workspace rule is disabled/removed, or a higher layer (a project folder,
 * or an absolute rule ordered above workspace) owns the same name. Saving
 * still succeeds — the warnings make the shadowing visible instead of silent.
 */
async function workspaceSaveWarnings(deps: Pick<HandlerDeps, 'skills' | 'workspaces'>, wsId: WorkspaceId, name: string): Promise<string[]> {
  const warnings: string[] = []
  const rules = await deps.skills.sources(wsId)
  if (!rules.some((rule) => rule.kind === 'workspace' && rule.enabled)) {
    warnings.push('The workspace skill folder is disabled in Source folders, so sessions will not see this skill.')
    return warnings
  }
  const owner = await deps.skills.ownerLayer(await skillLayers(deps.skills, deps.workspaces, wsId, undefined), name)
  if (owner !== undefined && owner.source !== 'workspace') {
    warnings.push(`A ${owner.source} skill with this name (${owner.base}) is ordered above the workspace folder and wins.`)
  }
  const shadowedIn: string[] = []
  for (const project of deps.workspaces.listProjects(wsId)) {
    const layers = await skillLayers(deps.skills, deps.workspaces, wsId, project.id).catch(() => [] as SkillLayer[])
    const projectOwner = await deps.skills.ownerLayer(layers, name).catch(() => undefined)
    if (projectOwner !== undefined && projectOwner.source === 'project') shadowedIn.push(project.name)
  }
  if (shadowedIn.length > 0) {
    warnings.push(`Project folders define the same name and win in their sessions: ${shadowedIn.join(', ')}.`)
  }
  return warnings
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {  const url = new URL(req.url ?? '/', 'http://localhost')
  const { pathname } = url

  // Clickjacking defence: no other page may frame this UI (approvals and the
  // terminal are one click away). The client itself never uses frames.
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('content-security-policy', "frame-ancestors 'none'")
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')

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

  if (pathname === '/api/health' || pathname === '/api/auth/state' || pathname === '/api/auth/pair' || pathname === '/api/auth/pairing-code' || pathname === '/api/auth/logout') {
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
      // A dead session's cookie is cleared with the refusal: pairing refuses
      // any request that still carries one, so leaving it would lock the
      // browser out of pairing again.
      const clear = decision.status === 401 && readSessionCookie(req.headers.cookie) !== undefined
      res.writeHead(decision.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(clear ? { 'set-cookie': CLEARED_SESSION_COOKIE } : {}) })
      res.end(JSON.stringify({ error: decision.reason }))
      return
    }
    if (decision.principal.kind === 'bearer' && !bearerAllows(pathname, decision.principal.scopes)) {
      res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'bearer token does not include this scope' }))
      return
    }
    ;(req as IncomingMessage & { dntHarnessPrincipalId?: string; dntHarnessGeneration?: number }).dntHarnessPrincipalId = decision.principal.id
    ;(req as IncomingMessage & { dntHarnessGeneration?: number }).dntHarnessGeneration = decision.principal.generation
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
    await serveStatic(res, pathname, deps.staticDir, req.headers['accept-encoding'])
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
    send(200, 'Authorization code received. Return to dnt-harness and finish connecting the server.')
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
    if (!deps.auth.enabled) {
      send(200, { required: false, paired: true })
      return
    }
    // Per browser: only this request's own session counts. A valid session
    // hands back its CSRF token so a reloaded page can mutate again; a stale
    // cookie is cleared, because pairing refuses any request carrying one.
    const decision = deps.auth.authenticate(req.headers, 'GET')
    if (decision.ok && decision.principal.kind === 'browser') {
      send(200, { required: true, paired: true, ...(decision.csrf !== undefined ? { csrf: decision.csrf } : {}) })
      return
    }
    const staleCookie = readSessionCookie(req.headers.cookie) !== undefined
    send(200, { required: true, paired: false }, staleCookie ? { 'set-cookie': CLEARED_SESSION_COOKIE } : undefined)
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
  if (pathname === '/api/auth/pairing-code' && req.method === 'POST') {
    // Operator recovery: minting a code needs the key from the data home's
    // operator file, never a browser session or a bearer.
    const presented = req.headers[OPERATOR_HEADER]
    if (!deps.auth.enabled || typeof presented !== 'string' || !deps.auth.operatorKeyMatches(presented)) {
      send(403, { error: 'operator key rejected' })
      return
    }
    const issued = deps.auth.issuePairingCode()
    send(200, { code: issued.code, expiresAt: issued.expiresAt })
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
    for (const waiting of [...deps.pendingQuestions.values()]) {
      if (waiting.principalId === decision.principal.id) waiting.settle({ kind: 'declined', reason: 'the user signed out' })
    }
    send(200, { revoked: true }, { 'set-cookie': CLEARED_SESSION_COOKIE })
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
        : error.code === 'root-invalid' ? 400
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
          for (const waiting of deps.pendingQuestions.values()) {
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
        send(200, listSessions(wsId, deps, await deps.automations.runSessions(wsId).catch(() => new Map<string, string>())))
        return
      }
      if (req.method === 'POST') {
        deps.workspaces.requireActive(wsId) // archived: no new sessions
        const body = await readJson(req)
        const created = await createRootSession(deps, wsId, { projectId: body['projectId'], controls: body['controls'] })
        if (!created.ok) {
          send(created.status, { error: created.error })
          return
        }
        send(201, { id: created.entry.session.id, workspaceId: wsId, ...(created.entry.projectId !== undefined ? { projectId: created.entry.projectId } : {}) })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Session folder grants: the composer's "+ folders". Browser-only when
    // auth is on — a grant is a standing pre-approval, so it is held to the
    // same principal rule as answering an approval.
    const wsSessionGrantsMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/grants$/.exec(pathname)
    if (wsSessionGrantsMatch !== null) {
      const wsId = decodeURIComponent(wsSessionGrantsMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsSessionGrantsMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      if (req.method === 'GET') {
        send(200, { ...deps.grants.session(entry.session), effective: deps.grants.effective(entry.session.id, entry.projectId, wsId) })
        return
      }
      if (req.method !== 'PUT') {
        send(405, { error: 'method not allowed' })
        return
      }
      if (!browserPrincipal(req, deps, 'PUT')) {
        send(401, { error: 'folder grants can only be changed from the browser session that owns the workspace' })
        return
      }
      try {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        if (typeof body['expectedRevision'] !== 'number' || !Array.isArray(body['roots'])) {
          send(400, { error: 'body needs expectedRevision (number) and roots (array)' })
          return
        }
        if (entry.projectId === undefined) {
          send(409, { error: 'bind a project to this conversation before granting extra folders' })
          return
        }
        if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
          send(409, { error: "a child agent's folders are fixed at spawn; change the parent conversation's folders instead" })
          return
        }
        const primary = deps.workspaces.getProject(entry.projectId, wsId).path
        const requested = body['roots'] as unknown[]
        const expected = body['expectedRevision']
        const next = await deps.grants.mutate(entry.session, async (current) => {
          if (current.revision !== expected) throw new StaleGrantsError(current.revision)
          const roots: SessionGrant[] = []
          for (const raw of requested) {
            const item = (raw ?? {}) as Record<string, unknown>
            roots.push({ path: await validateGrantFolder(item['path'], primary, deps.grants.policy), access: parseAccess(item['access']) })
          }
          return mergeGrants(roots)
        })
        send(200, { ...next, effective: deps.grants.effective(entry.session.id, entry.projectId, wsId) })
      } catch (error) {
        if (error instanceof StaleGrantsError) {
          send(409, { error: 'folder grants changed since they were loaded; reload and retry', revision: error.revision })
          return
        }
        fail(error)
      }
      return
    }

    // ── background processes of one session ────────────────────
    const wsProcessesMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/processes(?:\/([^/]+)(?:\/(stop))?)?$/.exec(pathname)
    if (wsProcessesMatch !== null) {
      const wsId = decodeURIComponent(wsProcessesMatch[1] ?? '') as WorkspaceId
      const processId = wsProcessesMatch[3] !== undefined ? decodeURIComponent(wsProcessesMatch[3] ?? '') : undefined
      const action = wsProcessesMatch[4]
      const entry = await findSession(decodeURIComponent(wsProcessesMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      if (deps.unavailableSessions.has(entry.session.id)) {
        send(503, { error: 'session unavailable after durable storage failure; restart the host to reload canonical history' })
        return
      }
      if (processId === undefined) {
        // Live reconciliation for the panel: event-derived state is the
        // source of truth; this snapshot corrects stale SSE-gap state.
        if (req.method === 'GET') {
          send(200, deps.processes.snapshot(entry.session.id))
          return
        }
        send(405, { error: 'method not allowed' })
        return
      }
      if (action === 'stop') {
        if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
        const outcome = await deps.processes.kill(entry.session.id, processId)
        if (outcome.outcome === 'not-found') {
          send(404, { error: `no such process '${processId}'` })
          return
        }
        if (outcome.outcome === 'already-ended') {
          send(409, { error: `process '${processId}' already ended`, status: outcome.status })
          return
        }
        send(200, { stopped: true, processId })
        return
      }
      // One process with its captured output, for the workbench detail view.
      if (req.method === 'GET') {
        const detail = deps.processes.detail(entry.session.id, processId)
        if (detail === undefined) {
          send(404, { error: `no such process '${processId}'` })
          return
        }
        send(200, detail)
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    const wsSessionMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)(?:\/(events|messages|stop|steer)|\/(inputs)\/([^/]+))?$/.exec(pathname)
    if (wsSessionMatch !== null) {
      const wsId = decodeURIComponent(wsSessionMatch[1] ?? '') as WorkspaceId
      const action = wsSessionMatch[3] ?? wsSessionMatch[4]
      const inputPathId = wsSessionMatch[5] !== undefined ? decodeURIComponent(wsSessionMatch[5]) : undefined
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
          deps.cancelCompaction(entry.session.id)
          await deps.settleCompaction(entry.session.id)
          if (entry.agent.busy) {
            send(409, { error: 'session is running; stop it before deleting' })
            return
          }
          try {
            // Claude SessionEnd (reason "clear" for a deleted conversation): observe-only.
            await deps.hookHost.fire('SessionEnd', {
              workspaceId: wsId,
              projectId: entry.projectId,
              sessionId: entry.session.id,
              matchValue: 'clear',
              input: { reason: 'clear' },
            })
            deps.hookHost.forgetSession(entry.session.id)
            await entry.session.durable()
          } catch (error) {
            send(500, { error: `SessionEnd hook/audit failed; session kept: ${String(error instanceof Error ? error.message : error)}` })
            return
          }
          // Children spawned over HTTP can outlive an idle root: stop them
          // first, so none keeps running against a deleted conversation.
          // Background processes die the same way — silently, because the
          // session's log (their only reader) is being deleted.
          await deps.processes.dispose(entry.session.id)
          await deps.childExecutor.cancelAllOfRoot(entry.session.id)
          for (const child of await deps.childExecutor.childrenOfRoot(entry.session.id, wsId)) {
            await deps.childExecutor.cancel(wsId, child.childSessionId)
          }
          deps.sessions.delete(entry.session.id)
          deps.kernel.ctx.agents.forget(entry.session.id)
          await deps.kernel.ctx.sessions.delete(entry.session.id)
          await forgetSessionState(entry.session.id, deps)
          deps.cancelCompaction(entry.session.id)
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
        deps.cancelCompaction(entry.session.id)
        entry.agent.stop()
        const cleaned = await deps.childExecutor.cancelAllOfRoot(entry.session.id)
        send(202, { stopped: true, ...(cleaned > 0 ? { childrenCancelled: cleaned } : {}) })
        return
      }
      if (action === 'steer' && req.method === 'POST') {
        const outcome = await steerSession(entry, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        send(outcome.status, outcome.body)
        return
      }
      if (action === 'inputs' && inputPathId !== undefined && (req.method === 'PATCH' || req.method === 'DELETE')) {
        const outcome = await amendQueuedInput(entry, inputPathId, req, deps)
        if (!outcome.ok) {
          send(outcome.status, { error: outcome.error })
          return
        }
        send(200, outcome.body)
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
      // Every layer that applies: bundled, ~/.claude/agents, the workspace,
      // and the project's .claude/agents when ?projectId= is given.
      const projectParam = query.get('projectId') ?? undefined
      const rows = await deps.agentDefinitions.list(wsId, projectParam)
      // Each row also says which model it would run on here (aliases such
      // as `opus` resolved against the configured providers).
      send(200, rows.map((row) => ({ ...row, modelResolution: deps.roleModelOf(row.definition.model) })))
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
          const resolved = await deps.agentDefinitions.resolve(wsId, name, parent.projectId)
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
          if (normalizeBrief(task) === undefined) {
            send(400, { error: "the task needs a non-empty 'prompt' (or the structured 'objective')" })
            return
          }
          const model = deps.childModelFor(
            parent.session,
            wsId,
            typeof body['model'] === 'string' ? body['model'] : undefined,
            resolved.definition.model,
          )
          const { turnId, handle } = await deps.childExecutor.spawnManual({
            workspaceId: wsId,
            parentSessionId: parent.session.id,
            definition: resolved.definition,
            ...(resolved.source !== undefined ? { definitionSource: resolved.source } : {}),
            admissionResolver: ({ parentSessionId, workspaceId, definition, candidates }) => deps.admissionExposureCeiling(parentSessionId, workspaceId, definition, candidates),
            packet: task,
            ...(inheritedContext !== undefined ? { inherit: 'brief' as const, inheritedContext } : {}),
            ...(parent.projectId !== undefined ? { projectId: parent.projectId } : {}),
            ...(Array.isArray(body['grantTools']) ? { grantTools: (body['grantTools'] as unknown[]).map(String) } : {}),
            ...(model !== undefined ? { model } : {}),
            grants: deps.grants.effective(parent.session.id, parent.projectId, wsId),
            // `agent.busy` lags the durable log: it flips idle only after the
            // turn's terminal append settles, so a spawn offered right after
            // turn/end must consult the events, not just the busy flag.
          }, () => parent.agent.busy && !deps.turnTerminal(parent.session), {
            ...(typeof body['parentTurnId'] === 'string' ? { turnId: body['parentTurnId'] } : {}),
            keepOpen: body['keepOpen'] === true,
          })
          send(202, {
            ...handle,
            parentTurnId: turnId,
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
          send(200, await deps.agentDefinitions.resolve(wsId, name, query.get('projectId') ?? undefined))
        } catch (error) {
          if (error instanceof AgentDefinitionError && (error.code === 'not-found' || error.code === 'invalid')) {
            send(error.code === 'not-found' ? 404 : 422, { error: error.message })
            return
          }
          fail(error)
        }
        return
      }
      if (req.method === 'DELETE') {
        requireWorkspace(deps, wsId, true)
        try {
          await deps.agentDefinitions.delete(wsId, name)
        } catch (error) {
          // An invalid or traversal name is the client's error, not a 500.
          if (error instanceof AgentDefinitionError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          throw error
        }
        send(200, { deleted: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Explicit workspace-scoped settlement. The parent id remains part of
    // the address so a workspace sibling cannot reconcile another root's child.
    const wsChildReconcileMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/children\/([^/]+)\/reconcile$/.exec(pathname)
    if (wsChildReconcileMatch !== null) {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      const wsId = decodeURIComponent(wsChildReconcileMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const parent = await findSession(decodeURIComponent(wsChildReconcileMatch[2] ?? ''), wsId, deps)
      if (parent === undefined) {
        send(404, { error: 'no such parent session' })
        return
      }
      const childId = decodeURIComponent(wsChildReconcileMatch[3] ?? '') as SessionId
      const owned = await deps.childExecutor.childrenOfRoot(parent.session.id, wsId)
      if (!owned.some((child) => child.childSessionId === childId)) {
        send(404, { error: 'no such child' })
        return
      }
      const handle = await deps.childExecutor.reconcile(wsId, childId)
      if (handle === undefined) {
        send(200, { reconciled: true, child: null })
        return
      }
      send(200, handle)
      return
    }

    // Child lifecycle: the addressed root owns the child. A child id alone
    // is not an authorization capability, even within one workspace.
    const wsChildMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/children\/([^/]+)(?:\/(cancel))?$/.exec(pathname)
    if (wsChildMatch !== null) {
      const wsId = decodeURIComponent(wsChildMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const root = await findSession(decodeURIComponent(wsChildMatch[2] ?? ''), wsId, deps)
      const childId = decodeURIComponent(wsChildMatch[3] ?? '') as SessionId
      const isCancel = wsChildMatch[4] === 'cancel'
      if (root === undefined || root.session.events.some((event) => event.type === 'session/child-meta') ||
        !(await deps.childExecutor.childrenOfRoot(root.session.id, wsId)).some((child) => child.childSessionId === childId)) {
        send(404, { error: 'no such child' })
        return
      }
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

    // Legacy workspace-only lifecycle routes cannot verify parent ownership.
    const legacyWsChild = /^\/api\/workspaces\/([^/]+)\/children\/([^/]+)(?:\/(cancel))?$/.exec(pathname)
    if (legacyWsChild !== null) {
      send(410, { error: 'child lifecycle now requires the owning root session in the address' })
      return
    }

    // Save one subagent file into the workspace layer. The document IS a
    // Claude Code subagent file (YAML frontmatter + body), stored verbatim
    // after validation. `dialect: "codex"` still converts a pinned Codex spec.
    // Clone a ~/.claude or bundled role into this workspace (same name, file
    // copied verbatim) so it overrides here and can be edited; and read a
    // workspace file's exact text for the raw editor.
    const wsAgentFile = /^\/api\/workspaces\/([^/]+)\/agents\/([^/]+)\/(clone|file)$/.exec(pathname)
    if (wsAgentFile !== null) {
      const wsId = decodeURIComponent(wsAgentFile[1] ?? '') as WorkspaceId
      const name = decodeURIComponent(wsAgentFile[2] ?? '')
      const action = wsAgentFile[3]
      try {
        if (action === 'clone' && req.method === 'POST') {
          requireWorkspace(deps, wsId, true)
          send(201, { definition: await deps.agentDefinitions.cloneToWorkspace(wsId, name) })
          return
        }
        if (action === 'file' && req.method === 'GET') {
          requireWorkspace(deps, wsId, false)
          send(200, await deps.agentDefinitions.readWorkspaceFile(wsId, name))
          return
        }
      } catch (error) {
        if (error instanceof AgentDefinitionError) {
          send(error.code === 'not-found' ? 404 : error.code === 'duplicate' ? 409 : 400, { error: error.message })
          return
        }
        throw error
      }
      send(405, { error: 'method not allowed' })
      return
    }

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
        const document = dialect === 'codex'
          ? serializeAgentDefinition(importCodexDefinition(content, typeof body['sourceVersion'] === 'string' ? body['sourceVersion'] : undefined).definition)
          : content
        // The raw editor sends the hash it read: an external edit since then is a 409.
        const expectedHash = typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined
        const saved = await deps.agentDefinitions.save(wsId, targetName, document, expectedHash)
        send(201, {
          definition: saved,
          imported: Object.keys(saved.definition).filter((key) => key !== 'instructions' && key !== 'warnings' && key !== 'unsupported'),
          warnings: saved.definition.warnings ?? [],
          active: true,
        })
      } catch (error) {
        if (error instanceof AgentDefinitionError) {
          send(error.code === 'blocked' ? 422 : error.code === 'not-found' ? 404 : error.code === 'conflict' ? 409 : 400, { error: error.message })
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
      const principalId = (req as IncomingMessage & { dntHarnessPrincipalId?: string }).dntHarnessPrincipalId ?? 'local'
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
        await deps.updateMcpConfig(wsId, (existing) => {
          let merged = existing
          for (const [name, server] of Object.entries(imported.servers)) {
            merged = upsertServer(merged, name, { ...server, enabled: false })
          }
          return merged
        })
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
            const unusableTools = discovered.filter((name) => !PROVIDER_TOOL_NAME.test(mcpToolName(server.name, name)) || name.includes('__'))
            const connectFailure = server.enabled ? deps.mcpConnectFailures.get(`${wsId}:${server.name}`) : undefined
            const stderr = client?.recentStderr() ?? ''
            rows.push({
              name: server.name,
              transport: server.transport,
              enabled: server.enabled,
              status: !server.enabled ? 'disabled' : client?.state ?? (connectFailure !== undefined ? 'failed' : 'connecting'),
              ...(connectFailure !== undefined ? { lastError: connectFailure.message } : {}),
              ...(unusableTools.length > 0 ? { unusableTools } : {}),
              ...(stderr !== '' ? { stderrTail: stderr.slice(-2_000) } : {}),
              breakerOpenUntil: client !== undefined && client.breakerOpenUntil > Date.now() ? client.breakerOpenUntil : null,
              containment: deps.containmentDetail,
              generation: deps.generationOf(wsId),
              auditFault,
              revision,
              stale: deps.isDrifted(wsId),
              discoveredTools: discovered,
              ...(server.allowedTools !== undefined ? { allowedTools: server.allowedTools } : {}),
              ...(server.executable !== undefined ? { executablePath: server.executable.path } : {}),
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
          await deps.updateMcpConfig(wsId, (current) => withoutServer(current, serverName))
          send(200, { deleted: serverName })
          return
        }
        if (req.method === 'POST' && serverName !== undefined && action === undefined) {
          // Register/update a server (config + provenance, no auto-spawn).
          requireWorkspace(deps, wsId, true)
          const body = await readJson(req)
          const expected = body['expectedRevision']
          const { expectedRevision: _expected, ...serverBody } = body
          void _expected
          const name = typeof body['name'] === 'string' && body['name'] !== '' ? body['name'] : serverName
          // The revision check runs inside the workspace's write turn, against
          // the file as it is when this save applies — not as it was on read.
          let conflict: string | undefined
          const merged = await deps.updateMcpConfig(wsId, (current) => {
            if (typeof expected === 'string' && expected !== configRevision(current)) {
              conflict = configRevision(current)
              throw new McpRevisionConflict()
            }
            return upsertServer(current, name, serverBody)
          }).catch((error: unknown) => {
            if (error instanceof McpRevisionConflict) return undefined
            throw error
          })
          if (merged === undefined) {
            send(409, { error: 'mcp.json changed since it was loaded; reload before saving', revision: conflict })
            return
          }
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
            await deps.updateMcpConfig(wsId, (current) => withServerEnabled(current, serverName, false))
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
          const expectedGeneration = deps.generationOf(wsId)
          let committedGeneration: number
          if (action === 'enable') {
            // Activation authorizes the canonical file the command resolves to
            // right now; later spawns refuse any other path or bytes.
            const executable = serverConfig.transport === 'stdio' && serverConfig.command !== undefined
              ? await resolveCanonicalExecutable(serverConfig.command).catch((error: unknown) => {
                throw new McpConfigError('invalid', `cannot enable '${serverName}': ${error instanceof Error ? error.message : String(error)}`)
              })
              : undefined
            const enabled = await deps.updateMcpConfig(wsId, (current) => {
              if (deps.generationOf(wsId) !== expectedGeneration) throw new McpRevisionConflict()
              return withServerActivated(current, serverName, executable)
            }).catch((error: unknown) => error instanceof McpRevisionConflict ? undefined : Promise.reject(error))
            if (enabled === undefined) {
              send(409, { error: 'MCP server changed while enable was preparing; retry against the current config' })
              return
            }
            committedGeneration = deps.generationOf(wsId)
          } else {
            // Reconnect never re-authorizes: a changed executable stays refused.
            const reconnected = await deps.updateMcpConfig(wsId, (current) => {
              if (deps.generationOf(wsId) !== expectedGeneration) throw new McpRevisionConflict()
              return withServerEnabled(current, serverName, true)
            }).catch((error: unknown) => error instanceof McpRevisionConflict ? undefined : Promise.reject(error))
            if (reconnected === undefined) {
              send(409, { error: 'MCP server changed while reconnect was preparing; retry against the current config' })
              return
            }
            committedGeneration = deps.generationOf(wsId)
          }
          if (action === 'reconnect') await deps.cancelMcpConnection(wsId, serverName)
          // A newer disable/save may have landed after this request committed
          // but before it reached publication. Never let the stale request
          // clear that mutation's cancellation marker and resurrect a server.
          const publishConfig = await deps.mcpStore.loadMcp(wsId)
          if (deps.generationOf(wsId) !== committedGeneration || publishConfig.servers[serverName]?.enabled !== true) {
            send(409, { error: 'MCP server changed before connection publication; retry against the current config' })
            return
          }
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
      // The workspace layer is `<ws>/settings.json` in Claude Code format;
      // GET also reports every layer that applies (user/workspace, plus the
      // project's `.claude/settings*.json` when ?projectId= is given).
      const workspaceDir = deps.hookHost.workspaceDir(wsId)
      if (workspaceDir === undefined) { send(409, { error: 'hook settings need a data home' }); return }
      if (req.method === 'GET') {
        try {
          const own = await readWorkspaceHooks(workspaceDir)
          const projectParam = query.get('projectId') ?? undefined
          const effective = await deps.hookHost.resolve(wsId, projectParam)
          send(200, {
            file: workspaceSettingsPath(workspaceDir),
            hooks: own.hooks,
            disableAllHooks: own.disableAllHooks,
            sources: effective.sources,
            // Every configured hook from every layer, with `active` and
            // `supported`; Settings groups them by event.
            effective: effective.all,
            disabled: effective.disabled,
            diagnostics: effective.diagnostics,
          })
        } catch (error) {
          if (error instanceof HookSettingsError) { send(400, { error: error.message }); return }
          throw error
        }
        return
      }
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        try {
          await writeWorkspaceHooks(
            workspaceDir,
            body['hooks'] ?? {},
            typeof body['disableAllHooks'] === 'boolean' ? body['disableAllHooks'] : undefined,
          )
          // The user reviewed and saved hooks: running conversations pick them up.
          deps.hookHost.invalidateWorkspace(wsId)
        } catch (error) {
          if (error instanceof HookSettingsError) { send(400, { error: error.message }); return }
          throw error
        }
        send(200, { saved: true })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Switch one hook (any layer) on or off for this workspace; the Claude
    // settings files are left exactly as written.
    const wsHookStateMatch = /^\/api\/workspaces\/([^/]+)\/hooks\/([0-9a-f]{16})$/.exec(pathname)
    if (wsHookStateMatch !== null) {
      const wsId = decodeURIComponent(wsHookStateMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const workspaceDir = deps.hookHost.workspaceDir(wsId)
      if (workspaceDir === undefined) { send(409, { error: 'hook settings need a data home' }); return }
      if (req.method !== 'PUT') { send(405, { error: 'method not allowed' }); return }
      const body = await readJson(req)
      if (typeof body['active'] !== 'boolean') { send(400, { error: "body needs a boolean 'active'" }); return }
      await setHookActive(workspaceDir, wsHookStateMatch[2] ?? '', body['active'])
      // Running conversations follow the switch immediately.
      deps.hookHost.invalidateWorkspace(wsId)
      send(200, { id: wsHookStateMatch[2], active: body['active'] })
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
        const value = body['value']
        await deps.updateMcpSecrets(wsId, (secrets) => { secrets[key] = value })
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
        await deps.updateMcpSecrets(wsId, (secrets) => { delete secrets[key] })
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

    // Explicit settlement for a child retained after a durable lifecycle
    // acknowledgement was lost. The parent id is part of the address, so the
    // operation cannot reconcile an otherwise workspace-owned sibling child.
    const legacyChildReconcileMatch = /^\/api\/sessions\/([^/]+)\/children\/([^/]+)\/reconcile$/.exec(pathname)
    if (legacyChildReconcileMatch !== null) {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      const workspaceId = implicitWorkspace(deps)
      const parent = await findSession(decodeURIComponent(legacyChildReconcileMatch[1] ?? ''), workspaceId, deps)
      if (parent === undefined) {
        send(404, { error: 'no such parent session' })
        return
      }
      const childId = decodeURIComponent(legacyChildReconcileMatch[2] ?? '') as SessionId
      const owned = await deps.childExecutor.childrenOfRoot(parent.session.id, workspaceId)
      if (!owned.some((child) => child.childSessionId === childId)) {
        send(404, { error: 'no such child' })
        return
      }
      const handle = await deps.childExecutor.reconcile(workspaceId, childId)
      if (handle === undefined) {
        // A canonical absent spawn is successfully cleaned up, but has no
        // surviving child handle to return.
        send(200, { reconciled: true, child: null })
        return
      }
      send(200, handle)
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
          deps.cancelCompaction(entry.session.id)
          await deps.settleCompaction(entry.session.id)
          if (entry.agent.busy) {
            send(409, { error: 'session is running; stop it before deleting' })
            return
          }
          await deps.processes.dispose(entry.session.id)
          const ownerWorkspace = entry.workspaceId
          await deps.childExecutor.cancelAllOfRoot(entry.session.id)
          for (const child of await deps.childExecutor.childrenOfRoot(entry.session.id, ownerWorkspace)) {
            await deps.childExecutor.cancel(ownerWorkspace, child.childSessionId)
          }
          deps.sessions.delete(entry.session.id)
          deps.kernel.ctx.agents.forget(entry.session.id)
          await deps.kernel.ctx.sessions.delete(entry.session.id)
          await forgetSessionState(entry.session.id, deps)
          deps.cancelCompaction(entry.session.id)
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
        deps.cancelCompaction(entry.session.id)
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

    // Settings → Providers & Models → Image generation: which provider/model GenerateImage calls.
    if (pathname === '/api/image-generation') {
      if (req.method === 'GET') {
        send(200, deps.imageSettings())
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const next = parseImageSettings(body)
        const blankRequested = body['provider'] === null || body['provider'] === '' || body['model'] === null || body['model'] === ''
        if (next.provider === null && !blankRequested) {
          send(400, { error: "body needs 'provider' and 'model' strings, or null to clear" })
          return
        }
        if (next.provider !== null && !deps.providers().some((entry) => entry.id === next.provider)) {
          send(400, { error: `unknown provider '${next.provider}'` })
          return
        }
        try {
          await deps.setImageSettings(next)
        } catch (error) {
          send(500, { error: `image generation settings could not be saved: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        send(200, deps.imageSettings())
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Settings → Providers & Models → Image understanding: DescribeImage model.
    if (pathname === '/api/image-understanding') {
      if (req.method === 'GET') {
        send(200, deps.imageUnderstanding())
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        const next = parseImageUnderstandingSettings(body)
        const blankRequested = body['provider'] === null || body['provider'] === '' || body['model'] === null || body['model'] === ''
        if (next.provider === null && !blankRequested) {
          send(400, { error: "body needs 'provider' and 'model' strings, or null to clear" })
          return
        }
        if (next.provider !== null && !deps.providers().some((entry) => entry.id === next.provider)) {
          send(400, { error: `unknown provider '${next.provider}'` })
          return
        }
        try {
          await deps.setImageUnderstanding(next)
        } catch (error) {
          send(500, { error: `image understanding settings could not be saved: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        send(200, deps.imageUnderstanding())
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Settings → Usage: daily token rows across every workspace.
    if (pathname === '/api/usage' && req.method === 'GET') {
      send(200, deps.usageLog.daily())
      return
    }

    // ── automations (scheduled prompts) ──────────────────────
    if (pathname.startsWith('/api/automations/') || /^\/api\/workspaces\/[^/]+\/automations(?:\/|$)/.test(pathname)) {
      await handleAutomations(req, pathname, deps, send, fail)
      return
    }
    if (pathname === '/api/push/key' || pathname === '/api/push/test' || pathname.startsWith('/api/push/subscriptions')) {
      await handlePush(req, pathname, deps, send)
      return
    }
    if (pathname === '/api/notify/channels' || pathname.startsWith('/api/notify/channels/')) {
      await handleChannels(req, pathname, deps, send)
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
          // The workspace mode is only the DEFAULT new conversations snapshot.
          // A conversation that owns a mode snapshot is never touched; only a
          // legacy root still reading the default re-evaluates its approvals.
          const effective = effectivePolicy(resolved.definition.permissionDefaults, deps.yolo)
          for (const [id, other] of deps.sessions) {
            if (other.workspaceId !== wsId || sessionModeOf(other.session.events) !== undefined) continue
            deps.approvalHandle.reevaluate({ workspaceId: wsId, rootSessionId: id, toolExposure: resolved.definition.toolExposure, policy: effective })
          }
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
    // Skill file tree: list + read the files inside one skill's owning layer
    // folder (before the /skills/:name match, which is single-segment anyway).
    const wsSkillFiles = /^\/api\/workspaces\/([^/]+)\/skills\/([^/]+)\/files$/.exec(pathname)
    if (wsSkillFiles !== null && req.method === 'GET') {
      const wsId = decodeURIComponent(wsSkillFiles[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const skillName = decodeURIComponent(wsSkillFiles[2] ?? '')
      const layers = await skillLayersForQuery(deps, wsId, query, send)
      if (layers === undefined) return
      try {
        send(200, { files: await deps.skills.filesIn(layers, skillName) })
      } catch (error) {
        if (error instanceof SkillError) {
          send(error.code === 'not-found' ? 404 : 400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }
    const wsSkillFile = /^\/api\/workspaces\/([^/]+)\/skills\/([^/]+)\/file$/.exec(pathname)
    if (wsSkillFile !== null && req.method === 'GET') {
      const wsId = decodeURIComponent(wsSkillFile[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const skillName = decodeURIComponent(wsSkillFile[2] ?? '')
      const filePath = query.get('path') ?? ''
      const layers = await skillLayersForQuery(deps, wsId, query, send)
      if (layers === undefined) return
      try {
        send(200, await deps.skills.readFileIn(layers, skillName, filePath))
      } catch (error) {
        if (error instanceof SkillError) {
          send(error.code === 'not-found' ? 404 : 400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }
    // Skill source rules (before /skills/:name, which has no room for the
    // extra segment). PUT also refreshes the grant-protected roots so the
    // absolute rule folders are never grantable to file tools.
    const wsSkillSources = /^\/api\/workspaces\/([^/]+)\/skills\/sources$/.exec(pathname)
    if (wsSkillSources !== null && (req.method === 'GET' || req.method === 'PUT')) {
      const wsId = decodeURIComponent(wsSkillSources[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, req.method === 'PUT')
      if (req.method === 'GET') {
        send(200, { rules: await deps.skills.sources(wsId) })
        return
      }
      const body = await readJson(req)
      try {
        const rules = await deps.skills.setSources(wsId, body)
        // Absolute rule folders join the protected roots immediately: grant
        // validation reads this array, so rules take effect on the next grant.
        // Recomputed from EVERY workspace's rules — the policy is host-wide.
        // The rules are already stored, so a failed recompute must not turn
        // into a 500: fall back to adding this list's folders (fail closed).
        try {
          await deps.refreshSkillProtectedRoots()
        } catch {
          deps.addSkillProtectedRoots(protectedRootsForRules(rules))
        }
        send(200, { rules })
      } catch (error) {
        if (error instanceof SkillError) {
          send(400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    // Catalog visibility toggle (before the /skills/:name match, which has no
    // room for the extra segment). Works for every layer: user/bundled skills
    // are read-only files, so the workspace sidecar is their only curation.
    const wsSkillHidden = /^\/api\/workspaces\/([^/]+)\/skills\/([^/]+)\/hidden$/.exec(pathname)
    if (wsSkillHidden !== null && req.method === 'PUT') {
      const wsId = decodeURIComponent(wsSkillHidden[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, true)
      const skillName = decodeURIComponent(wsSkillHidden[2] ?? '')
      const body = await readJson(req)
      if (typeof body['hidden'] !== 'boolean') {
        send(400, { error: "body needs a boolean 'hidden'" })
        return
      }
      try {
        await deps.skills.setHidden(wsId, skillName, body['hidden'])
        send(200, { name: skillName, hidden: body['hidden'] })
      } catch (error) {
        if (error instanceof SkillError) {
          send(400, { error: error.message })
          return
        }
        fail(error)
      }
      return
    }

    const wsSkillsMatch = /^\/api\/workspaces\/([^/]+)\/skills(?:\/([^/]+))?$/.exec(pathname)
    if (wsSkillsMatch !== null) {
      const wsId = decodeURIComponent(wsSkillsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const skillName = wsSkillsMatch[2] !== undefined ? decodeURIComponent(wsSkillsMatch[2]) : undefined
      if (req.method === 'GET' && skillName === undefined) {
        // The settings list shows every row (hidden included) with its state;
        // discovery surfaces filter separately via listVisible. A projectId
        // query adds that project's rule layers (unknown id → 400).
        const layers = await skillLayersForQuery(deps, wsId, query, send)
        if (layers === undefined) return
        const [rows, hidden] = await Promise.all([deps.skills.listIn(layers), deps.skills.hiddenNames(wsId)])
        const hiddenSet = new Set(hidden)
        send(200, rows.map((row) => ({ ...row, ...(hiddenSet.has(row.name) ? { hidden: true } : {}) })))
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
          const warnings = await workspaceSaveWarnings(deps, wsId, saved.name).catch(() => [] as string[])
          send(200, { name: saved.name, hash: saved.hash, ...(warnings.length > 0 ? { warnings } : {}) })
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
        try {
          await deps.skills.delete(wsId, skillName)
        } catch (error) {
          if (error instanceof SkillError) {
            send(400, { error: error.message })
            return
          }
          throw error
        }
        send(200, { deleted: true })
        return
      }
      if (req.method === 'GET' && skillName !== undefined) {
        // One skill's raw instructions + hash: the settings editor loads
        // real content so saves are never blind overwrites. projectId
        // selects the project's rule layers for project-layer rows.
        const layers = await skillLayersForQuery(deps, wsId, query, send)
        if (layers === undefined) return
        try {
          const loaded = await deps.skills.loadIn(layers, skillName)
          send(200, { name: loaded.name, title: loaded.title, description: loaded.description, source: loaded.source, ruleId: loaded.ruleId, hash: loaded.hash, instructions: loaded.instructions })
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
      // `?projectId=` selects the project tier (what the agent writes while a
      // conversation is bound to a project); absent = the workspace tier. The
      // id is checked against this workspace, so a foreign project is a 404.
      const rawMemoryProject = query.get('projectId')
      let memoryProject: ProjectId | undefined
      if (rawMemoryProject !== null && rawMemoryProject !== '') {
        try {
          deps.workspaces.getProject(rawMemoryProject as ProjectId, wsId)
        } catch (error) {
          fail(error)
          return
        }
        memoryProject = rawMemoryProject as ProjectId
      }
      const scope = { workspaceId: wsId, ...(memoryProject !== undefined ? { projectId: memoryProject } : {}) }
      if (req.method === 'GET' && entryId === undefined) {
        // The settings list shows every entry of a tier, so the listing is not
        // held to the model-facing default of 20 hits.
        const hits = await deps.memory.search(scope, typeof query.get('q') === 'string' ? (query.get('q') ?? '') : '', 500)
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
          if (error instanceof MemoryError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
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
        try {
          await deps.memory.forget(scope, entryId)
          send(200, { forgotten: true })
        } catch (error) {
          if (error instanceof MemoryError) send(400, { error: error.message })
          else fail(error)
        }
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

    // ── Root-owned live mode: one conversation's own mode ────
    const wsSessionModeMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/mode$/.exec(pathname)
    if (wsSessionModeMatch !== null) {
      const wsId = decodeURIComponent(wsSessionModeMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsSessionModeMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
        // A child resolves its root's mode; it has no picker of its own.
        send(409, { error: 'a child agent follows its root conversation\'s mode' })
        return
      }
      const view = (): Record<string, unknown> => {
        const { mode, revision } = deps.rootModeOf({ sessionId: entry.session.id }, wsId)
        return { modeId: mode.definition.id, name: mode.definition.name, revision, source: sessionModeOf(entry.session.events) !== undefined ? 'session' : 'workspace-default' }
      }
      if (req.method === 'GET') {
        send(200, view())
        return
      }
      if (req.method === 'PUT') {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const modeId = typeof body['modeId'] === 'string' ? body['modeId'].trim() : ''
        if (modeId === '') {
          send(400, { error: "body needs a non-empty string 'modeId'" })
          return
        }
        if ((await deps.modes.disabledIds(wsId)).includes(modeId)) {
          send(400, { error: `mode '${modeId}' is disabled in this workspace; enable it before selecting it` })
          return
        }
        let resolved: ResolvedMode
        try {
          resolved = await deps.modes.resolve(wsId, modeId)
        } catch (error) {
          if (error instanceof ModeError) {
            send(error.code === 'not-found' ? 404 : 400, { error: error.message })
            return
          }
          throw error
        }
        const stamped = deps.stampRootMode(entry.session, resolved)
        try {
          await entry.session.durable()
        } catch (error) {
          deps.unavailableSessions.add(entry.session.id)
          send(500, { error: `mode selection could not be persisted: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        deps.kernel.ctx.tools.bumpPolicyRevision()
        // Pending approvals re-evaluate against the new exposure for THIS
        // root and its children only; other conversations are untouched.
        deps.approvalHandle.reevaluate({
          workspaceId: wsId,
          rootSessionId: entry.session.id,
          toolExposure: stamped.snapshot.toolExposure,
          policy: effectivePolicy(stamped.snapshot.permissionDefaults, deps.yolo),
        })
        send(200, view())
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
      let manifest = deps.lastManifests.get(entry.session.id)
      if (manifest === undefined) {
        // The newest manifest is DURABLE — a `context/manifest` event per
        // request — and memory is only the latest request's cache. A restart
        // (or a log loaded without a live request since) rehydrates from the
        // log instead of answering as if no request ever ran.
        const events = entry.session.events
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index]
          if (event?.type === 'context/manifest') {
            manifest = event.manifest
            deps.lastManifests.set(entry.session.id, manifest)
            break
          }
        }
      }
      if (manifest === undefined) {
        // No live cache and no durable manifest event (a new conversation, or
        // a log from before manifests existed). 204 keeps the inspector quiet.
        res.writeHead(204)
        res.end()
        return
      }
      const usage = deps.sessionUsage.get(entry.session.id)
      // No `last` yet means this manifest's request has not reported usage.
      // Omit it rather than reuse the previous request's prompt count; the
      // cache totals still belong to the session.
      const reported = usage?.last !== undefined
        ? usage
        : usage !== undefined
          ? { cacheableInputTokens: usage.cacheableInputTokens, cachedInputTokens: usage.cachedInputTokens }
          : undefined
      send(200, reported !== undefined ? { ...manifest, usage: reported } : manifest)
      return
    }

    // One raw context block by hash: the trajectory's marker fetches the exact
    // text a past request carried. The newest record wins (a re-recorded hash
    // would be identical by construction); 404 is the honest legacy answer.
    const wsContextBodyMatch = /^\/api\/workspaces\/([^/]+)\/sessions\/([^/]+)\/context\/([0-9a-f]{64})$/.exec(pathname)
    if (wsContextBodyMatch !== null && req.method === 'GET') {
      const wsId = decodeURIComponent(wsContextBodyMatch[1] ?? '') as WorkspaceId
      const entry = await findSession(decodeURIComponent(wsContextBodyMatch[2] ?? ''), wsId, deps)
      if (entry === undefined) {
        send(404, { error: 'no such session' })
        return
      }
      const hash = wsContextBodyMatch[3] ?? ''
      const record = [...entry.session.events].reverse().find(
        (event): event is Extract<SessionEvent, { type: 'context/body' }> => event.type === 'context/body' && event.hash === hash,
      )
      if (record === undefined) {
        send(404, { error: 'no context body recorded for this hash (older than body recording, or content changed since)' })
        return
      }
      send(200, { hash: record.hash, kind: record.kind, ...(record.name !== undefined ? { name: record.name } : {}), chars: record.chars, body: record.body })
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
        const checkpoint = await deps.runCompaction(entry, 'manual')
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
    // Git is read-only status and diff for the workbench Git view.
    const wsProjectFilesMatch = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/(files|file|search|git|media)$/.exec(pathname)
    if (wsProjectFilesMatch !== null) {
      const wsId = decodeURIComponent(wsProjectFilesMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const project = deps.workspaces.getProject(decodeURIComponent(wsProjectFilesMatch[2] ?? '') as ProjectId, wsId)
      // HEAD joins GET: a media element asks for headers before it streams.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(405, { error: 'method not allowed' })
        return
      }
      try {
        const target = query.get('path') ?? ''
        const kind = wsProjectFilesMatch[3]
        if (kind === 'git') {
          send(200, target === ''
            ? await gitStatus(project.path, deps.deniedRoots)
            : await gitDiff(project.path, target, deps.deniedRoots))
          return
        }
        if (kind === 'media') {
          await serveProjectMedia(project.path, target, req, res, deps.deniedRoots)
          return
        }
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
        if (!(error instanceof ProjectFileError) && !(error instanceof ProjectGitError)) throw error
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
        // Folder grants are authorized and validated BEFORE anything changes,
        // so a refused grant never leaves a half-applied rename or retarget.
        // They are checked against the folder the project will have.
        let directories: AdditionalDirectory[] | undefined
        if (body['additionalDirectories'] !== undefined) {
          if (!browserPrincipal(req, deps, 'PATCH')) {
            send(401, { error: 'folder grants can only be changed from the browser session that owns the workspace' })
            return
          }
          if (!Array.isArray(body['additionalDirectories'])) {
            send(400, { error: 'additionalDirectories must be an array' })
            return
          }
          const primary = typeof body['path'] === 'string' ? await fs.realpath(path.resolve(body['path'])).catch(() => path.resolve(String(body['path']))) : updated.path
          directories = []
          for (const raw of body['additionalDirectories'] as unknown[]) {
            const item = (raw ?? {}) as Record<string, unknown>
            const access = parseAccess(item['access'])
            if (item['kind'] === 'project') {
              const referenced = deps.workspaces.getProject(String(item['projectId'] ?? '') as ProjectId, wsId)
              await validateGrantFolder(referenced.path, primary, deps.grants.policy)
              directories.push({ kind: 'project', projectId: referenced.id, access })
            } else {
              directories.push({ kind: 'path', path: await validateGrantFolder(item['path'], primary, deps.grants.policy), access })
            }
          }
        }
        if (typeof body['name'] === 'string' && body['name'].trim() !== '') {
          updated = await deps.workspaces.renameProject(pid, wsId, body['name'])
        }
        if (typeof body['path'] === 'string') {
          // Retargeting requires idle execution on the project — including
          // other projects' turns writing into it through a folder grant.
          for (const entry of deps.sessions.values()) {
            if (entry.projectId === pid && entry.agent.busy) {
              send(409, { error: 'project has running sessions; stop them before changing the folder' })
              return
            }
          }
          if (deps.leaseHeldInside(updated.path)) {
            send(409, { error: 'another conversation is writing into this project; stop it before changing the folder' })
            return
          }
          updated = await deps.workspaces.setProjectPath(pid, wsId, body['path'])
        }
        if (directories !== undefined) {
          updated = await deps.workspaces.setAdditionalDirectories(pid, wsId, directories)
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

    // ── system prompt overrides (Settings → System Prompts) ───
    // Per-workspace replacements for the fixed harness prompts. GET works on
    // any known workspace; PUT requires an active one and compare-and-swaps
    // on the config hash.
    const wsSystemPromptsMatch = /^\/api\/workspaces\/([^/]+)\/system-prompts$/.exec(pathname)
    if (wsSystemPromptsMatch !== null) {
      const wsId = decodeURIComponent(wsSystemPromptsMatch[1] ?? '') as WorkspaceId
      const snapshotBody = (snapshot: SystemPromptsSnapshot) => ({
        base: snapshot.base,
        child: snapshot.child,
        defaults: { base: DEFAULT_BASE_SYSTEM, child: DEFAULT_CHILD_SYSTEM },
        hash: snapshot.hash,
        ...(snapshot.warning !== undefined ? { warning: snapshot.warning } : {}),
      })
      if (req.method === 'GET') {
        try {
          requireWorkspace(deps, wsId, false)
        } catch (error) {
          fail(error)
          return
        }
        send(200, snapshotBody(await deps.systemPrompts.load(wsId)))
        return
      }
      if (req.method === 'PUT') {
        const body = await readJson(req)
        for (const key of ['base', 'child'] as const) {
          if (body[key] !== undefined && typeof body[key] !== 'string') {
            send(400, { error: `body '${key}' must be a string` })
            return
          }
        }
        const expectedHash = typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined
        try {
          requireWorkspace(deps, wsId, true)
        } catch (error) {
          fail(error)
          return
        }
        try {
          const snapshot = await deps.systemPrompts.save(
            wsId,
            {
              ...(typeof body['base'] === 'string' ? { base: body['base'] } : {}),
              ...(typeof body['child'] === 'string' ? { child: body['child'] } : {}),
            },
            expectedHash,
          )
          send(200, snapshotBody(snapshot))
        } catch (error) {
          const msg = String(error instanceof Error ? error.message : error)
          if (/^conflict:/.test(msg)) { send(409, { error: msg }); return }
          send(400, { error: msg })
        }
        return
      }
      send(405, { error: 'method not allowed' })
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
          await deps.approvalHandle.reevaluate({ workspaceId: wid })
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
              await deps.approvalHandle.reevaluate({ workspaceId: ws.id })
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

    // ── global subagent model aliases ──
    if (req.method === 'GET' && pathname === '/api/model-aliases') {
      send(200, deps.aliases().map((alias) => modelAliasRow(deps, alias)))
      return
    }

    if (req.method === 'POST' && pathname === '/api/model-aliases') {
      const body = await readJson(req)
      try {
        const created = await deps.mutateProviderStore(({ providers, defaults, aliases, aliasGeneration }) => {
          const input = parseModelAliasInput(deps, body)
          if (aliases.some((alias) => alias.name === input.name)) throw new ModelAliasConflict(`model alias '${input.name}' already exists`)
          const revision = aliasGeneration + 1
          const entry: ModelAlias = { ...input, revision }
          return { providers, defaults, aliases: [...aliases, entry], aliasGeneration: revision, result: entry }
        })
        send(201, modelAliasRow(deps, created))
      } catch (error) {
        const status = error instanceof ModelAliasConflict ? 409 : error instanceof ModelAliasValidation ? 400 : 500
        send(status, { error: String(error instanceof Error ? error.message : error) })
      }
      return
    }

    const aliasMatch = /^\/api\/model-aliases\/([^/]+)$/.exec(pathname)
    if ((req.method === 'PATCH' || req.method === 'DELETE') && aliasMatch !== null) {
      const currentName = decodeURIComponent(aliasMatch[1] ?? '')
      const body = await readJson(req)
      const expectedRevision = body['expectedRevision']
      if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) { send(400, { error: "body needs integer 'expectedRevision'" }); return }
      try {
        if (req.method === 'DELETE') {
          const deleted = await deps.mutateProviderStore(({ providers, defaults, aliases }) => {
            const current = aliases.find((alias) => alias.name === currentName)
            if (current === undefined) throw new ModelAliasMissing(currentName)
            if (current.revision !== expectedRevision) throw new ModelAliasConflict(`model alias '${currentName}' changed since it was loaded`)
            return { providers, defaults, aliases: aliases.filter((alias) => alias.name !== currentName), result: true }
          })
          send(200, { deleted })
        } else {
          const patched = await deps.mutateProviderStore(({ providers, defaults, aliases, aliasGeneration }) => {
            const current = aliases.find((alias) => alias.name === currentName)
            if (current === undefined) throw new ModelAliasMissing(currentName)
            if (current.revision !== expectedRevision) throw new ModelAliasConflict(`model alias '${currentName}' changed since it was loaded`)
            const input = parseModelAliasInput(deps, { ...current, ...body })
            if (input.name !== currentName && aliases.some((alias) => alias.name === input.name)) throw new ModelAliasConflict(`model alias '${input.name}' already exists`)
            const revision = aliasGeneration + 1
            const entry: ModelAlias = { ...input, revision }
            return { providers, defaults, aliases: aliases.map((alias) => alias.name === currentName ? entry : alias), aliasGeneration: revision, result: entry }
          })
          send(200, modelAliasRow(deps, patched))
        }
      } catch (error) {
        const status = error instanceof ModelAliasMissing ? 404 : error instanceof ModelAliasConflict ? 409 : error instanceof ModelAliasValidation ? 400 : 500
        send(status, { error: String(error instanceof Error ? error.message : error) })
      }
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
      const answerScope = body['scope'] ?? 'once'
      if (answerScope !== 'once' && answerScope !== 'session') {
        send(400, { error: "scope must be 'once' or 'session'" })
        return
      }
      // Only a root session's out-of-grant question with a grantable folder
      // can be answered for the session; children keep their spawn snapshot.
      const outside = answerScope === 'session' ? deps.pathScope.get(waiting.executionId ?? waiting.sessionId, waiting.call) : undefined
      if (answerScope === 'session' && (!allow || waiting.proposedGrant === undefined || waiting.parentSessionId !== undefined || outside === undefined)) {
        send(400, { error: 'this question cannot be answered for the whole session' })
        return
      }
      // Deleting must win the entry: a false return means expiry, stop, or a
      // policy change settled it while the body was being read — the answer
      // is late and the 404 is the truthful response.
      if (!deps.pending.delete(approvalId)) {
        send(404, { error: 'no such approval' })
        return
      }
      // Only the answer that won the entry may widen the session. The grant
      // itself is recorded only if the call is finally allowed, right before
      // it runs.
      if (outside !== undefined) {
        outside.grantForSession = true
        outside.approvalId = approvalId
      }
      waiting.resolve(allow)
      send(200, { answered: true })
      return
    }

    // AskUserQuestion answers follow the approval rule: the browser principal
    // that owns the conversation answers; the UUID alone is not a bearer.
    const questionMatch = /^\/api\/questions\/([^/]+)$/.exec(pathname)
    if (req.method === 'POST' && questionMatch !== null) {
      const questionId = questionMatch[1] ?? ''
      const waiting = deps.pendingQuestions.get(questionId)
      if (deps.auth.enabled) {
        const decision = deps.auth.authenticate(req.headers, 'POST')
        if (!decision.ok || decision.principal.kind !== 'browser') {
          send(401, { error: 'question answers require the browser session that owns the workspace' })
          return
        }
        if (waiting?.principalId !== undefined && waiting.principalId !== decision.principal.id) {
          send(403, { error: 'question belongs to a different principal' })
          return
        }
      }
      if (waiting === undefined) {
        send(404, { error: 'no such question' })
        return
      }
      const body = await readJson(req)
      let outcome: QuestionOutcome
      if (body['decline'] === true) {
        outcome = { kind: 'declined' }
      } else {
        try {
          outcome = { kind: 'answered', answers: validateAnswers(waiting.questions, body['answers']) }
        } catch (error) {
          send(400, { error: String(error instanceof Error ? error.message : error) })
          return
        }
      }
      // The body read is async: expiry or stop may have settled it meanwhile.
      if (deps.pendingQuestions.get(questionId) !== waiting) {
        send(404, { error: 'no such question' })
        return
      }
      waiting.settle(outcome)
      send(200, { answered: true })
      return
    }

    send(404, { error: 'no such route' })
  } catch (error) {
    fail(error)
  }
}

/** A session-grant edit based on an out-of-date revision. */
class StaleGrantsError extends Error {
  constructor(readonly revision: number) {
    super('stale folder grants')
  }
}

/**
 * True when the request comes from the browser principal (or auth is off).
 * Grants are standing pre-approvals, so they follow the approval rule: no
 * bearer (CLI/headless) client may widen a session's filesystem reach.
 */
function browserPrincipal(req: IncomingMessage, deps: HandlerDeps, method: string): boolean {
  if (!deps.auth.enabled) return true
  const decision = deps.auth.authenticate(req.headers, method)
  return decision.ok && decision.principal.kind === 'browser'
}

// ── session operation helpers ──────────────────────────────────

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

type SendJson = (status: number, body: unknown) => void

/** A named role must resolve where the run will happen (workspace + project layers). */
async function requireRole(deps: HandlerDeps, wsId: WorkspaceId, agent: string | null, projectId: string | null): Promise<void> {
  if (agent === null) return
  try {
    await deps.agentDefinitions.resolve(wsId, agent, projectId ?? undefined)
  } catch (error) {
    if (error instanceof AgentDefinitionError) throw new AutomationError(400, `agent role '${agent}': ${error.message}`)
    throw error
  }
}

/** An automation as the API returns it: the definition plus its next fire times. */
function automationView(row: Automation): Automation & { readonly nextRuns: readonly number[]; readonly finished: boolean } {
  const now = Date.now()
  // Finished = nothing left to run under this plan (one-time done, ended, used up).
  return { ...row, nextRuns: row.enabled ? nextRuns(row, now, 3) : [], finished: !hasFutureRuns(row, now) }
}

/**
 * Automations CRUD, Run now, run history and the cron preview.
 * `/api/workspaces/:ws/automations[/:id[/run|/runs]]`, `/api/automations/preview`.
 */
async function handleAutomations(req: IncomingMessage, pathname: string, deps: HandlerDeps, send: SendJson, fail: (error: unknown) => void): Promise<void> {
  try {
    if (pathname === '/api/automations/preview') {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      const body = await readJson(req)
      const input = parseAutomationInput({ ...body, schedules: Array.isArray(body['schedules']) ? body['schedules'] : [{ cron: body['cron'] }] }, true)
      send(200, { next: nextRuns(planOf(input.schedules ?? [], { endsAt: input.endsAt ?? null, maxRuns: input.maxRuns ?? null }), Date.now(), 5) })
      return
    }
    const match = /^\/api\/workspaces\/([^/]+)\/automations(?:\/([^/]+)(?:\/(run|runs))?)?$/.exec(pathname)
    if (match === null) { send(404, { error: 'not found' }); return }
    const wsId = decodeURIComponent(match[1] ?? '') as WorkspaceId
    const id = match[2] !== undefined ? decodeURIComponent(match[2]) : undefined
    const action = match[3]
    requireWorkspace(deps, wsId, req.method !== 'GET')
    if (id === undefined) {
      if (req.method === 'GET') {
        send(200, (await deps.automations.list(wsId)).map(automationView))
        return
      }
      if (req.method === 'POST') {
        const input = parseAutomationInput(await readJson(req), false)
        if (input.projectId !== null) deps.workspaces.getProject(input.projectId as ProjectId, wsId)
        await requireRole(deps, wsId, input.agent, input.projectId)
        const created = await deps.automations.create(wsId, input)
        deps.pokeScheduler()
        send(201, automationView(created))
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }
    if (action === 'runs') {
      if (req.method !== 'GET') { send(405, { error: 'method not allowed' }); return }
      await deps.automations.get(wsId, id)
      send(200, await deps.automations.history(wsId, id))
      return
    }
    if (action === 'run') {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      const outcome = await deps.runAutomation(wsId, await deps.automations.get(wsId, id), null)
      if (!outcome.ok) { send(outcome.status, { error: outcome.error }); return }
      send(202, outcome)
      return
    }
    if (req.method === 'GET') {
      send(200, automationView(await deps.automations.get(wsId, id)))
      return
    }
    if (req.method === 'PATCH') {
      const patch = parseAutomationInput(await readJson(req), true)
      if (patch.projectId !== undefined && patch.projectId !== null) deps.workspaces.getProject(patch.projectId as ProjectId, wsId)
      if (patch.agent !== undefined) {
        const current = await deps.automations.get(wsId, id)
        await requireRole(deps, wsId, patch.agent, patch.projectId !== undefined ? patch.projectId : current.projectId)
      }
      const updated = await deps.automations.update(wsId, id, patch)
      deps.pokeScheduler()
      send(200, automationView(updated))
      return
    }
    if (req.method === 'DELETE') {
      await deps.automations.remove(wsId, id)
      deps.pokeScheduler()
      send(200, { deleted: true })
      return
    }
    send(405, { error: 'method not allowed' })
  } catch (error) {
    if (error instanceof AutomationError) { send(error.status, { error: error.message }); return }
    fail(error)
  }
}

/**
 * Notification channels: `GET|POST /api/notify/channels`,
 * `PATCH|DELETE /api/notify/channels/:id`, `POST /api/notify/channels/:id/test`.
 * Secrets are write-only: responses carry a masked summary.
 */
async function handleChannels(req: IncomingMessage, pathname: string, deps: HandlerDeps, send: SendJson): Promise<void> {
  try {
    if (pathname === '/api/notify/channels') {
      if (req.method === 'GET') { send(200, await deps.channels.list()); return }
      if (req.method === 'POST') { send(201, await deps.channels.create(await readJson(req))); return }
      send(405, { error: 'method not allowed' })
      return
    }
    const match = /^\/api\/notify\/channels\/([^/]+)(?:\/(test))?$/.exec(pathname)
    if (match === null) { send(404, { error: 'not found' }); return }
    const id = decodeURIComponent(match[1] ?? '')
    if (match[2] === 'test') {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      await deps.channels.test(id)
      send(200, { sent: true })
      return
    }
    if (req.method === 'PATCH') { send(200, await deps.channels.update(id, await readJson(req))); return }
    if (req.method === 'DELETE') { await deps.channels.remove(id); send(200, { deleted: true }); return }
    send(405, { error: 'method not allowed' })
  } catch (error) {
    if (error instanceof ChannelError) { send(error.status, { error: error.message }); return }
    send(500, { error: String(error instanceof Error ? error.message : error) })
  }
}

/** Web Push: VAPID public key, device subscriptions and a test notification. */
async function handlePush(req: IncomingMessage, pathname: string, deps: HandlerDeps, send: SendJson): Promise<void> {
  try {
    if (pathname === '/api/push/key') {
      if (req.method !== 'GET') { send(405, { error: 'method not allowed' }); return }
      send(200, { publicKey: await deps.push.publicKey() })
      return
    }
    if (pathname === '/api/push/test') {
      if (req.method !== 'POST') { send(405, { error: 'method not allowed' }); return }
      const result = await deps.push.send({ title: 'dnt-harness', body: 'Notifications are working.', url: '/', tag: 'push-test' })
      send(200, result)
      return
    }
    if (pathname === '/api/push/subscriptions') {
      if (req.method === 'GET') {
        send(200, (await deps.push.list()).map(({ id, label, createdAt, endpoint }) => ({ id, label, createdAt, endpoint })))
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        const label = typeof body['label'] === 'string' ? body['label'] : (req.headers['user-agent'] ?? 'device')
        const record = await deps.push.subscribe(body['subscription'], label)
        send(201, { id: record.id, label: record.label, createdAt: record.createdAt, endpoint: record.endpoint })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }
    const match = /^\/api\/push\/subscriptions\/([^/]+)$/.exec(pathname)
    if (match !== null && req.method === 'DELETE') {
      await deps.push.unsubscribe(decodeURIComponent(match[1] ?? ''))
      send(200, { deleted: true })
      return
    }
    send(match === null ? 404 : 405, { error: match === null ? 'not found' : 'method not allowed' })
  } catch (error) {
    if (error instanceof PushError) { send(error.status, { error: error.message }); return }
    send(500, { error: String(error instanceof Error ? error.message : error) })
  }
}

/**
 * Create one root session: model/mode snapshot, project binding, MCP warm-up
 * and SessionStart hooks. Shared by `POST …/sessions` and the automation
 * runner. `controls` absent snapshots the global default; `modeId` absent
 * uses the workspace's selected mode.
 */
async function createRootSession(
  deps: HandlerDeps,
  wsId: WorkspaceId,
  options: { readonly projectId?: unknown; readonly controls?: unknown; readonly modeId?: string | null; readonly title?: string; readonly role?: (rootId: SessionId) => Promise<RoleRecord> },
): Promise<{ ok: false; status: number; error: string } | { ok: true; entry: SessionEntry }> {
  deps.workspaces.requireActive(wsId) // archived: no new sessions
  const rawProject = options.projectId
  let projectId: ProjectId | undefined
  if (rawProject !== undefined && rawProject !== null && rawProject !== '') {
    if (typeof rawProject !== 'string') return { ok: false, status: 400, error: "'projectId' must be a string" }
    try {
      deps.workspaces.getProject(rawProject as ProjectId, wsId)
    } catch (error) {
      return { ok: false, status: error instanceof ScopeError ? 404 : 500, error: String(error instanceof Error ? error.message : error) }
    }
    projectId = rawProject as ProjectId
  }
  // A browser submits the controls it displayed. Never re-read a shared
  // default in place of that choice: another tab/session may have changed it.
  let defaults = deps.defaults()
  const submitted = options.controls
  if (submitted !== undefined) {
    if (submitted === null || typeof submitted !== 'object' || Array.isArray(submitted)) {
      return { ok: false, status: 400, error: "'controls' must contain provider, model, and thinkingLevel" }
    }
    const { provider, model, thinkingLevel } = submitted as Record<string, unknown>
    if ((provider !== null && typeof provider !== 'string')
      || (model !== null && typeof model !== 'string')
      || (thinkingLevel !== null && !isThinkingLevel(thinkingLevel))
      || (provider === null) !== (model === null)) {
      return { ok: false, status: 400, error: "'controls' requires a complete string|null provider/model pair and valid thinkingLevel|null" }
    }
    if (provider !== null && model !== null) {
      try {
        deps.validateProviderModel(provider, model)
      } catch (error) {
        return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
      }
    }
    defaults = { provider, model, thinkingLevel }
  }
  // An explicit mode (automations) resolves before anything is created.
  let mode = deps.controlsFor(wsId).modeDefinition
  if (options.modeId !== undefined && options.modeId !== null) {
    if ((await deps.modes.disabledIds(wsId)).includes(options.modeId)) {
      return { ok: false, status: 400, error: `mode '${options.modeId}' is disabled in this workspace` }
    }
    try {
      mode = await deps.modes.resolve(wsId, options.modeId)
    } catch (error) {
      return { ok: false, status: 400, error: `mode '${options.modeId}' is unavailable: ${String(error instanceof Error ? error.message : error)}` }
    }
  }
  const session = deps.kernel.ctx.sessions.create(wsId)
  // Older API callers may omit controls and snapshot the global default.
  // Explicit null thinking preserves "use model default".
  session.append({
    type: 'session/model',
    provider: defaults.provider,
    model: defaults.model,
    // Null is an intentional snapshot: use the selected model default,
    // even if the global default gains a thinking override later.
    thinkingLevel: defaults.thinkingLevel,
  })
  // The workspace's selected mode is only the DEFAULT for new roots: the
  // root owns its own live mode from here on.
  deps.stampRootMode(session, mode)
  if (options.title !== undefined) session.append({ type: 'session/title', title: options.title.slice(0, 80) })
  if (options.role !== undefined) {
    // The role ceiling is resolved under the mode just stamped, so it is
    // admission exposure ∩ definition − disallowed, pinned for the root's life.
    try {
      const record = await options.role(session.id)
      session.append({ type: 'session/role', ...record })
    } catch (error) {
      await deps.kernel.ctx.sessions.delete(session.id).catch(() => {})
      return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) }
    }
  }
  try {
    await session.durable()
  } catch (error) {
    await deps.kernel.ctx.sessions.delete(session.id).catch(() => {})
    return { ok: false, status: 500, error: `session model/mode snapshot could not be persisted: ${String(error instanceof Error ? error.message : error)}` }
  }
  // G5: bring this workspace's enabled MCP servers up on first use.
  void deps.connectWorkspaceMcp(wsId).catch((error) => console.error(`web: MCP config/start failed for ${wsId}: ${String(error instanceof Error ? error.message : error)}`))
  if (projectId !== undefined) {
    // Canonical, rebuildable record of the binding.
    session.append({ type: 'session/project', projectId })
    await session.durable().catch(() => {})
  }
  const entry: SessionEntry = {
    session,
    agent: deps.kernel.ctx.agents.create(session, { workspaceId: wsId, ...(projectId !== undefined ? { projectId } : {}), ...roleIdentityOf(session) }),
    workspaceId: wsId,
    projectId,
  }
  deps.sessions.set(session.id, entry)
  // Claude SessionStart hooks (source "startup"): their context
  // (`additionalContext` or plain stdout) waits in the inbox and joins
  // the first user message as lower-trust data.
  try {
    const { verdict } = await deps.hookHost.fire('SessionStart', {
      workspaceId: wsId,
      projectId,
      sessionId: session.id,
      matchValue: 'startup',
      input: { source: 'startup' },
    })
    if (verdict.additionalContext !== undefined) {
      entry.agent.inject(hookContextBlock('SessionStart', verdict.additionalContext))
    }
    await session.durable()
  } catch (error) {
    // SessionStart is part of the hook lifecycle contract: do not
    // acknowledge a started session whose hook audit was lost.
    deps.sessions.delete(session.id)
    await deps.kernel.ctx.sessions.delete(session.id).catch(() => {})
    return { ok: false, status: 500, error: `SessionStart hook/audit failed: ${String(error instanceof Error ? error.message : error)}` }
  }
  return { ok: true, entry }
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
  const principalId = (req as IncomingMessage & { dntHarnessPrincipalId?: string }).dntHarnessPrincipalId
  return submitMessage(entry, deps, body, principalId)
}

/**
 * Accept one message into a root session and dispatch it: validation,
 * durable `input/queued`, then the inbox. `body` is the request shape
 * (`content`, `delivery`, `attachments`, `clientRequestId`). Shared by the
 * HTTP route and the automation runner.
 */
async function submitMessage(
  entry: SessionEntry,
  deps: HandlerDeps,
  body: Record<string, unknown>,
  principalId: string | undefined,
): Promise<{ ok: false; status: number; error: string } | { ok: true; status: number; body: Record<string, unknown> }> {
  if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
    return { ok: false, status: 409, error: 'this is a child agent session; it is executor-managed and cannot receive messages or be resumed directly' }
  }
  const content = body['content']
  if (typeof content !== 'string') {
    return { ok: false, status: 400, error: 'body needs a string content' }
  }
  // `steer` stops the running turn and runs the queue now; `queue` (the
  // default, and every legacy client) waits for the turn to finish.
  const rawDelivery = body['delivery']
  if (rawDelivery !== undefined && rawDelivery !== 'queue' && rawDelivery !== 'steer') {
    return { ok: false, status: 400, error: "'delivery' must be 'queue' or 'steer'" }
  }
  const delivery: 'queue' | 'steer' = rawDelivery === 'steer' ? 'steer' : 'queue'
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
    // A duplicate never stops anything: a double click or a transport retry
    // must not cancel the turn the first request already started.
    if (prior?.type === 'input/queued') {
      return { ok: true, status: 200, body: { inputId: prior.inputId, duplicate: true } }
    }
  }

  // Bound check before anything is adopted or stopped: a refused message
  // leaves the agent and the running turn exactly as they were.
  const stillPending = deps.kernel.ctx.sessions.pendingInputs(entry.session)
  if (stillPending.length >= deps.limits.maxPendingInputs) {
    return { ok: false, status: 429, error: `too many queued inputs (limit ${deps.limits.maxPendingInputs})` }
  }

  // Durable acceptance before the driver sees the input, and before a steer
  // stops anything: a write failure leaves the running turn untouched.
  const inputId = newInputId()
  // The host, not the client, decides whether this input starts a turn now
  // (idle, nothing blocking dispatch) or waits behind one. The stamp lets the
  // UI render a sent message right away instead of a queued row.
  const runsNow = !entry.agent.busy
    && entry.closed !== true
    && !deps.compactionPending(entry.session.id)
    && !deps.kernel.ctx.llm.sessionUncertain(entry.session.id)
  entry.session.append({
    type: 'input/queued',
    inputId,
    ...(clientRequestId !== undefined ? { clientRequestId } : {}),
    content,
    ...(refs.length > 0 ? { attachments: refs } : {}),
    ...(delivery === 'steer' ? { delivery: 'steer' as const } : {}),
    ...(runsNow ? { runsNow: true as const } : {}),
  })
  try {
    await entry.session.durable()
  } catch (error) {
    return { ok: false, status: 500, error: `input could not be durably accepted: ${String(error instanceof Error ? error.message : error)}` }
  }

  // Re-adopt anything accepted but never consumed (a stop left it queued,
  // or a previous run failed) in log order, then the new input last:
  // accepted input is never lost and runs in submission order.
  entry.agent.adoptPending(stillPending)
  entry.agent.enqueueAccepted({ content, inputId, ...(refs.length > 0 ? { attachments: refs } : {}) })
  if (deps.compactionPending(entry.session.id)) {
    return { ok: true, status: 202, body: { inputId, queued: true, delivery, dispatchBlocked: 'maintenance' } }
  }
  const wasBusy = entry.agent.busy
  if (!await dispatchInbox(entry, deps, delivery)) {
    // Acceptance is already durable: acknowledge it so callers do not resend
    // the message. Only dispatch is blocked; /steer can resume the queue later.
    return { ok: true, status: 202, body: { inputId, queued: true, delivery, dispatchBlocked: 'transport_cleanup' } }
  }
  return { ok: true, status: 202, body: { inputId, queued: wasBusy && delivery === 'queue', delivery } }
}

/**
 * Edit (PATCH `{ content }`) or delete (DELETE) one queued input while it
 * still waits: `input/revised`, or `input/settled { outcome: "withdrawn" }`,
 * applied to the live inbox in the same tick it is appended. Input a turn already claimed (pre-step or later) answers 409: it is
 * on its way to the model and no longer the user's to change.
 */
async function amendQueuedInput(
  entry: SessionEntry,
  inputId: string,
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true; body: Record<string, unknown> }> {
  if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
    return { ok: false, status: 409, error: 'this is a child agent session; its input is executor-managed' }
  }
  requireWorkspace(deps, entry.workspaceId, true)
  let content: string | undefined
  let attachments: readonly AttachmentRef[] | undefined
  if (req.method === 'PATCH') {
    const body = await readJson(req)
    const raw = body['content']
    if (typeof raw !== 'string') return { ok: false, status: 400, error: 'body needs a string content' }
    content = raw
    // Present means replacement (an empty array drops them); absent means the
    // queued list rides along. Same validation a sent message's refs get.
    if (body['attachments'] !== undefined) {
      const parsed = parseAttachments(body['attachments'], deps.limits.maxAttachmentsPerMessage)
      if (!parsed.ok) return parsed
      for (const ref of parsed.refs) {
        try {
          await deps.attachments.verify(entry.workspaceId, ref)
        } catch (error) {
          if (!(error instanceof AttachmentError)) throw error
          return { ok: false, status: 400, error: error.message }
        }
      }
      attachments = parsed.refs
    }
  }
  const pending = deps.kernel.ctx.sessions.pendingInputs(entry.session).find((item) => item.inputId === inputId)
  if (pending === undefined) return { ok: false, status: 404, error: 'no such queued input (it may already have run)' }
  const id = pending.inputId
  // Editing to nothing would leave an input the composer itself refuses:
  // empty text is fine only while files (queued or just submitted) ride along.
  const effective = attachments ?? pending.attachments ?? []
  if (content !== undefined && content.trim() === '' && effective.length === 0) {
    return { ok: false, status: 400, error: 'body needs a non-empty string content (delete the input instead)' }
  }
  // Check, inbox change and append are one synchronous step: a turn claims
  // its input synchronously too, so it sees either the old or the new queue,
  // never a deleted input it already logged.
  const applied = content !== undefined ? entry.agent.reviseQueued(id, content, attachments) : entry.agent.withdrawQueued(id)
  if (!applied) return { ok: false, status: 409, error: 'this input is already being processed' }
  entry.session.append(
    content !== undefined
      ? { type: 'input/revised', inputId: id, content, ...(attachments !== undefined ? { attachments } : {}) }
      : { type: 'input/settled', inputId: id, outcome: 'withdrawn' },
  )
  try {
    await entry.session.durable()
  } catch (error) {
    return { ok: false, status: 500, error: `change could not be durably recorded: ${String(error instanceof Error ? error.message : error)}` }
  }
  return { ok: true, body: content !== undefined ? { inputId: id, revised: true } : { inputId: id, withdrawn: true } }
}

/**
 * Steer without a new message ("Send now" on queued input): stop the running
 * turn and run every pending input now. While idle it simply runs the queue.
 * Nothing pending is a no-op, never a stop — steering an empty queue would
 * be a plain Stop under another name.
 */
async function steerSession(
  entry: SessionEntry,
  deps: HandlerDeps,
): Promise<{ ok: false; status: number; error: string } | { ok: true; status: number; body: Record<string, unknown> }> {
  if (entry.session.events.some((event) => event.type === 'session/child-meta')) {
    return { ok: false, status: 409, error: 'this is a child agent session; it is executor-managed and cannot be steered directly' }
  }
  requireWorkspace(deps, entry.workspaceId, true)
  if (deps.unavailableSessions.has(entry.session.id)) {
    return { ok: false, status: 503, error: 'session unavailable after durable storage failure; restart the host to reload canonical history' }
  }
  // Input a running turn already claimed (still in pre-step, not yet logged)
  // is not waiting: steering "for" it would cancel the turn that is about to
  // answer it. Only input nobody has claimed counts.
  const pending = deps.kernel.ctx.sessions.pendingInputs(entry.session)
  const waiting = pending.filter((item) => !entry.agent.isClaimed(item.inputId))
  if (waiting.length === 0) {
    return { ok: true, status: 200, body: { steered: false, pending: 0 } }
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
  entry.agent.adoptPending(pending)
  if (deps.compactionPending(entry.session.id)) {
    return { ok: true, status: 202, body: { steered: false, queued: true, pending: waiting.length, dispatchBlocked: 'maintenance' } }
  }
  if (!await dispatchInbox(entry, deps, 'steer')) {
    return { ok: false, status: 409, error: 'transport cleanup is unresolved; input remains queued, retry Send now after cleanup settles' }
  }
  return { ok: true, status: 202, body: { steered: true, pending: waiting.length } }
}

/**
 * Hand the inbox to the driver. Idle: start a run. Busy + queue: the running
 * turn picks it up when it finishes (or it waits, after a stop). Busy +
 * steer: stop the turn — children included, like Stop — and let the agent
 * re-run the inbox once the stopped run settles.
 */
async function dispatchInbox(entry: SessionEntry, deps: HandlerDeps, delivery: 'queue' | 'steer'): Promise<boolean> {
  // Uncertain transport ownership is not a live driver to steer. Keep input
  // queued, and never acknowledge Send now as dispatched until cleanup is verified.
  if (deps.compactionPending(entry.session.id)) return true
  if (entry.closed) return false
  if (deps.kernel.ctx.llm.sessionUncertain(entry.session.id)) return delivery === 'queue'
  if (!entry.agent.busy) {
    // Fire-and-forget: the reply (and any failure, which closes the turn
    // durably) reaches the client through the SSE stream.
    void entry.agent.run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`web: agent run failed for ${entry.session.id}: ${message}`)
      deps.kernel.ctx.emit('web/turn-error', { sessionId: entry.session.id, message })
    })
    return true
  }
  if (delivery === 'steer') {
    entry.agent.steer()
    await deps.childExecutor.cancelAllOfRoot(entry.session.id)
  }
  return true
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

function listSessions(workspaceId: WorkspaceId, deps: HandlerDeps, automationRuns: ReadonlyMap<string, string> = new Map()): Record<string, unknown>[] {
  const fallbackWs = defaultWorkspaceId(deps)
  const rows: Record<string, unknown>[] = []
  const summaries = deps.kernel.ctx.sessions.summaries()
  // Child sessions never join the root registry (executor-managed), so their
  // live driver state comes from the executor's own active index.
  const runningChildren = new Set<string>()
  for (const summary of summaries) {
    if (summary.parentSessionId == null) continue
    for (const id of deps.childExecutor.runningChildrenOfRoot(summary.parentSessionId as SessionId)) runningChildren.add(id)
  }
  for (const summary of summaries) {
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
      // Subagent conversations: the UI nests them under this parent instead
      // of listing them beside it.
      parentSessionId: summary.parentSessionId ?? null,
      // Opened by a scheduled run: the sidebar groups these under Automations.
      ...(automationRuns.has(summary.id) ? { automationId: automationRuns.get(summary.id) } : {}),
      status: entry?.agent.status ?? (runningChildren.has(summary.id) ? 'running' : 'idle'),
      activity: entry?.agent.activity ?? null,
      pendingInputs: entry !== undefined ? deps.kernel.ctx.sessions.pendingInputs(entry.session).length : 0,
      // Background Bash processes outlive their turn; the sidebar folder uses
      // the count to show a terminal marker while anything is still running.
      runningProcesses: deps.processes.runningCount(summary.id),
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
async function forgetSessionState(sessionId: SessionId, deps: HandlerDeps): Promise<void> {
  deps.lastManifests.delete(sessionId)
  deps.contextBodies.delete(sessionId)
  deps.sessionUsage.delete(sessionId)
  for (const childId of await deps.childExecutor.forgetRoot(sessionId)) {
    deps.lastManifests.delete(childId)
    deps.contextBodies.delete(childId)
    deps.sessionUsage.delete(childId)
  }
}

/** Token usage the provider reported for one session since this host started. */
interface SessionUsage {
  /**
   * The newest COMPLETED request's usage. Absent between assembling the next
   * request and that request reporting its own prompt count, so a manifest
   * is never paired with an older prompt size.
   */
  readonly last?: TokenUsage
  /** Prompt tokens summed over requests that reported a cached share. */
  readonly cacheableInputTokens: number
  readonly cachedInputTokens: number
}

/** Fold one completion's usage into the session's running totals. */
function recordUsage(store: Map<SessionId, SessionUsage>, sessionId: SessionId, usage: TokenUsage): void {
  const previous = store.get(sessionId)
  // Only requests whose provider reports a cached share count toward the
  // hit rate; a server that never reports caching must not read as 0%.
  const reported = usage.cachedInputTokens !== undefined
  store.set(sessionId, {
    last: usage,
    cacheableInputTokens: (previous?.cacheableInputTokens ?? 0) + (reported ? usage.inputTokens : 0),
    cachedInputTokens: (previous?.cachedInputTokens ?? 0) + (usage.cachedInputTokens ?? 0),
  })
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
      ...roleIdentityOf(session),
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

/** What a `session/role` record carries (minus its stamp). */
type RoleRecord = Omit<Extract<SessionEvent, { type: 'session/role' }>, 'seq' | 'timestamp' | 'type'>

/** A root's pinned role, rebuilt from its durable `session/role` record. */
function roleIdentityOf(session: Session): { readonly role?: NonNullable<AgentScope['role']> } {
  const record = [...session.events].reverse().find((event) => event.type === 'session/role')
  if (record?.type !== 'session/role') return {}
  return {
    role: {
      definition: record.definition,
      instructions: record.instructions,
      toolCeiling: record.toolCeiling,
      ...(record.source !== undefined ? { definitionSource: record.source } : {}),
      ...(record.skills !== undefined ? { skills: record.skills } : {}),
    },
  }
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

class ModelAliasConflict extends Error {}
class ModelAliasValidation extends Error {}
class ModelAliasMissing extends Error {
  constructor(name: string) { super(`no model alias '${name}'`) }
}

function parseModelAliasInput(deps: HandlerDeps, body: Record<string, unknown>): Omit<ModelAlias, 'revision'> {
  try {
    const name = validateModelAliasName(typeof body['name'] === 'string' ? body['name'] : '')
    const provider = typeof body['provider'] === 'string' ? body['provider'].trim() : ''
    const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
    const thinkingLevel = body['thinkingLevel'] === null ? null : body['thinkingLevel']
    if (provider === '' || model === '') throw new Error("model alias needs non-empty 'provider' and 'model'")
    deps.validateProviderModel(provider, model)
    if (thinkingLevel !== null) {
      if (!isThinkingLevel(thinkingLevel)) throw new Error("'thinkingLevel' must be a supported level or null")
      if (expressibleThinkingLevel(model, thinkingLevel) !== thinkingLevel) throw new Error(`model '${model}' does not support thinking '${thinkingLevel}'`)
    }
    return { name, provider, model, thinkingLevel }
  } catch (error) {
    throw new ModelAliasValidation(String(error instanceof Error ? error.message : error))
  }
}

function modelAliasRow(deps: HandlerDeps, alias: ModelAlias): ModelAlias & { readonly status: 'valid' | 'invalid'; readonly message?: string; readonly warnings: readonly string[] } {
  let message: string | undefined
  try {
    deps.validateProviderModel(alias.provider, alias.model)
    if (alias.thinkingLevel !== null && expressibleThinkingLevel(alias.model, alias.thinkingLevel) !== alias.thinkingLevel) {
      message = `thinking '${alias.thinkingLevel}' is not supported by ${alias.provider}:${alias.model}`
    }
  } catch (error) { message = String(error instanceof Error ? error.message : error) }
  const warnings: string[] = []
  if (['sonnet', 'opus', 'haiku', 'fable'].includes(alias.name.toLowerCase())) warnings.push(`shadows built-in model alias '${alias.name}'`)
  if (deps.providers().some((provider) => provider.models.includes(alias.name))) warnings.push(`shadows advertised model '${alias.name}'`)
  return { ...alias, status: message === undefined ? 'valid' : 'invalid', ...(message === undefined ? {} : { message }), warnings }
}

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

/**
 * The replay profile a fresh SSE client needs: `context/body` payloads (fetched
 * on demand by hash) are dropped, content chunks of steps that later carry a
 * durable `assistant/message` are dropped, and reasoning chunks fold to one
 * event per step. Mirrors the client's `compactClientEvents` so the wire
 * carries exactly what the browser would keep, instead of every raw chunk of
 * a long session's history on each fresh connect. Live events after this
 * frame stream raw and the client still compacts them, so both paths agree.
 */
function compactReplayEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const finalizedSteps = new Set<string>()
  const abandonedSteps = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message' && event.stepId !== undefined) finalizedSteps.add(event.stepId)
    if (event.type === 'step/abandoned' && event.stepId !== undefined) abandonedSteps.add(event.stepId)
  }
  const compacted: SessionEvent[] = []
  const folded = new Map<string, number>()
  for (const event of events) {
    if (event.type === 'context/body') continue
    if (event.type === 'assistant/chunk' && event.stepId !== undefined) {
      if (event.thinking !== true && (finalizedSteps.has(event.stepId) || abandonedSteps.has(event.stepId))) continue
      if (event.thinking === true) {
        const at = folded.get(event.stepId)
        if (at !== undefined) {
          const previous = compacted[at] as Extract<SessionEvent, { type: 'assistant/chunk' }>
          compacted[at] = { ...previous, delta: `${previous.delta}${event.delta}` }
          continue
        }
        folded.set(event.stepId, compacted.length)
      }
    }
    compacted.push(event)
  }
  return compacted
}

/** Write one SSE `data:` frame and flush it. */
function writeFrame(res: ServerResponse, envelope: WebEnvelope, sequence?: number): void {
  res.write(`${sequence !== undefined ? `id: ${sequence}\n` : ''}data: ${JSON.stringify(envelope)}\n\n`)
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
  const streamGeneration = (req as IncomingMessage & { dntHarnessGeneration?: number }).dntHarnessGeneration ?? deps.auth.currentGeneration()
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
  const principalId = (req as IncomingMessage & { dntHarnessPrincipalId?: string }).dntHarnessPrincipalId
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let streamRecord: { principalId: string | undefined; close: () => void } | undefined
  const settle = (endResponse: boolean): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    dispose()
    if (streamRecord !== undefined) {
      const index = deps.liveStreams.indexOf(streamRecord)
      if (index !== -1) deps.liveStreams.splice(index, 1)
    }
    if (endResponse && !res.writableEnded) res.end()
  }
  const close = (): void => settle(true)
  streamRecord = { principalId, close }
  deps.liveStreams.push(streamRecord)

  heartbeat = setInterval(() => {
    if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
      close()
      return
    }
    res.write(': ping\n\n')
  }, 25_000)
  heartbeat.unref?.()

  req.once('close', () => settle(false))
}

/**
 * Stream one session: snapshot the current log, relay live events, then
 * re-expose still-pending approval questions (a browser reload mid-question
 * restores actionable state) until the client disconnects. Listeners are
 * disposed on close so a dropped tab never leaks registrations.
 */
/**
 * Close `process/start` events left open by a server restart. Sessions load
 * lazily, so this runs on the FIRST read of each session after boot, before
 * any client can see its events: an open id the live registry does not own
 * gets one synthetic durable `process/exit { interrupted }`. Orphaned OS
 * processes are not re-adopted; KillShell/BashOutput on the id answer
 * unknown truthfully.
 */
function reconcileInterruptedProcesses(entry: SessionEntry, deps: HandlerDeps): void {
  const { session } = entry
  if (deps.processReconciled.has(session.id)) return
  deps.processReconciled.add(session.id)
  const closed = new Set<string>()
  for (const event of session.events) {
    if (event.type === 'process/exit') closed.add(event.processId)
  }
  for (const event of session.events) {
    if (event.type !== 'process/start') continue
    if (closed.has(event.processId) || deps.processes.read(session.id, event.processId) !== undefined) continue
    session.append({ type: 'process/exit', processId: event.processId, exitCode: null, termination: 'interrupted', durationMs: 0 })
  }
}

function streamEvents(req: IncomingMessage, res: ServerResponse, entry: SessionEntry, deps: HandlerDeps): void {
  const streamGeneration = (req as IncomingMessage & { dntHarnessGeneration?: number }).dntHarnessGeneration ?? deps.auth.currentGeneration()
  // A reconnect that authenticated under an older generation must not receive
  // the snapshot. Logout increments the generation before this handler runs
  // only when the cookie was already rejected; this covers a generation that
  // moved between authenticate() and the first write.
  if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
    res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ error: 'session generation was revoked' }))
    return
  }
  let disposeForBackpressure: (() => void) | undefined
  let backpressured = false
  const streamFrame=(envelope:WebEnvelope,sequence?:number):void=>{if(res.destroyed||res.writableEnded)return;if(res.writableLength>4_000_000){backpressured=true;disposeForBackpressure?.();res.end();return;}writeFrame(res,envelope,sequence)}
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  const { session } = entry

  // First read of this session since boot: close process/start events a
  // restart left open before any client can see them (orphaned OS processes
  // are not re-adopted — KillShell/BashOutput answer unknown truthfully).
  reconcileInterruptedProcesses(entry, deps)

  const rawCursor = req.headers['last-event-id']
  const cursor = typeof rawCursor === 'string' && /^\d+$/.test(rawCursor) ? Number(rawCursor) : NaN
  const latest = session.events.at(-1)?.seq ?? 0
  const earliest = session.events[0]?.seq ?? 1
  const resumable = Number.isSafeInteger(cursor) && cursor >= earliest - 1 && cursor <= latest
  // Both replay shapes are compacted: a fresh snapshot otherwise ships every
  // raw chunk of the session's history, and a long-disconnect resume replays
  // the same bulk. Sequence numbers stay untouched so the client's seen-cursor
  // filtering and its own compaction keep working unchanged.
  const replay = compactReplayEvents(resumable ? session.events.filter((event) => event.seq > cursor) : [...session.events])
  streamFrame({ kind: resumable ? 'resume' : 'snapshot', events: replay }, latest)
  for (const [approvalId, waiting] of deps.pending) {
    if (waiting.sessionId === session.id || waiting.parentSessionId === session.id) {
      streamFrame(approvalEnvelope(approvalId, waiting, session.id))
    }
  }
  for (const [questionId, waiting] of deps.pendingQuestions) {
    if (waiting.sessionId === session.id || waiting.parentSessionId === session.id) {
      streamFrame(questionEnvelope(questionId, waiting, session.id))
    }
  }
  const disposeQuestion = deps.kernel.ctx.on('web/question', (payload) => {
    if (payload.sessionId !== session.id && payload.parentSessionId !== session.id) return
    const waiting = deps.pendingQuestions.get(payload.questionId)
    if (waiting !== undefined) streamFrame(questionEnvelope(payload.questionId, waiting, session.id))
  })
  const disposeQuestionSettled = deps.kernel.ctx.on('web/question-settled', (payload) => {
    if (payload.sessionId === session.id || payload.parentSessionId === session.id) {
      streamFrame({ kind: 'question-settled', questionId: payload.questionId })
    }
  })

  const disposeSession = deps.kernel.ctx.on('session/event', (emitter, event) => {
    if (emitter.id === session.id && event.type !== 'context/body') streamFrame({ kind: 'session', event }, event.seq)
  })
  const disposeApproval = deps.kernel.ctx.on('web/approval', (payload) => {
    if (payload.sessionId === session.id || payload.parentSessionId === session.id) {
      const waiting = deps.pending.get(payload.approvalId)
      if (waiting !== undefined) {
        streamFrame(approvalEnvelope(payload.approvalId, waiting, session.id))
        return
      }
      streamFrame({
        kind: 'approval',
        approvalId: payload.approvalId,
        call: payload.call,
        expiresAt: payload.expiresAt,
        ...(payload.interactive === true ? { interactive: true } : {}),
        ...(payload.guardWarning !== undefined ? { guardWarning: payload.guardWarning } : {}),
        ...(payload.scopeWarning !== undefined ? { scopeWarning: payload.scopeWarning } : {}),
        ...(payload.proposedGrant !== undefined ? { proposedGrant: payload.proposedGrant } : {}),
        ...(payload.proposedAccess !== undefined ? { proposedAccess: payload.proposedAccess } : {}),
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
      streamFrame({ kind: 'approval-settled', approvalId: payload.approvalId })
    }
  })
  const disposeError = deps.kernel.ctx.on('web/turn-error', (payload) => {
    if (payload.sessionId === session.id) streamFrame({ kind: 'error', message: payload.message })
  })
  const principalId = (req as IncomingMessage & { dntHarnessPrincipalId?: string }).dntHarnessPrincipalId
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let streamRecord: { principalId: string | undefined; close: () => void } | undefined
  const settle = (endResponse: boolean): void => {
    if (closed) return
    closed = true
    if (heartbeat !== undefined) clearInterval(heartbeat)
    disposeSession()
    disposeApproval()
    disposeApprovalSettled()
    disposeQuestion()
    disposeQuestionSettled()
    disposeError()
    if (streamRecord !== undefined) {
      const index = deps.liveStreams.indexOf(streamRecord)
      if (index !== -1) deps.liveStreams.splice(index, 1)
    }
    if (endResponse && !res.writableEnded) res.end()
  }
  const close = (): void => settle(true)
  streamRecord = { principalId, close }
  deps.liveStreams.push(streamRecord)

  heartbeat = setInterval(() => {
    if (deps.auth.enabled && deps.auth.currentGeneration() !== streamGeneration) {
      close()
      return
    }
    // A deleted session must end its streams: no more frames can ever come.
    if (entry.closed === true) {
      streamFrame({ kind: 'error', message: 'session deleted' })
      close()
      return
    }
    if (res.destroyed || res.writableEnded) return
    if (res.writableLength > 4_000_000) {
      settle(false)
      res.end()
      return
    }
    res.write(': ping\n\n')
  }, 2_000)

  req.once('close', () => settle(false))
  res.once('close', () => settle(false))
  disposeForBackpressure = () => settle(false)
  if (backpressured) settle(false)
}

/**
 * Stream one project file as renderable media (image, audio, video) to the
 * paired browser. The type is sniffed — images must match their magic bytes,
 * audio and video may match by extension — and anything else is 404 rather
 * than bytes the caller would have to interpret. `Range` is honoured so
 * audio and video can seek; the whole body is capped at {@link MAX_MEDIA_BYTES}.
 */
async function serveProjectMedia(root: string, rawPath: string, req: IncomingMessage, res: ServerResponse, deniedRoots?: readonly string[]): Promise<void> {
  const deny = (status: number, message: string): void => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: message }))
  }
  let media: Awaited<ReturnType<typeof classifyProjectMedia>>
  try {
    media = await classifyProjectMedia(root, rawPath, deniedRoots)
  } catch (error) {
    deny(400, error instanceof ProjectFileError ? error.message : 'path must be a file inside this project')
    return
  }
  if (media === null) {
    deny(404, 'no viewable media at this path')
    return
  }
  const resolved = await resolveProjectMediaPath(root, rawPath, deniedRoots)
  if (resolved === null) {
    deny(404, 'no viewable media at this path')
    return
  }
  const baseHeaders: Record<string, string | number> = {
    'content-type': media.mediaType,
    'accept-ranges': 'bytes',
    // The path is the only identity a project file has, and the bytes behind
    // it can change; a stale media element must revalidate, not replay.
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
  }
  const range = req.headers.range
  if (range === undefined) {
    res.writeHead(200, { ...baseHeaders, 'content-length': media.size })
    if (req.method === 'HEAD') { res.end(); return }
    const stream = createReadStream(resolved.abs)
    stream.on('error', () => { res.destroy() })
    await new Promise<void>((resolve) => stream.pipe(res).on('close', resolve))
    return
  }
  // A single `bytes=first-last` (or open-ended) range; the media elements
  // never need more than one, and a syntactic refusal reads better than
  // silently ignoring the header.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  const first = match === null ? undefined : match[1] === '' ? undefined : Number(match[1])
  const last = match === null || match[2] === '' ? undefined : Number(match[2])
  if (match === null || (first === undefined && last === undefined) || (first !== undefined && first >= media.size) || (last !== undefined && last >= media.size && first === undefined)) {
    res.writeHead(416, { 'content-range': `bytes */${media.size}` })
    res.end()
    return
  }
  const start = first ?? Math.max(0, media.size - (last ?? 0))
  const end = last !== undefined && first !== undefined ? Math.min(last, media.size - 1) : media.size - 1
  res.writeHead(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${media.size}`, 'content-length': end - start + 1 })
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(resolved.abs, { start, end })
  stream.on('error', () => { res.destroy() })
  await new Promise<void>((resolve) => stream.pipe(res).on('close', resolve))
}

/** Hashed asset paths are safe to cache forever; everything else revalidates per request. */
const IMMUTABLE_ASSET_PATH = /^\/assets\//

/** Serve the built client: `/` (and unknown paths) fall back to index.html for the router. */
async function serveStatic(res: ServerResponse, pathname: string, staticDir: string, acceptEncoding: string | undefined): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const abs = path.resolve(staticDir, relative)
  if (abs !== path.resolve(staticDir) && !abs.startsWith(`${path.resolve(staticDir)}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden' }))
    return
  }
  // Precompressed twins (.br/.gz, emitted at build time) stream as-is when the
  // client's Accept-Encoding allows: no per-request compression on the hot path.
  const encoding = acceptEncoding !== undefined && acceptEncoding.includes('br')
    ? { extension: '.br', name: 'br' }
    : acceptEncoding !== undefined && acceptEncoding.includes('gzip')
      ? { extension: '.gz', name: 'gzip' }
      : undefined
  try {
    let content: Buffer
    const headers: Record<string, string> = {}
    if (encoding !== undefined) {
      try {
        content = await fs.readFile(`${abs}${encoding.extension}`)
        headers['content-encoding'] = encoding.name
        headers['vary'] = 'Accept-Encoding'
      } catch {
        // No precompressed twin (dev tree, non-build file): identity bytes.
        content = await fs.readFile(abs)
      }
    } else {
      content = await fs.readFile(abs)
    }
    // The shell and the service worker must revalidate so a rebuilt client takes over promptly.
    const revalidate = relative === 'index.html' || relative === 'sw.js'
    headers['content-type'] = CONTENT_TYPES[path.extname(abs)] ?? 'application/octet-stream'
    if (revalidate) headers['cache-control'] = 'no-cache'
    else if (IMMUTABLE_ASSET_PATH.test(pathname)) headers['cache-control'] = 'public, max-age=31536000, immutable'
    res.writeHead(200, headers)
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
