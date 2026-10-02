/**
 * Per-turn file changes, projected from the durable log — the same contract
 * as `projectItems()`: no request of its own, nothing inferred beyond what a
 * recorded call and its recorded result say.
 *
 * Attribution is positional, exactly like `projectItems()`: `tool/call` and
 * `tool/result` carry only a `stepId`, so a call belongs to the turn open at
 * its position in the replay (`turn/start` … `turn/end`). A result answers
 * its call by `callId` even when the log appends it after a restart, past
 * the turn boundary.
 *
 * A turn's changes are the `Write`/`Edit` calls whose result recorded
 * success. Reads never change a file, a failed or refused call did not land,
 * and a recovered record says the real outcome is unknown — none of the
 * three may be counted as a change, but a non-landing outcome is kept as
 * `uncertain` so a hidden failure cannot read as "no changes". Bash effects
 * are invisible here by design: the log does not record what a command
 * touched, and the panel never claims it did. A child's writes live in the
 * child's own log; the parent's panel cannot see them.
 */
import type { SseEvent } from './types.ts'

/** One file a closed turn changed, in the shape a change row reads. */
export interface TurnChangeFile {
  /**
   * The path exactly as the call recorded it (root-relative or absolute,
   * separators verbatim). Display only; opening the file goes through the
   * same path resolver a tool row uses.
   */
  readonly path: string
  /** `created` when the Write result said `created …`; else modified. */
  readonly status: 'modified' | 'created'
  /**
   * Lines counted from the recorded arguments, the way a tool row counts
   * them: an Edit contributes its `old`/`new` lines, a Write the lines it
   * wrote (nothing removed is knowable — what it replaced is not in the
   * call). Absent when the arguments say nothing countable.
   */
  readonly lines?: { readonly added: number; readonly removed?: number }
  /**
   * The recorded arguments, kept so an expanded row can draw the change from
   * the log when git cannot see the file (outside every project folder):
   * an Edit's `old`/`new`, a Write's `content`. Display only.
   */
  readonly args?: Record<string, unknown>
}

/** The files one recorded turn changed. */
export interface TurnChanges {
  readonly files: readonly TurnChangeFile[]
  /**
   * Call ids whose write did not report a landing: a failed or refused
   * result, or a recovery record. Distinct from `files` so "nothing landed"
   * and "the log cannot say" never look the same.
   */
  readonly uncertain: readonly string[]
  /** Wall-clock time of the turn's first landing mutation, if stamped. */
  readonly ts?: number
}

/** Lines in a recorded argument, ignoring one trailing newline. */
function countLines(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0
  return value.replace(/\n$/, '').split('\n').length
}

/** The call-derived line counts for one mutating call, when countable. */
function callLines(name: string, args: Record<string, unknown>): TurnChangeFile['lines'] {
  if (name.toLowerCase() === 'edit') {
    const added = countLines(args['new'])
    const removed = countLines(args['old'])
    if (added === 0 && removed === 0) return undefined
    return { added, ...(removed > 0 ? { removed } : {}) }
  }
  const added = countLines(args['content'])
  if (added === 0) return undefined
  return { added }
}

/** Tool names whose success means a file changed. Case-insensitive. */
const MUTATING_TOOLS = new Set(['write', 'edit'])

const mutating = (name: string): boolean => MUTATING_TOOLS.has(name.toLowerCase())

/**
 * The files each turn changed, keyed by turn id, in call order. Only turns
 * with at least one recorded mutation attempt appear. A call recorded
 * outside any open turn is skipped rather than mis-attributed — the panel
 * never guesses turn membership the log did not state.
 */
export function turnChanges(events: readonly SseEvent[]): ReadonlyMap<string, TurnChanges> {
  type Draft = { files: Map<string, TurnChangeFile>; uncertain: string[]; ts?: number }
  const drafts = new Map<string, Draft>()
  // callId → the turn and target the call named; its result lands there.
  // Args are kept too: the line counts come from the call's own arguments.
  const pending = new Map<string, { turn: string; path: string; write: boolean; args: Record<string, unknown> }>()
  let openTurnId: string | undefined

  const draftFor = (turnId: string): Draft => {
    let draft = drafts.get(turnId)
    if (draft === undefined) {
      draft = { files: new Map(), uncertain: [] }
      drafts.set(turnId, draft)
    }
    return draft
  }

  for (const event of events) {
    if (event.type === 'turn/start') {
      openTurnId = event.turnId !== undefined && event.turnId !== '' ? event.turnId : openTurnId
      continue
    }
    if (event.type === 'turn/end') {
      openTurnId = undefined
      continue
    }
    if (event.type === 'tool/call') {
      const call = event.call
      if (call === undefined || !mutating(call.name)) continue
      const path = call.args['path']
      if (typeof path !== 'string' || path === '') continue
      if (openTurnId === undefined) continue
      pending.set(call.id, { turn: openTurnId, path, write: call.name.toLowerCase() === 'write', args: call.args })
      continue
    }
    if (event.type !== 'tool/result') continue
    const callId = event.callId
    if (callId === undefined) continue
    const call = pending.get(callId)
    if (call === undefined) continue
    pending.delete(callId)
    const draft = draftFor(call.turn)
    if (event.ok !== true || event.recovery === true) {
      draft.uncertain.push(callId)
      continue
    }
    if (draft.ts === undefined && event.timestamp !== undefined) draft.ts = event.timestamp
    // Last landing wins per path: a turn that edits a file twice lists it
    // once. `created <path>` is the Write tool's own receipt for a fresh
    // file; anything else it landed is an overwrite of what was there.
    const created = call.write && /^created /.test(event.output ?? '')
    const lines = callLines(call.write ? 'write' : 'edit', call.args)
    draft.files.set(call.path, {
      path: call.path,
      status: created ? 'created' : 'modified',
      ...(lines !== undefined ? { lines } : {}),
      args: call.args,
    })
  }

  const out = new Map<string, TurnChanges>()
  for (const [turnId, draft] of drafts) {
    if (draft.files.size === 0 && draft.uncertain.length === 0) continue
    out.set(turnId, {
      files: [...draft.files.values()],
      uncertain: draft.uncertain,
      ...(draft.ts !== undefined ? { ts: draft.ts } : {}),
    })
  }
  return out
}
