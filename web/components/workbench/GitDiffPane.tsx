import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { fetchGitDiff, type GitChange, type GitDiffReport } from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromUnified } from '../common/DiffLines.tsx'
import { MediaPreview } from '../common/MediaPreview.tsx'

/**
 * The diff of the selected change: its own header (name, counts, the file's
 * stage control, opener, previous/next hunk) over the rows. The report is
 * fetched per path and per `reloadKey` (bumped when an operation settles); an
 * answer for a file the reader has already left is discarded.
 */
export function GitDiffPane({ workspaceId, projectId, change, reloadKey, onStage, onOpenFile, onReady }: {
  readonly workspaceId: string
  readonly projectId: string
  readonly change: GitChange
  /** Bumped whenever the status moved, so the diff is read again. */
  readonly reloadKey: number
  /** Stage or unstage exactly this file. */
  readonly onStage: (paths: readonly string[], intent: 'stage' | 'unstage') => void
  /** Opens the file itself in the workbench; absent without an opener. */
  readonly onOpenFile?: () => void
  /** Called once the diff (or its error) has rendered. */
  readonly onReady?: () => void
}) {
  const path = change.path
  const [diff, setDiff] = useState<GitDiffReport | null>(null)
  const [error, setError] = useState<string | null>(null)
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

  const stages = change.staging !== 'staged'
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
    <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]">
      <FileTypeIcon path={path} size={16} />
      <span className="min-w-0 flex-1 truncate" title={path}>
        <span className="font-medium">{name}</span>
        {directory !== '' ? <span className="ml-1.5 text-fg-faint">{directory}</span> : null}
      </span>
      <LineCount
        {...(change.added !== undefined ? { added: change.added } : {})}
        {...(change.removed !== undefined ? { removed: change.removed } : {})}
      />
      <IconButton label="Previous hunk" onClick={() => jump(-1)}><Icon name="arrowUp" size={13} /></IconButton>
      <IconButton label="Next hunk" onClick={() => jump(1)}><Icon name="arrowDown" size={13} /></IconButton>
      {onOpenFile !== undefined ? (
        <IconButton label={`Open ${name} in workbench`} onClick={onOpenFile}><Icon name="fileText" size={13} /></IconButton>
      ) : null}
      <Button size="sm" variant="outline" className="h-7 px-2.5" onClick={() => onStage([path], stages ? 'stage' : 'unstage')}>
        {stages ? 'Stage File' : 'Unstage File'}
      </Button>
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
        <DiffLines rows={diffRowsFromUnified(diff.lines, { keepHunks: true })} renderHunk={(_, headerText) => <span className="block bg-muted/40 px-3 py-0.5 font-mono text-[11px] text-fg-faint">{headerText}</span>} />
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
