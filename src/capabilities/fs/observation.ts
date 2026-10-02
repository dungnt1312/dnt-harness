import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolExecution } from '../../harness/tools/types.ts'
import { hashBytes } from './text-document.ts'

const tails = new Map<string, Promise<void>>()

/**
 * What each session has seen of each file: the sha256 of the stored bytes at
 * its last Read/Write/Edit. A mutation is allowed only while the file still
 * hashes to that value, so an external change (another session, Bash, a
 * formatter, the user) is never clobbered blindly.
 */
export class FileObservations {
  private readonly observed = new Map<string, Map<string, string>>()

  /** Record the stored-bytes hash a session has observed. */
  record(sessionId: string, file: string, hash: string): void {
    const records = this.observed.get(sessionId) ?? new Map<string, string>()
    records.set(keyOf(file), hash)
    this.observed.set(sessionId, records)
  }

  expected(sessionId: string, file: string): string | undefined {
    return this.observed.get(sessionId)?.get(keyOf(file))
  }

  forget(sessionId: string): void {
    this.observed.delete(sessionId)
  }
}

/** sha256 of text stored as UTF-8 (explicit-hash callers and tests). */
export function digest(content: string): string {
  return hashBytes(Buffer.from(content, 'utf8'))
}

const keyOf = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file

export async function canonical(file: string): Promise<string> {
  const parent = await fs.realpath(path.dirname(file))
  try {
    return await fs.realpath(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return path.join(parent, path.basename(file))
  }
}

export function observe(exec: ToolExecution, file: string, hash: string): void {
  if (exec.sessionId !== undefined) exec.observations?.record(exec.sessionId, file, hash)
}

/**
 * What the executing session knows about the target file.
 * - `check`: refuse unless the stored bytes still hash to `hash`.
 * - `skip`: no session scope (a direct caller outside any agent run) and no
 *   explicit hash — nothing to compare against, so compatibility is kept.
 * - `missing`: a session IS executing but never observed this file: the
 *   overwrite would be blind, so it is refused.
 *
 * A child agent also sees its parent's observation of a file (read-only):
 * the hash check still applies, so it only helps while the bytes are
 * exactly what the parent saw.
 */
export type ObservationRequirement =
  | { readonly kind: 'check'; readonly hash: string }
  | { readonly kind: 'skip' }
  | { readonly kind: 'missing' }

export function requirementFor(exec: ToolExecution, file: string, explicit: unknown): ObservationRequirement {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !/^[a-f0-9]{64}$/i.test(explicit)) throw new Error("argument 'expectedSha256' must be a SHA-256 hash")
    return { kind: 'check', hash: explicit.toLowerCase() }
  }
  if (exec.sessionId === undefined) return { kind: 'skip' }
  const own = exec.observations?.expected(exec.sessionId, file)
  if (own !== undefined) return { kind: 'check', hash: own }
  for (const ancestor of exec.observationParents ?? []) {
    const inherited = exec.observations?.expected(ancestor, file)
    if (inherited !== undefined) return { kind: 'check', hash: inherited }
  }
  return { kind: 'missing' }
}

export async function withFileLock<T>(file: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
  const key = keyOf(file)
  const previous = tails.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const tail = new Promise<void>((resolve) => { release = resolve })
  tails.set(key, tail)
  await previous
  try {
    if (signal?.aborted === true) throw new Error('cancelled: stop requested while waiting to mutate file')
    return await action()
  } finally {
    release()
    if (tails.get(key) === tail) tails.delete(key)
  }
}

/**
 * Publish `content` atomically, leaving the previous file untouched on
 * failure. An existing file's permission bits carry over to the new inode.
 */
export async function replaceFile(file: string, content: string | Uint8Array): Promise<void> {
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${randomUUID()}`)
  try {
    const mode = await fs.stat(file).then((stat) => stat.mode & 0o7777, () => undefined)
    const handle = await fs.open(temporary, 'wx', mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(temporary, file)
  } catch (error) {
    // A temporary file must never survive a failed publication: the previous
    // bytes stay authoritative and no debris is left beside them.
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
