/**
 * The per-install secret that keys route-identity credential fingerprints
 * (see `credentialGeneration` in effective-model.ts). Host-side: the CLI and
 * the web host load it from the directory holding `providers.json`, so both
 * compute the same identities for the same key.
 *
 * The secret is 32 random bytes, created once with owner-only permissions
 * (best effort on Windows, where POSIX modes are not enforced) and never
 * logged. When the directory cannot be read or written, a process-local
 * secret is used instead: identities then do not survive a restart, which
 * only means lineage keyed on them is not reused — never a wrong reuse.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { hmacCredentialHasher, type CredentialHasher } from './effective-model.ts'

export const CREDENTIAL_SECRET_FILE = 'route-identity.secret'

export interface LoadedCredentialHasher {
  readonly hash: CredentialHasher
  /** False when the in-memory fallback is in use (identities are process-local). */
  readonly persistent: boolean
}

const SECRET_HEX = /^[0-9a-f]{64}$/

function readSecret(file: string): Buffer | undefined {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return SECRET_HEX.test(text) ? Buffer.from(text, 'hex') : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Load (or create once) the secret in `dir`; fall back to a process-local one. */
export function loadCredentialHasher(dir: string): LoadedCredentialHasher {
  const file = path.join(dir, CREDENTIAL_SECRET_FILE)
  try {
    const existing = readSecret(file)
    if (existing !== undefined) return { hash: hmacCredentialHasher(existing), persistent: true }
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const secret = randomBytes(32)
    try {
      // `wx`: never overwrite a secret another process created concurrently.
      writeFileSync(file, `${secret.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      return { hash: hmacCredentialHasher(secret), persistent: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const raced = readSecret(file)
      if (raced !== undefined) return { hash: hmacCredentialHasher(raced), persistent: true }
      throw error
    }
  } catch {
    return { hash: hmacCredentialHasher(randomBytes(32)), persistent: false }
  }
}
