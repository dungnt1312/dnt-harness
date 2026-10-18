import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { subscribeEventsIn, type StreamState } from '../lib/api.ts'
import type { PendingApproval, PendingQuestion, SseEvent } from '../lib/types.ts'
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
 * The incremental twin below powers the live stream; this whole-array form
 * stays for one-shot inputs (tests, snapshots).
 */
export function compactClientEvents(events: readonly SseEvent[]): readonly SseEvent[] {
  return createEventCompactor()(events)
}

/**
 * Incremental twin of {@link compactClientEvents}: each streamed batch folds
 * into the kept list as it arrives, so a frame costs O(batch) instead of
 * rescanning the session's whole history every animation frame. The one full
 * scan happens when a step finalizes (its earlier content chunks must go) —
 * once per step, not once per chunk. Thinking folds and drops follow exactly
 * the whole-array rules, and a batch that changes nothing returns the same
 * array reference so downstream memos skip work.
 */
export function createEventCompactor(): (batch: readonly SseEvent[]) => readonly SseEvent[] {
  let events: SseEvent[] = []
  const finalizedSteps = new Set<string>()
  const abandonedSteps = new Set<string>()
  const thinkingAt = new Map<string, number>()
  return (batch) => {
    if (batch.length === 0) return events
    let newlyFinalized = false
    let newlyAbandoned = false
    for (const event of batch) {
      if (event.type === 'assistant/message' && event.stepId !== undefined && !finalizedSteps.has(event.stepId)) {
        finalizedSteps.add(event.stepId)
        newlyFinalized = true
      }
      if (event.type === 'step/abandoned' && event.stepId !== undefined && !abandonedSteps.has(event.stepId)) {
        abandonedSteps.add(event.stepId)
        newlyAbandoned = true
      }
    }
    const pushed: SseEvent[] = []
    let folded = false
    for (const event of batch) {
      if (event.type === 'context/body') continue
      if (event.type === 'assistant/chunk' && event.stepId !== undefined) {
        if (event.thinking === true) {
          const at = thinkingAt.get(event.stepId)
          if (at !== undefined) {
            // The fold target may still sit in this batch's `pushed` tail
            // (same-batch chunks), not yet joined into `events`.
            const target = at < events.length ? events[at] : pushed[at - events.length]
            if (target !== undefined) {
              const merged = { ...target, delta: `${target.delta ?? ''}${event.delta ?? ''}` }
              if (at < events.length) events[at] = merged
              else pushed[at - events.length] = merged
              folded = true
              continue
            }
          }
          // The fold target lands at this index once `pushed` joins `events`.
          thinkingAt.set(event.stepId, events.length + pushed.length)
        } else if (finalizedSteps.has(event.stepId) || abandonedSteps.has(event.stepId)) {
          // A step's content chunks leave once the step finalized or was
          // abandoned: a durable message replaces the former, and the latter's
          // partial text never renders again.
          continue
        }
      }
      pushed.push(event)
    }
    if (pushed.length > 0 || folded) events = pushed.length > 0 ? [...events, ...pushed] : [...events]
    if (newlyFinalized || newlyAbandoned) {
      // Earlier content chunks of the settled steps leave the kept list; fold
      // indices shift with them, so the map rebuilds from the result.
      events = events.filter((event) => !(
        event.type === 'assistant/chunk' && event.thinking !== true && event.stepId !== undefined && (finalizedSteps.has(event.stepId) || abandonedSteps.has(event.stepId))
      ))
      thinkingAt.clear()
      events.forEach((event, index) => {
        if (event.type === 'assistant/chunk' && event.thinking === true && event.stepId !== undefined) thinkingAt.set(event.stepId, index)
      })
    }
    return events
  }
}

/** Inactive navigation cache bounds: entry count and conservative payload weight. */
const MAX_CACHE_ENTRIES = 4
const MAX_CACHE_WEIGHT = 16_000_000
const EMPTY_EVENTS: readonly SseEvent[] = []
const EMPTY_ITEMS: readonly ViewItem[] = []
interface CachedStream {
  projector: ReturnType<typeof createProjector>
  compact: ReturnType<typeof createEventCompactor>
  events: readonly SseEvent[]
  items: readonly ViewItem[]
  cursor: number
  ready: boolean
  weight: number
}

/**
 * `delegationsOnly` opens the server's delegation projection: for a root the
 * caller reads only spawn/result facts from, it skips the full history replay.
 */
export function useSessionStream(workspaceId: string | null, sessionId: string | null, delegationsOnly = false) {
  // Hook-owned memory only: no history persists across logout/App unmount.
  const cache = useRef(new Map<string, CachedStream>())
  const scope = workspaceId !== null && sessionId !== null ? JSON.stringify([workspaceId, sessionId, delegationsOnly]) : null
  const [loadedScope, setLoadedScope] = useState<string | null>(null)
  const [events, setEvents] = useState<readonly SseEvent[]>([])
  const [items, setItems] = useState<readonly ViewItem[]>([])
  const [approvals, setApprovals] = useState<readonly PendingApproval[]>([])
  // Live-only: the server re-sends every still-open question on (re)connect.
  const [questions, setQuestions] = useState<readonly PendingQuestion[]>([])
  const [stream, setStream] = useState<StreamState>('idle')
  // True once this conversation's first snapshot/resume frame landed: before
  // that, `events` reflects nothing and "is it running?" is unknown, not no.
  const [settled, setSettled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seenSeq = useRef(0)
  // Scope of the latest *committed* render. A layout effect runs in the commit,
  // before the previous scope's passive cleanup, so that cleanup can tell which
  // cached entry the render just painted without any render-time mutation
  // (discarded concurrent renders and StrictMode replays never touch it).
  const committedScope = useRef<string | null>(null)
  useLayoutEffect(() => { committedScope.current = scope }, [scope])
  const dismissApproval = useCallback((id: string) => {
    setApprovals((prev) => prev.filter((row) => row.approvalId !== id))
  }, [])
  const dismissQuestion = useCallback((id: string) => {
    setQuestions((prev) => prev.filter((row) => row.questionId !== id))
  }, [])

  useEffect(() => {
    const cached = scope !== null ? cache.current.get(scope) : undefined
    let record: CachedStream = cached ?? { projector: createProjector(), compact: createEventCompactor(), events: EMPTY_EVENTS, items: EMPTY_ITEMS, cursor: 0, ready: false, weight: 0 }
    if (scope !== null) cache.current.delete(scope)
    seenSeq.current = record.cursor
    setLoadedScope(scope)
    setEvents(record.events)
    setItems(record.items)
    setSettled(false)
    setApprovals([])
    setQuestions([])
    setError(null)
    setStream(sessionId === null || workspaceId === null ? 'idle' : 'connecting')
    if (sessionId === null || workspaceId === null) return
    let disposed = false
    let frame = 0
    let pending: SseEvent[] = []
    const applyPending = (): void => {
      if (pending.length === 0) return
      const batch = pending
      pending = []
      record.items = record.projector.apply(batch)
      record.events = record.compact(batch)
      record.cursor = seenSeq.current
      // Conservative payload budget, including projector/event copies. Counting
      // only new batches avoids serializing the whole history on navigation.
      record.weight += JSON.stringify(batch).length * 4
    }
    const flush = (): void => {
      frame = 0
      if (disposed) return
      applyPending()
      setItems(record.items)
      setEvents(record.events)
    }
    const discardPending = (): void => {
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = 0
      pending = []
    }
    const dispose = subscribeEventsIn(workspaceId, sessionId, (envelope, frameCursor) => {
      if (disposed) return
      if (envelope.kind === 'question') {
        const { kind: _kind, ...row } = envelope
        setQuestions((prev) => prev.some((q) => q.questionId === row.questionId)
          ? prev.map((q) => q.questionId === row.questionId ? row : q)
          : [...prev, row])
        return
      }
      if (envelope.kind === 'question-settled') {
        setQuestions((prev) => prev.filter((q) => q.questionId !== envelope.questionId))
        return
      }
      if (envelope.kind === 'snapshot') {
        discardPending()
        // A fresh snapshot precedes the server's re-sent open questions.
        setQuestions([])
        record = { projector: createProjector(), compact: createEventCompactor(), events: EMPTY_EVENTS, items: EMPTY_ITEMS, cursor: 0, ready: true, weight: 0 }
        record.items = record.projector.apply(envelope.events)
        record.events = record.compact(envelope.events)
        record.weight = JSON.stringify(envelope.events).length * 4
        seenSeq.current = frameCursor ?? envelope.events.at(-1)?.seq ?? 0
        record.cursor = seenSeq.current
        setItems(record.items)
        setEvents(record.events)
        setApprovals(reconcileApprovals([], envelope.events))
        setSettled(true)
      } else if (envelope.kind === 'resume') {
        // Like a snapshot, a resume precedes the server's re-sent open
        // questions; one answered elsewhere while this tab was away must go.
        setQuestions([])
        const unseen = envelope.events.filter((event) => event.seq > seenSeq.current)
        for (const event of unseen) {
          seenSeq.current = event.seq
          pending.push(event)
        }
        seenSeq.current = Math.max(seenSeq.current, frameCursor ?? 0)
        record.ready = true
        record.cursor = seenSeq.current
        setApprovals((prev) => reconcileApprovals(prev, unseen))
        setSettled(true)
        if (pending.length > 0 && frame === 0) frame = requestAnimationFrame(flush)
      } else if (envelope.kind === 'session') {
        const { event } = envelope
        if (event.seq <= seenSeq.current) return
        seenSeq.current = event.seq
        pending.push(event)
        if (event.type === 'tool/result' || event.type === 'turn/end') {
          // A question's own tool result (or the turn ending) retires its card
          // even if the settled frame was missed.
          setQuestions((prev) => {
            if (prev.length === 0) return prev
            // Only this session's own questions: a child's card follows its own settled frame.
            const next = prev.filter((q) => q.childSessionId !== undefined || (event.type === 'turn/end' ? false : q.callId === '' || q.callId !== event.callId))
            return next.length === prev.length ? prev : next
          })
        }
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
    }, (state) => { if (!disposed) setStream(state) }, cached?.ready ? cached.cursor : undefined, { delegationsOnly })
    return () => {
      disposed = true
      dispose()
      applyPending()
      discardPending()
      if (scope !== null && record.ready && record.weight <= MAX_CACHE_WEIGHT) {
        cache.current.set(scope, record)
        // The committed target scope was already painted from its cached entry
        // and its new effect is about to claim (and remove) it, so it is a
        // handoff, not an inactive entry: it neither counts toward the limits
        // nor can be evicted by this insertion.
        const handoff = committedScope.current
        const inactive = [...cache.current].filter(([key]) => key !== handoff)
        let weight = inactive.reduce((total, [, row]) => total + row.weight, 0)
        let count = inactive.length
        for (const [key, row] of inactive) {
          if (count <= MAX_CACHE_ENTRIES && weight <= MAX_CACHE_WEIGHT) break
          cache.current.delete(key)
          count -= 1
          weight -= row.weight
        }
      }
    }
  }, [workspaceId, sessionId, scope, delegationsOnly])

  // Effects reset state after render. Fence synchronously so a new keyed
  // Transcript never mounts the previous conversation's expensive Markdown.
  const matches = loadedScope === scope
  const cached = scope !== null ? cache.current.get(scope) : undefined
  return {
    events: matches ? events : cached?.events ?? EMPTY_EVENTS,
    items: matches ? items : cached?.items ?? EMPTY_ITEMS,
    approvals: matches ? approvals : [], questions: matches ? questions : [],
    stream: matches ? stream : scope === null ? 'idle' as const : 'connecting' as const,
    error: matches ? error : null, dismissApproval, dismissQuestion,
    settled: matches && settled,
  }
}
