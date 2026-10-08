import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { Markdown } from '../../Markdown.tsx'
import Icon, { type IconName } from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Select } from '../ui/Select.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { createMemory, deleteMemory, readMemory, searchMemory, updateMemory } from '../../lib/api.ts'
import type { MemoryEntryRow, ProjectRow } from '../../lib/types.ts'
import {
  CodeArea,
  InlineConfirm,
  Notice,
  PanelBody,
  PanelIntro,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
  ConflictBanner,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

/** One tree row: fixed height, full-width hover; callers add the indent. */
const TREE_ROW = 'flex h-7 w-full min-w-0 items-center pr-3 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-link'
const WORKSPACE_FILTER = 'workspace'

/** kebab-case id from a title (memory create uses it as the entry id). */
function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

/** Icon, colour and label per frontmatter `metadata.type`, so kinds read at a glance. */
const TYPE_ICON: Readonly<Record<NonNullable<MemoryEntryRow['type']>, { readonly icon: IconName; readonly className: string; readonly label: string }>> = {
  user: { icon: 'user', className: 'text-tool-agent', label: 'User' },
  feedback: { icon: 'messageSquare', className: 'text-warn', label: 'Feedback' },
  project: { icon: 'layers', className: 'text-tool-edit', label: 'Project' },
  reference: { icon: 'bookmark', className: 'text-link', label: 'Reference' },
}

/** The entry's kind icon; an untyped file keeps the plain document icon. */
function EntryIcon({ type, size }: { readonly type: MemoryEntryRow['type']; readonly size: number }) {
  const kind = type === undefined ? undefined : TYPE_ICON[type]
  if (kind === undefined) return <Icon name="fileText" size={size} className="shrink-0 text-fg-faint" />
  return (
    <span className="flex shrink-0" title={kind.label} data-memory-type={type}>
      <Icon name={kind.icon} size={size} className={kind.className} />
    </span>
  )
}

/** `null` is the workspace tier; a project id is that project's tier. */
type Tier = string | null
const tierKey = (tier: Tier): string => tier ?? ''

interface MemoryGroup {
  readonly key: string
  readonly label: string
  readonly tier: Tier
  readonly rows: readonly MemoryEntryRow[]
}

interface EntryDraft {
  readonly title: string
  readonly body: string
  readonly pinned: boolean
}

interface EditState {
  readonly isNew: boolean
  readonly id: string
  readonly tier: Tier
  readonly hash: string | null
  readonly loaded: EntryDraft
}

/**
 * Memory settings, laid out like Skills: a tier-grouped tree (workspace memory,
 * then one group per project) with search and a tier filter, and a detail pane
 * that previews the entry first — Edit opens the form. Both tiers are listed
 * together because the agent writes to the project tier while a conversation is
 * bound to a project, so the workspace tier alone looks empty. Edits are
 * expectedHash-guarded: a conflict offers Reload (server wins) or Overwrite.
 */
export function MemoryPanel(props: {
  readonly workspaceId: string | null
  /** Projects of this workspace; each owns a memory tier next to the workspace one. */
  readonly projects?: readonly ProjectRow[]
}) {
  return <MemoryPanelContent key={props.workspaceId} {...props} />
}

function MemoryPanelContent({ workspaceId, projects = [] }: {
  readonly workspaceId: string | null
  readonly projects?: readonly ProjectRow[]
}) {
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  /** Entries per tier, keyed by {@link tierKey}. */
  const [tiers, setTiers] = useScopedState<Readonly<Record<string, readonly MemoryEntryRow[]>>>({})
  const [selected, setSelected] = useScopedState<{ readonly id: string; readonly tier: Tier } | null>(null)
  const [detail, setDetail] = useScopedState<MemoryEntryRow | null>(null)
  const [editing, setEditing] = useScopedState<EditState | null>(null)
  const [draft, setDraft] = useScopedState<EntryDraft>({ title: '', body: '', pinned: false })
  const [conflict, setConflict] = useScopedState(false)
  const [confirmDelete, setConfirmDelete] = useScopedState(false)
  const [collapsedGroups, setCollapsedGroups] = useScopedState<ReadonlySet<string>>(new Set<string>())
  const [search, setSearch] = useScopedState('')
  const [tierFilter, setTierFilter] = useScopedState<string>('all')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  // The `projects` default builds a new array every render, so the effect keys
  // on the ids instead of the array's identity.
  const projectKey = projects.map((project) => project.id).join('\n')

  const refresh = useCallback(async (): Promise<void> => {
    if (workspaceId === null) return
    try {
      const projectIds = projectKey === '' ? [] : projectKey.split('\n')
      const [workspaceRows, ...projectRows] = await Promise.all([
        searchMemory(workspaceId, '', null),
        // A project that vanished mid-flight must not blank the other tiers.
        ...projectIds.map((id) => searchMemory(workspaceId, '', id).catch(() => [] as MemoryEntryRow[])),
      ])
      setTiers({ '': workspaceRows ?? [], ...Object.fromEntries(projectIds.map((id, index) => [id, projectRows[index] ?? []])) })
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    }
  }, [workspaceId, projectKey])

  useEffect(() => { void refresh() }, [refresh])

  const guardDiscard = useUnsavedChanges(editing !== null && (
    draft.title !== editing.loaded.title || draft.body !== editing.loaded.body || draft.pinned !== editing.loaded.pinned
  ))

  if (workspaceId === null) return <WorkspaceRequired />

  const tierLabel = (tier: Tier): string =>
    tier === null ? 'Workspace' : projects.find((project) => project.id === tier)?.name ?? tier
  const tierOptions = [
    { value: '', label: 'Workspace (shared by every project)' },
    ...projects.map((project) => ({ value: project.id, label: `Project: ${project.name}` })),
  ]

  /** Workspace tier first, then projects in the workspace's order; empty groups drop. */
  const groups: readonly MemoryGroup[] = [
    { key: '', label: 'Workspace memory', tier: null as Tier, rows: tiers[''] ?? [] },
    ...projects.map((project) => ({ key: project.id, label: project.name, tier: project.id as Tier, rows: tiers[project.id] ?? [] })),
  ].filter((group) => group.rows.length > 0)

  const visibleGroups = groups
    .filter((group) => tierFilter === 'all' || (tierFilter === WORKSPACE_FILTER ? group.tier === null : group.tier === tierFilter))
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => search === '' || `${row.title}\n${row.id}\n${row.body}`.toLowerCase().includes(search.toLowerCase())),
    }))
    .filter((group) => group.rows.length > 0)
  const totalEntries = groups.reduce((sum, group) => sum + group.rows.length, 0)

  const toggleGroup = (key: string): void => {
    const next = new Set(collapsedGroups)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCollapsedGroups(next)
  }

  const openDetail = (tier: Tier, row: MemoryEntryRow): Promise<void> => run(`open:${tierKey(tier)}:${row.id}`, async () => {
    setNotice(null)
    setConflict(false)
    setConfirmDelete(false)
    setSelected({ id: row.id, tier })
    setEditing(null)
    setDetail(await readMemory(workspaceId, row.id, tier))
  })

  const beginNew = (): void => {
    // A new entry lands in the tier being looked at: the filter, else the open entry's.
    const tier: Tier = tierFilter === 'all' ? selected?.tier ?? null : tierFilter === WORKSPACE_FILTER ? null : tierFilter
    const blank = { title: '', body: '', pinned: false }
    setSelected(null)
    setDetail(null)
    setEditing({ isNew: true, id: '', tier, hash: null, loaded: blank })
    setDraft(blank)
    setConflict(false)
    setConfirmDelete(false)
    setNotice(null)
  }

  const beginEdit = (entry: MemoryEntryRow, tier: Tier): void => {
    const loaded = { title: entry.title, body: entry.body, pinned: entry.pinned }
    setEditing({ isNew: false, id: entry.id, tier, hash: entry.hash, loaded })
    setDraft(loaded)
    setConflict(false)
    setConfirmDelete(false)
  }

  const newId = slugify(draft.title)
  const idTaken = editing?.isNew === true && newId !== '' && (tiers[tierKey(editing.tier)] ?? []).some((row) => row.id === newId)
  const unchanged = editing !== null && !editing.isNew
    && draft.title === editing.loaded.title && draft.body === editing.loaded.body && draft.pinned === editing.loaded.pinned
  const cannotSave = draft.title.trim() === '' || draft.body.trim() === '' || (editing?.isNew === true && newId === '') || idTaken || unchanged

  const save = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (editing === null) return
    if (editing.isNew) {
      const created = await createMemory(workspaceId, { id: newId, title: draft.title.trim(), body: draft.body, ...(draft.pinned ? { pinned: true } : {}) }, editing.tier)
      setNotice({ kind: 'ok', text: `Created ${created.id}.` })
      setEditing(null)
      setSelected({ id: created.id, tier: editing.tier })
      setDetail(created)
      await refresh()
      return
    }
    try {
      const updated = await updateMemory(workspaceId, editing.id, {
        expectedHash: hashOverride ?? editing.hash ?? '',
        title: draft.title,
        body: draft.body,
        pinned: draft.pinned,
      }, editing.tier)
      setNotice({ kind: 'ok', text: `Saved ${updated.id}.` })
      setEditing(null)
      setConflict(false)
      setDetail(updated)
      await refresh()
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (editing === null || editing.isNew) return
    const fresh = await readMemory(workspaceId, editing.id, editing.tier)
    const updated = await updateMemory(workspaceId, editing.id, { expectedHash: fresh.hash, title: draft.title, body: draft.body, pinned: draft.pinned }, editing.tier)
    setNotice({ kind: 'ok', text: `Saved ${updated.id}.` })
    setEditing(null)
    setConflict(false)
    setDetail(updated)
    await refresh()
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (editing === null || editing.isNew) return
    const fresh = await readMemory(workspaceId, editing.id, editing.tier)
    const loaded = { title: fresh.title, body: fresh.body, pinned: fresh.pinned }
    setEditing({ ...editing, hash: fresh.hash, loaded })
    setDraft(loaded)
    setConflict(false)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const remove = (entry: MemoryEntryRow, tier: Tier): Promise<void> => run('delete', async () => {
    await deleteMemory(workspaceId, entry.id, tier)
    setConfirmDelete(false)
    setDetail(null)
    setSelected(null)
    setNotice({ kind: 'ok', text: `Deleted ${entry.id}.` })
    await refresh()
  })

  const badgeTone = (tier: Tier): 'blue' | 'green' => (tier === null ? 'blue' : 'green')

  /** Fixed-height bar at the top of the detail pane: identity + tier. */
  const paneHeader = (title: ReactNode, trailing?: ReactNode): ReactNode => (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      {title}
      <span className="min-w-0 flex-1" />
      {trailing}
    </div>
  )
  const entryTitle = (title: string, tier: Tier, type: MemoryEntryRow['type']): ReactNode => (
    <>
      <EntryIcon type={type} size={14} />
      <span className="min-w-0 truncate text-sm font-medium text-fg">{title}</span>
      <Badge tone={badgeTone(tier)}>{tier === null ? 'Workspace' : `Project · ${tierLabel(tier)}`}</Badge>
    </>
  )

  const detailBody = (): ReactNode => {
    if (editing !== null) {
      const idHint = idTaken
        ? 'An entry with this ID exists in this scope — open it from the tree instead.'
        : newId === '' ? 'The title needs letters or numbers to form an ID.' : `ID: ${newId}`
      return (
        <>
          {paneHeader(
            <span className="text-sm font-medium text-fg">{editing.isNew ? 'New memory entry' : `Edit ${editing.id}`}</span>,
            editing.isNew ? undefined : <Badge tone={badgeTone(editing.tier)}>{editing.tier === null ? 'Workspace' : `Project · ${tierLabel(editing.tier)}`}</Badge>,
          )}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {editing.isNew && projects.length > 0 ? (
              <Field label="Scope" hint="Workspace memory is shared; project memory loads only for conversations bound to that project.">
                <Select label="Memory scope" value={tierKey(editing.tier)} options={tierOptions} onChange={(value) => setEditing({ ...editing, tier: value === '' ? null : value })} />
              </Field>
            ) : null}
            <Field
              label="Title"
              {...(editing.isNew ? { hint: idHint } : {})}
              tone={editing.isNew && (idTaken || (draft.title !== '' && newId === '')) ? 'bad' : 'default'}
            >
              <TextInput value={draft.title} placeholder="Deploy notes" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <div className="rounded-xl border border-line px-3.5 py-2.5">
              <Switch checked={draft.pinned} label="Legacy pin (metadata only)" hint="Only MEMORY.md pointers load into context; topic bodies are read on demand." onChange={(pinned) => setDraft({ ...draft, pinned })} />
            </div>
            <Field label="Body">
              <CodeArea tall rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </Field>
            {conflict ? <ConflictBanner what="entry" busy={busy !== null} onReload={() => void reloadServer()} onOverwrite={() => void overwrite()} /> : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => guardDiscard(() => { setEditing(null); setConflict(false) })}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy !== null || cannotSave} onClick={() => void save()}>
              {busy === 'save' ? (editing.isNew ? 'Creating…' : 'Saving…') : editing.isNew ? 'Create entry' : 'Save entry'}
            </Button>
          </div>
        </>
      )
    }
    if (selected === null || detail === null) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon name="fileText" size={20} className="text-fg-faint" />
          <p className="m-0 text-[13px] text-fg-muted">Select an entry to preview it, or create a new one.</p>
        </div>
      )
    }
    return (
      <>
        {paneHeader(entryTitle(detail.title, selected.tier, detail.type), detail.pinned ? <span title="Legacy pin" className="flex shrink-0"><Icon name="pin" size={13} className="text-fg-faint" /></span> : undefined)}
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
          <Icon name="fileText" size={13} className="shrink-0 text-fg-faint" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{detail.id}.md</span>
          {confirmDelete ? (
            <InlineConfirm
              message="Delete this memory file and its index pointer?"
              confirmLabel="Delete permanently"
              busy={busy === 'delete'}
              onConfirm={() => void remove(detail, selected.tier)}
              onCancel={() => setConfirmDelete(false)}
            />
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => beginEdit(detail, selected.tier)}>
                <Icon name="pencil" size={13} />Edit
              </Button>
              <IconButton label={`Delete ${detail.id}`} disabled={busy !== null} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={14} /></IconButton>
            </>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[13px]">
          <Markdown content={detail.body} />
        </div>
      </>
    )
  }

  const filterOptions = [
    { value: 'all', label: `All (${totalEntries})` },
    { value: WORKSPACE_FILTER, label: 'Workspace' },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ]

  return (
    <PanelBody>
      <PanelIntro>Memory entries are Markdown notes the model recalls. Workspace memory is shared by every project; project memory loads only for conversations bound to that project. Only each tier’s MEMORY.md pointers load into context — topic bodies are read on demand.</PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}
      <div className="grid h-[min(560px,calc(100vh-460px))] min-h-[360px] overflow-hidden rounded-xl border border-line md:grid-cols-[minmax(260px,320px)_1fr]">
        <div className="flex min-h-0 flex-col border-b border-line md:border-r md:border-b-0">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
            <span className="text-[11px] font-semibold tracking-wider text-fg-faint uppercase">Memory</span>
            <span className="min-w-0 flex-1" />
            <IconButton label="Refresh memory" disabled={busy !== null} onClick={() => void refresh()}><Icon name="refresh" size={14} /></IconButton>
            <IconButton label="New memory entry" disabled={busy !== null} onClick={() => guardDiscard(beginNew)}><Icon name="plus" size={14} /></IconButton>
          </div>
          <div className="flex shrink-0 gap-2 border-b border-line p-2">
            <div className="min-w-0 flex-1">
              <TextInput
                className="h-8"
                leading={<Icon name="search" size={13} />}
                value={search}
                aria-label="Search memory"
                placeholder="Search memory"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {projects.length > 0 ? (
              <div className="w-[112px] shrink-0">
                <Select
                  label="Filter by scope"
                  triggerClassName="h-8 px-2.5 text-[13px]"
                  value={tierFilter}
                  onChange={setTierFilter}
                  options={filterOptions}
                />
              </div>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tree" aria-label="Memory">
            {visibleGroups.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">{totalEntries === 0 ? 'No memory entries yet.' : 'No entries match.'}</p>
            ) : visibleGroups.map((group) => {
              const groupOpen = !collapsedGroups.has(group.key) || search !== ''
              return (
                <div key={group.key} role="group">
                  <button
                    type="button"
                    className={`${TREE_ROW} gap-1.5 pl-2 font-medium text-fg`}
                    aria-expanded={groupOpen}
                    title={group.label}
                    onClick={() => toggleGroup(group.key)}
                  >
                    <Icon name="chevron" size={12} className={`shrink-0 text-fg-faint transition-transform ${groupOpen ? '' : '-rotate-90'}`} />
                    <Icon name={groupOpen ? 'folderOpen' : 'folder'} size={14} className="shrink-0 text-fg-muted" />
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    <span className="shrink-0 text-xs font-normal text-fg-faint">{group.rows.length}</span>
                  </button>
                  {groupOpen ? group.rows.map((row) => {
                    const active = selected?.id === row.id && selected.tier === group.tier
                    const firstLine = row.body.split('\n').find((line) => line.trim() !== '') ?? ''
                    return (
                      <div key={row.id} role="treeitem" aria-selected={active}>
                        <button
                          type="button"
                          title={firstLine !== '' ? `${row.title} — ${firstLine}` : row.title}
                          className={`${TREE_ROW} gap-1.5 pl-7 text-fg ${active ? 'bg-hover' : ''}`}
                          onClick={() => guardDiscard(() => void openDetail(group.tier, row))}
                        >
                          <EntryIcon type={row.type} size={13} />
                          <span className="min-w-0 flex-1 truncate">{row.title}</span>
                          {row.pinned ? <Icon name="pin" size={12} className="shrink-0 text-fg-faint" /> : null}
                        </button>
                      </div>
                    )
                  }) : null}
                </div>
              )
            })}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">{detailBody()}</div>
      </div>
    </PanelBody>
  )
}
