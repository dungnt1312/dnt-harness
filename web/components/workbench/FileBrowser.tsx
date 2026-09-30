import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { listProjectFiles, type ProjectEntry, type ProjectListing } from '../../lib/api.ts'
import { FileTypeIcon } from '../common/FileTypeIcon.tsx'
import { cn } from '../../lib/cn.ts'

interface FolderNode {
  readonly status: 'loading' | 'ready' | 'error'
  readonly listing: ProjectListing | null
  readonly error: string | null
}

/** A collapsible project tree. Folders load one level at a time; files open as tabs. */
export function FileBrowser({ workspaceId, project, activeFile, onOpenFile }: {
  readonly workspaceId: string
  readonly project: { readonly id: string; readonly name: string; readonly path: string }
  readonly activeFile: string | null
  readonly onOpenFile: (path: string) => void
}) {
  const [nodes, setNodes] = useState<Readonly<Record<string, FolderNode>>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const generation = useRef(new Map<string, number>())

  const load = useCallback(async (folder: string) => {
    const request = (generation.current.get(folder) ?? 0) + 1
    generation.current.set(folder, request)
    setNodes((current) => ({ ...current, [folder]: { status: 'loading', listing: current[folder]?.listing ?? null, error: null } }))
    try {
      const listing = await listProjectFiles(workspaceId, project.id, folder)
      if (generation.current.get(folder) !== request) return
      setNodes((current) => ({ ...current, [folder]: { status: 'ready', listing, error: null } }))
    } catch (cause) {
      if (generation.current.get(folder) !== request) return
      setNodes((current) => ({ ...current, [folder]: { status: 'error', listing: current[folder]?.listing ?? null, error: String(cause) } }))
    }
  }, [workspaceId, project.id])

  useEffect(() => { void load('') }, [load])

  const toggle = (folder: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
    if (nodes[folder] === undefined) void load(folder)
  }

  const root = nodes['']

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]">
        <Icon name="folder" size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={project.path}>{project.name}</span>
        <IconButton label="Refresh files" onClick={() => void load('')}><Icon name="refresh" size={14} /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {root?.status === 'error' && root.listing === null ? (
          <div className="flex flex-col items-start gap-2 p-2">
            <ErrorNotice raw={root.error ?? ''} />
            <Button size="sm" variant="outline" onClick={() => void load('')}>Retry</Button>
          </div>
        ) : root === undefined || (root.status === 'loading' && root.listing === null) ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-fg-muted" role="status"><Spinner size={13} />Loading files…</div>
        ) : (
          <FolderRows
            entries={root.listing?.entries ?? []}
            depth={0}
            nodes={nodes}
            open={open}
            activeFile={activeFile}
            onToggle={toggle}
            onOpenFile={onOpenFile}
            onRetry={load}
          />
        )}
      </div>
    </div>
  )
}

function FolderRows({ entries, depth, nodes, open, activeFile, onToggle, onOpenFile, onRetry }: {
  readonly entries: readonly ProjectEntry[]
  readonly depth: number
  readonly nodes: Readonly<Record<string, FolderNode>>
  readonly open: ReadonlySet<string>
  readonly activeFile: string | null
  readonly onToggle: (folder: string) => void
  readonly onOpenFile: (path: string) => void
  readonly onRetry: (folder: string) => void
}) {
  if (entries.length === 0) return <p className="m-0 px-2.5 py-2 text-[13px] text-fg-faint" style={{ paddingLeft: 10 + depth * 14 }}>Empty folder</p>
  return (
    <ul aria-label={depth === 0 ? 'Project files' : undefined} className="m-0 flex list-none flex-col p-0">
      {entries.map((entry) => {
        const expanded = entry.kind === 'dir' && open.has(entry.path)
        const node = nodes[entry.path]
        return (
          <li key={entry.path}>
            <button
              type="button"
              title={entry.path}
              aria-expanded={entry.kind === 'dir' ? expanded : undefined}
              onClick={() => entry.kind === 'dir' ? onToggle(entry.path) : onOpenFile(entry.path)}
              style={{ paddingLeft: 6 + depth * 14 }}
              className={cn('flex min-h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-[13px] hover:bg-hover', entry.path === activeFile && 'bg-hover text-fg')}
            >
              {entry.kind === 'dir'
                ? <Icon name="chevronRight" size={12} className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-90')} />
                : <span aria-hidden="true" className="w-3 shrink-0" />}
              <FileTypeIcon path={entry.name} kind={entry.kind === 'dir' ? 'folder' : 'file'} open={expanded} size={16} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
            {expanded ? (
              node?.status === 'error' && node.listing === null ? (
                <div className="flex items-center gap-2 py-1 pr-2" style={{ paddingLeft: 24 + depth * 14 }}>
                  <span className="text-xs text-bad">Could not load</span>
                  <Button size="sm" variant="outline" onClick={() => onRetry(entry.path)}>Retry</Button>
                </div>
              ) : node === undefined || (node.status === 'loading' && node.listing === null) ? (
                <div className="flex items-center gap-2 py-1 text-xs text-fg-muted" style={{ paddingLeft: 24 + depth * 14 }} role="status"><Spinner size={12} />Loading…</div>
              ) : (
                <FolderRows
                  entries={node.listing?.entries ?? []}
                  depth={depth + 1}
                  nodes={nodes}
                  open={open}
                  activeFile={activeFile}
                  onToggle={onToggle}
                  onOpenFile={onOpenFile}
                  onRetry={onRetry}
                />
              )
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
