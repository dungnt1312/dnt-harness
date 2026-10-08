/**
 * The workbench's Process view, laid out like a "Background tasks" list: every
 * background process of the conversation as a card (command, `Bash ·
 * status · duration`), running ones first, finished ones folded behind a
 * collapsible group. A card expands in place to show the command (shell-
 * highlighted) and its captured output, polled live while it runs. The
 * Environment panel's focused process opens expanded and scrolled into view.
 * A focused process the host no longer knows — a restart orphaned it — says
 * so truthfully; its history stays in the transcript.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { cn } from '../../lib/cn.ts'
import { ensureLanguage, escapeHtml, highlight } from '../../lib/highlight.ts'
import { getSessionProcess, listSessionProcesses, stopSessionProcess, type SessionProcessDetail, type SessionProcessSnapshot } from '../../lib/api.ts'
import { formatDuration } from '../chat/EnvironmentPanel.tsx'
import { useDismissedRows } from '../../lib/dismissed-rows.ts'

/** List refresh cadence: brisk while something runs, relaxed otherwise. */
const LIVE_POLL_MS = 2_000
const IDLE_POLL_MS = 5_000

type Tone = 'run' | 'ok' | 'bad' | 'faint'

/** Human status for a card: `Completed` / `Failed` / `Stopped` …, with its tone. */
export function processStatus(row: Pick<SessionProcessSnapshot, 'status' | 'exitCode'>): { readonly label: string; readonly tone: Tone } {
  switch (row.status) {
    case 'running': return { label: 'Running', tone: 'run' }
    case 'exited': return row.exitCode === 0 || row.exitCode === null ? { label: 'Completed', tone: 'ok' } : { label: `Failed (exit ${row.exitCode})`, tone: 'bad' }
    case 'killed': return { label: 'Stopped', tone: 'faint' }
    case 'interrupted': return { label: 'Interrupted', tone: 'bad' }
    default: return { label: 'Failed', tone: 'bad' }
  }
}

const TONE_CLASS: Record<Tone, string> = { run: 'text-warn', ok: 'text-fg-faint', bad: 'text-bad', faint: 'text-fg-faint' }

/** First non-empty line of a command: the card's title. */
function titleOf(command: string): string {
  return command.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? command
}

export function ProcessPanel({ workspaceId, sessionId, processId }: {
  readonly workspaceId: string | null
  readonly sessionId: string | null
  /** The process the Environment panel focused: opened expanded. */
  readonly processId: string | null
}) {
  const [rows, setRows] = useState<readonly SessionProcessSnapshot[] | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(processId !== null ? [processId] : []))
  const [finishedOpen, setFinishedOpen] = useState(true)
  // Persisted per conversation (shared with the Environment panel's Clear),
  // so a reload does not resurrect cleared tasks.
  const { dismissed, dismiss, undismiss } = useDismissedRows(workspaceId, sessionId)

  const loadList = useCallback(async (): Promise<void> => {
    if (workspaceId === null || sessionId === null) return
    try {
      setRows(await listSessionProcesses(workspaceId, sessionId))
      setListFailed(false)
    } catch {
      setListFailed(true)
      setRows((previous) => previous ?? [])
    }
  }, [workspaceId, sessionId])

  useEffect(() => { void loadList() }, [loadList])

  const anyRunning = rows?.some((row) => row.status === 'running') ?? false
  useEffect(() => {
    const id = window.setInterval(() => { void loadList() }, anyRunning ? LIVE_POLL_MS : IDLE_POLL_MS)
    return () => window.clearInterval(id)
  }, [anyRunning, loadList])

  // A newly focused process (another click in the Environment panel) opens
  // expanded and is no longer hidden by an earlier Clear.
  useEffect(() => {
    if (processId === null) return
    setExpanded((previous) => (previous.has(processId) ? previous : new Set([...previous, processId])))
    undismiss(processId)
  }, [processId, undismiss])

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const { running, finished } = useMemo(() => {
    const sorted = [...(rows ?? [])].sort((left, right) => right.startedAt - left.startedAt)
    return {
      running: sorted.filter((row) => row.status === 'running'),
      finished: sorted.filter((row) => row.status !== 'running' && !dismissed.has(row.id)),
    }
  }, [rows, dismissed])

  const clearFinished = useCallback(() => {
    dismiss(finished.map((row) => row.id))
  }, [finished, dismiss])

  if (workspaceId === null || sessionId === null) return null
  if (rows === null) {
    return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted"><Spinner size={14} />Loading background tasks…</div>
  }

  const focusMissing = processId !== null && !rows.some((row) => row.id === processId)
  const empty = running.length === 0 && finished.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        <span className="text-[13px] font-medium text-fg">Background tasks</span>
        {running.length > 0 ? <span className="text-[12px] tabular-nums text-warn">{running.length} running</span> : null}
        <span className="flex-1" />
        {finished.length > 0 ? (
          <button
            type="button"
            aria-label="Clear finished tasks"
            title="Clear finished tasks"
            onClick={clearFinished}
            className="flex size-7 items-center justify-center rounded-lg text-fg-faint transition-colors hover:bg-hover hover:text-fg"
          >
            <Icon name="trash" size={14} />
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {listFailed ? <p className="m-0 px-1 pb-2 text-[12px] text-fg-faint">Could not refresh the task list; showing the last known state.</p> : null}
        {focusMissing ? <MissingProcess workspaceId={workspaceId} sessionId={sessionId} processId={processId} /> : null}

        {empty && !focusMissing ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
            <Icon name="terminal" size={22} className="text-fg-faint" />
            <p className="m-0 text-sm font-medium">No background tasks</p>
            <p className="m-0 max-w-xs text-[13px] text-fg-muted">Commands the agent runs in the background appear here with their output.</p>
          </div>
        ) : null}

        {running.length > 0 ? (
          <div className="flex flex-col gap-1.5 pb-2">
            {running.map((row) => (
              <TaskCard key={row.id} workspaceId={workspaceId} sessionId={sessionId} row={row} open={expanded.has(row.id)} focused={row.id === processId} onToggle={toggle} onChanged={loadList} />
            ))}
          </div>
        ) : null}

        {finished.length > 0 ? (
          <section aria-label="Finished tasks" className="flex flex-col">
            <button
              type="button"
              aria-expanded={finishedOpen}
              onClick={() => setFinishedOpen((open) => !open)}
              className="flex w-fit items-center gap-1 rounded-md px-1 py-1 text-[12px] text-fg-muted transition-colors hover:text-fg"
            >
              Finished <span className="tabular-nums">{finished.length}</span>
              <Icon name="chevron" size={12} className={cn('transition-transform', finishedOpen ? '' : '-rotate-90')} />
            </button>
            {finishedOpen ? (
              <div className="flex flex-col gap-1.5 pt-1">
                {finished.map((row) => (
                  <TaskCard key={row.id} workspaceId={workspaceId} sessionId={sessionId} row={row} open={expanded.has(row.id)} focused={row.id === processId} onToggle={toggle} onChanged={loadList} />
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  )
}

/** The focused process is gone from the host registry: say so, once, above the list. */
function MissingProcess({ workspaceId, sessionId, processId }: { readonly workspaceId: string; readonly sessionId: string; readonly processId: string }) {
  // The list can lag a just-started process by one poll: confirm with the
  // detail route before calling it orphaned.
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let live = true
    getSessionProcess(workspaceId, sessionId, processId).then(() => undefined, () => { if (live) setGone(true) })
    return () => { live = false }
  }, [workspaceId, sessionId, processId])
  if (!gone) return null
  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl border border-line bg-muted px-3 py-2.5">
      <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0 text-fg-faint" />
      <div className="min-w-0">
        <p className="m-0 text-[13px] font-medium">This process is no longer running on the host</p>
        <p className="m-0 text-[12px] text-fg-muted">A host restart does not re-adopt background processes. What the agent saw stays in the transcript.</p>
      </div>
    </div>
  )
}

const TaskCard = memo(function TaskCard({ workspaceId, sessionId, row, open, focused, onToggle, onChanged }: {
  readonly workspaceId: string
  readonly sessionId: string
  readonly row: SessionProcessSnapshot
  readonly open: boolean
  readonly focused: boolean
  readonly onToggle: (id: string) => void
  readonly onChanged: () => Promise<void>
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const [stopping, setStopping] = useState(false)
  const running = row.status === 'running'
  const status = processStatus(row)
  const now = useTick(running)
  const duration = running ? Math.max(row.durationMs, now - row.startedAt) : row.durationMs

  // The focused card is the one the reader came for: bring it into view once.
  useEffect(() => {
    if (focused) cardRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [focused])

  const stop = async (): Promise<void> => {
    setStopping(true)
    try {
      await stopSessionProcess(workspaceId, sessionId, row.id)
    } catch {
      // The next poll (or the exit event) carries the truth.
    } finally {
      setStopping(false)
      await onChanged()
    }
  }

  return (
    <div
      ref={cardRef}
      data-process-id={row.id}
      className={cn('group rounded-xl bg-muted transition-colors', open ? '' : 'hover:bg-hover', focused && 'ring-1 ring-line-strong')}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${row.command}`}
          onClick={() => onToggle(row.id)}
          className="flex min-w-0 flex-1 flex-col gap-0.5 text-left"
        >
          <span className="truncate text-[13px] text-fg" title={row.command}>{titleOf(row.command)}</span>
          <span className="flex items-center gap-2 text-[12px]">
            <span className="text-fg-faint">Bash</span>
            {running ? <Spinner size={10} /> : null}
            <span className={TONE_CLASS[status.tone]}>{status.label}</span>
            <span className="tabular-nums text-fg-faint">{formatDuration(duration)}</span>
          </span>
        </button>
        {running ? (
          <button
            type="button"
            aria-label={`Stop ${row.command}`}
            title="Stop"
            onClick={() => void stop()}
            disabled={stopping}
            className="mt-0.5 flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line bg-bg px-2 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <Icon name="square" size={10} />
            Stop
          </button>
        ) : null}
      </div>
      {open ? <TaskDetail workspaceId={workspaceId} sessionId={sessionId} row={row} /> : null}
    </div>
  )
})

/** Expanded body: the highlighted command, then the captured output (polled while running). */
function TaskDetail({ workspaceId, sessionId, row }: { readonly workspaceId: string; readonly sessionId: string; readonly row: SessionProcessSnapshot }) {
  const [detail, setDetail] = useState<SessionProcessDetail | null>(null)
  const [failed, setFailed] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)
  const running = row.status === 'running'

  const load = useCallback(async (): Promise<void> => {
    try {
      setDetail(await getSessionProcess(workspaceId, sessionId, row.id))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [workspaceId, sessionId, row.id])

  // Re-read when the row's status flips (the final output lands with the exit).
  useEffect(() => { void load() }, [load, row.status])
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => { void load() }, LIVE_POLL_MS)
    return () => window.clearInterval(id)
  }, [running, load])

  // Follow the output tail while it runs.
  useEffect(() => {
    const node = outputRef.current
    if (node === null || !running) return
    node.scrollTop = node.scrollHeight
  }, [detail?.output, running])

  const [bashReady, setBashReady] = useState(false)
  useEffect(() => {
    let live = true
    void ensureLanguage('bash').then((ok) => { if (live && ok) setBashReady(true) })
    return () => { live = false }
  }, [])
  const commandHtml = useMemo(() => (bashReady ? highlight(row.command, 'bash') : escapeHtml(row.command)), [bashReady, row.command])

  const output = detail?.output ?? ''
  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      <div className="flex gap-2 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-[12px] leading-5" title={row.cwd}>
        <span aria-hidden="true" className="select-none text-fg-faint">&gt;</span>
        <code className="min-w-0 flex-1 whitespace-pre-wrap break-words text-fg" dangerouslySetInnerHTML={{ __html: commandHtml }} />
      </div>
      <pre
        ref={outputRef}
        tabIndex={0}
        aria-label="Process output"
        className="m-0 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-hover px-3 py-2 font-mono text-[12px] leading-5 text-fg"
      >
        {detail === null
          ? (failed ? 'Output unavailable — the host no longer holds this process.' : 'Loading output…')
          : output === '' ? (running ? 'No output yet.' : 'No output.') : output}
      </pre>
      {detail?.outputTruncated ? <p className="m-0 px-1 text-[11px] text-fg-faint">Output truncated at the capture cap.</p> : null}
    </div>
  )
}

/** A one-second tick while a card runs, so its duration counts up between polls. */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [active])
  return now
}
