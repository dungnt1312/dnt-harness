/** Client-side mirror of the wire shapes the server sends. */
import type { AttachmentRef } from './composer-draft.ts'

export type { AttachmentRef }

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: Record<string, unknown>
}

/** One durable session event; fields are optional per `type`. */
export interface SseEvent {
  readonly type: string
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
  readonly toolCalls?: ToolCall[]
  /** Recorded controls on assistant answers (what served this step). */
  readonly controls?: { readonly model?: string; readonly provider?: string }
  /** Recovery-synthesized tool results: the real outcome is unknown. */
  readonly recovery?: true
  /**
   * MCP-only structured outcome. Absent on non-MCP results and legacy logs.
   * `indeterminate` means the remote effect may have happened and must not be
   * retried automatically. `audit_fault` means the known outcome could not be
   * durably recorded and further MCP dispatch is blocked.
   */
  readonly outcome?: 'success' | 'error' | 'indeterminate' | 'audit_fault'
  /** MCP invocation id. A manual repeat is a new invocation. */
  readonly invocationId?: string
  /** Durable input acceptance. */
  readonly inputId?: string
  readonly clientRequestId?: string
  /** Files the user attached to this input (references, never bytes). */
  readonly attachments?: readonly AttachmentRef[]
  /** Approval traffic. */
  readonly approvalId?: string
  readonly decision?: string
  readonly kind?: string
  readonly message?: string
  readonly title?: string | null
  /** Delegation traffic (spawn/child-meta/child-result). */
  readonly childSessionId?: string
  readonly parentSessionId?: string
  readonly parentTurnId?: string
  readonly definition?: string
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
}

/** One frame on the events stream. */
export type Envelope =
  | { readonly kind: 'snapshot'; readonly events: SseEvent[] }
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
  }
  | { readonly kind: 'approval-settled'; readonly approvalId: string }
  | { readonly kind: 'error'; readonly message: string }

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
  /** Pinned conversations lead the sidebar; recorded in the session's own log. */
  readonly pinned?: boolean
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
    readonly maxTurns?: number
  }
  readonly source: 'bundled' | 'workspace'
  readonly hash?: string
}

/** One child agent card: runtime status is separate from model claims. */
export interface ChildRow {
  readonly childSessionId: string
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  readonly definitionName: string
  /** The child's effective `provider:model`. */
  readonly model?: string
  readonly startedAt: number
  readonly endedAt?: number
  readonly result?: { readonly summary: string; readonly fileReferences: readonly string[] }
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
}

export interface HookBindingRow {
  readonly matcher: string
  readonly type: 'command'
  readonly command: string
  readonly args?: readonly string[]
  readonly timeoutMs?: number
  readonly onFailure: 'deny' | 'allow'
}

export type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'UserPromptSubmit'
  | 'SessionStart'
  | 'SessionEnd'
  | 'PreCompact'

export type HooksConfigRow = {
  readonly version: 1
  readonly hooks: Partial<Record<HookEvent, readonly HookBindingRow[]>>
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
  readonly source: 'workspace' | 'user' | 'bundled'
  /** sha256 of the raw SKILL.md — the optimistic-concurrency token. */
  readonly hash: string
}

/** One memory entry; `hash` is the expectedHash token for updates. */
export interface MemoryEntryRow {
  readonly id: string
  readonly title: string
  readonly pinned: boolean
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
  readonly max: number
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
