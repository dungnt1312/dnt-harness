import { useEffect, useState } from 'react'
import { useUnsavedChanges } from './unsaved-changes.tsx'
import { setProjectFolders } from '../../lib/api.ts'
import type { AdditionalDirectory, ProjectRow } from '../../lib/types.ts'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { FolderPickerModal } from '../composer/FolderPickerModal.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'

type Access = AdditionalDirectory['access']

const ACCESS_OPTIONS: readonly { readonly value: Access; readonly label: string }[] = [
  { value: 'read', label: 'Read only' },
  { value: 'write', label: 'Read & write' },
]

/** The label for one grant: the referenced project's name, or the folder path. */
function describe(entry: AdditionalDirectory, projects: readonly ProjectRow[]): { readonly label: string; readonly detail?: string; readonly missing: boolean } {
  if (entry.kind === 'path') return { label: entry.path, missing: false }
  const project = projects.find((candidate) => candidate.id === entry.projectId)
  return project === undefined
    ? { label: 'Removed project', detail: entry.projectId, missing: true }
    : { label: project.name, detail: project.path, missing: false }
}

/**
 * Extra folders one project grants its conversations: other projects of the
 * workspace (followed when they move) or any folder on this machine, each
 * read-only or read-write. The server validates every folder; its refusal is
 * shown inline and nothing is saved.
 */
export function ProjectFoldersEditor({ workspaceId, project, projects, onSaved, onCancel, onDirtyChange }: {
  readonly workspaceId: string
  readonly project: ProjectRow
  readonly projects: readonly ProjectRow[]
  readonly onSaved: () => Promise<void>
  readonly onCancel: () => void
  /** Mirrors this editor's draft state to the parent's row guard. */
  readonly onDirtyChange?: (dirty: boolean) => void
}) {
  const [entries, setEntries] = useState<readonly AdditionalDirectory[]>(project.additionalDirectories ?? [])
  const [newPath, setNewPath] = useState('')
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dirty = newPath.trim() !== '' || JSON.stringify(entries) !== JSON.stringify(project.additionalDirectories ?? [])
  const guardDiscard = useUnsavedChanges(dirty)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty])
  useEffect(() => () => onDirtyChange?.(false), [])

  const others = projects.filter((candidate) => candidate.id !== project.id
    && !entries.some((entry) => entry.kind === 'project' && entry.projectId === candidate.id))
  const setAccess = (index: number, access: Access): void =>
    setEntries((all) => all.map((entry, at) => (at === index ? { ...entry, access } : entry)))
  const remove = (index: number): void => setEntries((all) => all.filter((_, at) => at !== index))
  const addPath = (): void => {
    const value = newPath.trim()
    if (value === '') return
    // The same folder twice would be two React rows with one key and a
    // duplicate grant on save; adding it again is simply a no-op.
    if (entries.some((entry) => entry.kind === 'path' && entry.path === value)) { setNewPath(''); return }
    setEntries((all) => [...all, { kind: 'path', path: value, access: 'read' }])
    setNewPath('')
  }
  const save = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      await setProjectFolders(workspaceId, project.id, entries)
      await onSaved()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <p className="m-0 text-xs text-fg-muted">
        Conversations in this project can also use these folders with their file tools. Paths outside them still ask for approval. Shell commands are not confined by this list.
      </p>
      {entries.length === 0 ? <p className="m-0 text-xs text-fg-faint">No extra folders.</p> : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={`Extra folders for ${project.name}`}>
          {entries.map((entry, index) => {
            const view = describe(entry, projects)
            return (
              <li key={`${entry.kind}:${entry.kind === 'path' ? entry.path : entry.projectId}`} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-2.5 py-2">
                <Icon name="folder" size={14} className="shrink-0 text-fg-faint" />
                <span className="min-w-0 flex-1 basis-48">
                  <span className={view.missing ? 'text-sm text-bad' : 'break-all text-sm'}>{view.label}</span>
                  {view.detail !== undefined ? <code className="block break-all font-mono text-xs text-fg-faint">{view.detail}</code> : null}
                </span>
                <Segmented label="Access" value={entry.access} options={ACCESS_OPTIONS} disabled={busy} onChange={(access) => setAccess(index, access)} />
                <IconButton label={`Remove ${view.label}`} disabled={busy} onClick={() => remove(index)}><Icon name="close" size={14} /></IconButton>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-64">
          <TextInput
            mono
            aria-label="Folder to add"
            placeholder="/Users/you/workspace/shared"
            value={newPath}
            disabled={busy}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addPath() } }}
            trailing={<IconButton label="Browse folders" disabled={busy} onClick={() => setPicking(true)}><Icon name="folder" size={15} /></IconButton>}
          />
        </div>
        <Button variant="outline" size="sm" disabled={busy || newPath.trim() === ''} onClick={addPath}><Icon name="plus" size={13} />Add folder</Button>
        {others.length > 0 ? (
          <div className="w-52">
            <Select
              label="Add a project"
              value=""
              options={others.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              onChange={(projectId) => setEntries((all) => [...all, { kind: 'project', projectId, access: 'read' }])}
              renderTrigger={() => <Button variant="outline" size="sm"><Icon name="plus" size={13} />Add a project…</Button>}
            />
          </div>
        ) : null}
      </div>
      {error !== null ? <ErrorNotice raw={error} /> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => guardDiscard(onCancel)}>Cancel</Button>
        <Button variant="primary" size="sm" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save folders'}</Button>
      </div>
      <FolderPickerModal
        open={picking}
        onDismiss={() => setPicking(false)}
        onConfirm={(picked) => { setNewPath(picked); setPicking(false) }}
      />
    </div>
  )
}
