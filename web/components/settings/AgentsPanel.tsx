import { useCallback, useEffect, useMemo } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Segmented } from '../ui/Segmented.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  deleteAgentDefinition,
  importAgentDefinition,
  listAgentDefinitions,
} from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import type { AgentDefinitionRow } from '../../lib/types.ts'
import {
  CodeArea,
  Disclosure,
  EmptyState,
  InlineConfirm,
  PanelBody,
  PanelFooter,
  PanelIntro,
  Section,
  WorkspaceRequired,
  useActionRunner,
  type NoticeState,
} from './settings-kit.tsx'

const AGENT_NAME = /^[A-Za-z0-9_-]+$/

const IMPORT_PLACEHOLDER = '---\ndescription: "reviews code"\ntools: ["Read", "Grep"]\n---\n\nReview carefully.'

const linesToArray = (raw: string): string[] => raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')

/** A Claude-dialect definition document built from the create form. */
export function definitionDocument(draft: { readonly name: string; readonly description: string; readonly tools: string; readonly disallowedTools: string; readonly instructions: string; readonly model: string }): string {
  const list = (raw: string): string => JSON.stringify(linesToArray(raw))
  return [
    '---',
    `name: ${JSON.stringify(draft.name.trim())}`,
    `description: ${JSON.stringify(draft.description.trim())}`,
    `tools: ${list(draft.tools)}`,
    `disallowedTools: ${list(draft.disallowedTools)}`,
    // Omitted entirely when blank: no key means the child inherits the
    // conversation's model, which is not the same as pinning one.
    ...(draft.model.trim() !== '' ? [`model: ${JSON.stringify(draft.model.trim())}`] : []),
    '---',
    '',
    draft.instructions.trim(),
    '',
  ].join('\n')
}

/**
 * Agent roles: the definitions a conversation can delegate to. Spawning a
 * child and following its result is runtime work and lives in the workbench
 * Agents view, where a conversation is actually selected.
 */
export interface AgentsPanelProps {
  readonly workspaceId: string | null
  /** `provider:model` rows a role may pin; the same list the composer offers. */
  readonly modelOptions?: readonly { readonly value: string; readonly label: string }[]
}

export function AgentsPanel(props: AgentsPanelProps) {
  // Scope changes remount before paint: no A data or drafts can be acted on in B.
  return <AgentsPanelContent key={props.workspaceId} {...props} />
}

function AgentsPanelContent({ workspaceId, modelOptions }: AgentsPanelProps) {
  const [definitions, setDefinitions] = useScopedState<readonly AgentDefinitionRow[]>([])
  const [selected, setSelected] = useScopedState<string>('explorer')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const [confirmDelete, setConfirmDelete] = useScopedState(false)
  const [createName, setCreateName] = useScopedState('')
  const [createDescription, setCreateDescription] = useScopedState('')
  const [createTools, setCreateTools] = useScopedState('')
  const [createDisallowed, setCreateDisallowed] = useScopedState('')
  const [createInstructions, setCreateInstructions] = useScopedState('')
  const [createModel, setCreateModel] = useScopedState('')
  const [importName, setImportName] = useScopedState('')
  const [importContent, setImportContent] = useScopedState('')
  const [importDialect, setImportDialect] = useScopedState<'claude' | 'codex'>('claude')
  const [importVersion, setImportVersion] = useScopedState('')
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refreshDefinitions = useCallback(async () => {
    if (workspaceId === null) return
    try { setDefinitions(await listAgentDefinitions(workspaceId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refreshDefinitions() }, [refreshDefinitions])

  const current = useMemo(() => definitions.find((row) => row.definition.name === selected), [definitions, selected])

  if (workspaceId === null) return <WorkspaceRequired />

  const removeDefinition = (name: string): Promise<void> => run('delete', async () => {
    await deleteAgentDefinition(workspaceId, name)
    setConfirmDelete(false)
    setSelected('explorer')
    setNotice({ kind: 'ok', text: `Deleted ${name}.` })
    await refreshDefinitions()
  })

  const createInvalid = !AGENT_NAME.test(createName.trim())
    ? 'Enter a role name using letters, numbers, underscores, or hyphens.'
    : createDescription.trim() === ''
      ? 'Describe what this role is for — the model uses it to pick a role.'
      : createInstructions.trim() === ''
        ? 'Add the instructions the child agent receives.'
        : null

  const createDefinition = (): Promise<void> => run('create', async () => {
    if (createInvalid !== null) { setNotice({ kind: 'bad', text: createInvalid }); return }
    const name = createName.trim()
    // The create form is the supported Claude subset, so it goes through the
    // same import path — one validation and provenance rule, not two.
    await importAgentDefinition(workspaceId, name, {
      content: definitionDocument({ name, description: createDescription, tools: createTools, disallowedTools: createDisallowed, instructions: createInstructions, model: createModel }),
      dialect: 'claude',
    })
    await refreshDefinitions()
    setSelected(name)
    setCreateName('')
    setCreateDescription('')
    setCreateTools('')
    setCreateDisallowed('')
    setCreateInstructions('')
    setNotice({ kind: 'ok', text: `Created ${name}.` })
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
    setSelected(name)
    setImportName('')
    setImportContent('')
    setNotice({
      kind: 'ok',
      text: `Imported ${result.imported.join(', ')}${result.blocked !== undefined && result.blocked.length > 0 ? ` — blocked: ${result.blocked.join(', ')}` : ''}`,
    })
  })

  return (
    <PanelBody>
      <PanelIntro>
        A role narrows a child agent's tools; it never grants more than the workspace allows. Delegate to a role and
        follow its result from the Agents view of the workbench, beside the conversation it belongs to.
      </PanelIntro>

      <Section title="Roles" count={definitions.length}>
        {definitions.length === 0 ? <EmptyState>No agent definitions in this workspace.</EmptyState> : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="group" aria-label="Agent roles">
            {definitions.map((row) => {
              const isSelected = row.definition.name === selected
              return (
                <button
                  key={row.definition.name}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => { setSelected(row.definition.name); setConfirmDelete(false) }}
                  className={cn(
                    'flex min-w-0 flex-col items-start gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors hover:bg-hover',
                    isSelected ? 'border-fg bg-hover' : 'border-line',
                  )}
                >
                  <span className="flex w-full min-w-0 items-center gap-2 text-sm font-medium">
                    <span className="truncate">{row.definition.name}</span>
                    <Badge tone={row.source === 'workspace' ? 'blue' : 'gray'}>{row.source}</Badge>
                  </span>
                  <span className="line-clamp-2 text-xs text-fg-muted">{row.definition.description}</span>
                  <span className="text-xs text-fg-faint">{row.definition.tools.length > 0 ? `${row.definition.tools.length} tools` : 'All allowed tools'}</span>
                </button>
              )
            })}
          </div>
        )}
      </Section>

      {current !== undefined ? (
        <Section
          title={current.definition.name}
          actions={current.source === 'workspace' && !confirmDelete
            ? <IconButton label={`Delete ${current.definition.name}`} disabled={busy !== null} onClick={() => setConfirmDelete(true)}><Icon name="trash" size={14} /></IconButton>
            : undefined}
        >
          <dl className="m-0 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[8rem_minmax(0,1fr)]">
            <dt className="m-0 text-fg-faint">Tools</dt>
            <dd className="m-0 min-w-0 break-words">{current.definition.tools.length > 0 ? current.definition.tools.join(', ') : 'All allowed tools'}</dd>
            <dt className="m-0 text-fg-faint">Model</dt>
            <dd className="m-0 min-w-0 break-words">{current.definition.model ?? 'Inherits the conversation'}</dd>
            {current.definition.disallowedTools.length > 0 ? (
              <>
                <dt className="m-0 text-fg-faint">Always denied</dt>
                <dd className="m-0 min-w-0 break-words">{current.definition.disallowedTools.join(', ')}</dd>
              </>
            ) : null}
          </dl>
          <Disclosure summary="Definition JSON">
            <pre className="m-0 max-h-72 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(current.definition, null, 2)}</pre>
          </Disclosure>
          {confirmDelete ? (
            <InlineConfirm
              message="Delete this workspace definition? Existing child results remain."
              confirmLabel="Delete definition"
              cancelLabel="Cancel"
              busy={busy === 'delete'}
              onConfirm={() => void removeDefinition(current.definition.name)}
              onCancel={() => setConfirmDelete(false)}
            />
          ) : null}
        </Section>
      ) : null}

      <Section title="Add a role">
        <Disclosure summary="Create a role">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Role name" hint="Letters, numbers, underscores, or hyphens.">
              <TextInput mono value={createName} placeholder="reviewer" onChange={(e) => setCreateName(e.target.value)} />
            </Field>
            <Field label="Description" hint="What this role is for.">
              <TextInput value={createDescription} placeholder="Reviews changes for correctness" onChange={(e) => setCreateDescription(e.target.value)} />
            </Field>
            <Field label="Tools" hint="One tool per line. Leave blank to allow every tool the workspace permits.">
              <CodeArea rows={3} value={createTools} placeholder={'Read\nGrep'} onChange={(e) => setCreateTools(e.target.value)} />
            </Field>
            <Field label="Always denied" hint="One tool per line. Denied here even when the workspace allows it.">
              <CodeArea rows={3} value={createDisallowed} placeholder={'Bash\nWrite'} onChange={(e) => setCreateDisallowed(e.target.value)} />
            </Field>
            <Field label="Model" hint="Which model children of this role run on. Leave on inherit to follow the conversation.">
              <Select
                label="Role model"
                value={createModel}
                options={[
                  { value: '', label: 'Inherit from the conversation' },
                  ...(modelOptions ?? []).map((option) => ({ value: option.value, label: option.label })),
                ]}
                onChange={setCreateModel}
              />
            </Field>
            <div className="md:col-span-2">
              <Field label="Instructions" hint="The system instructions the child agent receives.">
                <CodeArea rows={5} value={createInstructions} placeholder="Review carefully and report file references." onChange={(e) => setCreateInstructions(e.target.value)} />
              </Field>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={busy !== null || createInvalid !== null} title={createInvalid ?? undefined} onClick={() => void createDefinition()}>
              {busy === 'create' ? 'Creating…' : 'Create role'}
            </Button>
            {createInvalid !== null && createName.trim() !== '' ? <span className="text-xs text-fg-faint">{createInvalid}</span> : null}
          </div>
        </Disclosure>

        <Disclosure summary="Import a definition">
          <PanelIntro>
            Imports record provenance and never run content automatically. Unsupported security fields (hooks, mcpServers, isolation…)
            block activation and return an error.
          </PanelIntro>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Target name">
              <TextInput value={importName} placeholder="my-reviewer" onChange={(e) => setImportName(e.target.value)} />
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
            <div className="md:col-span-2">
              <Field label="Definition content">
                <CodeArea rows={7} value={importContent} placeholder={IMPORT_PLACEHOLDER} onChange={(e) => setImportContent(e.target.value)} />
              </Field>
            </div>
          </div>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || importName.trim() === '' || importContent.trim() === '' || codexNeedsVersion}
              onClick={() => void importDefinition()}
            >
              {busy === 'import' ? 'Importing…' : 'Import definition'}
            </Button>
          </div>
        </Disclosure>
      </Section>

      <PanelFooter notice={notice} />
    </PanelBody>
  )
}
