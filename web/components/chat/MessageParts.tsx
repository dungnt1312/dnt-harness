import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import Icon from '../common/Icon.tsx'
import CopyButton from '../common/CopyButton.tsx'
import { Spinner } from '../common/Spinner.tsx'
import { Button } from '../ui/Button.tsx'
import { IconButton } from '../ui/IconButton.tsx'
import { Markdown } from '../../Markdown.tsx'
import { ThinkingPanel } from './ThinkingPanel.tsx'
import { useHoldScroll } from '../../hooks/useStickToBottom.ts'
import { formatBytes, formatTime } from '../../lib/format.ts'
import { toolDisplayName, toolFacts } from '../../lib/tool-facts.ts'
import { errorSummary } from '../../lib/copy.ts'
import { attachmentUrl, waitChild } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import type { AttachmentRef } from '../../lib/composer-draft.ts'
import { parseMessageText } from '../../lib/inline-chips.ts'
import { InlineChip } from '../common/InlineChip.tsx'
import type { ChildRow, ToolCall } from '../../lib/types.ts'
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
    // Actions sit beside the bubble, not under it: the bubble never spans the
    // column, so the room they need is already there — reserving a row below
    // spent vertical space on every message the reader sent.
    <div className="group flex items-end justify-end gap-1" title={item.ts !== undefined ? formatTime(item.ts) : undefined}>
      {!queued && onReuse !== undefined ? (
        <div className={cn('flex shrink-0 items-center gap-0.5 pb-0.5', revealActions)}>
          <CopyButton text={item.content} label="Copy message" className="size-7" />
          <IconButton label="Reuse in composer" className="size-7" onClick={() => onReuse(item.content)}>
            <Icon name="pencil" size={15} />
          </IconButton>
        </div>
      ) : null}
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
                    // Contain, not cover: a preview that crops hides what was sent.
                    className="max-h-40 rounded-xl border border-line object-contain"
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
        // Reserved, not hover-inserted (a hover must not shift the transcript),
        // so the row stays short: it is height every answer pays for.
        <div className={cn('-ml-2 -mb-0.5 flex h-6 items-center gap-1 text-[11px] text-fg-faint', revealActions)}>
          <CopyButton text={turn.text} label="Copy response" className="size-6" />
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

/** The one row geometry every activity line shares, summary header included. */
const rowButtonClass = '-mx-2 flex min-h-8 max-w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-fg-muted transition-colors hover:bg-muted hover:text-fg'

/** Compact disclosure row shared by tool calls and delegations. */
function ActivityRow({ state, title, detail, fullDetail, digest, digestFailed, trailing, children }: {
  readonly state: RowState
  readonly title: ReactNode
  readonly detail?: string
  /** What the shortened detail stands for; shown on hover. */
  readonly fullDetail?: string
  /** One phrase for what came back — the reason a settled row needs no click. */
  readonly digest?: string
  readonly digestFailed?: boolean
  readonly trailing?: ReactNode
  readonly children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const holdScroll = useHoldScroll()
  const bodyId = useId()
  return (
    <div className="min-w-0">
      <button
        type="button"
        // Opening a row must not scroll it away: growth the reader asked for
        // releases the tail instead of following it.
        onClick={() => { if (!expanded) holdScroll(); setExpanded((prev) => !prev) }}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className={rowButtonClass}
      >
        <StateGlyph state={state} />
        {/* The name keeps its width up to half the row, then truncates: a long
            MCP name must not push the outcome off the row, and a long target
            must not squeeze the name down to "Re…". */}
        <span className="max-w-[45%] shrink-0 truncate font-medium text-fg">{title}</span>
        {/* Target and digest both stay on the row at every width — what the
            call touched and what came back are the reason the row exists.
            What gets dropped on a narrow screen is the chips and the duration. */}
        {detail !== undefined && detail !== '' ? <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-faint" title={fullDetail ?? detail}>{detail}</span> : null}
        {digest !== undefined && digest !== '' ? (
          <span className={cn('min-w-0 max-w-[45%] shrink-0 truncate text-xs', digestFailed === true ? 'text-bad' : 'text-fg-muted')} title={digest}>{digest}</span>
        ) : null}
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

/** Runs shorter than this stay open: a summary would hide more than it saves. */
const COLLAPSE_MIN_ROWS = 4
/** Running outranks a settled failure: while work continues, that is the state. */
const STATE_RANK: Readonly<Record<RowState, number>> = { running: 5, failed: 4, unknown: 3, cancelled: 1, ok: 0 }

interface ActivitySummary {
  readonly state: RowState
  readonly live: boolean
  /** Calls and delegations only: reasoning and audit notes are not steps. */
  readonly steps: number
  /** Rows that failed or ended unknown — a collapsed run must still admit them. */
  readonly problems: number
  readonly breakdown: string
  readonly duration: string
}

/** One line for a whole run: worst outcome, what ran, how long it took. */
export function summarizeActivity(items: readonly ViewItem[]): ActivitySummary {
  const counts = new Map<string, number>()
  let state: RowState = 'ok'
  let steps = 0
  let problems = 0
  let elapsed = 0
  const tally = (name: string): void => { counts.set(name, (counts.get(name) ?? 0) + 1) }
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'delegation') steps += 1
    const rowState = item.kind === 'tool' ? toolState(item) : item.kind === 'delegation' ? DELEGATION_STATE[item.status] : null
    if (rowState !== null) {
      if (STATE_RANK[rowState] > STATE_RANK[state]) state = rowState
      if (rowState === 'failed' || rowState === 'unknown') problems += 1
    }
    if (item.kind === 'tool') {
      tally(toolDisplayName(item.call.name))
      if (item.ts !== undefined && item.doneAt !== undefined) elapsed += item.doneAt - item.ts
    }
    if (item.kind === 'delegation') tally('Delegated')
  }
  const breakdown = [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => (count > 1 ? `${name} (${count})` : name))
    .join(' · ')
  return { state, live: state === 'running', steps, problems, breakdown, duration: elapsed > 0 ? fmtDuration(elapsed) : '' }
}

/**
 * A run of tool calls, delegations and audit lines. Four rows or more collapse
 * into one summary line once the work settles, so a turn that read twenty
 * files reads as one step instead of twenty. It stays open while anything is
 * still running or ended badly, and a reader's own toggle wins either way.
 */
export function ActivityBlock({ items, children }: { readonly items: readonly ViewItem[]; readonly children: ReactNode }) {
  const [userPreference, setUserPreference] = useState<boolean | null>(null)
  const holdScroll = useHoldScroll()
  const bodyId = useId()
  const summary = useMemo(() => summarizeActivity(items), [items])
  const open = userPreference ?? (summary.live || summary.problems > 0)

  if (items.length < COLLAPSE_MIN_ROWS) return <div className="flex flex-col gap-0.5">{children}</div>
  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={() => { if (!open) holdScroll(); setUserPreference(!open) }}
        aria-expanded={open}
        aria-controls={bodyId}
        className={rowButtonClass}
      >
        <StateGlyph state={summary.state} />
        <span className="shrink-0 font-medium text-fg">{summary.steps > 0 ? summary.steps : items.length} steps</span>
        <span className="min-w-0 truncate text-xs text-fg-faint" title={summary.breakdown}>{summary.breakdown}</span>
        {summary.problems > 0 ? (
          <span className="shrink-0 rounded-md bg-bad-soft px-1.5 text-xs text-bad">{summary.problems} to inspect</span>
        ) : null}
        {summary.duration !== '' ? <span className="shrink-0 font-mono text-xs text-fg-faint">{summary.duration}</span> : null}
        <Icon name="chevronRight" size={14} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
      </button>
      {/* Indented behind a guide line: an opened run must read as the header's
          contents, not as loose rows that happen to follow it. The padding
          clears the rows' own negative margin. */}
      {open ? <div id={bodyId} className="ml-2 flex flex-col gap-0.5 border-l border-line pl-3">{children}</div> : null}
    </div>
  )
}

/** `copy` offers the section's exact text — arguments and tool output are what a reader reaches for. */
function Section({ label, copy, children }: { readonly label: string; readonly copy?: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex min-h-7 items-center gap-1 text-xs font-medium text-fg-faint">
        <span className="min-w-0 truncate">{label}</span>
        {copy !== undefined && copy !== '' ? <CopyButton text={copy} label={`Copy ${label}`} className="size-7" /> : null}
      </span>
      {children}
    </div>
  )
}

const preClass = 'm-0 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-mono text-xs leading-relaxed text-fg'

/** A recorded call's outcome: unfinished, recovered/ambiguous, or what the result says. */
function toolState(item: Extract<ViewItem, { kind: 'tool' }>): RowState {
  if (item.result === undefined) return 'running'
  if (item.recovered === true || item.outcome === 'indeterminate' || item.outcome === 'audit_fault') return 'unknown'
  return item.result.ok ? 'ok' : 'failed'
}

/** How much output there is to scroll, said before the reader starts scrolling. */
function outputLabel(output: string): string {
  if (output === '') return 'Output'
  const lines = output.replace(/\n$/, '').split('\n').length
  return `Output · ${lines} ${lines === 1 ? 'line' : 'lines'}`
}

/**
 * Argument fields that carry code or prose rather than an identifier. They
 * get their own block: inside a JSON dump their newlines are `\n` escapes,
 * which is exactly the content a reader opened the row to read.
 */
const PROSE_ARGS: Readonly<Record<string, string>> = {
  old: 'Replaced',
  new: 'With',
  content: 'Content',
  command: 'Command',
}

/** The replaced/replacement pair reads as a change when each side is tinted. */
const PROSE_TINT: Readonly<Record<string, string>> = {
  old: 'bg-bad-soft',
  new: 'bg-ok-soft',
}

/**
 * Fields that are file content whatever their length. A short command or
 * pattern stays in the JSON block instead: the row already shows it, and a
 * block of its own would only say it twice.
 */
const ALWAYS_PROSE: ReadonlySet<string> = new Set(['old', 'new', 'content'])

/** A string argument long enough that a JSON dump would hide it. */
function isProse(key: string, value: unknown): value is string {
  if (typeof value !== 'string') return false
  return ALWAYS_PROSE.has(key) || value.includes('\n') || value.length > 120
}

/**
 * Exact arguments, in a readable order: the short ones as one JSON block
 * (whose copy carries the complete payload), then each prose field on its
 * own so it can be read and copied as the text it is.
 */
function ToolArguments({ call }: { readonly call: ToolCall }) {
  const complete = JSON.stringify(call.args, null, 2)
  const entries = Object.entries(call.args)
  const prose = entries.filter(([key, value]) => isProse(key, value)) as [string, string][]
  const rest = Object.fromEntries(entries.filter(([key, value]) => !isProse(key, value)))
  return (
    <>
      <Section label={`Arguments · ${call.id}`} copy={complete}>
        <pre className={preClass}>{JSON.stringify(rest, null, 2)}</pre>
      </Section>
      {prose.map(([key, value]) => (
        <Section key={key} label={PROSE_ARGS[key] ?? key} copy={value}>
          <pre className={cn(preClass, PROSE_TINT[key])}>{value}</pre>
        </Section>
      ))}
    </>
  )
}

/** A tool invocation: one quiet line that expands to exact arguments and recorded output. */
export function ToolCard({ item, openPath }: { readonly item: Extract<ViewItem, { kind: 'tool' }>; readonly openPath?: OpenPathResolver }) {
  const { call, result, ts, doneAt, server, recovered, outcome, invocationId } = item
  const facts = toolFacts(call, result)
  const open = facts.path !== undefined ? openPath?.(facts.path, facts.focus) ?? null : null
  const state = toolState(item)
  const duration = result !== undefined && ts !== undefined && doneAt !== undefined ? fmtDuration(doneAt - ts) : ''
  // Below `sm` the chips and the duration give up their room: the target and
  // the digest are what the row is read for.
  const chipClass = 'hidden shrink-0 rounded-md px-1.5 text-xs sm:block'
  return (
    <ActivityRow
      state={state}
      title={facts.name}
      detail={facts.target}
      fullDetail={facts.fullTarget}
      {...(facts.digest !== undefined ? { digest: facts.digest, digestFailed: facts.digestFailed === true } : {})}
      trailing={(
        <>
          {server !== undefined ? <span className={cn(chipClass, 'bg-muted text-fg-muted')}>{server}</span> : null}
          {recovered === true ? <span className={cn(chipClass, 'bg-warn-soft text-warn')}>recovered</span> : null}
          {outcome === 'indeterminate' ? <span className={cn(chipClass, 'bg-warn-soft text-warn')}>indeterminate</span> : null}
          {outcome === 'audit_fault' ? <span className={cn(chipClass, 'bg-warn-soft text-warn')}>audit fault</span> : null}
          {duration !== '' ? <span className="hidden shrink-0 font-mono text-xs text-fg-faint sm:block">{duration}</span> : null}
        </>
      )}
    >
      <ToolArguments call={call} />
      {open !== null ? <button type="button" className="self-start text-[13px] text-link hover:underline" onClick={open}>Open {facts.fullTarget} in workbench</button> : null}
      {recovered === true && result !== undefined ? (
        <p className="m-0 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
          <Icon name="alertTriangle" size={14} />
          Outcome unknown — the host restarted before this result was recorded.
        </p>
      ) : null}
      {outcome === 'indeterminate' ? (
        <p className="m-0 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
          <Icon name="alertTriangle" size={14} />
          Indeterminate — this call may have run remotely. It is not retried automatically{invocationId !== undefined ? ` (${invocationId})` : ''}.
        </p>
      ) : null}
      {outcome === 'audit_fault' ? (
        <p className="m-0 flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-[13px] text-warn" role="note">
          <Icon name="alertTriangle" size={14} />
          Audit fault — the outcome is known but its evidence was not durably recorded. Further MCP calls stay blocked until that evidence is repaired.
        </p>
      ) : null}
      {result !== undefined
        ? <Section label={outputLabel(result.output)} copy={result.output}><pre className={preClass}>{result.output || '(empty)'}</pre></Section>
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
 * payload (the child's final report, files touched, error) is fetched when
 * expanded.
 */
export function DelegationCard({ item, workspaceId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  return (
    <ActivityRow state={DELEGATION_STATE[item.status]} title={`Delegated to ${item.definition !== '' ? item.definition : 'agent'}`} detail={item.brief}>
      <DelegationDetail item={item} {...(workspaceId !== undefined ? { workspaceId } : {})} {...(onOpen !== undefined ? { onOpen } : {})} />
    </ActivityRow>
  )
}

/** Shown whenever a child's report hit the host cap; the full text is in its log. */
export function TruncatedNote() {
  return <p className="m-0 text-xs text-warn">Report truncated — open the child conversation for the full text.</p>
}

function DelegationDetail({ item, workspaceId, onOpen }: {
  readonly item: Extract<ViewItem, { kind: 'delegation' }>
  readonly workspaceId?: string | null
  readonly onOpen?: (childSessionId: string) => void
}) {
  const [detail, setDetail] = useState<ChildRow | null>(null)
  const [failed, setFailed] = useState(false)
  // Bumped by Try again; the fetch effect keys off it.
  const [attempt, setAttempt] = useState(0)
  const settled = item.status !== 'running'

  // Mounted only while expanded, so the result is fetched on demand.
  useEffect(() => {
    if (!settled || workspaceId === null || workspaceId === undefined) return
    let cancelled = false
    setFailed(false)
    void waitChild(workspaceId, item.childSessionId, 1_000).then(
      (row) => { if (!cancelled) setDetail(row) },
      () => { if (!cancelled) setFailed(true) },
    )
    return () => { cancelled = true }
  }, [settled, workspaceId, item.childSessionId, attempt])

  return (
    <>
      <Section label="Brief"><p className="m-0 whitespace-pre-wrap break-words">{item.brief !== '' ? item.brief : '—'}</p></Section>
      {settled ? (
        <Section label={`Result (${item.status})`} {...(detail?.result !== undefined ? { copy: detail.result.report } : {})}>
          {detail?.result?.truncated === true ? <TruncatedNote /> : null}
          {detail?.result !== undefined
            ? <p className="m-0 whitespace-pre-wrap break-words">{detail.result.report}</p>
            : detail?.error !== undefined
              ? <p className="m-0 text-bad">{detail.error}</p>
              : failed
                ? (
                  <p className="m-0 flex flex-wrap items-center gap-2 text-fg-muted">
                    Could not load the result of this child session.
                    <button type="button" className="text-[13px] text-link hover:underline" onClick={() => setAttempt((count) => count + 1)}>Try again</button>
                  </p>
                )
                : <p className="m-0 text-fg-muted">Result payload unavailable for this child session.</p>}
          {detail?.result !== undefined && detail.result.filesTouched.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-xs text-fg-faint">Files touched:</span>
              {detail.result.filesTouched.map((file) => <code key={file} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{file}</code>)}
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
    // Quiet by design: a failed request is a line to act on, not a red slab —
    // repeated attempts stack, and three of these must still read as a
    // transcript. The icon carries the state; the raw response stays one
    // click away.
    return (
      <div className="flex gap-2.5 rounded-xl border border-line bg-surface px-3 py-2.5" role="alert">
        <Icon name="alertTriangle" size={15} className="mt-0.5 shrink-0 text-bad" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="m-0 text-[13px]">
            <strong className="font-semibold">Request failed.</strong> <span className="text-fg-muted">{errorSummary(reason)}</span>
          </p>
          <p className="m-0 text-xs text-fg-faint">Nothing was executed, so retrying is safe.</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {onRetry !== undefined ? <Button variant="outline" size="sm" onClick={onRetry}><Icon name="refresh" size={14} />Retry</Button> : null}
            {onOpenSettings !== undefined ? <Button variant="ghost" size="sm" onClick={onOpenSettings}>Open settings</Button> : null}
          </div>
          <details className="min-w-0 text-xs text-fg-faint">
            <summary className="min-h-7 leading-7 hover:text-fg-muted">Original response</summary>
            <pre className={cn(preClass, 'mt-1 max-h-48')}>{reason}</pre>
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

/**
 * Back to the tail. `unseen` counts rows that arrived while the reader was
 * away, so the button says whether anything is actually waiting below.
 */
export function JumpToBottom({ unseen = 0, onClick }: { readonly unseen?: number; readonly onClick: () => void }) {
  const label = unseen > 0 ? `Jump to latest · ${unseen} new` : 'Jump to latest'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'absolute bottom-3 left-1/2 z-10 flex min-h-9 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border border-line bg-bg text-fg shadow-pop animate-fade-up hover:bg-muted',
        unseen > 0 ? 'px-3' : 'size-9',
      )}
    >
      <Icon name="arrowDown" size={16} />
      {unseen > 0 ? <span className="text-[13px] font-medium">{unseen} new</span> : null}
    </button>
  )
}
