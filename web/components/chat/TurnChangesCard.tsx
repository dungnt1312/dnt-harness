import { useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromEdit, diffRowsFromWrite, type DiffLayout, type DiffRow } from '../common/DiffLines.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { cn } from '../../lib/cn.ts'
import type { TurnChanges, TurnChangeFile } from '../../lib/turn-changes.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'

function turnChangesLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'} changed`
}

/**
 * The per-turn change card: the files a turn's Write/Edit calls landed. It
 * shows the TURN's change and nothing else — every number and every diff line
 * comes from the calls the log recorded for this turn (see `turnChanges`).
 * A file row expands in place to that turn-only diff; the header total is the
 * sum of the rows. Because nothing is fetched, the card appears the moment the
 * first edit lands and, while the turn runs (`live`), grows file by file.
 *
 * Review all opens the same turn-only diff as a workbench tab. Git is not
 * involved anywhere here: the turn's change is not git's diff vs HEAD.
 *
 * Bash edits and child writes are not in this turn's log and so not here.
 */
export function TurnChangesCard({ turnId, changes, live = false, onOpenPath, onReviewAll }: {
  readonly turnId: string
  readonly changes: TurnChanges
  /** The turn is still running: files stream in, and the header says "Editing". The list stays closed until opened. */
  readonly live?: boolean
  /** Resolves a recorded path to an opener, exactly like a tool row. */
  readonly onOpenPath?: OpenPathResolver
  /** Opens this turn's diff as a workbench tab. */
  readonly onReviewAll?: () => void
}) {
  // Closed by default, live or not: a long list must not push the running
  // work off screen. The header still counts files and lines as they land.
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const totals = changes.files.reduce((sum, file) => ({
    added: sum.added + (file.lines?.added ?? 0),
    removed: sum.removed + (file.lines?.removed ?? 0),
  }), { added: 0, removed: 0 })

  return (
    <section
      aria-label={`Changes of turn ${turnId}`}
      className="mt-1 rounded-xl border border-line bg-muted/40 p-1"
    >
      {/* Each line is ONE hover surface: the whole line lights as a single
          rounded band, its inner buttons included. Inner buttons only change
          text color. */}
      <div className="flex h-8 items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-hover">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-fg"
        >
          <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
          <span className="shrink-0 font-medium">{turnChangesLabel(changes.files.length)}</span>
          <LineCount added={totals.added} removed={totals.removed} />
          {live ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-fg-faint">
              <span className="size-1.5 rounded-full bg-ok animate-dot" aria-hidden="true" />
              Editing
            </span>
          ) : null}
        </button>
        {onReviewAll !== undefined ? (
          <button
            type="button"
            onClick={onReviewAll}
            title="Open this turn's diff in the workbench"
            className="flex h-full shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-[12px] text-fg-muted transition-colors hover:text-fg"
          >
            <Icon name="layers" size={12} className="shrink-0" />
            Review all
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-0.5">
          <ul aria-label={`Files changed by turn ${turnId}`} className="m-0 flex list-none flex-col gap-0.5 p-0">
            {changes.files.map((file) => (
              <li key={file.path} className="m-0">
                <FileSection
                  file={file}
                  layout="unified"
                  scroll
                  open={expanded.has(file.path)}
                  onToggle={() => setExpanded((current) => {
                    const next = new Set(current)
                    if (!next.delete(file.path)) next.add(file.path)
                    return next
                  })}
                  onOpenFile={onOpenPath?.(file.path) ?? null}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

/** The turn-only diff of one file: every landed call on it, in call order. */
export function turnFileDiffRows(file: TurnChangeFile): readonly DiffRow[] {
  const rows: DiffRow[] = []
  file.edits.forEach((edit, index) => {
    if (file.edits.length > 1) {
      rows.push({ kind: 'meta', text: `${edit.kind === 'write' ? 'Write' : 'Edit'} ${index + 1} of ${file.edits.length}`, old: null, new: null })
    }
    if (edit.kind === 'write') {
      if (!edit.created) rows.push({ kind: 'meta', text: 'Replaced the whole file; what it held before is not recorded.', old: null, new: null })
      rows.push(...diffRowsFromWrite(edit.content))
    } else {
      if (edit.output === 'deleted file' || edit.output.startsWith('moved from ')) rows.push({ kind: 'meta', text: edit.output, old: null, new: null })
      const diff = diffRowsFromEdit(edit.old, edit.new, edit.output)
      let oldNo = edit.oldLine ?? 1
      let newNo = edit.newLine ?? 1
      rows.push(...diff.map((row) => edit.oldLine === undefined ? row : ({ ...row, old: row.kind === 'add' ? null : oldNo++, new: row.kind === 'del' ? null : newNo++ })))
    }
  })
  return rows
}

/**
 * One file of a turn's change list: icon, name, directory, tag, line counts and
 * a chevron that folds the turn-only diff. The chat card and the workbench tab
 * both render this, so a file reads the same in either place.
 */
export function FileSection({ file, layout, open, onToggle, onOpenFile, scroll = false }: {
  readonly file: TurnChangeFile
  readonly layout: DiffLayout
  readonly open: boolean
  readonly onToggle: () => void
  readonly onOpenFile: (() => void) | null
  /** Cap the diff's height and scroll it: the chat must not grow without bound. */
  readonly scroll?: boolean
}) {
  const rows = useMemo(() => (open ? turnFileDiffRows(file) : []), [open, file])
  const name = file.path.split(/[\\/]/).pop() ?? file.path
  const directory = file.path.slice(0, file.path.length - name.length)
  return (
    <section className="overflow-hidden rounded-lg border border-line" aria-label={`This turn's diff of ${file.path}`}>
      {/* The whole header toggles; only the name opens the file. The chevron
          button has no handler of its own: its click (and Enter/Space) bubbles here. */}
      <div onClick={onToggle} className="flex h-8 cursor-pointer items-center gap-2 bg-muted/40 px-2 text-[13px]">
        <FileTypeIcon path={file.path} size={16} />
        {onOpenFile !== null
          ? <button type="button" title={`Open ${file.path}`} onClick={(event) => { event.stopPropagation(); onOpenFile() }} className="shrink-0 font-medium text-fg hover:underline">{name}</button>
          : <span className="shrink-0 font-medium text-fg">{name}</span>}
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-faint" title={file.path}>{directory}</span>
        {file.status === 'created'
          ? <span className="rounded bg-ok-soft px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-ok">New</span>
          : file.overwrote === true
            ? <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-fg-muted" title="Rewrote the whole file; the replaced content is not recorded">Rewritten</span>
            : null}
        <LineCount
          {...(file.lines?.added !== undefined ? { added: file.lines.added } : {})}
          {...(file.lines?.removed !== undefined ? { removed: file.lines.removed } : {})}
        />
        <IconButton label={open ? `Collapse ${name}` : `Expand ${name}`} aria-expanded={open} className="size-6">
          <Icon name="chevronRight" size={13} className={cn('transition-transform', open && 'rotate-90')} />
        </IconButton>
      </div>
      {open ? (
        <div className={cn('border-t border-line bg-surface', scroll ? 'max-h-80 overflow-auto' : 'overflow-x-auto')}>
          {rows.length > 0 ? <DiffLines rows={rows} layout={layout} /> : <p className="m-0 px-3 py-2 text-xs text-fg-muted">No textual change recorded.</p>}
        </div>
      ) : null}
    </section>
  )
}
