import type { SessionId, TurnId } from '../../util/brand.ts'
import type { ProcessRecord } from './registry.ts'

interface Sessions {
  has(id: SessionId): boolean
  load(id: SessionId): Promise<{ append(event: unknown): unknown; durable(): Promise<void> }>
}

/** Serialize canonical owner-session writes; callbacks never leak rejected promises. */
export function createProcessSessionEventBridge(sessions: Sessions) {
  const tails = new Map<SessionId, Promise<void>>()
  const failures = new Map<SessionId, unknown>()
  const enqueue = (record: ProcessRecord, event: unknown) => {
    const previous = tails.get(record.sessionId) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (!sessions.has(record.sessionId)) return
      const session = await sessions.load(record.sessionId)
      if (!sessions.has(record.sessionId)) return
      session.append(event)
      await session.durable()
    }).catch(error => { failures.set(record.sessionId, error) })
    tails.set(record.sessionId, next)
    void next.then(() => { if (tails.get(record.sessionId) === next) tails.delete(record.sessionId) })
  }
  return {
    onStart(record: ProcessRecord) {
      enqueue(record, { type: 'process/start', processId: record.id, command: record.command, cwd: record.cwd, ...(record.turnId !== undefined ? { turnId: record.turnId as TurnId } : {}) })
    },
    onExit(record: ProcessRecord) {
      enqueue(record, { type: 'process/exit', processId: record.id, exitCode: record.exitCode, termination: record.status, durationMs: (record.endedAt ?? record.startedAt) - record.startedAt })
    },
    async flushAll() {
      while (tails.size > 0) await Promise.all(tails.values())
      if (failures.size > 0) throw failures.values().next().value
    },
    async flush(sessionId: SessionId) {
      while (tails.has(sessionId)) await tails.get(sessionId)
      if (failures.has(sessionId)) throw failures.get(sessionId)
    },
  }
}
