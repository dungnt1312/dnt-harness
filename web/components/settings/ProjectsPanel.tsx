import { useEffect, useRef } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { createProject, renameProject, removeProject, setProjectPath } from '../../lib/api.ts'
import type { ProjectRow } from '../../lib/types.ts'
import Icon from '../common/Icon.tsx'
import { ErrorNotice } from '../common/ErrorNotice.tsx'
import { FolderPickerModal } from '../composer/FolderPickerModal.tsx'
import { ProjectFoldersEditor } from './ProjectFoldersEditor.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { EmptyState, InlineConfirm, ItemList, ItemRow, Notice, PanelBody, PanelIntro, Section } from './settings-kit.tsx'

type RowMode = { readonly id: string; readonly kind: 'rename' | 'path' | 'remove' | 'folders' }

/** Which input the folder picker fills: the register form or a row's new path. */
type PickerTarget = 'register' | 'path' | null

export function ProjectsPanel(props: {
  readonly workspaceId: string | null
  readonly projects: readonly ProjectRow[]
  readonly onChanged: () => Promise<void>
  readonly sessionCounts?: Readonly<Record<string, number>>
}) {
  return <ProjectsPanelContent key={props.workspaceId} {...props} />
}

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

function ProjectsPanelContent({ workspaceId, projects, onChanged, sessionCounts = {} }: {
  readonly workspaceId: string | null
  readonly projects: readonly ProjectRow[]
  readonly onChanged: () => Promise<void>
  readonly sessionCounts?: Readonly<Record<string, number>>
}) {
  const [name, setName] = useScopedState('')
  const [path, setPath] = useScopedState('')
  const [busy, setBusy] = useScopedState(false)
  const [error, setError] = useScopedState<string | null>(null)
  const [saved, setSaved] = useScopedState(false)
  const [mode, setMode] = useScopedState<RowMode | null>(null)
  const [editValue, setEditValue] = useScopedState('')
  const [rowErrors, setRowErrors] = useScopedState<Record<string, string>>({})
  const [picker, setPicker] = useScopedState<PickerTarget>(null)
  // A ref, not state: a double click in one frame must not start two requests.
  const lock = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false; lock.current = false }, [])

  const mutate = async (projectId: string, action: () => Promise<unknown>): Promise<void> => {
    if (lock.current || workspaceId === null) return
    lock.current = true; setBusy(true); setError(null); setRowErrors((all) => ({ ...all, [projectId]: '' }))
    try {
      await action()
      if (!alive.current) return
      await onChanged()
      if (!alive.current) return
      setMode(null)
    } catch (cause) {
      setRowErrors((all) => ({ ...all, [projectId]: String(cause) }))
    } finally {
      lock.current = false; setBusy(false)
    }
  }

  const register = async (): Promise<void> => {
    if (workspaceId === null || path.trim() === '' || lock.current) return
    lock.current = true; setBusy(true); setError(null); setSaved(false)
    try {
      await createProject(workspaceId, name.trim() || folderName(path.trim()) || path.trim(), path.trim())
      if (!alive.current) return
      await onChanged()
      if (!alive.current) return
      setPath(''); setName(''); setSaved(true)
    } catch (cause) {
      setError(String(cause))
    } finally {
      lock.current = false; setBusy(false)
    }
  }

  const startMode = (project: ProjectRow, kind: RowMode['kind']): void => {
    setMode({ id: project.id, kind })
    setEditValue(kind === 'rename' ? project.name : kind === 'path' ? project.path : '')
    setRowErrors((all) => ({ ...all, [project.id]: '' }))
  }

  return (
    <PanelBody>
      <PanelIntro>A project is a folder on this machine that conversations can read and change. Registration never changes the scope of an existing conversation.</PanelIntro>

      <Section title="Registered projects" count={projects.length}>
        {projects.length === 0 ? <EmptyState>No projects registered yet.</EmptyState> : (
          <ItemList label="Registered projects">
            {projects.map((project) => {
              const count = sessionCounts[project.id] ?? 0
              const active = mode?.id === project.id ? mode.kind : null
              const rowError = rowErrors[project.id]
              return (
                <ItemRow
                  key={project.id}
                  title={<><Icon name="folder" size={14} className="text-fg-faint" /><span className="break-all">{project.name}</span><span className="text-xs font-normal text-fg-faint">{count} {count === 1 ? 'conversation' : 'conversations'}</span></>}
                  meta={<>
                    <code className="font-mono">{project.path}</code>
                    {(project.additionalDirectories?.length ?? 0) > 0 ? (
                      <span className="ml-2 text-xs text-fg-faint">+{project.additionalDirectories!.length} extra {project.additionalDirectories!.length === 1 ? 'folder' : 'folders'}</span>
                    ) : null}
                  </>}
                  actions={active === null ? (
                    <>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => startMode(project, 'rename')}>Rename</Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => startMode(project, 'path')}>Change folder</Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => startMode(project, 'folders')}>Extra folders</Button>
                      <Button variant="ghost" size="sm" className="text-bad" disabled={busy} onClick={() => startMode(project, 'remove')}>Remove project</Button>
                    </>
                  ) : undefined}
                >
                  {active === 'rename' || active === 'path' ? (
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={(event) => {
                        event.preventDefault()
                        const value = editValue.trim()
                        if (value === '' || workspaceId === null) return
                        void mutate(project.id, () => active === 'rename' ? renameProject(workspaceId, project.id, value) : setProjectPath(workspaceId, project.id, value))
                      }}
                    >
                      <div className="min-w-0 flex-1 basis-64">
                        <TextInput
                          autoFocus
                          mono={active === 'path'}
                          aria-label={active === 'rename' ? 'New project name' : 'New project folder'}
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          trailing={active === 'path' ? <IconButton label="Browse folders" onClick={() => setPicker('path')}><Icon name="folder" size={15} /></IconButton> : undefined}
                        />
                      </div>
                      <Button type="submit" variant="primary" size="sm" disabled={busy || editValue.trim() === ''}>{active === 'rename' ? 'Save name' : 'Save path'}</Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode(null)}>Cancel</Button>
                    </form>
                  ) : null}
                  {active === 'folders' && workspaceId !== null ? (
                    <ProjectFoldersEditor
                      workspaceId={workspaceId}
                      project={project}
                      projects={projects}
                      onSaved={async () => { await onChanged(); if (alive.current) setMode(null) }}
                      onCancel={() => setMode(null)}
                    />
                  ) : null}
                  {active === 'remove' ? (
                    <InlineConfirm
                      message="Remove this registration? Files stay on disk. Removal is refused while any conversation is bound to this project."
                      confirmLabel="Remove registration"
                      cancelLabel="Cancel removal"
                      busy={busy}
                      onConfirm={() => { if (workspaceId !== null) void mutate(project.id, () => removeProject(workspaceId, project.id)) }}
                      onCancel={() => setMode(null)}
                    />
                  ) : null}
                  {rowError ? <ErrorNotice raw={rowError} /> : null}
                </ItemRow>
              )
            })}
          </ItemList>
        )}
      </Section>

      <Section title="Register a folder">
        <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void register() }} aria-busy={busy}>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Project folder" hint="An existing absolute path on this machine.">
              <TextInput
                mono
                value={path}
                placeholder="C:/workspace/project"
                disabled={busy}
                onChange={(event) => setPath(event.target.value)}
                trailing={<IconButton label="Browse folders" disabled={busy} onClick={() => setPicker('register')}><Icon name="folder" size={15} /></IconButton>}
              />
            </Field>
            <Field label="Project name" hint={path.trim() !== '' && name.trim() === '' ? `Optional. Defaults to “${folderName(path.trim())}”.` : 'Optional. Defaults to the folder name.'}>
              <TextInput value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
            </Field>
          </div>
          {error !== null ? <ErrorNotice raw={error} /> : null}
          {saved ? <Notice kind="ok" text="Project registered. Start a new conversation to use it." /> : null}
          <div>
            <Button type="submit" variant="primary" size="sm" disabled={busy || workspaceId === null || path.trim() === ''}>{busy ? 'Registering…' : 'Register project'}</Button>
          </div>
        </form>
      </Section>

      <FolderPickerModal
        open={picker !== null}
        onDismiss={() => setPicker(null)}
        onConfirm={(picked) => {
          if (picker === 'register') { setPath(picked); setSaved(false) }
          else setEditValue(picked)
          setPicker(null)
        }}
      />
    </PanelBody>
  )
}
