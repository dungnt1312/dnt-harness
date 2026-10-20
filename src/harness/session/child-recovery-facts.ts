import type { ChildRecoveryFacts, ChildRunState } from '../storage/file-session-store.ts'
import type { SessionEvent } from './events.ts'

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted'])

/**
 * Derive the child-recovery facts of one log in a single forward pass. They
 * mirror what boot recovery reads from canonical logs: the newest child-meta
 * and project binding, which spawns this log committed, each child's current
 * run result (the newest result after its newest spawn/resume), and whether
 * the child's report was queued after that result. A value recovery would
 * read differently from a well-formed one is left out, never guessed.
 */
export function childRecoveryFacts(events: readonly SessionEvent[]): ChildRecoveryFacts {
  let meta: ChildRecoveryFacts['meta'] = null
  let metaWellFormed = true
  let bound: string | null = null
  let boundWellFormed = true
  const committed = new Set<string>()
  const results = new Map<string, { readonly status: unknown; readonly seq: number } | undefined>()
  const lastReport = new Map<string, number>()
  for (const event of events) {
    switch (event.type) {
      case 'session/child-meta': {
        const projectId: unknown = event.projectId
        metaWellFormed = projectId === undefined || typeof projectId === 'string'
        meta = { background: event.background === true, projectId: typeof projectId === 'string' ? projectId : null }
        break
      }
      case 'session/project': {
        const projectId: unknown = event.projectId
        boundWellFormed = projectId === null || typeof projectId === 'string'
        bound = typeof projectId === 'string' ? projectId : null
        break
      }
      case 'agent/child-spawn':
        committed.add(event.childSessionId)
        results.set(event.childSessionId, undefined)
        break
      case 'agent/child-resume':
        results.set(event.childSessionId, undefined)
        break
      case 'agent/child-result':
        results.set(event.childSessionId, { status: event.status, seq: event.seq })
        break
      case 'input/queued':
        if (event.origin === 'child' && typeof event.childSessionId === 'string') {
          lastReport.set(event.childSessionId, Math.max(lastReport.get(event.childSessionId) ?? -Infinity, event.seq))
        }
        break
      default:
        break
    }
  }
  const children: Record<string, ChildRunState> = {}
  for (const id of committed) {
    const result = results.get(id)
    children[id] = result === undefined || typeof result.status !== 'string' || !TERMINAL_STATUSES.has(result.status)
      ? 'open'
      : (lastReport.get(id) ?? -Infinity) > result.seq ? 'reported' : 'settled'
  }
  return {
    ...(metaWellFormed ? { meta } : {}),
    ...(boundWellFormed ? { boundProjectId: bound } : {}),
    children,
  }
}
