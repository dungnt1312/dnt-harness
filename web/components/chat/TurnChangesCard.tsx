import { useEffect, useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, diffRowsFromEdit, diffRowsFromWrite, diffRowsFromUnified } from '../common/DiffLines.tsx'
import { cn } from '../../lib/cn.ts'
import type { GitStatusReport, GitDiffReport } from '../../lib/api.ts'
import { fetchGitDiff, fetchGitStatus } from '../../lib/api.ts'
import { overlayTotals, overlayTurnChanges, type TurnChangeOverlay } from '../../lib/turn-git.ts'
import type { TurnChanges, TurnChangeFile } from '../../lib/turn-changes.ts'
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

/** Letters for the git statuses a row may carry beside its own mark. */
const GIT_MARK: Readonly<Record<string, string>> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!',
}

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
export function TurnChangesCard({ turnId, changes, project, workspaceId, onOpenPath, onReviewAll }: {
  readonly turnId: string
  readonly changes: TurnChanges
  readonly project: WorkbenchProject | null
  readonly workspaceId: string | null
  /** Resolves a recorded path to an opener, exactly like a tool row. */
  readonly onOpenPath?: OpenPathResolver
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
  const totals = overlayTotals(rows)
  const outsideCount = rows.filter((row) => row.outside === true).length
  const logTotals = changes.files.reduce((sum, file) => ({
    added: sum.added + (file.lines?.added ?? 0),
    removed: sum.removed + (file.lines?.removed ?? 0),
  }), { added: 0, removed: 0 })
  // A missing git view (no project, no repository) or uncounted rows means
  // the numbers may not cover the list, so the note says where the whole
  // picture lives instead of claiming completeness.
  const noteNeeded = open && (project === null || report === null || report.changes.length === 0 || totals.counted < rows.length)

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
          <Icon name="squarePen" size={14} className="shrink-0 text-fg-faint" />
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
                const file = changes.files.find((candidate) => candidate.path === row.path)
                return (
                  <ChangeFileRow
                    key={row.path}
                    row={row}
                    {...(file !== undefined ? { file } : {})}
                    {...(project !== null && workspaceId !== null ? { project, workspaceId } : {})}
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
          {noteNeeded ? (
            <p className="m-0 px-1 pb-1 pt-0.5 text-[12px] text-fg-faint" role="note">
              Counts come from git over the project folder's current changes, shared across turns — shell edits and child writes are not attributed here. Git view has the full picture.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * One file of the expanded list: a toggle row (mark, icon, name, directory,
 * git chips) that expands to the file's diff. Inside the project the diff is
 * git's unified diff for that path — the same rows the Git view draws; the
 * header chips jump to the Workbench file for full context. A file outside
 * any project git cannot see has no git diff, so the rows come from the
 * recorded call itself (an Edit's old/new, a Write's full content).
 */
function ChangeFileRow({ row, file, project, workspaceId, onOpenPath }: {
  readonly row: TurnChangeOverlay
  /** The projection entry behind the row, for a log-derived diff fallback. */
  readonly file?: TurnChangeFile
  readonly project?: WorkbenchProject
  readonly workspaceId?: string
  readonly onOpenPath?: OpenPathResolver
}) {
  const [expanded, setExpanded] = useState(false)
  const open = onOpenPath?.(row.path) ?? null
  const name = row.path.split(/[\\/]/).pop() ?? row.path
  const directory = row.path.slice(0, row.path.length - name.length).replace(/[\\/]+$/, '')
  const gitMark = row.git !== undefined ? GIT_MARK[row.git.status] : undefined
  const gitLabel = row.git !== undefined ? `git: ${row.git.status}` : undefined
  const relative = project !== undefined ? toProjectRelative(project.path, row.path) : null
  return (
    <li className="m-0">
      <button
        type="button"
        aria-expanded={expanded}
        title={row.path}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          'flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] transition-colors hover:bg-hover',
          expanded && 'bg-hover',
        )}
      >
        <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-90')} />
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
        {gitMark !== undefined ? <span className="shrink-0 font-mono text-[11px] text-fg-faint" title={gitLabel}>{gitMark}</span> : null}
        {row.git?.added !== undefined && row.git.added > 0 ? <span className="shrink-0 font-mono text-xs text-ok">+{row.git.added}</span> : null}
        {row.git?.removed !== undefined && row.git.removed > 0 ? <span className="shrink-0 font-mono text-xs text-bad">−{row.git.removed}</span> : null}
        {row.outside === true ? <span className="shrink-0 text-[11px] text-fg-faint">outside project</span> : null}
      </button>
      {expanded ? (
        <>
          <TurnFileDiff
            {...(project !== undefined && workspaceId !== undefined && relative !== null && relative !== ''
              ? { project, workspaceId, relative }
              : {})}
            {...(file !== undefined && (relative === null || relative === '') ? { file } : {})}
          />
          {open !== null ? (
            <button
              type="button"
              className="mb-1 ml-1 mt-0.5 text-[12px] text-link underline-offset-2 hover:underline"
              onClick={open}
            >
              Open {name} in workbench
            </button>
          ) : null}
        </>
      ) : null}
    </li>
  )
}

/**
 * The diff body of one expanded file row: git's unified diff for the path
 * inside the project, or the recorded call's own old/new (Write content)
 * when git cannot see the file. Lazy: a body loads only once expanded.
 */
function TurnFileDiff({ project, workspaceId, relative, file }: {
  readonly project?: WorkbenchProject
  readonly workspaceId?: string
  /** Project-relative path for the git diff; absent when outside the project. */
  readonly relative?: string
  /** The projection entry for a log-derived diff when git cannot see the file. */
  readonly file?: TurnChangeFile
}) {
  const [diff, setDiff] = useState<GitDiffReport | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (project === undefined || workspaceId === undefined || relative === undefined) return
    let cancelled = false
    fetchGitDiff(workspaceId, project.id, relative)
      .then((next) => { if (!cancelled) setDiff(next) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [project, workspaceId, relative])

  if (relative !== undefined && project !== undefined && workspaceId !== undefined) {
    if (failed) {
      return <p className="m-0 px-1 py-1 text-[12px] text-fg-faint" role="note">Git could not diff this file — its change may be committed already.</p>
    }
    if (diff === null) {
      return <p className="m-0 px-1 py-1 text-[12px] text-fg-muted" role="status">Loading diff…</p>
    }
    if (diff.binary) {
      return <p className="m-0 px-1 py-1 text-[12px] text-fg-muted" role="note">Binary file — diff not shown.</p>
    }
    if (diff.lines.length === 0) {
      return <p className="m-0 px-1 py-1 text-[12px] text-fg-faint" role="note">No textual diff right now — a later turn may have changed this file back.</p>
    }
    return (
      <div className="overflow-x-auto rounded-md border border-line bg-muted/40" role="region" aria-label={`Diff of ${relative}`} tabIndex={0}>
        {diff.truncated ? <p className="m-0 border-b border-line bg-warn-soft px-3 py-1 text-xs text-warn">Diff is larger than 1 MB; only the beginning is shown.</p> : null}
        <DiffLines rows={diffRowsFromUnified(diff.lines)} />
      </div>
    )
  }
  // Outside any project: the log's own record is the only diff there is.
  if (file !== undefined) {
    const rows = fileLogRows(file)
    if (rows !== null) {
      return (
        <div className="overflow-x-auto rounded-md border border-line bg-muted/40" role="region" aria-label={`Recorded change to ${file.path}`} tabIndex={0}>
          <DiffLines rows={rows} />
        </div>
      )
    }
  }
  return <p className="m-0 px-1 py-1 text-[12px] text-fg-faint" role="note">No diff available — this file sits outside the project folder. Open it in the Workbench to read it as it is now.</p>
}

/** Rows from what the call itself recorded: an Edit's old/new, a Write's content. */
function fileLogRows(file: TurnChangeFile): ReturnType<typeof diffRowsFromEdit> | null {
  if (file.args === undefined) return null
  const { old: oldText, new: newText, content } = file.args
  if (typeof oldText === 'string' || typeof newText === 'string') {
    return diffRowsFromEdit(typeof oldText === 'string' ? oldText : '', typeof newText === 'string' ? newText : '')
  }
  if (typeof content === 'string' && content !== '') return diffRowsFromWrite(content)
  return null
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
