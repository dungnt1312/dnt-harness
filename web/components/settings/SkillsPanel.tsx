import { useCallback, useEffect, type ReactNode } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import { Markdown } from '../../Markdown.tsx'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { deleteSkill, getSkill, getSkillFile, getSkillFiles, getSkillSources, listProjects, listSkills, putSkillSources, saveSkill, setSkillHidden } from '../../lib/api.ts'
import type { ProjectRow, SkillFileRow, SkillRow, SkillRuleRow } from '../../lib/types.ts'
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
  ConflictBanner,
  InlineSwitch,
  RowMenu,
  SubTabs,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** Mirrors the server's reserved names (`/skills/sources` is the rules route). */
const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set(['sources'])
const SKILL_PLACEHOLDER = '---\nname: deploy-notes\ndescription: how deploys work\n---\n\nDeploy runs via pm2…'
const isConflict = (cause: unknown): boolean => /409/.test(String(cause))
/** Save notice: shadow/disabled warnings from the server turn it informational. */
const savedNotice = (saved: { readonly name: string; readonly hash: string; readonly warnings?: readonly string[] }): NoticeState =>
  saved.warnings !== undefined && saved.warnings.length > 0
    ? { kind: 'info', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}), but: ${saved.warnings.join(' ')}` }
    : { kind: 'ok', text: `Saved ${saved.name} (${saved.hash.slice(0, 8)}).` }
/** One tree row: fixed height, full-width hover; callers add the indent. */
const TREE_ROW = 'flex h-7 w-full min-w-0 items-center pr-3 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-link'
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
export function SkillsPanel(props: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  return <SkillsPanelContent key={props.workspaceId} {...props} />
}

function SkillsPanelContent({ workspaceId, onChanged = () => {} }: { readonly workspaceId: string | null; readonly onChanged?: () => void }) {
  const [tab, setTab] = useScopedState<PanelTab>('skills')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [rules, setRules] = useScopedState<readonly SkillRuleRow[]>([])
  const [projects, setProjects] = useScopedState<readonly ProjectRow[]>([])
  const [baseRows, setBaseRows] = useScopedState<readonly SkillRow[]>([])
  const [projectRows, setProjectRows] = useScopedState<readonly ProjectSkillRows[]>([])
  const [selected, setSelected] = useScopedState<{ readonly name: string; readonly source: SkillRow['source']; readonly projectId?: string; readonly file: string } | null>(null)
  const [detail, setDetail] = useScopedState<SkillRow & { readonly instructions: string } | null>(null)
  const [fileDetail, setFileDetail] = useScopedState<{ readonly path: string; readonly content: string } | null>(null)
  const [expanded, setExpanded] = useScopedState<ReadonlySet<string>>(new Set<string>())
  const [filesByKey, setFilesByKey] = useScopedState<Readonly<Record<string, readonly SkillFileRow[]>>>({})
  const [collapsedGroups, setCollapsedGroups] = useScopedState<ReadonlySet<string>>(new Set<string>())
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

  const guardDiscard = useUnsavedChanges(editing !== null && (
    editing.isNew ? newName.trim() !== '' || content.trim() !== '' : content !== editing.loaded
  ))

  if (workspaceId === null) return <WorkspaceRequired />

  const projectName = (projectId: string): string => projects.find((project) => project.id === projectId)?.name ?? projectId

  /** Project x rule groups first, then base layers keyed by their ACTUAL rules
   *  (path as label — a renamed or added absolute rule must not keep a stale
   *  hardcoded "User (~/.claude/skills)" title); empty groups drop. */
  const groups: readonly SkillGroup[] = (() => {
    const out: SkillGroup[] = []
    for (const entry of projectRows) {
      for (const rule of rules.filter((candidate) => candidate.kind === 'project' && candidate.enabled)) {
        const rows = entry.rows.filter((row) => row.ruleId === rule.id)
        if (rows.length > 0) out.push({ key: `${entry.projectId}:${rule.id}`, label: `${rule.path} · ${projectName(entry.projectId)}`, source: 'project', rows })
      }
    }
    for (const rule of rules) {
      if (rule.kind === 'project') continue
      const rows = baseRows.filter((row) => rule.kind === 'workspace'
        ? (row.source === 'workspace' && row.ruleId === undefined)
        : row.ruleId === rule.id)
      if (rows.length > 0) {
        out.push({
          key: `base:${rule.id}`,
          label: rule.kind === 'workspace' ? 'Workspace skills' : rule.path ?? rule.id,
          source: rule.kind === 'workspace' ? 'workspace' : 'user',
          rows,
        })
      }
    }
    const bundled = baseRows.filter((row) => row.source === 'bundled')
    if (bundled.length > 0) out.push({ key: 'base:bundled', label: 'Bundled', source: 'bundled', rows: bundled })
    return out
  })()

  /** Base copies a project row overrides: a repo's own folder outranks the
   *  workspace/user layers by default, so a cloned project can replace a
   *  trusted skill under the same name — make that visible on the project row. */
  const overriddenBase = (name: string): SkillRow | undefined => baseRows.find((row) => row.name === name)

  /** Base rows shadowed for some project's sessions: that project's copy wins
   *  there (first-hit-wins), so the base row must not read as universally live. */
  const shadowingProjects = (name: string): readonly string[] =>
    projectRows
      // A project-scoped catalog lists EVERY layer (workspace/user too); only
      // a row the project's own folder owns actually shadows the base copy.
      .filter((entry) => entry.rows.some((row) => row.name === name && row.source === 'project'))
      .map((entry) => projectName(entry.projectId))

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) =>
        (sourceFilter === 'all' || row.source === sourceFilter)
        && (search === '' || `${row.name}\n${row.title}\n${row.description}`.toLowerCase().includes(search.toLowerCase()))),
    }))
    .filter((group) => group.rows.length > 0)
  const totalSkills = groups.reduce((sum, group) => sum + group.rows.length, 0)

  const toggleGroup = (key: string): void => {
    const next = new Set(collapsedGroups)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setCollapsedGroups(next)
  }

  const projectIdOf = (row: SkillRow): string | undefined =>
    projectRows.find((entry) => entry.rows.includes(row))?.projectId

  const openDetail = (row: SkillRow): Promise<void> => run(`open:${row.name}`, async () => {
    setNotice(null)
    setConflict(false)
    const projectId = projectIdOf(row)
    setSelected({ name: row.name, source: row.source, ...(projectId !== undefined ? { projectId } : {}), file: 'SKILL.md' })
    setFileDetail(null)
    setDetail(await getSkill(workspaceId, row.name, projectId))
    setEditing(null)
  })

  /** Expand a skill folder and lazily fetch its file listing. */
  const toggleSkill = (row: SkillRow, key: string): void => {
    const next = new Set(expanded)
    if (next.has(key)) {
      next.delete(key)
      setExpanded(next)
      return
    }
    next.add(key)
    setExpanded(next)
    if (filesByKey[key] !== undefined) return
    const projectId = projectIdOf(row)
    void getSkillFiles(workspaceId, row.name, projectId)
      .then((res) => setFilesByKey({ ...filesByKey, [key]: res.files }))
      .catch(() => setFilesByKey({ ...filesByKey, [key]: [{ path: 'SKILL.md', bytes: 0 }] }))
  }

  const fileIconName = (filePath: string): 'fileText' | 'fileCode' | 'fileJson' => {
    const lower = filePath.toLowerCase()
    if (lower.endsWith('.json') || lower.endsWith('.jsonc')) return 'fileJson'
    if (/\.(sh|bash|py|js|jsx|ts|tsx|mjs|cjs|rs|go|rb|ps1|cmd|bat)$/.test(lower)) return 'fileCode'
    return 'fileText'
  }

  /** Open one file of the tree in the detail pane (SKILL.md keeps its flow). */
  const openFile = (row: SkillRow, filePath: string): Promise<void> => {
    if (filePath === 'SKILL.md') return openDetail(row)
    const projectId = projectIdOf(row)
    return run(`file:${row.name}:${filePath}`, async () => {
      setNotice(null)
      setSelected({ name: row.name, source: row.source, ...(projectId !== undefined ? { projectId } : {}), file: filePath })
      setEditing(null)
      setDetail(null)
      setFileDetail(await getSkillFile(workspaceId, row.name, filePath, projectId))
    })
  }

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
  const nameReserved = editing?.isNew === true && RESERVED_SKILL_NAMES.has(newName.trim())
  const nameInvalid = editing?.isNew === true && newName.trim() !== '' && (!SKILL_NAME.test(newName.trim()) || nameReserved)
  const nameTaken = editing?.isNew === true && allNames.includes(newName.trim())
  const unchanged = editing !== null && !editing.isNew && content === editing.loaded
  const cannotSave = name === '' || content.trim() === '' || nameInvalid || nameTaken || unchanged

  const save = (hashOverride?: string): Promise<void> => run('save', async () => {
    if (editing === null) return
    try {
      const saved = await saveSkill(workspaceId, name, content, hashOverride ?? editing.hash ?? undefined)
      setNotice(savedNotice(saved))
      setEditing(null)
      setDetail(null)
      setSelected(null)
      await refresh()
      onChanged()
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
    setNotice(savedNotice(saved))
    setEditing(null)
    await refresh()
    onChanged()
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
    onChanged()
  })

  const toggleCatalog = (row: SkillRow): Promise<void> => run(`catalog:${row.name}`, async () => {
    const next = !(row.hidden ?? false)
    await setSkillHidden(workspaceId, row.name, next)
    setNotice({
      kind: 'ok',
      text: next
        ? `${row.name} is hidden from discovery by name across every layer; Skill load by exact name still works.`
        : `${row.name} is back in the skill catalog.`,
    })
    await refresh()
    onChanged()
  })

  const badgeTone = (source: SkillRow['source']): 'blue' | 'green' | 'gray' =>
    source === 'workspace' ? 'blue' : source === 'project' ? 'green' : 'gray'
  const sourceLabel = (source: SkillRow['source']): string =>
    source === 'project' ? 'Project' : source === 'workspace' ? 'Workspace' : source === 'user' ? 'User' : 'Bundled'

  /** Fixed-height bar at the top of the detail pane: identity + catalog toggle. */
  const paneHeader = (title: ReactNode, trailing?: ReactNode): ReactNode => (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
      {title}
      <span className="min-w-0 flex-1" />
      {trailing}
    </div>
  )
  /** Second bar: the open file's path plus file-level actions. */
  const pathBar = (filePath: string, actions?: ReactNode): ReactNode => (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
      <Icon name={fileIconName(filePath)} size={13} className="shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{filePath}</span>
      {actions}
    </div>
  )
  /** A quiet one-line read-only marker (a full Notice card is too loud per file). */
  const readOnlyLine = (text: string): ReactNode => (
    <p className="m-0 mb-3 flex items-center gap-1.5 text-xs text-fg-faint">
      <Icon name="lock" size={12} className="shrink-0" />{text}
    </p>
  )
  const skillTitle = (name: string, source: SkillRow['source']): ReactNode => (
    <>
      <Icon name="zap" size={14} className="shrink-0 text-fg-muted" />
      <span className="min-w-0 truncate text-sm font-medium text-fg">{name}</span>
      <Badge tone={badgeTone(source)}>{sourceLabel(source)}</Badge>
    </>
  )

  const detailBody = (): ReactNode => {
    if (editing !== null) {
      return (
        <>
          {paneHeader(
            <span className="text-sm font-medium text-fg">{editing.isNew ? 'New skill' : `Edit ${editing.name}`}</span>,
            <Badge tone="blue">Workspace</Badge>,
          )}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {editing.isNew ? (
              <Field
                label="Name"
                tone={nameInvalid || nameTaken ? 'bad' : 'default'}
                hint={nameReserved ? `'${newName.trim()}' is reserved; choose another name.` : nameInvalid ? 'Use lowercase letters, numbers, and single hyphens.' : nameTaken ? 'A skill with this name exists — open it from the tree instead.' : 'Kebab-case folder name, e.g. deploy-notes.'}
              >
                <TextInput mono invalid={nameInvalid || nameTaken} value={newName} placeholder="deploy-notes" onChange={(e) => setNewName(e.target.value)} />
              </Field>
            ) : null}
            <Field label="SKILL.md" hint="Markdown with frontmatter (name, description).">
              <CodeArea tall value={content} placeholder={SKILL_PLACEHOLDER} onChange={(e) => setContent(e.target.value)} />
            </Field>
            {conflict ? <ConflictBanner what="file" busy={busy !== null} onReload={() => void reloadServer()} onOverwrite={() => void overwrite()} /> : null}
          </div>
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">
            <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => guardDiscard(() => { setEditing(null); setConflict(false) })}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy !== null || cannotSave} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save skill'}</Button>
          </div>
        </>
      )
    }
    if (selected === null || (selected.file === 'SKILL.md' ? detail === null : fileDetail === null)) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Icon name="fileText" size={20} className="text-fg-faint" />
          <p className="m-0 text-[13px] text-fg-muted">Select a skill or one of its files to preview it.</p>
        </div>
      )
    }
    if (selected.file !== 'SKILL.md' && fileDetail !== null) {
      return (
        <>
          {paneHeader(skillTitle(selected.name, selected.source))}
          {pathBar(fileDetail.path)}
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {readOnlyLine('Preview only — edit with an external editor; changes load on the next read.')}
            <pre className="m-0 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">{fileDetail.content}</pre>
          </div>
        </>
      )
    }
    if (detail === null) return null
    const readOnly = selected.source !== 'workspace'
    return (
      <>
        {paneHeader(
          skillTitle(detail.name, selected.source),
          <label className="flex cursor-pointer items-center gap-1.5 text-[13px] text-fg-muted" title="Offer this skill in the model's skill catalog">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              aria-label={`Offer ${detail.name} in the skill catalog`}
              checked={!(detail.hidden ?? false)}
              disabled={busy !== null}
              onChange={() => void toggleCatalog({ ...detail, source: selected.source })}
            />
            In catalog
          </label>,
        )}
        {pathBar('SKILL.md', !readOnly ? (
          deleteName === detail.name ? (
            <InlineConfirm
              message={`Delete “${detail.name}”?`}
              confirmLabel="Delete"
              busy={busy === `delete:${detail.name}`}
              onConfirm={() => void remove(detail)}
              onCancel={() => setDeleteName(null)}
            />
          ) : (
            <>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openEditorFromDetail(detail)}>
                <Icon name="pencil" size={13} />Edit raw
              </Button>
              <IconButton label={`Delete ${detail.name}`} disabled={busy !== null} onClick={() => setDeleteName(detail.name)}><Icon name="trash" size={14} /></IconButton>
            </>
          )
        ) : undefined)}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-4 text-[13px]">
          {readOnly ? readOnlyLine('Read-only layer — edit with an external editor; changes load on the next read.') : null}
          <Markdown content={detail.instructions} />
        </div>
      </>
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
      <SubTabs
        label="Skills view"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'skills', label: 'Skills', icon: 'zap', count: totalSkills },
          { value: 'folders', label: 'Source folders', icon: 'folder', count: rules.length },
        ]}
      />
      {tab === 'skills' ? (
        <div className="grid h-[min(560px,calc(100vh-460px))] min-h-[360px] overflow-hidden rounded-xl border border-line md:grid-cols-[minmax(260px,320px)_1fr]">
          <div className="flex min-h-0 flex-col border-b border-line md:border-r md:border-b-0">
            <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
              <span className="text-[11px] font-semibold tracking-wider text-fg-faint uppercase">Skills</span>
              <span className="min-w-0 flex-1" />
              <IconButton label="Refresh skills" disabled={busy !== null} onClick={() => void refresh()}><Icon name="refresh" size={14} /></IconButton>
              <IconButton label="New skill" disabled={busy !== null} onClick={() => guardDiscard(beginNew)}><Icon name="plus" size={14} /></IconButton>
            </div>
            <div className="flex shrink-0 gap-2 border-b border-line p-2">
              <div className="min-w-0 flex-1">
                <TextInput
                  className="h-8"
                  leading={<Icon name="search" size={13} />}
                  aria-label="Search skills"
                  value={search}
                  placeholder="Search skills"
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="w-[112px] shrink-0">
                <Select
                  label="Filter by layer"
                  triggerClassName="h-8 px-2.5 text-[13px]"
                  value={sourceFilter}
                  onChange={(value) => setSourceFilter(value as 'all' | SkillRow['source'])}
                  options={[
                    { value: 'all', label: `All (${totalSkills})` },
                    { value: 'project', label: 'Project' },
                    { value: 'workspace', label: 'Workspace' },
                    { value: 'user', label: 'User' },
                    { value: 'bundled', label: 'Bundled' },
                  ]}
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tree" aria-label="Skills">
              {visibleGroups.length === 0 ? (
                <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">{totalSkills === 0 ? 'No skills yet.' : 'No skills match.'}</p>
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
                      const key = `${group.key}:${row.name}`
                      const isOpen = expanded.has(key)
                      const files = filesByKey[key]
                      const shadowedIn = group.source !== 'project' ? shadowingProjects(row.name) : []
                      const overrides = group.source === 'project' ? overriddenBase(row.name) : undefined
                      const description = row.description !== '' ? row.description : row.title !== row.name ? row.title : ''
                      const rowActive = selected?.name === row.name && selected.source === row.source
                      return (
                        <div key={key} role="treeitem" aria-expanded={isOpen}>
                          <div className={`${TREE_ROW} pl-6 ${rowActive && !isOpen ? 'bg-hover' : ''}`}>
                            <button
                              type="button"
                              aria-label={`Toggle ${row.name}`}
                              className="flex size-6 shrink-0 items-center justify-center rounded-md text-fg-faint outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-link"
                              onClick={() => toggleSkill(row, key)}
                            >
                              <Icon name="chevron" size={12} className={`transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                            </button>
                            <button
                              type="button"
                              title={description !== '' ? `${row.name} — ${description}` : row.name}
                              aria-selected={rowActive}
                              className={`flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-link ${(row.hidden ?? false) ? 'text-fg-faint' : 'text-fg'}`}
                              onClick={() => guardDiscard(() => { if (!isOpen) toggleSkill(row, key); void openDetail(row) })}
                            >
                              <Icon name={isOpen ? 'folderOpen' : 'folder'} size={14} className="shrink-0 text-fg-muted" />
                              <span className="min-w-0 truncate">{row.name}</span>
                            </button>
                            {(row.hidden ?? false) ? <span title="Hidden from the catalog" className="flex shrink-0"><Icon name="eyeOff" size={12} className="text-fg-faint" /></span> : null}
                            {overrides !== undefined ? (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-bad"
                                title={`Overrides the ${sourceLabel(overrides.source).toLowerCase()} skill “${row.name}” in this project's sessions — review this project copy before trusting it.`}
                                role="img"
                                aria-label="Overrides another layer"
                              />
                            ) : null}
                            {shadowedIn.length > 0 ? (
                              <span
                                className="size-1.5 shrink-0 rounded-full bg-warn"
                                title={`Shadowed: also defined in ${shadowedIn.join(', ')} — that copy wins for those projects' sessions (first match in the rule list).`}
                                role="img"
                                aria-label="Shadowed in a project"
                              />
                            ) : null}
                          </div>
                          {isOpen ? (
                            files === undefined ? (
                              <p className="m-0 flex h-7 items-center pl-[68px] text-xs text-fg-faint">Loading…</p>
                            ) : files.map((file) => {
                              const fileActive = rowActive && selected?.file === file.path
                              return (
                                <button
                                  key={file.path}
                                  type="button"
                                  role="treeitem"
                                  aria-label={file.path}
                                  className={`${TREE_ROW} gap-1.5 pl-[52px] ${fileActive ? 'bg-hover text-fg' : 'text-fg-muted'}`}
                                  onClick={() => guardDiscard(() => void openFile(row, file.path))}
                                >
                                  <Icon name={fileIconName(file.path)} size={13} className="shrink-0 text-fg-faint" />
                                  <span className="min-w-0 truncate">{file.path}</span>
                                </button>
                              )
                            })
                          ) : null}
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
      ) : (
        <Section title="Source folders" count={rules.length}>
          <FoldersEditor
            workspaceId={workspaceId}
            rules={rules}
            onSaved={(saved) => { setRules(saved.rules); void refresh(); onChanged() }}
            setNotice={setNotice}
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
}): ReactNode {
  const [newKind, setNewKind] = useScopedState<'project' | 'absolute'>('project')
  const [newPath, setNewPath] = useScopedState('')
  /** Rule awaiting a remove confirmation: removing saves immediately. */
  const [removing, setRemoving] = useScopedState<string | null>(null)
  const { busy, run } = useActionRunner((text) => props.setNotice({ kind: 'bad', text }))

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
                <InlineSwitch
                  label="Enabled"
                  ariaLabel={`Enable ${rowLabel(rule)}`}
                  checked={rule.enabled}
                  disabled={busy !== null}
                  onChange={() => void persist(props.rules.map((candidate) => (candidate.id === rule.id ? { ...candidate, enabled: !candidate.enabled } : candidate)))}
                />
                <RowMenu
                  label={`More actions for ${rowLabel(rule)}`}
                  disabled={busy !== null}
                  actions={[
                    { label: 'Move up', icon: 'arrowUp', disabled: index === 0, onSelect: () => move(index, -1) },
                    { label: 'Move down', icon: 'arrowDown', disabled: index === props.rules.length - 1, onSelect: () => move(index, 1) },
                    ...(rule.kind !== 'workspace'
                      ? [{ label: 'Remove folder', icon: 'trash' as const, danger: true, onSelect: () => setRemoving(rule.id) }]
                      : []),
                  ]}
                />
              </>
            )}
          >
            {removing === rule.id ? (
              <InlineConfirm
                message={`Stop loading skills from ${rowLabel(rule)}? Files stay on disk.`}
                confirmLabel="Remove folder"
                busy={busy !== null}
                onConfirm={() => { setRemoving(null); void persist(props.rules.filter((candidate) => candidate.id !== rule.id)) }}
                onCancel={() => setRemoving(null)}
              />
            ) : null}
          </ItemRow>
        ))}
      </ItemList>
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-line p-3">
        <div className="w-[150px] shrink-0">
          <Select
            label="New rule kind"
            triggerClassName="h-8 px-2.5 text-[13px]"
            value={newKind}
            onChange={(value) => setNewKind(value as 'project' | 'absolute')}
            options={[
              { value: 'project', label: 'Project folder' },
              { value: 'absolute', label: 'Absolute path' },
            ]}
          />
        </div>
        <div className="min-w-[200px] flex-1">
          <TextInput className="h-8" mono aria-label="New rule path" value={newPath} placeholder={newKind === 'project' ? 'Relative, e.g. .team/skills' : 'Absolute, e.g. D:/shared-skills'} onChange={(e) => setNewPath(e.target.value)} />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null || newPath.trim() === ''}
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
      <p className="text-xs text-fg-faint">New rules join at the end — the lowest precedence; raise one with the up arrow. List order is precedence: the first folder holding a skill name wins. Absolute folders are protected from file-tool grants.</p>
    </div>
  )
}
