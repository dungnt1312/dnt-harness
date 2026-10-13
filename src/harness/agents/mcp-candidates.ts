/**
 * Tool-name set algebra for a child's ceiling. MCP entries are exact
 * `mcp__server__tool` names or selectors (`mcp__server__*`, `mcp__*`); the
 * host expands selectors against live descriptors at spawn admission.
 * Nothing here grants authority: mode exposure and approval stay independent.
 */
import type { AgentDefinition, AgentSource } from './definition-service.ts'

const isMcp = (name: string): boolean => name.startsWith('mcp__')

export function isMcpSelector(name: string): boolean {
  return name === 'mcp__*' || (isMcp(name) && name.endsWith('__*') && name.split('__').length === 3)
}

export function matchesMcpEntry(entry: string, tool: string): boolean {
  if (!isMcp(tool)) return false
  if (entry === 'mcp__*') return true
  if (isMcpSelector(entry)) return tool.startsWith(entry.slice(0, -1))
  return entry === tool
}

/** The bundled explorer has zero MCP. An unknown source fails closed as bundled. */
export function isBundledExplorer(name: string, source: AgentSource | undefined): boolean {
  return name === 'explorer' && (source === undefined || source === 'bundled')
}

/**
 * Built-ins plus MCP entries a role can ever hold (selectors unexpanded).
 * An inheriting role (Claude: `tools` omitted) gets every MCP tool, or only
 * its `mcpServers`' tools; an explicit role keeps exactly what it lists.
 */
export function roleCandidates(definition: AgentDefinition, source: AgentSource | undefined): readonly string[] {
  const builtIns = definition.tools.filter((tool) => !isMcp(tool))
  if (isBundledExplorer(definition.name, source)) return builtIns
  if (definition.inheritsTools !== true) return [...definition.tools]
  const servers = definition.mcpServers
  const mcp = servers !== undefined && servers.length > 0 ? servers.map((server) => `mcp__${server}__*`) : ['mcp__*']
  return [...builtIns, ...mcp]
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

/** Concrete `mcp__server__tool` names the grant asked for that the ceiling lacks. */
export function missingGrantedMcp(grant: readonly string[] | undefined, ceiling: readonly string[]): string[] {
  return (grant ?? []).filter((tool) => isMcp(tool) && !isMcpSelector(tool) && !ceiling.includes(tool))
}
