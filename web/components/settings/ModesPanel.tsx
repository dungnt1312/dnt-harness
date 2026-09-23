import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { KNOWN_MODE_TOOLS, emptyModeForm, parseModeForm, permissionKeyError, serializeModeForm, type ModeForm } from '../../lib/mode-form.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Select } from '../ui/Select.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteModeFile, duplicateModeFile, getModeFile, listModeFiles, listModes, saveModeFile, setModeEnabled } from '../../lib/api.ts'
import type { ModeCatalogRow, PolicyMode } from '../../lib/types.ts'
import {
  CodeArea,
  EmptyState,
  InlineConfirm,
  ItemList,
  ItemRow,
  Notice,
  PanelBody,
  PanelIntro,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'

const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

const PERMISSION_SEGMENTS = (['allow', 'ask', 'deny'] as const).map((mode) => ({ value: mode, label: mode[0]?.toUpperCase() + mode.slice(1) }))

/**
 * What a mode grants, in one line: the gate's own entries grouped by decision.
 * Deliberately a listing, not a resolution — the order the gate resolves keys
 * in (exact, then `mcp__server__*`, then `*`) lives in one place on the server.
 */
function permissionSummary(permissions: Record<string, PolicyMode>): string {
  const groups: readonly PolicyMode[] = ['allow', 'ask', 'deny']
  const parts = groups
    .map((decision) => {
      const tools = Object.entries(permissions).filter(([, value]) => value === decision).map(([tool]) => tool)
      return tools.length === 0 ? null : `${decision}: ${tools.join(', ')}`
    })
    .filter((part) => part !== null)
  return parts.length === 0 ? 'No permissions — every tool falls to the host default.' : parts.join(' · ')
}

/**
 * Modes define the permission defaults and tool exposure for conversations in
 * this workspace. This panel is where those defaults are authored, as a form —
 * the server still validates the generated file on every save. Bundled modes
 * are read-only constants; Duplicate copies one into the workspace as a file
 * you own. An edit applies when the mode is next selected — a running
 * conversation keeps the snapshot it adopted.
 */
export function ModesPanel(props: { readonly workspaceId: string | null; readonly onChanged?: () => Promise<void> | void }) {
  return <ModesPanelContent key={props.workspaceId} {...props} />
}

interface EditingMode {
  readonly id: string
  readonly isNew: boolean
  readonly hash: string | null
  /** Canonical serialization of the loaded file; the dirty check compares against it. */
  readonly baseline: string
}

function ModesPanelContent({ workspaceId, onChanged }: { readonly workspaceId: string | null; readonly onChanged?: () => Promise<void> | void }) {
  const [rows, setRows] = useScopedState<readonly ModeCatalogRow[]>([])
  const [selected, setSelected] = useScopedState<string | null>(null)
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [editing, setEditing] = useScopedState<EditingMode | null>(null)
  const [draft, setDraft] = useScopedState<ModeForm>(emptyModeForm)
  const [newId, setNewId] = useScopedState('')
  const [conflict, setConflict] = useScopedState<string | null>(null)
  const [deleteId, setDeleteId] = useScopedState<string | null>(null)
  const [copying, setCopying] = useScopedState<{ readonly from: string; readonly to: string } | null>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async () => {
    if (workspaceId === null) return
    try {
      const [catalog, selection] = await Promise.all([listModeFiles(workspaceId), listModes(workspaceId)])
      // The server catalog is normally ordered this way too, but preserve the
      // Settings contract if a future catalog source changes its ordering.
      setRows([...catalog].sort((left, right) => Number(left.source === 'workspace') - Number(right.source === 'workspace')))
      setSelected(selection.selected)
    } catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const loadEditor = async (id: string): Promise<void> => {
    const loaded = await getModeFile(workspaceId, id)
    const form = parseModeForm(loaded.raw)
    setDraft(form)
    setEditing({ id, isNew: false, hash: loaded.hash ?? null, baseline: serializeModeForm(form) })
    setConflict(null)
  }

  const openEditor = (row: ModeCatalogRow): Promise<void> => run(`open:${row.id}`, async () => {
    setNotice(null)
    await loadEditor(row.id)
  })

  const beginNew = (): void => {
    const form = emptyModeForm()
    setDraft(form)
    setEditing({ id: '', isNew: true, hash: null, baseline: serializeModeForm(form) })
    setNewId('')
    setConflict(null)
    setNotice(null)
  }

  const closeEditor = (): void => { setEditing(null); setConflict(null) }

  const id = editing === null ? '' : editing.isNew ? newId.trim() : editing.id
  const dirty = editing !== null && serializeModeForm(draft) !== editing.baseline

  const save = (): Promise<void> => run('save', async () => {
    if (editing === null) return
    try {
      const saved = await saveModeFile(workspaceId, id, serializeModeForm(draft), editing.hash ?? undefined)
      setNotice({ kind: 'ok', text: `Saved ${saved.name}. It applies when this mode is next selected.` })
      closeEditor()
      await refresh()
      await onChanged?.()
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(id)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (conflict === null) return
    const fresh = await getModeFile(workspaceId, conflict)
    const saved = await saveModeFile(workspaceId, conflict, serializeModeForm(draft), fresh.hash)
    setNotice({ kind: 'ok', text: `Saved ${saved.name}. It applies when this mode is next selected.` })
    closeEditor()
    await refresh()
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (conflict === null) return
    await loadEditor(conflict)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const duplicate = (): Promise<void> => run('duplicate', async () => {
    if (copying === null) return
    const copy = await duplicateModeFile(workspaceId, copying.from, copying.to.trim())
    setCopying(null)
    await refresh()
    await loadEditor(copy.id)
    await onChanged?.()
    setNotice({ kind: 'ok', text: `Copied ${copying.from} to ${copy.id}. Edit it below, then select it in the composer.` })
  })

  const remove = (row: ModeCatalogRow): Promise<void> => run(`delete:${row.id}`, async () => {
    await deleteModeFile(workspaceId, row.id)
    setDeleteId(null)
    setNotice({ kind: 'ok', text: `Deleted ${row.id}.` })
    await refresh()
    await onChanged?.()
  })

  const toggle = (row: ModeCatalogRow): Promise<void> => run(`toggle:${row.id}`, async () => {
    const next = !(row.enabled ?? true)
    await setModeEnabled(workspaceId, row.id, next)
    setNotice({
      kind: 'ok',
      text: next ? `${row.name} is back in the composer picker.` : `${row.name} is hidden from the composer picker.`,
    })
    await refresh()
    await onChanged?.()
  })

  /** The picker checkbox: checked means the composer offers this mode. */
  const pickerCheckbox = (row: ModeCatalogRow): ReactNode => (
    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted" title="Show in the composer picker">
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        aria-label={`Offer ${row.id} in the composer picker`}
        checked={row.enabled ?? true}
        disabled={busy !== null}
        onChange={() => void toggle(row)}
      />
      In picker
    </label>
  )

  return (
    <PanelBody>
      <PanelIntro>
        A mode defines the permission defaults and tool exposure for conversations in this workspace. The
        composer selects one; this is where they are written. Bundled modes are read-only: duplicate one to
        customize it. Untick “In picker” to hide a mode from the composer (a selected mode must be moved off
        first); a saved edit applies when the mode is next selected.
      </PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      {editing === null ? (
        <Section
          title="Modes"
          count={rows.length}
          actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={beginNew}><Icon name="plus" size={13} />New mode</Button>}
        >
          {rows.length === 0 ? <EmptyState>No modes in this workspace.</EmptyState> : (
            <ItemList label="Modes">
              {rows.map((row) => (
                <ItemRow
                  key={row.id}
                  title={(
                    <>
                      <span className={row.enabled === false ? 'break-all text-fg-faint' : 'break-all'}>{row.name}</span>
                      <Badge tone={row.source === 'workspace' ? 'blue' : 'gray'}>{row.source}</Badge>
                      {row.id === selected ? <Badge tone="green">selected</Badge> : null}
                    </>
                  )}
                  meta={permissionSummary(row.permissionDefaults)}
                  actions={row.source === 'workspace' ? (
                    <>
                      {pickerCheckbox(row)}
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void openEditor(row)}>{busy === `open:${row.id}` ? 'Opening…' : 'Edit'}</Button>
                      <IconButton label={`Delete ${row.id}`} disabled={busy !== null} onClick={() => setDeleteId(row.id)}><Icon name="trash" size={14} /></IconButton>
                    </>
                  ) : (
                    <>
                      <Badge tone="gray">Read-only</Badge>
                      {pickerCheckbox(row)}
                      <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setNotice(null); setCopying({ from: row.id, to: `${row.id}-custom` }) }}>Duplicate</Button>
                    </>
                  )}
                >
                  {copying?.from === row.id ? (
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="min-w-0 flex-1 basis-48">
                        <Field
                          label="New mode id"
                          hint="Kebab-case, e.g. plan-strict. The server validates the id and reports any issue."
                        >
                          <TextInput mono value={copying.to} onChange={(e) => setCopying({ from: row.id, to: e.target.value })} />
                        </Field>
                      </div>
                      <div className="flex gap-2 pb-1">
                        <Button variant="primary" size="sm" disabled={busy !== null || copying.to.trim() === ''} onClick={() => void duplicate()}>
                          {busy === 'duplicate' ? 'Copying…' : 'Duplicate'}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setCopying(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : null}
                  {deleteId === row.id ? (
                    <InlineConfirm
                      message={row.id === selected
                        ? `Delete “${row.id}”? The workspace's active cached snapshot remains until another mode is selected.`
                        : `Delete “${row.id}”? Its file is removed from this workspace.`}
                      confirmLabel="Delete permanently"
                      busy={busy === `delete:${row.id}`}
                      onConfirm={() => void remove(row)}
                      onCancel={() => setDeleteId(null)}
                    />
                  ) : null}
                </ItemRow>
              ))}
            </ItemList>
          )}
        </Section>
      ) : (
        <Section
          title={editing.isNew ? 'New mode' : `Edit ${editing.id}`}
          actions={<Button variant="ghost" size="sm" disabled={busy !== null} onClick={closeEditor}><Icon name="chevronRight" size={13} className="rotate-180" />Back to list</Button>}
        >
          <ModeEditor draft={draft} onDraft={setDraft} disabled={busy !== null} isNew={editing.isNew} newId={newId} onNewId={setNewId} />
          {conflict ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <span className="min-w-0 flex-1 basis-48">The file changed on disk since you opened it.</span>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadServer()}>Reload server version</Button>
              <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null || id === '' || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save mode'}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={closeEditor}>Cancel</Button>
          </div>
        </Section>
      )}
    </PanelBody>
  )
}

/** One permission row: the key, its remove action, and the Allow/Ask/Deny control. */
function PermissionRow({ label, code, value, disabled, onSet, onRemove }: {
  readonly label: string
  readonly code: string
  readonly value: PolicyMode | null
  readonly disabled: boolean
  readonly onSet: (mode: PolicyMode) => void
  readonly onRemove?: (() => void) | undefined
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1">
        <code className="truncate text-[13px]" title={code}>{label}</code>
        {onRemove !== undefined && value !== null ? (
          <IconButton label={`Remove the ${code} entry`} disabled={disabled} onClick={onRemove}><Icon name="close" size={12} /></IconButton>
        ) : null}
      </span>
      <Segmented label={`Permission for ${code}`} value={value} options={PERMISSION_SEGMENTS} onChange={onSet} />
    </div>
  )
}

/** The structured editor: identity, instructions, context sources, exposure, permissions. */
function ModeEditor({ draft, onDraft, disabled, isNew, newId, onNewId }: {
  readonly draft: ModeForm
  readonly onDraft: (next: ModeForm) => void
  readonly disabled: boolean
  readonly isNew: boolean
  readonly newId: string
  readonly onNewId: (next: string) => void
}) {
  const [adding, setAdding] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const patch = (part: Partial<ModeForm>): void => onDraft({ ...draft, ...part })
  const setPermission = (key: string, mode: PolicyMode | null): void => {
    const permissions = { ...draft.permissions }
    if (mode === null) delete permissions[key]
    else permissions[key] = mode
    patch({ permissions })
  }
  const addKey = (): void => {
    const key = adding.trim()
    if (key === '') return
    if (draft.permissions[key] !== undefined) {
      setAddError(`"${key}" already has an entry.`)
      return
    }
    const keyError = permissionKeyError(key)
    if (keyError !== null) {
      setAddError(keyError)
      return
    }
    setAddError(null)
    setPermission(key, 'ask')
    setAdding('')
  }
  const toggleExposure = (tool: string, exposed: boolean): void => {
    patch({ exposure: exposed ? [...draft.exposure, tool] : draft.exposure.filter((name) => name !== tool) })
  }

  const customKeys = Object.keys(draft.permissions)
    .filter((key) => key !== '*' && !KNOWN_MODE_TOOLS.includes(key))
    .sort((left, right) => left.localeCompare(right))

  return (
    <div className="flex flex-col gap-5">
      {isNew ? (
        <Field label="Mode id" hint="Kebab-case file name, e.g. review-only. The server validates the id and reports any issue.">
          <TextInput mono value={newId} placeholder="review-only" onChange={(e) => onNewId(e.target.value)} />
        </Field>
      ) : null}
      <Field label="Name" hint="Shown in the composer's mode menu.">
        <TextInput value={draft.name} placeholder="Review only" onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      <Field label="Instructions" hint="System-level guidance injected for every request while this mode is selected.">
        <CodeArea tall value={draft.instructions} placeholder="Read the workspace and report what you find. Do not change anything." onChange={(e) => patch({ instructions: e.target.value })} />
      </Field>

      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium text-fg">Context sources</span>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1 basis-44">
            <Field label="History">
              <Select
                label="History"
                value={draft.history}
                options={[{ value: 'none', label: 'None' }, { value: 'recent', label: 'Recent' }, { value: 'compact', label: 'Compact' }]}
                onChange={(value) => patch({ history: value as ModeForm['history'] })}
              />
            </Field>
          </div>
          <div className="min-w-0 flex-1 basis-44">
            <Field label="Skills">
              <Select
                label="Skills"
                value={draft.skills}
                options={[{ value: 'off', label: 'Off' }, { value: 'on-demand', label: 'On demand' }]}
                onChange={(value) => patch({ skills: value as ModeForm['skills'] })}
              />
            </Field>
          </div>
        </div>
        <Switch label="Workspace instructions" hint="Load workspace and project instruction files." checked={draft.workspaceInstructions} disabled={disabled} onChange={(next) => patch({ workspaceInstructions: next })} />
        <Switch label="Pinned memory" hint="Pinned memory entries load automatically." checked={draft.memoryPinned} disabled={disabled} onChange={(next) => patch({ memoryPinned: next })} />
        <Switch label="Memory retrieval" hint="Memory search stays available as a tool." checked={draft.memoryRetrieval} disabled={disabled} onChange={(next) => patch({ memoryRetrieval: next })} />
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium text-fg">Tool exposure</span>
        <p className="m-0 text-xs text-fg-faint">The hard ceiling of tools this mode may call — a permission cannot grant a tool the mode does not expose.</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-3">
          {KNOWN_MODE_TOOLS.map((tool) => (
            <Switch key={tool} label={tool} checked={draft.exposure.includes(tool)} disabled={disabled} onChange={(next) => toggleExposure(tool, next)} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <span className="text-[13px] font-medium text-fg">Permissions</span>
        <p className="m-0 text-xs text-fg-faint">Defaults applied when this mode is selected. Unset tools fall to the catch-all, then the host default.</p>
        <div className="flex flex-col gap-1.5">
          <PermissionRow label="Everything else" code="*" value={draft.permissions['*'] ?? null} disabled={disabled} onSet={(mode) => setPermission('*', mode)} onRemove={() => setPermission('*', null)} />
          {KNOWN_MODE_TOOLS.map((tool) => (
            <PermissionRow key={tool} label={tool} code={tool} value={draft.permissions[tool] ?? null} disabled={disabled} onSet={(mode) => setPermission(tool, mode)} onRemove={() => setPermission(tool, null)} />
          ))}
          {customKeys.map((key) => (
            <PermissionRow key={key} label={key} code={key} value={draft.permissions[key] ?? null} disabled={disabled} onSet={(mode) => setPermission(key, mode)} onRemove={() => setPermission(key, null)} />
          ))}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <Field label="Add permission key" hint="A tool name, mcp__server__tool, mcp__server__*, or * for everything else.">
              <TextInput mono value={adding} placeholder="mcp__github__*" onChange={(e) => { setAdding(e.target.value); setAddError(null) }} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addKey() } }} />
            </Field>
          </div>
          <Button variant="outline" size="sm" className="mt-6" disabled={disabled || adding.trim() === ''} onClick={addKey}>Add</Button>
        </div>
        {addError !== null ? <p className="m-0 text-xs text-bad" role="alert">{addError}</p> : null}
      </div>
    </div>
  )
}
