/**
 * The always-present glance at the session's environment, pinned above the
 * transcript: the project's git line, live subagents, and background
 * processes. Collapsed it is one chip row; the first live process or
 * subagent expands it exactly once per session, and an explicit user
 * collapse sticks until the conversation changes. State derives from the
 * durable event stream; one GET reconciles what an SSE gap may have missed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { cn } from '../../lib/cn.ts'
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import { fetchGitStatus, listSessionProcesses, stopSessionProcess } from '../../lib/api.ts'
import { processRows, subagentRows, type ProcessRow, type SubagentRow } from '../../lib/processes-view.ts'
import { agentRoleIcon, AGENT_ROLE_TONE } from '../../lib/agent-icons.ts'
import { todosFromEvents } from '../../lib/todos-view.ts'
import type { SseEvent } from '../../lib/types.ts'

interface GitLine {
  readonly branch: string | null
  readonly added: number
  readonly removed: number
  readonly ahead: number
  readonly behind: number
}

interface Props {
  readonly workspaceId: string | null
  readonly sessionId: string | null
  readonly project: { readonly id: string; readonly name: string; readonly path: string } | null
  readonly events: readonly SseEvent[]
  readonly connected: boolean
  readonly onOpenView: (view: 'git' | 'agents') => void
  /** A process row click: open its live detail in the workbench. */
  readonly onOpenProcess: (processId: string) => void
}

const TERMINAL_CLASS: Record<string, string | undefined> = { killed: 'text-bad', failed: 'text-bad', interrupted: 'text-bad' }

/** `1m 40s`-style wall-clock label for working/process durations. */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

/** Signed colored diff counts: `+2,173 −628`, zero parts omitted. */
function DiffCounts({ added, removed }: { readonly added: number; readonly removed: number }) {
  if (added === 0 && removed === 0) return <span className="text-[12px] text-fg-faint">clean</span>
  return (
    <span className="shrink-0 text-[12px]">
      {added > 0 ? <span className="text-ok">+{added.toLocaleString()}</span> : null}
      {added > 0 && removed > 0 ? ' ' : ''}
      {removed > 0 ? <span className="text-bad">−{removed.toLocaleString()}</span> : null}
    </span>
  )
}

/** Upstream sync arrows; a zero direction never renders (no `↓0` noise). */
function SyncArrows({ ahead, behind }: { readonly ahead: number; readonly behind: number }) {
  if (ahead <= 0 && behind <= 0) return null
  return (
    <span className="shrink-0 text-[12px] text-fg-faint">
      {ahead > 0 ? <span title={`${ahead} ahead of upstream`}>↑{ahead}</span> : null}
      {ahead > 0 && behind > 0 ? ' ' : ''}
      {behind > 0 ? <span title={`${behind} behind upstream`}>↓{behind}</span> : null}
    </span>
  )
}

/** Below this the overlay card covers the transcript, so the detail opens as a sheet. */
const COMPACT_QUERY = '(max-width: 767px)'

/** Subagent rows shown before the panel defers to the workbench list. */
const MAX_PANEL_SUBAGENTS = 6

export function EnvironmentPanel({ workspaceId, sessionId, project, events, connected, onOpenView, onOpenProcess }: Props) {
  // Panel state is scoped to the conversation: switching resets the collapse,
  // the one-shot auto-open, and the per-section disclosure.
  const [state, setState] = useState<{ scope: string | null; expanded: boolean; autoOpened: boolean; processesOpen: boolean; subagentsOpen: boolean; tasksOpen: boolean; endedOpen: boolean; dismissed: ReadonlySet<string> }>({ scope: sessionId, expanded: false, autoOpened: false, processesOpen: true, subagentsOpen: true, tasksOpen: true, endedOpen: false, dismissed: new Set() })
  const [git, setGit] = useState<GitLine | null>(null)
  const [liveRunning, setLiveRunning] = useState<readonly string[]>([])
  const [stopping, setStopping] = useState<readonly string[]>([])
  const [now, setNow] = useState(() => Date.now())
  const compact = useMediaQuery(COMPACT_QUERY)

  const derived = useMemo(() => processRows(events), [events])
  const agents = useMemo(() => subagentRows(events), [events])
  const liveRunningIds = useMemo(() => new Set(liveRunning), [liveRunning])
  const rows = useMemo(
    () => derived.map((row) => (liveRunningIds.has(row.id) && row.status !== 'running' ? { ...row, status: 'running' as const } : row)),
    [derived, liveRunningIds],
  )
  const running = useMemo(() => rows.filter((row) => row.status === 'running'), [rows])
  // Ended rows the user has not cleared. Dismissal is per-session view state:
  // the durable log (and the Process view) keeps the full history.
  const ended = useMemo(() => rows.filter((row) => row.status !== 'running' && !state.dismissed.has(row.id)), [rows, state.dismissed])
  const runningAgents = useMemo(() => agents.filter((row) => row.running), [agents])
  // The panel is a glance, not the archive: at most MAX_PANEL_SUBAGENTS rows
  // (list is newest-dispatch-first). Running children claim their slots first
  // — the header's "N running" always has its row — and the newest ended ones
  // fill the rest; the workbench list holds the full run history.
  const visibleAgents = useMemo(() => {
    const live = agents.filter((row) => row.running).slice(0, MAX_PANEL_SUBAGENTS)
    const settled = agents.filter((row) => !row.running).slice(0, MAX_PANEL_SUBAGENTS - live.length)
    return [...live, ...settled]
  }, [agents])
  const hiddenAgents = agents.length - visibleAgents.length
  const hasLive = running.length > 0 || runningAgents.length > 0
  const todo = useMemo(() => todosFromEvents(events), [events])
  const todoDone = useMemo(() => todo.todos.filter((item) => item.status === 'completed').length, [todo])
  const todoAllDone = todo.todos.length > 0 && todoDone === todo.todos.length

  // The turn currently open in this conversation, if any — the header's
  // `Working · <elapsed>` indicator, same semantics as the TaskStatus line.
  const workingSince = useMemo(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn/end') return null
      if (event.type === 'turn/start') return event.timestamp ?? null
    }
    return null
  }, [events])
  const ticking = running.length > 0 || workingSince !== null

  const scope = sessionId ?? null
  if (state.scope !== scope) setState({ scope, expanded: false, autoOpened: false, processesOpen: true, subagentsOpen: true, tasksOpen: true, endedOpen: false, dismissed: new Set() })

  // The one-shot auto-open: the first live process or subagent for this
  // conversation expands the panel; a user collapse never reopens it. On a
  // phone the expanded card would cover the transcript, so it stays a chip
  // until the user opens the sheet.
  useEffect(() => {
    if (compact || !hasLive || state.scope !== scope || state.autoOpened || state.expanded) return
    setState((prev) => (prev.scope === scope && !prev.autoOpened ? { ...prev, expanded: true, autoOpened: true } : prev))
  }, [compact, hasLive, scope, state.scope, state.autoOpened, state.expanded])

  // Live durations: working elapsed and running process ages.
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [ticking])

  const turnEndCount = useMemo(() => events.filter((event) => event.type === 'turn/end').length, [events])

  // Git line: on mount and after each settled turn.
  useEffect(() => {
    if (workspaceId === null || project === null || sessionId === null) return
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const report = await fetchGitStatus(workspaceId, project.id)
        if (disposed) return
        let added = 0
        let removed = 0
        for (const change of report.changes) {
          added += change.added ?? 0
          removed += change.removed ?? 0
        }
        setGit({ branch: report.branch, added, removed, ahead: report.ahead ?? 0, behind: report.behind ?? 0 })
      } catch {
        // Offline stays on the last known line; the panel never blocks chat.
      }
    }
    void load()
    return () => { disposed = true }
  }, [workspaceId, project, sessionId, turnEndCount])

  // Live reconciliation: correct state an SSE gap may have missed.
  const reconcile = useCallback(async (): Promise<void> => {
    if (workspaceId === null || sessionId === null) return
    try {
      const snapshot = await listSessionProcesses(workspaceId, sessionId)
      setLiveRunning(snapshot.filter((row) => row.status === 'running').map((row) => row.id))
    } catch {
      // Same policy as the git line: last known state, never a blocker.
    }
  }, [workspaceId, sessionId])

  useEffect(() => { void reconcile() }, [reconcile, connected])

  const stop = useCallback(
    async (id: string): Promise<void> => {
      if (workspaceId === null || sessionId === null) return
      setStopping((prev) => [...prev, id])
      try {
        await stopSessionProcess(workspaceId, sessionId, id)
      } catch {
        // The exit event (or reconcile) carries the truth; the click is done.
      } finally {
        setStopping((prev) => prev.filter((item) => item !== id))
      }
    },
    [workspaceId, sessionId],
  )

  if (sessionId === null) return null

  const expanded = state.expanded && !compact
  const collapseLabel = expanded ? 'Collapse environment' : 'Expand environment'
  const workingLabel = workingSince !== null ? formatDuration(now - workingSince) : null
  const detail = (
    <div className="flex flex-col gap-1.5">
      {project !== null ? (
        <section aria-label="Git">
          <button
            type="button"
            aria-label="Open git panel"
            onClick={() => onOpenView('git')}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
          >
            <Icon name="gitBranch" size={14} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg" title={git?.branch ?? project.path}>{git?.branch ?? project.name}</span>
            <SyncArrows ahead={git?.ahead ?? 0} behind={git?.behind ?? 0} />
            {git !== null ? <DiffCounts added={git.added} removed={git.removed} /> : <span className="text-[12px] text-fg-faint">…</span>}
          </button>
        </section>
      ) : null}

      {running.length + ended.length > 0 ? (
        <section aria-label="Background processes" className="flex flex-col">
          <button
            type="button"
            aria-expanded={state.processesOpen}
            onClick={() => setState((prev) => ({ ...prev, processesOpen: !prev.processesOpen }))}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
          >
            <Icon name="terminal" size={14} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg-muted">Background processes</span>
            <span className={cn('shrink-0 whitespace-nowrap text-[12px]', running.length > 0 ? 'text-warn' : 'text-fg-faint')}>
              {running.length > 0 ? `${running.length} running${ended.length > 0 ? ` · ${running.length + ended.length} total` : ''}` : `${ended.length} ended`}
            </span>
            <Icon name="chevron" size={13} className={cn('shrink-0 text-fg-faint transition-transform', state.processesOpen ? '' : 'rotate-180')} />
          </button>
          {state.processesOpen ? (
            <div className="flex flex-col gap-0.5 pb-1">
              {running.map((row) => (
                <ProcessLine key={row.id} row={row} now={now} pending={stopping.includes(row.id)} onOpen={() => onOpenProcess(row.id)} onStop={() => void stop(row.id)} />
              ))}
              {ended.length > 0 ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="Toggle ended processes"
                    aria-expanded={state.endedOpen}
                    onClick={() => setState((prev) => ({ ...prev, endedOpen: !prev.endedOpen }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm py-1 text-left text-[12px] text-fg-faint transition-colors hover:text-fg-muted"
                  >
                    <Icon name="chevron" size={12} className={cn('shrink-0 transition-transform', state.endedOpen ? 'rotate-180' : '')} />
                    Ended · {ended.length}
                  </button>
                  <button
                    type="button"
                    aria-label="Clear ended processes"
                    title="Clear ended processes"
                    onClick={() => setState((prev) => {
                      const dismissed = new Set(prev.dismissed)
                      for (const row of ended) dismissed.add(row.id)
                      return { ...prev, dismissed, endedOpen: false }
                    })}
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
                  >
                    <Icon name="trash" size={11} />
                    Clear
                  </button>
                </div>
              ) : null}
              {state.endedOpen ? (
                <div className="flex flex-col gap-0.5">
                  {ended.map((row) => (
                    <ProcessLine key={row.id} row={row} now={now} pending={stopping.includes(row.id)} onOpen={() => onOpenProcess(row.id)} onStop={() => void stop(row.id)} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {agents.length > 0 ? (
        <section aria-label="Subagents" className="flex flex-col">
          <button
            type="button"
            aria-expanded={state.subagentsOpen}
            onClick={() => setState((prev) => ({ ...prev, subagentsOpen: !prev.subagentsOpen }))}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
          >
            <Icon name="gitBranch" size={14} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg-muted">Subagents</span>
            <span className={cn('shrink-0 whitespace-nowrap text-[12px]', runningAgents.length > 0 ? 'text-warn' : 'text-fg-faint')}>
              {runningAgents.length > 0 ? `${runningAgents.length} running` : `${agents.length}`}
            </span>
            <Icon name="chevron" size={13} className={cn('shrink-0 text-fg-faint transition-transform', state.subagentsOpen ? '' : 'rotate-180')} />
          </button>
          {state.subagentsOpen ? (
            <div className="flex flex-col gap-0.5 pb-1">
              {visibleAgents.map((row) => (
                <SubagentLine key={row.childSessionId} row={row} onOpen={() => onOpenView('agents')} />
              ))}
              {hiddenAgents > 0 ? (
                <button
                  type="button"
                  aria-label="Open the full subagent list in the workbench"
                  title={`Open the Subagents workbench view for all ${agents.length}`}
                  onClick={() => onOpenView('agents')}
                  className="flex w-full items-center gap-1.5 rounded-lg py-1 pl-2.5 pr-1.5 text-left text-[12px] text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
                >
                  +{hiddenAgents} earlier · view all in Workbench
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {todo.todos.length > 0 ? (
        <section aria-label="Tasks" className="flex flex-col">
          <button
            type="button"
            aria-expanded={state.tasksOpen}
            onClick={() => setState((prev) => ({ ...prev, tasksOpen: !prev.tasksOpen }))}
            className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left text-[13px] transition-colors hover:bg-hover"
          >
            <Icon name="check" size={14} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg-muted">Tasks</span>
            <span className={cn('shrink-0 whitespace-nowrap text-[12px]', todoAllDone ? 'text-ok' : 'text-fg-faint')}>
              {todoAllDone ? 'Done' : `${todoDone}/${todo.todos.length}`}
            </span>
            <Icon name="chevron" size={13} className={cn('shrink-0 text-fg-faint transition-transform', state.tasksOpen ? '' : 'rotate-180')} />
          </button>
          {state.tasksOpen ? (
            <div className="flex flex-col gap-0.5 pb-1">
              {todo.todos.map((item, index) => (
                <div key={index} className="flex items-center gap-2 rounded-lg py-1 pl-2.5 pr-1.5 text-[13px]">
                  {item.status === 'in_progress' ? (
                    <Spinner size={11} />
                  ) : item.status === 'completed' ? (
                    <Icon name="check" size={11} className="shrink-0 text-ok" />
                  ) : (
                    <span className="inline-block size-[11px] shrink-0 rounded-full border border-line" aria-hidden />
                  )}
                  <span className={cn('min-w-0 flex-1 truncate', item.status === 'completed' ? 'text-fg-faint' : 'text-fg')} title={item.status === 'in_progress' ? item.activeForm : item.content}>
                    {item.content}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  )

  return (
    <>
    <aside
      data-environment-panel
      aria-label="Environment"
      className={cn(
        // Fixed top-right overlay of the chat column (dntspace arrangement),
        // below the 56px ChatHeader so the header controls stay clickable:
        // the transcript scrolls underneath; the card never pushes content.
        // Above the transcript's own overlays — the minimap rail is z-20 too,
        // and Transcript mounts after this panel, so paint order alone would
        // let the rail draw over the expanded card.
        // Collapsed is a slim fully-rounded capsule — as little chrome as a
        // status pill, never a panel competing with the transcript. On a phone
        // the capsule stays collapsed; the detail opens as a bottom sheet.
        'absolute right-2 top-[60px] z-30 border border-line bg-surface sm:right-4',
        expanded
          ? 'flex max-h-[calc(100dvh-320px)] w-[min(320px,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl px-3.5 py-2 shadow-lg'
          : 'inline-flex h-[30px] max-w-[min(220px,calc(100%-5.5rem))] items-center rounded-full py-0 pl-2.5 pr-1.5 shadow-sm sm:max-w-[min(480px,calc(100%-2rem))] sm:pl-3',
      )}
    >
        <button
          type="button"
          data-compact-control
          aria-label={collapseLabel}
          aria-expanded={expanded}
          onClick={() => setState((prev) => ({ ...prev, expanded: !prev.expanded }))}
          className="flex h-full min-h-7 w-full items-center gap-1.5 text-left transition-colors"
        >
          <span className="shrink-0 text-[12px] font-medium text-fg">Environment</span>
          {workingLabel !== null ? (
            <span className="flex shrink-0 items-center text-fg-muted" role="status" title={`Working · ${workingLabel}`}>
              <Spinner size={10} />
              <span className="sr-only">Working · {workingLabel}</span>
            </span>
          ) : null}
          {!expanded ? (
            <span className={cn('min-w-0 flex-1 items-center gap-1.5 overflow-hidden', compact ? 'hidden' : 'flex')}>
              {project !== null ? (
                <span className="truncate text-[11px] text-fg-muted">{git?.branch ?? project.name}</span>
              ) : null}
              {running.length > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-warn-soft px-1 py-px text-[10px] font-medium leading-[14px] text-warn" title={`${running.length} background process${running.length === 1 ? '' : 'es'} running`}>
                  <Icon name="terminal" size={9} />
                  {running.length}
                </span>
              ) : null}
              {runningAgents.length > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-px text-[10px] font-medium leading-[14px] text-fg-muted" title={`${runningAgents.length} subagent${runningAgents.length === 1 ? '' : 's'} running`}>
                  <Icon name="bot" size={9} />
                  {runningAgents.length}
                </span>
              ) : null}
            </span>
          ) : null}
          <Icon name="chevron" size={13} className={cn('icon-chevron ml-auto shrink-0 rounded-full p-0.5 text-fg-faint transition-transform hover:bg-hover hover:text-fg', expanded ? 'rotate-180' : '')} />
        </button>

        {expanded ? <div className="mt-1.5 border-t border-line pt-1.5">{detail}</div> : null}
    </aside>
    {compact ? (
      <Sheet open={state.expanded} onOpenChange={(open) => setState((prev) => ({ ...prev, expanded: open }))} side="bottom" label="Environment">
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <p className="m-0 px-1.5 pb-2 text-sm font-medium">Environment</p>
          {detail}
        </div>
      </Sheet>
    ) : null}
    </>
  )
}

function ProcessLine({ row, now, pending, onOpen, onStop }: { readonly row: ProcessRow; readonly now: number; readonly pending: boolean; readonly onOpen: () => void; readonly onStop: () => void }) {
  const runningRow = row.status === 'running'
  const duration = runningRow ? now - row.startedAt : row.durationMs
  const statusLabel = runningRow ? 'running' : row.exitCode !== null ? `${row.status} (${row.exitCode})` : row.status
  return (
    <div className="flex items-center gap-2 rounded-lg py-1 pl-2.5 pr-1.5 text-[13px]">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${row.command} in the workbench`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
      >
        {runningRow ? <Spinner size={11} /> : <span className="inline-block size-[11px] shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-fg">{row.command}</span>
        <span className="shrink-0 text-[12px] text-fg-faint">{formatDuration(duration)}</span>
        <span className={cn('shrink-0 text-[12px]', runningRow ? 'text-warn' : (TERMINAL_CLASS[row.status] ?? 'text-fg-faint'))}>{statusLabel}</span>
      </button>
      {runningRow ? (
        <button
          type="button"
          aria-label={`Stop ${row.command}`}
          title={`Stop ${row.command}`}
          disabled={pending}
          onClick={onStop}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <Icon name="square" size={10} />
        </button>
      ) : null}
    </div>
  )
}

function SubagentLine({ row, onOpen }: { readonly row: SubagentRow; readonly onOpen: () => void }) {
  const icon = agentRoleIcon(row.definition)
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-lg py-1 pl-1.5 pr-1.5 text-left text-[13px] transition-colors hover:bg-hover"
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[icon])}>
        {row.running ? <Spinner size={11} /> : <Icon name={icon} size={12} />}
      </span>
      <span className="min-w-0 flex-1 truncate text-fg" title={row.definition}>{row.definition}</span>
      <span className={cn('shrink-0 text-[12px]', row.running ? 'text-warn' : (TERMINAL_CLASS[row.status ?? ''] ?? 'text-fg-faint'))}>
        {row.running ? 'running' : (row.status ?? '')}
      </span>
    </button>
  )
}
