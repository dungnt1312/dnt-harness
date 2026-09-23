import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeEventsIn, type StreamState } from '../lib/api.ts'
import type { PendingApproval, SseEvent } from '../lib/types.ts'

/** Rebuild pending questions from durable facts, including reconnect replay. */
export function reconcileApprovals(pending: readonly PendingApproval[], events: readonly SseEvent[]): readonly PendingApproval[] {
  const next = new Map(pending.map((row) => [row.approvalId, row]))
  for (const event of events) {
    if (event.type === 'approval/request' && event.approvalId && event.call) {
      // The durable request carries the out-of-grant facts, so a card rebuilt
      // after a reload still explains itself; a live row keeps its extras.
      next.set(event.approvalId, {
        ...next.get(event.approvalId),
        approvalId: event.approvalId,
        call: event.call,
        ...(event.scopeWarning !== undefined ? { scopeWarning: event.scopeWarning } : {}),
        ...(event.proposedGrant !== undefined ? { proposedGrant: event.proposedGrant } : {}),
        ...(event.proposedAccess !== undefined ? { proposedAccess: event.proposedAccess } : {}),
      })
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
    let frame = 0
    let pending: SseEvent[] = []
    const flush = (): void => {
      frame = 0
      if (disposed || pending.length === 0) return
      const batch = pending
      pending = []
      setEvents((prev) => [...prev, ...batch])
    }
    const discardPending = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      pending = []
    }
    const dispose = subscribeEventsIn(workspaceId, sessionId, (envelope) => {
      if (disposed) return
      if (envelope.kind === 'snapshot') {
        discardPending()
        setEvents(envelope.events)
        setApprovals(reconcileApprovals([], envelope.events))
        seenSeq.current = envelope.events.at(-1)?.seq ?? 0
      } else if (envelope.kind === 'session') {
        const { event } = envelope
        if (event.seq <= seenSeq.current) return
        seenSeq.current = event.seq
        pending.push(event)
        if (event.type === 'approval/request' || event.type === 'approval/decision' || event.type === 'tool/result' || event.type === 'turn/end') {
          setApprovals((prev) => {
            const next = reconcileApprovals(prev, [event])
            return next.length === prev.length && next.every((row, index) => row === prev[index]) ? prev : next
          })
        }
        if (frame === 0) frame = requestAnimationFrame(flush)
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
            ...(envelope.scopeWarning !== undefined ? { scopeWarning: envelope.scopeWarning } : {}),
            ...(envelope.proposedGrant !== undefined ? { proposedGrant: envelope.proposedGrant } : {}),
            ...(envelope.proposedAccess !== undefined ? { proposedAccess: envelope.proposedAccess } : {}),
          }
          if (prev.some((row) => row.approvalId === envelope.approvalId)) {
            return prev.map((row) => row.approvalId === envelope.approvalId ? { ...row, ...next } : row)
          }
          return [...prev, next]
        })
      }
    }, (state) => { if (!disposed) setStream(state) })
    return () => { disposed = true; discardPending(); dispose() }
  }, [workspaceId, sessionId])

  return { events, approvals, stream, error, dismissApproval }
}
