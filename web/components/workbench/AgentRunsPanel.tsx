import { useCallback, useEffect } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Badge } from '../ui/Badge.tsx'
import { Button } from '../ui/Button.tsx'
import { Field } from '../ui/Field.tsx'
import { Select } from '../ui/Select.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import {
  CodeArea,
  Disclosure,
  EmptyState,
  ItemList,
  ItemRow,
  Notice,
  type NoticeState,
  useActionRunner,
} from '../settings/settings-kit.tsx'
import { TruncatedNote } from '../chat/MessageParts.tsx'
import { cancelChild, listAgentDefinitions, listChildren, spawnChild } from '../../lib/api.ts'
import type { AgentDefinitionRow, ChildRow } from '../../lib/types.ts'

const CHILD_TONE: Readonly<Record<ChildRow['status'], 'green' | 'blue' | 'amber' | 'gray'>> = {
  running: 'blue',
  completed: 'green',
  failed: 'amber',
  cancelled: 'gray',
  interrupted: 'amber',
}

const DEFAULT_RESULT = 'bounded summary with file references'

const linesToArray = (raw: string): string[] => raw.split('\n').map((line) => line.trim()).filter((line) => line !== '')

/**
 * Delegation for the open conversation: pick a role, send a task packet, and
 * watch the children it produced. This is runtime work, not configuration, so
 * it lives beside the conversation that owns the children rather than in
 * Settings — where no conversation is selected and every control is disabled.
 * Roles themselves are still defined in Settings → Agents.
 */
export interface AgentRunsPanelProps {
  readonly workspaceId: string | null
  readonly rootSessionId: string | null
  /** `provider:model` rows, the same list the composer offers. */
  readonly modelOptions?: readonly { readonly value: string; readonly label: string }[]
  /** Bumped when the conversation itself delegates, so its children appear at once. */
  readonly refreshSignal?: number
  readonly onOpenChild?: (childSessionId: string) => void
  readonly onOpenSettings?: () => void
}

export function AgentRunsPanel(props: AgentRunsPanelProps) {
  // Scope changes remount before paint: no conversation A draft can reach B.
  return <AgentRunsPanelContent key={JSON.stringify([props.workspaceId, props.rootSessionId])} {...props} />
}

function AgentRunsPanelContent({ workspaceId, rootSessionId, modelOptions, refreshSignal, onOpenChild, onOpenSettings }: AgentRunsPanelProps) {
  const [definitions, setDefinitions] = useScopedState<readonly AgentDefinitionRow[]>([])
  const [children, setChildren] = useScopedState<readonly ChildRow[]>([])
  const [selected, setSelected] = useScopedState('')
  const [brief, setBrief] = useScopedState('')
  const [objective, setObjective] = useScopedState('')
  const [constraints, setConstraints] = useScopedState('')
  const [references, setReferences] = useScopedState('')
  const [requiredResult, setRequiredResult] = useScopedState(DEFAULT_RESULT)
  const [grants, setGrants] = useScopedState('')
  const [model, setModel] = useScopedState('')
  const [notice, setNotice] = useScopedState<NoticeState>(null)
  const { busy, run } = useActionRunner((text) => setNotice({ kind: 'bad', text }))

  const refreshChildren = useCallback(async () => {
    if (workspaceId === null || rootSessionId === null) return
    try { setChildren(await listChildren(workspaceId, rootSessionId)) }
    catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId, rootSessionId])

  const refreshDefinitions = useCallback(async () => {
    if (workspaceId === null) return
    try {
      const rows = await listAgentDefinitions(workspaceId)
      setDefinitions(rows)
      // Select the first role only while nothing is chosen, so a background
      // refresh never moves the operator's selection under them.
      setSelected((current) => (current === '' ? rows[0]?.definition.name ?? '' : current))
    } catch (cause) { setNotice({ kind: 'bad', text: String(cause) }) }
  }, [workspaceId])

  useEffect(() => { void refreshDefinitions() }, [refreshDefinitions])
  // The signal is part of the dependency list on purpose: a child the model
  // spawned itself must show up without waiting for the polling effect,
  // which only starts once a running child is already in view.
  useEffect(() => { void refreshChildren() }, [refreshChildren, refreshSignal])

  // Poll only while a child runs; polling stops by itself when none do.
  useEffect(() => {
    if (workspaceId === null || rootSessionId === null) return
    if (!children.some((child) => child.status === 'running')) return
    const timer = window.setInterval(() => { void refreshChildren() }, 3000)
    return () => { window.clearInterval(timer) }
  }, [children, workspaceId, rootSessionId, refreshChildren])

  if (workspaceId === null) {
    return <div className="p-4"><Notice kind="info" text="Choose a workspace first." /></div>
  }
  if (rootSessionId === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="gitBranch" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No conversation selected</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">Open a conversation to delegate work to a child agent and follow its result here.</p>
      </div>
    )
  }

  const current = definitions.find((row) => row.definition.name === selected)

  const canSpawn = selected !== '' && (brief.trim() !== '' || objective.trim() !== '')

  const spawn = (): Promise<void> => run('spawn', async () => {
    if (!canSpawn) return
    const result = requiredResult.trim() === '' ? 'bounded summary' : requiredResult.trim()
    // The prose brief is the primary form; the structured packet stays
    // available in the disclosure and is sent unchanged when used alone.
    const task = brief.trim() !== ''
      ? {
          prompt: brief.trim(),
          ...(linesToArray(constraints).length > 0 ? { constraints: linesToArray(constraints) } : {}),
          ...(linesToArray(references).length > 0 ? { references: linesToArray(references) } : {}),
          requiredResult: result,
        }
      : {
          objective: objective.trim(),
          constraints: linesToArray(constraints),
          references: linesToArray(references),
          requiredResult: result,
        }
    const handle = await spawnChild(workspaceId, selected, rootSessionId, task, linesToArray(grants), model)
    setNotice({ kind: 'ok', text: `Spawned ${handle.definitionName} (${handle.childSessionId.slice(0, 12)}…)` })
    setBrief('')
    setObjective('')
    await refreshChildren()
  })

  const cancel = (child: ChildRow): Promise<void> => run(`cancel:${child.childSessionId}`, async () => {
    try { await cancelChild(workspaceId, child.childSessionId) }
    finally { await refreshChildren() }
  })

  const running = children.filter((child) => child.status === 'running').length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-w-0 flex-col gap-5 p-4">
          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-sm font-semibold">Delegate a task</h3>
              {onOpenSettings !== undefined ? (
                <Button variant="ghost" size="sm" onClick={onOpenSettings}>Manage roles<Icon name="chevronRight" size={13} /></Button>
              ) : null}
            </div>

            {definitions.length === 0 ? (
              <EmptyState>No agent roles in this workspace. Add one in Settings → Agents.</EmptyState>
            ) : (
              <>
                <Field label="Role" hint={current !== undefined ? `${current.definition.tools.length > 0 ? `${current.definition.tools.length} tools` : 'All allowed tools'} · ${current.definition.description}` : undefined}>
                  <Select
                    label="Agent role"
                    value={selected}
                    options={definitions.map((row) => ({ value: row.definition.name, label: row.definition.name }))}
                    onChange={setSelected}
                  />
                </Field>
                <Field label="Brief" hint="Write it for a colleague who cannot see this conversation: the files and facts it needs, and what the answer must contain.">
                  <CodeArea
                    rows={4}
                    className="font-sans text-sm leading-6"
                    aria-label="Brief"
                    value={brief}
                    placeholder="Find why the web build is slow: compare vite.config.ts with the last fast build and report the options that changed."
                    onChange={(e) => setBrief(e.target.value)}
                  />
                </Field>

                <Disclosure summary="Task packet details">
                  <Field label="Objective" hint="Structured alternative to the brief; used only when the brief is empty.">
                    <TextInput value={objective} placeholder="Investigate why the build is slow" onChange={(e) => setObjective(e.target.value)} />
                  </Field>
                  <Field
                    label="Model"
                    hint={
                      current?.definition.model !== undefined
                        ? `This role asks for ${current.definition.model}; a choice here overrides it.`
                        : 'The child inherits this conversation’s model unless you pick another.'
                    }
                  >
                    <Select
                      label="Child model"
                      value={model}
                      options={[
                        { value: '', label: current?.definition.model ?? 'Inherit from this conversation' },
                        ...(modelOptions ?? []).map((option) => ({ value: option.value, label: option.label })),
                      ]}
                      onChange={setModel}
                    />
                  </Field>
                  <Field label="Constraints" hint="One constraint per line.">
                    <CodeArea rows={2} value={constraints} onChange={(e) => setConstraints(e.target.value)} />
                  </Field>
                  <Field label="References" hint="One reference path or note per line.">
                    <CodeArea rows={2} value={references} onChange={(e) => setReferences(e.target.value)} />
                  </Field>
                  <Field label="Required result">
                    <TextInput value={requiredResult} onChange={(e) => setRequiredResult(e.target.value)} />
                  </Field>
                  <Field label="Explicit tool grants" hint="One tool per line. Grants only narrow the role; MCP tools always require an explicit grant.">
                    <CodeArea rows={2} value={grants} onChange={(e) => setGrants(e.target.value)} />
                  </Field>
                </Disclosure>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" disabled={busy !== null || !canSpawn} onClick={() => void spawn()}>
                    <Icon name="plus" size={14} />{busy === 'spawn' ? 'Spawning…' : 'Spawn agent'}
                  </Button>
                  <span className="text-xs text-fg-faint">{running} of 3 running</span>
                </div>
              </>
            )}
          </section>

          <section className="flex min-w-0 flex-col gap-3">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">Children<Badge>{children.length}</Badge></h3>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => void refreshChildren()}><Icon name="refresh" size={13} />Refresh</Button>
            </div>
            {children.length === 0 ? <EmptyState>No child agents for this conversation.</EmptyState> : (
              <ItemList label="Child agents">
                {children.map((child) => (
                  <ItemRow
                    key={child.childSessionId}
                    title={
                      <>
                        <span>{child.definitionName}</span>
                        <Badge tone={CHILD_TONE[child.status]}>{child.status}</Badge>
                        {child.awaitingApproval === true ? <Badge tone="amber">awaiting approval</Badge> : null}
                      </>
                    }
                    meta={
                      <>
                        <code className="font-mono">{child.childSessionId.slice(0, 14)}…</code>
                        {child.model !== undefined ? <span className="text-fg-faint"> · {child.model}</span> : null}
                      </>
                    }
                    actions={
                      <>
                        {onOpenChild !== undefined ? <Button variant="ghost" size="sm" onClick={() => onOpenChild(child.childSessionId)}>Open<Icon name="chevronRight" size={13} /></Button> : null}
                        {child.status === 'running' ? (
                          <Button variant="outline-danger" size="sm" disabled={busy !== null} onClick={() => void cancel(child)}>
                            {busy === `cancel:${child.childSessionId}` ? 'Cancelling…' : 'Cancel'}
                          </Button>
                        ) : null}
                      </>
                    }
                  >
                    {child.error !== undefined ? <p className="m-0 text-[13px] text-bad">{child.error}</p> : null}
                    {child.result !== undefined ? (
                      <div className="flex flex-col gap-1 text-[13px] text-fg-muted">
                        {child.result.truncated === true ? <TruncatedNote /> : null}
                        <p className="m-0 whitespace-pre-wrap">{child.result.report}</p>
                        {child.result.filesTouched.length > 0 ? <p className="m-0 text-xs text-fg-faint">Files touched: {child.result.filesTouched.join(', ')}</p> : null}
                      </div>
                    ) : null}
                  </ItemRow>
                ))}
              </ItemList>
            )}
          </section>
        </div>
      </div>
      {notice !== null ? (
        <div className="shrink-0 border-t border-line px-4 py-3"><Notice kind={notice.kind} text={notice.text} /></div>
      ) : null}
    </div>
  )
}
