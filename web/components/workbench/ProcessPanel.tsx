/**
 * The workbench's Process view: one background process with its captured
 * output, polled live while it runs. Reached from the Environment panel's
 * process rows (or a tool row's background chip). A process the host no
 * longer knows — a restart orphaned it — says so truthfully; its history
 * stays in the transcript.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { cn } from '../../lib/cn.ts'
import { getSessionProcess, stopSessionProcess, type SessionProcessDetail } from '../../lib/api.ts'
import { formatDuration } from '../chat/EnvironmentPanel.tsx'

const TERMINAL_CLASS: Record<string, string | undefined> = { running: 'text-warn', killed: 'text-bad', failed: 'text-bad', interrupted: 'text-bad' }

export function ProcessPanel({ workspaceId, sessionId, processId }: {
  readonly workspaceId: string | null
  readonly sessionId: string | null
  readonly processId: string | null
}) {
  const [detail, setDetail] = useState<SessionProcessDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [stopping, setStopping] = useState(false)
  const outputRef = useRef<HTMLPreElement>(null)

  const load = useCallback(async (): Promise<void> => {
    if (workspaceId === null || sessionId === null || processId === null) return
    try {
      const next = await getSessionProcess(workspaceId, sessionId, processId)
      setDetail(next)
      setMissing(false)
    } catch {
      // Unknown id: the host restarted (orphaned processes are not re-adopted).
      setMissing(true)
      setDetail(null)
    }
  }, [workspaceId, sessionId, processId])

  useEffect(() => { void load() }, [load])

  // Poll while the process is running; an ended process is final.
  const running = detail?.status === 'running'
  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => { void load() }, 2_000)
    return () => window.clearInterval(id)
  }, [running, load])

  // Follow the output tail unless the reader scrolled up.
  useEffect(() => {
    const node = outputRef.current
    if (node === null || !running) return
    node.scrollTop = node.scrollHeight
  }, [detail?.output, running])

  const stop = useCallback(async (): Promise<void> => {
    if (workspaceId === null || sessionId === null || processId === null) return
    setStopping(true)
    try {
      await stopSessionProcess(workspaceId, sessionId, processId)
      await load()
    } catch {
      // The next poll (or the exit event) carries the truth.
    } finally {
      setStopping(false)
    }
  }, [workspaceId, sessionId, processId, load])

  if (processId === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="terminal" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">No process selected</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">Open one from the Environment panel — click a background process row above the transcript.</p>
      </div>
    )
  }
  if (missing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon name="alertTriangle" size={22} className="text-fg-faint" />
        <p className="m-0 text-sm font-medium">This process is no longer running on the host</p>
        <p className="m-0 max-w-xs text-[13px] text-fg-muted">A host restart does not re-adopt background processes. What the agent saw stays in the transcript.</p>
      </div>
    )
  }
  if (detail === null) {
    return <div className="flex flex-1 items-center justify-center gap-2 text-sm text-fg-muted"><Spinner size={14} />Loading process…</div>
  }

  const statusLabel = detail.status === 'running' ? 'running' : detail.exitCode !== null ? `${detail.status} · exit ${detail.exitCode}` : detail.status
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon name="terminal" size={14} className="shrink-0 text-fg-faint" />
        <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg" title={detail.command}>{detail.command}</span>
        {running ? <Spinner size={12} /> : null}
        <span className="shrink-0 text-[12px] text-fg-faint">{formatDuration(detail.durationMs)}</span>
        <span className={cn('shrink-0 text-[12px] font-medium', TERMINAL_CLASS[detail.status] ?? 'text-fg-muted')}>{statusLabel}</span>
        {running ? (
          <button
            type="button"
            aria-label={`Stop ${detail.command}`}
            onClick={() => void stop()}
            disabled={stopping}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-line px-2 text-[12px] text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <Icon name="square" size={10} />
            Stop
          </button>
        ) : null}
      </div>
      <p className="m-0 shrink-0 px-4 pt-1.5 text-[11px] text-fg-faint" title={detail.cwd}>{detail.cwd}{detail.outputTruncated ? ' · output truncated at the capture cap' : ''}</p>
      <pre
        ref={outputRef}
        tabIndex={0}
        aria-label="Process output"
        className="m-3 mt-1.5 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-term-bg p-3 font-mono text-[12px] leading-5 text-term-fg"
      >
        {detail.output === '' ? (running ? 'No output yet.' : 'No output.') : detail.output}
      </pre>
    </div>
  )
}
