import { useCallback, useEffect } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Switch } from '../ui/Switch.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { createMemory, deleteMemory, readMemory, searchMemory, updateMemory } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import type { MemoryEntryRow } from '../../lib/types.ts'
import { CodeArea, EmptyState, InlineConfirm, Notice, PanelBody, PanelIntro, Section, WorkspaceRequired, useActionRunner, type NoticeState } from './settings-kit.tsx'

const SEARCH_DEBOUNCE_MS = 300

/** kebab-case id from a title (memory create uses it as the entry id). */
function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

interface EntryDraft {
  readonly title: string
  readonly body: string
  readonly pinned: boolean
  readonly hash: string | null
}

/**
 * Memory: scoped entries with debounced search, pinning, and
 * expectedHash-guarded edits — conflicts offer Reload (server wins) or
 * Overwrite (re-read the fresh hash, then resubmit). List on the left,
 * the open entry on the right.
 */
export function MemoryPanel(props: { readonly workspaceId: string | null }) {
  return <MemoryPanelContent key={props.workspaceId} {...props} />
}

function MemoryPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [query, setQuery] = useScopedState('')
  const [rows, setRows] = useScopedState<readonly MemoryEntryRow[]>([])
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  /** `new` while creating, an entry id while editing, null with nothing open. */
  const [open, setOpen] = useScopedState<string | null>(null)
  const [draft, setDraft] = useScopedState<EntryDraft>({ title: '', body: '', pinned: false, hash: null })
  const [saved, setSaved] = useScopedState<EntryDraft | null>(null)
  const [conflict, setConflict] = useScopedState(false)
  const [confirmDelete, setConfirmDelete] = useScopedState(false)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async (q: string) => {
    if (workspaceId === null) return
    try { setRows(await searchMemory(workspaceId, q)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => {
    if (workspaceId === null) return
    const timer = window.setTimeout(() => { void refresh(query) }, SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [query, workspaceId, refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const creating = open === 'new'
  const newId = slugify(draft.title)
  const dirty = saved === null || draft.title !== saved.title || draft.body !== saved.body || draft.pinned !== saved.pinned
  const incomplete = draft.title.trim() === '' || draft.body.trim() === '' || (creating && newId === '')

  const loadEntry = async (id: string): Promise<void> => {
    const entry = await readMemory(workspaceId, id)
    const loaded = { title: entry.title, body: entry.body, pinned: entry.pinned, hash: entry.hash }
    setOpen(entry.id)
    setDraft(loaded)
    setSaved(loaded)
  }

  const openEntry = (row: MemoryEntryRow): Promise<void> => run(`open:${row.id}`, async () => {
    setNotice(null)
    setConflict(false)
    setConfirmDelete(false)
    await loadEntry(row.id)
  })

  const beginCreate = (): void => {
    setOpen('new')
    setDraft({ title: '', body: '', pinned: false, hash: null })
    setSaved(null)
    setConflict(false)
    setConfirmDelete(false)
    setNotice(null)
  }

  const close = (): void => { setOpen(null); setConflict(false); setConfirmDelete(false) }

  const create = (): Promise<void> => run('save', async () => {
    const created = await createMemory(workspaceId, { id: newId, title: draft.title.trim(), body: draft.body, ...(draft.pinned ? { pinned: true } : {}) })
    setNotice({ kind: 'ok', text: `Created ${created.id}.` })
    await refresh(query)
    await loadEntry(created.id)
  })

  const update = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (open === null || creating) return
    try {
      const updated = await updateMemory(workspaceId, open, {
        expectedHash: hashOverride ?? draft.hash ?? '',
        title: draft.title,
        body: draft.body,
        pinned: draft.pinned,
      })
      const next = { title: updated.title, body: updated.body, pinned: updated.pinned, hash: updated.hash }
      setDraft(next)
      setSaved(next)
      setConflict(false)
      setNotice({ kind: 'ok', text: `Saved ${updated.id}.` })
      await refresh(query)
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (open === null) return
    const fresh = await readMemory(workspaceId, open)
    const updated = await updateMemory(workspaceId, open, { expectedHash: fresh.hash, title: draft.title, body: draft.body, pinned: draft.pinned })
    const next = { title: updated.title, body: updated.body, pinned: updated.pinned, hash: updated.hash }
    setDraft(next)
    setSaved(next)
    setConflict(false)
    setNotice({ kind: 'ok', text: `Saved ${updated.id}.` })
    await refresh(query)
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (open === null) return
    await loadEntry(open)
    setConflict(false)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const remove = (): Promise<void> => run('delete', async () => {
    if (open === null) return
    await deleteMemory(workspaceId, open)
    close()
    setNotice({ kind: 'ok', text: 'Entry deleted.' })
    await refresh(query)
  })

  return (
    <PanelBody>
      <PanelIntro>Memory entries are scoped to this workspace and surfaced to the model by relevance. Pinned entries always load.</PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(15rem,20rem)_minmax(0,1fr)]">
        <Section
          title="Entries"
          count={rows.length}
          actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={beginCreate}><Icon name="plus" size={13} />New entry</Button>}
        >
          <TextInput value={query} aria-label="Search memory" placeholder="Search memory…" leading={<Icon name="search" size={14} />} onChange={(event) => setQuery(event.target.value)} />
          {rows.length === 0 ? (
            <EmptyState>{query.trim() === '' ? 'No memory entries yet.' : 'No matching entries.'}</EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Memory entries">
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    aria-current={row.id === open ? 'true' : undefined}
                    onClick={() => void openEntry(row)}
                    className={cn('flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-hover', row.id === open && 'bg-hover')}
                  >
                    <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                      {row.pinned ? <Icon name="pin" size={12} className="shrink-0 text-fg-muted" /> : null}
                      <span className="truncate">{row.title}</span>
                    </span>
                    <span className="truncate text-xs text-fg-faint">{row.body.split('\n')[0] ?? ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {open === null ? (
          <div className="hidden items-center justify-center rounded-xl border border-dashed border-line p-8 text-[13px] text-fg-muted lg:flex">
            Select an entry to edit it, or create a new one.
          </div>
        ) : (
          <Section
            title={creating ? 'New memory entry' : `Edit ${open}`}
            actions={<Button variant="ghost" size="sm" disabled={busy !== null} onClick={close}>Close</Button>}
          >
            <Field label="Title" hint={creating ? (newId === '' ? 'The title needs letters or numbers to form an ID.' : `ID: ${newId}`) : undefined} tone={creating && draft.title !== '' && newId === '' ? 'bad' : 'default'}>
              <TextInput value={draft.title} placeholder="Deploy notes" onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            </Field>
            <div className="rounded-xl border border-line px-3.5 py-2.5">
              <Switch checked={draft.pinned} label="Legacy pin (metadata only)" hint="Only MEMORY.md pointers load into context; topic bodies are read on demand." onChange={(pinned) => setDraft({ ...draft, pinned })} />
            </div>
            <Field label="Body">
              <CodeArea tall rows={10} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
            </Field>
            {conflict ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
                <span className="min-w-0 flex-1 basis-48">The entry changed on disk since you opened it.</span>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadServer()}>Reload server version</Button>
                <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
              </div>
            ) : null}
            {confirmDelete ? (
              <InlineConfirm
                message="Delete this memory file and its index pointer?"
                confirmLabel="Delete permanently"
                busy={busy === 'delete'}
                onConfirm={() => void remove()}
                onCancel={() => setConfirmDelete(false)}
              />
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {creating ? (
                <Button variant="primary" size="sm" disabled={busy !== null || incomplete} onClick={() => void create()}>{busy === 'save' ? 'Creating…' : 'Create entry'}</Button>
              ) : (
                <>
                  <Button variant="primary" size="sm" disabled={busy !== null || incomplete || !dirty} onClick={() => void update()}>{busy === 'save' ? 'Saving…' : 'Save'}</Button>
                  <span className="flex-1" />
                  {!confirmDelete ? <Button variant="ghost" size="sm" className="text-bad" disabled={busy !== null} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={13} />Delete</Button> : null}
                </>
              )}
            </div>
          </Section>
        )}
      </div>
    </PanelBody>
  )
}
