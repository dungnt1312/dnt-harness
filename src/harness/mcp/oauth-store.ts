/**
 * Encrypted OAuth state. Tokens are not written to mcp.json. A transaction
 * is single-use; depositing a code does not reveal the verifier.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { TokenEndpointAuth } from './config.ts'

export type OAuthPhase = 'active' | 'refresh_in_progress' | 'replacement_persisted' | 'auth_required' | 'local_revoked'

export interface OAuthTokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly tokenEndpoint: string
  readonly clientId: string
  readonly phase: OAuthPhase
  readonly resource: string
  readonly workspaceId?: string
  readonly server?: string
  /** How refresh authenticates; absent means `none` (public client). The secret itself is never stored here. */
  readonly tokenEndpointAuth?: TokenEndpointAuth
  /** Set by an `insufficient_scope` answer: the scope the next sign-in must request. */
  readonly missingScope?: string
}

/**
 * What discovery found for one server, plus the client the host registered.
 * Host-owned: request bodies never supply these endpoints.
 */
export interface OAuthServerRecord {
  /** The `mcp.json` URL this record was discovered for. A different URL invalidates it. */
  readonly serverUrl: string
  readonly resource: string
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly revocationEndpoint?: string
  /** Scopes requested at the last connect. */
  readonly scopes: readonly string[]
  /** Present only for a client the host registered (RFC 7591). */
  readonly registration?: { readonly clientId: string; readonly redirectUri: string; readonly issuedAt: number }
  readonly discoveredAt: number
}

export interface OAuthTransaction {
  readonly state: string
  readonly verifier: string
  readonly workspaceId: string
  readonly server: string
  readonly principalId: string
  readonly resource: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly code: string | undefined
  readonly tokenEndpointAuth?: TokenEndpointAuth
  /** Discovery awaiting a successful token exchange. */
  readonly serverRecord?: OAuthServerRecord
  /** Durable incarnation of this name at begin, independent of its URL. */
  readonly incarnation?: string
  /** Exact OAuth configuration used at begin. */
  readonly configIdentity?: string
}

export class OAuthStore {
  private readonly locks = new Map<string, Promise<void>>()
  private readonly publicationContext = new AsyncLocalStorage<string>()

  constructor(private readonly directory: string, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('oauth store key must be 32 bytes')
  }

  async saveTransaction(tx: OAuthTransaction): Promise<void> {
    await this.write(`tx-${tx.state}.json`, tx)
  }

  async readTransaction(state: string): Promise<OAuthTransaction | undefined> {
    return this.read(`tx-${state}.json`)
  }

  /**
   * Claim a transaction once. A second caller sees it as already used, even
   * if the first caller has not finished writing the deposited code.
   */
  async takeTransaction(state: string): Promise<OAuthTransaction | undefined> {
    return this.withStateLock(state, async () => {
      const tx = await this.readTransaction(state)
      if (tx === undefined || tx.code !== undefined) return tx
      const claim = path.join(this.directory, `tx-${state}.claimed`)
      try {
        const handle = await fs.open(claim, 'wx')
        await handle.close()
        return tx
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        return { ...tx, code: 'claimed' }
      }
    })
  }

  async deleteTransaction(state: string): Promise<void> {
    await fs.rm(path.join(this.directory, `tx-${state}.json`), { force: true })
  }

  async saveTokens(workspaceId: string, server: string, tokens: OAuthTokens): Promise<void> {
    const grant = await this.read<{ record: OAuthServerRecord }>(grantName(workspaceId, server))
    if (grant !== undefined) await this.write(grantName(workspaceId, server), { record: grant.record, tokens })
    else await this.write(tokenName(workspaceId, server), tokens)
  }

  async readTokens(workspaceId: string, server: string): Promise<OAuthTokens | undefined> {
    const grant = await this.read<{ tokens: OAuthTokens; record: OAuthServerRecord }>(grantName(workspaceId, server))
    return grant?.tokens ?? this.read(tokenName(workspaceId, server))
  }

  /** One encrypted rename publishes both halves of a new managed grant. */
  async publishGrant(workspaceId: string, server: string, tokens: OAuthTokens, record: OAuthServerRecord): Promise<void> {
    await this.write(grantName(workspaceId, server), { tokens, record })
    // The combined file always wins reads. Old standalone files are removed only
    // after publication; a failed cleanup cannot expose a partial new grant.
    await Promise.all([
      fs.rm(path.join(this.directory, tokenName(workspaceId, server)), { force: true }),
      fs.rm(path.join(this.directory, recordName(workspaceId, server)), { force: true }),
    ])
  }

  async incarnation(workspaceId: string, server: string): Promise<string> {
    return this.withPublicationLock(workspaceId, server, () => this.incarnationUnlocked(workspaceId, server))
  }

  /** Only call while holding the publication lock for this server. */
  async incarnationUnlocked(workspaceId: string, server: string): Promise<string> {
    this.assertPublicationLock(workspaceId, server)
    const name = epochName(workspaceId, server)
    const existing = await this.read<string>(name)
    if (existing !== undefined) return existing
    const created = randomBytes(32).toString('hex')
    await this.write(name, created)
    return created
  }

  async invalidate(workspaceId: string, server: string): Promise<void> {
    // Config mutations already hold this lock across save + invalidation.
    if (this.holdsPublicationLock(workspaceId, server)) return this.invalidateUnlocked(workspaceId, server)
    await this.withPublicationLock(workspaceId, server, () => this.invalidateUnlocked(workspaceId, server))
  }

  /** Only call while holding the publication lock for this server. */
  async invalidateUnlocked(workspaceId: string, server: string): Promise<void> {
    this.assertPublicationLock(workspaceId, server)
    await this.write(epochName(workspaceId, server), randomBytes(32).toString('hex'))
  }

  /** Pre-incarnation fixture grants alone may lack a discovery record. */
  async isLegacyFixtureGrant(workspaceId: string, server: string): Promise<boolean> {
    return await this.read(epochName(workspaceId, server)) === undefined
      && await this.read(grantName(workspaceId, server)) === undefined
  }

  async saveServerRecord(workspaceId: string, server: string, record: OAuthServerRecord): Promise<void> {
    await this.write(recordName(workspaceId, server), record)
  }

  async readServerRecord(workspaceId: string, server: string): Promise<OAuthServerRecord | undefined> {
    const grant = await this.read<{ record: OAuthServerRecord }>(grantName(workspaceId, server))
    return grant?.record ?? this.read(recordName(workspaceId, server))
  }

  /** The server left the config: forget its discovery, registration, and tokens. */
  async deleteServer(workspaceId: string, server: string): Promise<void> {
    await this.invalidate(workspaceId, server)
    await fs.rm(path.join(this.directory, grantName(workspaceId, server)), { force: true })
    await fs.rm(path.join(this.directory, recordName(workspaceId, server)), { force: true })
    await fs.rm(path.join(this.directory, tokenName(workspaceId, server)), { force: true })
  }

  private async withStateLock<T>(state: string, body: () => Promise<T>): Promise<T> {
    return this.withLock(`state:${state}`, body)
  }

  async withServerLock<T>(workspaceId: string, server: string, body: () => Promise<T>): Promise<T> {
    return this.withLock(`${workspaceId}:${server}`, body)
  }

  async withPublicationLock<T>(workspaceId: string, server: string, body: () => Promise<T>): Promise<T> {
    const key = `publication:${JSON.stringify([workspaceId, server])}`
    return this.withLock(key, () => this.publicationContext.run(key, body))
  }

  private holdsPublicationLock(workspaceId: string, server: string): boolean {
    return this.publicationContext.getStore() === `publication:${JSON.stringify([workspaceId, server])}`
  }

  private assertPublicationLock(workspaceId: string, server: string): void {
    if (!this.holdsPublicationLock(workspaceId, server)) throw new Error('OAuth publication lock required')
  }

  private async withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.locks.set(key, previous.then(() => gate))
    await previous
    try {
      return await body()
    } finally {
      release()
    }
  }

  private async write(name: string, value: unknown): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true })
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    const envelope = {
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }
    const target = path.join(this.directory, name)
    const tmp = `${target}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(envelope), { flag: 'wx' })
      await fs.rename(tmp, target)
    } finally {
      await fs.rm(tmp, { force: true })
    }
  }

  private async read<T>(name: string): Promise<T | undefined> {
    try {
      const envelope = JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8')) as { iv?: string; tag?: string; ciphertext?: string }
      if (typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') return undefined
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8')
      return JSON.parse(plaintext) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

function epochName(workspaceId: string, server: string): string {
  return `epoch-${encodeURIComponent(workspaceId)}-${encodeURIComponent(server)}.json`
}

function grantName(workspaceId: string, server: string): string {
  return `grant-${encodeURIComponent(workspaceId)}-${encodeURIComponent(server)}.json`
}

function tokenName(workspaceId: string, server: string): string {
  return `tokens-${encodeURIComponent(workspaceId)}-${encodeURIComponent(server)}.json`
}

function recordName(workspaceId: string, server: string): string {
  return `server-${encodeURIComponent(workspaceId)}-${encodeURIComponent(server)}.json`
}
