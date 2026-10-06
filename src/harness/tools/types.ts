import type { ExecutionId, SessionId } from '../../util/brand.ts'
import type { ToolCall, ToolSchema } from '../llm/types.ts'
import type { FileObservations } from '../../capabilities/fs/observation.ts'

/**
 * Structured MCP tool outcome. Non-MCP tools omit it.
 *
 * - `success` / `error`: the remote effect is known (a tool-level `isError` is
 *   still `error`, not a transport failure).
 * - `indeterminate`: the request may have executed remotely. No automatic
 *   retry; a later attempt is a new invocation with a fresh approval.
 * - `audit_fault`: the remote outcome is known but its terminal execution
 *   evidence could not be persisted. Further MCP dispatch stays blocked until
 *   that evidence is repaired. This is not a normal failure.
 */
export type ToolOutcome = 'success' | 'error' | 'indeterminate' | 'audit_fault'

/** What one tool run answers: success text, or a failure the model must see. */
export interface ToolResult {
  readonly ok: boolean
  readonly output: string
  /** Set only for MCP calls. Absent means a non-MCP tool result. */
  readonly outcome?: ToolOutcome
  /** Stable id of this invocation. A manual repeat after `indeterminate` gets a new one. */
  readonly invocationId?: string
}

/** What a file tool intends to do with a path. */
export type PathIntent = 'read' | 'write'

/** A folder granted to file tools beside the primary root. */
export interface GrantedRoot {
  /** Absolute folder path (realpath at grant time). */
  readonly path: string
  readonly access: PathIntent
}

/** One out-of-grant path an approval allowed for a single call. */
export interface ApprovedPath {
  /** Absolute lexical path exactly as shown to the approver. */
  readonly path: string
  readonly intent: PathIntent
}

/**
 * The execution context the pipeline grants to one tool run: the explicitly
 * granted workspace root, the run's cancellation signal, and the identities
 * attributing the run. Root-aware tools fail closed when the grant is
 * missing — they never derive authority from a UI-global folder.
 */
export interface ToolExecution {
  /** The granted workspace root (already resolved for this session). */
  readonly root: string
  /**
   * Further folders granted beside the primary root (other projects or
   * user-chosen folders), each read-only or read-write. Relative paths still
   * resolve against `root`; absolute paths may land in any granted folder.
   */
  readonly additionalRoots?: readonly GrantedRoot[]
  /** Host-owned memory namespaces; only Markdown files are reachable in them. */
  readonly memoryRoots?: readonly string[]
  /** The host application-storage deny (if any); only this designated ancestor may be carved out for memory roots. */
  readonly hostStorageRoot?: string
  /**
   * Exact paths outside every granted folder that an approval allowed for
   * THIS call only. Set by the pipeline after the approval decision, never by
   * a rewrite listener.
   */
  readonly approvedPaths?: readonly ApprovedPath[]
  /** Additional absolute paths tools must refuse (e.g. app-internal storage). */
  readonly deniedRoots?: readonly string[]
  /** Fires when the owning turn is stopping; cancellable tools honor it. An already-aborted signal never fires its listener — check `aborted` up front. */
  readonly signal?: AbortSignal
  /** Model-visible output cap for one tool result (from the harness limits). */
  readonly outputLimit?: number
  readonly turnId?: string
  readonly subagentBackgroundBashMaxMs?: number
  readonly sessionId?: SessionId
  /** Explicit host authority scope; absent for compatible standalone callers. */
  readonly rootSessionId?: SessionId
  readonly workspaceId?: string
  /** Host-owned transient file observations, scoped by session. */
  readonly observations?: FileObservations
  /**
   * Sessions whose file observations this run may consult read-only (a
   * child agent's parent). The content-hash check still applies.
   */
  readonly observationParents?: readonly SessionId[]
  /** Host-owned durable identity; the model call id is transcript metadata only. */
  readonly executionId?: ExecutionId
  readonly toolCallId?: string
}

/**
 * A model-facing tool: schema for request assembly, `execute` for the
 * pipeline. Arguments arrive as a JSON object validated at the model-JSON
 * boundary; tools validate their own fields and fail through `ToolResult`
 * rather than throwing.
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: ToolSchema['parameters']
  /**
   * Optional live schema resolver (G5 MCP): the same public MCP name can
   * exist independently in Work/Life with different schemas. Resolve from
   * trusted execution scope at request assembly; do not leak the workspace
   * that happened to register first.
   */
  readonly schema?: () => { readonly description: string; readonly parameters: ToolSchema['parameters'] } | undefined
  /** True when the tool cannot run without a granted workspace root. */
  readonly requiresRoot?: boolean
  execute(args: Record<string, unknown>, exec: ToolExecution): Promise<string>
}

/**
 * The `tools/pre-execute` waterfall decision: allow (optionally with the
 * call rewritten) or deny with a reason the model sees as the tool result.
 */
export type PreExecuteDecision =
  | { readonly kind: 'allow'; readonly call: ToolCall }
  | {
      readonly kind: 'deny'
      readonly reason: string
      /** The exact (possibly hook-rewritten) call the denial applies to. */
      readonly call?: ToolCall
    }

/**
 * A fully gated tool call. The agent durably records `call` before invoking
 * `execute`, so rewritten arguments and the approval binding are the same
 * intent that precedes the side effect.
 */
export interface PreparedToolCall {
  readonly call: ToolCall
  readonly executionId?: ExecutionId
  execute(): Promise<ToolResult>
}

declare module 'dnt-harness' {
  interface Events {
    /**
     * Input-rewrite phase BEFORE authorization (G5 hooks). Listeners may
     * rewrite the call or deny it. ToolsService then runs the COMPLETE
     * tools/pre-execute authorization chain against the rewritten call,
     * excluding this phase to prevent rewrite recursion.
     */
    'tools/rewrite'(
      payload: { readonly call: ToolCall; readonly exec: ToolExecution },
      next: (replacement?: { readonly call: ToolCall; readonly exec?: ToolExecution }) => Promise<PreExecuteDecision>,
    ): Promise<PreExecuteDecision>

    /**
     * Around-middleware before a tool runs: listeners may rewrite the call
     * by forwarding a replacement through `next()`, or deny it by returning
     * `{ kind: 'deny' }` without calling `next()`. Approval policies hook
     * here; `exec.signal` lets waiters honor a stop. The default allows the
     * call unchanged.
     */
    'tools/pre-execute'(
      payload: { readonly call: ToolCall; readonly exec: ToolExecution },
      next: (replacement?: { readonly call: ToolCall; readonly exec?: ToolExecution }) => Promise<PreExecuteDecision>,
    ): Promise<PreExecuteDecision>

    /**
     * Final authority check, immediately before the tool body runs and after
     * any approval wait. Non-interactive: it never asks, never rewrites, and
     * runs no hooks. A listener returns a denial reason when the executing
     * root's current mode, policy, or ceiling no longer admits this exact
     * call; the call then ends truthfully without its side effect.
     */
    'tools/final-gate'(payload: { readonly call: ToolCall; readonly exec: ToolExecution }): Promise<string | undefined>

    /**
     * Around-middleware after a tool ran (or was denied): listeners may
     * transform the result the model sees by forwarding a replacement
     * through `next()`. The default passes the result through.
     */
    'tools/post-execute'(
      payload: { readonly call: ToolCall; readonly exec: ToolExecution; readonly result: ToolResult },
      next: (replacement?: { readonly result: ToolResult }) => Promise<ToolResult>,
    ): Promise<ToolResult>
  }
}
