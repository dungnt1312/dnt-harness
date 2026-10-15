import { useEffect, useRef, useState } from 'react'
import { deleteWorkspace, HttpError, renameWorkspace, setWorkspaceArchived } from '../../lib/api.ts'
import { useToast } from '../common/Toast.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import ConfirmDialog from '../common/ConfirmDialog.tsx'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu, menuItemClass } from '../ui/Menu.tsx'
import { cn } from '../../lib/cn.ts'
import type { WorkspaceRow } from '../../lib/types.ts'

/** `force-delete` is the second confirm, reached only after a plain delete answered `workspace-not-empty`. */
type PendingAction = { readonly kind: 'archive' | 'delete' | 'force-delete'; readonly workspace: WorkspaceRow }

function isNotEmpty(cause: unknown): boolean {
  if (!(cause instanceof HttpError) || cause.status !== 409) return false
  try { return (JSON.parse(cause.body) as { code?: unknown }).code === 'workspace-not-empty' } catch { return false }
}

/**
 * Workspace switch + manage list: rows with status badges and an action zone
 * (inline rename, Archive/Restore, Delete…). Destructive actions confirm; a
 * 409 keeps the dialog open with the server message.
 */
export function WorkspacePopover({ workspaces, activeWorkspaceId, onSelect, onChanged, newWorkspaceName, onNewWorkspaceName, onCreate }: {
  readonly workspaces: readonly WorkspaceRow[]
  readonly activeWorkspaceId: string | null
  readonly onSelect: (id: string) => void
  readonly onChanged: () => Promise<void>
  readonly newWorkspaceName: string
  readonly onNewWorkspaceName: (value: string) => void
  readonly onCreate: () => void
}) {
  const toast = useToast()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { if (renaming !== null) renameInputRef.current?.focus() }, [renaming])

  const commitRename = async (): Promise<void> => {
    if (renaming === null || busy) return
    const name = renameDraft.trim()
    if (name === '') return
    setBusy(true)
    setRenameError(null)
    try {
      await renameWorkspace(renaming, name)
      await onChanged()
      toast.notify('Workspace renamed.', 'ok')
      setRenaming(null)
    } catch (cause) {
      setRenameError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const runPending = async (): Promise<void> => {
    if (pending === null || busy) return
    setBusy(true)
    setPendingError(null)
    try {
      if (pending.kind === 'archive') {
        const next = !pending.workspace.archived
        await setWorkspaceArchived(pending.workspace.id, next)
        toast.notify(next ? 'Workspace archived.' : 'Workspace restored.', 'ok')
      } else {
        await deleteWorkspace(pending.workspace.id, pending.kind === 'force-delete')
        toast.notify('Workspace deleted.', 'ok')
      }
      await onChanged()
      setPending(null)
    } catch (cause) {
      if (pending.kind === 'delete' && isNotEmpty(cause)) {
        setPending({ kind: 'force-delete', workspace: pending.workspace })
        return
      }
      // Keep the dialog open: the server message is the decision context.
      setPendingError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="px-2.5 pb-1 pt-1.5 text-xs font-medium text-fg-faint">Workspaces</div>
      <div className="flex flex-col gap-px">
        {workspaces.map((row) => renaming === row.id ? (
          <form key={row.id} className="flex flex-col gap-1 p-1" onSubmit={(event) => { event.preventDefault(); void commitRename() }}>
            <div className="flex items-center gap-1">
              <input
                ref={renameInputRef}
                aria-label="Workspace name"
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) } }}
                className="h-8 min-w-0 flex-1 rounded-lg border border-line-strong bg-bg px-2.5 text-sm outline-none"
              />
              <IconButton type="submit" label="Save workspace name" disabled={busy || renameDraft.trim() === ''}><Icon name="check" size={15} /></IconButton>
              <IconButton label="Cancel rename" onClick={() => setRenaming(null)}><Icon name="close" size={15} /></IconButton>
            </div>
            {renameError !== null ? <ErrorNotice raw={renameError} /> : null}
          </form>
        ) : (
          <div key={row.id} className={cn('group flex items-center rounded-lg hover:bg-hover', row.id === activeWorkspaceId && 'bg-hover')}>
            <button type="button" onClick={() => onSelect(row.id)} className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-left text-sm">
              <span className="min-w-0 truncate">{row.name}</span>
              {(row.approvals ?? 0) > 0 ? <Badge tone="amber">{row.approvals} awaiting approval</Badge> : null}
              {(row.running ?? 0) > 0 ? <Badge tone="green">{row.running} running</Badge> : null}
              {row.archived ? <Badge>archived</Badge> : null}
              {row.default === true ? <Badge>default</Badge> : null}
            </button>
            {row.id === activeWorkspaceId ? <Icon name="check" size={15} className="mr-1 shrink-0" /> : null}
            <span className="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 [@media(pointer:coarse)]:opacity-100">
              <Menu label={`Manage ${row.name}`} align="end" triggerClassName="flex size-8 items-center justify-center rounded-md text-fg-muted hover:text-fg" trigger={() => <Icon name="dots" size={16} />}>
                {(close) => (
                  <>
                    <button type="button" role="menuitem" className={menuItemClass} aria-label={`Rename ${row.name}`} onClick={() => { close(); setRenameDraft(row.name); setRenameError(null); setRenaming(row.id) }}>
                      <Icon name="pencil" size={15} className="text-fg-muted" />Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={menuItemClass}
                      disabled={(row.running ?? 0) > 0}
                      title={(row.running ?? 0) > 0 ? 'Stop running sessions first' : undefined}
                      onClick={() => { close(); setPendingError(null); setPending({ kind: 'archive', workspace: row }) }}
                    >
                      <Icon name="archive" size={15} className="text-fg-muted" />{row.archived ? 'Restore' : 'Archive'}
                    </button>
                    <button type="button" role="menuitem" className={cn(menuItemClass, 'text-bad')} onClick={() => { close(); setPendingError(null); setPending({ kind: 'delete', workspace: row }) }}>
                      <Icon name="trash" size={15} />Delete…
                    </button>
                  </>
                )}
              </Menu>
            </span>
          </div>
        ))}
        {workspaces.length === 0 ? <span className="px-2.5 py-2 text-sm text-fg-faint">No workspaces</span> : null}
      </div>
      <form className="mt-1 flex items-center gap-1 border-t border-line p-1 pt-2" onSubmit={(event) => { event.preventDefault(); onCreate() }}>
        <input
          value={newWorkspaceName}
          placeholder="New workspace…"
          aria-label="New workspace name"
          onChange={(event) => onNewWorkspaceName(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-lg bg-muted px-2.5 text-sm outline-none"
        />
        <button type="submit" disabled={newWorkspaceName.trim() === ''} className="h-8 rounded-lg px-3 text-sm font-medium hover:bg-hover disabled:opacity-40">Create</button>
      </form>
      {pending !== null ? (
        <ConfirmDialog
          open
          title={pending.kind === 'archive' ? `${pending.workspace.archived ? 'Restore' : 'Archive'} "${pending.workspace.name}"?` : pending.kind === 'force-delete' ? `Delete non-empty "${pending.workspace.name}"?` : `Delete "${pending.workspace.name}"?`}
          confirmLabel={pending.kind === 'archive' ? (pending.workspace.archived ? 'Restore' : 'Archive') : pending.kind === 'force-delete' ? 'Delete everything' : 'Delete'}
          busy={busy}
          onConfirm={() => void runPending()}
          onDismiss={() => { if (!busy) setPending(null) }}
          body={(
            <>
              {pending.kind === 'archive'
                ? <p className="m-0">Archived workspaces remain in the switcher but stop accepting new sessions and projects. Existing conversations are kept.</p>
                : pending.kind === 'force-delete'
                  ? <p className="m-0">This workspace still has conversations or projects. Deleting it permanently removes all of them and cannot be undone. Project folders on disk are not touched.</p>
                  : <p className="m-0">An empty workspace is deleted right away. If it still has conversations or projects, you will be asked once more before anything is removed.</p>}
              {pendingError !== null ? <ErrorNotice raw={pendingError} /> : null}
            </>
          )}
        />
      ) : null}
    </>
  )
}
