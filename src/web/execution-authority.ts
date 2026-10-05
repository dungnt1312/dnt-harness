/**
 * Host exposure resolver: ONE predicate answers "may this scope see/call this
 * tool right now?" for request schema projection, spawn admission, the
 * `tools/pre-execute` gate, and the `tools/final-gate`.
 *
 * Exposure is a hard ceiling, never a permission grant: nothing here (and no
 * MCP annotation such as `readOnlyHint`) can turn an `ask` into an `allow`.
 *
 * Plan + MCP limitation: Plan exposes an MCP tool only when the workspace
 * allowlist names that exact tool AND the tool name has a read-safe prefix.
 * That is a conservative exposure filter, NOT a sandbox: a remote tool named
 * `get_…` may still have side effects. Disabling MCP in Plan altogether is a
 * separate, stronger product option and is deliberately not introduced here.
 */
import type { ModeDefinition } from '../harness/modes/types.ts'
import type { McpConfig } from '../harness/mcp/config.ts'
import { configRevision } from '../harness/mcp/config-v2.ts'

/** Plan-mode read-safe name prefix heuristic (not a side-effect guarantee). */
export const READ_SAFE_TOOL_NAME = /^(read|get|list|search|query|fetch|inspect|describe)/i

/** Bound on versioned-snapshot retries before failing closed. */
export const EXPOSURE_SNAPSHOT_ATTEMPTS = 3

/**
 * Explicit execution scope. `child` presence means the subject is a child
 * agent (or a child being admitted); `toolCeiling` is its pinned ceiling and
 * is absent only while the ceiling is still being computed at admission.
 */
export interface ExposureScope {
  readonly workspaceId?: string | undefined
  readonly sessionId?: string | undefined
  readonly rootSessionId?: string | undefined
  readonly childOf?: {
    readonly definition: string
    readonly toolCeiling?: readonly string[] | undefined
  } | undefined
}

export type ExposureMode = Pick<ModeDefinition, 'id' | 'name' | 'toolExposure'> & Pick<Partial<ModeDefinition>, 'permissionDefaults' | 'outOfGrant'>

/** A versioned view of everything the predicate depends on. */
export interface ExposureSnapshot {
  readonly blockedTools: readonly string[]
  readonly mode: ExposureMode
  readonly modeRevision: number
  /** Absent only when the caller knows no MCP tool is in question. */
  readonly mcp: McpConfig | undefined
}

export interface ExposureDeps {
  readonly blockedTools: readonly string[]
  /** Owning-root mode for the scope (sync, durable-log backed). */
  readonly modeOf: (scope: ExposureScope, workspaceId: string) => { readonly mode: ExposureMode; readonly revision: number }
  readonly loadMcp: (workspaceId: string) => Promise<McpConfig>
}

export interface ParsedMcpName {
  readonly server: string
  readonly tool: string
}

export function parseMcpName(name: string): ParsedMcpName {
  const parts = name.split('__')
  return { server: parts[1] ?? '', tool: parts.slice(2).join('__') }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Anchored glob (`*` = any characters) match of host blockedTools. */
export function hostBlockedPattern(blockedTools: readonly string[], name: string): string | undefined {
  return blockedTools.find((pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(name))
}

/**
 * General MCP exposure filter: an omitted or empty allowedTools list exposes
 * every discovered tool; a non-empty list is a filter. Entries may be the
 * server tool name or the public `mcp__server__tool` name. Not a permission.
 */
export function mcpToolExposed(allowed: readonly string[] | undefined, toolName: string, fullName: string): boolean {
  if (allowed === undefined || allowed.length === 0) return true
  return allowed.includes(toolName) || allowed.includes(fullName)
}

/** Plan: a concrete non-empty allowlist entry for exactly this tool. */
export function mcpToolExplicitlyAllowlisted(allowed: readonly string[] | undefined, toolName: string, fullName: string): boolean {
  if (allowed === undefined || allowed.length === 0) return false
  return allowed.includes(toolName) || allowed.includes(fullName)
}

/**
 * The shared predicate. Returns the first refusal reason, or `undefined` when
 * the tool is exposed to this scope. Order: host blockedTools, mode exposure
 * (MCP: zero-exposure, Explorer, enabled server, allowlist, Plan read-safe),
 * child cannot delegate, child definition/admission ceiling.
 */
export function exposureRefusal(snapshot: ExposureSnapshot, scope: ExposureScope | undefined, name: string): string | undefined {
  if (hostBlockedPattern(snapshot.blockedTools, name) !== undefined) return `host blockedTools denies '${name}'`
  const mode = snapshot.mode
  if (name.startsWith('mcp__')) {
    // Zero-exposure modes see no MCP tools (names are dynamic, so emptiness is
    // the only honest ceiling). Explorer sees none regardless of grant/mode.
    if (mode.toolExposure.length === 0) return `mode '${mode.name}' exposes no MCP tools`
    if (scope?.childOf?.definition === 'explorer') return 'Explorer exposes zero MCP tools'
    const { server: serverName, tool: toolName } = parseMcpName(name)
    const server = snapshot.mcp?.servers[serverName]
    if (server === undefined || !server.enabled) return `MCP server '${serverName}' is not enabled in this workspace`
    if (mode.id === 'plan') {
      if (!mcpToolExplicitlyAllowlisted(server.allowedTools, toolName, name) || !READ_SAFE_TOOL_NAME.test(toolName)) {
        return `mode 'Plan' does not expose MCP tool '${name}' without a read-safe allowlist entry`
      }
    } else if (!mcpToolExposed(server.allowedTools, toolName, name)) {
      return `MCP tool '${name}' is not exposed in this workspace`
    }
  } else if (!mode.toolExposure.includes(name)) {
    return `mode '${mode.name}' does not expose '${name}'`
  }
  const child = scope?.childOf
  if (child !== undefined && name === 'Agent') return 'one-level delegation: a child agent cannot delegate'
  if (child?.toolCeiling !== undefined && !child.toolCeiling.includes(name)) {
    return `agent '${child.definition}' does not expose '${name}' (definition ceiling)`
  }
  return undefined
}

export function isToolExposed(snapshot: ExposureSnapshot, scope: ExposureScope | undefined, name: string): boolean {
  return exposureRefusal(snapshot, scope, name) === undefined
}

/** Schema projection: keep only the schemas the predicate exposes. */
export function projectExposedSchemas<T extends { readonly name: string }>(
  snapshot: ExposureSnapshot,
  scope: ExposureScope | undefined,
  schemas: readonly T[],
): T[] {
  return schemas.filter((schema) => isToolExposed(snapshot, scope, schema.name))
}

/** Host-owned resolver bound to injected seams (hermetic in tests). */
export interface ExecutionAuthority {
  /**
   * Resolve a versioned snapshot and recheck mode/config revisions right
   * after the async reads. Retries are bounded; persistent churn fails closed.
   */
  readonly snapshot: (scope: ExposureScope, workspaceId: string, needsMcp: boolean) => Promise<ExposureSnapshot>
  /** Run an async authority read under a bounded owning-mode revision check. */
  readonly stableModeRead: <T>(scope: ExposureScope, workspaceId: string, read: (mode: ExposureMode, revision: number) => Promise<T>) => Promise<T>
  /**
   * Refusal for one call under CURRENT authority; used by pre-execute and final
   * gates. A scope without a workspace id is refused (host scope required),
   * after the host blockedTools check.
   */
  readonly refusal: (scope: ExposureScope | undefined, name: string) => Promise<string | undefined>
  /**
   * Spawn admission ceiling for a child of `definition`: candidates exposed
   * under the owning root's current authority. Called only at the executor's
   * admission linearization point; the result is an immutable pinned maximum.
   */
  readonly admissionCeiling: (input: {
    readonly workspaceId: string
    readonly rootSessionId: string
    readonly definition: string
    readonly candidates: readonly string[]
  }) => Promise<readonly string[]>
}

export function createExecutionAuthority(deps: ExposureDeps): ExecutionAuthority {
  const stableModeRead: ExecutionAuthority['stableModeRead'] = async (scope, workspaceId, read) => {
    for (let attempt = 0; attempt < EXPOSURE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const first = deps.modeOf(scope, workspaceId)
      const result = await read(first.mode, first.revision)
      const current = deps.modeOf(scope, workspaceId)
      if (first.revision === current.revision && first.mode.id === current.mode.id) return result
    }
    throw new Error('execution authority changed repeatedly; retry')
  }

  const snapshot: ExecutionAuthority['snapshot'] = async (scope, workspaceId, needsMcp) => {
    for (let attempt = 0; attempt < EXPOSURE_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const first = deps.modeOf(scope, workspaceId)
      const mcp = needsMcp ? await deps.loadMcp(workspaceId) : undefined
      const current = deps.modeOf(scope, workspaceId)
      const currentMcp = needsMcp ? await deps.loadMcp(workspaceId) : undefined
      const stable = first.revision === current.revision
        && first.mode.id === current.mode.id
        && (mcp === undefined || currentMcp === undefined || configRevision(mcp) === configRevision(currentMcp))
      if (!stable) continue
      return { blockedTools: deps.blockedTools, mode: first.mode, modeRevision: first.revision, mcp }
    }
    throw new Error('execution authority changed repeatedly; retry')
  }

  return {
    snapshot,
    stableModeRead,
    async refusal(scope, name) {
      // Host restrictions are the outermost hard deny, even without a workspace.
      if (hostBlockedPattern(deps.blockedTools, name) !== undefined) return `host blockedTools denies '${name}'`
      // Host scope is required: without a workspace there is no mode, MCP
      // config, or child ceiling to evaluate, and guessing an ambient default
      // would fail open. Same fail-closed rule as the Task 1 host scope.
      if (scope?.workspaceId === undefined) return `host execution scope required: no workspace identity to evaluate exposure of '${name}'`
      try {
        return exposureRefusal(await snapshot(scope, scope.workspaceId, name.startsWith('mcp__')), scope, name)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    async admissionCeiling({ workspaceId, rootSessionId, definition, candidates }) {
      const scope: ExposureScope = { workspaceId, sessionId: rootSessionId, rootSessionId, childOf: { definition } }
      const resolved = await snapshot(scope, workspaceId, candidates.some((name) => name.startsWith('mcp__')))
      return candidates.filter((name) => isToolExposed(resolved, scope, name))
    },
  }
}
