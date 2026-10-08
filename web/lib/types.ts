/** Client-side mirror of the wire shapes the server sends. */
import type { AttachmentRef } from './composer-draft.ts'

export type { AttachmentRef }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

export type McpOutcome = 'success' | 'error' | 'indeterminate' | 'audit_fault'
export type InputOutcome = 'admitted' | 'rejected' | 'empty' | 'withdrawn'

const MCP_OUTCOMES: ReadonlySet<string> = new Set<McpOutcome>(['success', 'error', 'indeterminate', 'audit_fault'])
/** Narrows the shared `outcome` key to a tool-result outcome. */
export const isMcpOutcome = (value: string | undefined): value is McpOutcome => value !== undefined && MCP_OUTCOMES.has(value)

/** One durable session event; fields are optional per `type`. */
export interface SseEvent {
  readonly type: string
  /** Canonical physical-attempt diagnostics; absent on legacy events. */
  readonly fact?: import('../../src/harness/llm/request-lifecycle.ts').AttemptFact
  readonly seq: number
  readonly timestamp?: number
  readonly content?: string
  readonly delta?: string
  /** A chunk the model thought before answering; never part of history. */
  readonly thinking?: boolean
  readonly call?: ToolCall
  readonly callId?: string
  readonly ok?: boolean
  readonly output?: string
  readonly reason?: string
  /** Turn membership (turn/start, user/message, assistant traffic, turn/end). */
  readonly turnId?: string
  /** Step membership (step/start, step/end). */
  readonly stepId?: string
  readonly toolCalls?: ToolCall[]
  /** Recorded controls on assistant answers (what served this step). */
  readonly controls?: { readonly model?: string; readonly provider?: string }
  /** Recovery-synthesized tool results: the real outcome is unknown. */
  readonly recovery?: true
  /**
   * `tool/result`: MCP-only structured outcome. Absent on non-MCP results and
   * legacy logs. `indeterminate` means the remote effect may have happened and
   * must not be retried automatically. `audit_fault` means the known outcome
   * could not be durably recorded and further MCP dispatch is blocked.
   * `input/settled`: whether the accepted input reached the model —
   * `admitted`, or `rejected`/`empty` (never logged as a user/message), or
   * `withdrawn` (the user deleted it from the queue).
   */
  readonly outcome?: McpOutcome | InputOutcome
  /** MCP invocation id. A manual repeat is a new invocation. */
  readonly invocationId?: string
  /** Durable input acceptance. */
  readonly inputId?: string
  readonly clientRequestId?: string
  /** `input/queued`: set when the input was sent with Steer. */
  readonly delivery?: 'steer'
  /** `input/queued`: the host found the session idle and starts a turn for it now. */
  readonly runsNow?: true
  /** Files the user attached to this input (references, never bytes). */
  readonly attachments?: readonly AttachmentRef[]
  /**
   * `user/message` not typed by the user: `continuation` is the joined
   * delegated-agent reports the turn continues with (`formatChildReports`).
   */
  readonly origin?: string
  /** Approval traffic. */
  readonly approvalId?: string
  readonly decision?: string
  /** Out-of-grant approval facts recorded on `approval/request`. */
  readonly scopeWarning?: string
  readonly proposedGrant?: string
  readonly proposedAccess?: 'read' | 'write'
  /** `session/grants`: the session's folder grants (full list) and revision. */
  readonly revision?: number
  readonly roots?: readonly FolderGrant[]
  readonly kind?: string
  readonly message?: string
  readonly title?: string | null
  /** Delegation traffic (spawn/child-meta/child-result). */
  readonly childSessionId?: string
  readonly parentSessionId?: string
  readonly parentTurnId?: string
  readonly definition?: string
  /** The child's brief; `objective` is the legacy name older logs carry. */
  readonly brief?: string
  readonly objective?: string
  readonly status?: string
  /** Hook audit trail. */
  readonly event?: string
  readonly matcher?: string
  readonly exitCode?: number | null
  readonly durationMs?: number
  /** MCP call audit trail. */
  readonly server?: string
  readonly tool?: string
  readonly argsHash?: string
  readonly resultHash?: string
  readonly isError?: boolean
  /** `context/manifest`: the assembled request's manifest, one per turn. */
  readonly manifest?: ContextManifestView
  /** `context/body`: one raw context block keyed by its content sha256. */
  readonly hash?: string
  readonly chars?: number
  readonly body?: string
  /** Compaction lifecycle (compaction/start, compaction/end). */
  readonly trigger?: 'manual' | 'automatic'
  readonly model?: string
  readonly coversSeq?: number
  readonly summaryChars?: number
  /** The stored summary itself; present on a successful compaction/end. */
  readonly summary?: string
  /** Set on a failed compaction/end. */
  readonly error?: string
  /** Background-process lifecycle (process/start, process/exit). */
  readonly processId?: string
  readonly command?: string
  readonly cwd?: string
  readonly termination?: string
}

/** Estimated tokens per request source; the fields sum to `usedTokens`. */
export interface ContextBreakdownView {
  readonly systemPrompt: number
  readonly systemTools: number
  readonly mcpTools: number
  readonly metaContext: number
  readonly skills: number
  readonly messages: number
}

export interface ContextUsageView {
  /**
   * Prompt count of the request this manifest describes. Absent when that
   * request has not reported usage yet; cache totals below may still be present.
   */
  readonly last?: { readonly inputTokens: number; readonly cachedInputTokens?: number; readonly outputTokens?: number }
  readonly cacheableInputTokens: number
  readonly cachedInputTokens: number
}

/** What one assembled model request carried; the server's ContextManifest. */
export interface ContextManifestView {
  readonly modeId: string
  readonly modeRevision: number
  readonly model?: string
  readonly provider?: string
  readonly budget: { readonly availableTokens: number; readonly usedTokens: number; readonly contextLimitTokens?: number; readonly estimated: boolean }
  /** Estimated tokens per source of the last request; sums to `usedTokens`. */
  readonly breakdown?: ContextBreakdownView
  /** Provider-reported usage, when the provider streams it. */
  readonly usage?: ContextUsageView
  readonly history: {
    readonly setting: string
    readonly includedTurns: number
    readonly omittedTurns: number
    readonly includedSeqRange?: readonly [number, number]
    readonly omittedSeqRange?: readonly [number, number]
    readonly checkpointHash?: string
  }
  readonly sources: {
    readonly instructionsHash?: string
    /** Where the active mode definition came from — bundled or workspace-authored. */
    readonly modeSource?: 'bundled' | 'workspace'
    /** Environment facts carried in the system block (when the host supplied them). */
    readonly environment?: { readonly date?: string; readonly platform?: string; readonly workspacePath?: string; readonly gitBranch?: string }
    readonly skills: readonly string[]
    /** Discovery rows the request carried; absent when dropped or skills off. */
    readonly skillCatalog?: { readonly names: readonly string[]; readonly hash: string }
    readonly memory: readonly string[]
    readonly toolNames: readonly string[]
    readonly toolSchemas: number
    /** Present when the request ran as a child role. */
    readonly child?: { readonly definition: string; readonly instructionsHash: string; readonly source?: 'bundled' | 'user' | 'workspace' | 'project' }
    /** Inherited parent context the request carried (absent when dropped). */
    readonly parentContext?: { readonly hash: string; readonly chars: number }
  }
  readonly omissions: readonly string[]
  /** Fetchable raw blocks of this request; hash keys the body store. */
  readonly sections?: readonly {
    readonly kind: 'system' | 'workspace-instructions' | 'compaction' | 'parent-context' | 'skill' | 'skill-catalog' | 'memory'
    readonly name?: string
    readonly hash: string
    readonly chars: number
  }[]
}

/** One frame on the events stream. */
export type Envelope =
  | { readonly kind: 'snapshot'; readonly events: SseEvent[] }
  | { readonly kind: 'resume'; readonly events: SseEvent[] }
  | { readonly kind: 'session'; readonly event: SseEvent }
  | {
    readonly kind: 'approval'
    readonly approvalId: string
    readonly call: ToolCall
    readonly interactive?: boolean
    readonly childSessionId?: string
    readonly definitionName?: string
    /** Absent on questions rebuilt from a log snapshot: no deadline is known. */
    readonly expiresAt?: number
    readonly guardWarning?: string
    readonly scopeWarning?: string
    readonly proposedGrant?: string
    readonly proposedAccess?: 'read' | 'write'
  }
  | { readonly kind: 'approval-settled'; readonly approvalId: string }
  | {
    readonly kind: 'question'
    readonly questionId: string
    readonly callId: string
    readonly questions: readonly UserQuestion[]
    readonly expiresAt: number
    readonly childSessionId?: string
    readonly definitionName?: string
  }
  | { readonly kind: 'question-settled'; readonly questionId: string }
  | { readonly kind: 'error'; readonly message: string }

/** One AskUserQuestion option, exactly as the model offered it. */
export interface UserQuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question of an AskUserQuestion call. */
export interface UserQuestion {
  readonly question: string
  readonly header?: string
  readonly options: readonly UserQuestionOption[]
  readonly multiSelect: boolean
}

/** The human's answer to one question, aligned by index. */
export interface UserQuestionAnswer {
  readonly selected: readonly string[]
  readonly other?: string
}

/** The human's reply to an AskUserQuestion: answers aligned with its questions, or a decline. */
export type QuestionReply = { readonly answers: readonly UserQuestionAnswer[] } | { readonly decline: true }

/** A live AskUserQuestion waiting on the human. */
export interface PendingQuestion {
  readonly questionId: string
  readonly callId: string
  readonly questions: readonly UserQuestion[]
  readonly expiresAt: number
  readonly childSessionId?: string
  readonly definitionName?: string
}

/** Sidebar ordering for the conversation list. */
export type SessionSort = 'recent' | 'oldest' | 'title'

/** One session row; `folder: null` inherits server's default workspace root. */
export interface SessionListing {
  readonly createdAt?: number
  readonly updatedAt?: number
  readonly id: string
  readonly title: string
  readonly eventCount: number
  readonly folder: string | null
  /** G2: the project this session is bound to (fixed at creation). */
  readonly projectId?: string | null
  /** Live driver state: idle, running, or cancelling a stop. */
  readonly status?: 'idle' | 'running' | 'cancelling'
  /** What the driver is busy with right now (model, tool, or approval). */
  readonly activity?: 'model' | 'tool' | null
  /** Durably queued inputs waiting for a later turn. */
  readonly pendingInputs?: number
  /** Background Bash processes still running under this conversation. */
  readonly runningProcesses?: number
  /** Pinned conversations lead the sidebar; recorded in the session's own log. */
  readonly pinned?: boolean
  /** Set when this row is a subagent: the sidebar nests it under this parent instead of listing it. */
  readonly parentSessionId?: string | null
}

/** Per-model operator overrides stored on one provider entry. */
export interface ModelSettings {
  /** Context-window override in tokens; absent = catalog default. */
  readonly contextTokens?: number
  /** Vision capability override; absent = catalog value. */
  readonly vision?: boolean
  /** Default thinking level for this model; absent = catalog default. */
  readonly thinkingLevel?: string
}

/** Safe provider projection — raw API keys never reach this type. */
export interface ProviderSummary {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly enabled: boolean
  readonly keyMasked: string
  readonly models: readonly string[]
  /** Per-model operator overrides (context window, vision, thinking default). */
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
}

/** Input to create/update one OpenAI-completions compatible provider. */
export interface ProviderInput {
  readonly name?: string
  readonly baseUrl?: string
  /** Omit on PATCH to retain stored key; required when creating. */
  readonly apiKey?: string
  readonly enabled?: boolean
  readonly models?: readonly string[]
  /** Replaces the whole per-model settings map when present. */
  readonly modelSettings?: Readonly<Record<string, ModelSettings>>
}

/** Server state: active pair, default workspace, safely masked provider list. */
export interface Meta {
  readonly provider: string
  readonly model: string
  readonly folder: string
  /** The selected mode's own permission defaults. */
  readonly permissionDefaults?: Record<string, string>
  /** `--yolo`: asks are answered automatically; a deny still blocks. */
  readonly yolo?: boolean
  /** Model names offered by the active provider, for compatibility. */
  readonly models: readonly string[]
  readonly providers: readonly ProviderSummary[]
}

export interface PendingApproval {
  readonly approvalId: string
  readonly call: ToolCall
  /** Interactive MCP: every call asks for a decision, every time. */
  readonly interactive?: boolean
  /** Set when the question belongs to a child of the open conversation. */
  readonly childSessionId?: string
  /** The child's agent definition name, shown instead of a bare id. */
  readonly definitionName?: string
  /** Epoch ms when the question expires undecided; absent for log-derived rows. */
  readonly expiresAt?: number
  /** Dangerous Commands guard warning for ask-blocked Bash commands. */
  readonly guardWarning?: string
  /** Set when a file tool targets a path outside every granted folder. */
  readonly scopeWarning?: string
  /** The folder "allow for this session" grants; absent when not offered. */
  readonly proposedGrant?: string
  /** The access that folder gets: the call's own read or write. */
  readonly proposedAccess?: 'read' | 'write'
}

/** One extra folder file tools may use, read-only or read-write. */
export interface FolderGrant {
  readonly path: string
  readonly access: 'read' | 'write'
}

/** One extra folder a project grants its conversations. */
export type AdditionalDirectory =
  | { readonly kind: 'project'; readonly projectId: string; readonly access: 'read' | 'write' }
  | { readonly kind: 'path'; readonly path: string; readonly access: 'read' | 'write' }

/** A conversation's own folder grants plus the effective merged view. */
export interface SessionGrantsView {
  readonly revision: number
  readonly roots: readonly FolderGrant[]
  /** Project grants and session grants merged — what file tools can use. */
  readonly effective: readonly FolderGrant[]
}

/** One permission policy decision, mirroring the server's ApprovalMode. */
export type PolicyMode = 'allow' | 'ask' | 'deny'

/** One mode in the authoring catalog, carrying what it grants. */
export interface ModeCatalogRow {
  readonly id: string
  readonly name: string
  readonly source: 'bundled' | 'workspace'
  /** False when the workspace has hidden this mode from the composer picker. */
  readonly enabled?: boolean
  readonly toolExposure: readonly string[]
  readonly permissionDefaults: Record<string, PolicyMode>
}

/** One mode's raw file, for the editor. Bundled modes carry no hash. */
export interface ModeFileRow {
  readonly id: string
  readonly raw: string
  readonly source: 'bundled' | 'workspace'
  readonly hash?: string
}


/** One workspace row (G2). `running`/`approvals` are live badges. */
export interface WorkspaceRow {
  readonly id: string
  readonly name: string
  readonly archived: boolean
  readonly createdAt: number
  readonly default?: boolean
  readonly running?: number
  readonly approvals?: number
}

/** One project bound to a workspace (G2): metadata for an external folder. */
export interface ProjectRow {
  readonly id: string
  readonly name: string
  readonly workspaceId: string
  readonly path: string
  /** Sidebar position; absent until the first drag-to-reorder. */
  readonly order?: number
  /** Extra folders this project's conversations may use. */
  readonly additionalDirectories?: readonly AdditionalDirectory[]
  readonly createdAt: number
}

/** Global defaults applied to drafts and snapshotted when a conversation starts. */
export interface ModelDefaults {
  readonly provider: string | null
  readonly model: string | null
  readonly thinkingLevel: string | null
}

/** Effective controls for one conversation. `source: 'global'` is a legacy log that follows live global defaults; session nulls are explicit blanks. */
export interface SessionModel extends ModelDefaults {
  readonly source: 'session' | 'global'
}

/** Per-workspace metadata. Provider/default fields remain for compatibility but are global. */
export interface WorkspaceMeta {
  readonly workspace: { readonly id: string; readonly name: string; readonly archived: boolean }
  /** Compatibility projection of global defaults. */
  readonly provider: string | null
  readonly model: string | null
  readonly thinkingLevel?: string | null
  readonly models: readonly string[]
  /** The selected mode's own permission defaults. */
  readonly permissionDefaults?: Record<string, string>
  readonly yolo?: boolean
  readonly projects: readonly ProjectRow[]
  readonly providers: readonly ProviderSummary[]
}

// ── G4: agent definitions + children ───────────────────────────────────────

/** One agent role definition (bundled read-only or workspace-owned). */
export interface AgentDefinitionRow {
  readonly definition: {
    readonly name: string
    readonly description: string
    readonly instructions: string
    readonly tools: readonly string[]
    readonly disallowedTools: readonly string[]
    readonly skills?: readonly string[]
    readonly model?: string
    /** Claude fields recognized but not enforced by dnt-harness. */
    readonly unsupported?: readonly string[]
    /** Tools the file named that dnt-harness does not provide. */
    readonly droppedTools?: readonly string[]
    /** `tools` omitted in the file: the role inherits every tool. */
    readonly inheritsTools?: boolean
    readonly warnings?: readonly string[]
  }
  /** What `model:` runs on here: a resolved `provider:model`, or inherit (with what could not be served). */
  readonly modelResolution?: { readonly resolved?: string; readonly inherit: boolean; readonly unresolved?: string }
  /** Claude Code layer: bundled < user (~/.claude/agents) < workspace < project (.claude/agents). */
  readonly source: 'bundled' | 'user' | 'workspace' | 'project'
  readonly path?: string
  readonly hash?: string
  /** Lower layers this definition overrides. */
  readonly overrides?: readonly ('bundled' | 'user' | 'workspace' | 'project')[]
}

/** One child agent card: runtime status is separate from model claims. */
export interface ChildRow {
  readonly childSessionId: string
  /** `uncertain` is retained while the host reconciles its canonical lifecycle log. */
  readonly status: 'queued' | 'dispatching' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'uncertain'
  readonly definitionName: string
  /** The child's effective `provider:model`. */
  readonly model?: string
  readonly startedAt: number
  readonly endedAt?: number
  /** A completed child's final message — its whole deliverable. */
  readonly result?: {
    readonly report: string
    /** Files it read or wrote (Read/Write/Edit); found paths live in `report`. */
    readonly filesTouched: readonly string[]
    /** The report was cut at the host's cap; the marker is in the text. */
    readonly truncated?: boolean
  }
  /**
   * What a child that did not complete got done (its last message and the files
   * it touched). Evidence, never a verdict; shown only when there is no result.
   */
  readonly partial?: {
    readonly report: string
    readonly filesTouched: readonly string[]
    readonly truncated?: boolean
  }
  /** Why there is no result; names the child's full-log session. */
  readonly error?: string
  /** Parked on an approval the user has not answered. */
  readonly awaitingApproval?: boolean
}

// ── G5: MCP servers, hooks, secrets ────────────────────────────────────────

export interface McpServerRow {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly enabled: boolean
  readonly status: 'connecting' | 'ready' | 'failed' | 'disabled'
  readonly breakerOpenUntil: number | null
  /** Host containment wording. This is not a sandbox claim. */
  readonly containment?: string
  readonly generation?: number
  readonly auditFault?: boolean
  /** Tool names the server listed. Descriptions stay off this row. */
  readonly discoveredTools?: readonly string[]
  /** Empty or omitted means every discovered tool is exposed. */
  readonly allowedTools?: readonly string[]
  readonly revision?: string
  readonly stale?: boolean
  readonly unmatchedAllowlist?: readonly string[]
  /** Why the last connect failed; the server's tools are skipped until it connects. */
  readonly lastError?: string
  /** Discovered tools whose public name LLM providers reject; never sent to the model. */
  readonly unusableTools?: readonly string[]
  /** Recent server stderr, secrets masked. */
  readonly stderrTail?: string
}

/** One Claude Code hook command (`settings.json` → hooks → Event → group → hooks[]). */
export interface HookCommandRow {
  readonly type: 'command'
  readonly command: string
  /** Seconds (Claude); omitted = 60. */
  readonly timeout?: number
}

/** One Claude Code matcher group. */
export interface HookMatcherGroupRow {
  /** Regex over the tool name / source / trigger; omitted or `*` matches all. */
  readonly matcher?: string
  readonly hooks: readonly HookCommandRow[]
}

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'Notification'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PostToolUseFailure'
  /** Claude event dnt-harness keeps in the file but does not fire yet. */
  | 'PermissionRequest'

/** The `hooks` section of a Claude Code settings file. */
export type HooksSectionRow = Partial<Record<HookEvent, readonly HookMatcherGroupRow[]>>

export interface EffectiveHookRow {
  readonly id: string
  readonly event: HookEvent
  readonly matcher: string
  readonly command: string
  readonly timeout?: number
  readonly layer: 'user' | 'workspace' | 'project' | 'local'
  readonly source: string
  /** False when switched off for this workspace. */
  readonly active: boolean
  /** False for Claude events dnt-harness does not fire yet. */
  readonly supported: boolean
}

/** GET /hooks: the workspace layer plus every layer that applies. */
export interface HooksConfigRow {
  /** `<ws>/settings.json` — the layer this editor writes. */
  readonly file: string
  readonly hooks: HooksSectionRow
  readonly disableAllHooks: boolean
  readonly sources: readonly { readonly layer: 'user' | 'workspace' | 'project' | 'local'; readonly path: string; readonly exists: boolean }[]
  /** Every configured hook from every layer (active or not). */
  readonly effective: readonly EffectiveHookRow[]
  readonly disabled: boolean
  readonly diagnostics: readonly string[]
}

export interface SecretRow {
  readonly name: string
}

// ── G3: skills + memory management ────────────────────────────────────────

/** One skill catalog row (only workspace rows are editable). */
export interface SkillRow {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly source: 'project' | 'workspace' | 'user' | 'bundled'
  /** The source rule a project row resolved from (panel grouping). */
  readonly ruleId?: string
  /** sha256 of the raw SKILL.md — the optimistic-concurrency token. */
  readonly hash: string
  /** Present when this workspace hides the skill from discovery surfaces. */
  readonly hidden?: boolean
}

/** One configurable skill source folder; list order is precedence order. */
export interface SkillRuleRow {
  readonly id: string
  readonly kind: 'project' | 'workspace' | 'absolute'
  readonly path?: string
  readonly enabled: boolean
}

/** One file inside a skill folder (SKILL.md plus resource files). */
export interface SkillFileRow {
  /** `/`-separated path relative to the skill folder. */
  readonly path: string
  readonly bytes: number
}

/** One memory entry; `hash` is the expectedHash token for updates. */
export interface MemoryEntryRow {
  readonly id: string
  readonly title: string
  readonly pinned: boolean
  /** Frontmatter `metadata.type`; absent when the file does not declare one. */
  readonly type?: 'user' | 'feedback' | 'project' | 'reference'
  readonly createdAt: number
  readonly updatedAt: number
  readonly body: string
  readonly hash: string
}

/** One live terminal, as the host describes it. */
export interface TerminalRow {
  readonly id: string
  readonly workspaceId: string
  /** Set when the shell was opened for a project; absent for the host default folder. */
  readonly projectId?: string
  readonly shellId: string
  readonly label: string
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly createdAt: number
}

/** A shell this host can actually launch; the picker never hardcodes a list. */
export interface ShellRow {
  readonly id: string
  readonly label: string
}

export interface TerminalListing {
  readonly terminals: readonly TerminalRow[]
  readonly shells: readonly ShellRow[]
  readonly available: boolean
  /** Why no PTY backend resolved, when `available` is false. */
  readonly unavailable?: string
}

/** Client mirror of the host's TerminalEnvelope; `data`/`scrollback` are base64. */
export type TerminalFrame =
  | { readonly kind: 'snapshot'; readonly terminals: readonly (TerminalRow & { readonly scrollback: string })[] }
  | { readonly kind: 'created'; readonly terminal: TerminalRow }
  | { readonly kind: 'data'; readonly terminalId: string; readonly data: string }
  | { readonly kind: 'exit'; readonly terminalId: string; readonly exitCode: number; readonly reason: 'exit' | 'killed' | 'idle' }

/** One host-local day's tokens for one model (`GET /api/usage`). */
export interface UsageDayRow {
  readonly date: string
  readonly model: string
  /** Prompt tokens, cached ones included. */
  readonly input: number
  readonly cached: number
  readonly output: number
  readonly requests: number
}

export interface UsageDailyResponse {
  readonly days: readonly UsageDayRow[]
  readonly longestSessionMs: number
  readonly firstRecordAt?: number
  /** Host-local `YYYY-MM-DD` of now. */
  readonly today: string
}
