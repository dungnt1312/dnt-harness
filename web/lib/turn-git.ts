/**
 * Overlay of the conversation project's read-only git status onto the files a
 * turn's calls named — the +X −Y numbers a TurnChangesCard may show.
 *
 * The honest limits, stated once:
 * - `added`/`removed` come from `git diff --numstat HEAD` for the whole
 *   working tree. When more of the conversation touched the same file after
 *   this turn, the numbers include that too — they are the file's *current*
 *   diff, not this turn's alone.
 * - git sees only the project root; a Write into a granted folder outside it
 *   is invisible here. A file git does not list reads as "outside git",
 *   never as "unchanged".
 * - The overlay is a display aid over live state: it loads on demand, never
 *   blocks the panel's projection, and a failure just leaves numbers off.
 */
import { toProjectRelative } from './project-paths.ts'
import type { GitStatusReport } from './api.ts'
import type { TurnChanges } from './turn-changes.ts'

/** One file's overlay row: the projection's path plus git's view of it now. */
export interface TurnChangeOverlay {
  readonly path: string
  readonly status: 'modified' | 'created'
  /** Git's status for the file's current worktree entry, when it has one. */
  readonly git?: { readonly status: string; readonly added?: number; readonly removed?: number }
  /** True when the recorded path resolves outside the project (or is gone). */
  readonly outside?: boolean
}

/**
 * Merge one turn's projection with a fresh git report. Paths are resolved
 * through the same `toProjectRelative` rule the workbench opener uses, so
 * what git matches is exactly what "Open in workbench" would show.
 */
export function overlayTurnChanges(changes: TurnChanges, root: string, report: GitStatusReport | null): readonly TurnChangeOverlay[] {
  const byPath = new Map<string, { status: string; added?: number; removed?: number }>()
  if (report !== null) {
    for (const change of report.changes) byPath.set(change.path, { status: change.status, ...(change.added !== undefined ? { added: change.added } : {}), ...(change.removed !== undefined ? { removed: change.removed } : {}) })
  }
  return changes.files.map((file) => {
    const relative = toProjectRelative(root, file.path)
    const entry = relative !== null ? byPath.get(relative) : undefined
    return {
      path: file.path,
      status: file.status,
      ...(entry !== undefined
        ? { git: { status: entry.status, ...(entry.added !== undefined ? { added: entry.added } : {}), ...(entry.removed !== undefined ? { removed: entry.removed } : {}) } }
        : relative !== null ? {} : { outside: true as const }),
    }
  })
}

