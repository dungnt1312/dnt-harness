/**
 * Version 2 is the migrated document: every server has an explicit `enabled`
 * boolean, and the envelope carries a revision plus a content hash. Version 1
 * stays readable through the existing parser. Omitted `enabled` is not
 * reinterpreted until migration quarantines it.
 */
import { createHash } from 'node:crypto'
import { McpConfigError, parseMcpConfig, type McpConfig, type McpServerConfig } from './config.ts'

export interface V2Server extends McpServerConfig {
  readonly enabled: boolean
  readonly activation?: 'explicit'
  readonly legacyAuth?: 'external_token'
}

export function parseV2McpConfig(raw: string): McpConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new McpConfigError('invalid', `mcp.json is not valid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigError('invalid', 'mcp.json must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] !== 2) throw new McpConfigError('invalid', 'mcp.json version must be 2')
  if (typeof record['revision'] !== 'number' || !Number.isInteger(record['revision']) || (record['revision'] as number) < 1) {
    throw new McpConfigError('invalid', 'mcp.json v2 revision must be a positive integer')
  }
  const serversRaw = record['servers']
  if (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    throw new McpConfigError('invalid', "'servers' must be an object")
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new McpConfigError('invalid', `server '${name}' must be an object`)
    }
    const source = value as Record<string, unknown>
    if (typeof source['enabled'] !== 'boolean') {
      throw new McpConfigError('invalid', `server '${name}': v2 requires an explicit enabled boolean`)
    }
    const checked = parseMcpConfig(JSON.stringify({ version: 1, servers: { [name]: { ...source, name } } }))
    const server = checked.servers[name]
    if (server === undefined) throw new McpConfigError('invalid', `server '${name}' failed validation`)
    servers[name] = { ...server, enabled: source['enabled'] }
  }
  const contentHash = hashServers(servers)
  if (record['contentHash'] !== undefined && record['contentHash'] !== contentHash) {
    throw new McpConfigError('invalid', 'mcp.json content hash does not match the servers')
  }
  return { version: 2, revision: record['revision'] as number, contentHash, servers }
}

/**
 * Save must not activate. A new server stays disabled. An existing server
 * keeps the enabled bit the enable/disable routes own.
 */
export function upsertServer(config: McpConfig, name: string, body: Record<string, unknown>): McpConfig {
  const previous = config.servers[name]
  // A save never changes activation: `enabled` and the authorized executable
  // pin come from the stored server, whatever the body says.
  const { enabled: _ignored, executable: _pin, ...rest } = body
  void _ignored
  void _pin
  const parsed = parseMcpConfig(JSON.stringify({ version: 1, servers: { [name]: { ...rest, name } } }))
  const server = parsed.servers[name]
  if (server === undefined) throw new McpConfigError('invalid', `server '${name}' failed validation`)
  const servers = {
    ...config.servers,
    [name]: { ...server, enabled: previous?.enabled === true, ...(previous?.executable !== undefined ? { executable: previous.executable } : {}) },
  }
  return {
    ...config,
    ...(config.version === 2 ? { revision: (config.revision ?? 1) + 1, contentHash: hashServers(servers) } : {}),
    servers,
  }
}

export function withServerEnabled(config: McpConfig, name: string, enabled: boolean): McpConfig {
  const current = config.servers[name]
  if (current === undefined) throw new McpConfigError('not-found', `no MCP server '${name}'`)
  const servers = { ...config.servers, [name]: { ...current, enabled } }
  return {
    ...config,
    ...(config.version === 2 ? { revision: (config.revision ?? 1) + 1, contentHash: hashServers(servers) } : {}),
    servers,
  }
}

/** Explicit activation: enable, and for stdio pin the canonical file the operator just authorized. */
export function withServerActivated(config: McpConfig, name: string, executable: { readonly path: string; readonly sha256: string } | undefined): McpConfig {
  const enabled = withServerEnabled(config, name, true)
  if (executable === undefined) return enabled
  const current = enabled.servers[name]
  if (current === undefined) throw new McpConfigError('not-found', `no MCP server '${name}'`)
  const servers = { ...enabled.servers, [name]: { ...current, executable: { path: executable.path, sha256: executable.sha256 } } }
  return {
    ...enabled,
    ...(enabled.version === 2 ? { contentHash: hashServers(servers) } : {}),
    servers,
  }
}

export function withoutServer(config: McpConfig, name: string): McpConfig {
  if (config.servers[name] === undefined) throw new McpConfigError('not-found', `no MCP server '${name}'`)
  const servers = { ...config.servers }
  delete servers[name]
  return {
    ...config,
    ...(config.version === 2 ? { revision: (config.revision ?? 1) + 1, contentHash: hashServers(servers) } : {}),
    servers,
  }
}

/** Stable identity of the server map. Clients send it back to avoid a silent overwrite. */
export function configRevision(config: McpConfig): string {
  return config.contentHash ?? hashServers(config.servers)
}

export function hashServers(servers: Readonly<Record<string, McpServerConfig>>): string {
  return createHash('sha256').update(stable(servers)).digest('hex')
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}
