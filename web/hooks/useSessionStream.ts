import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeEventsIn, type StreamState } from '../lib/api.ts'
import type { PendingApproval, SseEvent } from '../lib/types.ts'

/** Rebuild pending questions from durable facts, including reconnect replay. */
export function reconcileApprovals(pending: readonly PendingApproval[], events: readonly SseEvent[]): readonly PendingApproval[] {
  const next = new Map(pending.map((row) => [row.approvalId, row]))
  for (const event of events) {
    if (event.type === 'approval/request' && event.approvalId && event.call) {
      next.set(event.approvalId, { approvalId: event.approvalId, call: event.call })
    } else if (event.type === 'approval/decision' && event.approvalId) {
      next.delete(event.approvalId)
    } else if (event.type === 'tool/result') {
      for (const [id, row] of next) if (row.call.id === event.callId) next.delete(id)
    } else if (event.type === 'turn/end') {
      next.clear()
    }
  }
  return [...next.values()]
}

export function useSessionStream(workspaceId: string | null, sessionId: string | null) {
  const [events, setEvents] = useState<readonly SseEvent[]>([])
  const [approvals, setApprovals] = useState<readonly PendingApproval[]>([])
  const [stream, setStream] = useState<StreamState>('idle')
  const [error, setError] = useState<string | null>(null)
  const seenSeq = useRef(0)
  const dismissApproval = useCallback((id: string) => {
    setApprovals((prev) => prev.filter((row) => row.approvalId !== id))
  }, [])

  useEffect(() => {
    seenSeq.current = 0
    setEvents([])
    setApprovals([])
    setError(null)
    setStream(sessionId === null || workspaceId === null ? 'idle' : 'connecting')
    if (sessionId === null || workspaceId === null) return
    let disposed = false
    const dispose = subscribeEventsIn(workspaceId, sessionId, (envelope) => {
      if (disposed) return
      if (envelope.kind === 'snapshot') {
        setEvents(envelope.events)
        setApprovals(reconcileApprovals([], envelope.events))
        seenSeq.current = envelope.events.at(-1)?.seq ?? 0
      } else if (envelope.kind === 'session') {
        const { event } = envelope
        if (event.seq <= seenSeq.current) return
        seenSeq.current = event.seq
        setEvents((prev) => [...prev, event])
        setApprovals((prev) => reconcileApprovals(prev, [event]))
      } else if (envelope.kind === 'error') {
        setError(envelope.message)
      } else if (envelope.kind === 'approval-settled') {
        setApprovals((prev) => prev.filter((row) => row.approvalId !== envelope.approvalId))
      } else {
        setApprovals((prev) => {
          const next = {
            approvalId: envelope.approvalId,
            call: envelope.call,
            ...(envelope.interactive === true ? { interactive: true } : {}),
            ...(envelope.childSessionId !== undefined ? { childSessionId: envelope.childSessionId } : {}),
            ...(envelope.definitionName !== undefined ? { definitionName: envelope.definitionName } : {}),
            ...(envelope.expiresAt !== undefined ? { expiresAt: envelope.expiresAt } : {}),
            ...(envelope.guardWarning !== undefined ? { guardWarning: envelope.guardWarning } : {}),
          }
          if (prev.some((row) => row.approvalId === envelope.approvalId)) {
            return prev.map((row) => row.approvalId === envelope.approvalId ? { ...row, ...next } : row)
          }
          return [...prev, next]
        })
      }
    }, (state) => { if (!disposed) setStream(state) })
    return () => { disposed = true; dispose() }
  }, [workspaceId, sessionId])

  return { events, approvals, stream, error, dismissApproval }
}
