import type { ApprovalMode } from '../approval/policy.ts'

/**
 * A mode carries instructions, context sources, tool exposure, permission
 * defaults, and the out-of-grant rule for file tools. Defaults and hard
 * restrictions are distinct: permission defaults are defaults the
 * workspace/host policy still constrains; tool exposure is a hard ceiling no
 * override can widen.
 */
export interface ModeDefinition {
  /** Stable id; bundled ids are fixed, custom ids are file-derived. */
  readonly id: string
  /** Display name. */
  readonly name: string
  /** Optional one-line description (authoring metadata; never authority). */
  readonly description?: string
  /** System-level instructions injected for every request in this mode. */
  readonly instructions: string
  /** What the context builder may load for this mode. */
  readonly sources: ModeSources
  /** The hard ceiling of exposed tools (canonical names). */
  readonly toolExposure: readonly string[]
  /**
   * Permission per tool, keyed the way the approval gate resolves a call: a
   * known tool name, an exact `mcp__<server>__<tool>`, an `mcp__<server>__*`
   * wildcard, or the catch-all `*`.
   */
  readonly permissionDefaults: Readonly<Record<string, ApprovalMode>>
  /**
   * What a file-tool call targeting a path outside every granted folder
   * needs: `ask` (default) forces an approval even when the tool itself is
   * allowed; `allow` lets it run under the tool's own permission. Unsafe
   * paths (network/device paths, app storage, link escapes) are refused
   * either way.
   */
  readonly outOfGrant?: 'allow' | 'ask'
  /**
   * Which MCP tools this mode may expose (a ceiling, never a permission):
   * `none`; `read-safe` — only tools named by an explicit server allowlist
   * entry AND carrying a read-safe name prefix; `all` — every enabled,
   * allowlist-filtered tool. Absent derives from the mode: a zero tool
   * ceiling is always `none`; a mode exposing none of Write/Edit/Bash is
   * `read-safe`; otherwise `all`. A zero ceiling wins over any explicit value.
   */
  readonly mcpExposure?: McpExposure
}

export type McpExposure = 'none' | 'read-safe' | 'all'

/** Context sources a mode enables. Disabled loaders contribute nothing. */
export interface ModeSources {
  /** `none` drops previous Turns from the prompt; the current Turn's tool loop still works. */
  readonly history: 'none' | 'recent' | 'compact'
  /** Workspace/project instruction files. */
  readonly workspaceInstructions: boolean
  /** Skill loading: off, or on-demand via the Skill tool. */
  readonly skills: 'off' | 'on-demand'
  /** Pinned memory entries load automatically; retrieval is a tool call. */
  readonly memoryPinned: boolean
  readonly memoryRetrieval: boolean
}

/** Raw frontmatter shape of a custom mode file (Markdown + YAML frontmatter). */
export interface ModeFrontmatter {
  readonly name?: string
  readonly description?: string
  readonly history?: 'none' | 'recent' | 'compact'
  readonly workspaceInstructions?: boolean
  readonly skills?: 'off' | 'on-demand'
  readonly memoryPinned?: boolean
  readonly memoryRetrieval?: boolean
  readonly toolExposure?: readonly string[]
  /** Keys: a canonical known tool, `mcp__<server>__<tool>`, `mcp__<server>__*`, or `*`. */
  readonly permissionDefaults?: Readonly<Record<string, string>>
  readonly outOfGrant?: string
  readonly mcpExposure?: string
}

/** A validated, ready-to-use mode with its provenance. */
export interface ResolvedMode {
  readonly definition: ModeDefinition
  /** 'bundled' modes are read-only; customization duplicates them. */
  readonly source: 'bundled' | 'workspace'
  /** sha256 of the raw file for workspace modes (undefined for bundled). */
  readonly hash?: string
}

export class ModeError extends Error {
  constructor(
    readonly code: 'not-found' | 'invalid' | 'duplicate' | 'conflict',
    message: string,
  ) {
    super(message)
    this.name = 'ModeError'
  }
}
