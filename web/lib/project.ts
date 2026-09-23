import type { AttachmentRef, SseEvent, ToolCall } from './types.ts'
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
  | { readonly kind: 'status'; readonly reason: string }

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

/**
 * Project render items from the durable log. Streaming chunks accumulate
 * into the in-flight assistant item (mutated as chunks arrive); thinking
 * chunks fill `thinking` without touching `content`. `assistant/message`
 * finalizes the item and records the controls that served it. Each
 * `tool/result` answers the call its `callId` names; a `recovery: true`
 * result flags the row as recovered. `agent/child-spawn` → `agent/
 * child-result` project to one delegation card (a parent turn that ends
 * first marks it interrupted). Hooks surface only when blocking or failing;
 * approval decisions correlate their request by id. Answers carry their
 * `turnId` and stay `turnOpen` until the matching `turn/end` so the
 * transcript can place one footer per turn. Structural events are
 * skipped; non-`completed` turn ends surface as status lines.
 */
export function projectItems(events: readonly SseEvent[]): ViewItem[] {
  const items: ViewItem[] = []
  const toolItems = new Map<string, Extract<ViewItem, { kind: 'tool' }>>()
  const queuedUsers = new Map<string, Extract<ViewItem, { kind: 'user' }>>()
  const delegations = new Map<string, Extract<ViewItem, { kind: 'delegation' }>>()
  const approvals = new Map<string, ToolCall>()
  let draft: AssistantDraft | null = null
  let openTurnId: string | undefined
  const turnAssistants = new Map<string, Array<Extract<ViewItem, { kind: 'assistant' }>>>()

  /** Register an answer under its open turn so `turn/end` can close it in place. */
  const trackAssistant = (item: Extract<ViewItem, { kind: 'assistant' }>): void => {
    if (item.turnId === undefined) return
    const tracked = turnAssistants.get(item.turnId)
    if (tracked !== undefined) tracked.push(item)
    else turnAssistants.set(item.turnId, [item])
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        if (event.turnId !== undefined && event.turnId !== '') openTurnId = event.turnId
        break
      case 'user/message': {
        if (event.content === undefined) break
        const pending = event.inputId !== undefined && event.inputId !== '' ? queuedUsers.get(event.inputId) : undefined
        if (pending !== undefined && event.inputId !== undefined) {
          // The queued bubble becomes the real message at the same position.
          pending.queued = false
          queuedUsers.delete(event.inputId)
          break
        }
        items.push({
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
        }
        queuedUsers.set(event.inputId, item)
        items.push(item)
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
          items.push(draft)
          trackAssistant(draft)
        }
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
          items.push(item)
          trackAssistant(item)
        }
        break
      }
      case 'tool/call': {
        if (event.call === undefined) break
        const server = mcpServerOf(event.call.name)
        const item: Extract<ViewItem, { kind: 'tool' }> = {
          kind: 'tool',
          call: event.call,
          ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
          ...(server !== undefined ? { server } : {}),
        }
        toolItems.set(event.call.id, item)
        items.push(item)
        break
      }
      case 'tool/result': {
        const item = event.callId === undefined ? undefined : toolItems.get(event.callId)
        if (item !== undefined) {
          item.result = { ok: event.ok === true, output: event.output ?? '' }
          if (event.timestamp !== undefined) item.doneAt = event.timestamp
          if (event.recovery === true) item.recovered = true
          if (event.outcome !== undefined) item.outcome = event.outcome
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
          items.push({ kind: 'audit', icon: decision, text, ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}) })
        } else if (DECISION_LABELS[decision] !== undefined) {
          items.push({ kind: 'audit', icon: 'expired', text: DECISION_LABELS[decision]!, ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}) })
        }
        break
      }
      case 'hook/run': {
        const decision = event.decision ?? ''
        if (decision === 'block') {
          items.push({
            kind: 'audit',
            icon: 'block',
            text: `hook blocked · ${event.event ?? 'hook'} · ${event.matcher ?? ''}`,
            ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
            ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          })
        } else if (decision.startsWith('failure:')) {
          items.push({
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
        items.push(item)
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
          items.push(item)
        }
        const status = event.status
        if (status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted') item.status = status
        break
      }
      case 'turn/error':
        if (event.message !== undefined) {
          items.push({ kind: 'status', reason: `${event.kind ?? 'error'}: ${event.message}` })
        }
        break
      case 'turn/end':
        if (draft !== null) { draft.live = false; draft.thinkingLive = false; draft = null }
        {
          const closedId = event.turnId !== undefined && event.turnId !== '' ? event.turnId : openTurnId
          if (closedId !== undefined) {
            for (const item of turnAssistants.get(closedId) ?? []) item.turnOpen = false
            turnAssistants.delete(closedId)
          }
          openTurnId = undefined
        }
        for (const item of delegations.values()) {
          if (item.status === 'running') item.status = 'interrupted'
        }
        if (event.reason !== undefined) {
          items.push({ kind: 'status', reason: event.reason })
        }
        break
      default:
        break
    }
  }
  return items
}

/**
 * Whether a turn is currently in flight: every `turn/start` is closed by a
 * `turn/end`; an unmatched start means the agent is still working. The Stop
 * button and activity indicators read this.
 */
export type TaskPhase = 'idle' | 'preparing' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'rejected' | 'empty' | 'limit'

/** Connection loss is not a terminal outcome. Only durable events close work. */
export function taskPhase(events: readonly SseEvent[], pendingApprovals = 0, sending = false): TaskPhase {
  if (isTurnRunning(events)) return pendingApprovals > 0 ? 'waiting' : 'running'
  const queued = new Set<string>()
  let phase: TaskPhase = 'idle'
  for (const event of events) {
    if (event.type === 'input/queued' && event.inputId) queued.add(event.inputId)
    if (event.type === 'user/message' && event.inputId) queued.delete(event.inputId)
    if (event.type === 'turn/end') {
      const reason = event.reason
      phase = reason === 'completed' || reason === 'interrupted' || reason === 'cancelled' || reason === 'rejected' || reason === 'empty' || reason === 'limit' ? reason : 'failed'
    }
  }
  return sending || queued.size > 0 ? 'preparing' : phase
}

export function isTurnRunning(events: readonly SseEvent[]): boolean {
  let open = 0
  for (const event of events) {
    if (event.type === 'turn/start') open += 1
    else if (event.type === 'turn/end') open = Math.max(0, open - 1)
  }
  return open > 0
}
