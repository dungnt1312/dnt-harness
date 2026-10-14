import { useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Modal } from '../ui/Modal.tsx'
import { cn } from '../../lib/cn.ts'
import { parentOf } from '../../lib/file-tree.ts'
import { useFileSearch } from './useFileSearch.ts'

/** Find a project file by name and open it, from the keyboard alone. */
export function QuickOpen({ open, workspaceId, projectId, onOpen, onDismiss }: {
  readonly open: boolean
  readonly workspaceId: string
  readonly projectId: string
  readonly onOpen: (path: string) => void
  readonly onDismiss: () => void
}) {
  const search = useFileSearch(workspaceId, projectId)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLUListElement>(null)
  const matches = search.result?.matches ?? []

  // A fresh question each time the box opens.
  useEffect(() => { if (open) { search.setQuery(''); setIndex(0) } }, [open])
  useEffect(() => { setIndex(0) }, [search.query])
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, matches.length])

  const choose = (path: string): void => {
    onDismiss()
    onOpen(path)
  }

  return (
    <Modal open={open} onDismiss={onDismiss} label="Open file" width="md" className="top-[18%] -translate-y-0" bodyClassName="p-0">
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={14} className="shrink-0 text-fg-faint" />
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="quick-open-results"
          aria-activedescendant={matches[index] !== undefined ? `quick-open-${index}` : undefined}
          aria-label="Search files by name"
          placeholder="Search files by name"
          spellCheck={false}
          value={search.query}
          onChange={(event) => search.setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((current) => Math.min(current + 1, Math.max(matches.length - 1, 0))) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((current) => Math.max(current - 1, 0)) }
            else if (event.key === 'Enter') {
              const match = matches[index]
              if (match !== undefined) { event.preventDefault(); choose(match.path) }
            }
          }}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-fg-faint"
        />
      </div>
      <div className="max-h-80 min-h-16 overflow-auto py-1">
        {!search.searching ? (
          <p className="m-0 px-3 py-3 text-[13px] text-fg-faint">Type part of a file name.</p>
        ) : search.status === 'error' ? (
          <div className="p-2"><ErrorNotice raw={search.error ?? ''} /></div>
        ) : search.result === null ? (
          <div className="flex items-center gap-2 px-3 py-3 text-sm text-fg-muted" role="status"><Spinner size={13} />Searching…</div>
        ) : matches.length === 0 ? (
          <p className="m-0 px-3 py-3 text-[13px] text-fg-faint">No matching files</p>
        ) : (
          <ul ref={listRef} id="quick-open-results" role="listbox" aria-label="Matching files" className="m-0 flex list-none flex-col p-0">
            {matches.map((match, position) => (
              <li
                key={match.path}
                id={`quick-open-${position}`}
                role="option"
                aria-selected={position === index}
                onMouseMove={() => setIndex(position)}
                onClick={() => choose(match.path)}
                className={cn('flex min-h-8 cursor-pointer items-center gap-2 px-3 text-[13px]', position === index && 'bg-hover')}
              >
                <FileTypeIcon path={match.name} size={16} />
                <span className="shrink-0">{match.name}</span>
                {parentOf(match.path) !== '' ? <span className="min-w-0 flex-1 truncate text-fg-faint">{parentOf(match.path)}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  )
}
