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
 * success, merged per file in call order: three edits to one file are one
 * file whose counts add up and whose diff lists all three. A file the turn
 * created stays "created" however often the turn edits it afterwards.
 *
 * This is the TURN's change, never git's: git compares the whole working tree
 * with HEAD, which mixes in every other turn, session and hand edit. The
 * card shows this projection; the Git view is a separate, labelled surface.
 *
 * Reads never change a file, and a failed, refused or recovered call did not
 * land — none of the three is counted as a change, so a turn whose writes all
 * failed renders no card at all: the failed call already shows as its own
 * error tool row. Bash effects are invisible
 * here by design: the log does not record what a command touched. A child's
 * writes live in the child's own log.
 */
import { editLineCounts, editOccurrences, splitLines } from './line-diff.ts'
import { patchReceipt } from '../../src/capabilities/fs/patch.ts'
import type { SseEvent } from './types.ts'

/** One landed call on a file, as recorded — what the turn's diff is drawn from. */
export type TurnEdit =
  | {
      readonly kind: 'edit'
      readonly old: string
      readonly new: string
      /** The tool's receipt: carries the numbered snippet and replaceAll count. */
      readonly output: string
      readonly oldLine?: number
      readonly newLine?: number
    }
  | {
      readonly kind: 'write'
      readonly content: string
      /** The file did not exist before this write. */
      readonly created: boolean
    }

/** One file a turn changed, in the shape a change row reads. */
export interface TurnChangeFile {
  /**
   * The path exactly as the call recorded it (root-relative or absolute,
   * separators verbatim). Opening the file goes through the same path
   * resolver a tool row uses.
   */
  readonly path: string
  /** `created` when one of the turn's calls created the file; else modified. */
  readonly status: 'modified' | 'created'
  /**
   * Lines this turn added and removed, from the recorded arguments: an Edit
   * contributes its line diff (context it carried excluded, times the places
   * a replaceAll changed). For a created file, the net lines it now holds.
   * Absent when nothing countable was recorded, and for an overwritten file.
   */
  readonly lines?: { readonly added: number; readonly removed?: number }
  /**
   * A Write replaced an existing file whole: what it replaced is not in the
   * log, so the removed side is unknown and the added side is the full file.
   */
  readonly overwrote?: true
  /** Every landed call on the file, in call order. */
  readonly edits: readonly TurnEdit[]
}

/** The files one recorded turn changed. */
export interface TurnChanges {
  readonly files: readonly TurnChangeFile[]
  /** Wall-clock time of the turn's first landing mutation, if stamped. */
  readonly ts?: number
}

/** Tool names whose success means a file changed. Case-insensitive. */
const MUTATING_TOOLS = new Set(['write', 'edit', 'applypatch'])

const mutating = (name: string): boolean => MUTATING_TOOLS.has(name.toLowerCase())

const text = (args: Record<string, unknown>, key: string): string => (typeof args[key] === 'string' ? args[key] as string : '')

/** Both tools answer `created <path> …` when the file did not exist. */
const CREATED = /^created /

interface FileDraft {
  readonly path: string
  created: boolean
  overwrote: boolean
  added: number
  removed: number
  readonly edits: TurnEdit[]
}

function landEdit(file: FileDraft, edit: TurnEdit): void {
  file.edits.push(edit)
  if (edit.kind === 'write') {
    if (edit.created) file.created = true
    else if (!file.created) file.overwrote = true
    file.added += splitLines(edit.content).length
    return
  }
  // An Edit with an empty `old` that answered `created` made the file.
  if (CREATED.test(edit.output)) file.created = true
  const lines = editLineCounts(edit.old, edit.new)
  const times = editOccurrences(edit.output)
  file.added += lines.added * times
  file.removed += lines.removed * times
}

function finish(file: FileDraft): TurnChangeFile {
  // A file the turn created had nothing before it: its size is the net of
  // what the turn put in and took back out, never "removed" lines.
  // An overwritten file states no counts at all: the side it replaced is not
  // in the log, and "+300" for a one-line rewrite would be a made-up size.
  const added = file.created ? Math.max(0, file.added - file.removed) : file.added
  const removed = file.created ? 0 : file.removed
  const overwrote = file.overwrote && !file.created
  const countable = !overwrote && (added > 0 || removed > 0)
  return {
    path: file.path,
    status: file.created ? 'created' : 'modified',
    ...(countable ? { lines: { added, ...(removed > 0 ? { removed } : {}) } } : {}),
    ...(overwrote ? { overwrote: true as const } : {}),
    edits: file.edits,
  }
}

/**
 * The files each turn changed, keyed by turn id, in first-touch order. Only
 * turns with at least one recorded mutation attempt appear. A call recorded
 * outside any open turn is skipped rather than mis-attributed — the panel
 * never guesses turn membership the log did not state.
 */
export function turnChanges(events: readonly SseEvent[]): ReadonlyMap<string, TurnChanges> {
  type Draft = { files: Map<string, FileDraft>; ts?: number }
  const drafts = new Map<string, Draft>()
  // callId → the turn and target the call named; its result lands there.
  const pending = new Map<string, { turn: string; path: string; write: boolean; args: Record<string, unknown> }>()
  let openTurnId: string | undefined

  const draftFor = (turnId: string): Draft => {
    let draft = drafts.get(turnId)
    if (draft === undefined) {
      draft = { files: new Map() }
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
      const path = call.name.toLowerCase() === 'applypatch' ? '' : call.args['path']
      if (typeof path !== 'string' || (path === '' && call.name.toLowerCase() !== 'applypatch')) continue
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
    if (call.path === '') {
      if (event.recovery === true) continue
      const receipt = patchReceipt(event.output)
      if (receipt === undefined || receipt.files.length === 0) continue
      const draft = draftFor(call.turn)
      if (draft.ts === undefined && event.timestamp !== undefined) draft.ts = event.timestamp
      for (const change of receipt.files) {
        const path = change.movePath ?? change.path
        let file = draft.files.get(path)
        if (file === undefined) {
          file = { path, created: change.type === 'add', overwrote: false, added: 0, removed: 0, edits: [] }
          draft.files.set(path, file)
        }
        const label = change.type === 'move' ? `moved from ${change.path}` : change.type === 'delete' ? 'deleted file' : ''
        for (const edit of change.edits) landEdit(file, { kind: 'edit', ...edit, output: label })
      }
      continue
    }
    // Patch receipts above also preserve known changes from partial failures.
    if (event.ok !== true || event.recovery === true) continue
    const draft = draftFor(call.turn)
    if (draft.ts === undefined && event.timestamp !== undefined) draft.ts = event.timestamp
    const output = event.output ?? ''
    let file = draft.files.get(call.path)
    if (file === undefined) {
      file = { path: call.path, created: false, overwrote: false, added: 0, removed: 0, edits: [] }
      draft.files.set(call.path, file)
    }
    landEdit(file, call.write
      ? { kind: 'write', content: text(call.args, 'content'), created: CREATED.test(output) }
      : { kind: 'edit', old: text(call.args, 'old'), new: text(call.args, 'new'), output })
  }

  const out = new Map<string, TurnChanges>()
  for (const [turnId, draft] of drafts) {
    if (draft.files.size === 0) continue
    out.set(turnId, {
      files: [...draft.files.values()].map(finish),
      ...(draft.ts !== undefined ? { ts: draft.ts } : {}),
    })
  }
  return out
}
