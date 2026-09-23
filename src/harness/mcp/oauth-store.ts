/**
 * Encrypted OAuth state. Tokens are not written to mcp.json. A transaction
 * is single-use; depositing a code does not reveal the verifier.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

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
}

export class OAuthStore {
  private readonly locks = new Map<string, Promise<void>>()

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
    await this.write(tokenName(workspaceId, server), tokens)
  }

  async readTokens(workspaceId: string, server: string): Promise<OAuthTokens | undefined> {
    return this.read(tokenName(workspaceId, server))
  }

  private async withStateLock<T>(state: string, body: () => Promise<T>): Promise<T> {
    return this.withLock(`state:${state}`, body)
  }

  async withServerLock<T>(workspaceId: string, server: string, body: () => Promise<T>): Promise<T> {
    return this.withLock(`${workspaceId}:${server}`, body)
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
    const tmp = `${target}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(envelope))
    await fs.rename(tmp, target)
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

function tokenName(workspaceId: string, server: string): string {
  return `tokens-${encodeURIComponent(workspaceId)}-${encodeURIComponent(server)}.json`
}
