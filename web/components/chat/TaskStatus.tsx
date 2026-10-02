import { useMemo } from 'react'
import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { taskPhase, type TaskPhase } from '../../lib/project.ts'
import type { SseEvent } from '../../lib/types.ts'
import { todosFromEvents } from '../../lib/todos-view.ts'

const LABELS: Record<TaskPhase, string> = { idle: 'Ready', preparing: 'Preparing · submitting or queued', held: 'Stopped · queued messages are waiting', running: 'Working', waiting: 'Approval required', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted', cancelled: 'Stopped', steered: 'Redirected', rejected: 'Request rejected', empty: 'Ended without a response', limit: 'Turn limit reached' }

/**
 * Slim lifecycle line above the composer. Durable phase and connection loss
 * are reported separately: a dropped stream never implies work stopped.
 */
export function TaskStatus({ events, pending, sending, connected }: { readonly events: readonly SseEvent[]; readonly pending: number; readonly sending: boolean; readonly connected: boolean }) {
  const phase = useMemo(() => taskPhase(events, pending, sending), [events, pending, sending])
  const todo = useMemo(() => todosFromEvents(events), [events])
  const recovered = useMemo(() => {
    let found = false
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') break
      if (events[i]?.recovery === true) found = true
    }
    return found
  }, [events])
  // Failed and rejected turns render as one card inside the transcript itself.
  const showPhase = !(phase === 'idle' || phase === 'completed' || phase === 'failed' || phase === 'rejected')
  if (!showPhase && connected) return null
  const busy = phase === 'running' || phase === 'preparing'
  const phaseLabel = phase === 'running' && todo.active !== undefined ? `Working · ${todo.active.activeForm}` : LABELS[phase]
  return (
    <section aria-label="Work status" role="status" aria-live="polite" className="flex flex-col gap-1 px-1 text-[13px] text-fg-muted">
      {showPhase ? (
        <div className="flex flex-wrap items-center gap-2">
          {busy ? <Spinner size={12} /> : <Icon name={phase === 'waiting' ? 'shield' : 'info'} size={14} className={phase === 'waiting' ? 'text-warn' : undefined} />}
          <strong className={busy ? 'font-medium text-shimmer' : 'font-medium text-fg'}>{phaseLabel}</strong>
          {phase === 'held' ? <span>They do not run on their own after a stop or restart — use Send now on a queued message.</span> : null}
        </div>
      ) : null}
      {!connected ? (
        <p className="m-0 flex items-center gap-2 text-warn">
          <Icon name="alertTriangle" size={14} />
          Event connection unavailable. State may be out of date; a lost connection does not mean work has stopped.
        </p>
      ) : null}
      {showPhase && recovered ? <p className="m-0 text-xs">A recovered tool outcome may be unknown. Inspect the file or target system before requesting another action.</p> : null}
    </section>
  )
}
