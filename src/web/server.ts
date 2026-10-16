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
import { isIP } from 'node:net'
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
import { classifyGrantedRoots, classifyTarget, resolveInGrants, targetPaths, within } from '../capabilities/fs/grants.ts'
import { mergeGrants, parseAccess, projectGrants, validateGrantFolder, type GrantPolicy } from './folder-grants.ts'
import { approvedPathOf, attachPathScopeGuard, type PathScopeGuard, type PathScopeMatch } from './path-scope-guard.ts'
import type { Agent } from '../harness/agent/agent.ts'
import { approvalCallFingerprint, attachApproval, createApprovalReceiptRegistry, type ApprovalHandle, type ApprovalMode, type ApprovalScope } from '../harness/approval/policy.ts'
import { resolvePermission } from '../harness/approval/resolution.ts'
import { composeAuthority, type AskRequirement, type AuthorityDecision } from '../harness/tools/authority.ts'
import { DangerousCommandsStore } from '../harness/guard/store.ts'
import { liftsReadOnlyBash, riskyBashMatch, riskyBashWarning } from '../harness/modes/bash-policy.ts'
import { attachDangerousCommandGuard, guardMatchFingerprint } from '../harness/guard/guard.ts'
import { DEFAULT_LIMITS, resolveLimits, type HarnessLimits } from '../harness/limits.ts'
import { LlmService } from '../harness/llm/service.ts'
import { LogicalRequest, classifyTransport } from '../harness/llm/request-lifecycle.ts'
import { OpenAiCompletionsProvider } from '../harness/llm/openai.ts'
import { expressibleThinkingLevel, isThinkingLevel, type ThinkingLevel } from '../harness/llm/model-catalog.ts'
import { supportsNativeVision } from '../harness/llm/adaptive-vision.ts'
import { ProviderError } from '../harness/llm/types.ts'
import type { LlmProvider, ModelRequest, StreamEvent, StreamOptions, TokenUsage, ToolCall } from '../harness/llm/types.ts'
import type { ToolResult } from '../harness/tools/types.ts'
import { fileSessions, SessionsService } from '../harness/session/service.ts'
import type { Session } from '../harness/session/session.ts'
import { sessionGrantsOf, sessionModeOf, sessionModelOf, type SessionEvent, type SessionGrant, type SessionGrants } from '../harness/session/events.ts'
import { deriveTitle } from '../harness/session/title.ts'
import { newExecutionId, newInputId, type ProjectId, type SessionId, type TurnId, type WorkspaceId } from '../util/brand.ts'
import { ToolsService } from '../harness/tools/service.ts'
import { bashTool } from '../capabilities/shell/bash.ts'
import { bashOutputTool, killShellTool } from '../capabilities/shell/background-tools.ts'
import { createProcessSessionEventBridge } from '../harness/processes/session-event-bridge.ts'
import { runCleanup, boundedCleanup } from '../harness/processes/shutdown.ts'
import { ProcessRegistry } from '../harness/processes/registry.ts'
import { fsTools } from '../capabilities/fs/tools.ts'
import { listProjectEntries, readProjectFile, searchProjectFiles, ProjectFileError, classifyProjectMedia, resolveProjectMediaPath, MAX_MEDIA_BYTES, MAX_FILE_BYTES } from './project-files.ts'
import { createProjectEntry, deleteProjectEntry, ProjectWriteError, renameProjectEntry, saveProjectFile } from './project-files-write.ts'
import { gitDiff, gitStatus, ProjectGitError } from './project-git.ts'
import { answerGitAskpass, type AskpassSession } from './git-askpass.ts'
import { listProjectGitRemotes, pushedTo, runProjectGitOperation, type GitOperationRequest } from './project-git-ops.ts'
import { listProjectGitBranches } from './project-git-branches.ts'
import { commitMessageDiff, commitMessagePrompt, streamCommitMessage } from './git-commit-message.ts'
import type { GitHunkRef } from './project-git-hunks.ts'
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
  maxOutputTokenOverrides,
  validateModelAliasName,
} from './provider-store.ts'
import { ScopeError, WorkspaceService, type AdditionalDirectory, type ProjectRecord, type WorkspaceRecord } from '../harness/workspace/service.ts'
import { ModesService, ModeError, DEFAULT_MODE_ID, BUNDLED_MODES, type ResolvedMode } from '../harness/modes/service.ts'
import { migrateRootModes } from '../harness/modes/root-migration.ts'
import { AgentDefinitionService, AgentDefinitionError, serializeAgentDefinition, type AgentSource } from '../harness/agents/definition-service.ts'
import { narrowCeiling, roleCandidates } from '../harness/agents/mcp-candidates.ts'
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
import { McpDispatchError } from '../harness/mcp/boundaries.ts'
import { MutationStore, readFileIfPresent } from '../harness/mcp/mutation-store.ts'
import { recoverMigrations } from '../harness/mcp/migration.ts'
import { DataHomeLock } from '../harness/mcp/ownership-lock.ts'
import { ManagedOAuth } from '../harness/mcp/oauth.ts'
import { beginConnect, callbackPage, grantMatchesServer, managedAuthOf, OAuthConnectError, oauthConfigIdentity, oauthRowState, parseOAuthOrigins } from './mcp-oauth-connect.ts'
import { OAuthStore } from '../harness/mcp/oauth-store.ts'
import { containmentCapability, resolveCanonicalExecutable } from '../harness/mcp/process-controller.ts'
import { stageMcpOutcome } from '../harness/mcp/staged-outcome.ts'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { loadClaudeMd, renderClaudeMd } from '../harness/instructions/claude-md.ts'
import { HookSettingsError, isHookConfigPath, readWorkspaceHooks, setHookActive, workspaceSettingsPath, writeWorkspaceHooks } from '../harness/hooks/settings.ts'
import { fromClaudeToolInput, toClaudeToolInput } from '../harness/hooks/tool-input.ts'
import { HookHost, hookContextBlock } from './claude-hooks.ts'
import { BackgroundHooks } from './background-hooks.ts'
import type { HookVerdict } from '../harness/hooks/runner.ts'
import { ChildExecutor, SpawnError, normalizeBrief, type ChildModel, type TaskPacket } from '../harness/agents/executor.ts'
import { agentTool, ChildModelError, describeRoleModel, formatChildReports, projectInheritedMessages, resolveChildModel } from './agent-delegation.ts'
import { importCodexDefinition } from '../harness/agents/compatibility/claude.ts'
import { SkillsService, SkillError } from '../harness/skills/service.ts'
import { protectedRootsForRules, resolveSkillLayers, type SkillLayer } from '../harness/skills/layers.ts'
import { ResourceSourcesError, describeSourceLayers, validateSourcesInput } from '../harness/sources/resource-sources.ts'
import { MemoryService, MemoryError } from '../harness/memory/service.ts'
import { memoryGuidance, memoryGuidanceAccess, memoryIndexes } from '../harness/memory/context.ts'
import { todoWriteTool } from '../harness/tools/todo.ts'
import { editImageTool, generateImageTool, type ImageToolOptions } from '../harness/tools/image-tools.ts'
import { sendPreviewTool } from '../harness/tools/preview-tool.ts'
import { describeImageBytes, describeImageTool } from '../harness/tools/describe-image.ts'
import { generateVideoTool } from '../harness/tools/video-tools.ts'
import { VideoStore, VideoStoreError } from '../harness/attachments/video-store.ts'
import { loadPair, savePair, validatePairBody, type ModelPair } from './model-pair-store.ts'
import { resolveImageApi } from './image-generation-store.ts'
import { resolveVisionApi } from './image-understanding-store.ts'
import { resolveVideoApi } from './video-generation-store.ts'
import { askUserQuestionTool, validateAnswers, type QuestionOutcome, type UserQuestion } from '../harness/tools/ask-user.ts'
import { buildContext, buildContextPreview, estimateConversationTokens, DEFAULT_BASE_SYSTEM, DEFAULT_CHILD_SYSTEM, type ContextManifest, type ActiveSkill, type MemorySnippet } from '../harness/context/builder.ts'
import { renderEnvironmentContext } from '../harness/context/environment.ts'
import { SystemPromptsStore, type SystemPromptsSnapshot } from '../harness/prompts/store.ts'
import { CheckpointStore, recoverCanonicalCheckpoint, type CompactionCheckpoint } from '../harness/context/compaction.ts'
import { compactionSeedHash, sourceDigest } from '../harness/context/compaction-digest.ts'
import { CompactionSnapshotStore } from '../harness/storage/compaction-snapshot-store.ts'
import { promoteCapture, reconstructionCutoff, reconstructSnapshot } from './compaction-capture.ts'
import { CompactionHost, handoffSnapshot } from './compaction-host.ts'
import { CompactionPrecompute, candidateOwner } from './compaction-precompute.ts'
import { buildRestoration } from './compaction-restoration.ts'
import type { EffectiveCompactionSnapshot, SnapshotIdentity } from '../harness/context/compaction-snapshot.ts'
import { assertFitsWindow } from './compaction-generator.ts'
import { CaptureRegistry, identityOf, requestPrefixHash } from './compaction-wiring.ts'
import { loadReferencedSnapshot } from './compaction-restart.ts'
import { snapshotHash } from '../harness/context/compaction-snapshot.ts'
import { CacheAwareCompactionFallback, createCacheAwareCompactionSummarizer, createCompactionSummarizer, MAX_PARALLEL } from './llm-summarizer.ts'
import { DEFAULT_BUDGET, resolveModelBudget, schemaCost, type ResolvedBudget } from '../harness/context/budget.ts'
import type { BuildContextInput, PreviewCompaction } from '../harness/context/builder.ts'
import type { CompactionMeasurement } from '../harness/session/events.ts'
import type { Restored } from '../harness/context/compaction.ts'
import { isValidContextId } from '../harness/context/context-metrics.ts'
import { createContextReducer, deriveContextState, isAvailableContext, type ContextReducer, type ContextResponse } from '../harness/context/context-state.ts'
import { latestCalibration, pressureTokensOf, settledPressureTokens } from '../harness/context/calibration.ts'
import { isValidTokenUsage } from '../harness/context/context-metrics.ts'
import { CommandsService } from '../harness/commands/service.ts'
import { PluginService } from '../harness/plugins/service.ts'
import { PluginError } from '../harness/plugins/manifest.ts'
import { parseMarketplaceInput } from '../harness/plugins/marketplace.ts'
import { pluginServerName } from '../harness/plugins/mcp.ts'
import { commandKey, type CommandDefinition } from '../harness/commands/catalog.ts'
import { CommandExpansionError, expandCommand } from '../harness/commands/invoke.ts'
import { BUILTIN_COMMAND_NAMES, TurnCommandGrants, expandMessages, inlineShellOutput, resolveCommand, type CommandResolverDeps } from './slash-commands.ts'

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
      /** Epoch ms when this question expires undecided; absent when the host set no expiry. */
      readonly expiresAt?: number
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
  /** Read-only bundled slash commands shipped with the app (the lowest command layer). */
  readonly bundledCommandsDir?: string
  /** Test seam: replaces the `git` clone the plugin marketplace uses. */
  readonly pluginClone?: (url: string, target: string, ref?: string, sha?: string) => Promise<string>
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
   * https origins this host is reached at (`https://harness.example.com`), for
   * MCP OAuth sign-in from another machine. A request whose `Host` matches one
   * gets that origin as its OAuth redirect, so the provider returns the browser
   * to this host and sign-in finishes on its own. Any other non-loopback name
   * falls back to this host's loopback redirect and the person pastes the final
   * address back. The scheme cannot be read from a proxied request, so the
   * operator states it. Each must be an origin only and use https.
   */
  readonly oauthOrigins?: readonly string[]
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

/** The user (Stop), a delete or a shutdown ended a compaction: not a failure, nothing was written. */
class CompactionCancelled extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'CompactionCancelled'
  }
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
  /** Epoch ms from the policy's own timer — the one deadline the UI shows; absent when set to wait forever. */
  readonly expiresAt?: number
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
    ...(waiting.expiresAt !== undefined ? { expiresAt: waiting.expiresAt } : {}),
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

/** The provider/model references kept beside providers.json, one file each. */
const MODEL_PAIR_NAMES = ['image-generation', 'image-understanding', 'video-generation', 'commit-message'] as const
type ModelPairName = (typeof MODEL_PAIR_NAMES)[number]
const MODEL_PAIR_ROUTES: Readonly<Record<string, { readonly name: ModelPairName; readonly label: string }>> = {
  '/api/image-generation': { name: 'image-generation', label: 'image generation' },
  '/api/image-understanding': { name: 'image-understanding', label: 'image understanding' },
  '/api/commit-message': { name: 'commit-message', label: 'commit message' },
  '/api/video-generation': { name: 'video-generation', label: 'video generation' },
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
  // Validated before anything is built: a typo here would otherwise only show
  // up as a provider rejecting the redirect.
  const oauthOrigins = parseOAuthOrigins(options.oauthOrigins ?? [])
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
  // Not under workspaces/: boot adopts every directory there as a workspace.
  const checkpoints = new CheckpointStore(path.join(resourceHome, 'compaction'))
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
  const videos = new VideoStore(resourceHome)
  // Claude Code subagent layers: bundled < ~/.claude/agents < <ws>/agents <
  // <project>/.claude/agents.
  const projectRootOf = (workspaceId: string, projectId: string): string | undefined => {
    try { return workspaces.getProject(projectId as ProjectId, workspaceId as WorkspaceId).path } catch { return undefined }
  }
  // Claude Code plugins: the host's own store (<data>/plugins), enabled via
  // `enabledPlugins` in ~/.claude (read) < <ws> < project < local settings.
  const plugins = new PluginService({
    dataDir: resourceHome,
    ...(options.userClaudeDir !== undefined ? { userClaudeDir: options.userClaudeDir } : {}),
    homeDir: homedir(),
    projectRootOf,
    ...(options.pluginClone !== undefined ? { clone: options.pluginClone } : {}),
  })
  const pluginContext = (workspaceId: string, projectId: string | undefined) => ({ workspaceId, ...(projectId !== undefined ? { projectId } : {}) })
  if (options.home !== undefined) skills.setPluginLayers((workspaceId, projectId) => plugins.skillLayers(pluginContext(workspaceId, projectId)))
  const agentDefinitions = new AgentDefinitionService(resourceHome, {
    ...(options.userClaudeDir !== undefined ? { userClaudeDir: options.userClaudeDir } : {}),
    projectRootOf,
    ...(options.home !== undefined ? { pluginLayers: (workspaceId: string, projectId: string | undefined) => plugins.agentLayers(pluginContext(workspaceId, projectId)) } : {}),
    disabledLayers: (workspaceId: string) => skills.sourcesStore.disabled(workspaceId, 'agents'),
  })
  const childExecutor = new ChildExecutor(kernel.ctx, (root) => {
    const entry = sessions.get(root)
    const deps = depsRef.current
    if (entry !== undefined && deps !== undefined && !entry.closed && kernel.ctx.sessions.pendingInputs(entry.session).length > 0) {
      void dispatchInbox(entry, deps, 'queue').catch((error: unknown) => {
        console.error(`web: delegation inbox drain failed for ${root}: ${String(error)}`)
      })
    }
  })
  kernel.ctx.provide('agent-definitions', agentDefinitions)
  // Claude Code custom slash commands: ~/.claude/commands < plugins <
  // <ws>/commands < <project>/.claude/commands (ancestors first).
  const commandsService = new CommandsService(resourceHome, {
    ...(options.bundledCommandsDir !== undefined ? { bundledDir: options.bundledCommandsDir } : {}),
    ...(options.userClaudeDir !== undefined ? { userClaudeDir: options.userClaudeDir } : {}),
    projectRootOf,
    ...(options.home !== undefined ? { pluginLayers: (workspaceId: string, projectId: string | undefined) => plugins.commandLayers(pluginContext(workspaceId, projectId)) } : {}),
    disabledLayers: (workspaceId: string) => skills.sourcesStore.disabled(workspaceId, 'commands'),
  })
  // What the running turn's slash command granted (allowed-tools, model).
  const turnCommandGrants = new TurnCommandGrants()

  // G5: MCP servers + hooks, workspace-scoped. Each (workspace, enabled
  // server) gets one McpServerClient; tools register as `mcp__server__tool`.
  const mcpStore = new McpConfigStore(resourceHome)
  // Claude `async` / `asyncRewake` hooks: background runs owned by their root
  // conversation; a rewake becomes durable hook input for that conversation.
  const backgroundHooks = new BackgroundHooks({
    sessionOf: (sessionId) => sessions.get(sessionId as SessionId)?.session,
    deliverRewake: async (delivery) => {
      const entry = sessions.get(delivery.rootSessionId as SessionId)
      const deps = depsRef.current
      if (entry === undefined || deps === undefined || shuttingDown) return false
      return queueHookRewake(entry, deps, delivery.content, delivery.summary)
    },
  })
  // Claude Code hooks from settings.json layers (user/workspace/project/local).
  const hookHost = new HookHost({
    home: resourceHome,
    userClaudeDir: options.userClaudeDir,
    background: backgroundHooks,
    disabledLayers: (workspaceId) => skills.sourcesStore.disabled(workspaceId, 'hooks'),
    ...(options.home !== undefined ? { pluginHooks: (workspaceId: string, projectId: string | undefined) => plugins.hookSources(pluginContext(workspaceId, projectId)) } : {}),
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
  /** Per-server fences, so a change to one server never retires the others. */
  const mcpServerGeneration = new Map<string, number>()
  // Sum of two monotonic counters: bumps on a workspace-wide fence or on a fence of this server.
  const generationOf = (workspaceId: string, serverName: string): number =>
    (mcpGeneration.get(workspaceId) ?? 1) + (mcpServerGeneration.get(`${workspaceId}:${serverName}`) ?? 0)
  const journals = new Map<string, McpExecutionJournal>()
  const journalsOpening = new Map<string, Promise<McpExecutionJournal>>()
  const legacyAuditFaultFile = path.join(resourceHome, 'mcp-audit-fault.json')
  const workspaceAuditFaultFile = (workspaceId: string): string => path.join(resourceHome, 'mcp-audit-faults', `${encodeURIComponent(workspaceId)}.json`)
  let legacyAuditBlocked = await faultIsOpen(legacyAuditFaultFile)
  if (legacyAuditBlocked) {
    let owner: unknown
    try { owner = (JSON.parse(await fs.readFile(legacyAuditFaultFile, 'utf8')) as { workspaceId?: unknown } | null)?.workspaceId } catch { /* Unreadable metadata stays globally blocked. */ }
    if (typeof owner === 'string' && owner !== '') {
      const destination = workspaceAuditFaultFile(owner)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.copyFile(legacyAuditFaultFile, destination, 1).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      await clearAuditFault(legacyAuditFaultFile)
      legacyAuditBlocked = false
    }
  }
  const auditFaultFile = (workspaceId: string): string => legacyAuditBlocked ? legacyAuditFaultFile : workspaceAuditFaultFile(workspaceId)
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
  const oauthStore = new OAuthStore(path.join(resourceHome, 'oauth'), oauthKey)
  // A confidential client's secret is resolved from the workspace secrets at
  // each exchange; it never sits beside the tokens.
  const oauth = new ManagedOAuth(oauthStore, fetch, () => Date.now(), async (workspaceId, serverName) => {
    const config = await mcpStore.loadMcp(workspaceId)
    const ref = managedAuthOf(config.servers[serverName])?.clientSecret
    if (ref === undefined) return undefined
    return resolveSecretRefs(ref, await mcpStore.loadSecrets(workspaceId), `mcp.json server '${serverName}' auth.clientSecret`)
  }, async (workspaceId, serverName) => oauthConfigIdentity((await mcpStore.loadMcp(workspaceId)).servers[serverName]))
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
  // Settings → Providers & Models → Image generation / Image understanding /
  // Video generation: provider/model references beside providers.json,
  // resolved against the live provider list on every call.
  const pairFile = (name: ModelPairName): string => path.join(path.dirname(configFile), `${name}.json`)
  const pairs = new Map<ModelPairName, ModelPair>(MODEL_PAIR_NAMES.map((name) => [name, loadPair(pairFile(name))]))
  const pairOf = (name: ModelPairName): ModelPair => pairs.get(name)!
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
  // Provider registrations are re-made on every provider change. They live
  // apart from `disposers` so that churn never drops the host's long-lived
  // listeners (the automation run watcher used to vanish with them).
  const providerRegistrations = new Map<string, () => void>()

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
      maxOutputTokens: maxOutputTokenOverrides(entry),
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
    for (const dispose of providerRegistrations.values()) dispose()
    providerRegistrations.clear()
    for (const provider of options.providers ?? []) {
      providerRegistrations.set(provider.name, kernel.ctx.llm.register(provider))
    }
    for (const entry of list) {
      if (!isUsableConfigured(entry) || providerRegistrations.has(entry.id)) continue
      providerRegistrations.set(entry.id, kernel.ctx.llm.register(instantiate(entry)))
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

  /** The budget of a pair: the operator's override (verified), else the catalog's documented window. */
  const modelBudgetOf = (provider: string | undefined, model: string): ResolvedBudget => {
    const configured = provider === undefined ? undefined : list.find((entry) => entry.id === provider)?.modelSettings?.[model]?.contextTokens
    return resolveModelBudget({ model, ...(configured !== undefined ? { contextTokens: configured } : {}) })
  }

  /**
   * The model behind the Git panel's Generate Commit Message button: the
   * `commit-message` pair when one is set, else the alias named `fast`. No
   * silent fallback: a set-but-unusable pair returns its own error.
   */
  const commitMessageModel = (): { providerName: string; model: string } | { error: string } => {
    const pair = pairs.get('commit-message')!
    if (pair.provider !== null && pair.model !== null) {
      try {
        validateProviderModel(pair.provider, pair.model)
        return { providerName: pair.provider, model: pair.model }
      } catch (error) {
        return { error: `commit message model: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    const fast = aliases.find((alias) => alias.name === 'fast')
    if (fast !== undefined) {
      try {
        validateProviderModel(fast.provider, fast.model)
        return { providerName: fast.provider, model: fast.model }
      } catch (error) {
        return { error: `commit message model: ${error instanceof Error ? error.message : String(error)}` }
      }
    }
    return { error: 'No commit message model is configured.' }
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
    /** Alias the pair was picked through (display-only); the web verifies it still targets this pair. */
    readonly alias: string | null
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
    const alias = preference.hasEvent ? preference.alias ?? null : defaults.alias ?? null
    return { provider, model, thinkingLevel, alias, source: preference.hasEvent ? 'session' : 'global' }
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
    effort?: ThinkingLevel,
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
    }, effort)

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
    ...(options.bundledCommandsDir !== undefined ? [options.bundledCommandsDir] : []),
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
    const childCanWrite = scope?.childOf === undefined || scope.childOf.toolCeiling.some((name) => ['Write', 'Edit', 'ApplyPatch'].includes(name))
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

  // Read on an image file goes through the same vision model as DescribeImage.
  const readImageVision = {
    resolve: () => resolveVisionApi(pairOf('image-understanding'), list),
    stream: (request: ModelRequest, exec: { readonly signal?: AbortSignal }) => kernel.ctx.llm.stream(request, exec.signal !== undefined ? { signal: exec.signal } : undefined),
  }
  for (const tool of fsTools({ describeImage: async (image, exec) => (await describeImageBytes(readImageVision, image, '', exec)).description })) {
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

  // Turn-local snapshots of a child/role DEFINITION's skills: preloaded once
  // per turn and hash-pinned (no mid-turn hot reload). They ride the system
  // prefix because they never change during the run. Cleared at turn-settled.
  const skillSnapshots = new Map<SessionId, Map<string, ActiveSkill>>()
  // Skills the model loaded with the Skill tool this turn. Their bodies are
  // the tool result itself — immutable history after the prefix, so a load
  // never invalidates the provider's prompt cache — and this map only keeps a
  // repeat load in the same turn from pasting the body twice.
  const skillLoads = new Map<SessionId, Map<string, { readonly name: string; readonly hash: string }>>()
  /** Largest expanded skill body a Skill load returns (refused whole above it). */
  const MAX_SKILL_RESULT_CHARS = 200_000
  kernel.ctx.on('agent/turn-settled', async () => {
    const settled = agentScope.getStore()?.sessionId
    if (settled !== undefined) {
      skillSnapshots.delete(settled)
      skillLoads.delete(settled)
      turnCommandGrants.clear(settled)
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
  /** The trigger of the compaction that owns each session right now; its stage reports need it. */
  const jobTriggers = new Map<SessionId, 'manual' | 'automatic'>()
  /** Model requests and reported usage of the running compaction, one counter per session (one job at a time). */
  const jobStats = new Map<SessionId, { requests: number; input: number; cached: number; output: number }>()
  const countJobRequest = (sessionId: SessionId): void => { const stats = jobStats.get(sessionId); if (stats !== undefined) stats.requests++ }
  const countJobUsage = (sessionId: SessionId, usage: TokenUsage): void => {
    const stats = jobStats.get(sessionId)
    if (stats === undefined) return
    stats.input += usage.inputTokens
    stats.cached += usage.cachedInputTokens ?? 0
    stats.output += usage.outputTokens ?? 0
  }
  /**
   * Record one stage of the running compaction as a durable `compaction/job` event, so every
   * client — and a reload — sees where it is. Telemetry: a session that is going away just
   * has nowhere to write it. `ended` also carries the job's request/usage totals.
   */
  const appendJob = async (entry: SessionEntry, job: { readonly stage: 'preparing' | 'generating' | 'applying' | 'ended'; readonly outcome?: 'compacted' | 'noop' | 'cancelled' | 'failed'; readonly path?: 'exact' | 'reconstructed' | 'recovery' | 'legacy'; readonly error?: string; readonly progress?: { readonly done: number; readonly total: number } }): Promise<void> => {
    const trigger = jobTriggers.get(entry.session.id)
    if (trigger === undefined || entry.closed) return
    const stats = job.stage === 'ended' ? jobStats.get(entry.session.id) : undefined
    try {
      entry.session.append({
        type: 'compaction/job', stage: job.stage, trigger,
        ...(job.outcome !== undefined ? { outcome: job.outcome } : {}),
        ...(job.path !== undefined ? { path: job.path } : {}),
        ...(job.error !== undefined ? { error: job.error.slice(0, 500) } : {}),
        ...(job.progress !== undefined ? { progress: job.progress } : {}),
        ...(stats !== undefined && stats.requests > 0 ? { requests: stats.requests, usage: { input: stats.input, cached: stats.cached, output: stats.output } } : {}),
      })
      // The end is what a reload and the next request rely on, and a no-op, a failure or a cancel
      // has nothing else that waits for the log: let it reach the disk before the caller is told.
      if (job.stage === 'ended') await entry.session.durable()
    } catch { /* poisoned or deleted sessions cannot take it */ }
  }
  const runCompaction = (entry: SessionEntry, trigger: 'manual' | 'automatic'): Promise<{ coversSeq: number; summary: string; path?: string }> => {
    if (compactionClosing || entry.closed || compactions.has(entry.session.id)
      || (trigger === 'manual' && entry.agent.busy)
      || kernel.ctx.llm.sessionUncertain(entry.session.id)) {
      return Promise.reject(new Error('compaction requires a completed exchange boundary; session is active or reserved'))
    }
    const reservation = { controller: new AbortController(), done: undefined as Promise<unknown> | undefined }
    compactions.set(entry.session.id, reservation)
    jobTriggers.set(entry.session.id, trigger)
    jobStats.set(entry.session.id, { requests: 0, input: 0, cached: 0, output: 0 })
    const signal = reservation.controller.signal
    const done = agentScope.exit(async () => {
      const startedAfter = entry.session.events.at(-1)?.seq ?? 0
      void appendJob(entry, { stage: 'preparing' })
      try {
        let result: { coversSeq: number; summary: string; path?: string }
        if (limits.compactionEffectiveEnabled) result = await effectiveCompaction(entry, trigger, signal)
        else {
          const blocked = await runPreCompactHooks(entry.session, entry.workspaceId, signal, trigger === 'automatic' ? 'auto' : 'manual')
          signal.throwIfAborted()
          if (blocked !== undefined) throw new Error(blocked)
          result = await legacyBody(entry, trigger, signal)
        }
        // A new successful end after the job began means a checkpoint was written; otherwise the boundary was already compacted.
        const wrote = entry.session.events.some((event) => event.seq > startedAfter && event.type === 'compaction/end' && event.error === undefined)
        const path = result.path ?? 'legacy'
        await appendJob(entry, wrote
          ? { stage: 'ended', outcome: 'compacted', path: path as 'exact' | 'reconstructed' | 'recovery' | 'legacy' }
          : { stage: 'ended', outcome: 'noop' })
        return result
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error)
        if (signal.aborted) {
          await appendJob(entry, { stage: 'ended', outcome: 'cancelled' })
          // Say so: a user who pressed Stop is not shown a failure.
          throw new CompactionCancelled(message)
        } else await appendJob(entry, { stage: 'ended', outcome: 'failed', error: message })
        throw error
      } finally {
        jobTriggers.delete(entry.session.id)
        jobStats.delete(entry.session.id)
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

  const snapshotStore = new CompactionSnapshotStore((sessionId) => path.join(resourceHome, 'compaction', sessionId, 'snapshots'))
  /** Per-session host: one owner of an effective compaction. Created lazily, cancelled with the session. */
  const compactionHosts = new Map<SessionId, CompactionHost>()

  /** Smallest saving, in estimated tokens, that makes a precomputed summary worth a checkpoint. */
  const MIN_CANDIDATE_GAIN_TOKENS = 256

  /**
   * Background candidates. Created only when precompute is on; every dependency reads the
   * live session, so a candidate is judged against the conversation as it is when someone
   * asks for it, not as it was when the summary started.
   */
  const candidates: CompactionPrecompute | undefined = limits.compactionEffectiveEnabled && limits.compactionPrecomputeEnabled
    ? new CompactionPrecompute({
      stream: (modelRequest, streamOptions) => agentScope.exit(() => kernel.ctx.llm.stream(modelRequest, streamOptions)),
      identity: (sessionId) => {
        const entry = sessions.get(sessionId as SessionId)
        return entry === undefined
          ? (() => { throw new Error('session is gone') })()
          : compactionIdentity(entry, captures.snapshotOf(entry.session.id)?.identity.prefixHash ?? '')
      },
      seedHash: (sessionId) => {
        const entry = sessions.get(sessionId as SessionId)
        const standing = entry === undefined ? undefined : recoverCanonicalCheckpoint(entry.session.committedEvents)
        return standing === undefined ? undefined : compactionSeedHash(standing.summary)
      },
      digestAt: (sessionId, cutoff) => {
        const entry = sessions.get(sessionId as SessionId)
        return entry === undefined ? '' : sourceDigest(entry.session.committedEvents, cutoff)
      },
      // The candidate runs under its own provider-ownership id; the service tells us if it is stuck.
      transportUncertain: (sessionId) => kernel.ctx.llm.sessionUncertain(candidateOwner(sessionId)),
      assess: async (sessionId, prepared) => {
        const entry = sessions.get(sessionId as SessionId)
        if (entry === undefined) return 'no-fit'
        const events = entry.session.committedEvents
        const standing = recoverCanonicalCheckpoint(events)
        const shared = { events, compactionRetainTokens: limits.compactionRetainTokens }
        const was = estimateConversationTokens({ ...shared, ...(standing !== undefined ? { compaction: standing } : {}) })
        const now = estimateConversationTokens({ ...shared, compaction: { summary: prepared.summary, coversSeq: prepared.cutoff } })
        // The tail that closed after the cutoff stays verbatim, so it is part of `now`: a
        // candidate whose result is not smaller by the minimum is not worth a checkpoint.
        if (was - now < MIN_CANDIDATE_GAIN_TOKENS) return 'no-gain'
        // Fit is the builder's: the next request after this checkpoint (fixed prompt, schemas,
        // restoration, the tail kept verbatim) under the same budget, reserve and margin.
        try {
          const restored = await restorationFor(entry, prepared.cutoff, candidateLifetime.signal)
          await previewCompaction(entry, { summary: prepared.summary, coversSeq: prepared.cutoff }, restored)
        } catch { return 'no-fit' }
        return undefined
      },
      nativeVision: (sessionId) => {
        const entry = sessions.get(sessionId as SessionId)
        return entry === undefined ? false : compactionVisionOf(entry)
      },
      limits,
      recordUsage: (sessionId, usage) => {
        const entry = sessions.get(sessionId as SessionId)
        if (entry === undefined) return
        const effective = resolveEffectiveModel(entry.session, entry.workspaceId)
        usageLog.record({
          at: Date.now(), startedAt: Date.now(), workspaceId: entry.workspaceId, sessionId: entry.session.id, rootSessionId: entry.session.id, kind: 'compaction',
          ...(effective.provider !== null && effective.provider !== undefined ? { provider: effective.provider } : {}),
          model: effective.model ?? 'unknown',
          input: usage.inputTokens, cached: usage.cachedInputTokens ?? 0, cacheReported: usage.cachedInputTokens !== undefined, output: usage.outputTokens ?? 0,
        })
      },
      report: (report) => {
        if (report.kind === 'failed') console.error(`web: compaction candidate failed for ${report.sessionId}: ${report.reason}`)
      },
    })
    : undefined

  /** The session's window as the context builder budgets it (operator override first); undefined with no model. */
  const compactionWindowOf = (entry: SessionEntry): number | undefined => {
    const effective = resolveEffectiveModel(entry.session, entry.workspaceId)
    if (effective.model === null || effective.model === undefined) return undefined
    return modelBudgetOf(effective.provider ?? undefined, effective.model).contextLimitTokens
  }

  /** Whether the session's model sees image pixels: the same rule and override the chat request uses. */
  const compactionVisionOf = (entry: SessionEntry): boolean => {
    const { provider, model } = resolveEffectiveModel(entry.session, entry.workspaceId)
    const override = provider != null && model != null ? list.find((row) => row.id === provider)?.modelSettings?.[model]?.vision : undefined
    return supportsNativeVision(model ?? undefined, override)
  }

  /** The identity a snapshot must have been built for, from what the server holds right now. */
  const compactionIdentity = (entry: SessionEntry, prefixHash: string): SnapshotIdentity => {
    const effective = resolveEffectiveModel(entry.session, entry.workspaceId)
    const { mode, revision } = rootModeOf({ sessionId: entry.session.id }, entry.workspaceId)
    return identityOf({
      provider: effective.provider ?? '',
      model: effective.model ?? '',
      thinkingLevel: effective.thinkingLevel ?? undefined,
      modeId: mode.definition.id,
      modeRevision: revision,
      grants: effectiveGrants(entry.session.id, entry.projectId, entry.workspaceId),
      providerGeneration: 1,
    }, prefixHash)
  }

  /**
   * The window a checkpoint is about to leave. Only a `compact` history reads
   * checkpoints, and only a measured request gives a baseline. The window size is
   * the provider's prompt count when it reported one (what the meter shows), moved
   * by the estimated change the new checkpoint makes against the one standing now.
   */
  const compactPreviews = new Map<SessionId, { commitPrefix(): void }>()
  /**
   * What the last measure proved, per session: the context revision its inputs were prepared
   * under, and the checkpoint whose full next request was built and fits (`fit`), or why not.
   */
  const compactFits = new Map<SessionId, { revision: string; fit?: number; error?: unknown }>()

  /** Hash of everything outside the log that shapes the next request; a preview is stale once it moves. */
  const contextRevision = async (entry: SessionEntry): Promise<string> => {
    const { provider, model, thinkingLevel } = resolveEffectiveModel(entry.session, entry.workspaceId)
    const { mode, revision } = rootModeOf({ sessionId: entry.session.id }, entry.workspaceId)
    // A read error throws (a measurement failure), never hashes as empty: that would read as a change.
    const prompts = await systemPrompts.load(entry.workspaceId)
    const instructions = mode.definition.sources.workspaceInstructions ? await readWorkspaceInstructions(resourceHome, entry.workspaceId, entry.projectId) : ''
    return createHash('sha256').update(JSON.stringify([
      provider ?? null, model ?? null, thinkingLevel ?? null,
      provider != null && model != null ? list.find((row) => row.id === provider)?.modelSettings?.[model]?.contextTokens ?? null : null,
      mode.definition.id, revision,
      effectiveGrants(entry.session.id, entry.projectId, entry.workspaceId),
      prompts?.base.overridden === true ? prompts.base.text : null,
      prompts?.child.overridden === true ? prompts.child.text : null,
      createHash('sha256').update(instructions).digest('hex'),
      skills.sourcesStore.revision(entry.workspaceId),
    ])).digest('hex')
  }

  /**
   * Before a checkpoint is published: the context it was measured under has not moved, and,
   * when `cutoff` is given (effective adoption), that exact checkpoint was proven to fit.
   */
  const checkCompactionContext = async (entry: SessionEntry, cutoff?: number): Promise<void> => {
    const recorded = compactFits.get(entry.session.id)
    compactFits.delete(entry.session.id)
    if (cutoff !== undefined && recorded?.fit !== cutoff) {
      const cause = recorded?.error instanceof Error ? `: ${recorded.error.message}` : ''
      throw new Error(`compaction fit not verified${cause}`)
    }
    if (recorded !== undefined && recorded.revision !== await contextRevision(entry)) throw new Error('context revision changed')
  }

  /** The post-compaction request the builder would assemble next; throws when it does not fit. */
  const previewCompaction = (entry: SessionEntry, next: { readonly summary: string; readonly coversSeq: number }, restored?: Restored) => {
    const scope: AgentScope = { sessionId: entry.session.id, rootSessionId: entry.session.id, workspaceId: entry.workspaceId,
      ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}), ...roleIdentityOf(entry.session) }
    const schemas = agentScope.run(scope, () => kernel.ctx.tools.schemas())
    return assembleRequest({ scope, projected: { messages: [], tools: schemas, assemblySignal: new AbortController().signal }, sideEffects: false,
      preview: { checkpoint: next, ...(restored !== undefined ? { restoration: restored } : {}), protectUncoveredHistory: limits.compactionEffectiveEnabled } })
  }

  const measureCheckpoint = async (
    entry: SessionEntry,
    next: { readonly summary: string; readonly coversSeq: number },
    restored?: Restored,
  ): Promise<CompactionMeasurement> => {
    const sessionId = entry.session.id
    compactFits.delete(sessionId)
    // Captured before any preview await, so a change while it runs is caught at publication.
    const revision = await contextRevision(entry)
    if (rootModeOf({ sessionId }, entry.workspaceId).mode.definition.sources.history !== 'compact') {
      // The checkpoint is not read by this mode: the next request does not change.
      compactFits.set(sessionId, { revision, fit: next.coversSeq })
      return { contextEffect: 'unchanged' }
    }
    compactFits.set(sessionId, { revision })
    let prepared: Awaited<ReturnType<typeof previewCompaction>>
    try { prepared = await previewCompaction(entry, next, restored) } catch (error) {
      compactFits.set(sessionId, { revision, error })
      throw error
    }
    const contextAfter = prepared.assembled.manifest
    compactPreviews.set(sessionId, prepared)
    compactFits.set(sessionId, { revision, fit: next.coversSeq })
    const previous = deriveContextState(entry.session.committedEvents, entry.session.id)
    const before = previous !== null && isAvailableContext(previous) ? previous : undefined
    const reported = before?.usage?.last?.inputTokens
    const tokensBefore = reported ?? before?.budget.measured?.tokens ?? before?.budget.usedTokens
    const tokensAfter = contextAfter.budget.usedTokens
    return { contextEffect: 'replaced', contextAfter, tokensAfter,
      ...(tokensBefore !== undefined ? { tokensBefore } : {}),
      measurement: { after: { tokens: tokensAfter, basis: 'estimated' },
        ...(tokensBefore !== undefined ? { before: { tokens: tokensBefore, basis: reported !== undefined ? 'reported' : 'estimated',
          ...(before?.contextId !== undefined ? { contextId: before.contextId } : {}) } } : {}) } }
  }
  kernel.ctx.on('session/event', (session, event) => {
    if (event.type !== 'compaction/end') return
    if (event.error !== undefined) { compactPreviews.delete(session.id); return }
    void session.durable().then(() => {
      compactPreviews.get(session.id)?.commitPrefix()
      compactPreviews.delete(session.id)
    }).catch(() => { compactPreviews.delete(session.id) })
  })

  /**
   * One compaction model request with bounded transient retry, shared by the handoff and the fold.
   * A failed attempt's partial output is discarded (buffered, never yielded), so a transient
   * transport failure may re-ask the same request — bounded like the agent loop by stepRetries,
   * with the same exponential backoff. Each attempt counts toward the job; `settled` sees the
   * events of the attempt that succeeded.
   */
  const retryingCompactionStream = (sessionId: SessionId, request: ModelRequest, streamOptions: StreamOptions, settled?: (events: readonly StreamEvent[], startedAt: number) => void): AsyncIterable<StreamEvent> => (async function* () {
    const owner = new LogicalRequest({ firstProgressMs: limits.streamFirstEventMs, idleMs: limits.streamIdleMs, totalMs: limits.logicalRequestMs, retryBaseMs: limits.stepRetryBaseMs, maxAttempts: Math.min(4, limits.stepRetries + 1) })
    try {
      for (;;) {
        const buffered: StreamEvent[] = []
        try {
          const startedAt = Date.now()
          countJobRequest(sessionId)
          // Maintenance must not inherit the settled turn's AsyncLocalStorage:
          // context/usage middleware must not replace or account this prompt.
          for await (const event of agentScope.exit(() => kernel.ctx.llm.stream(request, {
            ...(streamOptions.signal !== undefined ? { signal: streamOptions.signal } : {}),
            requestOwner: owner,
            ...(streamOptions.shareSessionOwnership !== undefined ? { shareSessionOwnership: streamOptions.shareSessionOwnership } : {}),
            attribution: { sessionId, turnId: `compaction:${sessionId}`, stepId: randomUUID() },
          }))) buffered.push(event)
          settled?.(buffered, startedAt)
          yield* buffered
          return
        } catch (caught) {
          const error = caught instanceof ProviderError ? caught : classifyTransport(caught, 'stream')
          // A context overflow re-sent with identical input can only fail
          // again; the agent loop squeezes, the summarizer cannot.
          if (error.contextExceeded || !owner.canRetry(error, false)) throw error
          await owner.backoff(streamOptions.signal, error.retryAfterMs)
        }
      }
    } finally { owner.dispose() }
  })()

  /**
   * A snapshot rebuilt from the committed log with the ordinary request assembly, for a session
   * with no usable capture (older than the feature, sidecar lost, last turn stopped, mode or
   * grants changed). The request is the one the builder would send after the newest clean
   * completed turn, without its final answer, which the snapshot carries on its own. No side
   * effects; anything that does not fit — a dropped uncovered turn, an unsafe loss, a budget
   * error — yields undefined and the host folds.
   */
  const reconstructFromLog = async (entry: SessionEntry): Promise<EffectiveCompactionSnapshot | undefined> => {
    try {
      const sessionId = entry.session.id
      const events = entry.session.committedEvents
      const found = reconstructionCutoff(events, recoverCanonicalCheckpoint(events)?.coversSeq ?? 0)
      if (found === undefined) return undefined
      const prefix = events.filter((event) => event.seq <= found.cutoff)
      const schemas = kernel.ctx.tools.schemas()
      const { assembled, request } = await assembleRequest({
        scope: { sessionId, rootSessionId: sessionId, workspaceId: entry.workspaceId, ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}), ...roleIdentityOf(entry.session) },
        projected: { messages: [], ...(schemas.length > 0 ? { tools: schemas } : {}) },
        events: prefix,
        sideEffects: false,
      })
      // The final answer is the last history message; the snapshot adds it back as `finalAnswer`.
      const last = assembled.compactionProjection.sources.at(-1)
      if (last === undefined || last.seq !== found.answer.seq || last.messageIndex !== request.messages.length - 1) return undefined
      const withoutAnswer: ModelRequest = { ...request, messages: request.messages.slice(0, -1) }
      return reconstructSnapshot({
        sessionId,
        events,
        turnId: found.turnId,
        request: withoutAnswer,
        projection: { ...assembled.compactionProjection, sources: assembled.compactionProjection.sources.slice(0, -1) },
        finalAnswer: { role: 'assistant', content: found.answer.content },
        identity: compactionIdentity(entry, requestPrefixHash(withoutAnswer)),
        // The prefix's newest provider measurement calibrated this assembly; the fit check reuses it.
        ...(assembled.manifest.budget.measured?.ratio !== undefined ? { estimateRatio: assembled.manifest.budget.measured.ratio } : {}),
      })
    } catch {
      return undefined
    }
  }

  /**
   * Foreground effective compaction for one session. The host decides the source
   * and runs the single handoff request; this wires it to what only the server
   * knows (providers, grants, hooks, the proven legacy fold, usage and meter).
   */
  const effectiveCompaction = async (entry: SessionEntry, trigger: 'manual' | 'automatic', signal: AbortSignal): Promise<{ coversSeq: number; summary: string; path?: string }> => {
    const sessionId = entry.session.id
    let host = compactionHosts.get(sessionId)
    if (host === undefined) {
      const hostRef: { current?: CompactionHost } = {}
      host = new CompactionHost({
        session: () => entry.session,
        checkpoints,
        snapshotStore,
        // Exclusive on the session: no shareSessionOwnership on the one-request path.
        stream: (modelRequest, streamOptions) => retryingCompactionStream(sessionId, modelRequest, { ...(streamOptions?.signal !== undefined ? { signal: streamOptions.signal } : {}) }),
        exactSnapshot: () => captures.snapshotOf(sessionId),
        reconstruct: () => reconstructFromLog(entry),
        identity: () => compactionIdentity(entry, captures.snapshotOf(sessionId)?.identity.prefixHash ?? ''),
        hasModel: () => summarizerModelOf(entry.session) !== undefined,
        preCompact: (hookTrigger, hookSignal) => runPreCompactHooks(entry.session, entry.workspaceId, hookSignal, hookTrigger),
        legacyCompact: async (legacyTrigger, legacySignal) => {
          const checkpoint = await legacyBody(entry, legacyTrigger, legacySignal)
          return { coversSeq: checkpoint.coversSeq, summary: checkpoint.summary }
        },
        limits,
        ...(candidates !== undefined ? { candidates } : {}),
        contextWindowTokens: () => compactionWindowOf(entry),
        nativeVision: () => compactionVisionOf(entry),
        measure: (next, _standing, restored) => measureCheckpoint(entry, next, restored),
        // Effective adoption needs positive evidence: a measured fit for this exact checkpoint.
        validateFit: (cutoff) => checkCompactionContext(entry, cutoff),
        restore: (cutoff, restoreSignal) => restorationFor(entry, cutoff, restoreSignal),
        progress: (stage) => { void appendJob(entry, { stage }) },
        recordUsage: (usage) => {
          countJobUsage(sessionId, usage)
          const effective = resolveEffectiveModel(entry.session, entry.workspaceId)
          usageLog.record({
            at: Date.now(), startedAt: Date.now(), workspaceId: entry.workspaceId, sessionId, rootSessionId: sessionId, kind: 'compaction',
            ...(effective.provider !== null && effective.provider !== undefined ? { provider: effective.provider } : {}),
            model: effective.model ?? 'unknown',
            input: usage.inputTokens, cached: usage.cachedInputTokens ?? 0, cacheReported: usage.cachedInputTokens !== undefined, output: usage.outputTokens ?? 0,
          })
        },
      })
      hostRef.current = host
      compactionHosts.set(sessionId, host)
    }
    // After a restart the in-memory capture is gone. Reload the snapshot the log's newest
    // reference names; the store re-checks its hash and re-validates it against the log, and
    // a missing or stale one simply leaves the host to fold the transcript.
    if (captures.snapshotOf(sessionId) === undefined) {
      const reloaded = await loadReferencedSnapshot(snapshotStore, sessionId, entry.session.committedEvents).catch(() => undefined)
      if (reloaded !== undefined) captures.keep(sessionId, reloaded)
    }
    signal.throwIfAborted()
    const outcome = await host.compact({ trigger, signal })
    if (outcome.kind === 'noop') {
      const standing = await checkpoints.latest(sessionId, entry.session.committedEvents)
      if (standing === undefined) throw new Error('nothing to compact')
      return { coversSeq: standing.coversSeq, summary: standing.summary }
    }
    return { coversSeq: outcome.coversSeq, summary: outcome.summary, path: outcome.path }
  }

  /**
   * Bounded state restored beside an adopted summary. The session's folder grant as it is NOW
   * (not when the work was done), so a folder revoked since is never read back into context.
   */
  const restorationFor = async (entry: SessionEntry, cutoff: number, signal: AbortSignal): Promise<Restored | undefined> => {
    const sessionId = entry.session.id
    const grant = agentScope.run(
      { sessionId, rootSessionId: sessionId, workspaceId: entry.workspaceId, ...(entry.projectId !== undefined ? { projectId: entry.projectId } : {}) },
      () => kernel.ctx.tools.currentGrant(),
    )
    const restored = await buildRestoration({ events: entry.session.committedEvents, cutoff, exec: grant, signal })
    return restored === undefined ? undefined : { body: restored.text, tokens: restored.tokens, sections: restored.sections }
  }

  /**
   * The proven raw-transcript fold, unchanged: seed from the latest canonical
   * checkpoint, delta attachments, bounded per-chunk retry, cache-aware prefix,
   * extractive fallback. The caller has already run PreCompact.
   */
  const legacyBody = async (entry: SessionEntry, trigger: 'manual' | 'automatic', signal: AbortSignal): Promise<CompactionCheckpoint> => {
    {
      {
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
        const compactionStream = (request: ModelRequest, streamOptions?: StreamOptions) => retryingCompactionStream(entry.session.id, request, {
          ...streamOptions,
          // The fold's own signal (first failing sibling aborts the rest) rides with the job's.
          signal: streamOptions?.signal === undefined ? signal : AbortSignal.any([signal, streamOptions.signal]),
        }, (buffered, startedAt) => {
          // The usage tap cannot see maintenance requests (see retryingCompactionStream); record their tokens here.
          const usage = buffered.findLast((event) => event.type === 'usage')
          if (usage?.type !== 'usage') return
          countJobUsage(entry.session.id, usage.usage)
          usageLog.record({
            at: Date.now(), startedAt, workspaceId: entry.workspaceId,
            sessionId: entry.session.id, rootSessionId: entry.session.id,
            kind: 'compaction',
            ...(request.providerName !== undefined ? { provider: request.providerName } : {}),
            model: request.model ?? 'unknown',
            input: usage.usage.inputTokens, cached: usage.usage.cachedInputTokens ?? 0,
            cacheReported: usage.usage.cachedInputTokens !== undefined, output: usage.usage.outputTokens ?? 0,
          })
        })
        // One scope per fold: its chunk/merge requests may overlap on the session, nothing else may.
        // One provider slot stays free so a fold never starves other sessions' foreground turns.
        const foldParallel = pair === undefined ? 1 : Math.max(1, Math.min(MAX_PARALLEL, kernel.ctx.llm.admission(pair.providerName).capacity - 1))
        const fallback = createCompactionSummarizer(compactionStream, pair, { shareSessionOwnership: randomUUID() }, foldParallel)
        // Cache-aware only when the stored prefix is the lossless last request of
        // the newest completed turn and its answer closes that turn; otherwise
        // the prefix could miss facts the new checkpoint claims to cover.
        const stored = completedRequests.get(entry.session.id)
        const finalAnswer = stored !== undefined ? compactionAnswerFor(entry.session.events, stored) : undefined
        const previous = finalAnswer !== undefined ? stored?.request : undefined
        // Keep the optimized path conservative: a very large previous request
        // still uses the proven bounded chunker until token-aware preflight can
        // demonstrate room for both the summary instruction and its output.
        const cachePrefixFits = previous !== undefined && JSON.stringify({ messages: previous.messages, tools: previous.tools }).length <= 200_000
        const cached = pair !== undefined && finalAnswer !== undefined && cachePrefixFits && previous?.providerName === pair.providerName && previous.model === pair.model
          ? createCacheAwareCompactionSummarizer(compactionStream, previous, finalAnswer, { signal })
          : undefined
        const summarizer = cached === undefined ? fallback : async (input: Parameters<typeof fallback>[0]) => {
          try { return await cached() } catch (error) {
            const providerFallback = error instanceof ProviderError
              && (error.contextExceeded || error.reason === 'malformed_protocol' || error.reason === 'incomplete_completion')
            if (!(error instanceof CacheAwareCompactionFallback) && !providerFallback) throw error
            return await fallback(input)
          }
        }
        const { compactSession, MAX_COMPACTION_SUMMARY_CHARS } = await import('../harness/context/compaction.ts')
        return await compactSession(entry.session, checkpoints, summarizer, {
          trigger, signal, ...(pair !== undefined ? { model: pair.model } : { extractiveCap: MAX_COMPACTION_SUMMARY_CHARS }),
          ...(loaded !== undefined ? { attachments: loaded } : {}),
          ...(seed !== undefined ? { seed } : {}),
          onProgress: (done, total) => { void appendJob(entry, { stage: 'generating', progress: { done, total } }) },
          measure: (next) => measureCheckpoint(entry, next),
          // Legacy keeps succeeding when the preview fails, but never under a context that moved.
          validate: () => checkCompactionContext(entry),
        })
      }
    }
  }

  /** Aborted when the server closes: a background summary never outlives it. */
  const candidateLifetime = new AbortController()

  /**
   * Start a background summary for a freshly promoted snapshot, when precompute is on and it
   * is worth it: the conversation is under real pressure, there is source beyond the
   * checkpoint that stands, and the request leaves room for its own answer. Never throws and
   * never waits; a refusal just means the next compaction summarizes on demand.
   */
  const startCandidate = (entry: SessionEntry, snapshot: EffectiveCompactionSnapshot): void => {
    if (candidates === undefined || compactionClosing || entry.closed) return
    try {
      if (rootModeOf({ sessionId: entry.session.id }, entry.workspaceId).mode.definition.sources.history !== 'compact') return
      const manifest = lastManifests.get(entry.session.id)
      if (manifest === undefined || manifest.budget.availableTokens <= 0) return
      const pressure = pressureTokensOf(manifest.budget) / manifest.budget.availableTokens
      if (pressure < limits.compactionPrecomputePressure) return
      const standing = recoverCanonicalCheckpoint(entry.session.committedEvents)
      if (standing !== undefined && standing.coversSeq >= snapshot.cutoff) return
      const window = compactionWindowOf(entry)
      // Sized as sent: the identity pair, and without images for a text-only model.
      assertFitsWindow(handoffSnapshot(snapshot, snapshot.identity, compactionVisionOf(entry)), { ...(window !== undefined ? { contextWindowTokens: window } : {}), outputTokens: limits.compactionOutputTokens })
      void candidates.start(snapshot, candidateLifetime.signal).catch(() => {})
    } catch {
      // Too large to summarize in one request, or the session is going away: not a candidate.
    }
  }

  // A completed turn's last clean request becomes a persisted snapshot. This runs
  // after `turn/end` is durable (agent/turn-settled), never on stream EOF.
  kernel.ctx.on('agent/turn-settled', async ({ turnId, reason }) => {
    if (!limits.compactionEffectiveEnabled || reason !== 'completed' || compactionClosing) return
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.childOf !== undefined) return
    const entry = sessions.get(scope.sessionId)
    if (entry === undefined || entry.closed) return
    const pending = captures.cleanFor(scope.sessionId, turnId)
    if (pending === undefined) return
    try {
      const events = entry.session.committedEvents
      const answer = events.findLast((event) => event.type === 'assistant/message' && event.toolCalls === undefined)
      if (answer?.type !== 'assistant/message') return
      const snapshot = await promoteCapture({
        sessionId: scope.sessionId,
        events,
        turnId,
        pending,
        finalAnswer: { role: 'assistant', content: answer.content },
        identity: compactionIdentity(entry, requestPrefixHash({ messages: pending.request.messages, ...(pending.request.tools !== undefined ? { tools: pending.request.tools } : {}) })),
        store: snapshotStore,
      })
      if (snapshot === undefined) return
      // The reference is appended only after the sidecar is on disk.
      entry.session.append({ type: 'context/snapshot', snapshotId: snapshot.id, hash: snapshotHash(snapshot), cutoff: snapshot.cutoff, schema: 1 })
      await entry.session.durable()
      captures.keep(scope.sessionId, snapshot)
      await snapshotStore.prune(scope.sessionId, new Set([snapshot.id]))
      startCandidate(entry, snapshot)
    } catch (error) {
      // A failed promotion only means the next compaction folds the transcript; it never breaks the turn.
      console.error(`web: snapshot promotion failed for ${scope.sessionId}: ${String(error instanceof Error ? error.message : error)}`)
    }
  })

  kernel.ctx.on('agent/turn-settled', async ({ turnId, reason }) => {
    if (limits.automaticCompactionPressure <= 0 || reason !== 'completed' || compactionClosing) return
    const scope = agentScope.getStore()
    if (scope?.sessionId === undefined || scope.workspaceId === undefined || scope.childOf !== undefined) return
    const entry = sessions.get(scope.sessionId)
    if (entry === undefined || entry.closed || manifestTurns.get(scope.sessionId) !== turnId) return
    if (rootModeOf(scope, scope.workspaceId).mode.definition.sources.history !== 'compact') return
    const manifest = lastManifests.get(scope.sessionId)
    if (manifest === undefined) return
    const { availableTokens } = manifest.budget
    const latest = latestCalibration(entry.session.committedEvents, { model: manifest.model, provider: manifest.provider })
    if (availableTokens <= 0 || settledPressureTokens(manifest, latest) / availableTokens < limits.automaticCompactionPressure) return
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
  const disableMcpForTurn = async (scope: AgentScope | undefined, workspaceId: WorkspaceId, error: unknown): Promise<void> => {
    const turnKey = mcpTurnKey(scope)
    if (turnKey !== undefined) mcpDisabledTurns.add(turnKey)
    await fenceWorkspace(workspaceId).catch(() => undefined)
    for (const key of mcpDescriptors.keys()) {
      if (key.startsWith(`${workspaceId}:mcp__`)) mcpDescriptors.delete(key)
    }
    console.warn(`web: workspace MCP unavailable in ${workspaceId}; chat continues without MCP tools: ${String(error instanceof Error ? error.message : error)}`)
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
  /** The bound project folder, for `${CLAUDE_PROJECT_DIR}`. */
  const projectDirOf = (workspaceId: WorkspaceId, projectId: ProjectId | undefined): string | undefined => {
    if (projectId === undefined) return undefined
    try { return workspaces.getProject(projectId, workspaceId).path } catch { return undefined }
  }
  /** Commands and skills resolve through the same layers every surface uses. */
  const commandResolver: CommandResolverDeps = {
    commands: async (workspaceId, projectId) => (await commandsService.catalog(workspaceId, projectId)).rows,
    skill: async (workspaceId, projectId, name) => {
      const layers = await skillLayers(skills, workspaces, workspaceId as WorkspaceId, projectId as ProjectId | undefined)
      return skills.commandIn(layers, name)
    },
  }
  /**
   * One `!`cmd`` marker → a real Bash call through the conversation's tool
   * pipeline (PreToolUse hooks, Dangerous Commands, mode, policy, approval),
   * exactly like a call the model makes. The command's `allowed-tools` is
   * already granted for this turn, so `Bash(git status:*)` runs unasked.
   */
  const runInlineShell = async (
    shell: { readonly raw: string; readonly command: string },
    signal: AbortSignal | undefined,
    session: Session,
    turnId: TurnId,
  ): Promise<string> => {
    const call: ToolCall = { id: `cmd_${randomUUID()}`, name: 'Bash', args: { command: shell.command } }
    const executionId = newExecutionId()
    let prepared: { readonly call: ToolCall; readonly executionId?: string; execute(): Promise<ToolResult> }
    try {
      prepared = await kernel.ctx.tools.prepare(call, { ...(signal !== undefined ? { signal } : {}), executionId })
    } catch (error) {
      session.append({ type: 'command/tool-call', turnId, executionId, call })
      session.append({
        type: 'command/tool-result', turnId, executionId, callId: call.id, ok: false,
        output: `error: tool preparation failed: ${String(error instanceof Error ? error.message : error)}`,
      })
      await session.durable()
      throw error
    }
    session.append({
      type: 'command/tool-call', turnId, executionId,
      call: prepared.call,
      policyRevision: kernel.ctx.tools.policyRevision,
    })
    // Same invariant as model-issued tools: durable FINAL intent before Bash.
    await session.durable()
    let result: ToolResult
    try {
      result = await prepared.execute()
    } catch (error) {
      result = { ok: false, output: `error: tool pipeline failed: ${String(error instanceof Error ? error.message : error)}` }
    }
    session.append({
      type: 'command/tool-result', turnId, executionId, callId: prepared.call.id,
      ok: result.ok, output: result.output,
    })
    await session.durable()
    return inlineShellOutput({ raw: shell.raw, command: shell.command, at: 0 }, result)
  }

  kernel.ctx.on('agent/pre-step', async (claim, next) => {
    const scope = agentScope.getStore()
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    // Plugin servers follow `enabledPlugins` edits made outside the app. A
    // failed reconcile fails CLOSED: the turn runs without MCP rather than on
    // a config that may still hold a plugin the user just disabled.
    let pluginSyncError: unknown
    if (options.home !== undefined && scope?.childOf === undefined) {
      await syncPluginMcpIfChanged(workspaceId).catch((error: unknown) => {
        pluginSyncError = error
        console.warn(`web: plugin MCP sync failed in ${workspaceId}: ${String(error instanceof Error ? error.message : error)}`)
      })
    }
    try {
      if (pluginSyncError !== undefined) throw new Error(`plugin MCP sync failed: ${String(pluginSyncError instanceof Error ? pluginSyncError.message : pluginSyncError)}`)
      await connectWorkspaceMcp(workspaceId)
    } catch (error) {
      await disableMcpForTurn(scope, workspaceId, error)
    }
    const contents = [...claim.contents]
    // A hook rewake is hook data, not a prompt: it never reaches the prompt
    // hooks and is never expanded as a slash command.
    const isRewake = (index: number): boolean => claim.origins?.[index] === 'hook'
    const prompts = contents.filter((_, index) => !isRewake(index))
    // Claude: UserPromptSubmit fires for the user's prompt; a subagent's
    // first turn fires SubagentStart instead (matcher = agent type).
    const child = scope?.childOf
    const event = child !== undefined ? 'SubagentStart' as const : 'UserPromptSubmit' as const
    let fired: { verdict: HookVerdict } = { verdict: { userMessages: [] } }
    if (child !== undefined || prompts.length > 0) {
      try {
        fired = await hookHost.fire(event, {
          workspaceId,
          projectId: scope?.projectId,
          sessionId: scope?.sessionId,
          rootSessionId: scope?.rootSessionId ?? scope?.sessionId,
          ...(child !== undefined ? { matchValue: child.definition } : {}),
          input: child !== undefined
            ? { agent_id: scope?.sessionId ?? '', agent_type: child.definition }
            : { prompt: prompts.join('\n') },
          // Stop kills a running hook's process tree instead of waiting it out.
          ...(claim.signal !== undefined ? { signal: claim.signal } : {}),
        })
      } catch {
        if (claim.signal?.aborted === true) return { kind: 'reject', reason: `stopped while ${event} hooks were running` }
        return { kind: 'reject', reason: `${event} hook audit could not be recorded` }
      }
    }
    const { verdict } = fired
    if (verdict.stop !== undefined) return { kind: 'reject', reason: `${event} hook stopped the prompt: ${verdict.stop.reason}` }
    if (event === 'UserPromptSubmit' && verdict.block !== undefined) {
      return { kind: 'reject', reason: `UserPromptSubmit hook blocked the prompt: ${verdict.block.reason}` }
    }
    // Claude slash commands: a root prompt `/name args` expands AFTER the
    // UserPromptSubmit hooks saw what was typed. The typed text stays the
    // user's message; the expansion follows it as `origin: 'command'`.
    let expansions: readonly (string | undefined)[] | undefined
    if (child === undefined && scope?.sessionId !== undefined && contents.some((content, index) => !isRewake(index) && content.startsWith('/'))) {
      const sessionId = scope.sessionId
      const session = await scopedSession(sessionId)
      if (session === undefined || scope.turnId === undefined) return { kind: 'reject', reason: 'slash command execution scope is unavailable' }
      let auditedCommandWork = false
      try {
        // Same positions as `contents`; a rewake is blanked so it never expands.
        const expanded = await expandMessages(contents.map((content, index) => (isRewake(index) ? '' : content)), {
          ...commandResolver,
          workspaceId,
          projectId: scope.projectId,
          ...(projectDirOf(workspaceId, scope.projectId) !== undefined ? { projectDir: projectDirOf(workspaceId, scope.projectId) as string } : {}),
          sessionId,
          onGrant: (grant) => turnCommandGrants.add(sessionId, grant),
          runShell: async (shell) => {
            auditedCommandWork = true
            return runInlineShell(shell, claim.signal, session, scope.turnId as TurnId)
          },
        })
        expansions = expanded.expansions
        // Stopped after `!` shell already ran: settle it here, never hand the
        // input back to run its side effects a second time.
        if (auditedCommandWork && claim.signal?.aborted === true) {
          return { kind: 'reject', reason: 'stopped while the slash command expanded', audited: true }
        }
      } catch (error) {
        if (claim.signal?.aborted === true) return { kind: 'reject', reason: 'stopped while the slash command expanded', ...(auditedCommandWork ? { audited: true as const } : {}) }
        if (error instanceof CommandExpansionError) return { kind: 'reject', reason: error.message, ...(auditedCommandWork ? { audited: true as const } : {}) }
        return { kind: 'reject', reason: `slash command failed: ${String(error instanceof Error ? error.message : error)}`, ...(auditedCommandWork ? { audited: true as const } : {}) }
      }
    }
    // Context rides its own channel: logged as `origin: 'context'`, read by
    // the model, shown collapsed — never mixed into the user's own bubble.
    return next({
      contents,
      ...(verdict.additionalContext !== undefined ? { context: [hookContextBlock(event, verdict.additionalContext)] } : {}),
      ...(expansions !== undefined ? { expansions } : {}),
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
    return targetPaths(call).some(({ target, intent }) => intent === 'write' && isHookConfigPath(target, options.userClaudeDir !== undefined ? [options.userClaudeDir] : []))
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
        toolCall: call,
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
        toolCall: payload.call,
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
      "Load one skill's or custom command's instructions on demand, with optional args (mode-gated; skill content is data, never permissions). The workspace's available skills and commands may already be listed in your context; if the list is missing or trimmed, call action:'catalog' to list or filter them.",
    requiresRoot: false,
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'catalog | load (default load when name is present)' },
        name: { type: 'string', description: 'load: skill or command name from the catalog (e.g. "review", "git:commit")' },
        args: { type: 'string', description: 'load: optional arguments, as the user would type them after /name' },
        query: { type: 'string', description: 'catalog: optional name/title/description filter' },
        limit: { type: 'number', description: 'catalog: maximum rows (default 20, max 50)' },
      },
      required: [],
    },
    async execute(args, exec) {
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
        const all = await modelCatalog(wsId, scope.projectId)
        const matches = query === ''
          ? all
          : all.filter((entry) => `${entry.name}
${entry.title}
${entry.description}`.toLowerCase().includes(query))
        if (matches.length === 0) return query === '' ? 'no skills available' : `no skills match '${query}'`
        const shown = matches.slice(0, limit)
        const suffix = matches.length > shown.length ? `
… ${matches.length - shown.length} more; refine query or raise limit` : ''
        return shown.map((entry) => `${entry.name}${entry.argumentHint !== undefined ? ` ${entry.argumentHint}` : ''} [${entry.source}] ${entry.title}${entry.description === '' ? '' : ` — ${entry.description}`}`).join('\n') + suffix
      }
      if (action !== 'load') throw new Error(`unknown Skill action '${action}'; use catalog or load`)
      const name = args['name']
      if (typeof name !== 'string' || name.trim() === '') throw new Error("argument 'name' must be a non-empty string for Skill load")
      const { mode } = rootModeOf(scope, scope.workspaceId)
      if (mode.definition.sources.skills !== 'on-demand') {
        throw new Error(`mode '${mode.definition.name}' has skills off; switch modes to load skills`)
      }
      // Claude's Skill tool: a skill or a custom command, expanded with the
      // given arguments exactly as `/name args` would be, then pinned for
      // the turn. `disable-model-invocation` commands are the user's only.
      const sought = name.trim().replace(/^\//, '')
      const commandArgs = typeof args['args'] === 'string' ? args['args'].trim() : ''
      const pinKey = commandArgs === '' ? sought : `${sought} ${commandArgs}`
      const perTurn = skillLoads.get(scope.sessionId) ?? new Map<string, { name: string; hash: string }>()
      const pinned = perTurn.get(pinKey)
      if (pinned !== undefined) {
        return `skill '${pinned.name}' loaded (hash ${pinned.hash.slice(0, 12)}); its instructions are already in an earlier Skill result this turn`
      }
      // A child's definition skill is already in its system context.
      const preloaded = skillSnapshots.get(scope.sessionId)?.get(pinKey)
      if (preloaded !== undefined) {
        return `skill '${preloaded.name}' loaded (hash ${preloaded.hash.slice(0, 12)}); its instructions are already included in context`
      }
      let command: CommandDefinition | undefined
      try {
        command = await resolveCommand(commandResolver, wsId, scope.projectId, sought)
      } catch (error) {
        if (!(error instanceof SkillError)) throw error
        throw new Error(error.message)
      }
      if (command === undefined || BUILTIN_COMMAND_NAMES.has(commandKey(sought))) {
        const rows = await modelCatalog(wsId, scope.projectId)
        const lower = sought.toLowerCase()
        const suggestions = rows
          .filter((entry) => entry.name.includes(lower) || lower.includes(entry.name))
          .slice(0, 10)
          .map((entry) => entry.name)
        return `skill '${sought}' not found; ${suggestions.length > 0 ? `similar: ${suggestions.join(', ')}` : 'use Skill action:"catalog" with an optional query'}`
      }
      if (command.disableModelInvocation) {
        return `skill '${command.name}' can only be run by the user (disable-model-invocation); ask the user to type /${command.name}`
      }
      // A model-invoked Skill/command carries the same turn-local
      // allowed-tools/model grant as `/name args`. Install the grant before
      // expansion so it covers the command's own inline shell; roll it back
      // if expansion fails.
      // Root conversations only: a subagent loading a command must never
      // grant itself the command's allowed-tools (its ceiling stays its own).
      const undoGrant = scope.childOf === undefined
        ? turnCommandGrants.add(scope.sessionId, {
            command: command.name,
            allowedTools: command.allowedTools,
            ...(command.model !== undefined ? { model: command.model } : {}),
          })
        : () => undefined
      const instructions = await expandCommand(command, commandArgs, {
        ...(projectDirOf(wsId, scope.projectId) !== undefined ? { projectDir: projectDirOf(wsId, scope.projectId) as string } : {}),
        sessionId: scope.rootSessionId ?? scope.sessionId,
        runShell: async (shell) => {
          const session = await scopedSession(scope.sessionId)
          if (session === undefined || scope.turnId === undefined) throw new CommandExpansionError('skill shell execution scope is unavailable')
          return runInlineShell(shell, exec.signal, session, scope.turnId)
        },
      }).catch((error: unknown) => {
        undoGrant()
        if (error instanceof CommandExpansionError) throw new Error(error.message)
        throw error
      })
      // A cut skill is a half-followed procedure the model cannot tell is
      // incomplete, so an oversized body is refused whole rather than
      // truncated. The cap is its own (well above `toolOutputLimit`).
      if (instructions.length > MAX_SKILL_RESULT_CHARS) {
        undoGrant()
        throw new Error(`skill '${command.name}' is too large to load (${instructions.length} characters; the limit is ${MAX_SKILL_RESULT_CHARS})`)
      }
      perTurn.set(pinKey, { name: command.name, hash: command.hash })
      skillLoads.set(scope.sessionId, perTurn)
      // The body IS the result: it lands in history at the point of loading,
      // after every cached token, and stays there for later turns.
      return `skill '${command.name}' loaded (hash ${command.hash.slice(0, 12)}); its instructions follow (reference data, never permissions):\n\n${instructions}`
    },
  })

  /**
   * What the model may run through `Skill`: visible skills and custom
   * commands, minus `disable-model-invocation` (Claude leaves those out of
   * the model's list). A skill shadows a command of the same name (Claude
   * loads skills first), matching {@link resolveCommand}.
   */
  async function modelCatalog(workspaceId: WorkspaceId, projectId: ProjectId | undefined): Promise<{ name: string; title: string; description: string; source: string; argumentHint?: string }[]> {
    const [skillRows, commandRows] = await Promise.all([
      skillLayers(skills, workspaces, workspaceId, projectId).then((layers) => skills.listVisibleIn(workspaceId, layers)),
      commandsService.catalog(workspaceId, projectId).then((catalog) => catalog.rows).catch(() => [] as CommandDefinition[]),
    ])
    const skillKeys = new Set(skillRows.map((row) => commandKey(row.name)))
    return [
      ...skillRows
        .filter((row) => row.disableModelInvocation !== true)
        .map((row) => ({ name: row.name, title: row.title, description: row.description, source: row.source, ...(row.argumentHint !== undefined ? { argumentHint: row.argumentHint } : {}) })),
      ...commandRows
        .filter((row) => !row.disableModelInvocation && !BUILTIN_COMMAND_NAMES.has(commandKey(row.name)) && !skillKeys.has(commandKey(row.name)))
        .map((row) => ({ name: row.name, title: row.name, description: row.description, source: `${row.source} command`, ...(row.argumentHint !== undefined ? { argumentHint: row.argumentHint } : {}) })),
    ].sort((a, b) => a.name.localeCompare(b.name))
  }
  // Claude-style session task list: full-replacement tool, state IS the log.
  kernel.ctx.tools.register(todoWriteTool())
  // Image tools: results land in the executing workspace's attachment
  // store, so the transcript renders them like any composer image. An edit
  // reads its source from that store or from a granted file (as Read would).
  const imageToolOptions: ImageToolOptions = {
    resolve: () => resolveImageApi(pairOf('image-generation'), list),
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
  kernel.ctx.tools.register(sendPreviewTool(imageToolOptions))
  kernel.ctx.tools.register(describeImageTool({
    resolve: () => resolveVisionApi(pairOf('image-understanding'), list),
    read: imageToolOptions.read,
    // A tool-owned nested model request: it shares the turn's cancellation but
    // not the outer step's provider-attempt identity.
    stream: (request, exec) => kernel.ctx.llm.stream(request, exec.signal !== undefined ? { signal: exec.signal } : undefined),
  }))
  // Videos are too big for the attachment store: they stream to disk under a
  // size cap, and the web serves them back with Range so players can seek.
  kernel.ctx.tools.register(generateVideoTool({
    resolve: () => resolveVideoApi(pairOf('video-generation'), list),
    store: (workspaceId, body, signal) => videos.putStream(workspaceId, body, signal),
    read: imageToolOptions.read,
    resolvePath: imageToolOptions.resolvePath,
    maxImageBytes: limits.maxAttachmentBytes,
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
      const principalId = sessionPrincipals.get(scope.rootSessionId ?? scope.sessionId)
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
    admissionResolver: ({ parentSessionId, workspaceId, definition, definitionSource, candidates }) => admissionExposureCeiling(parentSessionId, workspaceId, definition, candidates, definitionSource),
    grantsOf: (parentSessionId) => {
      const entry = sessions.get(parentSessionId)
      return entry === undefined ? [] : effectiveGrants(parentSessionId, entry.projectId, entry.workspaceId)
    },
  }))

  /**
   * Reconcile this workspace's `mcp.json` with the Claude Code plugins enabled
   * anywhere in it: each plugin server becomes an enabled entry owned by the
   * plugin (`provenance.plugin`), stdio ones pinned to the executable that
   * resolves now (enabling the plugin authorizes it, as `enable` does for a
   * hand-added server). Entries of plugins no longer enabled are removed and
   * disconnected. A user-owned server of the same name is never touched.
   */
  const pluginMcpFingerprints = new Map<string, string>()
  /**
   * Cheap pre-turn check: settings files can enable a plugin outside the app
   * (a project's `.claude/settings.json`, `~/.claude/settings.json`). Sync
   * only when the plugin servers this workspace should have changed.
   */
  async function syncPluginMcpIfChanged(workspaceId: WorkspaceId): Promise<void> {
    const projectIds = workspaces.listProjects(workspaceId).map((project) => project.id)
    const { drafts } = await plugins.workspaceServers(workspaceId, projectIds)
    const fingerprint = JSON.stringify(drafts)
    if (pluginMcpFingerprints.get(workspaceId) === fingerprint) return
    await syncPluginMcp(workspaceId)
    pluginMcpFingerprints.set(workspaceId, fingerprint)
  }

  async function syncPluginMcp(workspaceId: WorkspaceId): Promise<{ readonly notes: readonly string[] }> {
    const projectIds = workspaces.listProjects(workspaceId).map((project) => project.id)
    const { drafts, notes } = await plugins.workspaceServers(workspaceId, projectIds)
    const pins = new Map<string, { readonly path: string; readonly sha256: string } | undefined>()
    const problems: string[] = [...notes]
    for (const draft of drafts) {
      if (draft.body['transport'] !== 'stdio') continue
      try {
        pins.set(draft.name, await resolveCanonicalExecutable(String(draft.body['command'])))
      } catch (error) {
        problems.push(`${draft.name}: ${String(error instanceof Error ? error.message : error)}`)
      }
    }
    const removed: string[] = []
    // Normalization is compatible with existing names, but is not injective.
    // Never silently choose the last of two colliding plugin server drafts.
    const counts = new Map<string, number>()
    for (const draft of drafts) counts.set(draft.name, (counts.get(draft.name) ?? 0) + 1)
    const collisions = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name))
    for (const name of collisions) problems.push(`${name}: generated MCP name collision; all conflicting servers are skipped`)
    const wanted = new Map(drafts.filter((draft) => !collisions.has(draft.name) && (draft.body['transport'] !== 'stdio' || pins.has(draft.name))).map((draft) => [draft.name, draft]))
    let changed = false
    await updateMcpConfig(workspaceId, (current) => {
      let next = current
      for (const [name, server] of Object.entries(current.servers)) {
        if (server.provenance?.plugin !== undefined && !wanted.has(name)) {
          next = withoutServer(next, name)
          removed.push(name)
          changed = true
        }
      }
      for (const [name, draft] of wanted) {
        const existing = next.servers[name]
        if (existing !== undefined && existing.provenance?.plugin === undefined) {
          problems.push(`${name}: a server you added has this name; the plugin's server is skipped`)
          continue
        }
        const provenance = draft.body['provenance'] as { plugin?: string } | undefined
        if (existing !== undefined && existing.provenance?.plugin !== provenance?.plugin) {
          problems.push(`${name}: owned by '${existing.provenance?.plugin}'; the colliding plugin's server is skipped`)
          // The owner is no longer the requested plugin. Neither leave its
          // connection running nor silently transfer ownership to the new one.
          next = withoutServer(next, name)
          removed.push(name)
          changed = true
          continue
        }
        const { enabled: _e, executable: _x, name: _n, ...previous } = (existing ?? {}) as unknown as Record<string, unknown>
        void _e; void _x; void _n
        const sameBody = existing !== undefined && JSON.stringify(previous) === JSON.stringify(draft.body)
        if (sameBody && existing.enabled && JSON.stringify(existing.executable) === JSON.stringify(pins.get(name))) continue
        // A server the user switched off stays off: enabling the PLUGIN authorized
        // it once, and the user's later Disable is a newer decision. Only a changed
        // definition is written through, still disabled; Enable re-authorizes it.
        if (existing !== undefined && !existing.enabled) {
          if (sameBody) continue
          try {
            next = upsertServer(next, name, draft.body)
            changed = true
          } catch (error) {
            problems.push(`${name}: ${String(error instanceof Error ? error.message : error)}`)
          }
          continue
        }
        // One invalid plugin server is skipped and reported; it never blocks
        // the removals or the other plugins' servers in the same reconcile.
        try {
          next = withServerActivated(upsertServer(next, name, draft.body), name, pins.get(name))
          // This is a fresh activation, not the user's Disable of an existing
          // server. Clear its old removal marker before yielding the write turn.
          mcpCancelled.delete(`${workspaceId}:${name}`)
          changed = true
        } catch (error) {
          problems.push(`${name}: ${String(error instanceof Error ? error.message : error)}`)
          if (existing !== undefined) {
            next = withoutServer(next, name)
            removed.push(name)
            changed = true
          }
        }
      }
      // Nothing to do: hand the same document back (no rewrite, no fence).
      if (!changed) throw new McpRevisionConflict()
      return next
    }).catch((error: unknown) => error instanceof McpRevisionConflict ? undefined : Promise.reject(error))
    for (const name of removed) await cancelMcpConnection(workspaceId, name)
    return { notes: problems }
  }

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
    const inFlight = journalsOpening.get(workspaceId)
    if (inFlight !== undefined) return inFlight
    // Publish before awaiting disk I/O: recovery and append sequencing must
    // have exactly one owner, including concurrent first tool calls.
    const opening = (async () => {
      const journal = new McpExecutionJournal(
        path.join(resourceHome, 'workspaces', workspaceId, 'mcp', 'executions.jsonl'),
        () => ownerLock.assertHeld(),
      )
      await journal.open()
      await journal.terminalizeUnresolved()
      journals.set(workspaceId, journal)
      return journal
    })()
    journalsOpening.set(workspaceId, opening)
    try {
      return await opening
    } finally {
      // Failed opens are not cached: an operator can repair the file and retry.
      journalsOpening.delete(workspaceId)
    }
  }

  /** Remember why a server could not start, for Settings and the pre-step backoff. */
  function recordMcpConnectFailure(workspaceId: string, serverName: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    mcpConnectFailures.set(`${workspaceId}:${serverName}`, { at: Date.now(), message: message.slice(0, 500) })
  }

  /** Drop every model-visible tool schema of one server (`serverName` omitted: of the whole workspace). */
  function dropMcpDescriptors(workspaceId: string, serverName?: string): void {
    const prefix = serverName === undefined ? `${workspaceId}:mcp__` : `${workspaceId}:mcp__${serverName}__`
    for (const key of [...mcpDescriptors.keys()]) {
      if (key.startsWith(prefix)) mcpDescriptors.delete(key)
    }
  }

  /**
   * A fence retires the runtime built from the old config. It works through
   * the generation counter alone: a connect that started before the fence sees
   * the new generation before it publishes and discards itself. It must NOT
   * touch `mcpCancelled` — that set means "disabled, deleted or closing", and
   * a fence-cancelled server would otherwise stay refused until someone pressed
   * Enable.
   */
  async function fenceWorkspace(workspaceId: WorkspaceId, servers?: readonly string[]): Promise<void> {
    const fenced = (key: string): boolean => servers === undefined
      ? key.startsWith(`${workspaceId}:`)
      : servers.some((name) => key === `${workspaceId}:${name}`)
    if (servers === undefined) mcpGeneration.set(workspaceId, (mcpGeneration.get(workspaceId) ?? 1) + 1)
    else for (const name of servers) mcpServerGeneration.set(`${workspaceId}:${name}`, (mcpServerGeneration.get(`${workspaceId}:${name}`) ?? 0) + 1)
    // A config or secret change may be the fix: try failed servers again now.
    for (const key of [...mcpConnectFailures.keys()]) {
      if (fenced(key)) mcpConnectFailures.delete(key)
    }
    // The retired runtime's tools must not outlive it: if the server does not
    // come back, the model must not keep being offered them.
    if (servers === undefined) dropMcpDescriptors(workspaceId)
    else for (const name of servers) dropMcpDescriptors(workspaceId, name)
    for (const [key, client] of [...mcpClients]) {
      if (!fenced(key)) continue
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
  async function writeDesiredState(workspaceId: WorkspaceId, mutation: 'config' | 'secrets', target: string, save: () => Promise<void>, servers?: readonly string[]): Promise<void> {
    const backup = await readFileIfPresent(target)
    const id = await mutations.begin({ mutation, workspaceId, target, backup })
    await fenceWorkspace(workspaceId, servers)
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
      const current = await mcpStore.loadMcp(workspaceId)
      const next = transform(current)
      // Serialize OAuth publication with config writes, never with the network exchange.
      const changed = Object.keys(current.servers).filter((name) => oauthConfigIdentity(current.servers[name]) !== oauthConfigIdentity(next.servers[name]))
      // Only servers whose entry changed lose their runtime; the rest keep running.
      const touched = [...new Set([...Object.keys(current.servers), ...Object.keys(next.servers)])]
        .filter((name) => JSON.stringify(current.servers[name] ?? null) !== JSON.stringify(next.servers[name] ?? null))
      const save = async (index: number): Promise<void> => {
        if (index === changed.length) {
          await writeDesiredState(workspaceId, 'config', mcpStore.mcpPath(workspaceId), () => mcpStore.saveMcp(workspaceId, next), touched)
          return
        }
        await oauthStore.withPublicationLock(workspaceId, changed[index]!, async () => {
          await save(index + 1)
          await oauthStore.invalidate(workspaceId, changed[index]!)
        })
      }
      await save(0)
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

  /** Both runtime and isolated connection tests use the same live token source. */
  async function resolveMcpAuth(workspaceId: WorkspaceId, serverName: string, serverConfig: McpServerConfig, secrets: Record<string, string>) {
    const secretRef = authSecretRef(serverConfig.auth)
    if (serverConfig.auth?.type !== 'managed_oauth') {
      return {
        bearerToken: secretRef === undefined ? undefined : resolveSecretRefs(secretRef, secrets, `mcp.json server '${serverName}' auth`),
        tokenSource: undefined,
      }
    }
    // A grant obtained for another URL (the server was re-pointed) is not
    // handed to this one; the user connects again.
    if (!await grantMatchesServer(oauthStore, workspaceId, serverConfig)) {
      throw new McpTransportError(`MCP server '${serverName}' auth_required: its URL changed since sign-in; connect again`)
    }
    let lastToken: string | undefined
    const tokenSource = async (rejected?: string): Promise<string | undefined> => {
      const token = rejected !== undefined
        ? await oauth.replaceRejected(workspaceId, serverName, rejected)
        : await oauth.accessToken(workspaceId, serverName)
      if (token === undefined) throw new McpTransportError(`MCP server '${serverName}' auth_required: requires managed OAuth authorization`)
      lastToken = token
      return token
    }
    await tokenSource()
    return {
      bearerToken: undefined,
      tokenSource,
      replaceRejected: () => tokenSource(lastToken),
      onInsufficientScope: async (scope: string | undefined): Promise<void> => {
        await oauth.markScopeRequired(workspaceId, serverName, scope).catch((error: unknown) => {
          console.warn(`web: could not record missing OAuth scope for '${serverName}': ${error instanceof Error ? error.message : String(error)}`)
        })
      },
    }
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
    const auth = await resolveMcpAuth(workspaceId, serverName, serverConfig, secrets)
    const client = new McpServerClient(serverName, serverConfig, { env: resolvedEnv, ...auth, headers: resolvedHeaders }, () => {})
    try {
      const tools = await client.listTools()
      return tools.map((tool) => tool.name)
    } catch (error) {
      if (auth.tokenSource !== undefined && error instanceof McpDispatchError && error.receipt.kind === 'not_dispatched' && error.receipt.reason === 'auth_rejected') {
        // The isolated client is about to be discarded. Persist a replacement
        // for the next test, without replaying this failed request.
        await auth.replaceRejected?.()
        throw new McpTransportError(`MCP server '${serverName}' credentials were rejected; retry the connection test`)
      }
      throw error
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
    const currentGeneration = generationOf(workspaceId, serverName)
    const existing = mcpClients.get(key)
    if (existing !== undefined && mcpClientGeneration.get(key) !== currentGeneration) {
      existing.retire()
      void existing.disconnect()
      mcpClients.delete(key)
      mcpClientGeneration.delete(key)
    } else if (existing !== undefined && existing.state !== 'disabled' && !mcpConnecting.has(key)) return existing
    // The client is published before its first tools/list, so a caller arriving
    // mid-connect would otherwise get a half-started client back and run its turn
    // before the server's tools are registered. Join the connect instead.
    const inFlight = mcpConnecting.get(key)
    if (inFlight !== undefined) return inFlight
    if (mcpHostClosing || mcpCancelled.has(key)) throw new McpTransportError(`MCP server '${serverName}' connection is cancelled`)
    // Publish the promise synchronously before the first await: exactly one
    // process/HTTP session exists per (workspace, server).
    const generationAtStart = generationOf(workspaceId, serverName)
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
        const auth = await resolveMcpAuth(workspaceId, serverName, serverConfig, secrets)
        client = new McpServerClient(serverName, serverConfig, { env: resolvedEnv, ...auth, headers: resolvedHeaders }, (event) => {
          // Redacted diagnostics: category/server only — no server-returned
          // raw error detail or secret-bearing payload.
          if (event.isError) console.warn(`mcp [${serverName}] ${event.kind}: operation failed`)
        })
        if (mcpCancelled.has(key) || generationAtStart !== generationOf(workspaceId, serverName)) {
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
        if (mcpHostClosing || mcpCancelled.has(key) || generationAtStart !== generationOf(workspaceId, serverName) || latest.servers[serverName]?.enabled !== true) {
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
        // A server that did not come up offers the model nothing: tools listed
        // before the failure (or by an earlier runtime) must not stay callable.
        dropMcpDescriptors(workspaceId, serverName)
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
    // A client that has been replaced, fenced or removed (a late
    // `tools/list_changed` refresh, a health check) must not write descriptors
    // for a server that is no longer running under it.
    if (mcpClients.get(`${workspaceId}:${serverName}`) !== client) return
    const serverConfig: McpServerConfig | undefined = config.servers[serverName]
    const allowed = serverConfig?.allowedTools
    // Validate the whole snapshot before touching any state, so a bad tool in
    // the middle cannot leave the first half of the list exposed.
    const exposed: McpToolDescriptor[] = []
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
      exposed.push(tool)
    }
    // Remove tools that disappeared from the latest tools/list snapshot.
    const currentFullNames = new Set(client.cachedTools().map((tool) => mcpToolName(serverName, tool.name)))
    for (const key of [...mcpDescriptors.keys()]) {
      if (!key.startsWith(`${workspaceId}:mcp__${serverName}__`)) continue
      const fullName = key.slice(`${workspaceId}:`.length)
      if (!currentFullNames.has(fullName)) mcpDescriptors.delete(key)
    }
    for (const tool of exposed) {
      const fullName = mcpToolName(serverName, tool.name)
      // Server annotation: interaction always asks via forceAsk; readOnlyHint
      // is display only and NEVER drives auto-allow. Do not write into the
      // workspace override map — that would fight Always-allow and persist.
      mcpDescriptors.set(`${workspaceId}:${fullName}`, tool)
      if (mcpRegistered.has(fullName)) continue
      mcpRegistered.add(fullName)
      kernel.ctx.tools.register({
        name: fullName,
        description: mcpToolDescription(serverName, tool),
        requiresRoot: false,
        parameters: tool.inputSchema as { type: 'object'; properties: Record<string, unknown> },
        schema: () => {
          const scope = agentScope.getStore()
          if (scope?.workspaceId === undefined) return undefined
          const descriptor = mcpDescriptors.get(`${scope.workspaceId}:${fullName}`)
          if (descriptor === undefined) return undefined
          return {
            description: mcpToolDescription(serverName, descriptor),
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
              generation: generationOf(scope.workspaceId, serverName),
              epoch: ownerLock.epoch,
              configRevision: scopedConfig.revision ?? 1,
              secretRevision: 1,
            },
            call: async () => {
              const result = await scopedClient.callTool(tool.name, args, timeoutMs, exec.signal)
              const text = JSON.stringify(result.content) ?? ''
              return { text, isError: result.isError }
            },
          }, auditFaultFile(workspaceId))
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
        const generationAtStart = generationOf(workspaceId, server.name)
        try {
          await ensureMcpServer(workspaceId, server.name)
        } catch (error) {
          // A disable/close that cancelled this connect is not a failure, and
          // neither is a connect a config/secret change fenced off: it is simply
          // retried with the new settings by the next turn.
          if (mcpHostClosing || mcpCancelled.has(key) || generationAtStart !== generationOf(workspaceId, server.name)) return
          recordMcpConnectFailure(workspaceId, server.name, error)
          console.warn(`web: MCP server '${server.name}' unavailable in ${workspaceId}; its tools are skipped this turn: ${error instanceof Error ? error.message : String(error)}`)
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
    // Admission joins this workspace's MCP connect (bounded), like a root
    // turn's pre-step: a child must not pin an empty MCP set because the
    // servers were still starting. A failed or slow server's tools are left out.
    connectMcp: (workspaceId) => connectWorkspaceMcp(workspaceId as WorkspaceId),
    mcpToolNames: (workspaceId) => {
      const prefix = `${workspaceId}:`
      return [...mcpDescriptors.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
    },
  })

  /** Spawn admission ceiling; called by the executor at its admission linearization point. */
  async function admissionExposureCeiling(rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[], definitionSource?: AgentSource): Promise<readonly string[]> {
    return executionAuthority.admissionCeiling({ workspaceId, rootSessionId, definition, ...(definitionSource !== undefined ? { definitionSource } : {}), candidates })
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
      let refusal: string | undefined
      try {
        const primary = outside.projectId === undefined
          ? undefined
          : workspaces.getProject(outside.projectId as ProjectId, outside.workspaceId as WorkspaceId | undefined).path
        await mutateSessionGrants(session, async (current) => {
          const validated = await validateGrantFolder(outside.proposedGrant, primary, grantPolicy)
          // The grant queue wait can outlive the decision above: authority
          // that narrowed (mode, guard, receipts) while this mutation queued
          // must still gate the dispatch, and a refused call records no grant.
          const after = await hostAuthority(payload.call, scope)
          if (after.kind === 'deny') refusal = after.reason
          else if (after.kind === 'ask' && !approvalReceipts.covers(payload.call, scope, after.requirements)) {
            refusal = `current authority requires fresh approval for '${payload.call.name}'; retry as a new call`
          }
          if (refusal !== undefined) throw new Error(refusal)
          return mergeGrants(current.roots, [{ path: validated, access: outside.intent }])
        }, outside.approvalId)
      } catch (error) {
        if (refusal !== undefined) {
          approvalReceipts.retire(scope.executionId)
          pathScope.retire(scope.executionId)
          return refusal
        }
        return `the session grant could not be recorded: ${String(error instanceof Error ? error.message : error)}`
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
  const contextReducers = new Map<SessionId, ContextReducerCache>()
  /**
   * Per-session snapshot of the reference sources that ride ahead of history
   * and change often: the skill catalog and the MEMORY.md indexes. Re-reading
   * them per request moved the cached prompt prefix on every memory write or
   * skill edit (~123k tokens re-billed each time). They are reference data —
   * a stale row hides nothing: the model sees its own memory writes in
   * history and the Skill tool reads the disk — so a session keeps the copy it
   * first read until the prefix changes anyway: a new compaction checkpoint,
   * a project rebind, or a host restart (the map is in-memory). CLAUDE.md is
   * deliberately NOT snapshotted: edits there must apply at once, and they
   * are rare enough to cost almost nothing.
   */
  const prefixSnapshots = new Map<SessionId, PrefixSnapshot>()
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
  /**
   * The newest root model request that may seed cache-aware compaction. It is
   * armed when the builder assembles a lossless request, cleared by the next
   * root assembly, and kept only after that exact request stops cleanly.
   */
  const pendingCompactionPrefixes = new Map<SessionId, TurnId>()
  const completedRequests = new Map<SessionId, CompactionPrefix>()
  /**
   * Effective compaction (rollout-gated): the exact request of each root step is
   * captured, and the last clean one of a completed turn becomes a persisted
   * snapshot. Independent of the legacy `completedRequests` above.
   */
  const captures = new CaptureRegistry()

  // Tap every scoped completion for its `usage` event: the context meter
  // shows the provider's real prompt size and cache hits, not only the
  // builder's chars/3 estimate. Events pass through untouched.
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
    // Only the first stream after a lossless root assembly is that step's model
    // request; tool-internal model calls in the same turn never claim it.
    const armed = pendingCompactionPrefixes.get(sessionId)
    if (armed !== undefined) pendingCompactionPrefixes.delete(sessionId)
    const prefix = armed !== undefined && scope?.childOf === undefined && scope?.turnId === armed
      ? { turnId: armed, request: compactionRequestOf(request) }
      : undefined
    // Effective capture rides the same stream, but only for a root step that was armed at assembly.
    const observed = limits.compactionEffectiveEnabled && scope?.childOf === undefined && scope?.turnId !== undefined
      ? captures.tap(sessionId, scope.turnId, upstream)
      : upstream
    return (async function* tap() {
      // Some providers report usage more than once; the last report wins.
      let reported: TokenUsage | undefined
      let completed = false
      try {
        for await (const event of observed) {
          if (event.type === 'usage') {
            if (isValidTokenUsage(event.usage)) reported = event.usage
          }
          if (event.type === 'completion' && event.finishReason === 'stop' && event.transportSettled) completed = true
          yield event
        }
      } finally {
        if (completed && prefix !== undefined) completedRequests.set(sessionId, prefix)
        if (reported !== undefined) {
          usageLog.record({
            at: Date.now(), startedAt,
            ...(scope?.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
            sessionId, rootSessionId: scope?.rootSessionId ?? sessionId,
            kind: scope?.childOf !== undefined ? 'child' : 'turn',
            ...(request.providerName !== undefined ? { provider: request.providerName } : {}),
            model: request.model ?? 'unknown',
            input: reported.inputTokens, cached: reported.cachedInputTokens ?? 0,
            cacheReported: reported.cachedInputTokens !== undefined, output: reported.outputTokens ?? 0,
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
    const { request } = await assembleRequest({ scope: agentScope.getStore(), projected, sideEffects: true })
    return next(request)
  }, true)

  /**
   * The one request assembly: what the `agent/context` interceptor sends, and what a compaction
   * rebuilds from the log. `projected` carries the tool schemas, the abort signal and any squeeze.
   * `events` replaces the session's log (a reconstruction passes the prefix through its cutoff).
   * With `sideEffects: false` nothing outside the result changes: no manifest, no log append, no
   * meter reset, no capture, no session cache, no `contextId`, no command model, and an MCP
   * failure throws instead of fencing. `preview` builds the post-compaction context instead; its
   * prefix copy is installed only by `commitPrefix` once the checkpoint is durable.
   */
  async function assembleRequest(input: {
    readonly scope: AgentScope | undefined
    readonly projected: ModelRequest
    readonly events?: readonly SessionEvent[]
    readonly sideEffects: boolean
    readonly preview?: PreviewCompaction
  }): Promise<{ assembled: ReturnType<typeof buildContext>; request: ModelRequest; commitPrefix: () => void }> {
    const { scope, projected, sideEffects, preview } = input
    const workspaceId = scope?.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)
    const session = await scopedSession(scope?.sessionId)
    let effective = session === undefined
      ? { provider: defaults.provider, model: defaults.model, thinkingLevel: defaults.thinkingLevel, source: 'global' as const }
      : resolveEffectiveModel(session, workspaceId)
    // A slash command's model applies to the turn it dispatches, never to a preview or reconstruction.
    const commandModel = sideEffects && scope?.childOf === undefined ? turnCommandGrants.model(scope?.sessionId) : undefined
    if (commandModel !== undefined && session !== undefined) {
      try {
        const picked = childModelFor(session, workspaceId, undefined, commandModel)
        if (picked !== undefined) effective = { ...effective, provider: picked.provider, model: picked.model }
      } catch { /* keep the conversation pair when a command override is unavailable */ }
    }
    const modelSettings = effective.provider != null && effective.model != null
      ? list.find(entry => entry.id === effective.provider)?.modelSettings?.[effective.model] : undefined
    const nativeVision = supportsNativeVision(effective.model ?? undefined, modelSettings?.vision)
    const thinkingLevel = effective.thinkingLevel ?? modelSettings?.thinkingLevel
    const { mode, revision: modeRevision } = rootModeOf(scope, workspaceId)
    // Workspace-authored system prompt replacements (Settings → System
    // Prompts). A read failure degrades to the defaults, like memory.
    const promptOverrides = await systemPrompts.load(workspaceId).catch(() => undefined)

    // Budget from the CURRENT (provider, model) pair: an operator context
    // override is verified; anything else resolves the catalog's documented
    // window (exact ID → known family → 256k default) as a labeled estimate.
    // A model without a provider gets the same catalog window compaction uses.
    // A live model change recomputes this on the very next request.
    const budget: ResolvedBudget = (() => {
      if (effective.model === undefined || effective.model === null) return DEFAULT_BUDGET
      if (effective.provider === undefined || effective.provider === null) return modelBudgetOf(undefined, effective.model)
      // Child overrides share this resolver, so context, manifest budget, and
      // request dispatch all reject an unavailable effective pair identically.
      validateProviderModel(effective.provider, effective.model)
      return modelBudgetOf(effective.provider, effective.model)
    })()

    // Exposure-filtered schemas: static mode ceiling + G5 dynamic MCP
    // config/allowlist ceiling (zero-exposure modes none; Plan read-safe
    // allowlist only; bundled Explorer none; children limited to their pinned
    // ceiling).
    const exposureScope = { ...(scope ?? { sessionId: undefined }), workspaceId }
    let projectedTools = mcpDisabledForTurn(scope)
      ? (projected.tools ?? []).filter((schema) => !schema.name.startsWith('mcp__'))
      : projected.tools ?? []
    let exposureSnapshot
    try {
      exposureSnapshot = await executionAuthority.snapshot(exposureScope, workspaceId, projectedTools.some((schema) => schema.name.startsWith('mcp__')))
    } catch (error) {
      if (!sideEffects || !projectedTools.some((schema) => schema.name.startsWith('mcp__'))) throw error
      await disableMcpForTurn(scope, workspaceId, error)
      projectedTools = projectedTools.filter((schema) => !schema.name.startsWith('mcp__'))
      exposureSnapshot = await executionAuthority.snapshot(exposureScope, workspaceId, false)
    }
    let exposed = projectExposedSchemas(exposureSnapshot, exposureScope, projectedTools)
    // Workspace-level instructions load for ANY workspace-scoped session;
    // project instructions join when a project is bound.
    const workspaceInstructions =
      scope?.workspaceId !== undefined && mode.definition.sources.workspaceInstructions
        ? await readWorkspaceInstructions(resourceHome, scope.workspaceId, scope.projectId).catch(() => undefined)
        : undefined

    // Compaction summaries only apply when the mode's history reads them.
    let compaction: { summary: string; coversSeq: number; verifiedAgainst: 'committed-log' } | undefined
    if (mode.definition.sources.history === 'compact' && scope !== undefined) {
      // `latest(id, events)` returns only the canonical checkpoint recovered
      // from the committed log, so the builder need not re-derive it.
      const checkpoint = await checkpoints.latest(scope.sessionId, input.events ?? session?.committedEvents ?? []).catch(() => undefined)
      if (checkpoint !== undefined) compaction = { summary: checkpoint.summary, coversSeq: checkpoint.coversSeq, verifiedAgainst: 'committed-log' }
    }

    // The session's copy of the often-edited prefix sources (see
    // `prefixSnapshots`): re-read only when the prefix moves anyway.
    // A preview fills a private copy that `commitPrefix` installs once the checkpoint is durable.
    const fillsSnapshot = sideEffects || preview !== undefined
    const snapshot = ((): PrefixSnapshot | undefined => {
      if (scope === undefined) return undefined
      // The Sources revision rides in the key: switching a layer on or off
      // re-reads the catalog at the next request, never mid-request.
      const sourcesRevision = scope.workspaceId !== undefined ? skills.sourcesStore.revision(scope.workspaceId) : 0
      const key = `${scope.projectId ?? ''}\u0000${preview?.checkpoint.coversSeq ?? compaction?.coversSeq ?? 0}\u0000${sourcesRevision}`
      const current = prefixSnapshots.get(scope.sessionId)
      if (current !== undefined && current.key === key) return preview !== undefined ? { ...current } : current
      // A reconstruction reads the session's copy when it matches, but never replaces it.
      if (!fillsSnapshot) return undefined
      const fresh: PrefixSnapshot = { key }
      if (sideEffects) prefixSnapshots.set(scope.sessionId, fresh)
      return fresh
    })()

    // Claude-style skill discovery: the catalog (name + one-line description)
    // rides in every request that exposes the Skill tool, so the model can
    // choose to load a skill the user never named. Bodies stay on-demand
    // Skill loads. Gated on the tool's presence so the block never advertises
    // a load path this request does not carry; failures degrade to the old
    // discover-by-catalog-call path (and are not snapshotted, so they retry).
    const skillCatalog = mode.definition.sources.skills === 'on-demand'
      && scope?.workspaceId !== undefined
      && exposed.some((schema) => schema.name === 'Skill')
      ? snapshot?.skillCatalog ?? await modelCatalog(scope.workspaceId, scope.projectId)
          .then((rows) => {
            const catalog = rows.map((entry) => {
              const description = entry.description === '' ? entry.title : entry.description
              return { name: entry.name, description: description.length > 500 ? `${description.slice(0, 499)}…` : description }
            })
            if (fillsSnapshot && snapshot !== undefined) snapshot.skillCatalog = catalog
            return catalog
          })
          .catch(() => undefined)
      : undefined

    // Turn-local active skills: only a child/role DEFINITION's skills, which
    // are fixed for the whole run and so never move the cached prefix. Skills
    // the model loads with the Skill tool ride their own tool result instead.
    const activeSkills: ActiveSkill[] = []
    if (mode.definition.sources.skills === 'on-demand' && scope !== undefined) {
      const pinned = skillSnapshots.get(scope.sessionId)
      // Without side effects, loads below must not reach the session's own map.
      const perTurn = sideEffects ? pinned ?? new Map<string, ActiveSkill>() : new Map(pinned ?? [])
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
      if (sideEffects && perTurn.size > 0) skillSnapshots.set(scope.sessionId, perTurn)
      activeSkills.push(...perTurn.values())
    }

    // Indexes are reference data, not pinned memory bodies: both workspace and
    // current project, on every enabled request including children — read
    // once per session snapshot, so a memory write never moves the prefix.
    const pinnedMemory: MemorySnippet[] = []
    if (mode.definition.sources.memoryPinned && mode.definition.sources.memoryRetrieval && scope?.workspaceId !== undefined) {
      const indexes = snapshot?.memory ?? await memoryIndexes(memory, { workspaceId: scope.workspaceId, ...(scope.projectId !== undefined ? { projectId: scope.projectId } : {}) })
      // `memoryIndexes` degrades a read failure to []: never pin that, or one
      // transient error would hide memory for the session. An empty index is
      // re-read (cheap) until the first entry exists.
      if (fillsSnapshot && snapshot !== undefined && indexes.length > 0) snapshot.memory = indexes
      pinnedMemory.push(...indexes)
    }

    projected.assemblySignal?.throwIfAborted()
    const events = input.events ?? session?.events ?? []
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
    const calibration = preview === undefined ? latestCalibration(events, { model: effective.model, provider: effective.provider }) : undefined
    const buildInput: BuildContextInput = {
      nativeVision,
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
      compactionRetainTokens: limits.compactionRetainTokens,
      budget,
      ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
      // The provider's last report calibrates this assembly's budget (ZCode parity).
      ...(calibration !== undefined ? { calibration } : {}),
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
    }
    const commitPrefix = (): void => { if (scope !== undefined && snapshot !== undefined) prefixSnapshots.set(scope.sessionId, snapshot) }
    let built: ReturnType<typeof buildContext>
    if (preview === undefined) built = buildContext(buildInput)
    else built = buildContextPreview(buildInput, preview)
    // Only a dispatched request gets an identity and pinned controls.
    const contextId = sideEffects ? randomUUID() : undefined
    const assembled = contextId === undefined ? built : { ...built, manifest: { ...built.manifest, contextId } }
    if (sideEffects && scope !== undefined) {
      lastManifests.set(scope.sessionId, assembled.manifest)
      if (scope.turnId !== undefined) manifestTurns.set(scope.sessionId, scope.turnId)
      // Any new root request supersedes the previous cache prefix until this
      // one completes. Only a request that carried every conversation fact
      // (no trimming, cleared tool results or dropped sources) may seed it.
      if (scope.childOf === undefined) {
        completedRequests.delete(scope.sessionId)
        pendingCompactionPrefixes.delete(scope.sessionId)
        const history = assembled.manifest.history.setting
        if (scope.turnId !== undefined && history !== 'none' && assembled.manifest.omissions.length === 0) {
          pendingCompactionPrefixes.set(scope.sessionId, scope.turnId)
        }
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
    // The ONE final request: dispatched and captured as the same object. Replace wholesale: when
    // the mode exposes nothing, tools must LEAVE the request — a spread of `projected` would
    // resurrect the full schema list.
    const { tools: _projectedTools, ...base } = projected
    void _projectedTools
    const request: ModelRequest = {
      ...base,
      ...(contextId === undefined ? {} : {
        ...(effective.model != null ? { model: effective.model } : {}),
        ...(effective.provider != null ? { providerName: effective.provider } : {}),
        ...(thinkingLevel != null ? { thinkingLevel } : {}),
        contextId,
      }),
      messages: assembled.messages,
      outputCeilingTokens: assembled.maxOutputTokens,
      ...(assembled.tools !== undefined ? { tools: assembled.tools } : {}),
    }
    // Arm the effective capture with the request EXACTLY as dispatched (root steps only).
    if (sideEffects && limits.compactionEffectiveEnabled && scope !== undefined && scope.childOf === undefined && scope.turnId !== undefined) {
      captures.arm(scope.sessionId, scope.turnId, request, assembled.compactionProjection)
    }
    return { assembled, request, commitPrefix }
  }

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
    return (match.paths ?? [approvedPathOf(match)]).some((target) => classifyTarget({
      root: workspaces.getProject(match.projectId as ProjectId, match.workspaceId as WorkspaceId | undefined).path,
      ...(current.length > 0 ? { additionalRoots: current } : {}),
      ...(deniedRoots !== undefined ? { deniedRoots } : {}),
    }, target.path, target.intent).kind === 'out-of-grant')
  }
  const scopeWarningOf = (match: PathScopeMatch): string =>
    `Outside granted folders: ${(match.paths ?? [approvedPathOf(match)]).map((target) => `${target.path} (${target.intent})`).join(', ')}`
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
    return match.paths ?? [approvedPathOf(match)]
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
        const writeTargets = targetPaths(call).filter(({ intent }) => intent === 'write')
        const memoryWrite = writeTargets.length > 0 && grant !== undefined && writeTargets.every(({ target }) => grant.memoryRoots?.some((root) => within(root, path.resolve(grant.root, target))) === true
          && classifyTarget(grant, target, 'write').kind === 'in-grant')
        // Only an `ask` becomes allow for a memory path; `classifyTarget` +
        // `resolveInGrants` restrict that path to `.md` files outside
        // `.git`/`.env`/`secrets`/`skills`/`agents`/`commands`. A deny —
        // exact, legacy-named, or via `*` — already resolved to `deny` in
        // `normalPermission` (canonical lookup), so it can never be lifted.
        // A slash command's `allowed-tools` (Claude) lifts a policy `ask`
        // for the turn that ran it — never a deny; guard, path and hook
        // questions below still apply.
        // Root sessions only: a child never inherits or creates a command grant.
        const commandAllowed = normalPermission === 'ask' && sessionId === rootSessionId && agentScope.getStore()?.childOf === undefined
          && turnCommandGrants.allows(sessionId, call, grant?.root)
        // A mode with `readOnlyBash: allow` lifts a Bash `ask` (never a deny)
        // for a provably read-only, project-contained command line.
        const readOnlyBash = normalPermission === 'ask' && liftsReadOnlyBash(mode, call)
        const permission = (memoryWrite || commandAllowed || readOnlyBash) && normalPermission === 'ask' ? 'allow' : normalPermission
        const requirements: AskRequirement[] = []
        if (permission === 'ask') requirements.push({ kind: 'tool-policy', subjectFingerprint: createHash('sha256').update(`${call.name}:ask`).digest('hex') })
        // `riskyBash: ask` (Autonomous): a bulk-destructive command asks per
        // call even though Bash is allowed. `--yolo` maps mode asks away.
        const risky = options.yolo === true ? null : riskyBashMatch(mode, call)
        if (risky !== null) requirements.push({ kind: 'risky-command', subjectFingerprint: createHash('sha256').update(`risky:${risky.ruleId}`).digest('hex') })
        const outside = pathScope.get(executionId, call)
        if (outside !== undefined && currentOutsideRequirement(outside, mode.outOfGrant)) requirements.push({ kind: 'outside-path', subjectFingerprint: createHash('sha256').update(JSON.stringify(outside.paths ?? [approvedPathOf(outside)])).digest('hex') })
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
        const riskyMatch = options.yolo === true ? null : riskyBashMatch(executingMode().mode.definition, call)
        const guardWarning = guardMatch?.action === 'ask'
          ? `Dangerous Commands: matched ${guardMatch.presetId ?? guardMatch.ruleId ?? 'rule'} — ${guardMatch.reason}`
          : riskyMatch !== null ? riskyBashWarning(riskyMatch) : undefined
        const workspaceId = (scope.workspaceId ?? (options.home !== undefined ? workspaces.defaultWorkspace : MEMORY_WORKSPACE)) as WorkspaceId
        const interactive = toolRequiresInteraction(call, scope.workspaceId, mcpDescriptors)
        const parentSessionId = scope.childOf?.parentSessionId
        const definitionName = scope.childOf?.definition
        const principalId = sessionPrincipals.get(scope.rootSessionId ?? scope.sessionId)
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
          ...(lifecycle.expiresAt !== undefined ? { expiresAt: lifecycle.expiresAt } : {}),
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
          ...(lifecycle.expiresAt !== undefined ? { expiresAt: lifecycle.expiresAt } : {}),
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
    // A role run has no spawn grant: its ceiling is admission ∩ role
    // candidates − disallowed, the rule a spawn without a grant gets.
    const exposed = await admissionExposureCeiling(rootId, workspaceId, definition.name, roleCandidates(definition, resolved.source), resolved.source)
    const toolCeiling = narrowCeiling(exposed, undefined, definition.disallowedTools).filter((tool) => tool !== 'Agent')
    return {
      definition: definition.name,
      instructions: definition.instructions,
      ...(resolved.source !== undefined ? { source: resolved.source } : {}),
      toolCeiling,
      ...(definition.skills !== undefined ? { skills: [...definition.skills] } : {}),
    }
  }
  /**
   * Whether a tracked run is really still going. Only a loaded session whose
   * driver is in flight counts: a conversation with no `turn/end` whose driver
   * already died must not block the next run forever. A run still being set
   * up is busy and counts as live.
   */
  const runStillLive = (sessionId: SessionId): boolean => {
    if (sessions.get(sessionId)?.agent.busy === true) return true
    activeRuns.delete(sessionId)
    return false
  }
  const runAutomation = async (workspaceId: WorkspaceId, automation: Automation, dueAt: number | null): Promise<{ ok: false; status: number; error: string } | { ok: true; runId: string; sessionId?: string; skipped?: true }> => {
    const runId = `run-${randomUUID()}`
    const identity = { workspaceId, title: automation.title, runId, notify: automation.notify, targets: automation.notifyTargets }
    // Never two runs of one automation at once.
    for (const [sessionId, run] of activeRuns) {
      if (run.automationId !== automation.id || !runStillLive(sessionId)) continue
      await automations.record(workspaceId, { runId, automationId: automation.id, dueAt, status: 'skipped-busy', sessionId })
      return { ok: true, runId, skipped: true }
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
  /**
   * Close runs history still shows as open although nothing watches them any
   * more (the host restarted mid-run, or a run outlived its watcher). The
   * run's conversation is the truth: its first settled turn is the outcome.
   * Records only; nobody is notified after the fact.
   */
  const settleStaleRuns = async (workspaceId: WorkspaceId, automationId: string): Promise<void> => {
    for (const run of await automations.history(workspaceId, automationId)) {
      if (run.status !== 'started' && run.status !== 'needs-approval') continue
      const sessionId = run.sessionId as SessionId | undefined
      if (sessionId !== undefined && runStillLive(sessionId)) continue
      const base = { runId: run.runId, automationId, dueAt: run.dueAt, ...(sessionId !== undefined ? { sessionId } : {}) }
      const events = sessionId === undefined
        ? undefined
        : sessions.get(sessionId)?.session.events ?? await kernel.ctx.sessions.readCanonicalEvents(sessionId).catch(() => undefined)
      if (events === undefined) {
        await automations.record(workspaceId, { ...base, status: 'failed', error: 'the run\'s conversation no longer exists' })
        continue
      }
      const end = events.findIndex((event) => event.type === 'turn/end')
      if (end === -1) {
        // No settled turn and no live watcher: the host stopped mid-run.
        await automations.record(workspaceId, { ...base, status: 'failed', error: 'interrupted before it finished (host restarted)' })
        continue
      }
      const ended = events[end] as Extract<SessionEvent, { type: 'turn/end' }>
      if (ended.reason === 'completed') {
        const reply = events.slice(0, end).reverse().find((event): event is Extract<SessionEvent, { type: 'assistant/message' }> => event.type === 'assistant/message' && event.content.trim() !== '')
        await automations.record(workspaceId, { ...base, status: 'done', summary: excerpt(reply?.content ?? '') || 'Done.', at: ended.timestamp })
      } else {
        const error = events.slice(0, end).reverse().find((event): event is Extract<SessionEvent, { type: 'turn/error' }> => event.type === 'turn/error')
        await automations.record(workspaceId, { ...base, status: 'failed', error: error?.message ?? `run ended: ${ended.reason}`, at: ended.timestamp })
      }
    }
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
    settleStaleRuns,
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
    commands: commandsService,
    plugins,
    syncPluginMcp,
    pluginsEnabled: options.home !== undefined,
    ...(options.userSkillsDir !== undefined ? { userSkillsDir: options.userSkillsDir } : {}),
    ...(options.bundledSkillsDir !== undefined ? { bundledSkillsDir: options.bundledSkillsDir } : {}),
    ...(options.userClaudeDir !== undefined ? { userClaudeDir: options.userClaudeDir } : {}),
    ...(options.bundledCommandsDir !== undefined ? { bundledCommandsDir: options.bundledCommandsDir } : {}),
    refreshSkillProtectedRoots,
    addSkillProtectedRoots,
    memory,
    attachments,
    videos,
    modelPair: pairOf,
    setModelPair: async (name: ModelPairName, next: ModelPair) => {
      await savePair(pairFile(name), next)
      pairs.set(name, next)
    },
    commitMessageModel,
    commitMessageStream: (request, signal) => agentScope.exit(() => kernel.ctx.llm.stream(request, { signal })),
    recordUsage: (record) => usageLog.record(record),
    checkpoints,
    lastManifests,
    contextReducers,
    prefixSnapshots,
    contextBodies,
    completedRequests,
    forgetCompactionCapture: async (sessionId) => {
      captures.forget(sessionId)
      compactionHosts.get(sessionId)?.cancel()
      compactionHosts.delete(sessionId)
      // Abort the background summary and wait until its stream has really ended.
      await candidates?.invalidate(sessionId, 'session-deleted')
    },
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
    backgroundHooks,
    runCompaction,
    cancelCompaction,
    compactionPending: (sessionId) => compactions.has(sessionId),
    settleCompaction: async (sessionId) => { await compactions.get(sessionId)?.done?.catch(() => {}) },
    mcpStore,
    recordMcpConnectFailure,
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
    oauthStore,
    oauthOrigins,
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
      const checkOwner = async (): Promise<string | undefined> => {
        let raw: string
        try {
          raw = await fs.readFile(auditFaultFile(workspaceId), 'utf8')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          return 'audit fault cannot be read; restore readable fault metadata before retrying repair'
        }
        try {
          const fault = JSON.parse(raw) as { workspaceId?: unknown } | null
          if (typeof fault?.workspaceId !== 'string' || fault.workspaceId === '') {
            return 'audit fault has no workspace owner; identify its invocation in the workspace execution journals and restore verified workspaceId metadata before retrying repair'
          }
          if (fault.workspaceId !== workspaceId) return `audit fault belongs to workspace '${fault.workspaceId}'; repair it from that workspace`
        } catch {
          return 'audit fault metadata is invalid; restore verified workspaceId metadata before retrying repair'
        }
        return undefined
      }
      const ownerError = await checkOwner()
      if (ownerError !== undefined) return { ok: false as const, error: ownerError }
      // A faulted journal is reopened from disk: a transient fault (a full
      // disk, a permission since fixed) recovers once the file validates,
      // while a genuinely corrupt file still fails its checks and stays blocked.
      if (journals.get(workspaceId)?.faulted === true) journals.delete(workspaceId)
      try {
        // Also validate when an earlier open failed before it could be cached.
        // Concurrent repairs join the same opening rather than clearing early.
        await journalFor(workspaceId)
      } catch (error) {
        return { ok: false as const, error: `execution journal is still faulted (${error instanceof Error ? error.message : String(error)}); repair the file before clearing the audit block` }
      }
      // Validation may have awaited disk I/O while another workspace faulted.
      const currentOwnerError = await checkOwner()
      if (currentOwnerError !== undefined) return { ok: false as const, error: currentOwnerError }
      await clearAuditFault(auditFaultFile(workspaceId))
      legacyAuditBlocked = false
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
    for (const dispose of [...disposers.values(), ...providerRegistrations.values()]) dispose()
    disposers.clear()
    providerRegistrations.clear()
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
      candidateLifetime.abort(new Error('server closing'))
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
        async () => { await boundedCleanup(() => backgroundHooks.closeAll()) },
        async () => { await boundedCleanup(async () => { await Promise.allSettled([...compactions.values()].flatMap((reservation) => reservation.done === undefined ? [] : [reservation.done])) }) },
        async () => { await boundedCleanup(() => candidates?.close() ?? Promise.resolve()) },
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
          for (const dispose of [...disposers.values(), ...providerRegistrations.values()]) { try { dispose() } catch (error) { errors.push(error) } }
          disposers.clear()
          providerRegistrations.clear()
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
    alias: string | null
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
  readonly commands: CommandsService
  readonly plugins: PluginService
  /** Reconcile a workspace's mcp.json with its enabled plugins' servers. */
  readonly syncPluginMcp: (workspaceId: WorkspaceId) => Promise<{ readonly notes: readonly string[] }>
  /** False on memory-only hosts: plugins need a durable data home. */
  readonly pluginsEnabled: boolean
  /** Read-only user skill layer (`~/.claude/skills`), for protected-root refresh. */
  readonly userSkillsDir?: string
  /** Read-only bundled skill layer, for protected-root refresh. */
  readonly bundledSkillsDir?: string
  /** Claude user folder and bundled commands, only to describe layers in Settings → Sources. */
  readonly userClaudeDir?: string
  readonly bundledCommandsDir?: string
  /** Recompute grant-protected roots from every workspace's skill rules. */
  readonly refreshSkillProtectedRoots: () => Promise<void>
  /** Fail-closed fallback when a recompute fails: add roots, never drop any. */
  readonly addSkillProtectedRoots: (roots: readonly string[]) => void
  readonly memory: MemoryService
  readonly attachments: AttachmentStore
  readonly checkpoints: CheckpointStore
  readonly lastManifests: Map<SessionId, ContextManifest>
  /** Incremental committed-context state per session for GET /manifest. */
  readonly contextReducers: Map<SessionId, ContextReducerCache>
  /** Per-session copy of the skill catalog and memory indexes (prefix stability). */
  readonly prefixSnapshots: Map<SessionId, PrefixSnapshot>
  /** Context section hashes already recorded per session's log (body dedupe). */
  readonly contextBodies: Map<SessionId, Set<string>>
  readonly completedRequests: Map<SessionId, CompactionPrefix>
  /** Drop the effective-compaction capture and host of a deleted session. */
  readonly forgetCompactionCapture: (sessionId: SessionId) => Promise<void>
  readonly adoptMode: (workspaceId: WorkspaceId, modeId: string) => Promise<ResolvedMode>
  readonly stampRootMode: (session: Session, resolved: ResolvedMode) => Extract<SessionEvent, { type: 'session/mode' }>
  readonly rootModeOf: (scope: { readonly sessionId: SessionId; readonly rootSessionId?: SessionId }, workspaceId: WorkspaceId) => { mode: ResolvedMode; revision: number }
  readonly admissionExposureCeiling: (rootSessionId: SessionId, workspaceId: WorkspaceId, definition: string, candidates: readonly string[], definitionSource?: AgentSource) => Promise<readonly string[]>
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
    effort?: ThinkingLevel,
  ) => ChildModel | undefined
  /** Display-only: what a role's `model:` resolves to on this host (aliases mapped). */
  readonly roleModelOf: (definitionModel: string | undefined) => ReturnType<typeof describeRoleModel>
  /** The (provider, model) pair host-side maintenance calls run on; undefined → extractive compaction fallback. */
  /** Durable token accounting behind GET /api/usage. */
  readonly usageLog: UsageLog
  /** Generated-video storage (streamed to disk, served with Range). */
  readonly videos: VideoStore
  /** Settings → Providers & Models → Image generation / Image understanding / Video generation / Commit message. */
  readonly modelPair: (name: ModelPairName) => ModelPair
  readonly setModelPair: (name: ModelPairName, next: ModelPair) => Promise<void>
  /** The model the Git panel's Generate Commit Message button runs on; `{ error }` when none resolves. */
  readonly commitMessageModel: () => { providerName: string; model: string } | { error: string }
  /** One model stream outside any session (the commit-message generator). */
  readonly commitMessageStream: (request: import('../harness/llm/types.ts').ModelRequest, signal: AbortSignal) => AsyncIterable<import('../harness/llm/types.ts').StreamEvent>
  /** Records one usage row for a non-session model call. */
  readonly recordUsage: (record: import('./usage-log.ts').UsageRecord) => void
  readonly summarizerModelOf: (session: Session) => { readonly providerName: string; readonly model: string } | undefined
  /** Runs PreCompact hooks (durable hook/run events); returns the blocking reason, or undefined to proceed. */
  readonly runPreCompactHooks: (session: Session, workspaceId: WorkspaceId) => Promise<string | undefined>
  readonly hookHost: HookHost
  readonly backgroundHooks: BackgroundHooks
  readonly runCompaction: (entry: SessionEntry, trigger: 'manual' | 'automatic') => Promise<{ coversSeq: number; summary: string; path?: string }>
  readonly cancelCompaction: (sessionId: SessionId) => void
  readonly compactionPending: (sessionId: SessionId) => boolean
  readonly settleCompaction: (sessionId: SessionId) => Promise<void>
  readonly mcpStore: McpConfigStore
  /** Why a server could not start; Settings shows it and the pre-step backs off. */
  readonly recordMcpConnectFailure: (workspaceId: string, serverName: string, error: unknown) => void
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
  readonly oauthStore: OAuthStore
  /** Validated `oauthOrigins`: https origins this host may use as an OAuth redirect. */
  readonly oauthOrigins: readonly string[]
  readonly generationOf: (workspaceId: string, serverName: string) => number
  readonly fenceWorkspace: (workspaceId: WorkspaceId, servers?: readonly string[]) => Promise<void>
  readonly closeStreamsFor: (principalId: string) => void
  readonly liveStreams: { principalId: string | undefined; close: () => void }[]
  readonly containmentDetail: string
  readonly auditFaultFile: (workspaceId: string) => string
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
  /** Close open runs nothing watches any more, from their conversation's log. */
  readonly settleStaleRuns: (workspaceId: WorkspaceId, automationId: string) => Promise<void>
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
  // Plugin skills (`plugin:skill`) never collide with plain names; a bare
  // name reaches one only when no plain layer has it. Bundled rides last:
  // every rule layer shadows it, and it stays scannable even under a custom
  // rule list (which never names it).
  // Plugin and bundled are fixed layers: the workspace's Sources policy can
  // switch either off, and every surface resolves through this function.
  const off = await skills.disabledLayers(workspaceId)
  const plugins = off.has('plugin') ? [] : await skills.pluginLayers(workspaceId, projectId).catch(() => [] as SkillLayer[])
  const bundled = off.has('bundled') ? undefined : skills.bundledLayer()
  // SkillService resolves first-hit wins. Keep all project/workspace rule
  // layers above plugins and every absolute/user layer below them:
  // project > workspace > plugin > user > bundled.
  const local = layers.filter((layer) => layer.source !== 'user')
  const user = layers.filter((layer) => layer.source === 'user')
  return [...local, ...plugins, ...user, ...(bundled !== undefined ? [bundled] : [])]
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
    warnings.push('The workspace skill folder is disabled in Settings → Sources, so sessions will not see this skill.')
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
    await serveStatic(res, pathname, deps.staticDir, req.headers['accept-encoding'], req.headers.host)
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
  // A browser lands here from the provider (GET): answer with a page that
  // hands the state to the app tab. A POST deposit keeps the plain answer.
  const browser = req.method === 'GET'
  const page = (status: number, result: Parameters<typeof callbackPage>[0]): void => {
    const { html, csp } = callbackPage(result)
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': csp })
    res.end(html)
  }
  const send = (status: number, body: string): void => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  if (browser) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const state = url.searchParams.get('state') ?? ''
    const providerError = url.searchParams.get('error')
    if (providerError !== null) {
      page(400, { ok: false, reason: `The provider did not grant access (${providerError.slice(0, 80)}).` })
      return
    }
    try {
      await deps.oauth.deposit(state, url.searchParams.get('code') ?? '')
      page(200, { ok: true, state })
    } catch {
      page(400, { ok: false, reason: 'This sign-in link is unknown, expired, or was already used.' })
    }
    return
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

/**
 * The schema a model request actually carries for one MCP tool — the same
 * wording `reconcileMcpTools` registers — or `undefined` when the provider
 * would reject the name and the tool never reaches the model.
 */
function mcpModelSchema(serverName: string, descriptor: McpToolDescriptor): { name: string; description: string; parameters: unknown } | undefined {
  if (descriptor.name.trim() === '' || descriptor.name.includes('__')) return undefined
  const fullName = mcpToolName(serverName, descriptor.name)
  if (!PROVIDER_TOOL_NAME.test(fullName)) return undefined
  return {
    name: fullName,
    description: mcpToolDescription(serverName, descriptor),
    parameters: descriptor.inputSchema as { type: 'object'; properties: Record<string, unknown> },
  }
}

/** The one wording a model sees for an MCP tool: registration, live schema and the token estimate all use it. */
function mcpToolDescription(serverName: string, descriptor: McpToolDescriptor): string {
  return `[MCP:${serverName}] ${descriptor.description ?? descriptor.name}${descriptor.requiresUserInteraction === true ? ' (interactive — always asks)' : ''}`
}

/**
 * Estimated tokens (chars/3, the same `schemaCost` the context builder
 * charges to `breakdown.mcpTools`) for the schemas this workspace would
 * carry for one server: provider-valid, allowlist-exposed descriptors.
 * Pure so the API row route can call it against the live descriptor map.
 */
function mcpSchemaTokenEstimate(
  workspaceId: string,
  serverName: string,
  allowed: readonly string[] | undefined,
  descriptors: ReadonlyMap<string, McpToolDescriptor>,
): number {
  const schemas: { name: string; description: string; parameters: unknown }[] = []
  for (const [key, descriptor] of descriptors) {
    if (!key.startsWith(`${workspaceId}:mcp__${serverName}__`)) continue
    const fullName = mcpToolName(serverName, descriptor.name)
    if (!mcpToolExposed(allowed, descriptor.name, fullName)) continue
    const schema = mcpModelSchema(serverName, descriptor)
    if (schema !== undefined) schemas.push(schema)
  }
  return schemaCost(schemas)
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
      send(status, { error: error.message, code: error.code })
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
        const force = query.get('force') === 'true'
        if (force) {
          // Refuse before touching anything: unknown / last workspace, or a conversation still running.
          deps.workspaces.get(wsId)
          if (deps.workspaces.list({ includeArchived: true }).length <= 1) {
            send(409, { error: 'cannot delete the last workspace' })
            return
          }
          for (const entry of deps.sessions.values()) {
            if (entry.workspaceId === wsId && entry.agent.busy) {
              send(409, { error: 'workspace has running sessions; stop them before deleting' })
              return
            }
          }
          for (const summary of deps.kernel.ctx.sessions.summaries()) {
            if (deps.kernel.ctx.sessions.workspaceOf(summary.id) !== wsId) continue
            // A child may already be gone with its root: findSession then returns undefined.
            const entry = await findSession(summary.id, wsId, deps)
            const refused = entry === undefined ? undefined : await removeSession(entry, wsId, deps)
            if (refused !== undefined) {
              send(refused.status, { error: refused.error })
              return
            }
          }
        }
        await deps.workspaces.delete(wsId, { force })
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
          send(200, deps.processes.snapshot(entry.session.id).filter((row) => row.backgrounded))
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
          const refused = await removeSession(entry, wsId, deps)
          if (refused !== undefined) {
            send(refused.status, { error: refused.error })
            return
          }
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
        // A user Stop also ends the conversation's background hooks.
        await deps.backgroundHooks.killRoot(entry.session.id)
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
            resolved.definition.effort,
          )
          const { turnId, handle } = await deps.childExecutor.spawnManual({
            workspaceId: wsId,
            parentSessionId: parent.session.id,
            definition: resolved.definition,
            ...(resolved.source !== undefined ? { definitionSource: resolved.source } : {}),
            admissionResolver: ({ parentSessionId, workspaceId, definition, definitionSource, candidates }) => deps.admissionExposureCeiling(parentSessionId, workspaceId, definition, candidates, definitionSource),
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
            send(error.code === 'capacity' ? 429 : error.code === 'packet' || error.code === 'inherit' || error.code === 'mcp' ? 400 : 404, { error: error.message })
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
          // Only extra scopes are read from the body (Reconnect). Endpoints,
          // client, and redirect URI come from discovery and mcp.json.
          const config = (await deps.mcpStore.loadMcp(wsId)).servers[serverName]
          if (config === undefined) {
            send(404, { error: `no MCP server '${serverName}'` })
            return
          }
          const extraScopes = Array.isArray(body['scopes']) ? body['scopes'].filter((item): item is string => typeof item === 'string' && /^[\x21-\x7e]+$/.test(item)) : []
          const started = await beginConnect({
            oauth: deps.oauth,
            store: deps.oauthStore,
            workspaceId: wsId,
            server: serverName,
            config,
            principalId,
            hostHeader: req.headers.host,
            boundPort: req.socket.localPort ?? 0,
            oauthOrigins: deps.oauthOrigins,
            extraScopes,
          })
          send(200, { authorizationUrl: started.authorizationUrl, state: started.state, redirectMode: started.redirectMode })
          return
        }
        if (action === 'complete') {
          // Sign-in from a machine whose browser could not reach the callback:
          // the person pastes the address it ended on. Only that address is read.
          const pastedAddress = typeof body['callbackUrl'] === 'string' ? body['callbackUrl'] : undefined
          const state = pastedAddress !== undefined
            ? await deps.oauth.acceptCallbackUrl(pastedAddress, { workspaceId: wsId, server: serverName, principalId })
            : String(body['state'] ?? '')
          // The sign-in was started for one URL. If the server has since been
          // deleted, renamed or pointed elsewhere, finishing it would store a
          // grant for the old URL under the new server's name.
          const target = (await deps.mcpStore.loadMcp(wsId)).servers[serverName]
          const pending = await deps.oauth.pendingServer(state)
          if (target?.transport !== 'http' || target.url === undefined) {
            send(400, { error: `server '${serverName}' no longer exists or is not an HTTP server; start Connect again` })
            return
          }
          if (pending !== undefined && pending.serverUrl !== target.url) {
            send(400, { error: `server '${serverName}' now points at a different URL than this sign-in was started for; start Connect again` })
            return
          }
          await deps.oauth.complete({
            state,
            principalId,
            workspaceId: wsId,
            server: serverName,
          })
          // An enabled server picks the new grant up now, not at the next turn.
          const current = (await deps.mcpStore.loadMcp(wsId)).servers[serverName]
          if (current?.enabled === true) {
            await deps.cancelMcpConnection(wsId, serverName)
            deps.mcpCancelled.delete(`${wsId}:${serverName}`)
            const client = await deps.ensureMcpServer(wsId, serverName).catch((error: unknown) => {
              deps.recordMcpConnectFailure(wsId, serverName, error)
              return undefined
            })
            if (client === undefined) {
              send(200, { connected: true, status: 'failed' })
              return
            }
          }
          send(200, { connected: true })
          return
        }
        // Only this server's connection used the grant: stop it, revoke, then let
        // the next turn try again (it fails with auth_required, which Settings
        // shows) instead of fencing every healthy server in the workspace.
        await deps.cancelMcpConnection(wsId, serverName)
        const record = await deps.oauthStore.readServerRecord(wsId, serverName)
        const revoked = await deps.oauth.revoke(wsId, serverName, record?.revocationEndpoint)
        deps.mcpCancelled.delete(`${wsId}:${serverName}`)
        send(200, revoked)
      } catch (error) {
        if (error instanceof OAuthConnectError) {
          send(400, { code: error.code, error: error.message })
          return
        }
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
        let taken: string[] = []
        await deps.updateMcpConfig(wsId, (existing) => {
          // An import adds servers. A name that already exists (possibly running,
          // possibly owned by a plugin) would be silently re-pointed while staying
          // enabled, so the whole import is refused and nothing is written.
          taken = Object.keys(imported.servers).filter((name) => existing.servers[name] !== undefined)
          if (taken.length > 0) throw new McpRevisionConflict()
          let merged = existing
          for (const [name, server] of Object.entries(imported.servers)) {
            merged = upsertServer(merged, name, { ...server, enabled: false })
          }
          return merged
        }).catch((error: unknown) => {
          if (error instanceof McpRevisionConflict && taken.length > 0) return undefined
          throw error
        }).then((saved) => {
          if (saved === undefined) {
            send(409, { error: `already configured: ${taken.join(', ')}; delete or rename them, or import only new servers` })
          }
        })
        if (taken.length > 0) return
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
          const auditFault = await faultIsOpen(deps.auditFaultFile(wsId))
          const rows = []
          for (const server of Object.values(config.servers)) {
            const client = deps.mcpClients.get(`${wsId}:${server.name}`)
            const discovered = (client?.cachedTools() ?? []).map((tool) => tool.name)
            const unmatchedAllowlist = (server.allowedTools ?? []).filter((name) => !name.includes('*') && !discovered.includes(name))
            const unusableTools = discovered.filter((name) => !PROVIDER_TOOL_NAME.test(mcpToolName(server.name, name)) || name.includes('__'))
            const connectFailure = server.enabled ? deps.mcpConnectFailures.get(`${wsId}:${server.name}`) : undefined
            const stderr = client?.recentStderr() ?? ''
            const oauthState = await oauthRowState(deps.oauth, deps.oauthStore, wsId, server)
            const toolSchemaTokens = server.enabled && client !== undefined && client.state === 'ready'
              ? mcpSchemaTokenEstimate(wsId, server.name, server.allowedTools, deps.mcpDescriptors)
              : 0
            rows.push({
              ...(oauthState !== undefined ? { oauth: oauthState } : {}),
              name: server.name,
              transport: server.transport,
              enabled: server.enabled,
              // `connecting` means a connect is actually in flight. An enabled
              // server with no client, no failure and nothing connecting (a fence
              // dropped it) is `idle`: the next turn starts it.
              status: !server.enabled
                ? 'disabled'
                : client?.state ?? (connectFailure !== undefined
                  ? 'failed'
                  : deps.mcpConnecting.has(`${wsId}:${server.name}`) ? 'connecting' : 'idle'),
              ...(connectFailure !== undefined ? { lastError: connectFailure.message } : {}),
              ...(unusableTools.length > 0 ? { unusableTools } : {}),
              ...(stderr !== '' ? { stderrTail: stderr.slice(-2_000) } : {}),
              ...(toolSchemaTokens > 0 ? { toolSchemaTokens } : {}),
              breakerOpenUntil: client !== undefined && client.breakerOpenUntil > Date.now() ? client.breakerOpenUntil : null,
              containment: deps.containmentDetail,
              generation: deps.generationOf(wsId, server.name),
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
          const managed = config.servers[serverName]?.auth?.type === 'managed_oauth'
          // Read the provider's revocation endpoint now: the record goes away with the server.
          const revocationEndpoint = managed ? (await deps.oauthStore.readServerRecord(wsId, serverName))?.revocationEndpoint : undefined
          // Stop the process and drop its tool schemas before the config forgets it.
          await deps.cancelMcpConnection(wsId, serverName)
          await deps.oauthStore.invalidate(wsId, serverName)
          await deps.updateMcpConfig(wsId, (current) => withoutServer(current, serverName))
          // Revoke locally first so a racing refresh cannot write the grant back;
          // the same call also asks the provider to void the token.
          if (managed) await deps.oauth.revoke(wsId, serverName, revocationEndpoint)
          await deps.oauthStore.deleteServer(wsId, serverName)
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
          // Reconnect restarts a server whose executable was already authorized.
          // A stdio server with no pin (imported, never enabled) must go through
          // Enable, which is what authorizes the file; otherwise Reconnect would
          // start it unpinned and a later edit of `command` would run unchecked.
          if (action === 'reconnect' && serverConfig.transport === 'stdio' && serverConfig.executable === undefined) {
            send(409, { error: `'${serverName}' has not been authorized to run; use Enable` })
            return
          }
          // The conflict check is about THIS server: an unrelated save fences
          // the workspace but must not fail an Enable of another server.
          const configOfServer = (config: McpConfig): string => JSON.stringify(config.servers[serverName] ?? null)
          const expectedServer = configOfServer(config)
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
              if (configOfServer(current) !== expectedServer) throw new McpRevisionConflict()
              return withServerActivated(current, serverName, executable)
            }).catch((error: unknown) => error instanceof McpRevisionConflict ? undefined : Promise.reject(error))
            if (enabled === undefined) {
              send(409, { error: 'MCP server changed while enable was preparing; retry against the current config' })
              return
            }
            committedGeneration = deps.generationOf(wsId, serverName)
          } else {
            // Reconnect never re-authorizes: a changed executable stays refused.
            const reconnected = await deps.updateMcpConfig(wsId, (current) => {
              if (configOfServer(current) !== expectedServer) throw new McpRevisionConflict()
              return withServerEnabled(current, serverName, true)
            }).catch((error: unknown) => error instanceof McpRevisionConflict ? undefined : Promise.reject(error))
            if (reconnected === undefined) {
              send(409, { error: 'MCP server changed while reconnect was preparing; retry against the current config' })
              return
            }
            committedGeneration = deps.generationOf(wsId, serverName)
          }
          if (action === 'reconnect') await deps.cancelMcpConnection(wsId, serverName)
          // A newer disable/save may have landed after this request committed
          // but before it reached publication. Never let the stale request
          // clear that mutation's cancellation marker and resurrect a server.
          const publishConfig = await deps.mcpStore.loadMcp(wsId)
          if (deps.generationOf(wsId, serverName) !== committedGeneration || publishConfig.servers[serverName]?.enabled !== true) {
            send(409, { error: 'MCP server changed before connection publication; retry against the current config' })
            return
          }
          deps.mcpCancelled.delete(`${wsId}:${serverName}`)
          // Fresh/singleton connect; ensureMcpServer lists + reconciles tools.
          // A failure is remembered so the row says why instead of "connecting".
          const client = await deps.ensureMcpServer(wsId, serverName).catch((error: unknown) => {
            if (deps.generationOf(wsId, serverName) === committedGeneration && !deps.mcpCancelled.has(`${wsId}:${serverName}`)) {
              deps.recordMcpConnectFailure(wsId, serverName, error)
            }
            throw error
          })
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

    // Settings → Providers & Models → Image generation / Image understanding /
    // Video generation: one provider/model reference each, same contract.
    const pairRoute = MODEL_PAIR_ROUTES[pathname]
    if (pairRoute !== undefined) {
      if (req.method === 'GET') {
        send(200, deps.modelPair(pairRoute.name))
        return
      }
      if (req.method === 'PUT') {
        const checked = validatePairBody(await readJson(req), (id) => deps.providers().some((entry) => entry.id === id))
        if (!checked.ok) {
          send(400, { error: checked.error })
          return
        }
        try {
          await deps.setModelPair(pairRoute.name, checked.pair)
        } catch (error) {
          send(500, { error: `${pairRoute.label} settings could not be saved: ${String(error instanceof Error ? error.message : error)}` })
          return
        }
        send(200, deps.modelPair(pairRoute.name))
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
      // Opening a workspace brings its enabled MCP servers up (after a restart nothing else would until the first turn).
      void deps.connectWorkspaceMcp(wsId).catch((error) => console.error(`web: MCP config/start failed for ${wsId}: ${String(error instanceof Error ? error.message : error)}`))
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
        const hidden = new Set(await deps.modes.hiddenIds(wsId))
        send(200, {
          modes: rows.filter((row) => !hidden.has(row.definition.id)).map((row) => ({
            id: row.definition.id,
            name: row.definition.name,
            ...(row.definition.description !== undefined ? { description: row.definition.description } : {}),
            source: row.source,
          })),
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
        const disabled = new Set(await deps.modes.hiddenIds(wsId))
        // Permissions and exposure travel with the catalog: the settings list
        // states what each mode grants without a read per row. `enabled`
        // marks what the composer picker offers (default-hidden modes included).
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
    // Workspace Sources: which folder layers skills, agents, hooks and
    // commands may be discovered from. One document, one hash: PUT replaces it
    // whole and refuses a stale `expectedHash`.
    const wsSources = /^\/api\/workspaces\/([^/]+)\/sources$/.exec(pathname)
    if (wsSources !== null && (req.method === 'GET' || req.method === 'PUT')) {
      const wsId = decodeURIComponent(wsSources[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, req.method === 'PUT')
      const store = deps.skills.sourcesStore
      const view = (state: Awaited<ReturnType<typeof store.read>>) => ({
        doc: state.doc,
        hash: state.hash,
        ...(state.error !== undefined ? { error: state.error } : {}),
        layers: describeSourceLayers({
          workspaceDir: path.dirname(store.file(wsId)),
          ...(deps.userClaudeDir !== undefined ? { userClaudeDir: deps.userClaudeDir } : {}),
          ...(deps.bundledSkillsDir !== undefined ? { bundledSkillsDir: deps.bundledSkillsDir } : {}),
          ...(deps.bundledCommandsDir !== undefined ? { bundledCommandsDir: deps.bundledCommandsDir } : {}),
        }),
      })
      if (req.method === 'GET') {
        send(200, view(await store.read(wsId)))
        return
      }
      if (!browserPrincipal(req, deps, 'PUT')) {
        send(401, { error: 'sources can only be changed from the browser session that owns the workspace' })
        return
      }
      const body = await readJson(req)
      try {
        const saved = await store.write(wsId, validateSourcesInput(body['doc']), typeof body['expectedHash'] === 'string' ? body['expectedHash'] : undefined)
        // Switches take effect at the next request/operation: hook snapshots
        // are re-read, and the catalog snapshot key carries the revision.
        deps.hookHost.invalidateWorkspace(wsId)
        try {
          await deps.refreshSkillProtectedRoots()
        } catch {
          deps.addSkillProtectedRoots(protectedRootsForRules(saved.doc.skills.rules))
        }
        send(200, view(saved))
      } catch (error) {
        if (error instanceof ResourceSourcesError) {
          send(error.code === 'conflict' ? 409 : 400, { error: error.message })
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

    // ── Claude Code plugins ──────────────────────────────────
    // Marketplaces are host-wide; plugin rows, install and enable are scoped
    // by workspace (+ optional ?projectId for project/local scope). A
    // memory-only host has no durable store: every plugin route refuses.
    if (!deps.pluginsEnabled && (pathname.startsWith('/api/plugins/') || /^\/api\/workspaces\/[^/]+\/plugins(?:\/|$)/.test(pathname))) {
      send(409, { error: 'plugins need a durable data home; this host runs in memory' })
      return
    }
    if (pathname === '/api/plugins/marketplaces') {
      if (req.method === 'GET') {
        send(200, { marketplaces: await deps.plugins.listMarketplaces() })
        return
      }
      if (req.method === 'POST') {
        const body = await readJson(req)
        try {
          const source = parseMarketplaceInput(typeof body['source'] === 'string' ? body['source'] : '')
          const added = await deps.plugins.addMarketplace(source)
          send(201, { name: added.name, plugins: added.document.plugins.length })
        } catch (error) {
          if (error instanceof PluginError) { send(error.code === 'not-found' ? 404 : 400, { error: error.message }); return }
          throw error
        }
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }
    const marketplaceMatch = /^\/api\/plugins\/marketplaces\/([^/]+)(\/update)?$/.exec(pathname)
    if (marketplaceMatch !== null) {
      const name = decodeURIComponent(marketplaceMatch[1] ?? '')
      try {
        if (req.method === 'POST' && marketplaceMatch[2] !== undefined) {
          const document = await deps.plugins.updateMarketplace(name)
          send(200, { name: document.name, plugins: document.plugins.length })
          return
        }
        if (req.method === 'DELETE' && marketplaceMatch[2] === undefined) {
          await deps.plugins.removeMarketplace(name)
          send(200, { removed: true })
          return
        }
      } catch (error) {
        if (error instanceof PluginError) { send(error.code === 'not-found' ? 404 : 400, { error: error.message }); return }
        throw error
      }
      send(405, { error: 'method not allowed' })
      return
    }
    const wsPluginsMatch = /^\/api\/workspaces\/([^/]+)\/plugins(?:\/([^/]+)(?:\/(install|enable|disable|uninstall|update))?)?$/.exec(pathname)
    if (wsPluginsMatch !== null) {
      const wsId = decodeURIComponent(wsPluginsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      const rawProject = query.get('projectId')
      const projectId = rawProject !== null && rawProject !== '' ? rawProject as ProjectId : undefined
      if (projectId !== undefined) {
        try { deps.workspaces.getProject(projectId, wsId) } catch { send(400, { error: 'unknown projectId' }); return }
      }
      const context = { workspaceId: wsId, ...(projectId !== undefined ? { projectId } : {}) }
      const pluginId = wsPluginsMatch[2] !== undefined ? decodeURIComponent(wsPluginsMatch[2]) : undefined
      const action = wsPluginsMatch[3]
      if (req.method === 'GET' && pluginId === undefined) {
        send(200, await deps.plugins.list(context))
        return
      }
      if (req.method === 'GET' && pluginId !== undefined && action === undefined) {
        try {
          send(200, await deps.plugins.details(pluginId, context))
        } catch (error) {
          if (error instanceof PluginError) { send(error.code === 'not-found' ? 404 : error.code === 'unsupported' ? 422 : 400, { error: error.message }); return }
          throw error
        }
        return
      }
      if (req.method === 'POST' && pluginId !== undefined && action !== undefined) {
        requireWorkspace(deps, wsId, true)
        const body = await readJson(req)
        const scope = body['scope'] === 'project' || body['scope'] === 'local' || body['scope'] === 'user' ? body['scope'] : 'workspace'
        try {
          if (action === 'install') await deps.plugins.install(pluginId, scope, context)
          else if (action === 'enable') await deps.plugins.setEnabled(pluginId, scope, context, true)
          else if (action === 'disable') await deps.plugins.setEnabled(pluginId, scope, context, false)
          else if (action === 'uninstall') await deps.plugins.uninstall(pluginId, scope, context)
          else await deps.plugins.update(pluginId)
        } catch (error) {
          if (error instanceof PluginError) { send(error.code === 'not-found' ? 404 : error.code === 'unsupported' ? 422 : 400, { error: error.message }); return }
          throw error
        }
        // Hooks, commands and skills follow on the next read; hooks are a
        // per-conversation snapshot, so a plugin change re-reads them now
        // (an explicit user action, like saving hooks in Settings).
        deps.hookHost.invalidateWorkspace(wsId)
        const synced = await deps.syncPluginMcp(wsId).catch((error: unknown) => ({ notes: [`MCP sync failed: ${String(error instanceof Error ? error.message : error)}`] }))
        send(200, { ok: true, ...(synced.notes.length > 0 ? { notes: synced.notes } : {}), ...(await deps.plugins.list(context)) })
        return
      }
      send(405, { error: 'method not allowed' })
      return
    }

    // Claude Code custom slash commands (the `/` menu's file commands).
    const wsCommandsMatch = /^\/api\/workspaces\/([^/]+)\/commands$/.exec(pathname)
    if (wsCommandsMatch !== null) {
      const wsId = decodeURIComponent(wsCommandsMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method !== 'GET') {
        send(405, { error: 'method not allowed' })
        return
      }
      const rawProject = query.get('projectId')
      const projectId = rawProject !== null && rawProject !== '' ? rawProject as ProjectId : undefined
      if (projectId !== undefined) {
        try { deps.workspaces.getProject(projectId, wsId) } catch { send(400, { error: 'unknown projectId' }); return }
      }
      const { rows, errors } = await deps.commands.catalog(wsId, projectId)
      send(200, {
        commands: rows.map((row) => ({
          name: row.name,
          description: row.description,
          source: row.source,
          path: row.path,
          ...(row.argumentHint !== undefined ? { argumentHint: row.argumentHint } : {}),
          ...(row.allowedTools.length > 0 ? { allowedTools: row.allowedTools } : {}),
          ...(row.model !== undefined ? { model: row.model } : {}),
          ...(row.disableModelInvocation ? { disableModelInvocation: true } : {}),
          ...(!row.userInvocable ? { userInvocable: false } : {}),
          ...(row.plugin !== undefined ? { plugin: row.plugin.id } : {}),
          ...(row.notes !== undefined ? { notes: row.notes } : {}),
        })),
        errors,
      })
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
    // A raw, read-only view of one file under a memory folder, for the
    // workbench when a tool row names a memory file (MEMORY.md has no entry id).
    // Contained to that folder, symlinks included; nothing here writes.
    const wsMemoryFile = /^\/api\/workspaces\/([^/]+)\/memory-file$/.exec(pathname)
    if (wsMemoryFile !== null) {
      const wsId = decodeURIComponent(wsMemoryFile[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method !== 'GET') {
        send(405, { error: 'method not allowed' })
        return
      }
      const rawProject = query.get('projectId')
      let fileProject: ProjectId | undefined
      if (rawProject !== null && rawProject !== '') {
        try {
          deps.workspaces.getProject(rawProject as ProjectId, wsId)
        } catch (error) {
          fail(error)
          return
        }
        fileProject = rawProject as ProjectId
      }
      try {
        send(200, await readProjectFile(deps.memory.root({ workspaceId: wsId, ...(fileProject !== undefined ? { projectId: fileProject } : {}) }), query.get('path') ?? ''))
      } catch (error) {
        if (!(error instanceof ProjectFileError)) throw error
        send(400, { error: error.message })
      }
      return
    }
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
          ...(effective.alias !== null ? { alias: effective.alias } : {}),
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
          ...(effective.alias !== null ? { alias: effective.alias } : {}),
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
      const committedView = committedContextView(entry.session, deps.contextReducers)
      const live = deps.lastManifests.get(entry.session.id)
      // A request assembled but not yet reported: show its fresh estimate and
      // pre-trim pressure, never an older request's numbers over this assembly.
      // After a compaction the committed post-compaction preview stands until a
      // request is assembled beyond it: a live manifest recorded before the
      // checkpoint describes the old context and must not replace the preview.
      const compactionSeq = committedView !== null && isAvailableContext(committedView) && committedView.display?.kind === 'post-compaction' ? committedView.display.compactionSeq : undefined
      const liveIsNewer = live !== undefined && (compactionSeq === undefined
        || entry.session.events.some((event) => event.type === 'context/manifest' && event.seq > compactionSeq && event.manifest.contextId === live.contextId))
      const liveShown = live === undefined ? undefined : { ...live, ...(isValidContextId(live.contextId) ? { display: { kind: 'request' as const, contextId: live.contextId } } : {}) }
      const view = committedView !== null && isAvailableContext(committedView) && liveIsNewer
        && liveShown !== undefined && live?.contextId !== committedView.contextId
        // usage.last pairs only with its own contextId; session cache totals carry over.
        ? { ...liveShown, ...(committedView.usage !== undefined ? { usage: { cacheableInputTokens: committedView.usage.cacheableInputTokens, cachedInputTokens: committedView.usage.cachedInputTokens } } : {}) }
        : committedView ?? liveShown ?? null
      if (view === null) {
        res.writeHead(204); res.end(); return
      }
      send(200, { ...view, ...(deps.limits.automaticCompactionPressure > 0 ? { policy: { automaticCompactionPressure: deps.limits.automaticCompactionPressure } } : {}) })
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
        // The server picks the path; a body (an older client's recovery echo) changes nothing.
        await readJson(req).catch(() => undefined)
        const lastSeqBefore = entry.session.events.at(-1)?.seq ?? 0
        const checkpoint = await deps.runCompaction(entry, 'manual')
        // An unchanged boundary is a no-op with no new end event: report no figures.
        const end = entry.session.events.findLast((event) => event.type === 'compaction/end' && event.seq > lastSeqBefore)
        const measured = end?.type === 'compaction/end' && end.tokensBefore !== undefined && end.tokensAfter !== undefined
          ? { tokensBefore: end.tokensBefore, tokensAfter: end.tokensAfter, ...(end.measurement !== undefined ? { measurement: end.measurement } : {}) }
          : {}
        send(200, { coversSeq: checkpoint.coversSeq, summaryChars: checkpoint.summary.length, ...measured, ...(checkpoint.path !== undefined ? { path: checkpoint.path } : {}) })
      } catch (error) {
        if (error instanceof CompactionCancelled) {
          send(409, { error: 'compaction was cancelled', cancelled: true })
          return
        }
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

    // ── generated videos ──────────────────────────────────────
    // Read-only: videos are written only by the GenerateVideo tool. The id is
    // a sha256 of the bytes, so the response is immutable and cacheable; the
    // type is sniffed from the stored bytes, never taken from a caller.
    const wsVideoMatch = /^\/api\/workspaces\/([^/]+)\/videos\/([^/]+)$/.exec(pathname)
    if (wsVideoMatch !== null) {
      const wsId = decodeURIComponent(wsVideoMatch[1] ?? '') as WorkspaceId
      requireWorkspace(deps, wsId, false)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(405, { error: 'method not allowed' })
        return
      }
      await serveStoredVideo(deps.videos, wsId, decodeURIComponent(wsVideoMatch[2] ?? ''), req, res, send)
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

    // ── Git panel actions (NDJSON stream) and askpass answers ──
    // Matched before the read route below, which only knows `…/git` itself.
    const wsProjectGitActionMatch = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/git\/(.+)$/.exec(pathname)
    if (wsProjectGitActionMatch !== null) {
      await handleProjectGitAction(
        req,
        res,
        deps,
        decodeURIComponent(wsProjectGitActionMatch[1] ?? '') as WorkspaceId,
        decodeURIComponent(wsProjectGitActionMatch[2] ?? '') as ProjectId,
        wsProjectGitActionMatch[3] ?? '',
      )
      return
    }

    // ── project browsing and explorer writes (workbench Files) ──
    // Reads serve browsing; POST/PATCH/DELETE on `files` go to
    // `handleProjectFileWrite`; PUT on `file` saves an edited file
    // (`handleProjectFileSave`). `git` here is trust-aware status and diff;
    // Git writes are the `…/git/:op` route above.
    const wsProjectFilesMatch = /^\/api\/workspaces\/([^/]+)\/projects\/([^/]+)\/(files|file|search|git|media)$/.exec(pathname)
    if (wsProjectFilesMatch !== null) {
      const wsId = decodeURIComponent(wsProjectFilesMatch[1] ?? '') as WorkspaceId
      const kind = wsProjectFilesMatch[3]
      const writing = (kind === 'files' && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE'))
        || (kind === 'file' && req.method === 'PUT')
      // Writes need a live workspace; an archived one stays browsable.
      requireWorkspace(deps, wsId, writing)
      const project = deps.workspaces.getProject(decodeURIComponent(wsProjectFilesMatch[2] ?? '') as ProjectId, wsId)
      if (writing) {
        if (kind === 'file') await handleProjectFileSave(req, project.path, deps.deniedRoots, send)
        else await handleProjectFileWrite(req, query, project.path, deps.deniedRoots, send)
        return
      }
      // HEAD joins GET: a media element asks for headers before it streams.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        send(405, { error: 'method not allowed' })
        return
      }
      try {
        const target = query.get('path') ?? ''
        if (kind === 'git') {
          const trusted = project.gitTrusted === true
          send(200, target === ''
            ? await gitStatus(project.path, deps.deniedRoots, trusted)
            : await gitDiff(project.path, target, deps.deniedRoots, trusted))
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
        // Trusting a project lets its own git configuration and hooks run, so
        // like a folder grant it is a browser-only decision.
        let gitTrusted: boolean | undefined
        if (body['gitTrusted'] !== undefined) {
          if (!browserPrincipal(req, deps, 'PATCH')) {
            send(401, { error: 'git trust can only be changed from the browser session that owns the workspace' })
            return
          }
          if (typeof body['gitTrusted'] !== 'boolean') {
            send(400, { error: 'gitTrusted must be a boolean' })
            return
          }
          gitTrusted = body['gitTrusted']
        }
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
        if (gitTrusted !== undefined) {
          updated = await deps.workspaces.setProjectGitTrusted(pid, wsId, gitTrusted)
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

    // The stored secret on demand, and only to the paired browser: it never
    // rides along in the provider list, and a bearer (CLI/headless) client may
    // not read a key back. `no-store` keeps it out of any HTTP cache.
    const providerKeyMatch = /^\/api\/providers\/([^/]+)\/key$/.exec(pathname)
    if (req.method === 'GET' && providerKeyMatch !== null) {
      if (!browserPrincipal(req, deps, 'GET')) {
        send(401, { error: 'the stored API key can only be read from the browser session that owns the workspace' })
        return
      }
      const entry = deps.providers().find((candidate) => candidate.id === decodeURIComponent(providerKeyMatch[1] ?? ''))
      if (entry === undefined) {
        send(404, { error: 'no such provider' })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ apiKey: entry.apiKey }))
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

// ── Git panel actions ──────────────────────────────────────────

/** Operations of `POST …/projects/:pid/git/:op`; the queries are answered in the done frame. */
const GIT_OPERATIONS: ReadonlySet<string> = new Set([
  'stage', 'unstage', 'discard', 'trash', 'stage-all', 'unstage-all', 'commit', 'uncommit', 'fetch', 'fetch-all', 'pull', 'push',
  'switch-branch', 'create-branch', 'delete-branch',
  'stage-hunk', 'unstage-hunk', 'restore-hunk', 'resolve-conflict', 'ignore',
])
const GIT_QUERIES: ReadonlySet<string> = new Set(['remotes', 'pushed-to', 'branches'])
/** Streamed like an operation, but produced by the model layer, not git. */
const GIT_STREAMS: ReadonlySet<string> = new Set(['commit-message'])

/**
 * Which principal's operation raised a prompt, so another browser session
 * cannot answer it. Entries live exactly as long as the operation that owns them.
 */
const promptPrincipals = new Map<string, string | undefined>()

type GitBody = Record<string, unknown>

function gitFlag(body: GitBody, key: string): boolean | string {
  const value = body[key]
  if (value === undefined) return false
  return typeof value === 'boolean' ? value : `${key} must be a boolean`
}

function gitText(body: GitBody, key: string, optional = false): string | undefined {
  const value = body[key]
  if (value === undefined && optional) return ''
  return typeof value === 'string' ? value : undefined
}

/** A client body as the operation union; the string is the 400 message. */
function parseGitOperation(op: string, body: GitBody): GitOperationRequest | string {
  const flags = (...keys: string[]): Record<string, boolean> | string => {
    const out: Record<string, boolean> = {}
    for (const key of keys) {
      const value = gitFlag(body, key)
      if (typeof value === 'string') return value
      out[key] = value
    }
    return out
  }
  switch (op) {
    case 'stage':
    case 'unstage':
    case 'discard':
    case 'trash': {
      const list = body['paths']
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) return 'paths must be an array of strings'
      return { type: op, paths: list as string[] }
    }
    case 'stage-all':
    case 'unstage-all':
    case 'uncommit':
    case 'fetch-all':
      return { type: op }
    case 'commit': {
      const message = gitText(body, 'message')
      if (message === undefined) return 'message must be a string'
      const f = flags('amend', 'signoff', 'noVerify', 'tracked')
      if (typeof f === 'string') return f
      return { type: 'commit', message, amend: f['amend'] === true, signoff: f['signoff'] === true, noVerify: f['noVerify'] === true, tracked: f['tracked'] === true }
    }
    case 'fetch': {
      const remote = gitText(body, 'remote')
      return remote === undefined ? 'remote must be a string' : { type: 'fetch', remote }
    }
    case 'pull': {
      const remote = gitText(body, 'remote')
      const branch = gitText(body, 'branch', true)
      if (remote === undefined) return 'remote must be a string'
      if (branch === undefined) return 'branch must be a string'
      const f = flags('rebase')
      if (typeof f === 'string') return f
      return { type: 'pull', remote, ...(branch === '' ? {} : { branch }), rebase: f['rebase'] === true }
    }
    case 'push': {
      const remote = gitText(body, 'remote')
      const branch = gitText(body, 'branch')
      const upstreamBranch = gitText(body, 'upstreamBranch', true)
      if (remote === undefined) return 'remote must be a string'
      if (branch === undefined) return 'branch must be a string'
      if (upstreamBranch === undefined) return 'upstreamBranch must be a string'
      const f = flags('setUpstream', 'force')
      if (typeof f === 'string') return f
      return { type: 'push', remote, branch, upstreamBranch, setUpstream: f['setUpstream'] === true, force: f['force'] === true }
    }
    case 'switch-branch': {
      const name = gitText(body, 'name')
      return name === undefined ? 'name must be a string' : { type: 'switch-branch', name }
    }
    case 'create-branch': {
      const name = gitText(body, 'name')
      const base = gitText(body, 'base', true)
      if (name === undefined) return 'name must be a string'
      if (base === undefined) return 'base must be a string'
      return { type: 'create-branch', name, ...(base === '' ? {} : { base }) }
    }
    case 'delete-branch': {
      const name = gitText(body, 'name')
      if (name === undefined) return 'name must be a string'
      const f = flags('remote', 'force')
      if (typeof f === 'string') return f
      return { type: 'delete-branch', name, remote: f['remote'] === true, force: f['force'] === true }
    }
    case 'stage-hunk':
    case 'unstage-hunk':
    case 'restore-hunk': {
      const path = gitText(body, 'path')
      const hunk = parseGitHunk(body['hunk'])
      if (path === undefined) return 'path must be a string'
      if (typeof hunk === 'string') return hunk
      return { type: op, path, hunk }
    }
    case 'resolve-conflict': {
      const path = gitText(body, 'path')
      const index = body['index']
      const fingerprint = gitText(body, 'fingerprint')
      const choice = body['choice']
      if (path === undefined) return 'path must be a string'
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return 'index must be a non-negative integer'
      if (fingerprint === undefined) return 'fingerprint must be a string'
      if (choice !== 'ours' && choice !== 'theirs' && choice !== 'both') return 'choice must be ours, theirs or both'
      return { type: 'resolve-conflict', path, index, fingerprint, choice }
    }
    case 'ignore': {
      const list = body['paths']
      if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) return 'paths must be an array of strings'
      return { type: 'ignore', paths: list as string[] }
    }
    default:
      return `unknown git action '${op}'`
  }
}

/** A `hunk` body value: five exact fields, four non-negative integers and a string. */
function parseGitHunk(value: unknown): GitHunkRef | string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'hunk must be { oldStart, oldLines, newStart, newLines, fingerprint }'
  const row = value as Record<string, unknown>
  const numbers = ['oldStart', 'oldLines', 'newStart', 'newLines'].map((key) => row[key])
  if (!numbers.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 0)) {
    return 'hunk must be { oldStart, oldLines, newStart, newLines, fingerprint }'
  }
  if (typeof row['fingerprint'] !== 'string') return 'hunk must be { oldStart, oldLines, newStart, newLines, fingerprint }'
  return { oldStart: row['oldStart'] as number, oldLines: row['oldLines'] as number, newStart: row['newStart'] as number, newLines: row['newLines'] as number, fingerprint: row['fingerprint'] as string }
}

/**
 * `POST …/projects/:pid/git/:op` streams one JSON frame per line: `askpass`
 * prompts while Git runs, then a single `done`. A request that is invalid
 * before Git runs answers 400 JSON (the stream starts with the first frame);
 * Git's own failure is a normal stream with `done.ok === false`. A client that
 * goes away cancels the operation. `POST …/git/askpass/:promptId` answers a prompt.
 */
async function handleProjectGitAction(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  wsId: WorkspaceId,
  pid: ProjectId,
  action: string,
): Promise<void> {
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  requireWorkspace(deps, wsId, false)
  const project = deps.workspaces.getProject(pid, wsId)
  const promptId = /^askpass\/([^/]+)$/.exec(action)?.[1]
  if (promptId === undefined && !GIT_OPERATIONS.has(action) && !GIT_QUERIES.has(action) && !GIT_STREAMS.has(action)) {
    json(404, { error: `unknown git action '${action}'` })
    return
  }
  if (req.method !== 'POST') {
    json(405, { error: 'method not allowed' })
    return
  }
  // Git here can run hooks, push and discard work: like approvals, only the
  // paired browser may drive it.
  if (!browserPrincipal(req, deps, 'POST')) {
    json(401, { error: 'git actions require the browser session that owns the workspace' })
    return
  }
  requireWorkspace(deps, wsId, true) // archived: no Git mutation
  const principalId = (req as IncomingMessage & { dntHarnessPrincipalId?: string }).dntHarnessPrincipalId
  const owner = { workspaceId: wsId as string, projectId: pid as string }

  // A fixed message: a parse error would quote the offending text, and this
  // body can carry a password or a commit message.
  let body: GitBody
  try {
    body = await readJson(req)
  } catch {
    json(400, { error: 'invalid request body' })
    return
  }

  if (promptId !== undefined) {
    const id = decodeURIComponent(promptId)
    const keys = Object.keys(body)
    const password = body['password']
    const answer = keys.length === 1 && typeof password === 'string' ? { password }
      : keys.length === 1 && body['cancel'] === true ? { cancel: true as const }
        : undefined
    if (answer === undefined) {
      json(400, { error: 'body must be exactly { password: string } or { cancel: true }' })
      return
    }
    const asker = promptPrincipals.get(id)
    if (principalId !== undefined && asker !== undefined && asker !== principalId) {
      json(401, { error: 'prompt belongs to a different browser session' })
      return
    }
    if (!answerGitAskpass(id, answer, owner)) {
      json(404, { error: 'no such prompt' })
      return
    }
    json(200, { answered: true })
    return
  }

  const trusted = project.gitTrusted === true
  let request: GitOperationRequest | undefined
  if (GIT_OPERATIONS.has(action)) {
    const parsed = parseGitOperation(action, body)
    if (typeof parsed === 'string') {
      json(400, { error: parsed })
      return
    }
    request = parsed
  }

  let started = false
  let aborted = false
  let session: AskpassSession | undefined
  const raised = new Set<string>()
  const frame = (value: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    if (!started) {
      started = true
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    }
    res.write(`${JSON.stringify(value)}\n`)
  }
  // `res` closes without having ended only when the client went away.
  const onClose = (): void => {
    if (res.writableFinished) return
    aborted = true
    session?.cancelAll()
  }
  res.once('close', onClose)
  try {
    if (GIT_STREAMS.has(action)) {
      if (action === 'commit-message') {
        const subject = body['subject']
        if (subject !== undefined && typeof subject !== 'string') {
          json(400, { error: 'subject must be a string' })
          return
        }
        const model = deps.commitMessageModel()
        if ('error' in model) {
          json(400, { error: model.error })
          return
        }
        // A client that leaves while the diff is still being read must stop the
        // work before the model is asked: `aborted` is the outer close flag.
        const diff = await commitMessageDiff(project.path, trusted)
        if (aborted || res.destroyed) return
        const prompt = commitMessagePrompt(diff, subject === undefined ? undefined : subject)
        const controller = new AbortController()
        const onStreamClose = (): void => { if (!res.writableFinished) controller.abort() }
        res.once('close', onStreamClose)
        const startedAt = Date.now()
        // Some providers report usage more than once; the last report wins (as the session tap does).
        let lastUsage: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number } | undefined
        try {
          frame({ type: 'start' })
          for await (const text of streamCommitMessage(
            { stream: (request, signal) => deps.commitMessageStream(request, signal) },
            { providerName: model.providerName, model: model.model, prompt },
            controller.signal,
            (usage) => { lastUsage = usage },
          )) {
            frame({ type: 'delta', text })
          }
          frame({ type: 'done', ok: true })
        } finally {
          res.off('close', onStreamClose)
          if (lastUsage !== undefined) {
            deps.recordUsage({
              v: 1, at: Date.now(), startedAt, workspaceId: wsId as string,
              sessionId: `git:${pid as string}`, rootSessionId: `git:${pid as string}`,
              kind: 'commit-message', provider: model.providerName, model: model.model,
              input: lastUsage.inputTokens, cached: lastUsage.cachedInputTokens ?? 0,
              cacheReported: lastUsage.cachedInputTokens !== undefined, output: lastUsage.outputTokens ?? 0,
            })
          }
        }
      }
      return
    }
    if (request === undefined) {
      if (action === 'remotes') {
        const branch = gitText(body, 'branch')
        if (branch === undefined || (body['push'] !== undefined && typeof body['push'] !== 'boolean') || (body['all'] !== undefined && typeof body['all'] !== 'boolean')) {
          json(400, { error: 'branch must be a string, push and all booleans' })
          return
        }
        frame({ type: 'done', ok: true, stdout: '', stderr: '', remotes: await listProjectGitRemotes(project.path, trusted, branch, body['push'] === true, body['all'] === true) })
      } else if (action === 'branches') {
        frame({ type: 'done', ok: true, stdout: '', stderr: '', ...(await listProjectGitBranches(project.path, trusted)) })
      } else {
        frame({ type: 'done', ok: true, stdout: '', stderr: '', pushedTo: await pushedTo(project.path, trusted) })
      }
    } else {
      const result = await runProjectGitOperation(
        project.path,
        trusted,
        request,
        {
          operation: action,
          owner,
          onPrompt: (prompt) => {
            raised.add(prompt.promptId)
            promptPrincipals.set(prompt.promptId, principalId)
            frame(prompt)
          },
          onSession: (live) => {
            session = live
            if (aborted) live.cancelAll()
          },
        },
        deps.deniedRoots === undefined ? {} : { deniedRoots: deps.deniedRoots },
      )
      frame({
        type: 'done',
        ok: result.ok,
        stdout: result.stdout,
        stderr: result.stderr,
        status: result.status,
        ...(result.cancelled === true ? { cancelled: true } : {}),
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!started && !res.headersSent) {
      if (error instanceof ProjectGitError) json(400, { error: message })
      else throw error
    } else if (GIT_STREAMS.has(action)) {
      // A model stream has no repository status to offer: its client reads `error`.
      frame({ type: 'done', ok: false, error: message })
    } else {
      // Git may have changed the repository before failing: offer the current
      // status when it can be read, otherwise leave it out.
      const status = res.destroyed ? undefined : await gitStatus(project.path, deps.deniedRoots, trusted).catch(() => undefined)
      frame({ type: 'done', ok: false, stdout: '', stderr: message, ...(status === undefined ? {} : { status }) })
    }
  } finally {
    res.off('close', onClose)
    for (const id of raised) promptPrincipals.delete(id)
    if (started && !res.writableEnded) res.end()
  }
}

// ── session operation helpers ──────────────────────────────────

/** The workspace owning sessions when the caller does not address one. */
function implicitWorkspace(deps: HandlerDeps): WorkspaceId {
  return deps.deniedRoots !== undefined ? defaultWorkspaceId(deps) : MEMORY_WORKSPACE
}

/**
 * Explorer writes on `…/projects/:pid/files`: POST creates, PATCH renames in
 * place, DELETE removes. A direct user action like the workbench terminal, so
 * no session mode applies; containment lives in `project-files-write.ts`.
 */
async function handleProjectFileWrite(
  req: IncomingMessage,
  query: URLSearchParams,
  root: string,
  deniedRoots: readonly string[] | undefined,
  send: (status: number, body: unknown) => void,
): Promise<void> {
  try {
    if (req.method === 'DELETE') {
      const removed = await deleteProjectEntry(root, query.get('path') ?? '', deniedRoots)
      send(200, { deleted: true, path: removed.path })
      return
    }
    let body: Record<string, unknown>
    try {
      body = await readJson(req)
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const rawPath = body['path']
    if (typeof rawPath !== 'string') {
      send(400, { error: "'path' must be a string" })
      return
    }
    if (req.method === 'POST') {
      const kind = body['kind']
      if (kind !== 'file' && kind !== 'dir') {
        send(400, { error: "'kind' must be 'file' or 'dir'" })
        return
      }
      send(201, await createProjectEntry(root, rawPath, kind, deniedRoots))
      return
    }
    const name = body['name']
    if (typeof name !== 'string') {
      send(400, { error: "'name' must be a string" })
      return
    }
    send(200, await renameProjectEntry(root, rawPath, name, deniedRoots))
  } catch (error) {
    if (!(error instanceof ProjectWriteError)) throw error
    send(error.status, { error: error.message })
  }
}

/**
 * Viewer saves on `…/projects/:pid/file`: PUT `{path, content, expectedHash}`.
 * A stale hash answers 409 with `currentHash`; containment, encoding and the
 * atomic write live in `saveProjectFile`.
 */
async function handleProjectFileSave(
  req: IncomingMessage,
  root: string,
  deniedRoots: readonly string[] | undefined,
  send: (status: number, body: unknown) => void,
): Promise<void> {
  let body: Record<string, unknown>
  try {
    // JSON escaping can double a file, so the body may exceed the general cap.
    body = await readJson(req, 4 * MAX_FILE_BYTES)
  } catch (error) {
    send(400, { error: error instanceof Error ? error.message : String(error) })
    return
  }
  const rawPath = body['path']
  const content = body['content']
  const expectedHash = body['expectedHash']
  if (typeof rawPath !== 'string') { send(400, { error: "'path' must be a string" }); return }
  if (typeof content !== 'string') { send(400, { error: "'content' must be a string" }); return }
  if (typeof expectedHash !== 'string' || expectedHash === '') { send(400, { error: "'expectedHash' must be a non-empty string" }); return }
  try {
    send(200, await saveProjectFile(root, rawPath, content, expectedHash, deniedRoots))
  } catch (error) {
    if (!(error instanceof ProjectWriteError)) throw error
    send(error.status, error.currentHash !== undefined ? { error: error.message, currentHash: error.currentHash } : { error: error.message })
  }
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
      await deps.settleStaleRuns(wsId, id)
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
    const { provider, model, thinkingLevel, alias } = submitted as Record<string, unknown>
    if (alias !== undefined && alias !== null && (typeof alias !== 'string' || alias === '')) {
      return { ok: false, status: 400, error: "'controls.alias' must be a non-empty string or null" }
    }
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
    defaults = { provider, model, thinkingLevel, ...(typeof alias === 'string' && provider !== null ? { alias } : {}) }
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
    // The alias is a display label for the pair above; null when picked directly.
    alias: defaults.alias ?? null,
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
 * Queue an `asyncRewake` hook's result for a root conversation: durable
 * `input/queued` with `origin: 'hook'`, then the same drain a queued message
 * uses — an idle conversation wakes, a running turn keeps it queued behind
 * it, nothing is ever steered. False when the conversation cannot take it
 * (child, closed, unavailable, no model, queue full).
 */
async function queueHookRewake(entry: SessionEntry, deps: HandlerDeps, content: string, summary: string): Promise<boolean> {
  if (entry.closed || deps.unavailableSessions.has(entry.session.id)) return false
  if (entry.session.events.some((event) => event.type === 'session/child-meta')) return false
  const effectiveModel = deps.resolveEffectiveModel(entry.session, entry.workspaceId)
  if (effectiveModel.model === undefined || effectiveModel.model === null || effectiveModel.provider === undefined || effectiveModel.provider === null) return false
  const stillPending = deps.kernel.ctx.sessions.pendingInputs(entry.session)
  if (stillPending.length >= deps.limits.maxPendingInputs) return false
  const inputId = newInputId()
  const runsNow = !entry.agent.busy
    && !deps.childExecutor.delegationPending(entry.session.id)
    && !deps.compactionPending(entry.session.id)
    && !deps.kernel.ctx.llm.sessionUncertain(entry.session.id)
  entry.session.append({
    type: 'input/queued',
    inputId,
    content,
    origin: 'hook',
    summary,
    ...(runsNow ? { runsNow: true as const } : {}),
  })
  await entry.session.durable()
  // Re-read after the barrier: a DELETE/PATCH that landed meanwhile must win.
  entry.agent.adoptPending(deps.kernel.ctx.sessions.pendingInputs(entry.session))
  if (!deps.compactionPending(entry.session.id)) await dispatchInbox(entry, deps, 'queue')
  return true
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
    && !deps.childExecutor.delegationPending(entry.session.id)
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
  // Read after the barrier, not the pre-append snapshot: a DELETE/PATCH that
  // landed during the await (this input included) must not be undone.
  entry.agent.adoptPending(deps.kernel.ctx.sessions.pendingInputs(entry.session))
  if (deps.compactionPending(entry.session.id)) {
    return { ok: true, status: 202, body: { inputId, queued: true, delivery, dispatchBlocked: 'maintenance' } }
  }
  const wasBusy = entry.agent.busy || deps.childExecutor.delegationPending(entry.session.id)
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
    await deps.childExecutor.admitConversation(entry.session.id, () => {
      if (entry.closed || deps.compactionPending(entry.session.id)) return
      void entry.agent.run().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`web: agent run failed for ${entry.session.id}: ${message}`)
        deps.kernel.ctx.emit('web/turn-error', { sessionId: entry.session.id, message })
      })
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
  const alias = body['alias']
  if ((provider !== undefined && provider !== null && typeof provider !== 'string')
    || (model !== undefined && model !== null && typeof model !== 'string')) {
    return { ok: false, status: 400, error: "body accepts optional string|null 'provider' and 'model'" }
  }
  if (alias !== undefined && alias !== null && (typeof alias !== 'string' || alias === '')) {
    return { ok: false, status: 400, error: "'alias' must be a non-empty string or null" }
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
  // The alias names how the pair was picked, so it follows the pair: a pick
  // without one clears it, and a thinking-only edit leaves it alone.
  const pairChanged = provider !== undefined || model !== undefined
  entry.session.append({
    type: 'session/model',
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    ...(alias !== undefined ? { alias } : pairChanged ? { alias: null } : {}),
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
    const pickedAlias = typeof alias === 'string' ? alias : null
    if (steady.provider !== resultingProvider || steady.model !== resultingModel || (steady.alias ?? null) !== pickedAlias) {
      await deps.mutateProviderStore(({ providers, defaults }) => ({
        providers,
        defaults: { provider: resultingProvider, model: resultingModel, thinkingLevel: defaults.thinkingLevel, ...(typeof alias === 'string' ? { alias } : {}) },
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
  const provider = body['provider']; const model = body['model']; const thinkingLevel = body['thinkingLevel']; const alias = body['alias']
  if (alias !== undefined && alias !== null && (typeof alias !== 'string' || alias === '')) return { ok: false, status: 400, error: "'alias' must be a non-empty string or null" }
  if (!Object.hasOwn(body, 'provider') || !Object.hasOwn(body, 'model')) return { ok: false, status: 400, error: "body needs complete 'provider' and 'model' pair" }
  if ((provider !== null && typeof provider !== 'string') || (model !== null && typeof model !== 'string') || (thinkingLevel !== undefined && thinkingLevel !== null && !isThinkingLevel(thinkingLevel))) {
    return { ok: false, status: 400, error: "body needs provider/model strings or null, plus documented thinkingLevel or null" }
  }
  if ((provider === null) !== (model === null) || (provider === '' || model === '')) return { ok: false, status: 400, error: 'provider and model must both be configured or both be blank' }
  const next: ModelDefaults = { provider, model, thinkingLevel: thinkingLevel === undefined ? deps.defaults().thinkingLevel : thinkingLevel, ...(typeof alias === 'string' && provider !== null ? { alias } : {}) }
  if (provider !== null && model !== null) {
    try { deps.validateProviderModel(provider, model) } catch (error) { return { ok: false, status: 400, error: String(error instanceof Error ? error.message : error) } }
  }
  try {
    await deps.mutateProviderStore(({ providers, defaults }) => ({
      providers,
      defaults: { provider: next.provider, model: next.model, thinkingLevel: thinkingLevel === undefined ? defaults.thinkingLevel : next.thinkingLevel, ...(next.alias !== undefined && next.alias !== null ? { alias: next.alias } : {}) },
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
  // Sessions blocked on a human (approval or AskUserQuestion); a waiting child
  // also marks its parent, since that is the row the sidebar nests it under.
  const awaitingUser = new Set<string>()
  for (const waiting of [...deps.pending.values(), ...deps.pendingQuestions.values()]) {
    awaitingUser.add(waiting.sessionId)
    if (waiting.parentSessionId !== undefined) awaitingUser.add(waiting.parentSessionId)
  }
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
      ...(summary.eventCount > 0
        ? { createdAt: summary.createdAt, updatedAt: summary.updatedAt, lastUserActivityAt: summary.lastUserActivityAt ?? summary.updatedAt }
        : {}),
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
      // A compaction is not a turn (agent.status stays idle), yet the conversation is busy.
      compacting: deps.compactionPending(summary.id as SessionId),
      awaitingUser: awaitingUser.has(summary.id as SessionId),
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

/** Full teardown of one conversation; a refusal leaves it untouched. Shared by session DELETE and forced workspace DELETE. */
async function removeSession(entry: SessionEntry, wsId: WorkspaceId, deps: HandlerDeps): Promise<{ status: number; error: string } | undefined> {
  deps.cancelCompaction(entry.session.id)
  await deps.settleCompaction(entry.session.id)
  if (entry.agent.busy) return { status: 409, error: 'session is running; stop it before deleting' }
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
    return { status: 500, error: `SessionEnd hook/audit failed; session kept: ${String(error instanceof Error ? error.message : error)}` }
  }
  // Children spawned over HTTP can outlive an idle root: stop them
  // first, so none keeps running against a deleted conversation.
  // Background processes die the same way — silently, because the
  // session's log (their only reader) is being deleted.
  await deps.processes.dispose(entry.session.id)
  await deps.backgroundHooks.forgetRoot(entry.session.id)
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
  return undefined
}

interface ContextReducerCache {
  readonly session: Session
  readonly reducer: ContextReducer<ContextManifest>
  last?: { readonly seq: number; readonly type: string }
}

/**
 * The committed context view, applying only the committed suffix since the
 * last GET. A new session instance or a replaced prefix (the remembered last
 * event no longer sits at its seq with its type) starts a fresh reducer.
 */
function committedContextView(session: Session, cache: Map<SessionId, ContextReducerCache>): ContextResponse<ContextManifest> | null {
  const events = session.committedEvents
  let cached = cache.get(session.id)
  // Seqs are 1-based positions in the log, so the remembered event sits at seq - 1.
  const at = cached?.last === undefined ? undefined : events[cached.last.seq - 1]
  if (cached === undefined || cached.session !== session
    || (cached.last !== undefined && (at?.seq !== cached.last.seq || at.type !== cached.last.type))) {
    cached = { session, reducer: createContextReducer<ContextManifest>(session.id) }
    cache.set(session.id, cached)
  }
  const suffix = events.slice(cached.last?.seq ?? 0)
  cached.reducer.apply(suffix)
  const tail = events.at(-1)
  if (tail !== undefined) cached.last = { seq: tail.seq, type: tail.type }
  return cached.reducer.current()
}

/** A deleted session leaves no per-session index behind (manifest, child indexes). */
async function forgetSessionState(sessionId: SessionId, deps: HandlerDeps): Promise<void> {
  deps.lastManifests.delete(sessionId)
  deps.contextReducers.delete(sessionId)
  deps.contextBodies.delete(sessionId)
  deps.completedRequests.delete(sessionId)
  await deps.forgetCompactionCapture(sessionId)
  deps.prefixSnapshots.delete(sessionId)
  for (const childId of await deps.childExecutor.forgetRoot(sessionId)) {
    deps.lastManifests.delete(childId)
    deps.contextReducers.delete(childId)
    deps.contextBodies.delete(childId)
    deps.completedRequests.delete(childId)
    deps.prefixSnapshots.delete(childId)
  }
}

/**
 * One session's snapshot of the frequently-edited prefix sources. `key`
 * names what the copy was read under (project + compaction boundary); any
 * change to it means the prefix moves anyway, so the copy is re-read then.
 * A field is absent until a request first needs it.
 */
interface PrefixSnapshot {
  readonly key: string
  skillCatalog?: readonly { readonly name: string; readonly description: string }[]
  memory?: readonly MemorySnippet[]
}

/** A completed root request that can seed cache-aware compaction for its turn. */
interface CompactionPrefix {
  readonly turnId: TurnId
  readonly request: ModelRequest
}

/** Keep only the fields that shape the provider wire prefix; drop host-only handles. */
function compactionRequestOf(request: ModelRequest): ModelRequest {
  return {
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.providerName !== undefined ? { providerName: request.providerName } : {}),
    ...(request.thinkingLevel !== undefined ? { thinkingLevel: request.thinkingLevel } : {}),
    messages: request.messages,
    ...(request.tools !== undefined ? { tools: request.tools } : {}),
  }
}

/**
 * The final answer of the newest completed turn, when the stored prefix is
 * exactly that turn's last model request. Anything else (a failed or
 * cancelled later turn, a different turn, no text answer) returns undefined.
 */
function compactionAnswerFor(events: readonly SessionEvent[], prefix: CompactionPrefix): string | undefined {
  const end = events.findLast((event) => event.type === 'turn/end')
  if (end?.type !== 'turn/end' || end.turnId !== prefix.turnId || end.reason !== 'completed') return undefined
  const start = events.findLast((event) => event.type === 'turn/start' && event.turnId === prefix.turnId)
  if (start === undefined) return undefined
  const answer = events.findLast((event) => event.seq > start.seq && event.seq < end.seq && event.type === 'assistant/message')
  if (answer?.type !== 'assistant/message' || answer.toolCalls !== undefined || answer.content.trim() === '') return undefined
  return answer.content
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
      ...(typeof entry['maxOutputTokens'] === 'number' && Number.isSafeInteger(entry['maxOutputTokens']) && entry['maxOutputTokens'] > 0
        ? { maxOutputTokens: entry['maxOutputTokens'] }
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

async function readJson(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) {
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
 * What a browser needs from a restoration is what happened to each piece of state
 * (`sections`), not the restored text: that is up to 25k tokens of file and skill
 * contents the log already holds for the model, and a fresh connection would
 * otherwise replay it in full.
 */
function withoutRestorationText(event: Extract<SessionEvent, { type: 'compaction/restoration' }>): SessionEvent {
  const { body: _body, ...rest } = event
  void _body
  return rest as unknown as SessionEvent
}

/**
 * The replay profile a fresh SSE client needs: `context/body` payloads (fetched
 * on demand by hash) are dropped, content chunks of steps that later carry a
 * durable `assistant/message` are dropped, and reasoning chunks fold to one
 * event per step. Mirrors the client's `compactClientEvents` so the wire
 * carries exactly what the browser would keep, instead of every raw chunk of
 * a long session's history on each fresh connect. Live events after this
 * frame stream raw and the client still compacts them, so both paths agree.
 *
 * A successful `compaction/end` whose durability barrier has not committed is
 * also a replay boundary: it and everything behind it are cut, because a
 * reconnect would otherwise see a state the canonical log may never hold.
 * `heldCompactionSeq` is the seq of that end (0 when nothing is held).
 */
function compactReplayEvents(events: readonly SessionEvent[], heldCompactionSeq = 0): SessionEvent[] {
  const finalizedSteps = new Set<string>()
  const abandonedSteps = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message' && event.stepId !== undefined) finalizedSteps.add(event.stepId)
    if (event.type === 'step/abandoned' && event.stepId !== undefined) abandonedSteps.add(event.stepId)
  }
  const compacted: SessionEvent[] = []
  const folded = new Map<string, number>()
  for (const event of events) {
    if (heldCompactionSeq > 0 && event.seq >= heldCompactionSeq) break
    if (event.type === 'context/body') continue
    if (event.type === 'compaction/restoration') {
      compacted.push(withoutRestorationText(event))
      continue
    }
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

  // Native reconnect headers supersede the initial cached-navigation cursor.
  const rawCursor = req.headers['last-event-id'] ?? new URL(req.url ?? '/', 'http://localhost').searchParams.get('cursor')
  const cursor = typeof rawCursor === 'string' && /^\d+$/.test(rawCursor) ? Number(rawCursor) : NaN
  const latest = session.events.at(-1)?.seq ?? 0
  const earliest = session.events[0]?.seq ?? 1
  const resumable = Number.isSafeInteger(cursor) && cursor >= earliest - 1 && cursor <= latest
  // A successful compaction/end that the durability barrier has not committed
  // holds this stream: it, and every event appended behind it, wait for the
  // commit instead of describing a state the canonical log may never hold.
  // Normal chunks (never barriered themselves) keep streaming immediately.
  let held: { seq: number; queue: { envelope: WebEnvelope; sequence: number | undefined }[] } | undefined
  const findHeldCompaction = (): number => {
    for (const event of session.events) {
      if (event.type === 'compaction/end' && event.error === undefined && event.seq > session.committedSeq) return event.seq
    }
    return 0
  }
  const toFrame = (event: SessionEvent): WebEnvelope => ({ kind: 'session', event: event.type === 'compaction/restoration' ? withoutRestorationText(event) : event })
  const heldSeq = findHeldCompaction()
  // The replay below stops before the held success, so the success and the
  // tail already appended behind it seed the queue: they ship on commit.
  if (heldSeq > 0) held = { seq: heldSeq, queue: session.events.filter((event) => event.seq >= heldSeq && event.type !== 'context/body').map((event) => ({ envelope: toFrame(event), sequence: event.seq })) }
  // Both replay shapes are compacted: a fresh snapshot otherwise ships every
  // raw chunk of the session's history, and a long-disconnect resume replays
  // the same bulk. Sequence numbers stay untouched so the client's seen-cursor
  // filtering and its own compaction keep working unchanged. A held compaction
  // success also cuts the replay tail: reconnect must not see the uncommitted
  // state either.
  const replay = compactReplayEvents(resumable ? session.events.filter((event) => event.seq > cursor) : [...session.events], held?.seq ?? 0)
  streamFrame({ kind: resumable ? 'resume' : 'snapshot', events: replay }, held === undefined ? latest : (held.seq - 1))
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
    if (emitter.id !== session.id || event.type === 'context/body') return
    const frame = toFrame(event)
    // A failed end never publishes a checkpoint: it drops the uncommitted
    // success (the queue head) and releases what queued behind it.
    if (event.type === 'compaction/end' && event.error !== undefined) {
      const dropped = held
      held = undefined
      for (const { envelope, sequence } of dropped?.queue.slice(1) ?? []) streamFrame(envelope, sequence)
      streamFrame(frame, event.seq)
      return
    }
    if (held !== undefined) {
      // Behind an uncommitted success: queue instead of shipping. The success
      // itself is the hold's head, so it is queued exactly once, at its seq.
      held.queue.push({ envelope: frame, sequence: event.seq })
      return
    }
    if (event.type === 'compaction/end' && event.error === undefined && event.seq > session.committedSeq) {
      // The success appended but its barrier has not committed: it heads the hold.
      held = { seq: event.seq, queue: [{ envelope: frame, sequence: event.seq }] }
      return
    }
    streamFrame(frame, event.seq)
  })
  // The commit releases the hold: drain the queued prefix in seq order.
  const disposeDurable = deps.kernel.ctx.on('session/durable', (emitter) => {
    if (emitter.id !== session.id || held === undefined) return
    if (session.committedSeq < held.seq) return
    const draining = held
    held = undefined
    for (const { envelope, sequence } of draining.queue) streamFrame(envelope, sequence)
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
        ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
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
    disposeDurable()
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

/**
 * Serve one stored video with `Range` support (players seek and probe with
 * ranges). A single `bytes=first-last` is honored; anything else is refused
 * with 416 rather than silently ignored.
 */
async function serveStoredVideo(store: VideoStore, workspaceId: string, id: string, req: IncomingMessage, res: ServerResponse, send: (status: number, body: unknown) => void): Promise<void> {
  let info: Awaited<ReturnType<VideoStore['stat']>>
  try {
    info = await store.stat(workspaceId, id)
  } catch (error) {
    if (!(error instanceof VideoStoreError)) throw error
    send(404, { error: error.message })
    return
  }
  const headers: Record<string, string | number> = {
    'content-type': info.mediaType,
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  }
  const pipe = async (range?: { start: number; end: number }): Promise<void> => {
    const stream = store.stream(workspaceId, id, range)
    stream.on('error', () => { res.destroy() })
    await new Promise<void>((resolve) => stream.pipe(res).on('close', resolve))
  }
  const range = req.headers.range
  if (range === undefined) {
    res.writeHead(200, { ...headers, 'content-length': info.bytes })
    if (req.method === 'HEAD') { res.end(); return }
    await pipe()
    return
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  const first = match === null || match[1] === '' ? undefined : Number(match[1])
  const last = match === null || match[2] === '' ? undefined : Number(match[2])
  const unsatisfiable = match === null || (first === undefined && last === undefined) || (first !== undefined && first >= info.bytes) || (first === undefined && last === 0)
  if (unsatisfiable) {
    res.writeHead(416, { 'content-range': `bytes */${info.bytes}` })
    res.end()
    return
  }
  const start = first ?? Math.max(0, info.bytes - (last ?? 0))
  const end = first !== undefined && last !== undefined ? Math.min(last, info.bytes - 1) : info.bytes - 1
  if (end < start) {
    res.writeHead(416, { 'content-range': `bytes */${info.bytes}` })
    res.end()
    return
  }
  res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${info.bytes}`, 'content-length': end - start + 1 })
  if (req.method === 'HEAD') { res.end(); return }
  await pipe({ start, end })
}

/** Hashed asset paths are safe to cache forever; everything else revalidates per request. */
const IMMUTABLE_ASSET_PATH = /^\/assets\//

/**
 * The host an install should be labelled with, so the same app served from several
 * domains stays distinguishable in the OS window list and launcher. Loopback hosts
 * keep the plain name: there is only one of them per machine.
 */
function installLabel(hostHeader: string | undefined): string | undefined {
  const hostname = requestHostname(hostHeader)
  if (hostname === undefined || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return undefined
  return hostname
}

/**
 * Host first: taskbars truncate the tail, and the host is the part that differs.
 * Launchers fit ~12 characters under an icon, so short_name keeps only the first DNS label.
 */
function manifestWithHost(manifest: Record<string, unknown>, host: string): Record<string, unknown> {
  return { ...manifest, name: `${host} · dnt-harness`, short_name: isIP(host) === 0 ? host.split('.')[0] : host }
}

function brandManifest(content: Buffer, host: string): Buffer {
  try {
    return Buffer.from(JSON.stringify(manifestWithHost(JSON.parse(content.toString('utf8')) as Record<string, unknown>, host)))
  } catch {
    return content
  }
}

function brandShell(content: Buffer, host: string): Buffer {
  const label = `${host} · dnt-harness`.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return Buffer.from(content.toString('utf8')
    .replace('<title>dnt-harness</title>', () => `<title>${label}</title>`)
    .replace('name="apple-mobile-web-app-title" content="dnt-harness"', () => `name="apple-mobile-web-app-title" content="${label}"`))
}

/** Serve the built client: `/` (and unknown paths) fall back to index.html for the router. */
async function serveStatic(res: ServerResponse, pathname: string, staticDir: string, acceptEncoding: string | undefined, hostHeader?: string): Promise<void> {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const host = installLabel(hostHeader)
  const abs = path.resolve(staticDir, relative)
  if (abs !== path.resolve(staticDir) && !abs.startsWith(`${path.resolve(staticDir)}${path.sep}`)) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'forbidden' }))
    return
  }
  // Precompressed twins (.br/.gz, emitted at build time) stream as-is when the
  // client's Accept-Encoding allows: no per-request compression on the hot path.
  // The manifest and the shell are rewritten per host below, so they never use a precompressed twin.
  const hostScoped = host !== undefined && (relative === 'manifest.webmanifest' || relative === 'index.html')
  const encoding = hostScoped
    ? undefined
    : acceptEncoding !== undefined && acceptEncoding.includes('br')
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
    if (host !== undefined && hostScoped) content = relative === 'index.html' ? brandShell(content, host) : brandManifest(content, host)
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
      res.end(host === undefined ? shell : brandShell(shell, host))
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
