import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { createProjectEntry, deleteProjectEntry, listProjectFiles, renameProjectEntry, type ProjectEntry } from '../../lib/api.ts'
import { ancestorsOf, dropKeysUnder, dropUnderSet, isAtOrUnder, joinPath, parentOf, targetFolder, writeErrorText, type Selection } from '../../lib/file-tree.ts'
import { FolderRows, type FolderNode, type TreeActions, type TreeEditor } from './FileTreeRows.tsx'

interface DeleteRequest {
  readonly entry: ProjectEntry
  readonly busy: boolean
  readonly error: string | null
}

/** A collapsible project tree. Folders load one level at a time; files open as tabs; rows create, rename and delete. */
export function FileBrowser({ workspaceId, project, activeFile, onOpenFile, onRenamed, onRemoved }: {
  readonly workspaceId: string
  readonly project: { readonly id: string; readonly name: string; readonly path: string }
  readonly activeFile: string | null
  readonly onOpenFile: (path: string) => void
  readonly onRenamed: (from: string, to: string) => void
  readonly onRemoved: (path: string) => void
}) {
  const [nodes, setNodes] = useState<Readonly<Record<string, FolderNode>>>({})
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [selected, setSelected] = useState<Selection | null>(null)
  const [editor, setEditor] = useState<TreeEditor | null>(null)
  const [deleting, setDeleting] = useState<DeleteRequest | null>(null)
  const generation = useRef(new Map<string, number>())
  const nextEditorId = useRef(0)
  /** Latest `open`, for async handlers that must not read the value captured before an await. */
  const openNow = useRef(open)
  openNow.current = open

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

  /** Forget everything cached at or under `path`; listings still in flight for it are ignored. */
  const forget = (path: string): void => {
    for (const [folder, request] of generation.current) if (isAtOrUnder(folder, path)) generation.current.set(folder, request + 1)
    setNodes((current) => dropKeysUnder(current, path))
    setOpen((current) => dropUnderSet(current, path))
  }

  /** Close the editor, unless a newer one already replaced it. */
  const closeEditor = (finished: TreeEditor): void => setEditor((current) => current === finished ? null : current)

  const toggle = (folder: string): void => {
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      return next
    })
    if (nodes[folder] === undefined) void load(folder)
  }

  const startCreate = (kind: 'file' | 'dir'): void => {
    const folder = targetFolder(selected)
    const chain = ancestorsOf(folder)
    if (chain.length > 0) setOpen((current) => new Set([...current, ...chain]))
    for (const ancestor of chain) if (nodes[ancestor] === undefined) void load(ancestor)
    setEditor({ id: nextEditorId.current++, mode: 'create', folder, kind })
  }

  // Both submit handlers resolve (never reject) and unmount their editor on
  // success before reloading, so the input is never left disabled.
  const submitCreate = async (name: string): Promise<string | null> => {
    if (editor?.mode !== 'create') return null
    const { folder, kind } = editor
    const path = joinPath(folder, name)
    try {
      await createProjectEntry(workspaceId, project.id, path, kind)
    } catch (cause) {
      return writeErrorText(cause)
    }
    closeEditor(editor)
    setSelected({ path, kind })
    await load(folder)
    if (kind === 'file') onOpenFile(path)
    return null
  }

  const submitRename = async (entry: ProjectEntry, name: string): Promise<string | null> => {
    const current = editor
    let renamed: string
    try {
      renamed = (await renameProjectEntry(workspaceId, project.id, entry.path, name)).path
    } catch (cause) {
      return writeErrorText(cause)
    }
    const wasOpen = entry.kind === 'dir' && openNow.current.has(entry.path)
    if (current !== null) closeEditor(current)
    forget(entry.path)
    if (wasOpen) setOpen((now) => new Set(now).add(renamed))
    setSelected((now) => now !== null && isAtOrUnder(now.path, entry.path) ? { ...now, path: `${renamed}${now.path.slice(entry.path.length)}` } : now)
    onRenamed(entry.path, renamed)
    await load(parentOf(entry.path))
    if (wasOpen) await load(renamed)
    return null
  }

  const confirmDelete = async (): Promise<void> => {
    if (deleting === null || deleting.busy) return
    const { entry } = deleting
    setDeleting({ entry, busy: true, error: null })
    try {
      await deleteProjectEntry(workspaceId, project.id, entry.path)
    } catch (cause) {
      setDeleting({ entry, busy: false, error: writeErrorText(cause) })
      return
    }
    setDeleting(null)
    forget(entry.path)
    setSelected((now) => now !== null && isAtOrUnder(now.path, entry.path) ? null : now)
    setEditor((now) => now !== null && isAtOrUnder(now.mode === 'create' ? now.folder : now.path, entry.path) ? null : now)
    onRemoved(entry.path)
    await load(parentOf(entry.path))
  }

  const actions: TreeActions = {
    nodes,
    open,
    activeFile,
    selected,
    editor,
    activate: (entry) => {
      setSelected({ path: entry.path, kind: entry.kind })
      if (entry.kind === 'dir') toggle(entry.path)
      else onOpenFile(entry.path)
    },
    retry: (folder) => void load(folder),
    beginRename: (entry) => setEditor({ id: nextEditorId.current++, mode: 'rename', path: entry.path }),
    beginDelete: (entry) => setDeleting({ entry, busy: false, error: null }),
    submitCreate,
    submitRename,
    cancelEdit: () => setEditor(null),
  }

  const root = nodes['']

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line px-2.5 text-[13px]">
        <Icon name="folder" size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate font-medium" title={project.path}>{project.name}</span>
        <IconButton label="New file" onClick={() => startCreate('file')}><Icon name="plus" size={14} /></IconButton>
        <IconButton label="New folder" onClick={() => startCreate('dir')}><Icon name="folder" size={14} /></IconButton>
        <IconButton label="Refresh files" onClick={() => void load('')}><Icon name="refresh" size={14} /></IconButton>
      </div>
      {/* Task 7 places the file search box here, between the header and the tree. */}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {root?.status === 'error' && root.listing === null ? (
          <div className="flex flex-col items-start gap-2 p-2">
            <ErrorNotice raw={root.error ?? ''} />
            <Button size="sm" variant="outline" onClick={() => void load('')}>Retry</Button>
          </div>
        ) : root === undefined || (root.status === 'loading' && root.listing === null) ? (
          <div className="flex items-center gap-2 px-2.5 py-2 text-sm text-fg-muted" role="status"><Spinner size={13} />Loading files…</div>
        ) : (
          <FolderRows folder="" entries={root.listing?.entries ?? []} depth={0} actions={actions} />
        )}
      </div>
      {deleting !== null ? (
        <ConfirmDialog
          open
          title={`Delete ${deleting.entry.name}?`}
          confirmLabel="Delete"
          tone="danger"
          busy={deleting.busy}
          onConfirm={() => void confirmDelete()}
          onDismiss={() => { if (!deleting.busy) setDeleting(null) }}
          body={(
            <>
              <p className="m-0">{deleting.entry.kind === 'dir' ? 'This folder and everything inside it will be deleted permanently.' : 'This file will be deleted permanently.'}</p>
              {deleting.error !== null ? <ErrorNotice raw={deleting.error} /> : null}
            </>
          )}
        />
      ) : null}
    </div>
  )
}
