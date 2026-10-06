/**
 * dnt-harness: a TypeScript agent harness built from scratch — a
 * Cordis-inspired plugin kernel plus an agent core (durable session log, LLM
 * streaming seam, turn/step driver).
 */
// ── Kernel ────────────────────────────────────────────────────────────────
export { EventBus, type Events, type DispatchMode, type EventOptions } from './kernel/events.ts'
export {
  Fiber,
  assertNever,
  type Effect,
  type EffectMeta,
  type FiberState,
} from './kernel/fiber.ts'
export { ServiceStore, type ServiceChange } from './kernel/store.ts'
export { Context, createContext } from './kernel/context.ts'
export { Service } from './kernel/service.ts'
export {
  Kernel,
  resolvePlugin,
  type PluginTarget,
  type ResolvedPlugin,
} from './kernel/registry.ts'
export {
  boot,
  bootFromFile,
  loadPluginModule,
  parseConfig,
  type ConfigEntry,
} from './kernel/loader.ts'

// ── Util ──────────────────────────────────────────────────────────────────
export type { Branded, SessionId, StepId, TurnId, ExecutionId, InputId, WorkspaceId, ProjectId } from './util/brand.ts'
export { newSessionId, newStepId, newTurnId, newExecutionId, newInputId, newWorkspaceId, newProjectId } from './util/brand.ts'

export { AttemptAdmission, LogicalRequest, classifyTransport, runAttempt, type AttemptTicket, type PhysicalAdmission, type RequestPolicy, type AttemptFact, type AttemptObserver } from './harness/llm/request-lifecycle.ts'

// ── Harness: limits ──────────────────────────────────────────────────────
export { DEFAULT_LIMITS, resolveLimits, type HarnessLimits } from './harness/limits.ts'

// ── Harness: session log ─────────────────────────────────────────────────
export {
  deriveMessages,
  deriveSessionModel,
  sessionModelOf,
  type ApprovalDecision,
  type RequestControls,
  type SessionAppendedEvent,
  type SessionEvent,
  type SessionModel,
  type TurnEndReason,
  type TurnErrorKind,
} from './harness/session/events.ts'
export { Session, type SessionOptions } from './harness/session/session.ts'
export { deriveTitle, TITLE_MAX_LENGTH } from './harness/session/title.ts'
export {
  SessionsService,
  fileSessions,
  type SessionsServiceOptions,
} from './harness/session/service.ts'

// ── Harness: durable storage ─────────────────────────────────────────────
export {
  FileSessionStore,
  type SessionStore,
  type SessionSummary,
  type FileSessionStoreOptions,
} from './harness/storage/file-session-store.ts'
export {
  EVENT_SCHEMA_VERSION,
  SessionLogError,
  type SessionLogErrorKind,
} from './harness/storage/events-jsonl.ts'

// ── Harness: LLM seam ────────────────────────────────────────────────────
export type {
  ContentPart,
  ModelFinishReason,
  ModelCompletion,
  CompletionPolicy,
  ProviderErrorReason,
  ProviderErrorPhase,
  LlmProvider,
  ModelMessage,
  ModelRequest,
  StreamEvent,
  StreamOptions,
  ToolCall,
  ToolSchema,
} from './harness/llm/types.ts'
export { messageText, ProviderError } from './harness/llm/types.ts'
export { WIRE_LIMITS, encodedBytes, normalizeFinishReason, validateCompletion, validateToolBatch, withLegacyCompletion, readBoundedError, readSse } from './harness/llm/completion.ts'
export {
  AttachmentError,
  AttachmentStore,
  isImageMediaType,
  isSupportedMediaType,
  isTextMediaType,
  normalizeMediaType,
  sniffImageMediaType,
  type AttachmentLookup,
  type AttachmentRef,
  type LoadedAttachment,
} from './harness/attachments/store.ts'
export { LlmService } from './harness/llm/service.ts'
export { DeepSeekProvider } from './harness/llm/deepseek.ts'
export { OpenAiCompletionsProvider, type OpenAiCompletionsOptions } from './harness/llm/openai.ts'
export {
  DEFAULT_CONTEXT_LIMIT,
  THINKING_LEVELS,
  applyThinkingOverride,
  bareModelId,
  defaultThinkingLevel,
  expressibleThinkingLevel,
  formatContextLimit,
  getModelInfo,
  getReasoningCapability,
  isThinkingLevel,
  knownModelLimit,
  resolveContextLimit,
  supportsReasoningControl,
  type ModelInfo,
  type ModelMetadata,
  type ReasoningCapability,
  type ReasoningLevel,
  type ThinkingLevel,
} from './harness/llm/model-catalog.ts'

// ── Harness: agent ───────────────────────────────────────────────────────
export type {
  AgentStatus,
  InboxItem,
  PreStepDecision,
} from './harness/agent/types.ts'
export { Agent } from './harness/agent/agent.ts'
export type { AgentIdentity } from './harness/agent/service.ts'
export { AgentsService } from './harness/agent/service.ts'
export { agentScope } from './harness/agent/scope.ts'

// ── Harness: modes (G3) ─────────────────────────────────────────────────
export {
  ModesService,
  ModeError,
  BUNDLED_MODES,
  DEFAULT_MODE_ID,
  parseModeFile,
  serializeModeFile,
  type ModeDefinition,
  type ModeFrontmatter,
  type ModeSources,
  type ResolvedMode,
} from './harness/modes/service.ts'

// ── Harness: context builder + budget + compaction (G3) ────────────────
export {
  buildContext,
  DEFAULT_BASE_SYSTEM,
  DEFAULT_CHILD_SYSTEM,
  ContextBudgetError,
  CLEARED_TOOL_RESULT,
  MICROCOMPACT_KEEP_RECENT,
  wrapUntrusted,
  type ActiveSkill,
  type AssembledContext,
  type BuildContextInput,
  type ContextManifest,
  type ContextSection,
  type MemorySnippet,
} from './harness/context/builder.ts'
export {
  renderEnvironmentContext,
  formatEnvironmentDate,
  type EnvironmentFacts,
} from './harness/context/environment.ts'
export {
  DEFAULT_BUDGET,
  budgetFor,
  estimateTokens,
  schemaCost,
  type BudgetConfig,
  type ResolvedBudget,
} from './harness/context/budget.ts'
export {
  CheckpointStore,
  compactSession,
  type CompactionCheckpoint,
  type Summarizer,
} from './harness/context/compaction.ts'

// ── Harness: skills (G3) ────────────────────────────────────────────────
export { SkillsService, parseSkill, type SkillEntry, type LoadedSkill } from './harness/skills/service.ts'
export { SkillError, defaultSkillRules, projectRuleBase, absoluteRuleBase, absoluteRuleTooBroad, assertSkillName, assertWritableSkillName, RESERVED_SKILL_NAMES, SKILL_NAME_PATTERN, validateSkillRules, validateSkillRulesForWrite, resolveSkillLayers, protectedRootsForRules, MAX_SKILL_RULES, type SkillRule, type SkillLayer, type SkillSource } from './harness/skills/layers.ts'

// ── Harness: memory (G3) ────────────────────────────────────────────────
export { MemoryService, MemoryError, memoryTools, type MemoryEntry } from './harness/memory/index.ts'

// ── Harness: agent definitions + multi-agent (G4) ───────────────────────
export {
  AgentDefinitionService,
  AgentDefinitionError,
  BUNDLED_AGENT_ROLES,
  bundledDefinition,
  parseAgentDefinition,
  type AgentDefinition,
  type ResolvedAgentDefinition,
} from './harness/agents/definition-service.ts'
export {
  ChildExecutor,
  SpawnError,
  normalizeBrief,
  MAX_REPORT_CHARS,
  type TaskPacket,
  type SpawnRequest,
  type ChildHandle,
  type ChildResult,
  type ChildStatus,
} from './harness/agents/executor.ts'
export {
  importClaudeDefinition,
  importCodexDefinition,
  CODEX_PINNED_VERSION,
  type ClaudeImportResult,
  type CodexImportResult,
} from './harness/agents/compatibility/claude.ts'

// ── Harness: workspaces & projects ─────────────────────────────────────
export {
  WorkspaceService,
  ScopeError,
  type AppRecord,
  type ProjectRecord,
  type WorkspaceRecord,
  type WorkspaceSummary,
} from './harness/workspace/service.ts'

// ── Harness: tool pipeline ───────────────────────────────────────────────
export type { ApprovedPath, GrantedRoot, PathIntent, PreExecuteDecision, ToolDefinition, ToolExecution, ToolResult } from './harness/tools/types.ts'
export { ToolsService, type AuthorityRetirer, type RootResolver } from './harness/tools/service.ts'
export {
  CANONICAL_TOOLS,
  canonicalCall,
  canonicalPolicy,
  canonicalToolName,
  type CanonicalTool,
} from './harness/tools/names.ts'

// ── Harness: approval ────────────────────────────────────────────────────
export type { ApprovalHandle, ApprovalMode, ApprovalOptions, ApprovalReceipt, ApprovalReceiptRegistry, ApprovalScope, PolicySource } from './harness/approval/policy.ts'
export { approvalCallFingerprint, attachApproval, createApprovalReceiptRegistry } from './harness/approval/policy.ts'
export type { AskRequirement, AuthorityDecision } from './harness/tools/authority.ts'

// ── Capabilities: filesystem + shell ─────────────────────────────────────
export { fsTools, resolveGrantedPath, resolveWithin } from './capabilities/fs/tools.ts'
export { classifyTarget, OutOfGrantError, resolveInGrants, targetPaths, type PathClass, type TargetPath } from './capabilities/fs/grants.ts'
export { bashTool, type BashToolOptions } from './capabilities/shell/bash.ts'
export { bashOutputTool, killShellTool } from './capabilities/shell/background-tools.ts'
export { ProcessRegistry, type ProcessRecord, type ProcessSnapshot, type ProcessStatus, type ProcessTermination } from './harness/processes/registry.ts'

// ── MCP + hooks (G5) ───────────────────────────────────────────────────
export {
  McpConfigStore,
  McpConfigError,
  RESERVED_TOOL_NAMES,
  parseMcpConfig,
  parseHooksConfig,
  importClaudeMcp,
  importCodexMcp,
  resolveSecretRefs,
  mcpToolName,
  auditHash,
  type McpConfig,
  type McpServerConfig,
  type HooksConfig,
  type HookBinding,
} from './harness/mcp/config.ts'
export {
  MCP_ACCEPTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION_TABLE,
  DEPLOYMENT_BOUNDARY,
  MCP_METADATA_DESCRIPTION_MAX,
  MCP_METADATA_NAME_MAX,
  acceptProtocolVersion,
  receiptForTransportFailure,
  boundToolMetadata,
  annotationMayReduceApproval,
  type McpDiagnostic,
  type DispatchReceipt,
  type DispatchNotSentReason,
  type DispatchMaybeSentReason,
  type UntrustedToolMetadata,
} from './harness/mcp/boundaries.ts'
export {
  ROUTE_INVENTORY,
  privilegedRoutes,
  type RouteInventoryEntry,
  type RouteAuth,
  type RouteCredential,
  type RouteOwner,
} from './harness/mcp/route-inventory.ts'
export {
  McpServerClient,
  McpTransportError,
  MCP_PROTOCOL_VERSION,
  type McpToolDescriptor,
  type McpCallResult,
  type TransportState,
} from './harness/mcp/client.ts'
export { McpDispatchError } from './harness/mcp/boundaries.ts'
export { DataHomeLock, OwnershipError } from './harness/mcp/ownership-lock.ts'
export { MutationStore } from './harness/mcp/mutation-store.ts'
export { McpExecutionJournal } from './harness/mcp/execution-journal.ts'
export { dispatchToolCall, AuditFaultBlock, faultIsOpen, clearAuditFault } from './harness/mcp/execution-coordinator.ts'
export { applyMigration, dryRunMigration, assertBinaryCanOpen, THIS_BINARY, planMigration, recoverMigrations, MIGRATION_STEPS } from './harness/mcp/migration.ts'
export type { MigrationRecovery, MigrationStep, MigrationStepObserver } from './harness/mcp/migration.ts'
export { minimalStdioEnv, containmentCapability, assertHardContainmentAvailable } from './harness/mcp/process-controller.ts'
export { assertOutboundUrl, OutboundPolicyError } from './harness/mcp/outbound-policy.ts'
export { SseParser } from './harness/mcp/sse-parser.ts'
export { ManagedOAuth } from './harness/mcp/oauth.ts'
export { OAuthStore } from './harness/mcp/oauth-store.ts'
export { bearerAllows } from './web/control-plane-auth.ts'
export {
  runHook,
  isBlockingDecision,
  isFailureDecision,
  type HookDecision,
} from './harness/hooks/runner.ts'

// ── Web host ──────────────────────────────────────────────────────────────
export { ControlPlaneAuthService, isPublicPath, SESSION_COOKIE } from './web/control-plane-auth.ts'
export { checkCanonicalOrigin, csrfTokensMatch, CSRF_HEADER } from './web/csrf.ts'
export {
  createWebServer,
  extractModelIds,
  type PublicProvider,
  type WebEnvelope,
  type WebServer,
  type WebServerOptions,
} from './web/server.ts'
export {
  loadProviders,
  saveProviders,
  maskKey,
  slugify,
  type ProviderConfig,
} from './web/provider-store.ts'
