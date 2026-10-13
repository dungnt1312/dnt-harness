import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import type { ProjectSearchResult } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { parentOf } from '../../lib/file-tree.ts'

/** The explorer's file-name search results, shown in place of the tree while a query is active. */
export function FileSearchResults({ status, result, error, activeFile, onOpen }: {
  readonly status: 'loading' | 'ready' | 'error'
  readonly result: ProjectSearchResult | null
  readonly error: string | null
  readonly activeFile: string | null
  readonly onOpen: (path: string) => void
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
          {result.matches.map((match) => {
            const folder = parentOf(match.path)
            return (
              <li key={match.path}>
                <button
                  type="button"
                  title={match.path}
                  onClick={() => onOpen(match.path)}
                  className={cn('flex min-h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[13px] hover:bg-hover', match.path === activeFile && 'bg-hover text-fg')}
                >
                  <FileTypeIcon path={match.name} size={16} />
                  <span className="shrink-0">{match.name}</span>
                  {folder !== '' ? <span className="min-w-0 flex-1 truncate text-fg-faint">{folder}</span> : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {result.truncated ? <p className="m-0 px-2.5 py-2 text-xs text-fg-faint">Results may be incomplete.</p> : null}
    </>
  )
}
