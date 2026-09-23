import { useCallback, useEffect, useState } from 'react'
import { getSessionGrants, HttpError, setSessionGrants } from '../../lib/api.ts'
import type { FolderGrant, SessionGrantsView } from '../../lib/types.ts'
import { cn } from '../../lib/cn.ts'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Menu } from '../ui/Menu.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { FolderPickerModal } from './FolderPickerModal.tsx'

const ACCESS_OPTIONS: readonly { readonly value: FolderGrant['access']; readonly label: string }[] = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read & write' },
]

const sameFolder = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/**
 * Composer chip listing the extra folders this conversation's file tools can
 * use: the project's folders (managed in Settings → Projects) and the
 * conversation's own, which can be added or removed here. `revision` is the
 * latest `session/grants` revision seen on the stream, so an approval that
 * granted a folder shows up without reopening.
 */
export function SessionFoldersChip({ workspaceId, sessionId, revision }: {
  readonly workspaceId: string
  readonly sessionId: string
  readonly revision: number
}) {
  const [view, setView] = useState<SessionGrantsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)
  const [access, setAccess] = useState<FolderGrant['access']>('read')

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await getSessionGrants(workspaceId, sessionId))
    } catch (cause) {
      setError(String(cause))
    }
  }, [workspaceId, sessionId])
  useEffect(() => { void load() }, [load, revision])

  const replace = async (roots: readonly FolderGrant[]): Promise<void> => {
    if (view === null) return
    setBusy(true); setError(null)
    try {
      setView(await setSessionGrants(workspaceId, sessionId, view.revision, roots))
    } catch (cause) {
      // Someone else (an approval) changed the list first: reload, keep the error.
      if (cause instanceof HttpError && cause.status === 409) await load()
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  const own = view?.roots ?? []
  const fromProject = (view?.effective ?? []).filter((root) => !own.some((mine) => sameFolder(mine.path, root.path)))
  const count = view?.effective.length ?? 0

  return (
    <>
      <Menu
        label={count > 0 ? `Extra folders (${count})` : 'Extra folders'}
        panelRole="dialog"
        side="top"
        align="end"
        triggerClassName={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-fg-muted transition-colors hover:bg-hover [@media(pointer:coarse)]:h-11',
          count > 0 && 'text-fg',
        )}
        panelClassName="w-80 p-4"
        trigger={() => <><Icon name="folder" size={15} />{count > 0 ? <span className="font-mono">+{count}</span> : null}</>}
      >
        {() => (
          <div className="flex flex-col gap-3 text-sm">
            <div>
              <p className="m-0 font-semibold">Extra folders</p>
              <p className="m-0 text-xs text-fg-muted">File tools can use these besides the project folder. Other paths ask first; shell commands are not confined.</p>
            </div>
            {fromProject.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="From project settings">
                {fromProject.map((root) => (
                  <li key={root.path} className="flex items-center gap-2 text-xs">
                    <Icon name="folder" size={13} className="shrink-0 text-fg-faint" />
                    <code className="min-w-0 flex-1 break-all font-mono" title={root.path}>{root.path}</code>
                    <span className="shrink-0 text-fg-faint">{root.access === 'write' ? 'read & write' : 'read only'} · project</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {own.length > 0 ? (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="This conversation">
                {own.map((root) => (
                  <li key={root.path} className="flex items-center gap-2 text-xs">
                    <Icon name="folder" size={13} className="shrink-0 text-fg-faint" />
                    <code className="min-w-0 flex-1 break-all font-mono" title={root.path}>{root.path}</code>
                    <span className="shrink-0 text-fg-faint">{root.access === 'write' ? 'read & write' : 'read only'}</span>
                    <IconButton label={`Remove ${root.path}`} disabled={busy} onClick={() => void replace(own.filter((other) => other !== root))}>
                      <Icon name="close" size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : null}
            {count === 0 && view !== null ? <p className="m-0 text-xs text-fg-faint">No extra folders yet.</p> : null}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <Segmented label="Access for a new folder" value={access} options={ACCESS_OPTIONS} onChange={setAccess} />
              <Button variant="outline" size="sm" disabled={busy || view === null} onClick={() => setPicking(true)}>Add folder…</Button>
            </div>
            {error !== null ? <ErrorNotice raw={error} announce={false} /> : null}
          </div>
        )}
      </Menu>
      <FolderPickerModal
        open={picking}
        onDismiss={() => setPicking(false)}
        onConfirm={(picked) => { setPicking(false); void replace([...own, { path: picked, access }]) }}
      />
    </>
  )
}
