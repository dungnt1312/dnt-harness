/**
 * Host-owned registry of background Bash processes, keyed by session. The
 * registry owns spawn-lifecycle bookkeeping only: caps, a head-capped output
 * ring, and tree kills through the shell capability's killTree. It knows
 * nothing about the web, SSE, or the session log — hosts bridge the
 * onStart/onExit callbacks to durable events. Processes outlive turns; only
 * a KillShell/operator stop, a child error, natural exit, or session delete
 * (dispose, which emits nothing — the log is going away) ends one. Ended
 * records stay readable for a retention window (one hour by default) and are
 * pruned on later lookups; the durable event log remains the archive.
 */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { killTree } from '../../capabilities/shell/bash.ts'
import { timerBudget } from './shutdown.ts'
import type { SessionId } from '../../util/brand.ts'

export type ProcessTermination = 'exited' | 'killed' | 'failed' | 'interrupted'
export type ProcessStatus = 'running' | ProcessTermination

export interface ProcessRecord {
  readonly id: string
  readonly sessionId: SessionId
  readonly command: string
  readonly cwd: string
  readonly turnId?: string
  readonly startedAt: number
  status: ProcessStatus
  exitCode: number | null
  endedAt: number | null
  /** Combined stdout+stderr captured so far, head-capped. */
  output: string
  outputTruncated: boolean
  /** Set by dispose: exit listeners run but no callbacks fire. */
  suppressEvents: boolean
  /** True once a kill was requested, so close maps to `killed`. */
  killRequested: boolean
  backgrounded: boolean
  rootExited: boolean
}

export interface ProcessSnapshot {
  readonly id: string
  readonly command: string
  readonly cwd: string
  readonly status: ProcessStatus
  readonly startedAt: number
  readonly exitCode: number | null
  readonly durationMs: number
  readonly truncated: boolean
}

export interface RegisterInput {
  readonly sessionId: SessionId
  readonly command: string
  readonly cwd: string
  readonly turnId?: string
  readonly child: ChildProcess
  readonly executable: string
  readonly treeTag: string
}

export interface RegistryLimits {
  readonly perSession: number
  readonly host: number
  readonly ringChars: number
  /** How long an ended record stays readable before a lookup prunes it. */
  readonly endedRetentionMs: number
}

const DEFAULT_LIMITS: RegistryLimits = { perSession: 8, host: 24, ringChars: 64_000, endedRetentionMs: 3_600_000 }

/** Kill-to-close grace: a straggler grandchild can outlive the tree walk, and
 * a loaded host (parallel test workers) delays taskkill noticeably. */
const KILL_SETTLE_MS = 10_000

export class ProcessRegistry {
  private admissionClosed = false
  closeAdmission(): void { this.admissionClosed = true }

  private readonly byId = new Map<string, ProcessRecord>()
  /** Spawned handle per process id, for tree kills. Never serialized. */
  private readonly owners = new Map<string, { child: ChildProcess; executable: string; treeTag: string }>()
  private readonly backgroundTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Registered by `wait()`; each checks its own record and self-removes when it fires. */
  private readonly settleListeners: (() => void)[] = []
  private readonly limits: RegistryLimits

  constructor(
    private readonly events: {
      readonly onStart?: (record: ProcessRecord) => void
      readonly onExit?: (record: ProcessRecord) => void
    } = {},
    limits: Partial<RegistryLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  /** Drop ended records past their retention window; running records are never touched. */
  private pruneEnded(): void {
    const cutoff = Date.now() - this.limits.endedRetentionMs
    for (const [id, record] of this.byId) {
      if (record.status !== 'running' && record.endedAt !== null && record.endedAt < cutoff) this.byId.delete(id)
    }
  }

  canRegister(sessionId: SessionId): { ok: true } | { ok: false; error: string } {
    this.pruneEnded()
    if (this.admissionClosed) return { ok: false, error: 'host is shutting down; command admission closed' }
    if (this.runningCount(sessionId) >= this.limits.perSession) return { ok: false, error: `this session already has ${this.limits.perSession} background processes running; kill one (KillShell) or wait for it to exit before starting another` }
    if (this.runningTotal() >= this.limits.host) return { ok: false, error: `the host limit of ${this.limits.host} running background processes is reached; kill or wait for one before starting another` }
    return { ok: true }
  }

  tryRegister(input: RegisterInput): { ok: true; record: ProcessRecord } | { ok: false; error: string } {
    const capacity = this.canRegister(input.sessionId)
    if (!capacity.ok) return capacity
    const record: ProcessRecord = {
      id: `proc_${randomUUID()}`,
      sessionId: input.sessionId,
      command: input.command,
      cwd: input.cwd,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      endedAt: null,
      output: '',
      outputTruncated: false,
      suppressEvents: false,
      killRequested: false,
      backgrounded: false,
      rootExited: false,
    }
    this.byId.set(record.id, record)
    this.owners.set(record.id, { child: input.child, executable: input.executable, treeTag: input.treeTag })
    this.watch(input, record)
    this.events.onStart?.({ ...record })
    return { ok: true, record }
  }

  private watch(input: RegisterInput, record: ProcessRecord): void {
    const capAt = (chunk: Buffer): void => {
      if (record.outputTruncated) return
      record.output += chunk.toString('utf8')
      if (record.output.length > this.limits.ringChars) {
        record.outputTruncated = true
        record.output = record.output.slice(0, this.limits.ringChars)
      }
    }
    input.child.stdout?.on('data', capAt)
    input.child.stderr?.on('data', capAt)
    const settle = (status: ProcessTermination, code: number | null): void => {
      if (record.status !== 'running') return
      clearTimeout(this.backgroundTimers.get(record.id))
      this.backgroundTimers.delete(record.id)
      record.status = status
      record.exitCode = code
      record.endedAt = Date.now()
      this.owners.delete(record.id)
      this.fireSettleListeners()
      if (!record.suppressEvents) this.events.onExit?.({ ...record })
    }
    input.child.on('exit', (code: number | null) => {
      record.rootExited = true
      if (record.backgrounded && !record.killRequested) return
      // Root exit seals foreground execution; descendants must not hold its
      // pipes until the foreground deadline converts a completed root to background.
      killTree(input.child, input.executable, input.treeTag)
      setTimeout(() => {
        input.child.stdout?.destroy()
        input.child.stderr?.destroy()
        settle(record.killRequested ? 'killed' : 'exited', code)
      }, 20).unref?.()
    })
    input.child.on('error', () => settle('failed', null))
    input.child.on('close', (code: number | null) => settle(record.killRequested ? 'killed' : 'exited', code))
  }

  read(sessionId: SessionId, processId: string): { output: string; outputTruncated: boolean; status: ProcessStatus; exitCode: number | null } | undefined {
    this.pruneEnded()
    const record = this.byId.get(processId)
    if (record === undefined || record.sessionId !== sessionId) return undefined
    return { output: record.output, outputTruncated: record.outputTruncated, status: record.status, exitCode: record.exitCode }
  }

  isDraining(sessionId: SessionId, processId: string): boolean {
    const record = this.byId.get(processId)
    return record?.sessionId === sessionId && record.status === 'running' && record.rootExited
  }

  isRunning(sessionId: SessionId, processId: string): boolean {
    const record = this.byId.get(processId)
    return record !== undefined && record.sessionId === sessionId && record.status === 'running'
  }

  runningCount(sessionId: SessionId): number {
    let count = 0
    for (const record of this.byId.values()) {
      if (record.sessionId === sessionId && record.status === 'running') count += 1
    }
    return count
  }

  private runningTotal(): number {
    let count = 0
    for (const record of this.byId.values()) {
      if (record.status === 'running') count += 1
    }
    return count
  }

  async kill(sessionId: SessionId, processId: string): Promise<{ outcome: 'killed' } | { outcome: 'already-ended'; status: ProcessStatus } | { outcome: 'not-found' }> {
    const record = this.byId.get(processId)
    if (record === undefined || record.sessionId !== sessionId) return { outcome: 'not-found' }
    if (record.status !== 'running') return { outcome: 'already-ended', status: record.status }
    record.killRequested = true
    const owned = this.owners.get(processId)
    if (owned !== undefined) killTree(owned.child, owned.executable, owned.treeTag)
    await this.awaitSettled(record)
    return { outcome: 'killed' }
  }

  commitBackground(sessionId: SessionId, processId: string, options: { maxRuntimeMs?: number } = {}): boolean {
    const record = this.byId.get(processId)
    if (!record || record.sessionId !== sessionId || record.status !== 'running' || record.rootExited) return false
    if (record.backgrounded) return true
    record.backgrounded = true
    if (options.maxRuntimeMs !== undefined && Number.isFinite(options.maxRuntimeMs) && options.maxRuntimeMs > 0) {
      const timer = setTimeout(() => { void this.kill(sessionId, processId).catch(() => {}) }, timerBudget(options.maxRuntimeMs, 3_600_000))
      timer.unref?.()
      this.backgroundTimers.set(processId, timer)
    }
    return true
  }

  /** Every `wait()` promise re-checks its record; fired listeners remove themselves. */
  private fireSettleListeners(): void {
    const pendingListeners = [...this.settleListeners]
    this.settleListeners.length = 0
    for (const listener of pendingListeners) listener()
  }

  async wait(sessionId: SessionId, processId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ReturnType<ProcessRegistry['read']>> {
    if (!this.isRunning(sessionId, processId) || options.signal?.aborted) return this.read(sessionId, processId)
    const record = this.byId.get(processId)
    if (record === undefined) return this.read(sessionId, processId)
    // One waiter per settle: the registry's own exit path resolves it, so no
    // 10ms polling loop burns timers while the process runs.
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        const at = this.settleListeners.indexOf(settle)
        if (at !== -1) this.settleListeners.splice(at, 1)
        clearTimeout(deadline)
        options.signal?.removeEventListener('abort', finish)
        resolve()
      }
      const settle = (): void => {
        if (record.status === 'running') {
          // A foreign record settled; stay registered for this one.
          this.settleListeners.push(settle)
          return
        }
        finish()
      }
      const deadline = setTimeout(finish, timerBudget(options.timeoutMs, 30_000))
      deadline.unref?.()
      options.signal?.addEventListener('abort', finish, { once: true })
      this.settleListeners.push(settle)
    })
    return this.read(sessionId, processId)
  }

  async cancelSession(sessionId: SessionId): Promise<void> {
    await Promise.all(this.snapshot(sessionId).filter(r => r.status === 'running').map(r => this.kill(sessionId, r.id)))
  }

  private async awaitSettled(record: ProcessRecord): Promise<void> {
    await this.wait(record.sessionId, record.id, { timeoutMs: KILL_SETTLE_MS })
    if (record.status === 'running') throw new Error(`process ${record.id} did not confirm termination`)
  }

  snapshot(sessionId: SessionId): readonly ProcessSnapshot[] {
    this.pruneEnded()
    const rows: ProcessSnapshot[] = []
    for (const record of this.byId.values()) {
      if (record.sessionId !== sessionId) continue
      rows.push(this.snapshotOf(record))
    }
    return rows
  }

  /** One process with its captured output; undefined for a foreign or unknown id. */
  detail(sessionId: SessionId, processId: string): (ProcessSnapshot & { readonly output: string; readonly outputTruncated: boolean }) | undefined {
    this.pruneEnded()
    const record = this.byId.get(processId)
    if (record === undefined || record.sessionId !== sessionId) return undefined
    return { ...this.snapshotOf(record), output: record.output, outputTruncated: record.outputTruncated }
  }

  private snapshotOf(record: ProcessRecord): ProcessSnapshot {
    return {
      id: record.id,
      command: record.command,
      cwd: record.cwd,
      status: record.status,
      startedAt: record.startedAt,
      exitCode: record.exitCode,
      durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
      truncated: record.outputTruncated,
    }
  }

  /** Kill every running process of the session. Emits nothing (the session's log is going away). */
  async dispose(sessionId: SessionId): Promise<void> {
    const dying: Promise<void>[] = []
    for (const [id, record] of this.byId.entries()) {
      if (record.sessionId !== sessionId || record.status !== 'running') continue
      record.killRequested = true
      record.suppressEvents = true
      const owned = this.owners.get(id)
      if (owned !== undefined) {
        killTree(owned.child, owned.executable, owned.treeTag)
        dying.push(this.awaitSettled(record))
      }
    }
    await Promise.all(dying)
  }

  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...new Set([...this.byId.values()].map(record => record.sessionId))].map(id => this.dispose(id)))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures, 'process disposal failed')
  }
}
