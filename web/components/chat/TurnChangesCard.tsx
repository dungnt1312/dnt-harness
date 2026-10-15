import { useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, diffRowsFromEdit, diffRowsFromWrite, type DiffRow } from '../common/DiffLines.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { cn } from '../../lib/cn.ts'
import type { TurnChanges, TurnChangeFile } from '../../lib/turn-changes.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'

function turnChangesLabel(count: number): string {
  return `${count} ${count === 1 ? 'file' : 'files'} changed`
}

/** Hover-revealed without taking room: see GitPanel's ChangeRow for the contract. */
const REVEAL_ON_ROW = 'absolute right-1 top-0 flex h-8 items-center opacity-0 invisible transition-opacity group-hover/file:visible group-hover/file:opacity-100 group-has-[:focus-visible]/file:visible group-has-[:focus-visible]/file:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100'
const QUIET_ICON = 'size-6 rounded-md text-fg-faint hover:bg-transparent hover:text-fg'

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
              <ChangeFileRow
                key={file.path}
                file={file}
                {...(onOpenPath !== undefined ? { onOpenPath } : {})}
              />
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
 * One file of the list: icon, name, directory, a "New"/"Rewritten" tag, and
 * this turn's line counts. Clicking expands the turn-only diff right here.
 * Quiet buttons over the row's right edge — shown on hover, keyboard focus or
 * touch, never taking room — open the file.
 */
function ChangeFileRow({ file, onOpenPath }: {
  readonly file: TurnChangeFile
  readonly onOpenPath?: OpenPathResolver
}) {
  const [expanded, setExpanded] = useState(false)
  const rows = useMemo(() => (expanded ? turnFileDiffRows(file) : []), [expanded, file])
  const open = onOpenPath?.(file.path) ?? null
  const name = file.path.split(/[\\/]/).pop() ?? file.path
  const directory = file.path.slice(0, file.path.length - name.length).replace(/[\\/]+$/, '')
  const hasActions = open !== null
  return (
    <li className="group/file relative m-0">
      <button
        type="button"
        aria-expanded={expanded}
        title={file.path}
        onClick={() => setExpanded((value) => !value)}
        className={cn('flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[13px] transition-colors hover:bg-hover', expanded && 'bg-hover')}
      >
        <FileTypeIcon path={file.path} size={16} />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-fg">{name}</span>
          {directory !== '' ? <span className="ml-2 text-[12px] text-fg-faint">{directory}</span> : null}
        </span>
        <span className={cn('flex shrink-0 items-center gap-2', hasActions && 'transition-opacity group-hover/file:opacity-0 group-has-[:focus-visible]/file:opacity-0 [@media(pointer:coarse)]:opacity-100')}>
          {file.status === 'created'
            ? <span className="rounded bg-ok-soft px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-ok">New</span>
            : file.overwrote === true
              ? <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-fg-muted" title="Rewrote the whole file; the replaced content is not recorded">Rewritten</span>
              : <span className="sr-only">Modified</span>}
          <LineCount
            {...(file.lines?.added !== undefined ? { added: file.lines.added } : {})}
            {...(file.lines?.removed !== undefined ? { removed: file.lines.removed } : {})}
          />
        </span>
      </button>
      {open !== null ? (
        <span className={REVEAL_ON_ROW}>
          <IconButton label={`Open ${name} in workbench`} onClick={open} className={QUIET_ICON}>
            <Icon name="fileText" size={12} />
          </IconButton>
        </span>
      ) : null}
      {expanded ? (
        <div className="mx-1 mb-1 mt-0.5 max-h-80 overflow-auto rounded-lg border border-line bg-surface" role="region" aria-label={`This turn's diff of ${file.path}`} tabIndex={0}>
          {rows.length > 0 ? <DiffLines rows={rows} /> : <p className="m-0 px-3 py-2 text-xs text-fg-muted">No textual change recorded.</p>}
        </div>
      ) : null}
    </li>
  )
}
