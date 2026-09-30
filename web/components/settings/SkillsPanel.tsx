import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteSkill, getSkill, listSkills, saveSkill, setSkillHidden } from '../../lib/api.ts'
import type { SkillRow } from '../../lib/types.ts'
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

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SKILL_PLACEHOLDER = '---\nname: deploy-notes\ndescription: how deploys work\n---\n\nDeploy runs via pm2…'
const isConflict = (cause: unknown): boolean => /409/.test(String(cause))

/**
 * Skills: workspace SKILL.md files, user and bundled rows read-only. The editor loads
 * the real content so saves are never blind; expectedHash conflicts offer
 * Reload / Overwrite — overwrite re-reads the fresh hash first.
 */
export function SkillsPanel(props: { readonly workspaceId: string | null }) {
  return <SkillsPanelContent key={props.workspaceId} {...props} />
}

function SkillsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [rows, setRows] = useScopedState<readonly SkillRow[]>([])
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [editing, setEditing] = useScopedState<{ readonly name: string; readonly isNew: boolean; readonly hash: string | null; readonly loaded: string } | null>(null)
  const [newName, setNewName] = useScopedState('')
  const [content, setContent] = useScopedState('')
  const [conflict, setConflict] = useScopedState(false)
  const [deleteName, setDeleteName] = useScopedState<string | null>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async () => {
    if (workspaceId === null) return
    try { setRows(await listSkills(workspaceId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const openEditor = (row: SkillRow): Promise<void> => run(`open:${row.name}`, async () => {
    setNotice(null)
    setConflict(false)
    const loaded = await getSkill(workspaceId, row.name)
    setEditing({ name: row.name, isNew: false, hash: loaded.hash, loaded: loaded.instructions })
    setContent(loaded.instructions)
  })

  const beginNew = (): void => {
    setEditing({ name: '', isNew: true, hash: null, loaded: '' })
    setNewName('')
    setContent('')
    setConflict(false)
    setNotice(null)
  }

  const closeEditor = (): void => { setEditing(null); setConflict(false) }

  const name = editing === null ? '' : editing.isNew ? newName.trim() : editing.name
  const nameInvalid = editing?.isNew === true && newName.trim() !== '' && !SKILL_NAME.test(newName.trim())
  const nameTaken = editing?.isNew === true && rows.some((row) => row.name === newName.trim())
  const unchanged = editing !== null && !editing.isNew && content === editing.loaded

  const save = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (editing === null) return
    const expectedHash = hashOverride ?? editing.hash ?? undefined
    try {
      const saved = await saveSkill(workspaceId, name, content, expectedHash)
      setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
      closeEditor()
      await refresh()
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (editing === null) return
    const fresh = await getSkill(workspaceId, editing.name)
    const saved = await saveSkill(workspaceId, editing.name, content, fresh.hash)
    setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
    closeEditor()
    await refresh()
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (editing === null) return
    const fresh = await getSkill(workspaceId, editing.name)
    setContent(fresh.instructions)
    setEditing({ ...editing, hash: fresh.hash, loaded: fresh.instructions })
    setConflict(false)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const remove = (row: SkillRow): Promise<void> => run(`delete:${row.name}`, async () => {
    await deleteSkill(workspaceId, row.name)
    setDeleteName(null)
    setNotice({ kind: 'ok', text: `Deleted ${row.name}.` })
    await refresh()
  })

  const toggleCatalog = (row: SkillRow): Promise<void> => run(`catalog:${row.name}`, async () => {
    const next = !(row.hidden ?? false)
    await setSkillHidden(workspaceId, row.name, next)
    setNotice({
      kind: 'ok',
      text: next
        ? `${row.name} is hidden from discovery; the model loads it only when the user names it.`
        : `${row.name} is back in the skill catalog.`,
    })
    await refresh()
  })

  /** The catalog checkbox: checked means the model discovers this skill. */
  const catalogCheckbox = (row: SkillRow): ReactNode => (
    <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted" title="List in the model's skill catalog">
      <input
        type="checkbox"
        className="size-3.5 accent-primary"
        aria-label={`Offer ${row.name} in the skill catalog`}
        checked={!(row.hidden ?? false)}
        disabled={busy !== null}
        onChange={() => void toggleCatalog(row)}
      />
      In catalog
    </label>
  )

  const cannotSave = name === '' || content.trim() === '' || nameInvalid || nameTaken || unchanged

  return (
    <PanelBody>
      <PanelIntro>Skills are SKILL.md instruction packages the model can load by name. User (~/.claude/skills) and bundled rows are read-only; workspace rows are yours and win on a name clash. Untick “In catalog” to hide a skill from discovery — the model loads it only when the user names it.</PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}

      {editing === null ? (
        <Section
          title="Skills"
          count={rows.length}
          actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={beginNew}><Icon name="plus" size={13} />New skill</Button>}
        >
          {rows.length === 0 ? <EmptyState>No skills in this workspace.</EmptyState> : (
            <ItemList label="Skills">
              {rows.map((row) => (
                <ItemRow
                  key={row.name}
                  title={<><span className="break-all">{row.name}</span><Badge tone={row.source === 'workspace' ? 'blue' : 'gray'}>{row.source}</Badge></>}
                  meta={row.description !== '' ? row.description : row.title !== row.name ? row.title : undefined}
                  actions={(
                    <>
                      {catalogCheckbox(row)}
                      {row.source === 'workspace' ? (
                        <>
                          <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void openEditor(row)}>{busy === `open:${row.name}` ? 'Opening…' : 'Edit'}</Button>
                          <IconButton label={`Delete ${row.name}`} disabled={busy !== null} onClick={() => setDeleteName(row.name)}><Icon name="trash" size={14} /></IconButton>
                        </>
                      ) : <span className="px-2 text-xs text-fg-faint">Read-only</span>}
                    </>
                  )}
                >
                  {deleteName === row.name ? (
                    <InlineConfirm
                      message={`Delete “${row.name}”? Its SKILL.md is removed from this workspace.`}
                      confirmLabel="Delete permanently"
                      busy={busy === `delete:${row.name}`}
                      onConfirm={() => void remove(row)}
                      onCancel={() => setDeleteName(null)}
                    />
                  ) : null}
                </ItemRow>
              ))}
            </ItemList>
          )}
        </Section>
      ) : (
        <Section
          title={editing.isNew ? 'New skill' : `Edit ${editing.name}`}
          actions={<Button variant="ghost" size="sm" disabled={busy !== null} onClick={closeEditor}><Icon name="chevronRight" size={13} className="rotate-180" />Back to list</Button>}
        >
          {editing.isNew ? (
            <Field
              label="Name"
              tone={nameInvalid || nameTaken ? 'bad' : 'default'}
              hint={nameInvalid ? 'Use lowercase letters, numbers, and single hyphens.' : nameTaken ? 'A skill with this name exists — edit it from the list instead.' : 'Kebab-case directory name, e.g. deploy-notes.'}
            >
              <TextInput mono invalid={nameInvalid || nameTaken} value={newName} placeholder="deploy-notes" onChange={(e) => setNewName(e.target.value)} />
            </Field>
          ) : null}
          <Field label="SKILL.md content" hint="Markdown with frontmatter (name, description). The frontmatter name should match the skill name.">
            <CodeArea tall value={content} placeholder={SKILL_PLACEHOLDER} onChange={(e) => setContent(e.target.value)} />
          </Field>
          {conflict ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn">
              <span className="min-w-0 flex-1 basis-48">The file changed on disk since you opened it.</span>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void reloadServer()}>Reload server version</Button>
              <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void overwrite()}>Overwrite anyway</Button>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null || cannotSave} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save skill'}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={closeEditor}>Cancel</Button>
          </div>
        </Section>
      )}
    </PanelBody>
  )
}
