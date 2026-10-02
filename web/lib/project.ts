import { isMcpOutcome, type AttachmentRef, type ContextManifestView, type SseEvent, type ToolCall } from './types.ts'
import { toolTarget } from './format.ts'
import { mcpServerOf } from './tool-facts.ts'

/** View items projected from the durable log — the UI's deriveMessages(). */
export type ViewItem =
  | {
      readonly kind: 'user'
      readonly content: string
      readonly ts?: number
      /** Files sent with the message; the transcript shows them as chips. */
      readonly attachments?: readonly AttachmentRef[]
      /** Queued input awaiting its consuming turn — flipped in place by the user/message sharing its inputId. */
      queued?: boolean
      /** The durable input id while queued; "Send now" and tests key on it. */
      inputId?: string
      /** Sent with Steer: it stops the running turn and runs next. */
      steer?: boolean
      /** Accepted but never reached the model (pre-step rejected it, or admitted nothing). */
      notSent?: 'rejected' | 'empty'
    }
  | {
      readonly kind: 'assistant'
      readonly content: string
      readonly live: boolean
      readonly ts?: number
      readonly thinking: readonly string[]
      readonly thinkingLive: boolean
      readonly toolCalls?: readonly ToolCall[]
      /** What actually served this step; the workspace model is only a fallback. */
      controls?: { readonly model?: string; readonly provider?: string }
      /** Turn this answer belongs to; absent on legacy events. */
      readonly turnId?: string
      /** True while the owning turn is still open — the turn footer waits for it to close. */
      turnOpen?: boolean
    }
  | {
      readonly kind: 'tool'
      readonly call: ToolCall
      readonly ts?: number
      doneAt?: number
      result?: { readonly ok: boolean; readonly output: string }
      /** Recovery-synthesized result: the real outcome is unknown. */
      recovered?: boolean
      /** `mcp__<server>__<tool>` calls carry their server for the chip. */
      server?: string
      /** MCP structured outcome. Absent for non-MCP tools. */
      outcome?: 'success' | 'error' | 'indeterminate' | 'audit_fault'
      /** MCP invocation id, when the result carried one. */
      invocationId?: string
    }
  | {
      readonly kind: 'delegation'
      readonly childSessionId: string
      readonly definition: string
      /** The child's brief (legacy logs: its objective). */
      readonly brief: string
      readonly ts?: number
      status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
    }
  | { readonly kind: 'audit'; readonly ts?: number; readonly icon: 'block' | 'fail' | 'allow' | 'deny' | 'expired'; readonly text: string; readonly durationMs?: number }
  | {
      readonly kind: 'status'
      readonly reason: string
      /**
       * On a turn/error: what Retry resends — the failed turn's own input,
       * never "the newest user message" — and whether tools already ran in
       * it (a retry could repeat their side effects).
       */
      retry?: RetryTarget
    }
  | {
      readonly kind: 'compaction'
      readonly ts?: number
      /** running: start without end yet; completed/failed: end recorded; interrupted: dangling start the log moved past. */
      status: 'running' | 'completed' | 'failed' | 'interrupted'
      trigger?: 'manual' | 'automatic'
      model?: string
      coversSeq?: number
      summaryChars?: number
      durationMs?: number
      /** The stored summary, carried by a successful compaction/end. */
      summary?: string
      error?: string
    }
  | {
      readonly kind: 'context'
      readonly ts?: number
      /** What the turn's latest model request carried (updated in place per request). */
      manifest: ContextManifestView
      /** Requests this turn has made so far; the item is one per turn, not per request. */
      requests?: number
    }

/** One user input as Retry must resend it. */
export interface RetryInput {
  readonly content: string
  readonly attachments?: readonly AttachmentRef[]
}

/** The inputs of a failed turn (a turn may batch several), oldest first. */
export interface RetryTarget {
  /** Stable across re-projection (the failure's log seq): keys retry request ids. */
  readonly key: string
  readonly inputs: readonly RetryInput[]
  /** A tool call was recorded in the failed turn before it failed. */
  readonly toolsRan: boolean
}

interface AssistantDraft {
  kind: 'assistant'
  content: string
  live: boolean
  ts?: number
  thinking: string[]
  thinkingLive: boolean
  toolCalls?: readonly ToolCall[]
  controls?: { readonly model?: string; readonly provider?: string }
  turnId?: string
  turnOpen?: boolean
}

const DECISION_LABELS: Readonly<Record<string, string>> = {
  expired: 'Expired · no decision recorded',
  cancelled: 'Cancelled · no decision recorded',
  invalidated: 'Invalidated · no decision recorded',
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
}

/** Preserve row identity across log projections without sharing mutable drafts. */
export function shareProjectedItems(previous: readonly ViewItem[], next: ViewItem[]): readonly ViewItem[] {
  let unchanged = previous.length === next.length
  const shared = next.map((item, index) => {
    const old = previous[index]
    if (old !== undefined && sameValue(old, item)) return old
    unchanged = false
    return item
  })
  return unchanged ? previous : shared
}

function retryInputOf(event: SseEvent): RetryInput {
  return {
    content: event.content ?? '',
    ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
  }
}

/** Project durable events into messages, tool rows, delegations, and status. */
export function projectItems(events: readonly SseEvent[]): ViewItem[] {
  return [...createProjector().apply(events)]
}

export function createProjector(): { apply(events: readonly SseEvent[]): readonly ViewItem[] } {
  const items: ViewItem[] = []
  const toolItems = new Map<string, Extract<ViewItem, { kind: 'tool' }>>()
  const queuedUsers = new Map<string, Extract<ViewItem, { kind: 'user' }>>()
  const delegations = new Map<string, Extract<ViewItem, { kind: 'delegation' }>>()
  const approvals = new Map<string, ToolCall>()
  let draft: AssistantDraft | null = null
  let openTurnId: string | undefined
  const turnAssistants = new Map<string, Array<Extract<ViewItem, { kind: 'assistant' }>>>()
  /** One context marker per turn: the latest request's manifest, updated in place. */
  const turnContexts = new Map<string, Extract<ViewItem, { kind: 'context' }>>()
  /** The compaction awaiting its end event; null while none is open. */
  let openCompaction: Extract<ViewItem, { kind: 'compaction' }> | null = null
  /** Every accepted input by id, so a turn that never logs user/message can still be retried. */
  const acceptedInputs = new Map<string, RetryInput>()
  /** The open turn's own inputs and whether it recorded a tool call. */
  let turnInputs: RetryInput[] = []
  let turnLegacyInputs: RetryInput[] = []
  const turnInputIds = new Set<string>()
  let turnToolsRan = false

  let published: readonly ViewItem[] = []
  const indexes = new WeakMap<object, number>()
  const dirty = new Set<number>()
  const touch = (item: ViewItem): void => {
    const index = indexes.get(item)
    if (index !== undefined) dirty.add(index)
  }
  const add = (item: ViewItem): void => {
    indexes.set(item, items.length)
    dirty.add(items.length)
    items.push(item)
  }

  /** Register an answer under its open turn so `turn/end` can close it in place. */
  const trackAssistant = (item: Extract<ViewItem, { kind: 'assistant' }>): void => {
    if (item.turnId === undefined) return
    const tracked = turnAssistants.get(item.turnId)
    if (tracked !== undefined) tracked.push(item)
    else turnAssistants.set(item.turnId, [item])
  }

  const apply = (events: readonly SseEvent[]): readonly ViewItem[] => {
    for (const event of events) {
      // A log that moves on without the open compaction's end means the
      // compaction never finished (crash mid-summarizer); the interrupted
      // label stays honest until a real end corrects it in place.
      if (openCompaction !== null && openCompaction.status === 'running' && event.type !== 'compaction/end') {
        touch(openCompaction)
        openCompaction.status = 'interrupted'
      }
      switch (event.type) {
        case 'turn/start':
          if (event.turnId !== undefined && event.turnId !== '') openTurnId = event.turnId
          turnInputs = []
          turnLegacyInputs = []
          turnInputIds.clear()
          turnToolsRan = false
          break
        case 'user/message': {
          if (event.content === undefined) break
          if (event.inputId !== undefined && event.inputId !== '') {
            // Retry resends what the user typed, not a hook's rewrite of it.
            if (!turnInputIds.has(event.inputId)) {
              turnInputIds.add(event.inputId)
              turnInputs.push(acceptedInputs.get(event.inputId) ?? retryInputOf(event))
            }
          } else {
            // Legacy logs carry no ids; hook-injected context carries none
            // either, so these only count when no accepted input does.
            turnLegacyInputs.push(retryInputOf(event))
          }
          const pending = event.inputId !== undefined && event.inputId !== '' ? queuedUsers.get(event.inputId) : undefined
          if (pending !== undefined && event.inputId !== undefined) {
            // The queued bubble becomes the real message at the same position.
            touch(pending)
            pending.queued = false
            delete pending.inputId
            delete pending.steer
            queuedUsers.delete(event.inputId)
            break
          }
          add({
            kind: 'user',
            content: event.content,
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
          })
          break
        }
        case 'input/queued': {
          if (event.inputId === undefined || event.inputId === '' || event.content === undefined) break
          const item: Extract<ViewItem, { kind: 'user' }> = {
            kind: 'user',
            content: event.content,
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            ...(event.attachments !== undefined && event.attachments.length > 0 ? { attachments: event.attachments } : {}),
            queued: true,
            inputId: event.inputId,
            ...(event.delivery === 'steer' ? { steer: true } : {}),
          }
          acceptedInputs.set(event.inputId, retryInputOf(event))
          queuedUsers.set(event.inputId, item)
          add(item)
          break
        }
        case 'input/settled': {
          if (event.inputId === undefined || event.inputId === '') break
          const settled = event.outcome
          // Every settled input belongs to the turn that claimed it — also a
          // rejected/empty one (no user/message at all) and an admitted one a
          // hook rewrote wholesale (its user/message carries no id). Retry
          // resends what the user typed, never a hook's rewrite.
          if (!turnInputIds.has(event.inputId)) {
            const accepted = acceptedInputs.get(event.inputId)
            if (accepted !== undefined) {
              turnInputIds.add(event.inputId)
              turnInputs.push(accepted)
            }
          }
          const pending = queuedUsers.get(event.inputId)
          if (pending === undefined) break
          // The input is terminal either way: it no longer waits in the queue.
          touch(pending)
          pending.queued = false
          delete pending.inputId
          delete pending.steer
          if (settled === 'rejected' || settled === 'empty') pending.notSent = settled
          queuedUsers.delete(event.inputId)
          break
        }
        case 'assistant/chunk':
          if (event.delta === undefined) break
          if (draft === null) {
            draft = {
              kind: 'assistant', content: '', live: true, thinking: [], thinkingLive: false,
              ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
              ...(openTurnId !== undefined ? { turnId: openTurnId, turnOpen: true } : {}),
            }
            add(draft)
            trackAssistant(draft)
          }
          touch(draft)
          if (event.thinking === true) {
            draft.thinking.push(event.delta)
            draft.thinkingLive = true
          } else {
            draft.content += event.delta
            draft.thinkingLive = false
          }
          break
        case 'assistant/message': {
          const content = event.content ?? ''
          const controls = event.controls !== undefined
            ? {
                ...(event.controls.model !== undefined ? { model: event.controls.model } : {}),
                ...(event.controls.provider !== undefined ? { provider: event.controls.provider } : {}),
              }
            : undefined
          if (draft !== null) {
            touch(draft)
            if (content !== '') draft.content = content
            draft.live = false
            draft.thinkingLive = false
            if (event.toolCalls !== undefined) draft.toolCalls = event.toolCalls
            if (controls !== undefined) draft.controls = controls
            draft = null
          } else if (content !== '' || event.toolCalls !== undefined) {
            const item: Extract<ViewItem, { kind: 'assistant' }> = {
              kind: 'assistant',
              content,
              live: false,
              thinking: [],
              thinkingLive: false,
              ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
              ...(event.toolCalls !== undefined ? { toolCalls: event.toolCalls } : {}),
              ...(controls !== undefined ? { controls } : {}),
              ...(openTurnId !== undefined ? { turnId: openTurnId, turnOpen: true } : {}),
            }
            add(item)
            trackAssistant(item)
          }
          break
        }
        case 'tool/call': {
          if (event.call === undefined) break
          turnToolsRan = true
          const server = mcpServerOf(event.call.name)
          const item: Extract<ViewItem, { kind: 'tool' }> = {
            kind: 'tool',
            call: event.call,
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            ...(server !== undefined ? { server } : {}),
          }
          toolItems.set(event.call.id, item)
          add(item)
          break
        }
        case 'tool/result': {
          const item = event.callId === undefined ? undefined : toolItems.get(event.callId)
          if (item !== undefined) {
            touch(item)
            item.result = { ok: event.ok === true, output: event.output ?? '' }
            if (event.timestamp !== undefined) item.doneAt = event.timestamp
            if (event.recovery === true) item.recovered = true
            if (isMcpOutcome(event.outcome)) item.outcome = event.outcome
            if (event.invocationId !== undefined) item.invocationId = event.invocationId
          }
          break
        }
        case 'approval/request':
          if (event.approvalId !== undefined && event.call !== undefined) approvals.set(event.approvalId, event.call)
          break
        case 'approval/decision': {
          const decision = event.decision ?? ''
          if (decision === 'allow' || decision === 'deny') {
            const call = event.approvalId !== undefined ? approvals.get(event.approvalId) : undefined
            const target = call !== undefined ? toolTarget(call.args) : ''
            const text = `${decision === 'allow' ? 'Allowed' : 'Denied'} · ${call?.name ?? 'unknown tool'}${target !== '' ? ` · ${target}` : ''}`
            add({ kind: 'audit', icon: decision, text, ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}) })
          } else if (DECISION_LABELS[decision] !== undefined) {
            add({ kind: 'audit', icon: 'expired', text: DECISION_LABELS[decision]!, ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}) })
          }
          break
        }
        case 'hook/run': {
          const decision = event.decision ?? ''
          if (decision === 'block') {
            add({
              kind: 'audit',
              icon: 'block',
              text: `hook blocked · ${event.event ?? 'hook'} · ${event.matcher ?? ''}`,
              ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            })
          } else if (decision.startsWith('failure:')) {
            add({
              kind: 'audit',
              icon: 'fail',
              text: `hook failed · ${event.event ?? 'hook'} · ${event.matcher ?? ''} (${decision.slice('failure:'.length)})`,
              ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
              ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
            })
          }
          break
        }
        case 'agent/child-spawn': {
          if (event.childSessionId === undefined) break
          const item: Extract<ViewItem, { kind: 'delegation' }> = {
            kind: 'delegation',
            childSessionId: event.childSessionId,
            definition: event.definition ?? '',
            brief: event.brief ?? event.objective ?? '',
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            status: 'running',
          }
          delegations.set(event.childSessionId, item)
          add(item)
          break
        }
        case 'agent/child-result': {
          if (event.childSessionId === undefined) break
          let item = delegations.get(event.childSessionId)
          if (item === undefined) {
            item = {
              kind: 'delegation',
              childSessionId: event.childSessionId,
              definition: event.definition ?? '',
              brief: event.brief ?? event.objective ?? '',
              ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
              status: 'running',
            }
            delegations.set(event.childSessionId, item)
            add(item)
          }
          const status = event.status
          touch(item)
          if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') item.status = status
          break
        }
        case 'context/manifest': {
          if (event.manifest === undefined) break
          // A tool loop makes one request per step: folding into the turn's
          // single marker keeps the transcript quiet while the collapsed line
          // and the expanded manifest always describe the LATEST request.
          const key = openTurnId ?? 'turnless'
          const existing = turnContexts.get(key)
          if (existing !== undefined) {
            touch(existing)
            existing.manifest = event.manifest
            existing.requests = (existing.requests ?? 1) + 1
            break
          }
          const item: Extract<ViewItem, { kind: 'context' }> = {
            kind: 'context',
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            manifest: event.manifest,
            requests: 1,
          }
          turnContexts.set(key, item)
          add(item)
          break
        }
        case 'compaction/start': {
          const item: Extract<ViewItem, { kind: 'compaction' }> = {
            kind: 'compaction',
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            status: 'running',
            ...(event.trigger !== undefined ? { trigger: event.trigger } : {}),
            ...(event.model !== undefined ? { model: event.model } : {}),
          }
          openCompaction = item
          add(item)
          break
        }
        case 'compaction/end': {
          const patch = (item: Extract<ViewItem, { kind: 'compaction' }>): void => {
            touch(item)
            item.status = event.error !== undefined ? 'failed' : 'completed'
            if (event.trigger !== undefined) item.trigger = event.trigger
            if (event.model !== undefined) item.model = event.model
            if (event.coversSeq !== undefined) item.coversSeq = event.coversSeq
            if (event.summaryChars !== undefined) item.summaryChars = event.summaryChars
            if (event.durationMs !== undefined) item.durationMs = event.durationMs
            if (event.summary !== undefined) item.summary = event.summary
            if (event.error !== undefined) item.error = event.error
          }
          if (openCompaction !== null) {
            patch(openCompaction)
            openCompaction = null
            break
          }
          // An end without a surviving start (truncated replay): still the
          // durable outcome, just rendered without a live phase.
          const item: Extract<ViewItem, { kind: 'compaction' }> = {
            kind: 'compaction',
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            status: 'running',
          }
          patch(item)
          add(item)
          break
        }
        case 'turn/error':
          if (event.message !== undefined) {
            const inputs = turnInputs.length > 0 ? turnInputs : turnLegacyInputs
            add({
              kind: 'status',
              reason: `${event.kind ?? 'error'}: ${event.message}`,
              // A deterministic policy rejection would only be rejected again:
              // the bubble says Not sent and Reuse puts the text back instead.
              ...(inputs.length > 0 && event.kind !== 'rejected'
                ? { retry: { key: `seq-${event.seq}`, inputs: [...inputs], toolsRan: turnToolsRan } }
                : {}),
            })
          }
          break
        case 'turn/end':
          if (draft !== null) { touch(draft); draft.live = false; draft.thinkingLive = false; draft = null }
          {
            const closedId = event.turnId !== undefined && event.turnId !== '' ? event.turnId : openTurnId
            if (closedId !== undefined) {
              for (const item of turnAssistants.get(closedId) ?? []) { touch(item); item.turnOpen = false }
              turnAssistants.delete(closedId)
              turnContexts.delete(closedId)
            }
            openTurnId = undefined
          }
          for (const item of delegations.values()) {
            if (item.status === 'running') { touch(item); item.status = 'interrupted' }
          }
          if (event.reason !== undefined) {
            add({ kind: 'status', reason: event.reason })
          }
          break
        default:
          break
      }
    }
    if (dirty.size === 0) return published
    const next = [...published]
    for (const index of dirty) {
      const item = items[index]!
      next[index] = item.kind === 'assistant' ? { ...item, thinking: [...item.thinking] } : { ...item }
    }
    dirty.clear()
    published = next
    return published
  }
  return { apply }
}

/**
 * Whether a turn is currently in flight: every `turn/start` is closed by a
 * `turn/end`; an unmatched start means the agent is still working. The Stop
 * button and activity indicators read this.
 */
export type TaskPhase = 'idle' | 'preparing' | 'held' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'steered' | 'rejected' | 'empty' | 'limit'

const TERMINAL_PHASES: ReadonlySet<string> = new Set(['completed', 'interrupted', 'cancelled', 'steered', 'rejected', 'empty', 'limit'])

/** Connection loss is not a terminal outcome. Only durable events close work. */
export function taskPhase(events: readonly SseEvent[], pendingApprovals = 0, sending = false): TaskPhase {
  if (isTurnRunning(events)) return pendingApprovals > 0 ? 'waiting' : 'running'
  const queued = new Set<string>()
  let phase: TaskPhase = 'idle'
  for (const event of events) {
    if (event.type === 'input/queued' && event.inputId) queued.add(event.inputId)
    if (event.type === 'user/message' && event.inputId) queued.delete(event.inputId)
    // Rejected or empty input is terminal too: it must not hold "preparing".
    if (event.type === 'input/settled' && event.inputId) queued.delete(event.inputId)
    if (event.type === 'turn/end') {
      const reason = event.reason
      phase = reason !== undefined && TERMINAL_PHASES.has(reason) ? reason as TaskPhase : 'failed'
    }
  }
  if (sending) return 'preparing'
  // After a stop or a restart nothing runs queued input on its own: that is
  // a resting state ("held"), not work in progress — no spinner.
  if (queued.size > 0) return phase === 'cancelled' || phase === 'interrupted' ? 'held' : 'preparing'
  return phase
}

export function isTurnRunning(events: readonly SseEvent[]): boolean {
  let open = 0
  for (const event of events) {
    if (event.type === 'turn/start') open += 1
    else if (event.type === 'turn/end') open = Math.max(0, open - 1)
  }
  return open > 0
}
