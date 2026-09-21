import { useEffect, useId, useState, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Markdown } from '../../Markdown.tsx'
import { ThinkingPanel } from './ThinkingPanel.tsx'
import { formatTime, toolTarget } from '../../lib/format.ts'
import { attachmentUrl, waitChild } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { formatBytes, type AttachmentRef } from '../../lib/composer-draft.ts'
import { parseMessageText } from '../../lib/inline-chips.ts'
import { InlineChip } from '../common/InlineChip.tsx'
import type { ChildRow } from '../../lib/types.ts'
import type { ViewItem } from '../../lib/project.ts'
import type { OpenPathResolver } from '../artifacts/ArtifactsPanel.tsx'

/** Images render inline; anything else is named rather than previewed. */
const isImageAttachment = (ref: AttachmentRef): boolean => ref.mediaType.startsWith('image/')

/** Hover-revealed on fine pointers, always visible on touch and keyboard focus. */
const revealActions = 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(pointer:coarse)]:opacity-100'

export function UserBubble({ item, workspaceId, onReuse }: {
  readonly item: Extract<ViewItem, { kind: 'user' }>
  /** Needed to fetch attachment bytes; without it they show as file chips. */
  readonly workspaceId?: string | null
  readonly onReuse?: (text: string) => void
}) {
  const queued = item.queued === true
  const attachments = item.attachments ?? []
  return (
    <div className="group flex flex-col items-end gap-0.5" title={item.ts !== undefined ? formatTime(item.ts) : undefined}>
      <div
        className={cn(
          'max-w-[85%] rounded-3xl px-4 py-2.5 text-[15px] leading-relaxed sm:max-w-[70%]',
          queued ? 'border border-dashed border-line-strong text-fg-muted' : 'bg-muted',
        )}
      >
        {queued ? <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-fg-faint">Queued</span> : null}
        {attachments.length > 0 ? (
          <ul className="m-0 mb-1.5 flex list-none flex-wrap gap-1.5 p-0">
            {attachments.map((ref) => (
              <li key={ref.id}>
                {isImageAttachment(ref) && workspaceId != null ? (
                  <img
                    src={attachmentUrl(workspaceId, ref.id)}
                    alt={ref.name}
                    className="max-h-40 rounded-xl border border-line object-cover"
                  />
                ) : (
                  <span className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-[13px]">
                    <Icon name="fileText" size={14} className="text-fg-muted" />
                    <span className="truncate">{ref.name}</span>
                    <span className="text-fg-faint">{formatBytes(ref.bytes)}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {item.content !== '' ? (
          <p className="m-0 whitespace-pre-wrap break-words">
            {parseMessageText(item.content).map((segment, index) => (
              segment.kind === 'text' ? segment.text : <InlineChip key={index} segment={segment} />
            ))}
          </p>
        ) : null}
      </div>
      {!queued && onReuse !== undefined ? (
        <div className={cn('flex items-center gap-0.5', revealActions)}>
          <CopyButton text={item.content} label="Copy message" className="size-7" />
          <IconButton label="Reuse in composer" className="size-7" onClick={() => onReuse(item.content)}>
            <Icon name="pencil" size={15} />
          </IconButton>
        </div>
      ) : null}
    </div>
  )
}

/**
 * One assistant answer: thinking disclosure, markdown. The action row (copy,
 * serving model, time) belongs to the whole turn, so `Transcript` passes
 * `turn` only on the last answer of a closed turn — copying every answer
 * that turn produced.
 */
export function AssistantMessage({ item, modelLabel, turn }: {
  readonly item: Extract<ViewItem, { kind: 'assistant' }>
  readonly modelLabel?: string
  /** Present on the last answer of a closed turn; text is the turn's full answer. */
  readonly turn?: { readonly text: string }
}) {
  // The label reports what actually served THIS step (recorded controls);
  // the workspace's current model is only the fallback for legacy events.
  const controlsLabel = item.controls !== undefined
    ? [item.controls.model, item.controls.provider].filter((part) => part !== undefined && part !== '').join(' · ')
    : ''
  const label = controlsLabel !== '' ? controlsLabel : modelLabel
  return (
    <div className="group flex flex-col gap-1">
      {item.thinking.length > 0 || item.thinkingLive ? <ThinkingPanel thinking={item.thinking} live={item.live && item.thinkingLive} /> : null}
      {item.content !== '' ? (
        <div className="text-fg">
          <Markdown content={item.content} />
          {item.live ? <span className="ml-0.5 inline-block size-2.5 translate-y-[-1px] rounded-full bg-fg align-middle animate-dot" aria-hidden="true" /> : null}
        </div>
      ) : null}
      {!item.live && turn !== undefined ? (
        <div className={cn('-ml-2 flex items-center gap-1 text-xs text-fg-faint', revealActions)}>
          <CopyButton text={turn.text} label="Copy response" className="size-7" />
          {label !== undefined ? <span className="truncate">{label}</span> : null}
          {item.ts !== undefined ? <span>· {formatTime(item.ts)}</span> : null}
        </div>
      ) : null}
    </div>
  )
}

function fmtDuration(ms: number): string {
  if (Number.isNaN(ms)) return ''
  if (ms < 1_000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1_000)}s`
}

type RowState = 'running' | 'ok' | 'failed' | 'unknown' | 'cancelled'

const STATE_TEXT: Readonly<Record<RowState, string>> = {
  running: 'Running',
  ok: 'Succeeded',
  failed: 'Failed',
  unknown: 'Outcome unknown',
  cancelled: 'Cancelled',
}

/** Status glyph with a text alternative — state is never conveyed by color alone. */
function StateGlyph({ state }: { readonly state: RowState }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      {state === 'running' ? <Spinner size={13} /> : null}
      {state === 'ok' ? <Icon name="check" size={15} className="text-ok" /> : null}
      {state === 'failed' ? <Icon name="close" size={15} className="text-bad" /> : null}
      {state === 'unknown' ? <Icon name="alertTriangle" size={14} className="text-warn" /> : null}
      {state === 'cancelled' ? <Icon name="circle" size={13} className="text-fg-faint" /> : null}
      <span className="sr-only">{STATE_TEXT[state]}</span>
    </span>
  )
}

/** Compact disclosure row shared by tool calls and delegations. */
function ActivityRow({ state, title, detail, trailing, children }: {
  readonly state: RowState
  readonly title: ReactNode
  readonly detail?: string
  readonly trailing?: ReactNode
  readonly children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="-mx-2 flex min-h-8 max-w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-fg-muted transition-colors hover:bg-muted hover:text-fg"
      >
        <StateGlyph state={state} />
        <span className="shrink-0 font-medium text-fg">{title}</span>
        {detail !== undefined && detail !== '' ? <span className="min-w-0 truncate font-mono text-xs text-fg-faint" title={detail}>{detail}</span> : null}
        {trailing}
        <Icon name="chevronRight" size={14} className={cn('shrink-0 text-fg-faint transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded ? (
        <div id={bodyId} role="region" className="mt-1 flex flex-col gap-2 rounded-xl border border-line p-3 text-sm animate-fade-up">
          {children}
        </div>
      ) : null}
    </div>
  )
}

function Section({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-xs font-medium text-fg-faint">{label}</span>
      {children}
    </div>
  )
}

const preClass = 'm-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-fg'

/** A tool invocation: one quiet line that expands to exact arguments and recorded output. */
export function ToolCard({ item, openPath }: { readonly item: Extract<ViewItem, { kind: 'tool' }>; readonly openPath?: OpenPathResolver }) {
  const { call, result, ts, doneAt, server, recovered } = item
  const recordedPath = typeof call.args['path'] === 'string' ? call.args['path'] : typeof call.args['file_path'] === 'string' ? call.args['file_path'] : undefined
  const open = recordedPath !== undefined ? openPath?.(recordedPath) ?? null : null
  const state: RowState = result === undefined ? 'running' : recovered === true ? 'unknown' : result.ok ? 'ok' : 'failed'
  const duration = result !== undefined && ts !== undefined && doneAt !== undefined ? fmtDuration(doneAt - ts) : ''
  return (
    <ActivityRow
      state={state}
      title={call.name}
      detail={toolTarget(call.args)}
      trailing={(
        <>
          {server !== undefined ? <span className="shrink-0 rounded-md bg-muted px-1.5 text-xs text-fg-muted">{server}</span> : null}
          {recovered === true ? <span className="shrink-0 rounded-md bg-warn-soft px-1.5 text-xs text-warn">recovered</span> : null}
          {duration !== '' ? <span className="shrink-0 font-mono text-xs text-fg-faint">{duration}</span> : null}
        </>
      )}
    >
      <Section label={`Arguments · ${call.id}`}><pre className={preClass}>{JSON.stringify(call.args, null, 2)}</pre></Section>
      {open !== null ? <button type="button" className="self-start text-[13px] text-link hover:underline" onClick={open}>Open {recordedPath} in workbench</button> : null}
      {recovered === true && result !== undefined ? (
        <p className="m-0 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
          <Icon name="alertTriangle" size={14} />
          Outcome unknown — the host restarted before this result was recorded.
        </p>
      ) : null}
      {result !== undefined
        ? <Section label="Output"><pre className={preClass}>{result.output || '(empty)'}</pre></Section>
        : <p className="m-0 text-[13px] text-fg-muted">Running…</p>}
    </ActivityRow>
  )
}

const DELEGATION_STATE: Readonly<Record<Extract<ViewItem, { kind: 'delegation' }>['status'], RowState>> = {
  running: 'running',
  completed: 'ok',
  failed: 'failed',
  interrupted: 'unknown',
  cancelled: 'cancelled',
}

/**
 * One delegation from the durable spawn → result pair. The settled result
 * payload (summary, file references, error) is fetched when expanded.
 */
export function DelegationCard({ item, workspaceId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  return (
    <ActivityRow state={DELEGATION_STATE[item.status]} title={`Delegated to ${item.definition !== '' ? item.definition : 'agent'}`} detail={item.objective}>
      <DelegationDetail item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} {...(onOpen !== undefined ? { onOpen } : {})} />
    </ActivityRow>
  )
}

function DelegationDetail({ item, workspaceId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  const [detail, setDetail] = useState<ChildRow | null>(null)
  const settled = item.status !== 'running'

  // Mounted only while expanded, so the result is fetched on demand.
  useEffect(() => {
    if (!settled || workspaceId === null || workspaceId === undefined) return
    let cancelled = false
    void waitChild(workspaceId, item.childSessionId, 1_000).then(
      (row) => { if (!cancelled) setDetail(row) },
      () => {},
    )
    return () => { cancelled = true }
  }, [settled, workspaceId, item.childSessionId])

  return (
    <>
      <Section label="Objective"><p className="m-0 whitespace-pre-wrap break-words">{item.objective !== '' ? item.objective : '—'}</p></Section>
      {settled ? (
        <Section label={`Result (${item.status})`}>
          {detail?.result !== undefined
            ? <p className="m-0 whitespace-pre-wrap break-words">{detail.result.summary}</p>
            : detail?.error !== undefined
              ? <p className="m-0 text-bad">{detail.error}</p>
              : <p className="m-0 text-fg-muted">Result payload unavailable for this child session.</p>}
          {detail?.result !== undefined && detail.result.fileReferences.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {detail.result.fileReferences.map((file) => <code key={file} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{file}</code>)}
            </div>
          ) : null}
        </Section>
      ) : null}
      {onOpen !== undefined ? (
        <button type="button" className="self-start text-[13px] text-link hover:underline" onClick={() => onOpen(item.childSessionId)}>
          Open conversation →
        </button>
      ) : null}
    </>
  )
}

const AUDIT_ICONS = {
  block: { icon: 'alertTriangle', className: 'text-warn' },
  fail: { icon: 'alertTriangle', className: 'text-bad' },
  allow: { icon: 'check', className: 'text-ok' },
  deny: { icon: 'close', className: 'text-bad' },
  expired: { icon: 'circle', className: 'text-fg-faint' },
} as const

/** A quiet audit line — hooks that blocked or failed, and correlated approval decisions. */
export function AuditLine({ item }: { readonly item: Extract<ViewItem, { kind: 'audit' }> }) {
  const glyph = AUDIT_ICONS[item.icon]
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted" role="note">
      <Icon name={glyph.icon} size={13} className={glyph.className} />
      <span className="min-w-0 break-words">{item.text}</span>
      {item.durationMs !== undefined ? <span className="font-mono text-fg-faint">{fmtDuration(item.durationMs)}</span> : null}
    </div>
  )
}

const REASONS: Readonly<Record<string, string>> = {
  interrupted: 'Interrupted · inspect results before continuing',
  cancelled: 'Stopped by you',
  limit: 'Limit reached',
  stopped: 'Stopped by you',
  rejected: 'Rejected',
  empty: 'No content',
  failed: 'Failed',
}

export function StatusLine({ reason, onRetry, onOpenSettings }: { readonly reason: string; readonly onRetry?: () => void; readonly onOpenSettings?: () => void }) {
  if (!reason.startsWith('Permission decision') && reason.includes(':')) {
    return (
      <div className="flex gap-3 rounded-2xl border border-line bg-bad-soft p-4" role="alert">
        <Icon name="alertTriangle" size={18} className="mt-0.5 text-bad" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <p className="m-0 text-sm"><strong className="font-semibold">Request failed.</strong> <span className="text-fg-muted">Nothing was executed, so retrying is safe.</span></p>
          <div className="flex flex-wrap items-center gap-2">
            {onRetry !== undefined ? <Button variant="outline" size="sm" onClick={onRetry}><Icon name="refresh" size={14} />Retry</Button> : null}
            {onOpenSettings !== undefined ? <Button variant="ghost" size="sm" onClick={onOpenSettings}>Open settings</Button> : null}
          </div>
          <details className="text-xs text-fg-muted">
            <summary>Details</summary>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words">{reason}</pre>
          </details>
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="h-px w-6 bg-line" aria-hidden="true" />
      <span>{REASONS[reason] ?? reason}</span>
    </div>
  )
}

export function JumpToBottom({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Jump to latest"
      title="Jump to latest"
      className="absolute bottom-3 left-1/2 z-10 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-bg text-fg shadow-pop animate-fade-up hover:bg-muted"
    >
      <Icon name="arrowDown" size={16} />
    </button>
  )
}
