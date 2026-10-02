import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { Markdown } from '../../Markdown.tsx'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteSkill, getSkill, getSkillSources, listProjects, listSkills, putSkillSources, saveSkill, setSkillHidden } from '../../lib/api.ts'
import type { ProjectRow, SkillRow, SkillRuleRow } from '../../lib/types.ts'
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
type PanelTab = 'skills' | 'folders'

interface SkillGroup {
  readonly key: string
  readonly label: string
  readonly source: SkillRow['source']
  readonly rows: readonly SkillRow[]
}

/** One project's catalog slice, fetched per project for the tree's groups. */
interface ProjectSkillRows {
  readonly projectId: string
  readonly rows: readonly SkillRow[]
}

/**
 * Skills settings, two tabs: "Skills" is a layer-grouped catalog (project x
 * rule groups, then workspace/user/bundled) with a detail pane — preview for
 * every layer, raw editing and delete only for workspace rows; "Source
 * folders" is the rule editor ({@link FoldersEditor}). Grouping scans ALL
 * projects of the workspace: rules apply to every project, so no selector.
 */
export function SkillsPanel(props: { readonly workspaceId: string | null }) {
  return <SkillsPanelContent key={props.workspaceId} {...props} />
}

function SkillsPanelContent({ workspaceId }: { readonly workspaceId: string | null }) {
  const [tab, setTab] = useScopedState<PanelTab>('skills')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [rules, setRules] = useScopedState<readonly SkillRuleRow[]>([])
  const [projects, setProjects] = useScopedState<readonly ProjectRow[]>([])
  const [baseRows, setBaseRows] = useScopedState<readonly SkillRow[]>([])
  const [projectRows, setProjectRows] = useScopedState<readonly ProjectSkillRows[]>([])
  const [selected, setSelected] = useScopedState<{ readonly name: string; readonly source: SkillRow['source']; readonly projectId?: string } | null>(null)
  const [detail, setDetail] = useScopedState<SkillRow & { readonly instructions: string } | null>(null)
  const [editing, setEditing] = useScopedState<{ readonly name: string; readonly isNew: boolean; readonly hash: string | null; readonly loaded: string } | null>(null)
  const [newName, setNewName] = useScopedState('')
  const [content, setContent] = useScopedState('')
  const [conflict, setConflict] = useScopedState(false)
  const [deleteName, setDeleteName] = useScopedState<string | null>(null)
  const [search, setSearch] = useScopedState('')
  const [sourceFilter, setSourceFilter] = useScopedState<'all' | SkillRow['source']>('all')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refresh = useCallback(async (): Promise<void> => {
    if (workspaceId === null) return
    try {
      const [baseRows, sources, projects] = await Promise.all([listSkills(workspaceId), getSkillSources(workspaceId), listProjects(workspaceId)])
      setBaseRows(baseRows)
      setRules(sources.rules)
      setProjects(projects)
      setProjectRows(await Promise.all(projects.map(async (project) => ({
        projectId: project.id,
        rows: await listSkills(workspaceId, project.id).catch(() => [] as SkillRow[]),
      }))))
    } catch (cause) {
      setNotice({ kind: 'bad', text: String(cause) })
    }
  }, [workspaceId])

  useEffect(() => { void refresh() }, [refresh])

  if (workspaceId === null) return <WorkspaceRequired />

  const projectName = (projectId: string): string => projects.find((project) => project.id === projectId)?.name ?? projectId

  /** Project x rule groups first, then the default layers; empty groups drop. */
  const groups: readonly SkillGroup[] = (() => {
    const out: SkillGroup[] = []
    for (const entry of projectRows) {
      for (const rule of rules.filter((candidate) => candidate.kind === 'project' && candidate.enabled)) {
        const rows = entry.rows.filter((row) => row.ruleId === rule.id)
        if (rows.length > 0) out.push({ key: `${entry.projectId}:${rule.id}`, label: `${rule.path} · ${projectName(entry.projectId)}`, source: 'project', rows })
      }
    }
    const baseGroup = (source: SkillRow['source'], label: string): SkillGroup | undefined => {
      const rows = baseRows.filter((row) => row.source === source)
      return rows.length > 0 ? { key: source, label, source, rows } : undefined
    }
    for (const group of [baseGroup('workspace', 'Workspace'), baseGroup('user', 'User (~/.claude/skills)'), baseGroup('bundled', 'Bundled')]) {
      if (group !== undefined) out.push(group)
    }
    return out.filter((group) => group !== undefined)
  })()

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) =>
        (sourceFilter === 'all' || row.source === sourceFilter)
        && (search === '' || `${row.name}\n${row.title}\n${row.description}`.toLowerCase().includes(search.toLowerCase()))),
    }))
    .filter((group) => group.rows.length > 0)
  const totalVisible = visibleGroups.reduce((sum, group) => sum + group.rows.length, 0)

  const projectIdOf = (row: SkillRow): string | undefined =>
    projectRows.find((entry) => entry.rows.includes(row))?.projectId

  const openDetail = (row: SkillRow): Promise<void> => run(`open:${row.name}`, async () => {
    setNotice(null)
    setConflict(false)
    const projectId = projectIdOf(row)
    setSelected({ name: row.name, source: row.source, ...(projectId !== undefined ? { projectId } : {}) })
    setDetail(await getSkill(workspaceId, row.name, projectId))
    setEditing(null)
  })

  const beginNew = (): void => {
    setSelected(null)
    setDetail(null)
    setEditing({ name: '', isNew: true, hash: null, loaded: '' })
    setNewName('')
    setContent('')
    setConflict(false)
    setNotice(null)
  }

  const name = editing === null ? '' : editing.isNew ? newName.trim() : editing.name
  const allNames = groups.flatMap((group) => group.rows.map((row) => row.name))
  const nameInvalid = editing?.isNew === true && newName.trim() !== '' && !SKILL_NAME.test(newName.trim())
  const nameTaken = editing?.isNew === true && allNames.includes(newName.trim())
  const unchanged = editing !== null && !editing.isNew && content === editing.loaded
  const cannotSave = name === '' || content.trim() === '' || nameInvalid || nameTaken || unchanged

  const save = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (editing === null) return
    try {
      const saved = await saveSkill(workspaceId, name, content, hashOverride ?? editing.hash ?? undefined)
      setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
      setEditing(null)
      setDetail(null)
      setSelected(null)
      await refresh()
    } catch (cause) {
      if (!isConflict(cause)) throw cause
      setConflict(true)
      setNotice({ kind: 'bad', text: 'Changed on disk since you opened it.' })
    }
  })

  const overwrite = (): Promise<void> => run('overwrite', async () => {
    if (editing === null || editing.isNew) return
    const fresh = await getSkill(workspaceId, editing.name)
    const saved = await saveSkill(workspaceId, editing.name, content, fresh.hash)
    setNotice({ kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` })
    setEditing(null)
    await refresh()
  })

  const reloadServer = (): Promise<void> => run('reload', async () => {
    if (editing === null || editing.isNew) return
    const fresh = await getSkill(workspaceId, editing.name)
    setContent(fresh.instructions)
    setEditing({ ...editing, hash: fresh.hash, loaded: fresh.instructions })
    setConflict(false)
    setNotice({ kind: 'info', text: 'Loaded the server version.' })
  })

  const remove = (row: SkillRow): Promise<void> => run(`delete:${row.name}`, async () => {
    await deleteSkill(workspaceId, row.name)
    setDeleteName(null)
    setDetail(null)
    setSelected(null)
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

  const badgeTone = (source: SkillRow['source']): 'blue' | 'green' | 'gray' =>
    source === 'workspace' ? 'blue' : source === 'project' ? 'green' : 'gray'

  const detailBody = (): ReactNode => {
    if (editing !== null) {
      return (
        <Section title={editing.isNew ? 'New skill' : `Edit ${editing.name}`}>
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
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setEditing(null); setConflict(false) }}>Cancel</Button>
          </div>
        </Section>
      )
    }
    if (selected === null || detail === null) return <EmptyState>Select a skill to preview it.</EmptyState>
    const readOnly = selected.source !== 'workspace'
    return (
      <Section title={detail.title === detail.name ? detail.name : `${detail.name} — ${detail.title}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={badgeTone(selected.source)}>{selected.source}</Badge>
          {(detail.hidden ?? false) ? <Icon name="eyeOff" size={13} className="text-fg-faint" /> : null}
          <span className="min-w-0 flex-1" />
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted" title="List in the model's skill catalog">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              aria-label={`Offer ${detail.name} in the skill catalog`}
              checked={!(detail.hidden ?? false)}
              disabled={busy !== null}
              onChange={() => void toggleCatalog({ ...detail, source: selected.source })}
            />
            In catalog
          </label>
        </div>
        <p className="font-mono text-xs text-fg-faint">/SKILL.md</p>
        {readOnly ? <Notice kind="info" text="This layer is read-only here — edit the file with an external editor; changes load fresh on the next read." /> : null}
        {detail.description !== '' ? <p className="text-[13px] text-fg-muted">{detail.description}</p> : null}
        <div className="max-h-[50vh] overflow-auto rounded-lg border border-border-subtle p-3 text-[13px]">
          <Markdown content={detail.instructions} />
        </div>
        {!readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openEditorFromDetail(detail)}>
              <Icon name="chevronRight" size={13} className="rotate-90" />Edit raw
            </Button>
            {deleteName === detail.name ? (
              <InlineConfirm
                message={`Delete “${detail.name}”? Its SKILL.md is removed from this workspace.`}
                confirmLabel="Delete permanently"
                busy={busy === `delete:${detail.name}`}
                onConfirm={() => void remove(detail)}
                onCancel={() => setDeleteName(null)}
              />
            ) : (
              <IconButton label={`Delete ${detail.name}`} disabled={busy !== null} onClick={() => setDeleteName(detail.name)}><Icon name="trash" size={14} /></IconButton>
            )}
          </div>
        ) : null}
      </Section>
    )
  }

  const openEditorFromDetail = (loaded: SkillRow & { readonly instructions: string }): void => {
    setEditing({ name: loaded.name, isNew: false, hash: loaded.hash, loaded: loaded.instructions })
    setContent(loaded.instructions)
  }

  return (
    <PanelBody>
      <PanelIntro>Skills are SKILL.md instruction packages the model loads by name. Project folders (.claude/skills, .agents/skills) follow the rule list in “Source folders” — precedence is list order, first match wins.</PanelIntro>
      {notice !== null ? <Notice kind={notice.kind} text={notice.text} /> : null}
      <div className="flex gap-1 rounded-lg bg-bg-inset p-1 text-[13px]" role="tablist">
        {(['skills', 'folders'] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            role="tab"
            aria-selected={tab === candidate}
            className={`rounded-md px-3 py-1.5 ${tab === candidate ? 'bg-bg-surface text-fg shadow-sm' : 'text-fg-muted'}`}
            onClick={() => setTab(candidate)}
          >
            {candidate === 'skills' ? 'Skills' : 'Source folders'}
          </button>
        ))}
      </div>
      {tab === 'skills' ? (
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,2fr)_3fr]">
          <Section
            title="Skills"
            count={totalVisible}
            actions={<Button variant="outline" size="sm" disabled={busy !== null} onClick={beginNew}><Icon name="plus" size={13} />New skill</Button>}
          >
            <div className="flex flex-wrap gap-2">
              <TextInput value={search} placeholder="Search skills" onChange={(e) => setSearch(e.target.value)} />
              <select
                aria-label="Filter by layer"
                className="rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-[13px]"
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value as 'all' | SkillRow['source'])}
              >
                <option value="all">All</option>
                <option value="project">Project</option>
                <option value="workspace">Workspace</option>
                <option value="user">User</option>
                <option value="bundled">Bundled</option>
              </select>
            </div>
            {visibleGroups.length === 0 ? <EmptyState>No skills match.</EmptyState> : (
              <ItemList label="Skills">
                {visibleGroups.map((group) => (
                  <div key={group.key} className="space-y-1">
                    <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-fg-faint">
                      <Icon name="folder" size={12} />{group.label}
                      <span className="ml-auto">{group.rows.length}</span>
                    </p>
                    {group.rows.map((row) => (
                      <ItemRow
                        key={`${group.key}:${row.name}`}
                        title={(
                          <>
                            <button
                              type="button"
                              className={`break-all text-left ${selected?.name === row.name && selected.source === row.source ? 'text-fg' : 'text-fg-muted hover:text-fg'}`}
                              onClick={() => void openDetail(row)}
                            >
                              {row.name}
                            </button>
                            {(row.hidden ?? false) ? <Icon name="eyeOff" size={12} className="text-fg-faint" /> : null}
                          </>
                        )}
                        meta={row.description !== '' ? row.description : undefined}
                      />
                    ))}
                  </div>
                ))}
              </ItemList>
            )}
          </Section>
          {detailBody()}
        </div>
      ) : (
        <Section title="Source folders" count={rules.length}>
          <FoldersEditor
            workspaceId={workspaceId}
            rules={rules}
            onSaved={(saved) => { setRules(saved.rules); void refresh() }}
            setNotice={setNotice}
            busy={busy !== null}
          />
        </Section>
      )}
    </PanelBody>
  )
}

/** The ordered rule list; every mutation persists immediately (last-write-wins). */
function FoldersEditor(props: {
  readonly workspaceId: string
  readonly rules: readonly SkillRuleRow[]
  readonly onSaved: (saved: { readonly rules: readonly SkillRuleRow[] }) => void
  readonly setNotice: (notice: NoticeState) => void
  readonly busy: boolean
}): ReactNode {
  const [newKind, setNewKind] = useScopedState<'project' | 'absolute'>('project')
  const [newPath, setNewPath] = useScopedState('')
  const { run } = useActionRunner((text) => props.setNotice({ kind: 'bad', text }))

  const persist = (next: readonly SkillRuleRow[]): Promise<void> => run('sources', async () => {
    try {
      props.onSaved(await putSkillSources(props.workspaceId, next))
      props.setNotice({ kind: 'ok', text: 'Source folders saved.' })
    } catch (cause) {
      props.setNotice({ kind: 'bad', text: cause instanceof Error ? cause.message : String(cause) })
    }
  })

  const kindLabel = (kind: SkillRuleRow['kind']): string => (kind === 'project' ? 'Project' : kind === 'absolute' ? 'Absolute' : 'Workspace')
  const rowLabel = (rule: SkillRuleRow): string => (rule.kind === 'workspace' ? 'Workspace skills' : rule.path ?? rule.id)
  const rowHint = (rule: SkillRuleRow): string =>
    rule.kind === 'workspace'
      ? "The workspace's own skill folder — path is fixed."
      : rule.kind === 'project'
        ? "Relative to the bound project's folder."
        : 'Absolute folder on this host.'

  const move = (index: number, delta: -1 | 1): void => {
    const next = [...props.rules]
    const [row] = next.splice(index, 1)
    if (row === undefined) return
    next.splice(index + delta, 0, row)
    void persist(next)
  }

  return (
    <div className="space-y-2">
      <ItemList label="Source folders">
        {props.rules.map((rule, index) => (
          <ItemRow
            key={rule.id}
            title={(
              <>
                <Badge tone={rule.kind === 'project' ? 'green' : rule.kind === 'absolute' ? 'gray' : 'blue'}>{kindLabel(rule.kind)}</Badge>
                <span className="break-all font-mono text-[13px]">{rowLabel(rule)}</span>
              </>
            )}
            meta={rowHint(rule)}
            actions={(
              <>
                <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-primary"
                    aria-label={`Enable ${rowLabel(rule)}`}
                    checked={rule.enabled}
                    disabled={props.busy}
                    onChange={() => void persist(props.rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled } : candidate)))}
                  />
                  Enabled
                </label>
                <IconButton label={`Move ${rowLabel(rule)} up`} disabled={props.busy || index === 0} onClick={() => move(index, -1)}>
                  <Icon name="chevron" size={13} className="-rotate-90" />
                </IconButton>
                <IconButton label={`Move ${rowLabel(rule)} down`} disabled={props.busy || index === props.rules.length - 1} onClick={() => move(index, 1)}>
                  <Icon name="chevron" size={13} className="rotate-90" />
                </IconButton>
                {rule.kind !== 'workspace' ? (
                  <IconButton label={`Remove ${rowLabel(rule)}`} disabled={props.busy} onClick={() => void persist(props.rules.filter((candidate) => candidate.id !== rule.id))}>
                    <Icon name="trash" size={14} />
                  </IconButton>
                ) : null}
              </>
            )}
          />
        ))}
      </ItemList>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Kind">
          <select
            aria-label="New rule kind"
            className="rounded-md border border-border-subtle bg-bg-surface px-2 py-1.5 text-[13px]"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as 'project' | 'absolute')}
          >
            <option value="project">Project folder</option>
            <option value="absolute">Absolute path</option>
          </select>
        </Field>
        <Field label={newKind === 'project' ? 'Relative folder (e.g. .claude/skills)' : 'Absolute folder (e.g. D:/shared-skills)'}>
          <TextInput mono aria-label="New rule path" value={newPath} placeholder={newKind === 'project' ? '.team/skills' : 'D:/shared-skills'} onChange={(e) => setNewPath(e.target.value)} />
        </Field>
        <Button
          variant="outline"
          size="sm"
          disabled={props.busy || newPath.trim() === ''}
          onClick={() => {
            const path = newPath.trim()
            if (path === '') return
            void persist([...props.rules, { id: `rule-${Math.random().toString(36).slice(2, 8)}`, kind: newKind, path, enabled: true }])
            setNewPath('')
          }}
        >
          <Icon name="plus" size={13} />Add rule
        </Button>
      </div>
      <p className="text-xs text-fg-faint">List order is precedence — the first folder holding a skill name wins. Absolute folders are protected from file-tool grants.</p>
    </div>
  )
}
