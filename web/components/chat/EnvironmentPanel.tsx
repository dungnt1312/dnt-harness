/**
 * The always-present glance at the session's environment, pinned above the
 * transcript: the project's git line, live subagents, and background
 * processes. Collapsed it is one chip row; the first live process or
 * subagent expands it exactly once per session, and an explicit user
 * collapse sticks until the conversation changes. Ended subagents fold
 * behind an "Ended" group with a Clear, like ended processes. State
 * derives from the durable event stream; host-registry GETs reconcile
 * what an SSE gap or a skipped result write may have missed — processes
 * once per connect, subagents on a short poll while any still runs.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Sheet } from '../ui/Sheet.tsx'
import { cn } from '../../lib/cn.ts'
import { useMediaQuery } from '../../hooks/useMediaQuery.ts'
import { fetchGitStatus, listSessionProcesses, stopSessionProcess, cancelChild, listChildren } from '../../lib/api.ts'
import { processRows, subagentRows, reconcileSubagentRows, type ProcessRow, type SubagentRow } from '../../lib/processes-view.ts'
import { agentRoleIcon, AGENT_ROLE_TONE } from '../../lib/agent-icons.ts'
import { todosFromEvents } from '../../lib/todos-view.ts'
import { formatAge } from '../../lib/format.ts'
import type { ChildRow, SseEvent } from '../../lib/types.ts'

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
  /** A subagent row click: open the child's own conversation. */
  readonly onOpenChild?: (childSessionId: string) => void
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
  if (added === 0 && removed === 0) return <span className="text-[11px] text-fg-faint">clean</span>
  return (
    <span className="shrink-0 text-[11px]">
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
    <span className="shrink-0 text-[11px] text-fg-faint">
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

export function EnvironmentPanel({ workspaceId, sessionId, project, events, connected, onOpenView, onOpenProcess, onOpenChild }: Props) {
  // Panel state is scoped to the conversation: switching resets the collapse,
  // the one-shot auto-open, and the per-section disclosure.
  const [state, setState] = useState<{ scope: string | null; expanded: boolean; autoOpened: boolean; processesOpen: boolean; subagentsOpen: boolean; tasksOpen: boolean; endedOpen: boolean; endedAgentsOpen: boolean; dismissed: ReadonlySet<string> }>({ scope: sessionId, expanded: false, autoOpened: false, processesOpen: true, subagentsOpen: true, tasksOpen: true, endedOpen: false, endedAgentsOpen: false, dismissed: new Set() })
  const [git, setGit] = useState<GitLine | null>(null)
  const [gitFailed, setGitFailed] = useState(false)
  const [liveRunning, setLiveRunning] = useState<readonly string[]>([])
  const [childRows, setChildRows] = useState<readonly ChildRow[]>([])
  const [stopping, setStopping] = useState<readonly string[]>([])
  const [stoppingChild, setStoppingChild] = useState<readonly string[]>([])
  const [now, setNow] = useState(() => Date.now())
  const compact = useMediaQuery(COMPACT_QUERY)

  const derived = useMemo(() => processRows(events), [events])
  const spawned = useMemo(() => subagentRows(events), [events])
  // The registry fold settles rows the log still calls running: a result event
  // an SSE gap dropped, or one the host never wrote for an uncertain child.
  const agents = useMemo(() => reconcileSubagentRows(spawned, childRows), [spawned, childRows])
  const hasRunningSpawns = useMemo(() => spawned.some((row) => row.running), [spawned])
  const liveRunningIds = useMemo(() => new Set(liveRunning), [liveRunning])
  const rows = useMemo(
    () => derived.map((row) => (liveRunningIds.has(row.id) && row.status !== 'running' ? { ...row, status: 'running' as const } : row)),
    [derived, liveRunningIds],
  )
  const running = useMemo(() => rows.filter((row) => row.status === 'running'), [rows])
  // Ended rows the user has not cleared. Dismissal is per-session view state:
  // the durable log (and the Process view) keeps the full history.
  const ended = useMemo(() => rows.filter((row) => row.status !== 'running' && !state.dismissed.has(row.id)), [rows, state.dismissed])
  const runningAgents = useMemo(() => agents.filter((row) => row.running && !state.dismissed.has(row.childSessionId)), [agents, state.dismissed])
  // Ended subagents, minus those the user cleared (the workbench list keeps
  // the full history). Mirrors the ended-processes group's policy.
  const endedAgents = useMemo(() => agents.filter((row) => !row.running && !state.dismissed.has(row.childSessionId)), [agents, state.dismissed])
  // The panel is a glance, not the archive: running children claim the rows
  // (capped — the "+N earlier" jump leads to the workbench list), and ended
  // ones fold behind the section's ended group like ended processes do.
  const liveAgents = useMemo(() => runningAgents.slice(0, MAX_PANEL_SUBAGENTS), [runningAgents])
  const hiddenRunningAgents = runningAgents.length - liveAgents.length
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
  const ticking = running.length > 0 || runningAgents.length > 0 || workingSince !== null

  const scope = sessionId ?? null
  if (state.scope !== scope) setState({ scope, expanded: false, autoOpened: false, processesOpen: true, subagentsOpen: true, tasksOpen: true, endedOpen: false, endedAgentsOpen: false, dismissed: new Set() })

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
        setGitFailed(false)
      } catch {
        // Offline: say so instead of an eternal loading ellipsis; the next
        // settled turn (or a reconnect) retries and the line recovers.
        if (!disposed) setGitFailed(true)
      }
    }
    void load()
    return () => { disposed = true }
  }, [workspaceId, project, sessionId, turnEndCount])

  // Live reconciliation: correct state an SSE gap may have missed — processes
  // from the host registry, and subagents from the same child list the
  // workbench reads (a settled child whose parent result never landed would
  // otherwise read running forever).
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

  const reconcileChildren = useCallback(async (): Promise<void> => {
    if (workspaceId === null || sessionId === null) return
    try {
      setChildRows(await listChildren(workspaceId, sessionId))
    } catch {
      // Last known state, never a blocker — the result event still carries it.
    }
  }, [workspaceId, sessionId])

  useEffect(() => {
    // Only fetch while the log still shows a live child: nothing to correct
    // once every spawn has a result. `connected` re-runs it after a reconnect.
    if (workspaceId === null || sessionId === null || !hasRunningSpawns) return
    void reconcileChildren()
    const timer = window.setInterval(() => void reconcileChildren(), 3_000)
    return () => window.clearInterval(timer)
  }, [workspaceId, sessionId, hasRunningSpawns, reconcileChildren, connected])

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

  /** Cancel a running child from its panel row; the child-result carries the truth. */
  const stopChild = useCallback(
    async (childSessionId: string): Promise<void> => {
      if (workspaceId === null || sessionId === null) return
      setStoppingChild((prev) => [...prev, childSessionId])
      try {
        await cancelChild(workspaceId, sessionId, childSessionId)
      } catch {
        // The result event (or the workbench list) carries the truth.
      } finally {
        setStoppingChild((prev) => prev.filter((item) => item !== childSessionId))
      }
    },
    [workspaceId, sessionId],
  )

  if (sessionId === null) return null

  const expanded = state.expanded && !compact
  const collapseLabel = expanded ? 'Collapse environment' : 'Expand environment'
  const workingLabel = workingSince !== null ? formatDuration(now - workingSince) : null
  const detail = (
    <div className="flex flex-col gap-1">
      {project !== null ? (
        <section aria-label="Git">
          <button
            type="button"
            aria-label="Open git panel"
            onClick={() => onOpenView('git')}
            className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left text-[12px] transition-colors hover:bg-hover"
          >
            <Icon name="gitBranch" size={13} className="shrink-0 text-fg-faint" />
            <span className="min-w-0 flex-1 truncate font-medium text-fg" title={git?.branch ?? project.path}>{git?.branch ?? project.name}</span>
            <SyncArrows ahead={git?.ahead ?? 0} behind={git?.behind ?? 0} />
            {git !== null ? <DiffCounts added={git.added} removed={git.removed} /> : <span className="text-[11px] text-fg-faint">{gitFailed ? 'unavailable' : '…'}</span>}
          </button>
        </section>
      ) : null}

      {running.length + ended.length > 0 ? (
        <Section
          label="Background processes"
          tone={running.length > 0 ? 'warn' : 'faint'}
          count={running.length > 0 ? `${running.length} running${ended.length > 0 ? ` · ${running.length + ended.length} total` : ''}` : `${ended.length} ended`}
          open={state.processesOpen}
          onToggle={() => setState((prev) => ({ ...prev, processesOpen: !prev.processesOpen }))}
        >
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
                className="flex min-w-0 flex-1 items-center gap-1 rounded py-0.5 text-left text-[11px] text-fg-faint transition-colors hover:text-fg-muted"
              >
                <Icon name="chevron" size={11} className={cn('shrink-0 transition-transform', state.endedOpen ? '' : 'rotate-180')} />
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
                className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
              >
                <Icon name="trash" size={10} />
                Clear
              </button>
            </div>
          ) : null}
          {state.endedOpen ? (
            <div className="flex flex-col gap-px">
              {ended.map((row) => (
                <ProcessLine key={row.id} row={row} now={now} pending={stopping.includes(row.id)} onOpen={() => onOpenProcess(row.id)} onStop={() => void stop(row.id)} />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}

      {runningAgents.length + endedAgents.length > 0 ? (
        <Section
          label="Subagents"
          tone={runningAgents.length > 0 ? 'ok' : 'faint'}
          count={runningAgents.length > 0 ? `${runningAgents.length} running` : `${runningAgents.length + endedAgents.length} total`}
          open={state.subagentsOpen}
          onToggle={() => setState((prev) => ({ ...prev, subagentsOpen: !prev.subagentsOpen }))}
        >
          {liveAgents.map((row) => (
            <SubagentLine key={row.childSessionId} row={row} now={now} pending={stoppingChild.includes(row.childSessionId)} onOpen={() => onOpenChild?.(row.childSessionId)} onStop={() => void stopChild(row.childSessionId)} />
          ))}
          {hiddenRunningAgents > 0 ? (
            <button
              type="button"
              aria-label="Open the full subagent list in the workbench"
              title={`Open the Subagents workbench view for all ${runningAgents.length + endedAgents.length}`}
              onClick={() => onOpenView('agents')}
              className="flex w-full items-center rounded py-0.5 pl-1 pr-0.5 text-left text-[11px] text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
            >
              +{hiddenRunningAgents} more running · view all in Workbench
            </button>
          ) : null}
          {endedAgents.length > 0 ? (
            <>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-label="Toggle ended subagents"
                  aria-expanded={state.endedAgentsOpen}
                  onClick={() => setState((prev) => ({ ...prev, endedAgentsOpen: !prev.endedAgentsOpen }))}
                  className="flex min-w-0 flex-1 items-center gap-1 rounded py-0.5 text-left text-[11px] text-fg-faint transition-colors hover:text-fg-muted"
                >
                  <Icon name="chevron" size={11} className={cn('shrink-0 transition-transform', state.endedAgentsOpen ? '' : 'rotate-180')} />
                  Ended · {endedAgents.length}
                </button>
                <button
                  type="button"
                  aria-label="Clear ended subagents"
                  title="Clear ended subagents"
                  onClick={() => setState((prev) => {
                    const dismissed = new Set(prev.dismissed)
                    for (const row of endedAgents) dismissed.add(row.childSessionId)
                    return { ...prev, dismissed }
                  })}
                  className="flex h-5 shrink-0 items-center gap-1 rounded px-1 text-[11px] text-fg-faint transition-colors hover:bg-hover hover:text-fg-muted"
                >
                  <Icon name="trash" size={10} />
                  Clear
                </button>
              </div>
              {state.endedAgentsOpen ? (
                <div className="flex flex-col gap-px">
                  {endedAgents.map((row) => (
                    <SubagentLine key={row.childSessionId} row={row} now={now} pending={false} onOpen={() => onOpenChild?.(row.childSessionId)} />
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}

      {todo.todos.length > 0 ? (
        <Section
          label="Tasks"
          tone={todoAllDone ? 'ok' : 'faint'}
          count={todoAllDone ? 'Done' : `${todoDone}/${todo.todos.length}`}
          open={state.tasksOpen}
          onToggle={() => setState((prev) => ({ ...prev, tasksOpen: !prev.tasksOpen }))}
        >
          {todo.todos.map((item, index) => (
            <div key={index} className="flex items-center gap-1.5 rounded-md py-1 pl-1 pr-0.5 text-[12px]">
              {item.status === 'in_progress' ? (
                <Spinner size={11} />
              ) : item.status === 'completed' ? (
                <Icon name="check" size={11} className="shrink-0 text-ok" />
              ) : (
                <span className="inline-block size-[10px] shrink-0 rounded-full border border-line" aria-hidden />
              )}
              <span className={cn('min-w-0 flex-1 truncate', item.status === 'completed' ? 'text-fg-faint' : 'text-fg')} title={item.status === 'in_progress' ? item.activeForm : item.content}>
                {item.content}
              </span>
            </div>
          ))}
        </Section>
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
          ? 'flex max-h-[calc(100dvh-320px)] w-[min(300px,calc(100%-2rem))] flex-col overflow-y-auto rounded-xl px-3 py-1.5 shadow-lg'
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
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-ok-soft px-1 py-px text-[10px] font-medium leading-[14px] text-ok" title={`${running.length} background process${running.length === 1 ? '' : 'es'} running`}>
                  <Icon name="terminal" size={9} />
                  {running.length}
                </span>
              ) : null}
              {runningAgents.length > 0 ? (
                <span className="flex shrink-0 items-center gap-0.5 rounded bg-ok-soft px-1 py-px text-[10px] font-medium leading-[14px] text-ok" title={`${runningAgents.length} subagent${runningAgents.length === 1 ? '' : 's'} running`}>
                  <Icon name="bot" size={9} />
                  {runningAgents.length}
                </span>
              ) : null}
            </span>
          ) : null}
          <Icon name="chevron" size={13} className={cn('icon-chevron ml-auto shrink-0 rounded-full p-0.5 text-fg-faint transition-transform hover:bg-hover hover:text-fg', expanded ? 'rotate-180' : '')} />
        </button>

        {expanded ? <div className="mt-1 border-t border-line pt-1">{detail}</div> : null}
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

/** A collapsible section: an uppercase eyebrow head, then child rows behind a rail. */
function Section({ label, tone, count, open, onToggle, children }: {
  readonly label: string
  readonly tone: 'warn' | 'ok' | 'faint'
  readonly count: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}) {
  return (
    <section aria-label={label} className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="group flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-hover"
      >
        <span className="truncate text-[11px] font-medium text-fg-faint group-hover:text-fg-muted">{label}</span>
        <span className={cn('shrink-0 whitespace-nowrap text-[11px] tabular-nums', tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-fg-faint')}>{count}</span>
        <Icon name="chevron" size={12} className={cn('shrink-0 text-fg-faint transition-transform', open ? 'rotate-180' : '')} />
      </button>
      {open ? <div className="flex flex-col gap-px pb-1 pl-2.5">{children}</div> : null}
    </section>
  )
}

/** One background process row. */
function ProcessLine({ row, now, pending, onOpen, onStop }: { readonly row: ProcessRow; readonly now: number; readonly pending: boolean; readonly onOpen: () => void; readonly onStop: () => void }) {
  const runningRow = row.status === 'running'
  const duration = runningRow ? now - row.startedAt : row.durationMs
  const statusLabel = runningRow ? 'running' : row.exitCode !== null ? `${row.status} (${row.exitCode})` : row.status
  return (
    <div className="flex items-center gap-2 rounded-md py-1 pl-1 pr-1 text-[12px]">
      <button
        type="button"
        onClick={onOpen}
        title={`Open ${row.command} in the workbench`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left"
      >
        {runningRow ? <Spinner size={11} /> : <span className="inline-block size-[10px] shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1 truncate text-fg">{row.command}</span>
        <span className="shrink-0 text-[11px] text-fg-faint">{formatDuration(duration)}</span>
        <span className={cn('shrink-0 text-[11px]', runningRow ? 'text-warn' : (TERMINAL_CLASS[row.status] ?? 'text-fg-faint'))}>{statusLabel}</span>
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

/** One subagent row: the role's face, the brief as its title, a live age, and a stop for the running ones. */
function SubagentLine({ row, now, pending, onOpen, onStop }: { readonly row: SubagentRow; readonly now: number; readonly pending: boolean; readonly onOpen: () => void; readonly onStop?: () => void }) {
  const icon = agentRoleIcon(row.definition)
  const title = row.brief !== '' ? row.brief : row.definition
  return (
    <div className="flex items-center gap-1.5 rounded-md py-1 pl-0.5 pr-0.5 text-[12px]">
      <button
        type="button"
        onClick={onOpen}
        title={row.brief !== '' ? `${row.definition}: ${row.brief}` : row.definition}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left"
      >
        <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[icon])}>
          {row.running ? <Spinner size={10} /> : <Icon name={icon} size={11} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg">{title}</span>
        <span className="shrink-0 text-[11px] text-fg-faint">{formatAge(row.running ? row.dispatchedAt : (row.endedAt ?? row.dispatchedAt), now)}</span>
        <span className={cn('shrink-0 text-[11px]', row.running ? 'text-ok' : (TERMINAL_CLASS[row.status ?? ''] ?? 'text-fg-faint'))}>
          {row.running ? 'running' : (row.status ?? '')}
        </span>
      </button>
      {row.running && onStop !== undefined ? (
        <button
          type="button"
          aria-label={`Stop ${title}`}
          title={`Stop ${title}`}
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
