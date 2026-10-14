/**
 * Tool-name set algebra for a child's ceiling. MCP entries are exact
 * `mcp__server__tool` names or selectors (`mcp__server__*`, `mcp__*`); the
 * host expands selectors against live descriptors at spawn admission.
 * Nothing here grants authority: mode exposure and approval stay independent.
 */
import type { AgentDefinition, AgentSource } from './definition-service.ts'

const isMcp = (name: string): boolean => name.startsWith('mcp__')

export function isMcpSelector(name: string): boolean {
  return name === 'mcp__*' || (isMcp(name) && name.endsWith('__*') && name.length > 'mcp____*'.length)
}

/**
 * Server names may contain `__` but tool names never do (the host skips
 * them), so `mcp__s__*` matches `mcp__s__<tool>` only when the remainder
 * has no `__` — server `s` never captures server `s__x`'s tools.
 */
export function matchesMcpEntry(entry: string, tool: string): boolean {
  if (!isMcp(tool)) return false
  if (entry === 'mcp__*') return true
  if (isMcpSelector(entry)) {
    const prefix = entry.slice(0, -1)
    return tool.startsWith(prefix) && tool.length > prefix.length && !tool.slice(prefix.length).includes('__')
  }
  return entry === tool
}

/** The bundled explorer has zero MCP. An unknown source fails closed as bundled. */
export function isBundledExplorer(name: string, source: AgentSource | undefined): boolean {
  return name === 'explorer' && (source === undefined || source === 'bundled')
}

/**
 * Built-ins plus MCP entries a role can ever hold (selectors unexpanded).
 * An inheriting role (Claude: `tools` omitted or `*`) gets every MCP tool,
 * unless it names MCP entries in `tools` or `mcpServers` — then exactly
 * those. An explicit role keeps exactly what it lists.
 */
export function roleCandidates(definition: AgentDefinition, source: AgentSource | undefined): readonly string[] {
  const builtIns = definition.tools.filter((tool) => !isMcp(tool))
  if (isBundledExplorer(definition.name, source)) return builtIns
  if (definition.inheritsTools !== true) return [...definition.tools]
  const named = [
    ...definition.tools.filter(isMcp),
    ...(definition.mcpServers ?? []).map((server) => `mcp__${server}__*`),
  ]
  return [...builtIns, ...(named.length > 0 ? [...new Set(named)] : ['mcp__*'])]
}

/**
 * Grant and disallowed narrowing over an admitted (concrete) list. A grant
 * always narrows built-ins, and narrows MCP only when it names an MCP entry.
 */
export function narrowCeiling(admitted: readonly string[], grant: readonly string[] | undefined, disallowed: readonly string[]): string[] {
  const grantMcp = grant?.filter(isMcp) ?? []
  const kept = admitted.filter((tool) => {
    if (grant === undefined) return true
    if (!isMcp(tool)) return grant.includes(tool)
    return grantMcp.length === 0 || grantMcp.some((entry) => matchesMcpEntry(entry, tool))
  })
  return [...new Set(kept)].filter((tool) =>
    !disallowed.some((entry) => entry === tool || matchesMcpEntry(entry, tool)))
}

/**
 * MCP entries the grant asked for that the ceiling cannot honor: a concrete
 * name absent from it, or a selector matching none of its tools (a typo'd
 * selector would otherwise silently strip every MCP tool).
 */
export function missingGrantedMcp(grant: readonly string[] | undefined, ceiling: readonly string[]): string[] {
  return (grant ?? []).filter((entry) => isMcp(entry) && !ceiling.some((tool) => matchesMcpEntry(entry, tool)))
}
