import { useCallback, useEffect, useState } from 'react'
import { useScopedState } from '../../hooks/useScopedState.ts'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { cancelChild, listAgentDefinitions, listChildren, listModelAliases, reconcileChild, spawnChild } from '../../lib/api.ts'
import { formatAge } from '../../lib/format.ts'
import { agentRoleIcon, AGENT_ROLE_TONE } from '../../lib/agent-icons.ts'
import { cn } from '../../lib/cn.ts'
import type { AgentDefinitionRow, ChildRow, ModelAliasRow } from '../../lib/types.ts'

/**
 * The subagents of the open conversation: which are running, and what the
 * ended ones reported. Delegating is the model's job (its `Agent` tool) and
 * roles live in Settings → Agents, so this view only follows the runs. A row
 * opens the child's own conversation, which is its full history.
 */
export interface AgentRunsPanelProps {
  readonly workspaceId: string | null
  readonly rootSessionId: string | null
  /** Each child's brief from the root's log, keyed by child session id. */
  readonly briefs?: ReadonlyMap<string, string>
  /** Bumped when the conversation itself delegates, so its children appear at once. */
  readonly refreshSignal?: number
  readonly onOpenChild?: (childSessionId: string) => void
}

const STATUS_LABEL: Readonly<Record<ChildRow['status'], string>> = {
  queued: 'Queued',
  dispatching: 'Starting',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  uncertain: 'Reconciling',
}

/** One line for a row: the first non-empty line of the text, markdown marks dropped. */
function firstLine(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((part) => part.trim()).find((part) => part !== '') ?? ''
  return line.replace(/^#+\s*/, '').replace(/\*\*/g, '')
}

export function AgentRunsPanel(props: AgentRunsPanelProps) {
  // Scope changes remount before paint: no conversation A row can reach B.
  return <AgentRunsPanelContent key={JSON.stringify([props.workspaceId, props.rootSessionId])} {...props} />
}

/** How a settled row's pill reads: a verdict, a stop, or someone else's call. */
const STATUS_TONE: Readonly<Partial<Record<ChildRow['status'], string>>> = {
  failed: 'bg-bad-soft text-bad',
  cancelled: 'bg-muted text-fg-muted',
  interrupted: 'bg-warn-soft text-warn',
  uncertain: 'bg-warn-soft text-warn',
}

function AgentRunsPanelContent({ workspaceId, rootSessionId, briefs, refreshSignal, onOpenChild }: AgentRunsPanelProps) {
  const [children, setChildren] = useScopedState<readonly ChildRow[]>([])
  const [failure, setFailure] = useScopedState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [roles, setRoles] = useScopedState<readonly AgentDefinitionRow[]>([])
  const [aliases, setAliases] = useScopedState<readonly ModelAliasRow[]>([])
  const [role, setRole] = useScopedState('')
  const [brief, setBrief] = useScopedState('')
  const [model, setModel] = useScopedState('')

  const refresh = useCallback(async () => {
    if (workspaceId === null || rootSessionId === null) return
    try {
      setChildren(await listChildren(workspaceId, rootSessionId))
      setFailure(null)
    } catch (cause) { setFailure(String(cause)) }
  }, [workspaceId, rootSessionId])

  // The signal is in the dependency list on purpose: a child the model
  // spawned must show up without waiting for the running-child poll.
  useEffect(() => { void refresh() }, [refresh, refreshSignal])
  useEffect(() => {
    if (workspaceId === null) return
    void Promise.all([listAgentDefinitions(workspaceId), listModelAliases()]).then(([nextRoles, nextAliases]) => {
      const validRoles = nextRoles.filter((entry) => entry?.definition?.name !== undefined)
      const validAliases = nextAliases.filter((entry) => typeof entry?.name === 'string')
      setRoles(validRoles); setAliases(validAliases); if (role === '' && validRoles[0] !== undefined) setRole(validRoles[0].definition.name)
    }).catch((cause) => setFailure(String(cause)))
  }, [workspaceId])

  // Poll only while a child runs or settles; it stops by itself when none do.
  useEffect(() => {
    if (!children.some((child) => child.status === 'queued' || child.status === 'dispatching' || child.status === 'running' || child.status === 'uncertain')) return
    const timer = window.setInterval(() => { void refresh() }, 3000)
    return () => { window.clearInterval(timer) }
  }, [children, refresh])

  if (workspaceId === null || rootSessionId === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="gitBranch" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No conversation selected</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">Open a conversation to follow the subagents it delegates to.</p>
      </div>
    )
  }

  const act = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    try { await action() } catch (cause) { setFailure(String(cause)) } finally {
      setBusy(null)
      await refresh()
    }
  }

  // A child still settling is not over yet, so it stays with the running ones.
  const active = children.filter((child) => child.status === 'queued' || child.status === 'dispatching' || child.status === 'running' || child.status === 'uncertain')
  const ended = children
    .filter((child) => !active.includes(child))
    .sort((left, right) => (right.endedAt ?? right.startedAt) - (left.endedAt ?? left.startedAt))

  const row = (child: ChildRow) => {
    const brief = briefs?.get(child.childSessionId)
    const title = firstLine(brief) || child.definitionName
    const preview = child.status === 'queued' ? 'Waiting for a host slot'
      : child.status === 'dispatching' ? 'Starting agent'
      : child.status === 'running' ? (child.awaitingApproval === true ? 'Waiting for your approval' : '')
      : child.error !== undefined && child.result === undefined
        ? (child.partial !== undefined && child.partial.report !== ''
            ? `${firstLine(child.error)} · it had said: ${firstLine(child.partial.report)}`
            : firstLine(child.error))
        : firstLine(child.result?.report)
    const bad = child.status === 'failed' || (child.error !== undefined && child.result === undefined && !active.includes(child))
    const time = formatAge(child.endedAt ?? child.startedAt)
    const icon = agentRoleIcon(child.definitionName)
    const pill = STATUS_TONE[child.status]
    return (
      <li key={child.childSessionId} className="group flex items-center gap-1">
        <button
          type="button"
          disabled={onOpenChild === undefined}
          onClick={() => onOpenChild?.(child.childSessionId)}
          title={brief ?? child.definitionName}
          className="flex min-w-0 flex-1 items-start gap-2.5 rounded-lg px-2 py-2.5 text-left transition-colors enabled:hover:bg-hover"
        >
          {/* The role is the row's face; the spinner only overrides it while it runs. */}
          <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[icon])}>
            {active.includes(child) ? <Spinner size={13} /> : <Icon name={icon} size={14} />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold text-fg">{title}</span>
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <span className={cn('text-xs', bad ? 'text-bad' : 'text-fg-faint')}>{time}</span>
                <span className={cn(
                  'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium leading-4',
                  pill ?? 'bg-ok-soft text-ok',
                )}>
                  {active.includes(child) ? <span className="size-1.5 animate-dot rounded-full bg-current" /> : null}
                  {STATUS_LABEL[child.status]}
                </span>
              </span>
            </span>
            <span className="truncate font-mono text-[11px] text-fg-faint">{child.definitionName}{child.model !== undefined ? ` · ${child.model}` : ''}</span>
            {preview !== '' ? <span className={cn('truncate text-[13px]', child.awaitingApproval === true ? 'text-warn' : 'text-fg-muted')}>{preview}</span> : null}
          </span>
        </button>
        {child.status === 'queued' || child.status === 'dispatching' || child.status === 'running' ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act(child.childSessionId, () => cancelChild(workspaceId, rootSessionId, child.childSessionId))}
            className="mr-1 shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-muted opacity-0 transition-opacity hover:text-bad focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            {busy === child.childSessionId ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
        {child.status === 'uncertain' ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act(child.childSessionId, () => reconcileChild(workspaceId, rootSessionId, child.childSessionId))}
            className="shrink-0 rounded-md border border-line bg-surface px-2 py-1 text-xs text-fg-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
          >
            {busy === child.childSessionId ? 'Settling…' : 'Retry settlement'}
          </button>
        ) : null}
      </li>
    )
  }

  const selectedAlias = aliases.find((alias) => alias.name === model)
  const submit = async () => {
    if (role === '' || brief.trim() === '' || selectedAlias?.status === 'invalid') return
    setBusy('spawn')
    try { await spawnChild(workspaceId, role, rootSessionId, { prompt: brief.trim() }, undefined, model || undefined); setBrief(''); setFailure(null); await refresh() }
    catch (cause) { setFailure(String(cause)) } finally { setBusy(null) }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <form aria-label="Spawn subagent" className="space-y-2 border-b border-line p-4" onSubmit={(event) => { event.preventDefault(); void submit() }}>
        <h3 className="m-0 text-sm font-semibold">Spawn subagent</h3>
        <label className="block text-xs text-fg-muted">Role<select aria-label="Subagent role" className="mt-1 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm" value={role} onChange={(event) => setRole(event.target.value)}>{roles.map((entry) => <option key={entry.definition.name} value={entry.definition.name}>{entry.definition.name}</option>)}</select></label>
        <label className="block text-xs text-fg-muted">Brief<textarea aria-label="Subagent brief" className="mt-1 min-h-20 w-full rounded-md border border-line bg-bg p-2 text-sm" value={brief} onChange={(event) => setBrief(event.target.value)} /></label>
        <label className="block text-xs text-fg-muted">Model<select aria-label="Subagent model" className="mt-1 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm" value={model} onChange={(event) => setModel(event.target.value)}><option value="">Inherit conversation model</option>{aliases.map((alias) => <option key={alias.name} value={alias.name} disabled={alias.status === 'invalid'}>{alias.name} → {alias.provider}:{alias.model}{alias.status === 'invalid' ? ' (unusable)' : ''}</option>)}</select></label>
        <label className="block text-xs text-fg-muted">Direct provider:model<input aria-label="Direct subagent model" className="mt-1 h-9 w-full rounded-md border border-line bg-bg px-2 text-sm" value={model.includes(':') ? model : ''} onChange={(event) => setModel(event.target.value)} placeholder="provider:model" /></label>
        {selectedAlias?.status === 'invalid' ? <p role="alert" className="m-0 text-xs text-bad">Alias unusable: {selectedAlias.message}</p> : null}
        <button type="submit" disabled={busy !== null || role === '' || brief.trim() === '' || selectedAlias?.status === 'invalid'} className="rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-50">{busy === 'spawn' ? 'Spawning…' : 'Spawn'}</button>
      </form>
      <section aria-label="Active subagents" className="flex flex-col px-3 pt-4">
        <h3 className="m-0 px-2 pb-1 text-xs font-medium text-fg-faint">Active · {active.length}</h3>
        {active.length === 0
          ? <p className="m-0 px-2 py-2 text-[13px] text-fg-faint">No active subagents</p>
          : <ul className="m-0 flex list-none flex-col p-0">{active.map(row)}</ul>}
      </section>
      <section aria-label="Ended subagents" className="flex flex-col px-3 pt-5 pb-4">
        <h3 className="m-0 px-2 pb-1 text-xs font-medium text-fg-faint">Ended · {ended.length}</h3>
        {ended.length === 0
          ? <p className="m-0 px-2 py-2 text-[13px] text-fg-faint">No ended subagents</p>
          : <ul className="m-0 flex list-none flex-col p-0">{ended.map(row)}</ul>}
      </section>
      {failure !== null ? <p role="alert" className="m-0 mt-auto border-t border-line px-5 py-3 text-[13px] text-bad">{failure}</p> : null}
    </div>
  )
}
