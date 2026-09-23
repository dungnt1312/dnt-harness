import type { SseEvent, ToolCall } from '../../lib/types.ts'

export type ArtifactKind = 'file-reference' | 'resource-reference' | 'command' | 'tool-output'
export type ArtifactState = 'pending' | 'succeeded' | 'failed' | 'unknown'

export interface ArtifactItem {
  readonly id: string
  readonly kind: ArtifactKind
  readonly toolName: string
  readonly label: string
  readonly argumentKey?: string
  readonly reference?: string
  readonly command?: string
  readonly output?: string
  readonly state: ArtifactState
  readonly timestamp?: number
  readonly durationMs?: number
}

const PATH_KEYS = new Set(['path', 'file_path'])
const PATH_LIKE_KEY = /(?:^|_)(?:path|file|folder|directory|cwd|root)$/i

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function resultState(result: SseEvent | undefined): ArtifactState {
  if (result === undefined) return 'pending'
  // A possible remote effect and a known outcome whose evidence failed to
  // persist are both unknown to the operator — never a clean failure.
  if (result.outcome === 'indeterminate' || result.outcome === 'audit_fault') return 'unknown'
  if (result.recovery === true) return 'unknown'
  if (result.ok === true) return 'succeeded'
  if (result.ok === false) return 'failed'
  return 'unknown'
}

function baseItem(call: ToolCall, event: SseEvent, result: SseEvent | undefined) {
  const output = nonEmptyString(result?.output)
  return {
    id: call.id,
    toolName: call.name,
    state: resultState(result),
    ...(event.timestamp !== undefined ? { timestamp: event.timestamp } : {}),
    ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(output !== undefined ? { output } : {}),
  }
}

function projectCall(call: ToolCall, event: SseEvent, result: SseEvent | undefined): ArtifactItem | null {
  const base = baseItem(call, event, result)
  const shellCommand = /^(?:bash|shell)$/i.test(call.name) ? nonEmptyString(call.args.command) : undefined
  if (shellCommand !== undefined) return { ...base, kind: 'command', label: 'Command record', command: shellCommand }

  for (const key of PATH_KEYS) {
    const reference = nonEmptyString(call.args[key])
    if (reference !== undefined) return { ...base, kind: 'file-reference', label: 'File reference', argumentKey: key, reference }
  }

  for (const [key, value] of Object.entries(call.args)) {
    const reference = nonEmptyString(value)
    if (reference !== undefined && PATH_LIKE_KEY.test(key)) {
      return { ...base, kind: 'resource-reference', label: 'Resource reference', argumentKey: key, reference }
    }
  }

  if (base.output !== undefined) return { ...base, kind: 'tool-output', label: 'Recorded tool output' }
  return null
}

export function projectArtifacts(events: readonly SseEvent[]): readonly ArtifactItem[] {
  const calls = new Map<string, { readonly call: ToolCall; readonly event: SseEvent }>()
  const results = new Map<string, SseEvent>()
  const orderedIds: string[] = []

  for (const event of events) {
    if (event.type === 'tool/call' && event.call !== undefined && !calls.has(event.call.id)) {
      calls.set(event.call.id, { call: event.call, event })
      orderedIds.push(event.call.id)
    } else if (event.type === 'tool/result' && event.callId !== undefined && !results.has(event.callId)) {
      results.set(event.callId, event)
    }
  }

  return orderedIds.flatMap((id) => {
    const entry = calls.get(id)
    if (entry === undefined) return []
    const item = projectCall(entry.call, entry.event, results.get(id))
    return item === null ? [] : [item]
  })
}
