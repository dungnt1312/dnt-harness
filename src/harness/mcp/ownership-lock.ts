/**
 * One data-home owner. The lock file is created exclusively and held open.
 * A second host refuses to start while the holder is alive and inside its
 * lease. A dead holder can be replaced; the replacement gets a new fencing
 * epoch so the old host cannot keep writing.
 *
 * This is a local-filesystem lock. Network filesystems are not a supported
 * production deployment.
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OwnershipError'
  }
}

interface LockFile {
  readonly ownerId: string
  readonly epoch: number
  readonly pid: number
  readonly heartbeat: number
}

export interface DataHomeLockOptions {
  readonly leaseMs?: number
  readonly now?: () => number
  readonly isAlive?: (pid: number) => boolean
}

const DEFAULT_LEASE_MS = 8_000

/** `kill(pid, 0)` — EPERM means the process exists but is not signalable. */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class DataHomeLock {
  private timer: ReturnType<typeof setInterval> | undefined
  private handle: fs.FileHandle | undefined
  private released = false

  private constructor(
    readonly home: string,
    readonly ownerId: string,
    private epochValue: number,
    private readonly options: { readonly leaseMs: number; readonly now: () => number; readonly isAlive: (pid: number) => boolean },
  ) {}

  get epoch(): number {
    return this.epochValue
  }

  static async acquire(home: string, options: DataHomeLockOptions = {}): Promise<DataHomeLock> {
    const resolved = {
      leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
      now: options.now ?? (() => Date.now()),
      isAlive: options.isAlive ?? pidIsAlive,
    }
    await fs.mkdir(home, { recursive: true })
    const file = lockPath(home)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(file, 'wx')
        const ownerId = randomUUID()
        const epoch = await nextEpoch(home)
        const lock = new DataHomeLock(home, ownerId, epoch, resolved)
        lock.handle = handle
        const body = JSON.stringify({ ownerId, epoch, pid: process.pid, heartbeat: resolved.now() } satisfies LockFile)
        await handle.write(body, 0)
        await handle.sync()
        await lock.writeHeartbeat()
        lock.startHeartbeat()
        return lock
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const current = await readLock(file)
        const beat = await readLock(path.join(home, 'mcp-owner.heartbeat'))
        const heartbeat = beat?.heartbeat ?? current?.heartbeat ?? 0
        const fresh = current !== undefined && resolved.now() - heartbeat < resolved.leaseMs && resolved.isAlive(current.pid)
        if (fresh) {
          throw new OwnershipError(`data home already has a live owner (epoch ${current?.epoch ?? '?'})`)
        }
        await fs.rm(file, { force: true }).catch(() => undefined)
      }
    }
    throw new OwnershipError('could not acquire the data-home lock')
  }

  /** Crash stand-in: drop the handle without deleting the lock file. */
  async abandon(): Promise<void> {
    this.stopHeartbeat()
    await this.handle?.close().catch(() => undefined)
    this.handle = undefined
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    this.stopHeartbeat()
    await this.handle?.close().catch(() => undefined)
    this.handle = undefined
    await fs.rm(lockPath(this.home), { force: true }).catch(() => undefined)
  }

  /** Writers call this before appending evidence. A lost epoch fences them. */
  async assertHeld(): Promise<void> {
    if (this.released || this.handle === undefined) {
      throw new OwnershipError('data-home lock is not held')
    }
    const current = await readLock(lockPath(this.home))
    if (current === undefined || current.epoch !== this.epochValue || current.ownerId !== this.ownerId) {
      throw new OwnershipError('data-home fencing epoch changed')
    }
  }

  private startHeartbeat(): void {
    this.timer = setInterval(() => {
      void this.writeHeartbeat().catch(() => undefined)
    }, Math.max(50, Math.floor(this.options.leaseMs / 3)))
    this.timer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  private async writeHeartbeat(): Promise<void> {
    const body = JSON.stringify({ ownerId: this.ownerId, epoch: this.epochValue, pid: process.pid, heartbeat: this.options.now() })
    const target = path.join(this.home, 'mcp-owner.heartbeat')
    const tmp = `${target}.${process.pid}.tmp`
    await fs.writeFile(tmp, body)
    await fs.rename(tmp, target)
  }
}

function lockPath(home: string): string {
  return path.join(home, 'mcp-owner.lock')
}

async function nextEpoch(home: string): Promise<number> {
  const marker = path.join(home, 'mcp-owner.epoch')
  let previous = 0
  try {
    previous = Number(await fs.readFile(marker, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const next = Number.isInteger(previous) && previous > 0 ? previous + 1 : 1
  await fs.writeFile(marker, String(next), 'utf8')
  return next
}

async function readLock(file: string): Promise<LockFile | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockFile>
    if (typeof parsed.ownerId !== 'string' || typeof parsed.epoch !== 'number' || typeof parsed.pid !== 'number' || typeof parsed.heartbeat !== 'number') {
      return undefined
    }
    return { ownerId: parsed.ownerId, epoch: parsed.epoch, pid: parsed.pid, heartbeat: parsed.heartbeat }
  } catch {
    return undefined
  }
}
