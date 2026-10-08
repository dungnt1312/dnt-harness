/**
 * G5 workspace-owned configuration: `mcp.json` (servers), `secrets.json`
 * (credential store). Strict validation — an
 * invalid file surfaces a full error and is never partially executed.
 * Secrets are referenced from `mcp.json` via `${VAR}` and resolved ONLY
 * from the secrets store; `mcp.json` never carries plain credentials.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFile, spawnSync } from 'node:child_process'
import path from 'node:path'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'

export type McpTransport = 'stdio' | 'http'

export interface McpServerConfig {
  readonly name: string
  readonly transport: McpTransport
  /** stdio: executable + args. */
  readonly command?: string
  readonly args?: readonly string[]
  /** stdio env — values may reference secrets via ${VAR}. */
  readonly env?: Readonly<Record<string, string>>
  /** http: Streamable HTTP endpoint. */
  readonly url?: string
  /** Custom HTTP headers; values may reference encrypted secrets. */
  readonly headers?: Readonly<Record<string, string>>
  /** HTTP auth: Bearer, or OAuth access-token reference (flow/provider metadata). */
  readonly auth?:
    | { readonly type: 'bearer'; readonly token: string }
    | { readonly type: 'oauth'; readonly provider: string; readonly accessToken: string }
    | { readonly type: 'external_token'; readonly provider: string; readonly accessToken: string }
    | { readonly type: 'managed_oauth'; readonly provider: string; readonly resource: string; readonly clientId: string; readonly scopes?: readonly string[] }
  readonly enabled: boolean
  readonly timeoutMs?: number
  /** Subprocess resource watchdogs (stdio): hard kill on breach. */
  readonly resourceLimits?: { readonly memoryMb?: number; readonly cpuPercent?: number; readonly maxLifetimeMs?: number; readonly enforcement?: 'hard' | 'best_effort' }
  /** Exposure filter: only these tools register (never a permission bypass). */
  readonly allowedTools?: readonly string[]
  readonly provenance?: { readonly importedFrom?: 'claude' | 'codex'; readonly importedAt?: number }
  /**
   * stdio: the canonical file the operator authorized when enabling. Set only
   * by activation, never by a save; a spawn whose command now resolves to a
   * different path or different bytes is refused until enabled again.
   */
  readonly executable?: { readonly path: string; readonly sha256: string }
}

export interface McpConfig {
  readonly version: 1 | 2
  readonly revision?: number
  readonly contentHash?: string
  readonly servers: Readonly<Record<string, McpServerConfig>>
}

export class McpConfigError extends Error {
  constructor(
    readonly code: 'invalid' | 'not-found' | 'reserved-name' | 'bad-name',
    message: string,
  ) {
    super(message)
    this.name = 'McpConfigError'
  }
}

/** The reserved built-in tool identities (G4/G5 canonical list). */
export const RESERVED_TOOL_NAMES = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'Skill',
  'MemorySearch', 'MemoryRead', 'MemoryCreate', 'MemoryUpdate', 'MemoryForget', 'Agent',
])

const SERVER_NAME_RE = /^[A-Za-z0-9_-]+$/

/** `mcp__<server>__<tool>` — the Claude-convention full tool name. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

/** Validate one server name: charset + reserved-name protection. */
export function validateServerName(name: string): void {
  if (!SERVER_NAME_RE.test(name)) {
    throw new McpConfigError('bad-name', `server name '${name}' must match ${SERVER_NAME_RE.source}`)
  }
}

/** v1 stays on {@link parseMcpConfig}. v2 is the migrated envelope. */
export async function readMcpDocument(raw: string): Promise<McpConfig> {
  let version: unknown
  try {
    version = (JSON.parse(raw) as { version?: unknown }).version
  } catch (error) {
    throw new McpConfigError('invalid', `mcp.json is not valid JSON: ${String(error)}`)
  }
  if (version === 2) {
    const { parseV2McpConfig } = await import('./config-v2.ts')
    return parseV2McpConfig(raw)
  }
  return parseMcpConfig(raw)
}

/** Strict `mcp.json` parse: invalid content is an error, never partial. */
export function parseMcpConfig(raw: string): McpConfig {
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
  for (const key of Object.keys(record)) {
    if (!['version', 'servers'].includes(key)) throw new McpConfigError('invalid', `mcp.json: unknown top-level key '${key}'`)
  }
  if (record['version'] !== 1) {
    throw new McpConfigError('invalid', `mcp.json version must be 1, got ${JSON.stringify(record['version'])}`)
  }
  const serversRaw = record['servers']
  if (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    throw new McpConfigError('invalid', "'servers' must be an object keyed by server name")
  }
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    validateServerName(name)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new McpConfigError('invalid', `server '${name}' must be an object`)
    }
    const server = value as Record<string, unknown>
    if (server['name'] !== undefined && server['name'] !== name) {
      throw new McpConfigError('invalid', `server '${name}': persisted name must match its map key`)
    }
    const transport = server['transport']
    if (transport !== 'stdio' && transport !== 'http') {
      throw new McpConfigError('invalid', `server '${name}': transport must be stdio|http`)
    }
    if (transport === 'stdio' && (typeof server['command'] !== 'string' || server['command'] === '')) {
      throw new McpConfigError('invalid', `server '${name}': stdio transport needs a command`)
    }
    if (transport === 'http' && (typeof server['url'] !== 'string' || !/^https?:\/\//.test(server['url'] as string))) {
      throw new McpConfigError('invalid', `server '${name}': http transport needs an http(s) url`)
    }
    if (server['enabled'] !== undefined && typeof server['enabled'] !== 'boolean') {
      throw new McpConfigError('invalid', `server '${name}': 'enabled' must be a boolean`)
    }
    if (server['timeoutMs'] !== undefined && (typeof server['timeoutMs'] !== 'number' || !Number.isFinite(server['timeoutMs']) || (server['timeoutMs'] as number) <= 0)) {
      throw new McpConfigError('invalid', `server '${name}': 'timeoutMs' must be a positive number`)
    }
    if (server['args'] !== undefined && (!Array.isArray(server['args']) || !(server['args'] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new McpConfigError('invalid', `server '${name}': 'args' must be an array of strings`)
    }
    if (server['allowedTools'] !== undefined && (!Array.isArray(server['allowedTools']) || !(server['allowedTools'] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new McpConfigError('invalid', `server '${name}': 'allowedTools' must be an array of strings`)
    }
    for (const field of ['env', 'headers'] as const) {
      const value = server[field]
      if (value === undefined) continue
      if (value === null || typeof value !== 'object' || Array.isArray(value) || !Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string')) {
        throw new McpConfigError('invalid', `server '${name}': '${field}' must be an object of string values`)
      }
    }
    if (server['resourceLimits'] !== undefined) {
      const limits = server['resourceLimits']
      if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) throw new McpConfigError('invalid', `server '${name}': resourceLimits must be an object`)
      for (const [key, value] of Object.entries(limits as Record<string, unknown>)) {
        if (!['memoryMb', 'cpuPercent', 'maxLifetimeMs', 'enforcement'].includes(key)) throw new McpConfigError('invalid', `server '${name}': unknown resource limit '${key}'`)
        if (key === 'enforcement') {
          if (value !== 'hard' && value !== 'best_effort') throw new McpConfigError('invalid', `server '${name}': enforcement must be hard|best_effort`)
          continue
        }
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new McpConfigError('invalid', `server '${name}': resource limit '${key}' must be positive`)
      }
    }
    if (server['provenance'] !== undefined) {
      const value = server['provenance']
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new McpConfigError('invalid', `server '${name}': invalid provenance`)
      const provenance = value as Record<string, unknown>
      for (const key of Object.keys(provenance)) {
        if (!['importedFrom', 'importedAt'].includes(key)) throw new McpConfigError('invalid', `server '${name}': unknown provenance key '${key}'`)
      }
      if (provenance['importedFrom'] !== undefined && provenance['importedFrom'] !== 'claude' && provenance['importedFrom'] !== 'codex') {
        throw new McpConfigError('invalid', `server '${name}': provenance.importedFrom must be claude|codex`)
      }
      if (provenance['importedAt'] !== undefined && (typeof provenance['importedAt'] !== 'number' || !Number.isFinite(provenance['importedAt']))) {
        throw new McpConfigError('invalid', `server '${name}': provenance.importedAt must be a finite number`)
      }
    }
    for (const key of Object.keys(server)) {
      if (!['name', 'transport', 'command', 'args', 'env', 'url', 'headers', 'auth', 'enabled', 'timeoutMs', 'resourceLimits', 'allowedTools', 'provenance', 'executable'].includes(key)) {
        throw new McpConfigError('invalid', `server '${name}': unknown key '${key}'`)
      }
    }
    const executable = server['executable']
    if (executable !== undefined) {
      const pin = executable as Record<string, unknown> | null
      if (pin === null || typeof pin !== 'object' || typeof pin['path'] !== 'string' || pin['path'] === '' ||
        typeof pin['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(pin['sha256']) || Object.keys(pin).some((key) => key !== 'path' && key !== 'sha256')) {
        throw new McpConfigError('invalid', `server '${name}': executable must be { path, sha256 }`)
      }
    }
    servers[name] = {
      name,
      transport,
      ...(typeof server['command'] === 'string' ? { command: server['command'] } : {}),
      ...(Array.isArray(server['args']) ? { args: server['args'] as string[] } : {}),
      ...(server['env'] !== undefined && typeof server['env'] === 'object' && server['env'] !== null
        ? { env: sanitizeStringRecord(server['env']) }
        : {}),
      ...(typeof server['url'] === 'string' ? { url: server['url'] } : {}),
      ...(server['headers'] !== undefined ? { headers: server['headers'] as Record<string, string> } : {}),
      ...(server['auth'] !== undefined ? { auth: parseAuth(name, server['auth']) } : {}),
      enabled: server['enabled'] !== false,
      ...(typeof server['timeoutMs'] === 'number' ? { timeoutMs: server['timeoutMs'] } : {}),
      ...(server['resourceLimits'] !== undefined ? { resourceLimits: server['resourceLimits'] as NonNullable<McpServerConfig['resourceLimits']> } : {}),
      ...(Array.isArray(server['allowedTools']) ? { allowedTools: server['allowedTools'] as string[] } : {}),
      ...(server['provenance'] !== undefined && server['provenance'] !== null
        ? { provenance: server['provenance'] as NonNullable<McpServerConfig['provenance']> }
        : {}),
      ...(executable !== undefined ? { executable: executable as NonNullable<McpServerConfig['executable']> } : {}),
    }
  }
  return { version: 1, servers }
}

function parseAuth(serverName: string, value: unknown): NonNullable<McpServerConfig['auth']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpConfigError('invalid', `server '${serverName}': 'auth' must be an object`)
  }
  const auth = value as Record<string, unknown>
  if (auth['type'] === 'bearer') {
    for (const key of Object.keys(auth)) {
      if (!['type', 'token'].includes(key)) throw new McpConfigError('invalid', `server '${serverName}': unknown bearer auth key '${key}'`)
    }
    if (typeof auth['token'] !== 'string' || !/^\$\{[A-Za-z0-9_]+\}$/.test(auth['token'])) {
      throw new McpConfigError('invalid', `server '${serverName}': auth.token must be a non-empty ${'${'}VAR} reference`)
    }
    return { type: 'bearer', token: auth['token'] }
  }
  if (auth['type'] === 'oauth' || auth['type'] === 'external_token') {
    for (const key of Object.keys(auth)) {
      if (!['type', 'provider', 'accessToken'].includes(key)) throw new McpConfigError('invalid', `server '${serverName}': unknown ${auth['type']} auth key '${key}'`)
    }
    if (typeof auth['provider'] !== 'string' || auth['provider'] === '') {
      throw new McpConfigError('invalid', `server '${serverName}': oauth.provider must be a non-empty string`)
    }
    if (typeof auth['accessToken'] !== 'string' || !/^\$\{[A-Za-z0-9_]+\}$/.test(auth['accessToken'])) {
      throw new McpConfigError('invalid', `server '${serverName}': oauth.accessToken must reference an encrypted secret`)
    }
    return auth['type'] === 'external_token'
      ? { type: 'external_token', provider: auth['provider'], accessToken: auth['accessToken'] }
      : { type: 'oauth', provider: auth['provider'], accessToken: auth['accessToken'] }
  }
  if (auth['type'] === 'managed_oauth') {
    for (const key of Object.keys(auth)) {
      if (!['type', 'provider', 'resource', 'clientId', 'scopes'].includes(key)) {
        throw new McpConfigError('invalid', `server '${serverName}': unknown managed_oauth auth key '${key}'`)
      }
    }
    if (typeof auth['provider'] !== 'string' || auth['provider'] === '') throw new McpConfigError('invalid', `server '${serverName}': managed_oauth.provider is required`)
    if (typeof auth['resource'] !== 'string' || !/^https?:\/\//.test(auth['resource'])) throw new McpConfigError('invalid', `server '${serverName}': managed_oauth.resource must be an absolute URL`)
    if (typeof auth['clientId'] !== 'string' || auth['clientId'] === '') throw new McpConfigError('invalid', `server '${serverName}': managed_oauth.clientId is required`)
    if (auth['scopes'] !== undefined && (!Array.isArray(auth['scopes']) || !(auth['scopes'] as unknown[]).every((item) => typeof item === 'string'))) {
      throw new McpConfigError('invalid', `server '${serverName}': managed_oauth.scopes must be an array of strings`)
    }
    return {
      type: 'managed_oauth',
      provider: auth['provider'],
      resource: auth['resource'],
      clientId: auth['clientId'],
      ...(Array.isArray(auth['scopes']) ? { scopes: auth['scopes'] as string[] } : {}),
    }
  }
  throw new McpConfigError('invalid', `server '${serverName}': auth.type must be bearer|oauth|external_token|managed_oauth`)
}

/** Secret reference carried in config, if any. Managed OAuth tokens are not stored here. */
export function authSecretRef(auth: McpServerConfig['auth']): string | undefined {
  if (auth === undefined) return undefined
  if (auth.type === 'bearer') return auth.token
  if (auth.type === 'oauth' || auth.type === 'external_token') return auth.accessToken
  return undefined
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}

/** Explicit Claude `.mcp.json` import: provenance recorded, every server disabled (never spawned). */
export function importClaudeMcp(raw: string): McpConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new McpConfigError('invalid', `Claude .mcp.json is invalid JSON: ${String(error)}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new McpConfigError('invalid', 'Claude .mcp.json must be an object')
  }
  const root = parsed as Record<string, unknown>
  const serversRaw = root['mcpServers'] ?? root
  if (serversRaw === null || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
    throw new McpConfigError('invalid', 'Claude import needs an mcpServers object')
  }
  const servers: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(serversRaw as Record<string, unknown>)) {
    validateServerName(name)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new McpConfigError('invalid', `Claude server '${name}' must be an object`)
    }
    const source = value as Record<string, unknown>
    const entry: Record<string, unknown> = {
      enabled: false, // import never auto-enables/spawns
      provenance: { importedFrom: 'claude', importedAt: Date.now() },
    }
    if (typeof source['command'] === 'string') {
      entry.transport = 'stdio'
      entry.command = source['command']
      if (Array.isArray(source['args'])) entry.args = (source['args'] as unknown[]).map(String)
      if (source['env'] !== undefined) entry.env = source['env']
    } else if (typeof source['url'] === 'string') {
      entry.transport = 'http'
      entry.url = source['url']
    } else {
      throw new McpConfigError('invalid', `Claude server '${name}' has neither command nor url`)
    }
    servers[name] = entry
  }
  return parseMcpConfig(JSON.stringify({ version: 1, servers }))
}

/** Pinned Codex MCP import: strict version gate, provenance, disabled by default. */
export function importCodexMcp(toml: string, sourceVersion: string): McpConfig {
  const PINNED = 'openai/codex@38cbebaf3fe3e81a94bf462079e7cf9659fc9e50'
  if (sourceVersion !== PINNED) {
    throw new McpConfigError('invalid', `Codex MCP import version '${sourceVersion}' is outside pinned adapter ${PINNED}`)
  }
  // Minimal pinned fixture subset: [mcp_servers.NAME] + command/url fields.
  const sections = [...toml.matchAll(/\[mcp_servers\.([A-Za-z0-9_-]+)\]([\s\S]*?)(?=\n\[|$)/g)]
  if (sections.length === 0) throw new McpConfigError('invalid', 'Codex import has no [mcp_servers.NAME] sections')
  const servers: Record<string, unknown> = {}
  for (const section of sections) {
    const name = section[1] ?? ''
    const body = section[2] ?? ''
    const command = /(?:^|\n)command\s*=\s*"([^"]+)"/.exec(body)?.[1]
    const url = /(?:^|\n)url\s*=\s*"([^"]+)"/.exec(body)?.[1]
    if (command === undefined && url === undefined) {
      throw new McpConfigError('invalid', `Codex server '${name}' has neither command nor url`)
    }
    servers[name] = command !== undefined
      ? { transport: 'stdio', command, enabled: false, provenance: { importedFrom: 'codex', importedAt: Date.now() } }
      : { transport: 'http', url, enabled: false, provenance: { importedFrom: 'codex', importedAt: Date.now() } }
  }
  return parseMcpConfig(JSON.stringify({ version: 1, servers }))
}

/** Workspace-scoped G5 config store: mcp.json / secrets.json (hooks live in settings.json, see hooks/settings.ts). */
export class McpConfigStore {
  constructor(private readonly home: string) {}

  private workspaceDir(workspaceId: string): string {
    return path.join(this.home, 'workspaces', workspaceId)
  }

  mcpPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'mcp.json')
  }

  secretsPath(workspaceId: string): string {
    return path.join(this.workspaceDir(workspaceId), 'secrets.json')
  }

  /** Load + validate mcp.json; only a missing file is an empty config. */
  async loadMcp(workspaceId: string): Promise<McpConfig> {
    const raw = await readOptionalText(this.mcpPath(workspaceId))
    if (raw === undefined) return { version: 1, servers: {} }
    return readMcpDocument(raw)
  }

  async saveMcp(workspaceId: string, config: McpConfig): Promise<void> {
    await fs.mkdir(this.workspaceDir(workspaceId), { recursive: true })
    await replaceFileAtomic(this.mcpPath(workspaceId), `${JSON.stringify(config, null, 2)}\n`)
  }

  /**
   * Secrets are encrypted at rest (AES-256-GCM) in secrets.json; the local
   * master key is a separate 32-byte file under the application home with
   * restrictive permissions where supported. This is file encryption, not
   * an OS-keychain guarantee — the keychain integration remains a platform
   * hardening seam. Plain values never enter mcp.json or exports.
   */
  async loadSecrets(workspaceId: string): Promise<Record<string, string>> {
    const raw = await readOptionalText(this.secretsPath(workspaceId))
    if (raw === undefined) return {}
    let envelope: { v?: unknown; iv?: unknown; tag?: unknown; ciphertext?: unknown }
    try {
      envelope = JSON.parse(raw) as typeof envelope
    } catch {
      throw new McpConfigError('invalid', 'secrets.json is not valid encrypted JSON')
    }
    if (envelope.v !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') {
      throw new McpConfigError('invalid', 'secrets.json has an invalid encrypted envelope')
    }
    try {
      const key = await this.masterKey()
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
      const parsed = JSON.parse(plaintext) as Record<string, unknown>
      const out: Record<string, string> = {}
      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[name] = value
      }
      return out
    } catch (error) {
      throw new McpConfigError('invalid', `secrets.json cannot be decrypted: ${String(error instanceof Error ? error.message : error)}`)
    }
  }

  async saveSecrets(workspaceId: string, secrets: Record<string, string>): Promise<void> {
    await fs.mkdir(this.workspaceDir(workspaceId), { recursive: true })
    const key = await this.masterKey()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(secrets), 'utf8'),
      cipher.final(),
    ])
    const envelope = {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
    await replaceFileAtomic(this.secretsPath(workspaceId), `${JSON.stringify(envelope, null, 2)}
`)
  }

  private async masterKey(): Promise<Buffer> {
    const file = path.join(this.home, 'secrets.master.key')
    try {
      const key = await fs.readFile(file)
      if (key.length !== 32) throw new Error('master key must be 32 bytes')
      await this.verifyMasterKeyProtection(file)
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const key = randomBytes(32)
      await fs.mkdir(this.home, { recursive: true })
      const handle = await fs.open(file, 'wx', 0o600)
      try {
        await handle.writeFile(key)
        await handle.sync()
      } finally {
        await handle.close()
      }
      await this.protectMasterKey(file)
      await this.verifyMasterKeyProtection(file)
      return key
    }
  }

  /**
   * Establish user-scoped key protection. Windows uses an explicit ACL;
   * POSIX uses chmod 0600. If protection cannot be established, fail
   * closed — never claim encrypted-at-rest with a world-readable key.
   */
  private async protectMasterKey(file: string): Promise<void> {
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o600)
      return
    }
    // Granted by SID: account names are localized and differ for AzureAD
    // and domain users, a SID is not.
    const acl = await readWindowsAcl(file)
    const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `*${acl.currentUser}:F`], { encoding: 'utf8', windowsHide: true })
    if (result.status !== 0) {
      throw new McpConfigError('invalid', `cannot protect secrets.master.key with a user-scoped Windows ACL`)
    }
    this.verifiedKey = undefined
  }

  /** `ctime` of the key when its protection was last verified; a change re-verifies. */
  private verifiedKey: string | undefined

  /**
   * An allowlist, not a denylist: the key may be reachable only by the
   * current OS user. POSIX: owned by this uid, no group/other bits. Windows:
   * inheritance removed and every allow entry is the current user's SID —
   * any other principal (another user, SYSTEM, Administrators, a localized
   * group name) is refused.
   */
  private async verifyMasterKeyProtection(file: string): Promise<void> {
    const stat = await fs.stat(file)
    const fingerprint = `${stat.ctimeMs}:${stat.mtimeMs}:${stat.size}`
    if (this.verifiedKey === fingerprint) return
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) throw new McpConfigError('invalid', 'secrets.master.key permissions are broader than 0600')
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new McpConfigError('invalid', 'secrets.master.key is owned by another user')
      }
    } else {
      const acl = await readWindowsAcl(file)
      if (!acl.protectedFromInheritance) throw new McpConfigError('invalid', 'secrets.master.key still inherits its folder\'s ACL')
      const others = acl.allow.filter((sid) => sid !== acl.currentUser)
      if (others.length > 0 || !acl.allow.includes(acl.currentUser)) {
        throw new McpConfigError('invalid', `secrets.master.key ACL is not user-scoped (also grants ${others.join(', ')}); restore it with: icacls "${file}" /inheritance:r /grant:r *${acl.currentUser}:F`)
      }
    }
    this.verifiedKey = fingerprint
  }
}

interface WindowsAcl {
  readonly currentUser: string
  readonly protectedFromInheritance: boolean
  /** SIDs of every Allow entry. */
  readonly allow: readonly string[]
}

/** The file's ACL as SIDs, plus the current user's SID. The path travels in the environment, never in the script. */
async function readWindowsAcl(file: string): Promise<WindowsAcl> {
  const script = [
    '$acl = Get-Acl -LiteralPath $env:DNT_HARNESS_ACL_TARGET',
    '"ME|" + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '"PROTECTED|" + $acl.AreAccessRulesProtected',
    'foreach ($rule in $acl.Access) { "ACE|" + $rule.AccessControlType + "|" + $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }',
  ].join('; ')
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { ...process.env, DNT_HARNESS_ACL_TARGET: file },
    }, (error, out) => (error === null ? resolve(out) : reject(new McpConfigError('invalid', 'cannot verify Windows ACL on secrets.master.key'))))
  })
  let currentUser = ''
  let protectedFromInheritance = false
  const allow: string[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const [kind, first, second] = line.trim().split('|')
    if (kind === 'ME' && first !== undefined) currentUser = first
    else if (kind === 'PROTECTED') protectedFromInheritance = first === 'True'
    else if (kind === 'ACE' && first === 'Allow' && second !== undefined) allow.push(second)
  }
  if (!/^S-1-/.test(currentUser)) throw new McpConfigError('invalid', 'cannot determine the current Windows user SID')
  return { currentUser, protectedFromInheritance, allow }
}

/**
 * Read a config file that is allowed to be absent. `ENOENT` is the only
 * missing signal; permission errors, directories, and every other failure
 * stay failures so a locked or replaced file cannot look like "no config".
 */
async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    if (code === 'EISDIR') {
      throw new McpConfigError('invalid', `expected a file but found a directory at '${file}'`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new McpConfigError('invalid', `cannot read '${file}': permission denied`)
    }
    throw new McpConfigError('invalid', `cannot read '${file}': ${code ?? 'unknown error'}`)
  }
}

/** Resolve ${VAR} references against the secrets store; missing → surfaced error. */
export function resolveSecretRefs(value: string, secrets: Readonly<Record<string, string>>, context: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
    const resolved = secrets[name]
    if (resolved === undefined) {
      throw new McpConfigError('invalid', `${context}: secret \${${name}} is not present in secrets.json`)
    }
    return resolved
  })
}

/** Hash for audit records: never the raw content. */
export function auditHash(content: unknown): string {
  return createHash('sha256').update(JSON.stringify(content) ?? '', 'utf8').digest('hex').slice(0, 16)
}
