/**
 * What a running child is doing, derived from its live log alone. Advisory:
 * the parent model reads it to tell a slow child from a stuck one, the way
 * ZCode's subagent watchdog does on the host side. Stream thresholds mirror
 * the limits the request watchdog (`LogicalRequest`) already enforces, so
 * `stalled` means "the host is about to abort and retry that request".
 */
import type { SessionEvent } from '../session/events.ts'
import type { HarnessLimits } from '../limits.ts'

export type ChildHealth = 'active' | 'slow' | 'stalled' | 'awaiting-approval'
export interface ChildActivity { readonly kind: 'start' | 'model' | 'tool' | 'approval'; readonly name?: string; readonly sinceMs: number }
export interface ChildProgress {
  readonly elapsedMs: number
  readonly steps: number
  readonly toolCalls: number
  readonly lastActivity: ChildActivity
  readonly health: ChildHealth
}
export type ProgressLimits = Pick<HarnessLimits, 'streamFirstEventMs' | 'streamIdleMs' | 'bashMaxWaitMs'>

export function describeProgress(events: readonly SessionEvent[], startedAt: number, now: number, limits: ProgressLimits): ChildProgress {
  let steps = 0
  let toolCalls = 0
  let lastAt = startedAt
  const openTools = new Map<string, { readonly name: string; readonly at: number }>()
  const pendingApprovals = new Map<string, string>()
  let model: { readonly startedAt: number; progressAt?: number } | undefined
  for (const event of events) {
    lastAt = Math.max(lastAt, event.timestamp)
    switch (event.type) {
      case 'step/start': steps++; break
      case 'tool/call': toolCalls++; openTools.set(event.call.id, { name: event.call.name, at: event.timestamp }); break
      case 'tool/result': openTools.delete(event.callId); break
      case 'model/attempt': model = event.fact.state === 'start' ? { startedAt: event.timestamp } : undefined; break
      case 'assistant/chunk': if (model !== undefined) model.progressAt = event.timestamp; break
      case 'approval/request': pendingApprovals.set(event.approvalId, event.call.name); break
      case 'approval/decision': pendingApprovals.delete(event.approvalId); break
      default: break
    }
  }
  const base = { elapsedMs: Math.max(0, now - startedAt), steps, toolCalls }
  const approval = [...pendingApprovals.values()].at(-1)
  if (approval !== undefined) {
    return { ...base, lastActivity: { kind: 'approval', name: approval, sinceMs: Math.max(0, now - lastAt) }, health: 'awaiting-approval' }
  }
  let lastActivity: ChildActivity
  let threshold: number
  const tool = [...openTools.values()].at(-1)
  if (tool !== undefined) {
    // A tool is bounded by its own limits, not the model stream's.
    lastActivity = { kind: 'tool', name: tool.name, sinceMs: Math.max(0, now - tool.at) }
    threshold = limits.bashMaxWaitMs
  } else if (model !== undefined) {
    lastActivity = { kind: 'model', sinceMs: Math.max(0, now - (model.progressAt ?? model.startedAt)) }
    threshold = model.progressAt === undefined ? limits.streamFirstEventMs : limits.streamIdleMs
  } else {
    lastActivity = { kind: 'start', sinceMs: Math.max(0, now - lastAt) }
    threshold = limits.streamIdleMs
  }
  const health: ChildHealth = lastActivity.sinceMs >= threshold ? 'stalled' : lastActivity.sinceMs >= threshold / 2 ? 'slow' : 'active'
  return { ...base, lastActivity, health }
}
