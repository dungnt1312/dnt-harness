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
import { cn } from '../../lib/cn.ts'
import { processRows, subagentRows, type ProcessRow } from '../../lib/processes-view.ts'
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
}

const TERMINAL_CLASS: Record<string, string | undefined> = { killed: 'text-bad', failed: 'text-bad', interrupted: 'text-bad' }

function formatDuration(ms: number): string {
  if (ms < 1_000) return '0s'
  const seconds = Math.floor(ms / 1_000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60 > 0 ? ` ${seconds % 60}s` : ''}`
  return `${Math.floor(minutes / 60)}h${minutes % 60 > 0 ? ` ${minutes % 60}m` : ''}`
}

export function EnvironmentPanel({ workspaceId, sessionId, project, events, connected, onOpenView }: Props) {
  // Panel state is scoped to the conversation: switching resets both the
  // collapse and the one-shot auto-open.
  const [state, setState] = useState<{ scope: string | null; expanded: boolean; autoOpened: boolean }>({ scope: sessionId, expanded: false, autoOpened: false })
  const [git, setGit] = useState<GitLine | null>(null)
  const [liveRunning, setLiveRunning] = useState<readonly string[]>([])
  const [stopping, setStopping] = useState<readonly string[]>([])
  const [now, setNow] = useState(() => Date.now())

  const derived = useMemo(() => processRows(events), [events])
  const agents = useMemo(() => subagentRows(events), [events])
  const liveRunningIds = useMemo(() => new Set(liveRunning), [liveRunning])
  const rows = useMemo(
    () => derived.map((row) => (liveRunningIds.has(row.id) && row.status !== 'running' ? { ...row, status: 'running' as const } : row)),
    [derived, liveRunningIds],
  )
  const running = useMemo(() => rows.filter((row) => row.status === 'running'), [rows])
  const runningAgents = useMemo(() => agents.filter((row) => row.running), [agents])
  const hasLive = running.length > 0 || runningAgents.length > 0

  const scope = sessionId ?? null
  if (state.scope !== scope) setState({ scope, expanded: false, autoOpened: false })

  // The one-shot auto-open: the first live process or subagent for this
  // conversation expands the panel; a user collapse never reopens it.
  useEffect(() => {
    if (!hasLive || state.scope !== scope || state.autoOpened || state.expanded) return
    setState((prev) => (prev.scope === scope && !prev.autoOpened ? { ...prev, expanded: true, autoOpened: true } : prev))
  }, [hasLive, scope, state.scope, state.autoOpened, state.expanded])

  // Live durations for running processes only.
  useEffect(() => {
    if (running.length === 0) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [running.length])

  const turnEndCount = useMemo(() => events.filter((event) => event.type === 'turn/end').length, [events])

  // Git line: on mount and after each settled turn.
  useEffect(() => {
    if (workspaceId === null || project === null || sessionId === null) return
    let disposed = false
    const load = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/projects/${project.id}/git`)
        if (!res.ok) return
        const report = (await res.json()) as { branch?: string | null; changes?: readonly { added?: number; removed?: number }[]; ahead?: number; behind?: number }
        if (disposed) return
        let added = 0
        let removed = 0
        for (const change of report.changes ?? []) {
          added += change.added ?? 0
          removed += change.removed ?? 0
        }
        setGit({ branch: report.branch ?? null, added, removed, ahead: report.ahead ?? 0, behind: report.behind ?? 0 })
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
      const res = await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/processes`)
      if (!res.ok) return
      const snapshot = (await res.json()) as readonly { id: string; status: string }[]
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
        await fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/processes/${id}/stop`, { method: 'POST' })
      } catch {
        // The exit event (or reconcile) carries the truth; the click is done.
      } finally {
        setStopping((prev) => prev.filter((item) => item !== id))
      }
    },
    [workspaceId, sessionId],
  )

  if (sessionId === null) return null

  const expanded = state.expanded
  const collapseLabel = expanded ? 'Collapse environment' : 'Expand environment'
  const gitLabel = git === null ? (project?.name ?? '') : `${git.branch ?? project?.name ?? ''}`
  const syncs = git !== null && (git.ahead > 0 || git.behind > 0)

  return (
    <div className="shrink-0 px-3 pt-2 sm:px-6" data-environment-panel>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-1.5 rounded-xl border border-line bg-surface px-3 py-2">
        <button
          type="button"
          aria-label={collapseLabel}
          aria-expanded={expanded}
          onClick={() => setState((prev) => ({ ...prev, expanded: !prev.expanded }))}
          className="flex min-h-7 w-full items-center gap-2 text-left text-[13px] text-fg-muted transition-colors hover:text-fg"
        >
          <Icon name="info" size={14} className="shrink-0 text-fg-faint" />
          <span className="font-medium">Environment</span>
          {!expanded ? (
            <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
              {project !== null ? (
                <span className="truncate">
                  <span className="text-fg">{gitLabel}</span>
                  {git !== null && git.added + git.removed > 0 ? (
                    <>
                      <span className="text-ok"> +{git.added}</span>
                      <span className="text-bad"> −{git.removed}</span>
                    </>
                  ) : null}
                  {syncs ? (
                    <span className="text-fg-faint">
                      {' '}
                      ↑{git.ahead} ↓{git.behind}
                    </span>
                  ) : null}
                </span>
              ) : null}
              {running.length > 0 ? (
                <span className={cn('shrink-0 rounded-md bg-warn-soft px-1.5 py-0.5 text-[11px] font-medium text-warn')}>
                  {running.length} process{running.length === 1 ? '' : 'es'}
                </span>
              ) : null}
              {runningAgents.length > 0 ? (
                <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-fg-muted">
                  {runningAgents.length} subagent{runningAgents.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </span>
          ) : null}
          <Icon name="close" size={12} className={cn('ml-auto shrink-0 text-fg-faint transition-transform', expanded ? '' : 'rotate-180')} />
        </button>

        {expanded ? (
          <div className="flex flex-col gap-1.5">
            {project !== null ? (
              <section aria-label="Git">
                <button
                  type="button"
                  aria-label="Open git panel"
                  onClick={() => onOpenView('git')}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-hover"
                >
                  <Icon name="gitBranch" size={14} className="shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate font-medium text-fg" title={git?.branch ?? project.path}>{git?.branch ?? project.name}</span>
                  {syncs ? <span className="shrink-0 text-fg-faint">↑{git.ahead} ↓{git.behind}</span> : null}
                  {git !== null && git.added + git.removed > 0 ? (
                    <span className="shrink-0 text-[12px]">
                      <span className="text-ok">+{git.added}</span> <span className="text-bad">−{git.removed}</span>
                    </span>
                  ) : (
                    <span className="shrink-0 text-[12px] text-fg-faint">clean</span>
                  )}
                </button>
              </section>
            ) : null}

            {rows.length > 0 ? (
              <section aria-label="Processes" className="flex flex-col gap-0.5">
                {rows.map((row) => (
                  <ProcessLine key={row.id} row={row} now={now} pending={stopping.includes(row.id)} onStop={() => void stop(row.id)} />
                ))}
              </section>
            ) : null}

            {agents.length > 0 ? (
              <section aria-label="Subagents" className="flex flex-col gap-0.5">
                {agents.map((row) => (
                  <button
                    key={row.childSessionId}
                    type="button"
                    onClick={() => onOpenView('agents')}
                    className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left text-[13px] transition-colors hover:bg-hover"
                  >
                    {row.running ? <Spinner size={11} /> : <span className="inline-block size-[11px] shrink-0" aria-hidden />}
                    <span className="min-w-0 flex-1 truncate text-fg" title={row.definition}>{row.definition}</span>
                    <span className={cn('shrink-0 text-[12px]', row.running ? 'text-warn' : (TERMINAL_CLASS[row.status ?? ''] ?? 'text-fg-faint'))}>
                      {row.running ? 'running' : (row.status ?? '')}
                    </span>
                  </button>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ProcessLine({ row, now, pending, onStop }: { readonly row: ProcessRow; readonly now: number; readonly pending: boolean; readonly onStop: () => void }) {
  const runningRow = row.status === 'running'
  const duration = runningRow ? now - row.startedAt : row.durationMs
  const statusLabel = runningRow ? 'running' : row.exitCode !== null ? `${row.status} (${row.exitCode})` : row.status
  return (
    <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-[13px]">
      {runningRow ? <Spinner size={11} /> : <span className="inline-block size-[11px] shrink-0" aria-hidden />}
      <Icon name="terminal" size={13} className="shrink-0 text-fg-faint" />
      <span className="min-w-0 flex-1 truncate text-fg" title={row.command}>{row.command}</span>
      <span className={cn('shrink-0 text-[12px] text-fg-faint')} title={statusLabel}>{formatDuration(duration)}</span>
      <span className={cn('shrink-0 text-[12px]', runningRow ? 'text-warn' : (TERMINAL_CLASS[row.status] ?? 'text-fg-faint'))}>{statusLabel}</span>
      {runningRow ? (
        <button
          type="button"
          aria-label={`Stop ${row.command}`}
          title={`Stop ${row.command}`}
          disabled={pending}
          onClick={onStop}
          className="flex size-5 shrink-0 items-center justify-center rounded text-fg-faint transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
        >
          <Icon name="square" size={11} />
        </button>
      ) : null}
    </div>
  )
}
