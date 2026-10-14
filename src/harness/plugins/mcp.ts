/**
 * A plugin's MCP servers → workspace `mcp.json` entries. Claude names them
 * `plugin:<plugin>:<server>` and their tools `mcp__plugin_<plugin>_<server>__<tool>`;
 * dnt-harness server names allow `[A-Za-z0-9_-]`, so the entry is
 * `plugin_<plugin>_<server>` and the tool names come out identical to Claude's.
 *
 * Enabling a plugin is the trust decision (as in Claude), so its servers are
 * written enabled with `provenance.plugin`; disabling or uninstalling removes
 * exactly those entries. `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` are
 * substituted here; other `${VAR}` references stay for the secrets store.
 */
import { substituteDeep } from './manifest.ts'

export function pluginServerName(plugin: string, server: string): string {
  // Sanitizing can leave `__` (from `a.` + `b`) or a trailing `_` (from `docs.`);
  // a server name may have neither, because `mcp__<server>__<tool>` is split on
  // `__`. Collapsing keeps every ordinary name exactly as Claude spells it.
  return `plugin_${plugin}_${server}`
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/_+$/, '')
}

export interface PluginServerDraft {
  readonly name: string
  /** The `mcp.json` server body (without `enabled`). */
  readonly body: Record<string, unknown>
}

/**
 * Convert one plugin's server map. Servers dnt-harness cannot run (`sse`,
 * `ws`, or no command/url) are returned as notes instead.
 */
export function pluginServers(
  plugin: { readonly id: string; readonly name: string; readonly root: string; readonly data: string },
  servers: Readonly<Record<string, unknown>>,
): { readonly drafts: readonly PluginServerDraft[]; readonly notes: readonly string[] } {
  const drafts: PluginServerDraft[] = []
  const notes: string[] = []
  for (const [server, raw] of Object.entries(servers)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) { notes.push(`MCP server '${server}' is not an object`); continue }
    const source = substituteDeep(raw, { root: plugin.root, data: plugin.data }) as Record<string, unknown>
    const type = typeof source['type'] === 'string' ? source['type'] : undefined
    const body: Record<string, unknown> = { provenance: { plugin: plugin.id } }
    if (typeof source['command'] === 'string' && (type === undefined || type === 'stdio')) {
      body['transport'] = 'stdio'
      body['command'] = source['command']
      if (Array.isArray(source['args'])) body['args'] = source['args'].map(String)
      if (isStringRecord(source['env'])) body['env'] = source['env']
    } else if (typeof source['url'] === 'string' && (type === undefined || type === 'http' || type === 'streamable-http')) {
      body['transport'] = 'http'
      body['url'] = source['url']
      if (isStringRecord(source['headers'])) body['headers'] = source['headers']
    } else {
      notes.push(`MCP server '${server}': transport ${type ?? 'unknown'} is not supported by dnt-harness`)
      continue
    }
    drafts.push({ name: pluginServerName(plugin.name, server), body })
  }
  return { drafts, notes }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string')
}
