import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import {
  fetchGitDiff,
  fetchGitStatus,
  type GitChange,
  type GitChangeStatus,
  type GitDiffReport,
  type GitStatusReport,
} from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { cn } from '../../lib/cn.ts'
import type { WorkbenchProject } from './Workbench.tsx'

const STATUS_LABEL: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'Modified',
  added: 'Added',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  untracked: 'Untracked',
  conflict: 'Conflict',
}

/** Letter shown before the file name, the same codes a git UI prints. */
const STATUS_MARK: Readonly<Record<GitChangeStatus, string>> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', copied: 'C', untracked: 'U', conflict: '!',
}

/**
 * Read-only source control for the conversation's project: the changed files
 * with their added and removed line counts, and the diff of the one that is
 * open. It never stages, commits, or discards.
 */
export function GitPanel({ workspaceId, project }: {
  readonly workspaceId: string
  readonly project: WorkbenchProject
}) {
  const [report, setReport] = useState<GitStatusReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openPath, setOpenPath] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const next = await fetchGitStatus(workspaceId, project.id)
      if (generation.current !== request) return
      setReport(next)
      setOpenPath((current) => current !== null && next.changes.some((change) => change.path === current) ? current : null)
    } catch (cause) {
      if (generation.current !== request) return
      setError(String(cause))
    } finally {
      if (generation.current === request) setLoading(false)
    }
  }, [workspaceId, project.id])

  useEffect(() => { void load() }, [load])

  const changes = report?.changes ?? []
  const totals = changes.reduce((sum, change) => ({
    added: sum.added + (change.added ?? 0),
    removed: sum.removed + (change.removed ?? 0),
  }), { added: 0, removed: 0 })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]">
        <Icon name="gitBranch" size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={report?.branch ?? project.path}>{report?.branch ?? project.name}</span>
        {changes.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
            <span className="text-fg-faint">{changes.length}</span>
            {totals.added > 0 ? <span className="text-ok">+{totals.added}</span> : null}
            {totals.removed > 0 ? <span className="text-bad">−{totals.removed}</span> : null}
          </span>
        ) : null}
        <IconButton label="Refresh git status" onClick={() => void load()}><Icon name="refresh" size={14} /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error !== null && report === null ? (
          <div className="flex flex-col items-start gap-2 p-3">
            <ErrorNotice raw={error} />
            <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
          </div>
        ) : loading && report === null ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-fg-muted" role="status"><Spinner size={13} />Checking git…</div>
        ) : changes.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <Icon name="check" size={20} className="text-fg-faint" />
            <p className="m-0 text-sm font-medium">No changes</p>
            <p className="m-0 max-w-xs text-[13px] text-fg-muted">{report?.branch === null ? 'This folder is not a git repository.' : 'The working tree matches HEAD.'}</p>
          </div>
        ) : (
          <ul aria-label="Changed files" className="m-0 flex list-none flex-col p-1">
            {changes.map((change) => (
              <li key={change.path}>
                <ChangeRow change={change} open={openPath === change.path} onToggle={() => setOpenPath((current) => current === change.path ? null : change.path)} />
                {openPath === change.path ? (
                  <DiffView key={change.path} workspaceId={workspaceId} projectId={project.id} path={change.path} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {report?.truncated === true ? <p className="m-0 px-3 py-2 text-xs text-fg-faint">Showing the first {changes.length} changed files.</p> : null}
      </div>
    </div>
  )
}

function ChangeRow({ change, open, onToggle }: {
  readonly change: GitChange
  readonly open: boolean
  readonly onToggle: () => void
}) {
  const name = change.path.split('/').pop() ?? change.path
  const directory = change.path.slice(0, change.path.length - name.length).replace(/\/$/, '')
  return (
    <button
      type="button"
      aria-expanded={open}
      title={change.previousPath !== undefined ? `${change.previousPath} → ${change.path}` : change.path}
      onClick={onToggle}
      className={cn('flex min-h-8 w-full items-center gap-1.5 rounded-md px-1.5 text-left text-[13px] hover:bg-hover', open && 'bg-hover')}
    >
      <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
      <span className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', markColor(change.status))} aria-label={STATUS_LABEL[change.status]}>{STATUS_MARK[change.status]}</span>
      <FileTypeIcon path={change.path} size={16} />
      <span className="min-w-0 flex-1 truncate">
        <span className={cn(change.status === 'deleted' && 'line-through')}>{name}</span>
        {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-xs">
        {change.added !== undefined && change.added > 0 ? <span className="text-ok">+{change.added}</span> : null}
        {change.removed !== undefined && change.removed > 0 ? <span className="text-bad">−{change.removed}</span> : null}
      </span>
    </button>
  )
}

function markColor(status: GitChangeStatus): string {
  if (status === 'deleted' || status === 'conflict') return 'text-bad'
  if (status === 'added' || status === 'untracked') return 'text-ok'
  return 'text-warn'
}

/** The unified diff of one changed file, loaded when its row opens. */
function DiffView({ workspaceId, projectId, path }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly path: string
}) {
  const [diff, setDiff] = useState<GitDiffReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const request = ++generation.current
    setError(null)
    try {
      const next = await fetchGitDiff(workspaceId, projectId, path)
      if (generation.current === request) setDiff(next)
    } catch (cause) {
      if (generation.current === request) setError(String(cause))
    }
  }, [workspaceId, projectId, path])

  useEffect(() => { void load() }, [load])

  if (error !== null) {
    return (
      <div className="flex items-center gap-2 py-1.5 pl-7 pr-2">
        <span className="text-xs text-bad">Could not load diff</span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    )
  }
  if (diff === null) return <div className="flex items-center gap-2 py-1.5 pl-7 text-xs text-fg-muted" role="status"><Spinner size={12} />Loading diff…</div>
  if (diff.binary) return <p className="m-0 py-1.5 pl-7 pr-2 text-xs text-fg-muted">Binary file — diff not shown.</p>
  if (diff.lines.length === 0) return <p className="m-0 py-1.5 pl-7 pr-2 text-xs text-fg-muted">No textual diff.</p>
  return (
    <div className="overflow-x-auto border-y border-line bg-muted/40" role="region" aria-label={`Diff of ${path}`} tabIndex={0}>
      {diff.truncated ? <p className="m-0 border-b border-line bg-warn-soft px-3 py-1 text-xs text-warn">Diff is larger than 1 MB; only the beginning is shown.</p> : null}
      <pre className="m-0 px-3 py-1.5 font-mono text-[12px] leading-5">
        {diff.lines.map((line, index) => (
          <div key={index} className={cn('whitespace-pre', lineClass(line.kind))}>
            <span aria-hidden="true" className="mr-2 inline-block w-3 select-none text-fg-faint">{marker(line.kind)}</span>
            {line.text === '' ? ' ' : line.text}
          </div>
        ))}
      </pre>
    </div>
  )
}

function marker(kind: GitDiffReport['lines'][number]['kind']): string {
  if (kind === 'add') return '+'
  if (kind === 'del') return '−'
  return ''
}

function lineClass(kind: GitDiffReport['lines'][number]['kind']): string {
  if (kind === 'add') return 'bg-ok-soft text-ok'
  if (kind === 'del') return 'bg-bad-soft text-bad'
  if (kind === 'hunk') return 'text-link'
  if (kind === 'meta') return 'text-fg-faint'
  return 'text-fg'
}
