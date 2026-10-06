import { useEffect, useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { LineCount } from '../common/DiffLines.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { cn } from '../../lib/cn.ts'
import type { GitStatusReport } from '../../lib/api.ts'
import { fetchGitStatus } from '../../lib/api.ts'
import { overlayTurnChanges, type TurnChangeOverlay } from '../../lib/turn-git.ts'
import type { TurnChanges } from '../../lib/turn-changes.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import { toProjectRelative } from '../../lib/project-paths.ts'
import type { WorkbenchProject } from '../workbench/Workbench.tsx'

/** Copy label per file status — never color alone. */
const STATUS_TEXT: Readonly<Record<'modified' | 'created', string>> = {
  modified: 'Modified',
  created: 'Created',
}

/** One-letter mark, the same codes a git UI prints. */
const STATUS_MARK: Readonly<Record<'modified' | 'created', string>> = {
  modified: 'M',
  created: 'A',
}

const markColor = (status: 'modified' | 'created'): string => (status === 'created' ? 'text-ok' : 'text-warn')

function turnChangesLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'} changed`
}

/**
 * The per-turn change card: one collapsible row under a closed turn's last
 * answer, naming the files that turn's Write/Edit calls landed. The collapsed
 * row counts lines from the log alone — the exact `old`/`new` an Edit
 * recorded, attributed to this turn and no other. Expanding loads the
 * project's read-only git view (lazily: nothing is fetched while collapsed)
 * and marks each file with git's current whole-worktree numbers, which other
 * turns sharing the file also contributed to — the note says so rather than
 * implying attribution.
 *
 * The projection never invents effects: Bash edits and child writes are
 * invisible here, and the expanded list points at the Git view for the full
 * picture.
 */
export function TurnChangesCard({ turnId, changes, project, workspaceId, onOpenPath, onReviewFile, onReviewAll }: {
  readonly turnId: string
  readonly changes: TurnChanges
  readonly project: WorkbenchProject | null
  readonly workspaceId: string | null
  /** Resolves a recorded path to an opener, exactly like a tool row. */
  readonly onOpenPath?: OpenPathResolver
  /** Opens the Git view in the workbench narrowed to this one file. */
  readonly onReviewFile?: (path: string) => void
  /** Opens the Git view over the whole project; offered with a project. */
  readonly onReviewAll?: () => void
}) {
  const [open, setOpen] = useState(false)
  // Collapsed costs nothing: git is a view over live state, loaded once, only
  // while the list is open — never as a side effect of rendering the row.
  const report = useGitReport(workspaceId, project?.id ?? null, open)

  const rows = useMemo(
    () => (open ? overlayTurnChanges(changes, project?.path ?? '', report) : []),
    [open, changes, project?.path, report],
  )
  const outsideCount = rows.filter((row) => row.outside === true).length
  const logTotals = changes.files.reduce((sum, file) => ({
    added: sum.added + (file.lines?.added ?? 0),
    removed: sum.removed + (file.lines?.removed ?? 0),
  }), { added: 0, removed: 0 })

  return (
    <div className="-ml-2 mt-0.5">
      <div className="flex min-h-7 items-center gap-1.5 pr-1.5 text-[13px]">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
          <Icon name="gitBranch" size={14} className="shrink-0 text-fg-faint" />
          <span className="shrink-0 font-medium">{turnChangesLabel(changes.files.length)}</span>
          {logTotals.added > 0 ? <span className="shrink-0 font-mono text-xs text-ok">+{logTotals.added}</span> : null}
          {logTotals.removed > 0 ? <span className="shrink-0 font-mono text-xs text-bad">−{logTotals.removed}</span> : null}
          {changes.files.length === 0 && changes.uncertain.length > 0 ? (
            <span className="shrink-0 rounded bg-warn-soft px-1.5 text-[11px] text-warn">outcome unconfirmed</span>
          ) : null}
        </button>
        {onReviewAll !== undefined ? (
          <button
            type="button"
            onClick={onReviewAll}
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[12px] text-link underline-offset-2 transition-colors hover:bg-hover hover:underline"
          >
            Review all
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="ml-[26px] border-l border-line pl-2">
          {report === null && project !== null ? (
            <p className="m-0 flex items-center gap-2 px-1 py-1 text-[12px] text-fg-muted" role="status">
              Loading git view…<span className="sr-only">Loading git status</span>
            </p>
          ) : null}
          {changes.files.length > 0 ? (
            <ul aria-label={`Files changed by turn ${turnId}`} className="m-0 list-none p-0">
              {rows.map((row) => {
                return (
                  <ChangeFileRow
                    key={row.path}
                    row={row}
                    {...(project !== null ? { project } : {})}
                    {...(onReviewFile !== undefined ? { onReviewFile } : {})}
                    {...(onOpenPath !== undefined ? { onOpenPath } : {})}
                  />
                )
              })}
            </ul>
          ) : (
            <p className="m-0 px-1 py-1 text-[12px] text-fg-muted" role="note">
              {changes.uncertain.length} {changes.uncertain.length === 1 ? 'write did not report its outcome' : 'writes did not report their outcomes'} — the log cannot say whether the {changes.uncertain.length === 1 ? 'file was' : 'files were'} changed. Git view shows what actually differs.
            </p>
          )}
          {outsideCount > 0 ? (
            <p className="m-0 px-1 py-1 text-[12px] text-fg-faint" role="note">
              {outsideCount === 1 ? 'One file sits' : `${outsideCount} files sit`} outside the project folder — git does not count {outsideCount === 1 ? 'it' : 'them'} here.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One file of the expanded list: a row (mark, icon, name, directory, git
 * chips) whose click opens the Git view in the workbench with that file's
 * diff open — the review lives at review scale, beside every other change,
 * instead of a diff drawn inline here. A quiet button at the row's end opens
 * the file itself for full context. A file whose path git cannot resolve has
 * no row to focus, so the row stays put and only the file opener remains.
 */
function ChangeFileRow({ row, project, onReviewFile, onOpenPath }: {
  readonly row: TurnChangeOverlay
  readonly project?: WorkbenchProject
  readonly onReviewFile?: (path: string) => void
  readonly onOpenPath?: OpenPathResolver
}) {
  const open = onOpenPath?.(row.path) ?? null
  const name = row.path.split(/[\\/]/).pop() ?? row.path
  const directory = row.path.slice(0, row.path.length - name.length).replace(/[\\/]+$/, '')
  const relative = project !== undefined ? toProjectRelative(project.path, row.path) : null
  // The Git view focuses project-relative paths; an unresolvable path leaves
  // the row informational.
  const review = onReviewFile !== undefined && relative !== null && relative !== ''
    ? () => onReviewFile(relative)
    : null
  const body = (
    <>
      <span
        className={cn('flex w-3 shrink-0 justify-center font-mono text-[11px] font-semibold', markColor(row.status))}
        title={STATUS_TEXT[row.status]}
      >
        <span aria-hidden="true">{STATUS_MARK[row.status]}</span>
        <span className="sr-only">{STATUS_TEXT[row.status]}</span>
      </span>
      <FileTypeIcon path={row.path} size={16} />
      <span className="min-w-0 flex-1 truncate">
        <span className={cn(row.status === 'created' && 'font-medium')}>{name}</span>
        {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
      </span>
      {row.git !== undefined
        ? <LineCount {...(row.git.added !== undefined ? { added: row.git.added } : {})} {...(row.git.removed !== undefined ? { removed: row.git.removed } : {})} />
        : null}
      {row.outside === true ? <span className="shrink-0 text-[11px] text-fg-faint">outside project</span> : null}
    </>
  )
  return (
    <li className="m-0">
      <div className="flex items-center gap-0.5">
        {review !== null ? (
          <button
            type="button"
            title={`${row.path} — show the diff in the Git view`}
            onClick={review}
            className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-hover"
          >
            {body}
          </button>
        ) : (
          <div title={row.path} className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 px-1.5 text-[13px]">
            {body}
          </div>
        )}
        {open !== null ? (
          <IconButton label={`Open ${name} in workbench`} onClick={open} className="mr-0.5">
            <Icon name="fileText" size={13} />
          </IconButton>
        ) : null}
      </div>
    </li>
  )
}

/** Git report for the conversation project; loads only while `enabled`. */
function useGitReport(workspaceId: string | null, projectId: string | null, enabled: boolean): GitStatusReport | null {
  const [report, setReport] = useState<GitStatusReport | null>(null)
  useEffect(() => {
    if (!enabled || workspaceId === null || projectId === null) return
    let cancelled = false
    fetchGitStatus(workspaceId, projectId)
      .then((next) => { if (!cancelled) setReport(next) })
      .catch(() => {
        // No numbers is a display outcome, not an error surface: the card
        // already words itself for a missing git view.
        if (!cancelled) setReport(null)
      })
    return () => { cancelled = true }
  }, [workspaceId, projectId, enabled])
  return report
}
