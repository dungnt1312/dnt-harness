import { useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { DiffLines, LineCount, type DiffLayout } from '../common/DiffLines.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { cn } from '../../lib/cn.ts'
import { turnChanges, type TurnChangeFile } from '../../lib/turn-changes.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'
import type { SseEvent } from '../../lib/types.ts'
import { turnFileDiffRows } from '../chat/TurnChangesCard.tsx'
import { readDiffLayout, writeDiffLayout } from './git-view.ts'

/**
 * One turn's changes as a review tab: every file the turn's Write/Edit calls
 * landed, each with the turn-only diff, stacked. Everything comes from the
 * log — never from git or the project folder — so it reads the same for a
 * file outside the project, a repository with other edits, or no repository.
 */
export function TurnChangesView({ turnId, events, openPath }: {
  readonly turnId: string
  readonly events: readonly SseEvent[]
  readonly openPath?: OpenPathResolver
}) {
  const changes = useMemo(() => turnChanges(events).get(turnId), [events, turnId])
  const [layout, setLayout] = useState<DiffLayout>(readDiffLayout)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  if (changes === undefined) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="fileText" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No changes recorded for this turn</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">The turn belongs to another conversation, or none of its edits landed.</p>
      </div>
    )
  }
  const totals = changes.files.reduce((sum, file) => ({
    added: sum.added + (file.lines?.added ?? 0),
    removed: sum.removed + (file.lines?.removed ?? 0),
  }), { added: 0, removed: 0 })
  const allCollapsed = changes.files.every((file) => collapsed.has(file.path))
  const toggle = (path: string): void => setCollapsed((current) => {
    const next = new Set(current)
    if (!next.delete(path)) next.add(path)
    return next
  })

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`Changes of turn ${turnId}`} role="region">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3 text-[13px]">
        <span className="font-medium">{changes.files.length} {changes.files.length === 1 ? 'file' : 'files'}</span>
        <LineCount added={totals.added} removed={totals.removed} />
        <span className="flex-1" />
        <IconButton
          label={allCollapsed ? 'Expand all files' : 'Collapse all files'}
          className="size-6"
          onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(changes.files.map((file) => file.path)))}
        >
          <Icon name="chevronRight" size={13} className={cn('transition-transform', !allCollapsed && 'rotate-90')} />
        </IconButton>
        <div role="group" aria-label="Diff layout" className="flex shrink-0 items-center rounded-md border border-line p-px">
          {([['unified', 'rows', 'Unified'], ['split', 'columns', 'Split']] as const).map(([mode, icon, label]) => (
            <button
              key={mode}
              type="button"
              aria-pressed={layout === mode}
              onClick={() => { writeDiffLayout(mode); setLayout(mode) }}
              className={cn('flex h-6 items-center gap-1 rounded px-1.5 text-[12px] text-fg-muted hover:text-fg', layout === mode && 'bg-hover text-fg')}
            >
              <Icon name={icon} size={12} />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {changes.files.map((file) => (
          <FileSection
            key={file.path}
            file={file}
            layout={layout}
            open={!collapsed.has(file.path)}
            onToggle={() => toggle(file.path)}
            onOpenFile={openPath?.(file.path) ?? null}
          />
        ))}
      </div>
    </div>
  )
}

function FileSection({ file, layout, open, onToggle, onOpenFile }: {
  readonly file: TurnChangeFile
  readonly layout: DiffLayout
  readonly open: boolean
  readonly onToggle: () => void
  readonly onOpenFile: (() => void) | null
}) {
  const rows = useMemo(() => (open ? turnFileDiffRows(file) : []), [open, file])
  const name = file.path.split(/[\\/]/).pop() ?? file.path
  const directory = file.path.slice(0, file.path.length - name.length)
  return (
    <section className="mb-2 overflow-hidden rounded-lg border border-line" aria-label={`This turn's diff of ${file.path}`}>
      <div className="flex h-8 items-center gap-2 bg-muted/40 px-2 text-[13px]">
        <FileTypeIcon path={file.path} size={16} />
        {onOpenFile !== null
          ? <button type="button" title={`Open ${file.path}`} onClick={onOpenFile} className="shrink-0 font-medium text-fg hover:underline">{name}</button>
          : <span className="shrink-0 font-medium text-fg">{name}</span>}
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg-faint" title={file.path}>{directory}</span>
        {file.status === 'created'
          ? <span className="rounded bg-ok-soft px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-ok">New</span>
          : file.overwrote === true
            ? <span className="rounded bg-muted px-1.5 text-[10px] font-medium uppercase leading-[16px] tracking-wide text-fg-muted">Rewritten</span>
            : null}
        <LineCount
          {...(file.lines?.added !== undefined ? { added: file.lines.added } : {})}
          {...(file.lines?.removed !== undefined ? { removed: file.lines.removed } : {})}
        />
        <IconButton label={open ? `Collapse ${name}` : `Expand ${name}`} aria-expanded={open} className="size-6" onClick={onToggle}>
          <Icon name="chevronRight" size={13} className={cn('transition-transform', open && 'rotate-90')} />
        </IconButton>
      </div>
      {open ? (
        <div className="overflow-x-auto border-t border-line bg-surface">
          {rows.length > 0 ? <DiffLines rows={rows} layout={layout} /> : <p className="m-0 px-3 py-2 text-xs text-fg-muted">No textual change recorded.</p>}
        </div>
      ) : null}
    </section>
  )
}
