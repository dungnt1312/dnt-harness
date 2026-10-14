import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import type { ProjectSearchResult } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { absoluteEntryPath, parentOf, writeProjectFileDrag } from '../../lib/file-tree.ts'

const MENU_TRIGGER = 'absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-fg-faint hover:text-fg opacity-0 invisible transition-opacity group-hover/row:visible group-hover/row:opacity-100 group-focus-within/row:visible group-focus-within/row:opacity-100 focus-visible:visible focus-visible:opacity-100 [@media(pointer:coarse)]:visible [@media(pointer:coarse)]:opacity-100'

/** One result row: opens the file, drags it as a project reference, copies its paths. */
function ResultRow({ match, projectPath, onCopyPath, active, onOpen }: {
  readonly match: { readonly name: string; readonly path: string }
  readonly projectPath: string
  readonly onCopyPath: (path: string, absolute: boolean) => void
  readonly active: boolean
  readonly onOpen: (path: string) => void
}) {
  return (
    <div className="group/row relative">
      <button
        type="button"
        title={match.path}
        onClick={() => onOpen(match.path)}
        onDragStart={(event) => writeProjectFileDrag(event.dataTransfer, { path: match.path, kind: 'file' })}
        draggable
        className={cn('flex min-h-7 w-full items-center gap-1.5 rounded-md px-2.5 pr-8 text-left text-[13px] hover:bg-hover', active && 'bg-hover text-fg')}
      >
        <FileTypeIcon path={match.name} size={16} />
        <span className="shrink-0">{match.name}</span>
        {parentOf(match.path) !== '' ? <span className="min-w-0 flex-1 truncate text-fg-faint">{parentOf(match.path)}</span> : null}
      </button>
      <Menu label={`Actions for ${match.name}`} align="end" triggerClassName={MENU_TRIGGER} trigger={() => <Icon name="dots" size={14} />}>
        {(close) => (
          <>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onCopyPath(match.path, false) }}>
              <Icon name="copy" size={14} />Copy relative path
            </button>
            <button type="button" role="menuitem" className={menuItemClass} onClick={() => { close(); onCopyPath(match.path, true) }}>
              <Icon name="copy" size={14} />Copy absolute path: {absoluteEntryPath(projectPath, match.path)}
            </button>
          </>
        )}
      </Menu>
    </div>
  )
}

/** The explorer's file-name search results, shown in place of the tree while a query is active. */
export function FileSearchResults({ status, result, error, activeFile, onOpen, projectPath, onCopyPath }: {
  readonly status: 'loading' | 'ready' | 'error'
  readonly result: ProjectSearchResult | null
  readonly error: string | null
  readonly activeFile: string | null
  readonly onOpen: (path: string) => void
  /** The project root, for absolute-path copies. */
  readonly projectPath: string
  readonly onCopyPath: (path: string, absolute: boolean) => void
}) {
  if (status === 'error') return <div className="p-2"><ErrorNotice raw={error ?? ''} /></div>
  if (result === null) {
    return <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-fg-muted" role="status"><Spinner size={13} />Searching…</div>
  }
  return (
    <>
      {result.matches.length === 0 ? (
        <p className="m-0 px-2.5 py-2 text-[13px] text-fg-faint">No matching files</p>
      ) : (
        <ul aria-label="Search results" className="m-0 flex list-none flex-col p-0">
          {result.matches.map((match) => (
            <li key={match.path}>
              <ResultRow match={match} projectPath={projectPath} onCopyPath={onCopyPath} active={match.path === activeFile} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
      {result.truncated ? <p className="m-0 px-2.5 py-2 text-xs text-fg-faint">Results may be incomplete.</p> : null}
    </>
  )
}
