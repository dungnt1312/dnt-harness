import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeEventsIn, type StreamState } from '../lib/api.ts'
import type { PendingApproval, SseEvent } from '../lib/types.ts'
import { createProjector, type ViewItem } from '../lib/project.ts'

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

/**
 * Remove payloads the browser never renders and chunks superseded by a
 * durable assistant message. Reasoning chunks remain available for the
 * collapsed thought-process disclosure, but are folded to one event per step.
 */
export function compactClientEvents(events: readonly SseEvent[]): readonly SseEvent[] {
  const finalizedSteps = new Set<string>()
  for (const event of events) {
    if (event.type === 'assistant/message' && event.stepId !== undefined) finalizedSteps.add(event.stepId)
  }
  const compacted: SseEvent[] = []
  const thinkingByStep = new Map<string, number>()
  for (const event of events) {
    // Raw context bodies are fetched on demand by hash and never render from
    // the session stream. Keeping them here duplicates potentially large text.
    if (event.type === 'context/body') continue
    if (event.type === 'assistant/chunk' && event.stepId !== undefined) {
      if (finalizedSteps.has(event.stepId) && event.thinking !== true) continue
      if (event.thinking === true) {
        const at = thinkingByStep.get(event.stepId)
        if (at !== undefined) {
          const previous = compacted[at]!
          compacted[at] = { ...previous, delta: `${previous.delta ?? ''}${event.delta ?? ''}` }
          continue
        }
        thinkingByStep.set(event.stepId, compacted.length)
      }
    }
    compacted.push(event)
  }
  return compacted.length === events.length && compacted.every((event, index) => event === events[index]) ? events : compacted
}

export function useSessionStream(workspaceId: string | null, sessionId: string | null) {
  const [events, setEvents] = useState<readonly SseEvent[]>([])
  const [items, setItems] = useState<readonly ViewItem[]>([])
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
    setItems([])
    let projector = createProjector()
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
      setItems(projector.apply(batch))
      setEvents((prev) => compactClientEvents([...prev, ...batch]))
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
        projector = createProjector()
        setItems(projector.apply(envelope.events))
        setEvents(compactClientEvents(envelope.events))
        setApprovals(reconcileApprovals([], envelope.events))
        seenSeq.current = envelope.events.at(-1)?.seq ?? 0
      } else if (envelope.kind === 'resume') {
        const unseen = envelope.events.filter((event) => event.seq > seenSeq.current)
        for (const event of unseen) {
          seenSeq.current = event.seq
          pending.push(event)
        }
        setApprovals((prev) => reconcileApprovals(prev, unseen))
        if (pending.length > 0 && frame === 0) frame = requestAnimationFrame(flush)
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

  return { events, items, approvals, stream, error, dismissApproval }
}
