import { useCallback, useEffect, useMemo, type ReactElement } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Markdown } from '../../Markdown.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  cloneAgentToWorkspace,
  deleteAgentDefinition,
  importAgentDefinition,
  listAgentDefinitions,
  listModelAliases,
  readAgentFile,
} from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { agentRoleIcon, AGENT_ROLE_TONE } from '../../lib/agent-icons.ts'
import type { AgentDefinitionRow, ModelAliasRow } from '../../lib/types.ts'
import {
  CodeArea,
  Disclosure,
  InlineConfirm,
  PanelBody,
  PanelFooter,
  PanelIntro,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
  FormActions,
} from './settings-kit.tsx'
import { useUnsavedChanges } from './unsaved-changes.tsx'

const AGENT_NAME = /^[A-Za-z0-9_-]+$/

const IMPORT_PLACEHOLDER = '---\nname: my-reviewer\ndescription: Reviews code. Use after changes.\ntools: Read, Grep, Glob\nmodel: inherit\n---\n\nReview carefully.'

const linesToArray = (raw: string): string[] => raw.split(/[\n,]/).map((line) => line.trim()).filter((line) => line !== '')

/**
 * A Claude Code subagent file built from the form: YAML frontmatter
 * (`tools` as a comma list, omitted to inherit every tool) plus the body.
 */
export function definitionDocument(draft: { readonly name: string; readonly description: string; readonly tools: string; readonly disallowedTools: string; readonly instructions: string; readonly model: string }): string {
  const tools = linesToArray(draft.tools)
  const disallowed = linesToArray(draft.disallowedTools)
  return [
    '---',
    `name: ${JSON.stringify(draft.name.trim())}`,
    `description: ${JSON.stringify(draft.description.trim())}`,
    // Omitted = the role inherits every tool the conversation allows (Claude).
    ...(tools.length > 0 ? [`tools: ${tools.join(', ')}`] : []),
    ...(disallowed.length > 0 ? [`disallowedTools: ${disallowed.join(', ')}`] : []),
    // Omitted entirely when blank: no key means the child inherits the
    // conversation's model, which is not the same as pinning one.
    ...(draft.model.trim() !== '' ? [`model: ${JSON.stringify(draft.model.trim())}`] : []),
    '---',
    '',
    draft.instructions.trim(),
    '',
  ].join('\n')
}

type Source = AgentDefinitionRow['source']

/** Layer order in the list: the most specific (winning) layer first. */
const SOURCE_ORDER: readonly Source[] = ['project', 'workspace', 'user', 'bundled']
const SOURCE_TONE = { bundled: 'gray', user: 'green', workspace: 'blue', project: 'amber' } as const
const SOURCE_LABEL = { bundled: 'Bundled', user: '~/.claude', workspace: 'Workspace', project: 'Project' } as const
const SOURCE_HINT = {
  bundled: 'Ships with dnt-harness. Clone it to this workspace to customize.',
  user: '~/.claude/agents — shared with Claude Code and every workspace. Clone it to change it for this workspace only.',
  workspace: 'This workspace’s agents folder. Editable here.',
  project: 'The bound project’s .claude/agents. Edit the file in the repository.',
} as const

/** `…/agents/my-role.md` → `my-role` (either separator). */
const fileStem = (file: string): string => (file.split(/[\\/]/).pop() ?? file).replace(/\.md$/, '')

/** Stable identity of a row in the list (names are case-insensitive). */
const rowKey = (row: AgentDefinitionRow): string => row.definition.name.toLowerCase()

/** What the role's model line reads: the pair it runs on, or why it inherits. */
function modelText(row: AgentDefinitionRow): { readonly short: string; readonly long: string; readonly warn: boolean } {
  const asked = row.definition.model
  const resolution = row.modelResolution
  if (resolution?.blocked === true) return { short: `${resolution.alias ?? resolution.unresolved ?? asked}?`, long: resolution.error ?? 'This model alias is unusable and blocks spawn', warn: true }
  if (resolution?.resolved !== undefined) {
    const pair = resolution.resolved
    const shortModel = resolution.alias ?? pair.slice(pair.indexOf(':') + 1)
    const thinking = resolution.alias !== undefined ? ` · thinking ${resolution.thinkingLevel ?? 'model default'}` : ''
    return { short: shortModel, long: resolution.alias !== undefined ? `${resolution.alias} → ${pair}${thinking}` : (asked !== undefined && asked !== pair ? `${asked} → ${pair}` : pair), warn: false }
  }
  if (resolution?.unresolved !== undefined) {
    return { short: `${resolution.unresolved}?`, long: `${resolution.unresolved} is not served by any provider here — runs on the conversation’s model`, warn: true }
  }
  return { short: 'inherit', long: 'Inherits the conversation’s model', warn: false }
}

/**
 * Agent roles: the definitions a conversation can delegate to, read from
 * every Claude Code layer. A list (search, grouped by layer) beside one
 * role's detail; workspace roles edit in place. Spawning a child and
 * following its result lives in the workbench Subagents view.
 */
export interface AgentsPanelProps {
  readonly workspaceId: string | null
  /** The open conversation's project: its `.claude/agents` layer is listed too. */
  readonly projectId?: string | null
  /** `provider:model` rows a role may pin; the same list the composer offers. */
  readonly modelOptions?: readonly { readonly value: string; readonly label: string }[]
}

export function AgentsPanel(props: AgentsPanelProps) {
  // Scope changes remount before paint: no A data or drafts can be acted on in B.
  return <AgentsPanelContent key={`${props.workspaceId}:${props.projectId ?? ''}`} {...props} />
}

interface Draft {
  /** The workspace file this draft overwrites (edit), or undefined (create). */
  readonly file?: string
  readonly name: string
  readonly description: string
  readonly tools: string
  readonly disallowedTools: string
  readonly instructions: string
  readonly model: string
}

const EMPTY_DRAFT: Draft = { name: '', description: '', tools: '', disallowedTools: '', instructions: '', model: '' }

function draftOf(row: AgentDefinitionRow): Draft {
  const definition = row.definition
  return {
    ...(row.path === undefined ? {} : { file: fileStem(row.path) }),
    name: definition.name,
    description: definition.description,
    // A role that inherits every tool keeps the field blank (= inherit).
    tools: definition.inheritsTools === true ? '' : definition.tools.join(', '),
    disallowedTools: definition.disallowedTools.join(', '),
    instructions: definition.instructions,
    model: definition.model ?? '',
  }
}

type View =
  | { readonly kind: 'role'; readonly key: string }
  | { readonly kind: 'edit'; readonly key: string | undefined }
  | { readonly kind: 'paste' }

function AgentsPanelContent({ workspaceId, projectId, modelOptions }: AgentsPanelProps) {
  const [definitions, setDefinitions] = useScopedState<readonly AgentDefinitionRow[] | null>(null)
  const [aliases, setAliases] = useScopedState<readonly ModelAliasRow[]>([])
  const [view, setView] = useScopedState<View | null>(null)
  const [search, setSearch] = useScopedState('')
  const [sourceFilter, setSourceFilter] = useScopedState<'all' | Source>('all')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [confirmDelete, setConfirmDelete] = useScopedState(false)
  const [draft, setDraft] = useScopedState<Draft>(EMPTY_DRAFT)
  const [draftOrigin, setDraftOrigin] = useScopedState<Draft>(EMPTY_DRAFT)
  const [importName, setImportName] = useScopedState('')
  const [importContent, setImportContent] = useScopedState('')
  const [importDialect, setImportDialect] = useScopedState<'claude' | 'codex'>('claude')
  const [importVersion, setImportVersion] = useScopedState('')
  /** Edit mode for an existing file: the form, or the file text itself (every Claude field kept). */
  const [editMode, setEditMode] = useScopedState<'form' | 'file'>('form')
  const [rawFile, setRawFile] = useScopedState<{ readonly content: string; readonly hash: string } | null>(null)
  const [rawDraft, setRawDraft] = useScopedState('')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refreshDefinitions = useCallback(async () => {
    if (workspaceId === null) return
    try { setDefinitions(await listAgentDefinitions(workspaceId, projectId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId, projectId])

  useEffect(() => { void refreshDefinitions() }, [refreshDefinitions])
  useEffect(() => { void listModelAliases().then(setAliases).catch(() => setAliases([])) }, [])

  const rows = definitions ?? []
  const groups = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return SOURCE_ORDER
      .filter((source) => sourceFilter === 'all' || sourceFilter === source)
      .map((source) => ({
        source,
        rows: rows.filter((row) => row.source === source && (needle === ''
          || `${row.definition.name}\n${row.definition.description}\n${row.definition.model ?? ''}`.toLowerCase().includes(needle))),
      }))
      .filter((group) => group.rows.length > 0)
  }, [rows, search, sourceFilter])

  // Default selection: the first listed role, once the list arrives.
  const firstKey = groups[0]?.rows[0] !== undefined ? rowKey(groups[0].rows[0]) : undefined
  const activeView: View | null = view ?? (firstKey !== undefined ? { kind: 'role', key: firstKey } : null)
  const current = activeView?.kind === 'role' || activeView?.kind === 'edit'
    ? rows.find((row) => rowKey(row) === activeView.key)
    : undefined

  const draftDirty = activeView?.kind === 'edit' && (
    editMode === 'file' ? rawFile !== null && rawDraft !== rawFile.content : JSON.stringify(draft) !== JSON.stringify(draftOrigin)
  )
  const pasteDirty = activeView?.kind === 'paste' && importContent.trim() !== ''
  // The Settings-wide discard dialog (not a browser alert) guards leaving a draft.
  const guardDiscard = useUnsavedChanges(draftDirty || pasteDirty)
  const [collapsed, setCollapsed] = useScopedState<ReadonlySet<Source>>(new Set())
  /** Search always shows its matches, even inside a collapsed layer. */
  const groupOpen = (source: Source): boolean => search.trim() !== '' || !collapsed.has(source)

  if (workspaceId === null) return <WorkspaceRequired />

  /** Switch view now (callers that may drop a draft go through {@link go}). */
  const show = (next: View): void => {
    setConfirmDelete(false)
    setNotice(null)
    setView(next)
  }
  /** Leaving an unsaved draft asks first, through the Settings discard dialog. */
  const go = (next: View): void => guardDiscard(() => show(next))
  const beginEdit = (row: AgentDefinitionRow | undefined): void => {
    const next = row === undefined ? EMPTY_DRAFT : draftOf(row)
    show({ kind: 'edit', key: row !== undefined ? rowKey(row) : undefined })
    setDraft(next)
    setDraftOrigin(next)
    setRawFile(null)
    setRawDraft('')
    setEditMode('form')
  }
  /** Load the file text (and its hash) into the raw editor. */
  const loadFile = async (file: string): Promise<void> => {
    const read = await readAgentFile(workspaceId, file)
    setRawFile(read)
    setRawDraft(read.content)
    setEditMode('file')
  }
  const openFileMode = (file: string): Promise<void> => run('read', () => loadFile(file))

  /**
   * Clone a ~/.claude or bundled role into this workspace: the same name and
   * the file copied verbatim, so the copy overrides the global role here and
   * opens straight in the editor.
   */
  const cloneToWorkspace = (row: AgentDefinitionRow): Promise<void> => run('clone', async () => {
    const { definition: cloned } = await cloneAgentToWorkspace(workspaceId, row.definition.name)
    await refreshDefinitions()
    beginEdit(cloned)
    if (cloned.path !== undefined) await loadFile(fileStem(cloned.path))
    setNotice({ kind: 'ok', text: `Cloned ${row.definition.name} into this workspace — it now overrides the ${SOURCE_LABEL[row.source]} role here. Delete the copy to go back.` })
  })

  const saveFile = (): Promise<void> => run('save', async () => {
    if (draft.file === undefined || rawFile === null) return
    const result = await importAgentDefinition(workspaceId, draft.file, { content: rawDraft, dialect: 'claude', expectedHash: rawFile.hash })
    await refreshDefinitions()
    const name = result.definition?.definition.name ?? draft.name
    setRawFile(null)
    setView({ kind: 'role', key: name.toLowerCase() })
    setNotice({ kind: 'ok', text: `Saved ${name}${result.warnings !== undefined && result.warnings.length > 0 ? ` — ${result.warnings.join('; ')}` : ''}.` })
  })

  const removeDefinition = (row: AgentDefinitionRow): Promise<void> => run('delete', async () => {
    const file = row.path !== undefined ? fileStem(row.path) : row.definition.name
    await deleteAgentDefinition(workspaceId, file)
    setConfirmDelete(false)
    setView(null)
    setNotice({ kind: 'ok', text: `Deleted ${row.definition.name}.` })
    await refreshDefinitions()
  })

  const draftInvalid = !AGENT_NAME.test(draft.name.trim())
    ? 'Name: letters, numbers, underscores or hyphens.'
    : draft.description.trim() === ''
      ? 'Describe when to use this role — the delegating model reads it to choose.'
      : draft.instructions.trim() === ''
        ? 'Add the instructions the child agent receives.'
        : null

  const saveDraft = (): Promise<void> => run('save', async () => {
    if (draftInvalid !== null) { setNotice({ kind: 'bad', text: draftInvalid }); return }
    const name = draft.name.trim()
    // Editing keeps the file the role came from; creating names the file after the role.
    const file = draft.file ?? name
    const result = await importAgentDefinition(workspaceId, file, { content: definitionDocument(draft), dialect: 'claude' })
    await refreshDefinitions()
    setDraftOrigin(draft)
    setView({ kind: 'role', key: name.toLowerCase() })
    setNotice({ kind: 'ok', text: `Saved ${name}${result.warnings !== undefined && result.warnings.length > 0 ? ` — ${result.warnings.join('; ')}` : ''}.` })
  })

  const codexNeedsVersion = importDialect === 'codex' && importVersion.trim() === ''
  const importDefinition = (): Promise<void> => run('import', async () => {
    const name = importName.trim()
    const result = await importAgentDefinition(workspaceId, name, {
      content: importContent,
      dialect: importDialect,
      ...(importDialect === 'codex' ? { sourceVersion: importVersion.trim() } : {}),
    })
    await refreshDefinitions()
    setImportName('')
    setImportContent('')
    setView({ kind: 'role', key: (result.definition?.definition.name ?? name).toLowerCase() })
    setNotice({ kind: 'ok', text: `Saved ${name}${result.warnings !== undefined && result.warnings.length > 0 ? ` — ${result.warnings.join('; ')}` : ''}.` })
  })

  const field = (key: keyof Omit<Draft, 'file'>) => (value: string): void => setDraft((prev) => ({ ...prev, [key]: value }))

  const detail = (): ReactElement => {
    if (activeView?.kind === 'paste') {
      return (
        <>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <h3 className="m-0 truncate text-sm font-semibold">Paste a subagent file</h3>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p className="m-0 text-xs text-fg-muted">
            A Claude Code subagent file, saved verbatim into this workspace’s <code>agents/</code> folder. Fields dnt-harness does not
            enforce (hooks, mcpServers, permissionMode, memory…) are kept and listed as notes.
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="File name">
              <TextInput mono value={importName} placeholder="my-reviewer" onChange={(e) => setImportName(e.target.value)} />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Format</span>
              <Segmented
                label="Import format"
                value={importDialect}
                options={[{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex (pinned)' }]}
                onChange={setImportDialect}
              />
            </div>
            {importDialect === 'codex' ? (
              <Field label="Pinned Codex version" hint="Required. Must match the pinned adapter version." tone={codexNeedsVersion && importContent.trim() !== '' ? 'bad' : 'default'}>
                <TextInput mono value={importVersion} onChange={(e) => setImportVersion(e.target.value)} />
              </Field>
            ) : null}
          </div>
          <Field label="Subagent file (Markdown + YAML frontmatter)">
            <CodeArea rows={12} value={importContent} placeholder={IMPORT_PLACEHOLDER} onChange={(e) => setImportContent(e.target.value)} />
          </Field>
          <FormActions>
            <Button variant="ghost" size="sm" onClick={() => go({ kind: 'role', key: firstKey ?? '' })}>Cancel</Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy !== null || importName.trim() === '' || importContent.trim() === '' || codexNeedsVersion}
              onClick={() => void importDefinition()}
            >
              {busy === 'import' ? 'Saving…' : 'Save subagent'}
            </Button>
          </FormActions>
        </div>
        </>
      )
    }

    if (activeView?.kind === 'edit') {
      const editing = draft.file !== undefined
      const lossy = current?.definition.unsupported ?? []
      const bar = (
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold">{editing ? `Edit ${draftOrigin.name}` : 'New role'}</h3>
            {editing ? (
              <Segmented
                label="Edit as"
                value={editMode}
                options={[{ value: 'form', label: 'Form' }, { value: 'file', label: 'File' }]}
                onChange={(next) => {
                  if (next === editMode) return
                  guardDiscard(() => {
                    if (next === 'file' && draft.file !== undefined) void openFileMode(draft.file)
                    else { setEditMode('form'); setDraft(draftOrigin) }
                  })
                }}
              />
            ) : null}
        </div>
      )
      const header = (
        <p className="m-0 text-xs text-fg-muted">
          {editing
            ? <>Saved to this workspace’s <code>agents/{draft.file}.md</code> as a Claude Code subagent file.</>
            : <>Saved to this workspace’s <code>agents/</code> folder as a Claude Code subagent file.</>}
        </p>
      )
      if (editMode === 'file') {
        return (
          <>
          {bar}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {header}
            <Field label="Subagent file" hint="The exact file Claude Code reads: YAML frontmatter + Markdown body. Every field is kept.">
              <CodeArea tall value={rawDraft} disabled={rawFile === null} onChange={(e) => setRawDraft(e.target.value)} />
            </Field>
            <FormActions>
              <Button variant="ghost" size="sm" onClick={() => go(current !== undefined ? { kind: 'role', key: rowKey(current) } : { kind: 'role', key: firstKey ?? '' })}>Cancel</Button>
              <Button variant="primary" size="sm" disabled={busy !== null || !draftDirty || rawDraft.trim() === ''} onClick={() => void saveFile()}>
                {busy === 'save' ? 'Saving…' : 'Save file'}
              </Button>
            </FormActions>
          </div>
          </>
        )
      }
      return (
        <>
        {bar}
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {header}
          {editing && lossy.length > 0 ? (
            <p className="m-0 rounded-lg border border-warn/40 px-3 py-2 text-xs text-warn">
              Saving the form rewrites the file without {lossy.map((key) => `\`${key}\``).join(', ')}. Switch to File to keep them.
            </p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" hint="Letters, numbers, underscores or hyphens.">
              <TextInput mono value={draft.name} placeholder="security-reviewer" onChange={(e) => field('name')(e.target.value)} />
            </Field>
            <Field label="Model" hint="Inherit follows the conversation.">
              <Select
                label="Role model"
                value={draft.model}
                options={[
                  { value: '', label: 'Inherit from the conversation' },
                  ...(['sonnet', 'opus', 'haiku'].includes(draft.model) ? [{ value: draft.model, label: `${draft.model} (built-in alias)` }] : []),
                  ...aliases.map((alias) => ({ value: alias.name, label: `${alias.name} → ${alias.provider}:${alias.model}${alias.status === 'invalid' ? ' (unusable)' : ''}`, disabled: alias.status === 'invalid' })),
                  ...(modelOptions ?? []).map((option) => ({ value: option.value, label: option.label })),
                  ...(draft.model !== '' && !['sonnet', 'opus', 'haiku'].includes(draft.model) && !(modelOptions ?? []).some((option) => option.value === draft.model) ? [{ value: draft.model, label: draft.model }] : []),
                ]}
                onChange={field('model')}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Description" hint="When to use this role — the delegating model reads it to choose.">
                <CodeArea rows={2} value={draft.description} placeholder="Reviews changes for correctness. Use after an edit." onChange={(e) => field('description')(e.target.value)} />
              </Field>
            </div>
            <Field label="tools" hint="Comma or line separated. Blank = every tool the conversation allows.">
              <TextInput mono value={draft.tools} placeholder="Read, Grep, Glob" onChange={(e) => field('tools')(e.target.value)} />
            </Field>
            <Field label="disallowedTools" hint="Denied even when the conversation allows them.">
              <TextInput mono value={draft.disallowedTools} placeholder="Bash, Write" onChange={(e) => field('disallowedTools')(e.target.value)} />
            </Field>
            <div className="md:col-span-2">
              <Field label="Instructions" hint="The system prompt the child agent receives (Markdown).">
                <CodeArea rows={10} value={draft.instructions} placeholder="Review carefully and report file references." onChange={(e) => field('instructions')(e.target.value)} />
              </Field>
            </div>
          </div>
          <FormActions>
            {draftInvalid !== null ? <span className="mr-auto text-xs text-fg-faint">{draftInvalid}</span> : null}
            <Button variant="ghost" size="sm" onClick={() => go(current !== undefined ? { kind: 'role', key: rowKey(current) } : { kind: 'role', key: firstKey ?? '' })}>Cancel</Button>
            <Button variant="primary" size="sm" disabled={busy !== null || draftInvalid !== null || !draftDirty} onClick={() => void saveDraft()}>
              {busy === 'save' ? 'Saving…' : editing ? 'Save changes' : 'Create role'}
            </Button>
          </FormActions>
        </div>
        </>
      )
    }

    if (current === undefined) {
      return <p className="m-auto px-6 text-center text-[13px] text-fg-muted">{definitions === null ? 'Loading roles…' : 'Select a role.'}</p>
    }
    const definition = current.definition
    const model = modelText(current)
    const dropped = definition.droppedTools ?? []
    const unsupported = definition.unsupported ?? []
    return (
      <>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[agentRoleIcon(definition.name)])}>
            <Icon name={agentRoleIcon(definition.name)} size={13} />
          </span>
          <h3 className="m-0 min-w-0 truncate text-sm font-semibold">{definition.name}</h3>
          <Badge tone={SOURCE_TONE[current.source]}>{SOURCE_LABEL[current.source]}</Badge>
          {current.overrides !== undefined && current.overrides.length > 0 ? (
            <span className="hidden shrink-0 text-xs text-fg-faint xl:inline">overrides {current.overrides.map((source) => SOURCE_LABEL[source]).join(', ')}</span>
          ) : null}
          <span className="min-w-0 flex-1" />
          <div className="flex shrink-0 gap-1.5">
            {current.source === 'workspace' ? (
              <>
                <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => beginEdit(current)}><Icon name="pencil" size={13} />Edit</Button>
                <Button variant="outline-danger" size="sm" disabled={busy !== null || confirmDelete} onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={13} />{current.overrides !== undefined && current.overrides.length > 0 ? 'Remove override' : 'Delete'}
                </Button>
              </>
            ) : current.source === 'project' ? null : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                title="Copy this file into the workspace under the same name; the copy overrides it here and can be edited."
                onClick={() => void cloneToWorkspace(current)}
              >
                <Icon name="copy" size={13} />{busy === 'clone' ? 'Cloning…' : 'Clone to workspace'}
              </Button>
            )}
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <p className="m-0 text-[13px] text-fg-muted">{definition.description}</p>
          {confirmDelete ? (
            <InlineConfirm
              message={`Delete ${definition.name} from this workspace? Existing child results remain.${current.overrides !== undefined && current.overrides.length > 0 ? ` The ${SOURCE_LABEL[current.overrides[current.overrides.length - 1]!]} role of the same name takes over.` : ''}`}
              confirmLabel="Delete role"
              busy={busy === 'delete'}
              onConfirm={() => void removeDefinition(current)}
              onCancel={() => setConfirmDelete(false)}
            />
          ) : null}

          <dl className="m-0 grid gap-x-4 gap-y-2.5 text-[13px] sm:grid-cols-[7.5rem_minmax(0,1fr)]">
            <dt className="m-0 text-fg-faint">Model</dt>
            <dd className={cn('m-0 min-w-0 break-words', model.warn && 'text-warn')}>
              {model.warn ? <Icon name="alertTriangle" size={12} className="mr-1 inline align-[-1px]" /> : null}
              <span className="font-mono text-xs">{model.long}</span>
            </dd>
            <dt className="m-0 text-fg-faint">Tools</dt>
            <dd className="m-0 flex min-w-0 flex-wrap gap-1">
              {definition.inheritsTools === true
                ? <span className="text-fg-muted">Every tool the conversation allows</span>
                : definition.tools.length === 0
                  ? <span className="text-fg-muted">None</span>
                  : definition.tools.map((tool) => <code key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">{tool}</code>)}
            </dd>
            {definition.disallowedTools.length > 0 ? (
              <>
                <dt className="m-0 text-fg-faint">Denied</dt>
                <dd className="m-0 flex min-w-0 flex-wrap gap-1">
                  {definition.disallowedTools.map((tool) => <code key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-muted line-through">{tool}</code>)}
                </dd>
              </>
            ) : null}
            {dropped.length > 0 ? (
              <>
                <dt className="m-0 text-warn">Not available</dt>
                <dd className="m-0 flex min-w-0 flex-col gap-1">
                  <span className="flex flex-wrap gap-1">
                    {dropped.map((tool) => <code key={tool} className="rounded border border-warn/40 px-1.5 py-0.5 font-mono text-[11px] text-warn">{tool}</code>)}
                  </span>
                  <span className="text-xs text-fg-faint">Listed in the file but not provided by dnt-harness; the role runs without them.</span>
                </dd>
              </>
            ) : null}
            {unsupported.length > 0 ? (
              <>
                <dt className="m-0 text-fg-faint">Not enforced</dt>
                <dd className="m-0 flex min-w-0 flex-wrap gap-1">
                  {unsupported.map((key) => <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-fg-muted">{key}</code>)}
                </dd>
              </>
            ) : null}
            {definition.skills !== undefined && definition.skills.length > 0 ? (
              <>
                <dt className="m-0 text-fg-faint">Skills</dt>
                <dd className="m-0 font-mono text-xs">{definition.skills.join(', ')}</dd>
              </>
            ) : null}
            <dt className="m-0 text-fg-faint">Source</dt>
            <dd className="m-0 min-w-0">
              {current.path !== undefined ? <code className="break-all font-mono text-xs" title="Copy path">{current.path}</code> : <span className="text-fg-muted">Bundled with dnt-harness</span>}
              <span className="block text-xs text-fg-faint">{SOURCE_HINT[current.source]}</span>
            </dd>
          </dl>

          <Disclosure summary="Instructions" defaultOpen>
            <div className="max-h-[420px] overflow-y-auto rounded-lg border border-line bg-surface px-3.5 py-2.5 text-[13px]">
              <Markdown content={(definition.instructions ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()} />
            </div>
          </Disclosure>
        </div>
      </>
    )
  }

  const total = rows.length
  return (
    <PanelBody>
      <PanelIntro>
        Roles are Claude Code subagent files from <code>~/.claude/agents</code>, this workspace, and the open conversation’s project
        (<code>.claude/agents</code>). When two layers define the same name, the more specific one wins. A role narrows a child agent’s
        tools; it never grants more than the conversation allows.
      </PanelIntro>

      <div className="grid min-h-[420px] grid-cols-[minmax(0,1fr)] grid-rows-[minmax(220px,40vh)_minmax(360px,1fr)] overflow-hidden rounded-xl border border-line lg:h-[min(640px,calc(100vh-300px))] lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:grid-rows-none">
        <div className="flex min-h-0 flex-col border-b border-line lg:border-r lg:border-b-0">
          <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line pr-2 pl-4">
            <span className="text-[11px] font-semibold tracking-wider text-fg-faint uppercase">Roles</span>
            <span className="text-xs text-fg-faint">{total}</span>
            <span className="min-w-0 flex-1" />
            <IconButton label="Refresh roles" disabled={busy !== null} onClick={() => void refreshDefinitions()}><Icon name="refresh" size={14} /></IconButton>
            <IconButton label="Paste a subagent file" disabled={busy !== null} onClick={() => go({ kind: 'paste' })}><Icon name="fileText" size={14} /></IconButton>
            <IconButton label="New role" disabled={busy !== null} onClick={() => guardDiscard(() => beginEdit(undefined))}><Icon name="plus" size={14} /></IconButton>
          </div>
          <div className="flex shrink-0 gap-2 border-b border-line p-2">
            <div className="min-w-0 flex-1">
              <TextInput
                className="h-8"
                leading={<Icon name="search" size={13} />}
                aria-label="Search roles"
                value={search}
                placeholder="Search roles"
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="w-[108px] shrink-0">
              <Select
                label="Filter by layer"
                triggerClassName="h-8 px-2.5 text-[13px]"
                value={sourceFilter}
                onChange={(value) => setSourceFilter(value as 'all' | Source)}
                options={[
                  { value: 'all', label: `All (${total})` },
                  ...SOURCE_ORDER.map((source) => ({ value: source, label: `${SOURCE_LABEL[source]} (${rows.filter((row) => row.source === source).length})` })),
                ]}
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox" aria-label="Agent roles">
            {definitions === null ? (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">Loading…</p>
            ) : groups.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-[13px] text-fg-muted">{total === 0 ? 'No roles.' : 'No roles match.'}</p>
            ) : groups.map((group) => (
              <div key={group.source} role="group" aria-label={SOURCE_LABEL[group.source]}>
                <button
                  type="button"
                  aria-expanded={groupOpen(group.source)}
                  onClick={() => setCollapsed((prev) => {
                    const next = new Set(prev)
                    if (next.has(group.source)) next.delete(group.source)
                    else next.add(group.source)
                    return next
                  })}
                  className="flex w-full items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-left text-[11px] font-semibold tracking-wider text-fg-faint uppercase outline-none hover:text-fg focus-visible:text-fg"
                >
                  <Icon name="chevron" size={12} className={cn('shrink-0 transition-transform', groupOpen(group.source) ? '' : '-rotate-90')} />
                  <span>{SOURCE_LABEL[group.source]}</span>
                  <span className="font-normal">{group.rows.length}</span>
                </button>
                {!groupOpen(group.source) ? null : group.rows.map((row) => {
                  const key = rowKey(row)
                  const active = (activeView?.kind === 'role' || activeView?.kind === 'edit') && activeView.key === key
                  const model = modelText(row)
                  const issues = (row.definition.droppedTools?.length ?? 0) > 0 || model.warn
                  return (
                    <button
                      key={`${group.source}:${key}`}
                      type="button"
                      role="option"
                      aria-selected={active}
                      title={row.definition.description}
                      onClick={() => go({ kind: 'role', key })}
                      className={cn(
                        'agents-row flex w-full min-w-0 items-center gap-2.5 px-4 py-1.5 text-left outline-none transition-colors hover:bg-hover focus-visible:bg-hover',
                        active && 'bg-hover',
                      )}
                    >
                      <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[agentRoleIcon(row.definition.name)])}>
                        <Icon name={agentRoleIcon(row.definition.name)} size={12} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">{row.definition.name}</span>
                          {issues ? <Icon name="alertTriangle" size={11} className="shrink-0 text-warn" aria-label="Has notes" /> : null}
                        </span>
                        <span className="truncate text-xs text-fg-faint">{row.definition.description}</span>
                      </span>
                      <span className={cn('shrink-0 font-mono text-[10px]', model.warn ? 'text-warn' : 'text-fg-faint')} title={model.long}>{model.short}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">{detail()}</div>
      </div>

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
