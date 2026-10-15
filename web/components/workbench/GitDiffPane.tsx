import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { fetchGitDiff, type GitChange, type GitConflict, type GitDiffReport, type GitHunk, type GitOperationDone, type GitOperationInput } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { GIT_BAR, GIT_ICON, GIT_ICON_TRIGGER } from './git-controls.ts'
import { readDiffLayout, writeDiffLayout } from './git-view.ts'
import type { GitRun } from './use-git-operation.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromUnified, type DiffLayout } from '../common/DiffLines.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'

/**
 * The diff of the selected change: its own header (name, counts, the file's
 * stage control, opener, previous/next hunk) over the rows. The report is
 * fetched per path and per `reloadKey` (bumped when an operation settles); an
 * answer for a file the reader has already left is discarded.
 */
export function GitDiffPane({ workspaceId, projectId, change, reloadKey, run, enqueue, onDone, onOpenFile, onReady }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly change: GitChange
  /** Bumped whenever the status moved, so the diff is read again. */
  readonly reloadKey: number
  /** Runs one Git operation (a hunk or conflict button). */
  readonly run: GitRun
  /** The panel's queue: a hunk click runs after the staging clicks before it. */
  readonly enqueue: (task: () => Promise<void>) => void
  /** An operation answered: its status is the panel's new report. */
  readonly onDone: (done: GitOperationDone | undefined) => void
  /** Opens the file itself in the workbench; absent without an opener. */
  readonly onOpenFile?: () => void
  /** Called once the diff (or its error) has rendered. */
  readonly onReady?: () => void
}) {
  const path = change.path
  const [diff, setDiff] = useState<GitDiffReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [layout, setLayout] = useState<DiffLayout>(readDiffLayout)
  const generation = useRef(0)
  const body = useRef<HTMLDivElement | null>(null)
  const name = path.split('/').pop() ?? path
  const directory = path.slice(0, path.length - name.length).replace(/\/$/, '')

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

  // A different file clears the previous one at once: its rows must not sit under the new header.
  useEffect(() => { setDiff(null) }, [path])
  useEffect(() => { void load() }, [load, reloadKey])
  useEffect(() => {
    if (diff !== null || error !== null) onReady?.()
  }, [diff, error, onReady])

  /** One hunk or conflict button: queued behind pending clicks, its answer becomes the report. */
  const operate = (input: GitOperationInput): void => {
    enqueue(async () => { onDone(await run(input)) })
  }

  const jump = (direction: 1 | -1): void => {
    const anchors = [...(body.current?.querySelectorAll<HTMLElement>('[data-hunk-index]') ?? [])]
    if (anchors.length === 0) return
    const top = body.current?.getBoundingClientRect().top ?? 0
    const offsets = anchors.map((anchor) => anchor.getBoundingClientRect().top - top)
    // Next: the first hunk below the top edge; previous: the last one above it.
    let target: HTMLElement | undefined
    if (direction === 1) target = anchors[offsets.findIndex((offset) => offset > 4)]
    else for (let index = offsets.length - 1; index >= 0; index--) if (offsets[index]! < -4) { target = anchors[index]; break }
    target?.scrollIntoView?.({ block: 'start' })
  }

  const header = (
    <div className={cn(GIT_BAR, 'flex shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]')}>
      <FileTypeIcon path={path} size={16} />
      <span className="min-w-0 flex-1 truncate" title={path}>
        <span className="font-medium">{name}</span>
        {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
      </span>
      <LineCount
        {...(change.added !== undefined ? { added: change.added } : {})}
        {...(change.removed !== undefined ? { removed: change.removed } : {})}
      />
      {/* Two icons, the active one filled: unified (rows) or side by side (columns). */}
      <div role="group" aria-label="Diff layout" className="flex shrink-0 items-center rounded-md border border-line p-px">
        {([['unified', 'rows', 'Unified diff (vertical)'], ['split', 'columns', 'Split diff (side by side)']] as const).map(([mode, icon, label]) => (
          <IconButton
            key={mode}
            label={label}
            aria-pressed={layout === mode}
            className={cn('size-5 rounded', layout === mode && 'bg-hover text-fg')}
            onClick={() => { writeDiffLayout(mode); setLayout(mode) }}
          >
            <Icon name={icon} size={12} />
          </IconButton>
        ))}
      </div>
      <IconButton label="Previous hunk" className={GIT_ICON} onClick={() => jump(-1)}><Icon name="arrowUp" size={13} /></IconButton>
      <IconButton label="Next hunk" className={GIT_ICON} onClick={() => jump(1)}><Icon name="arrowDown" size={13} /></IconButton>
      {/* The rarely used actions live here, not on the bar. */}
      {onOpenFile !== undefined ? (
        <Menu label="More file actions" align="end" triggerClassName={GIT_ICON_TRIGGER} trigger={() => <Icon name="dots" size={14} />}>
          {(close) => (
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onOpenFile() }}>View file</button>
          )}
        </Menu>
      ) : null}
    </div>
  )

  let content
  if (error !== null) {
    content = (
      <div className="flex items-center gap-2 p-3">
        <span className="text-xs text-bad">Could not load diff</span>
        <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
      </div>
    )
  } else if (diff === null || diff.path !== path) {
    content = <div className="flex items-center gap-2 p-3 text-xs text-fg-muted" role="status"><Spinner size={12} />Loading diff…</div>
  } else if (diff.binary) {
    // A binary the browser can render shows the media itself; the rest say so.
    content = <div className="p-2"><MediaPreview workspaceId={workspaceId} projectId={projectId} path={path} /></div>
  } else if (diff.lines.length === 0) {
    content = <p className="m-0 p-3 text-xs text-fg-muted">No textual diff.</p>
  } else {
    content = (
      <div className="overflow-x-auto" role="region" aria-label={`Diff of ${path}`} tabIndex={0}>
        {diff.truncated ? <p className="m-0 border-b border-line bg-warn-soft px-3 py-1 text-xs text-warn">Diff is larger than 1 MB; only the beginning is shown.</p> : null}
        {(diff.conflicts ?? []).map((conflict) => (
          <ConflictBlock key={conflict.index} conflict={conflict} onChoose={(choice) => operate({ type: 'resolve-conflict', path, index: conflict.index, fingerprint: conflict.fingerprint, choice })} />
        ))}
        <DiffLines
          layout={layout}
          rows={diffRowsFromUnified(diff.lines, { keepHunks: true })}
          renderHunk={(index, headerText) => (
            <HunkHeader
              text={headerText}
              hunk={diff.hunks?.[index]}
              created={change.created}
              onOperate={(type) => {
                const hunk = diff.hunks?.[index]
                if (hunk !== undefined) operate({ type, path, hunk: { oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, fingerprint: hunk.fingerprint } })
              }}
            />
          )}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20" data-diff-pane={path}>
      {header}
      <div ref={body} className="min-h-0 flex-1 overflow-auto">{content}</div>
    </div>
  )
}

/**
 * One hunk's header: its range, and Zed's buttons — Stage (unstaged or
 * partial), Unstage (staged or partial), Restore (never on a created file).
 * The status shows as a bar: solid unstaged, half partial, hollow staged.
 */
function HunkHeader({ text, hunk, created, onOperate }: {
  readonly text: string
  readonly hunk: GitHunk | undefined
  readonly created: boolean
  readonly onOperate: (type: 'stage-hunk' | 'unstage-hunk' | 'restore-hunk') => void
}) {
  const canStage = hunk !== undefined && hunk.status !== 'staged'
  const canUnstage = hunk !== undefined && hunk.status !== 'unstaged'
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 border-l-2 bg-muted/40 px-3 py-0.5 font-mono text-[11px] text-fg-faint',
        hunk?.status === 'unstaged' && 'border-warn',
        hunk?.status === 'partial' && 'border-dashed border-warn',
        hunk?.status === 'staged' && 'border-dashed border-ok opacity-70',
        hunk === undefined && 'border-transparent',
      )}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {canStage ? <HunkButton title="Stage Hunk" onClick={() => onOperate('stage-hunk')}>Stage</HunkButton> : null}
      {canUnstage ? <HunkButton title="Unstage Hunk" onClick={() => onOperate('unstage-hunk')}>Unstage</HunkButton> : null}
      {hunk !== undefined && !created ? <HunkButton title="Restore Hunk" onClick={() => onOperate('restore-hunk')}>Restore</HunkButton> : null}
    </span>
  )
}

function HunkButton({ title, onClick, children }: { readonly title: string; readonly onClick: () => void; readonly children: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="h-5 rounded border border-line px-1.5 font-sans text-[11px] leading-none text-fg hover:bg-hover"
    >
      {children}
    </button>
  )
}

/** One conflict region: both sides, and Zed's Use <ours> / Use <theirs> / Use Both. */
function ConflictBlock({ conflict, onChoose }: {
  readonly conflict: GitConflict
  readonly onChoose: (choice: 'ours' | 'theirs' | 'both') => void
}) {
  return (
    <div data-conflict-index={conflict.index} className="border-b border-line">
      <div className="flex items-center gap-1.5 bg-warn-soft px-3 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate font-medium text-warn">Conflict {conflict.index + 1} · lines {conflict.startLine}–{conflict.endLine}</span>
        <HunkButton title={`Use ${conflict.oursName}`} onClick={() => onChoose('ours')}>{`Use ${conflict.oursName}`}</HunkButton>
        <HunkButton title={`Use ${conflict.theirsName}`} onClick={() => onChoose('theirs')}>{`Use ${conflict.theirsName}`}</HunkButton>
        <HunkButton title="Use Both" onClick={() => onChoose('both')}>Use Both</HunkButton>
      </div>
      <pre className="m-0 bg-ok-soft px-3 py-1 font-mono text-[12px] leading-5 text-ok">{conflict.ours}</pre>
      <pre className="m-0 bg-muted/60 px-3 py-1 font-mono text-[12px] leading-5">{conflict.theirs}</pre>
    </div>
  )
}
