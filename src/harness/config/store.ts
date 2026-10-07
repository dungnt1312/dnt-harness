import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { replaceFileAtomic } from '../storage/events-jsonl.ts'
import { isPlainObject, parseLimitOverrides } from '../limits-config.ts'
import { AppConfigError, type AppConfigDocument } from './types.ts'

/** Optional test/production seam; defaults read utf8 and write via replaceFileAtomic. */
export interface ConfigStoreIo {
  read?: (file: string) => Promise<string>
  write?: (file: string, content: string) => Promise<void>
}

export type ConfigRead =
  | { readonly kind: 'missing'; readonly document: AppConfigDocument; readonly hash: string }
  | { readonly kind: 'valid'; readonly document: AppConfigDocument; readonly hash: string }
  | { readonly kind: 'invalid'; readonly error: string }

/** The canonical missing-file document, frozen so callers cannot mutate the shared baseline. */
const EMPTY: AppConfigDocument = Object.freeze({ v: 1 })
const EMPTY_HASH = canonicalHash(EMPTY)

/** Canonical form: recursively key-sorted JSON, no whitespace. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** SHA256 hex over the canonical encoding — stable across whitespace and key order. */
export function canonicalHash(document: AppConfigDocument): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex')
}

/**
 * Whole-document validation: plain JSON object, no unknown top-level
 * sections, version 1, sparse limits-only overrides that parse under the
 * strict `parseLimitOverrides` semantics.
 */
function parseDocument(raw: string): AppConfigDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new AppConfigError('invalid', `app-config is not valid JSON: ${String(error)}`)
  }
  if (!isPlainObject(parsed)) throw new AppConfigError('invalid', 'app-config must be a plain JSON object')
  const record = parsed
  for (const key of Object.keys(record)) {
    if (key !== 'v' && key !== 'limits') throw new AppConfigError('invalid', `unknown app-config section: ${key}`)
  }
  if (record['v'] !== 1) throw new AppConfigError('invalid', `unsupported app-config version: ${String(record['v'])}`)
  const limits = 'limits' in record && record['limits'] !== undefined ? parseLimitOverrides(record['limits']) : undefined
  const document: { v: 1; limits?: Partial<Record<string, number>> } = { v: 1 }
  if (limits !== undefined) document.limits = limits
  return document as AppConfigDocument
}

/**
 * Versioned atomic persistence for the global app-config file. Reads
 * canonicalize: only ENOENT is missing (→ `{v:1}`), any other read failure
 * surfaces `io`, and corrupt/future/unknown documents stay diagnosable as
 * `invalid` — never repaired or overwritten implicitly. Saves validate the
 * whole document first, then serialize on a per-store promise tail that
 * re-reads the canonical state and compares `expectedHash` (optimistic
 * locking); a mismatch rejects with `conflict` before any write. Write
 * failures reject with `io` and leave the previous bytes untouched.
 */
export class AppConfigStore {
  private readonly file: string
  private readonly io: ConfigStoreIo
  /** Serialized save tail: every save chains behind the previous one. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(file: string, io?: ConfigStoreIo) {
    this.file = file
    this.io = io ?? {}
  }

  async read(): Promise<ConfigRead> {
    let raw: string
    try {
      raw = this.io.read ? await this.io.read(this.file) : await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
        return { kind: 'missing', document: EMPTY, hash: EMPTY_HASH }
      }
      throw new AppConfigError('io', `cannot read '${this.file}': ${String(error)}`)
    }
    try {
      const document = parseDocument(raw)
      return { kind: 'valid', document, hash: canonicalHash(document) }
    } catch (error) {
      return { kind: 'invalid', error: error instanceof Error ? error.message : String(error) }
    }
  }

  save(document: AppConfigDocument, expectedHash: string): Promise<{ document: AppConfigDocument; hash: string }> {
    const run = this.tail.then(() => this.saveLocked(document, expectedHash))
    this.tail = run.catch(() => {})
    return run
  }

  /** Serialized section: validate → re-read canonical state → compare hash → atomic write. */
  private async saveLocked(
    document: AppConfigDocument,
    expectedHash: string,
  ): Promise<{ document: AppConfigDocument; hash: string }> {
    // Whole-document validation BEFORE any hash comparison or write.
    if (document.v !== 1) throw new AppConfigError('invalid', `unsupported app-config version: ${String(document.v)}`)
    for (const key of Object.keys(document)) {
      if (key !== 'v' && key !== 'limits') throw new AppConfigError('invalid', `unknown app-config section: ${key}`)
    }
    let limits: Partial<Record<string, number>> | undefined
    try {
      limits = document.limits === undefined ? undefined : parseLimitOverrides(document.limits)
    } catch (error) {
      throw new AppConfigError('invalid', error instanceof Error ? error.message : String(error))
    }
    const clean: { v: 1; limits?: Partial<Record<string, number>> } = { v: 1 }
    if (limits !== undefined) clean.limits = limits
    const canonical = clean as AppConfigDocument
    const hash = canonicalHash(canonical)

    // Re-read the canonical state inside the lock and compare expected hashes.
    const current = await this.read()
    if (current.kind === 'invalid') {
      throw new AppConfigError('invalid', `cannot save over invalid app-config: ${current.error}`)
    }
    const currentHash = current.kind === 'missing' ? EMPTY_HASH : current.hash
    if (currentHash !== expectedHash) {
      throw new AppConfigError(
        'conflict',
        `app-config changed: stored hash ${currentHash} does not match expected ${expectedHash}`,
      )
    }

    // Stored bytes are exactly the canonical encoding, so hash === content.
    try {
      if (this.io.write) await this.io.write(this.file, canonicalJson(canonical))
      else await replaceFileAtomic(this.file, canonicalJson(canonical))
    } catch (error) {
      throw new AppConfigError('io', `cannot write '${this.file}': ${String(error)}`)
    }
    return { document: canonical, hash }
  }
}
