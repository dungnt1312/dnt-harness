import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ToolExecution } from '../../harness/tools/types.ts'

const tails = new Map<string, Promise<void>>()

export class FileObservations {
  private readonly observed = new Map<string, Map<string, string>>()

  record(sessionId: string, file: string, content: string): void {
    const records = this.observed.get(sessionId) ?? new Map<string, string>()
    records.set(keyOf(file), digest(content))
    this.observed.set(sessionId, records)
  }

  expected(sessionId: string, file: string): string | undefined {
    return this.observed.get(sessionId)?.get(keyOf(file))
  }

  forget(sessionId: string): void {
    this.observed.delete(sessionId)
  }
}

export function digest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
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

export function observe(exec: ToolExecution, file: string, content: string): void {
  if (exec.sessionId !== undefined) exec.observations?.record(exec.sessionId, file, content)
}

/**
 * What the executing session knows about the target file.
 * - `check`: refuse unless the bytes still hash to `hash`.
 * - `skip`: no session scope (a direct caller outside any agent run) and no
 *   explicit hash — nothing to compare against, so compatibility is kept.
 * - `missing`: a session IS executing but never observed this file: the
 *   overwrite would be blind, so it is refused.
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
  const hash = exec.observations?.expected(exec.sessionId, file)
  return hash === undefined ? { kind: 'missing' } : { kind: 'check', hash }
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

/** Publish `content` atomically, leaving the previous file untouched on failure. */
export async function replaceFile(file: string, content: string): Promise<void> {
  const directory = path.dirname(file)
  const temporary = path.join(directory, `.${path.basename(file)}.tmp-${randomUUID()}`)
  try {
    const handle = await fs.open(temporary, 'wx')
    try {
      await handle.writeFile(content, 'utf8')
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
