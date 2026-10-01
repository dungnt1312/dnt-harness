/** Pure derivation of Environment-panel rows from the session event log. */
import type { SseEvent } from './types.ts'

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
  readonly running: boolean
  readonly status?: string
}

export function subagentRows(events: readonly SseEvent[]): readonly SubagentRow[] {
  const rows = new Map<string, SubagentRow>()
  for (const event of events) {
    if (event.type === 'agent/child-spawn' && event.childSessionId !== undefined) {
      rows.set(event.childSessionId, { childSessionId: event.childSessionId, definition: event.definition ?? 'subagent', running: true })
    } else if (event.type === 'agent/child-result' && event.childSessionId !== undefined) {
      const row = rows.get(event.childSessionId)
      if (row === undefined) continue
      rows.set(event.childSessionId, { ...row, running: false, status: event.status ?? 'finished' })
    }
  }
  return [...rows.values()]
}
