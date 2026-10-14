import { toProjectRelative } from './project-paths.ts'
import { toolFacts } from './tool-facts.ts'
import type { SseEvent } from './types.ts'

/**
 * Which project files the agent's own Edit/Write calls changed, read from the
 * session log. An open file viewer watches its entry: a rising number means the
 * file on disk may have moved under it, and the viewer then compares hashes
 * before it acts, so a replayed or redundant signal costs one read and nothing
 * else. Writes made by Bash or by other programs leave no record in the log,
 * so they are not seen here.
 */
export interface AgentWrites {
  /** The session the scan belongs to; another session starts over. */
  readonly key: string | null
  readonly root: string | null
  /** Events already read; the log only grows, so the next scan starts here. */
  readonly scanned: number
  /** Edit/Write calls waiting for their result: call id → project-relative path. */
  readonly pending: ReadonlyMap<string, string>
  /** Project-relative path → seq of the latest landed write. */
  readonly writes: Readonly<Record<string, number>>
}

export const NO_AGENT_WRITES: AgentWrites = { key: null, root: null, scanned: 0, pending: new Map(), writes: {} }

const WRITERS = new Set(['edit', 'write'])

/**
 * Folds the events past `previous.scanned` into the tracker. Returns the same
 * object when nothing new arrived, so a consumer comparing by identity
 * re-renders only when a write landed.
 */
export function trackAgentWrites(previous: AgentWrites, events: readonly SseEvent[], key: string | null, root: string | null): AgentWrites {
  // A different session or project, or a log that shrank (it was replaced), starts over.
  const restart = previous.key !== key || previous.root !== root || events.length < previous.scanned
  const base: AgentWrites = restart ? { ...NO_AGENT_WRITES, key, root } : previous
  if (events.length === base.scanned) return base

  let pending: Map<string, string> | null = null
  let writes: Record<string, number> | null = null
  for (let index = base.scanned; index < events.length; index += 1) {
    const event = events[index]!
    if (event.type === 'tool/call' && event.call !== undefined && root !== null && WRITERS.has(event.call.name.toLowerCase())) {
      const path = toolFacts(event.call).path
      const relative = path === undefined ? null : toProjectRelative(root, path)
      if (relative !== null) (pending ??= new Map(base.pending)).set(event.call.id, relative)
    } else if (event.type === 'tool/result' && event.callId !== undefined) {
      const relative = (pending ?? base.pending).get(event.callId)
      if (relative === undefined) continue
      pending ??= new Map(base.pending)
      pending.delete(event.callId)
      if (event.ok === true) (writes ??= { ...base.writes })[relative] = event.seq
    }
  }
  return { key, root, scanned: events.length, pending: pending ?? base.pending, writes: writes ?? base.writes }
}
