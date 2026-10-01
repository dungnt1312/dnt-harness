import { assertNever } from '../../kernel/index.ts'
import type { ExecutionId, StepId, TurnId } from '../../util/brand.ts'
import { isImageMediaType, type AttachmentLookup, type AttachmentRef } from '../attachments/store.ts'
import type { ContextManifest } from '../context/builder.ts'
import type { ContentPart, ModelMessage, ToolCall } from '../llm/types.ts'
import type { ModeDefinition } from '../modes/types.ts'

/** Fields the session itself stamps onto every appended event. */
interface SessionEventStamp {
  readonly seq: number
  readonly timestamp: number
}

/**
 * The controls actually in force for one model request: which model served
 * the step and through which provider. Recorded on the step's answer so the
 * log answers "what did this reply come from" without guessing.
 */
export interface RequestControls {
  readonly model?: string
  readonly provider?: string
}

/**
 * The durable session log vocabulary: everything the model saw or said —
 * including the tools it called and what they answered — plus the turn/step
 * structure, approval traffic, durable input acceptance, and session
 * metadata around it. Closed union — new durable facts extend this type
 * and every switch over it, ending in `assertNever`.
 */
export type SessionEvent =
  | ({ readonly type: 'turn/start'; readonly turnId: TurnId; readonly kind?: 'conversation' | 'delegation' } & SessionEventStamp)
  | ({ readonly type: 'turn/closing'; readonly turnId: TurnId } & SessionEventStamp)
  | ({ readonly type: 'user/message'; readonly turnId: TurnId; readonly content: string; readonly inputId?: string; readonly attachments?: readonly AttachmentRef[] } & SessionEventStamp)
  | ({ readonly type: 'step/start'; readonly turnId: TurnId; readonly stepId: StepId } & SessionEventStamp)
  | ({ readonly type: 'assistant/chunk'; readonly stepId: StepId; readonly delta: string; readonly thinking?: boolean } & SessionEventStamp)
  | ({ readonly type: 'assistant/message'; readonly stepId: StepId; readonly content: string; readonly toolCalls?: readonly ToolCall[]; readonly controls?: RequestControls } & SessionEventStamp)
  | ({ readonly type: 'tool/call'; readonly stepId: StepId; readonly executionId?: ExecutionId; readonly call: ToolCall; readonly policyRevision?: number } & SessionEventStamp)
  | ({
      readonly type: 'tool/result'
      readonly stepId: StepId
      readonly executionId?: ExecutionId
      readonly callId: string
      readonly ok: boolean
      readonly output: string
      /** Set on synthesized recovery records: the real outcome is unknown. */
      readonly recovery?: true
      /**
       * MCP-only structured outcome. Omitted for every non-MCP tool and for
       * legacy logs. `indeterminate` is not a failure and is never retried
       * automatically; `audit_fault` means the known outcome could not be
       * durably recorded and further MCP dispatch is blocked.
       */
      readonly outcome?: 'success' | 'error' | 'indeterminate' | 'audit_fault'
      /** MCP invocation id. A repeat is a new invocation, never a reused id. */
      readonly invocationId?: string
    } & SessionEventStamp)
  | ({ readonly type: 'step/end'; readonly turnId: TurnId; readonly stepId: StepId } & SessionEventStamp)
  | ({ readonly type: 'turn/end'; readonly turnId: TurnId; readonly reason: TurnEndReason } & SessionEventStamp)
  | ({ readonly type: 'turn/error'; readonly turnId: TurnId; readonly kind: TurnErrorKind; readonly message: string } & SessionEventStamp)
  | ({
      readonly type: 'approval/request'
      readonly approvalId: string
      readonly call: ToolCall
      readonly rootSessionId?: string
      readonly turnId?: TurnId
      readonly executionId?: ExecutionId
      /** Set when the call targets a path outside every granted folder. */
      readonly scopeWarning?: string
      /** The folder a session-scoped answer would grant (already validated). */
      readonly proposedGrant?: string
      /** The access that folder would get (the call's own read or write). */
      readonly proposedAccess?: 'read' | 'write'
    } & SessionEventStamp)
  | ({ readonly type: 'approval/decision'; readonly approvalId: string; readonly executionId?: ExecutionId; readonly decision: ApprovalDecision; readonly reason?: string } & SessionEventStamp)
  | ({ readonly type: 'input/queued'; readonly inputId: string; readonly clientRequestId?: string; readonly content: string; readonly attachments?: readonly AttachmentRef[] } & SessionEventStamp)
  | ({ readonly type: 'input/settled'; readonly inputId: string; readonly outcome: 'admitted' | 'rejected' | 'empty' } & SessionEventStamp)
  | ({ readonly type: 'session/title'; readonly title: string | null } & SessionEventStamp)
  | ({ readonly type: 'session/pinned'; readonly pinned: boolean } & SessionEventStamp)
  | ({ readonly type: 'session/project'; readonly projectId: string | null } & SessionEventStamp)
  | ({ readonly type: 'session/model'; readonly provider?: string | null; readonly model?: string | null; readonly thinkingLevel?: string | null } & SessionEventStamp)
  // The root's own live mode: a normalized snapshot, so a restart never
  // depends on the mode file still existing or holding the same content.
  // Last wins; `revision` increases per selection. Children resolve their
  // root's latest record — they never carry one of their own.
  | ({ readonly type: 'session/mode'; readonly modeId: string; readonly revision: number; readonly snapshot: ModeDefinition; readonly source: 'bundled' | 'workspace'; readonly hash: string } & SessionEventStamp)
  // Session-scoped folder grants for the file tools: a full replacement list,
  // last wins. `revision` increments per change so concurrent editors can
  // detect a stale view; `approvalId` names the approval that added a folder.
  | ({ readonly type: 'session/grants'; readonly revision: number; readonly roots: readonly SessionGrant[]; readonly approvalId?: string } & SessionEventStamp)
  // Child records: writers emit `brief`; `objective` is the legacy field older
  // logs carry, so readers take `brief ?? objective`. The inherit audit fields
  // record how much parent context a child received — never the text itself.
  | ({
      readonly type: 'session/child-meta'
      readonly parentSessionId: string
      readonly parentTurnId: string
      readonly definition: string
      readonly brief?: string
      readonly objective?: string
      readonly projectId?: string
      readonly inherit?: 'none' | 'brief'
      readonly inheritedHash?: string
      readonly inheritedChars?: number
    } & SessionEventStamp)
  | ({ readonly type: 'agent/child-spawn'; readonly childSessionId: string; readonly parentTurnId: string; readonly definition: string; readonly brief?: string; readonly objective?: string } & SessionEventStamp)
  | ({ readonly type: 'agent/child-result'; readonly childSessionId: string; readonly parentTurnId: string; readonly status: string; readonly error?: string } & SessionEventStamp)
  | ({ readonly type: 'mcp/call'; readonly server: string; readonly tool: string; readonly argsHash: string; readonly resultHash: string; readonly durationMs: number; readonly isError: boolean } & SessionEventStamp)
  | ({ readonly type: 'hook/run'; readonly event: string; readonly matcher: string; readonly exitCode: number | null; readonly durationMs: number; readonly decision: string } & SessionEventStamp)
  // Observability, not model content: the context manifest of the request this
  // step is about to send, recorded between `step/start` and the step's
  // answer. The trajectory reads it as "what this request carried"; model
  // projection ignores it.
  | ({ readonly type: 'context/manifest'; readonly turnId: TurnId; readonly manifest: ContextManifest } & SessionEventStamp)
  // The raw text of one assembled context block (system, compaction, parent
  // context, skill, skill catalog, memory), keyed by the sha256 of the exact
  // model-visible text. Recorded once per distinct hash per session — a body
  // the request already carried is never re-recorded. The `body` field name
  // (not `content`/`output`) keeps it out of the compaction size projection.
  | ({ readonly type: 'context/body'; readonly hash: string; readonly kind: 'system' | 'compaction' | 'parent-context' | 'skill' | 'skill-catalog' | 'memory'; readonly name?: string; readonly chars: number; readonly body: string } & SessionEventStamp)
  // Compaction lifecycle, log-only (DeepSeek-Harness-style): `start` opens the
  // transaction before the summarizer runs; `end` closes it after the
  // checkpoint is durable — with the summary body for immediate UI review, or
  // `error` for a failed attempt. A dangling start (crash mid-compaction)
  // stays visible as an unfinished transaction; there is never an end that
  // claims success without a checkpoint on disk. Model projection ignores both.
  | ({ readonly type: 'compaction/start'; readonly trigger: 'manual' | 'automatic'; readonly model?: string } & SessionEventStamp)
  | ({
      readonly type: 'compaction/end'
      readonly trigger: 'manual' | 'automatic'
      readonly model?: string
      readonly coversSeq: number
      readonly summaryChars: number
      readonly durationMs: number
      /** The full summary exactly as stored in the checkpoint; absent on failure. */
      readonly summary?: string
      /** Set on a failed attempt; no checkpoint was written. */
      readonly error?: string
    } & SessionEventStamp)
  // Background-process lifecycle, log-only (model projection ignores it):
  // a `Bash run_in_background` registration and its settled outcome. Pairs
  // are per process id; `interrupted` closes ids a restart left open.
  | ({ readonly type: 'process/start'; readonly processId: string; readonly command: string; readonly cwd: string; readonly turnId?: TurnId } & SessionEventStamp)
  | ({ readonly type: 'process/exit'; readonly processId: string; readonly exitCode: number | null; readonly termination: 'exited' | 'killed' | 'failed' | 'interrupted'; readonly durationMs: number } & SessionEventStamp)

/** Why a turn closed. */
export type TurnEndReason =
  | 'completed'
  | 'rejected'
  | 'empty'
  | 'failed'
  /** The user stopped the run; queued input stays queued. */
  | 'cancelled'
  /** The host restarted (or crashed) with the turn still open. */
  | 'interrupted'
  /** Legacy terminal reason retained so existing durable session logs remain readable. */
  | 'limit'

/** Durable classification of why a turn failed. */
export type TurnErrorKind = 'provider' | 'storage' | 'limit' | 'internal' | 'rejected'

/** How an approval request was settled. */
export type ApprovalDecision = 'allow' | 'deny' | 'expired' | 'cancelled' | 'invalidated'

/**
 * A user turn's model content. Images become image parts; text attachments are
 * inlined under their file name; an attachment the host could not load says so
 * in the text instead of vanishing, because a silent drop would let the model
 * answer as if the user never sent it.
 */
export function userMessageContent(
  text: string,
  refs: readonly AttachmentRef[] | undefined,
  loaded: AttachmentLookup | undefined,
): string | readonly ContentPart[] {
  if (refs === undefined || refs.length === 0) return text
  const parts: ContentPart[] = []
  const texts: string[] = text === '' ? [] : [text]
  for (const ref of refs) {
    const content = loaded?.get(ref.id)
    if (content === undefined) {
      texts.push(`[attachment "${ref.name}" (${ref.mediaType}) is not available]`)
      continue
    }
    if (isImageMediaType(content.mediaType) && content.base64 !== undefined) {
      parts.push({ type: 'image', mediaType: content.mediaType, base64: content.base64, name: ref.name })
      continue
    }
    if (content.text !== undefined) {
      const cut = content.truncated === true ? '\n[truncated]' : ''
      texts.push(`attachment "${ref.name}":\n\`\`\`\n${content.text}${cut}\n\`\`\``)
      continue
    }
    texts.push(`[attachment "${ref.name}" (${ref.mediaType}) could not be read]`)
  }
  const body = texts.join('\n\n')
  // Without an image the message stays a plain string: text-only requests must
  // keep the exact wire shape they had before attachments existed.
  if (parts.length === 0) return body
  return body === '' ? parts : [{ type: 'text', text: body }, ...parts]
}

/** Distributive Omit so the union stays a union after removing stamped fields. */
type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never

/** An event before stamping: what producers pass to `Session.append()`. */
export type SessionAppendedEvent = DistributiveOmit<SessionEvent, 'seq' | 'timestamp'>

/**
 * Project model history from the log: user, assistant (with its tool calls),
 * and tool results in order. Raw `assistant/chunk` events stay in the log
 * for replay and UI fidelity but never reach the model twice — the assembled
 * `assistant/message` is the durable fact, and each `tool/result` answers
 * the call its `callId` names. Recovery-synthesized results project like
 * real ones: their content says the outcome is unknown, and the `recovery`
 * flag keeps them distinguishable from original tool output.
 */
/**
 * A snapshot of the durable per-session model preference.
 *
 * `hasEvent` distinguishes a legacy log from a session that explicitly
 * configured or cleared a preference. In `session/model` events, omitted
 * fields leave the preceding value unchanged; `null` is an explicit clear and
 * remains `null` here as the session-owned blank (it never re-inherits a
 * workspace value).
 */
export interface SessionModel {
  readonly hasEvent: boolean
  readonly provider?: string | null
  readonly model?: string | null
  readonly thinkingLevel?: string | null
}

/**
 * Project per-field, last-wins model preferences from the immutable log.
 *
 * The returned object is a fresh snapshot. No event means `{ hasEvent: false }`;
 * an event with only omitted fields is still `{ hasEvent: true }`, which
 * preserves the distinction needed by callers resolving workspace defaults.
 */
export function deriveSessionModel(events: readonly SessionEvent[]): SessionModel {
  let hasEvent = false
  let provider: string | null | undefined
  let model: string | null | undefined
  let thinkingLevel: string | null | undefined
  for (const event of events) {
    if (event.type !== 'session/model') continue
    hasEvent = true
    if (event.provider !== undefined) provider = event.provider
    if (event.model !== undefined) model = event.model
    if (event.thinkingLevel !== undefined) thinkingLevel = event.thinkingLevel
  }
  return {
    hasEvent,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
  }
}

/** Alias kept for the name used in the plan. */
export const sessionModelOf = deriveSessionModel

/** One folder a session grants to its file tools. */
export interface SessionGrant {
  /** Absolute folder (realpath at grant time). */
  readonly path: string
  readonly access: 'read' | 'write'
}

/** The session's current folder grants and their revision (0 = never set). */
export interface SessionGrants {
  readonly revision: number
  readonly roots: readonly SessionGrant[]
}

/** Project the last `session/grants` event; the log is the only store. */
export function sessionGrantsOf(events: readonly SessionEvent[]): SessionGrants {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/grants') return { revision: event.revision, roots: event.roots }
  }
  return { revision: 0, roots: [] }
}

/** The root's latest durable mode snapshot, or undefined for a legacy log. */
export function sessionModeOf(events: readonly SessionEvent[]): Extract<SessionEvent, { type: 'session/mode' }> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'session/mode') return event
  }
  return undefined
}

export function deriveMessages(events: readonly SessionEvent[], attachments?: AttachmentLookup): ModelMessage[] {
  // Authorization hooks may rewrite a requested tool call. The durable
  // tool/call is the effective identity that actually crossed the side-effect
  // boundary, so model history must project it instead of stale provider args.
  const effectiveCalls = new Map<string, ToolCall[]>()
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const calls = effectiveCalls.get(event.stepId) ?? []
    calls.push(event.call)
    effectiveCalls.set(event.stepId, calls)
  }
  const messages: ModelMessage[] = []
  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        messages.push({ role: 'user', content: userMessageContent(event.content, event.attachments, attachments) })
        break
      case 'assistant/message':
        messages.push(
          event.toolCalls === undefined
            ? { role: 'assistant', content: event.content }
            : {
                role: 'assistant',
                content: event.content,
                toolCalls: event.toolCalls.map((call, index) => effectiveCalls.get(event.stepId)?.[index] ?? call),
              },
        )
        break
      case 'tool/result':
        messages.push({ role: 'tool', content: event.output, toolCallId: event.callId })
        break
      case 'turn/start':
      case 'turn/closing':
      case 'step/start':
      case 'assistant/chunk':
      case 'tool/call':
      case 'step/end':
      case 'turn/end':
      case 'turn/error':
      case 'approval/request':
      case 'approval/decision':
      case 'input/queued':
      case 'input/settled':
      case 'session/title':
      case 'session/pinned':
      case 'session/project':
      case 'session/model':
      case 'session/mode':
      case 'session/grants':
      case 'session/child-meta':
      case 'agent/child-spawn':
      case 'agent/child-result':
      case 'mcp/call':
      case 'hook/run':
      case 'context/manifest':
      case 'context/body':
      case 'compaction/start':
      case 'compaction/end':
      case 'process/start':
      case 'process/exit':
        break
      default:
        assertNever(event)
    }
  }
  return messages
}
