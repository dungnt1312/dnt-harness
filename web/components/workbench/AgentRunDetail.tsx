import Icon from '../common/Icon.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Section } from '../chat/ToolArguments.tsx'
import { agentRoleIcon, AGENT_ROLE_TONE } from '../../lib/agent-icons.ts'
import { cn } from '../../lib/cn.ts'
import { formatAge } from '../../lib/format.ts'
import type { ChildRow } from '../../lib/types.ts'

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

const LIVE: ReadonlySet<ChildRow['status']> = new Set(['queued', 'dispatching', 'running', 'uncertain'])

/**
 * One subagent's detail in the workbench: its brief, status, final report (or
 * the reason there is none) and the files it touched. The child's full history
 * is its own conversation, one button away.
 */
export function AgentRunDetail({ childSessionId, child, loading, brief, onBack, onOpenConversation }: {
  readonly childSessionId: string
  /** Null while the children list loads, or when the child is not in it. */
  readonly child: ChildRow | null
  readonly loading: boolean
  readonly brief: string | undefined
  readonly onBack: () => void
  readonly onOpenConversation?: (childSessionId: string) => void
}) {
  const icon = agentRoleIcon(child?.definitionName ?? '')
  const live = child !== null && LIVE.has(child.status)
  const evidence = child?.result ?? (child?.error !== undefined ? child.partial : undefined)
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <button type="button" onClick={onBack} className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[13px] text-fg-muted hover:bg-hover hover:text-fg">
          <Icon name="chevronRight" size={14} className="rotate-180" />
          All subagents
        </button>
        {onOpenConversation !== undefined ? (
          <button type="button" onClick={() => onOpenConversation(childSessionId)} className="ml-auto text-[13px] text-link hover:underline">
            Open conversation →
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-md bg-muted', AGENT_ROLE_TONE[icon])}>
            {live ? <Spinner size={13} /> : <Icon name={icon} size={14} />}
          </span>
          <span className="min-w-0 truncate text-sm font-semibold text-fg">{child?.definitionName ?? 'Subagent'}</span>
          {child !== null ? (
            <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-fg-faint">
              {formatAge(child.endedAt ?? child.startedAt)}
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium leading-4 text-fg-muted">{STATUS_LABEL[child.status]}</span>
            </span>
          ) : null}
        </div>
        {child?.model !== undefined ? <span className="-mt-2 truncate font-mono text-[11px] text-fg-faint">{child.model}</span> : null}
        {brief !== undefined && brief !== '' ? (
          <Section label="Brief" copy={brief}><p className="m-0 whitespace-pre-wrap break-words text-[13px]">{brief}</p></Section>
        ) : null}
        {child === null ? (
          <p className="m-0 text-[13px] text-fg-muted">{loading ? 'Loading this subagent…' : 'This subagent is no longer listed. Open its conversation for the full history.'}</p>
        ) : live ? (
          <p className="m-0 text-[13px] text-fg-muted">
            {child.awaitingApproval === true ? 'Waiting for your approval — open the conversation to answer.' : 'Still working. The report appears here when it finishes.'}
          </p>
        ) : (
          <Section label={child.result !== undefined ? 'Result' : 'Result (none)'} {...(evidence !== undefined ? { copy: evidence.report } : {})}>
            {child.error !== undefined && child.result === undefined ? <p className="m-0 text-[13px] text-bad">{child.error}</p> : null}
            {evidence !== undefined && evidence.truncated === true ? (
              <p className="m-0 text-xs text-warn">Report truncated — open the conversation for the full text.</p>
            ) : null}
            {evidence !== undefined && evidence.report !== '' ? (
              <>
                {child.result === undefined ? <span className="text-xs text-fg-faint">What it had said before stopping:</span> : null}
                <p className="m-0 whitespace-pre-wrap break-words text-[13px]">{evidence.report}</p>
              </>
            ) : null}
            {child.result === undefined && child.error === undefined ? <p className="m-0 text-[13px] text-fg-muted">No result was recorded.</p> : null}
            {evidence !== undefined && evidence.filesTouched.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-xs text-fg-faint">Files touched:</span>
                {evidence.filesTouched.map((file) => <code key={file} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{file}</code>)}
              </div>
            ) : null}
          </Section>
        )}
      </div>
    </div>
  )
}
