/** Pure derivation of Environment-panel rows from the session event log. */
import type { ChildRow, SseEvent } from './types.ts'

/** One non-empty line, markdown heading marks dropped — the same title rule the transcript's DelegationCard applies. */
function briefLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  return line.replace(/^#+\s*/, '').replace(/\*\*/g, '')
}

export interface ProcessRow {
  readonly id: string
  readonly command: string
  readonly status: 'running' | 'exited' | 'killed' | 'failed' | 'interrupted'
  readonly exitCode: number | null
  readonly startedAt: number
  readonly durationMs: number
}

export function processRows(events: readonly SseEvent[]): readonly ProcessRow[] {
  const rows = new Map<string, ProcessRow>()
  for (const event of events) {
    if (event.type === 'process/start' && event.processId !== undefined) {
      rows.set(event.processId, { id: event.processId, command: event.command ?? '', status: 'running', exitCode: null, startedAt: event.timestamp ?? 0, durationMs: 0 })
    } else if (event.type === 'process/exit' && event.processId !== undefined) {
      const row = rows.get(event.processId)
      if (row === undefined) continue
      rows.set(event.processId, { ...row, status: (event.termination as ProcessRow['status']) ?? 'exited', exitCode: event.exitCode ?? null, durationMs: event.durationMs ?? 0 })
    }
  }
  return [...rows.values()]
}

export interface SubagentRow {
  readonly childSessionId: string
  readonly definition: string
  /** First line of the child's brief — the row's title; empty when the spawn carried none. */
  readonly brief: string
  readonly running: boolean
  readonly status?: string
  /** Wall-clock dispatch time of the spawn; 0 on legacy events without one. */
  readonly dispatchedAt: number
  /** Wall-clock the child settled at, when the result event carried one. */
  readonly endedAt?: number
}

export function subagentRows(events: readonly SseEvent[]): readonly SubagentRow[] {
  const rows = new Map<string, SubagentRow>()
  for (const event of events) {
    if (event.type === 'agent/child-spawn' && event.childSessionId !== undefined) {
      rows.set(event.childSessionId, { childSessionId: event.childSessionId, definition: event.definition ?? 'subagent', brief: briefLine(event.brief ?? event.objective), running: true, dispatchedAt: event.timestamp ?? 0 })
    } else if (event.type === 'agent/child-result' && event.childSessionId !== undefined) {
      const row = rows.get(event.childSessionId)
      if (row === undefined) continue
      rows.set(event.childSessionId, { ...row, running: false, status: event.status ?? 'finished', ...(event.timestamp !== undefined ? { endedAt: event.timestamp } : {}) })
    }
  }
  // Newest dispatch first: the child just sent out leads the list instead of
  // hiding at the bottom under the whole ended history.
  return [...rows.values()].sort((left, right) => right.dispatchedAt - left.dispatchedAt)
}

/**
 * Fold the host's child registry (the workbench list's source of truth) into
 * event-derived rows. A spawn whose result event an SSE gap dropped — or that
 * the host never wrote because the parent append failed and the child settled
 * `uncertain` — otherwise reads `running` forever. Only the running bit flips:
 * the log keeps the row's brief, role, and dispatch time.
 */
export function reconcileSubagentRows(rows: readonly SubagentRow[], children: readonly ChildRow[]): readonly SubagentRow[] {
  if (rows.every((row) => !row.running) || children.length === 0) return rows
  const settled = new Map(children.map((child) => [child.childSessionId, child]))
  let changed = false
  const next = rows.map((row) => {
    if (!row.running) return row
    const child = settled.get(row.childSessionId)
    if (child === undefined || child.status === 'queued' || child.status === 'dispatching' || child.status === 'running' || child.status === 'uncertain') return row
    changed = true
    return { ...row, running: false, status: child.status, ...(child.endedAt !== undefined ? { endedAt: child.endedAt } : {}) }
  })
  return changed ? next : rows
}
