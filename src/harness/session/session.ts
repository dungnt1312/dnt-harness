import type { Context } from '../../kernel/index.ts'
import { newSessionId, type SessionId } from '../../util/brand.ts'
import type { ModelMessage } from '../llm/types.ts'
import type { SessionStore } from '../storage/file-session-store.ts'
import { deriveMessages, type SessionAppendedEvent, type SessionEvent } from './events.ts'

declare module 'dnt-harness' {
  interface Events {
    /**
     * An event was appended to a session log (memory) — the live stream for
     * UIs and observers. This is append *visibility*, not a durability
     * acknowledgment: the record reaches disk through the single writer and
     * is only trustworthy-as-durable once `session.durable()` resolves at a
     * checkpoint. Contract-critical publishers (input acceptance, approval
     * recording, the agent's barriers) await that barrier before treating
     * anything as recorded; streaming UI chunks may legitimately arrive
     * first, exactly like transient provider deltas.
     */
    'session/event'(session: Session, event: SessionEvent): void
  }
}

/** Construction options for a `Session`. */
export interface SessionOptions {
  readonly id?: SessionId
  /** Durable store; omitted keeps the log memory-only (unit tests). */
  readonly store?: SessionStore
  /** Injectable clock for deterministic tests. */
  readonly now?: () => number
  /** Called after an append prefix has crossed the durability barrier. */
  readonly onDurable?: (lastSeq: number) => void
}

/**
 * One durable conversation: an append-only event log. The log is the source
 * of model context — `deriveMessages()` projects history from it, and a
 * runtime invariant asserts everything a model sees is reconstructable from
 * it, so a new model-visible input requires a new session event.
 *
 * Appending stamps and stores the event synchronously and hands the record
 * to the store's single writer. Durability is a separate, explicit barrier:
 * {@link Session.durable} resolves only once every record appended so far
 * has been written **and** fsynced. Callers acknowledge durable input, start
 * recorded side effects, or report terminal state only after it resolves.
 * A failed write poisons the session: later appends throw, because memory
 * can no longer be claimed to match the disk.
 */
export class Session {
  private log: SessionEvent[] = []
  /** Monotonic append completion chain; never detach a captured prefix. */
  private writeTail: Promise<void> = Promise.resolve()
  private durableListener: ((lastSeq: number) => void) | undefined
  private poisonedError: unknown
  private disposed = false
  private closed = false
  private lazyId: SessionId | undefined

  constructor(
    private readonly ctx: Context,
    private readonly options: SessionOptions = {},
  ) {
    this.durableListener = options.onDurable
  }

  private get store(): SessionStore | undefined {
    return this.options.store
  }

  private get now(): () => number {
    return this.options.now ?? Date.now
  }

  /** The durable log so far, in append order. */
  get events(): readonly SessionEvent[] {
    return this.log
  }

  /** The session id (minted at construction when not supplied). */
  get id(): SessionId {
    if (this.lazyId === undefined) {
      this.lazyId = this.options.id ?? newSessionId()
    }
    return this.lazyId
  }

  /**
   * Append a durable fact: stamps `seq` and `timestamp`, stores it, and
   * broadcasts `session/event`. Appending is the only way state grows. The
   * record reaches the store asynchronously; see {@link Session.durable}.
   *
   * @returns the stamped event.
   */
  append(event: SessionAppendedEvent): SessionEvent {
    if (this.disposed) {
      throw new Error(`session '${this.id}' has been deleted`)
    }
    if (this.closed) {
      throw new Error(`session '${this.id}' is closing`)
    }
    if (this.poisonedError !== undefined) {
      throw this.poisonedError instanceof Error
        ? this.poisonedError
        : new Error(String(this.poisonedError))
    }
    const stamped = { ...event, seq: this.log.length + 1, timestamp: this.now() } as SessionEvent
    this.log.push(stamped)
    if (this.store !== undefined) {
      // Queue the canonical append before notifying observers. A synchronous
      // observer must never prevent a durable fact from entering this chain.
      // Captured durable() barriers retain their exact append prefix.
      const write = this.writeTail.then(() => this.store?.append(this.id, stamped))
      void write.catch(() => {})
      this.writeTail = write
    }
    // Start all live observers immediately, but use the kernel's `parallel`
    // contract to contain both synchronous throws and rejected async listeners.
    // Observer failures cannot roll back an already-queued canonical append.
    void this.ctx.parallel('session/event', this, stamped).catch((error) => {
      console.warn(`session '${this.id}': event observer failed`, error)
    })
    return stamped
  }

  /**
   * Wait until every record appended so far is written and fsynced. Rejects
   * on the first storage failure; the session is poisoned afterwards and
   * {@link Session.append} throws.
   */
  async durable(): Promise<void> {
    // Capture the append chain before awaiting. Later appends intentionally do
    // not extend this barrier, but every append in this captured prefix does.
    const captured = this.writeTail
    const lastSeq = this.log.length
    try {
      await captured
      await this.store?.flush(this.id)
      this.durableListener?.(lastSeq)
    } catch (error) {
      this.poisonedError = error
      throw error
    }
  }

  /** Set by the service after it establishes session ownership. */
  setDurableListener(listener: (lastSeq: number) => void): void {
    this.durableListener = listener
  }

  /** Mark this instance unusable after its canonical storage is removed. */
  dispose(): void {
    this.disposed = true
  }

  /** Stop new appends while allowing the already-queued writer prefix to drain. */
  close(): void {
    this.closed = true
  }

  /** Wait for the exact canonical append prefix queued at call time. */
  async drain(): Promise<void> {
    await this.writeTail
  }

  /**
   * Whether storage for this session has failed; further appends throw the
   * poisoned error.
   */
  get poisoned(): boolean {
    return this.poisonedError !== undefined
  }

  /** The last recorded custom title, or undefined when the title is derived. */
  get customTitle(): string | undefined {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const event = this.log[i]
      if (event?.type === 'session/title') {
        return event.title === null ? undefined : event.title
      }
    }
    return undefined
  }

  /** Whether the reader pinned this conversation; the last record wins. */
  get pinned(): boolean {
    for (let i = this.log.length - 1; i >= 0; i--) {
      const event = this.log[i]
      if (event?.type === 'session/pinned') return event.pinned
    }
    return false
  }

  /** Project model history from this log; see {@link deriveMessages}. */
  deriveMessages(): ModelMessage[] {
    return deriveMessages(this.log)
  }

  /**
   * Seed a freshly constructed session with events read from storage.
   * Loaded history is not re-broadcast and never re-stamped — seq values
   * come from the log. Internal: called by the sessions service at load.
   */
  adoptHistory(events: readonly SessionEvent[]): void {
    for (const event of events) this.log.push(event)
  }

  /**
   * Fork this session into a new one, copying events up to and including
   * `boundarySeq` (all events when omitted), with `seq` rebased from 1.
   * Copied history is not re-broadcast; the child's future appends are.
   * The child shares this session's store; persisting the copy is the
   * caller's (the sessions service's) job.
   *
   * @returns the child session.
   */
  fork(boundarySeq?: number): Session {
    const child = new Session(this.ctx, {
      ...(this.options.store !== undefined ? { store: this.options.store } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.durableListener !== undefined ? { onDurable: this.durableListener } : {}),
    })
    const limit = boundarySeq ?? this.log[this.log.length - 1]?.seq ?? 0
    for (const event of this.log) {
      if (event.seq > limit) break
      child.log.push({ ...event, seq: child.log.length + 1 })
    }
    return child
  }
}
