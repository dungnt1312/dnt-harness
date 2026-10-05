/**
 * What one model request actually did, read from the durable log: the context
 * it carried (manifest, raw non-history blocks by hash), the physical attempts
 * it made (retries, stalls, uncertain settlement), and what came back (answer,
 * streamed thinking, tool calls). Tool calls still render the chat's ToolCard;
 * this is the request-level view the transcript never had room for.
 */
import { useState } from 'react'
import Icon from '../common/Icon.tsx'
import { cn } from '../../lib/cn.ts'
import { budgetTone, formatDuration, formatTime, formatTokenCount } from '../../lib/format.ts'
import { fetchContextBody } from '../../lib/api.ts'
import type { ContextManifestView } from '../../lib/types.ts'
import type { TrajectoryAttempt, TrajectoryCall, TrajectoryStep, TrajectoryTurn, StepTrace } from './trajectory.ts'
import { ToolCard } from '../chat/MessageParts.tsx'
import { mcpServerOf } from '../../lib/tool-facts.ts'
import type { ViewItem } from '../../lib/project.ts'

type InspectorTab = 'summary' | 'request' | 'response'

const TABS: readonly { readonly id: InspectorTab; readonly label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
]

const SECTION_KIND: Readonly<Record<string, string>> = {
  system: 'System block',
  compaction: 'Compaction summary',
  'parent-context': 'Parent context',
  skill: 'Skill',
  'skill-catalog': 'Skill catalog',
  memory: 'Memory',
}

const ATTEMPT_STATE: Readonly<Record<string, { readonly label: string; readonly tone: string }>> = {
  start: { label: 'started', tone: 'text-fg-faint' },
  end: { label: 'ended', tone: 'text-fg-muted' },
  uncertain: { label: 'uncertain', tone: 'text-warn' },
  reconciled: { label: 'reconciled', tone: 'text-ok' },
}

/** `name@<full sha>` → `name@<12 chars>`, matching the context marker's labels. */
function shortSource(source: string): string {
  const at = source.lastIndexOf('@')
  return at === -1 ? source : `${source.slice(0, at)}@${source.slice(at + 1, at + 13)}`
}

/** The transcript's tool item for one call, so a response row is the chat's own row. */
function toolItem(call: TrajectoryCall): Extract<ViewItem, { kind: 'tool' }> {
  const server = mcpServerOf(call.call.name)
  return {
    kind: 'tool',
    call: call.call,
    ...(call.start !== undefined ? { ts: call.start } : {}),
    ...(call.end !== undefined ? { doneAt: call.end } : {}),
    ...(call.result !== undefined ? { result: { ok: call.result.ok, output: call.result.output } } : {}),
    ...(call.result?.recovery === true ? { recovered: true } : {}),
    ...(call.result?.outcome !== undefined ? { outcome: call.result.outcome } : {}),
    ...(call.result?.invocationId !== undefined ? { invocationId: call.result.invocationId } : {}),
    ...(server !== undefined ? { server } : {}),
  }
}

function Fact({ term, children }: { readonly term: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 text-xs sm:flex-row sm:gap-3">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-fg-faint sm:w-24 sm:pt-0.5">{term}</span>
      <span className="min-w-0 flex-1 break-words leading-5 text-fg-muted">{children}</span>
    </div>
  )
}

/** One collapsible block of raw text, collapsed to its first lines. */
function RawText({ text, label, collapsedLines = 6 }: {
  readonly text: string
  readonly label: string
  readonly collapsedLines?: number
}) {
  const [open, setOpen] = useState(false)
  const lines = text.split('\n')
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1 flex items-center gap-1 rounded-sm px-1 text-[11px] text-fg-faint transition-colors hover:text-fg-muted"
      >
        <Icon name="chevronRight" size={11} className={cn('transition-transform', open && 'rotate-90')} />
        {label}
        {!open && lines.length > collapsedLines ? <span className="font-mono">· {lines.length} lines</span> : null}
      </button>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words text-fg-muted">{open ? text : lines.slice(0, collapsedLines).join('\n')}</pre>
    </div>
  )
}

type ContextSection = NonNullable<ContextManifestView['sections']>[number]

/** One context section's raw text, fetched by hash the first time it opens. */
function ContextSectionRow({ workspaceId, sessionId, section }: {
  readonly workspaceId?: string | null | undefined
  readonly sessionId?: string | null | undefined
  readonly section: ContextSection
}) {
  const [body, setBody] = useState<{ readonly state: 'idle' } | { readonly state: 'loading' } | { readonly state: 'ok'; readonly text: string } | { readonly state: 'missing' }>({ state: 'idle' })
  const [open, setOpen] = useState(false)

  const toggle = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (body.state !== 'idle') return
    if (workspaceId == null || sessionId == null) {
      setBody({ state: 'missing' })
      return
    }
    setBody({ state: 'loading' })
    void fetchContextBody(workspaceId, sessionId, section.hash)
      .then((result) => setBody(result === null ? { state: 'missing' } : { state: 'ok', text: result.body }))
      .catch(() => setBody({ state: 'missing' }))
  }

  return (
    <div className="min-w-0 rounded-lg border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-hover"
      >
        <Icon name="chevronRight" size={11} className={cn('shrink-0 text-fg-faint transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-medium text-fg-muted">{SECTION_KIND[section.kind] ?? section.kind}</span>
        {section.name !== undefined ? <span className="truncate font-mono text-[11px] text-fg-faint">{section.name}</span> : null}
        <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-faint">{formatTokenCount(section.chars)} chars</span>
      </button>
      {open ? (
        <div className="border-t border-line px-2.5 py-2">
          {body.state === 'loading' || body.state === 'idle' ? <p className="m-0 text-xs text-fg-faint">Loading…</p> : null}
          {body.state === 'missing' ? <p className="m-0 text-xs text-fg-faint">Not recorded (older than body recording, or the content changed since).</p> : null}
          {body.state === 'ok' ? <RawText text={body.text} label={`${formatTokenCount(body.text.length)} chars`} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function ManifestView({ manifest, workspaceId, sessionId }: {
  readonly manifest: ContextManifestView
  readonly workspaceId?: string | null | undefined
  readonly sessionId?: string | null | undefined
}) {
  const limit = manifest.budget.contextLimitTokens ?? manifest.budget.availableTokens
  const reported = manifest.usage?.last?.inputTokens
  const used = reported ?? manifest.budget.usedTokens
  const estimated = reported === undefined
  const percent = limit > 0 ? Math.round((used / limit) * 100) : 0
  const tone = budgetTone(used, limit)
  const breakdown = manifest.breakdown
  const breakdownRows = breakdown === undefined ? [] : [
    { label: 'History', value: breakdown.messages },
    { label: 'Tools', value: breakdown.systemTools },
    { label: 'System', value: breakdown.systemPrompt },
    { label: 'Skills', value: breakdown.skills },
    { label: 'Meta', value: breakdown.metaContext },
    { label: 'MCP', value: breakdown.mcpTools },
  ].filter((row) => row.value > 0)

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Fact term="Window">
        <span className="flex flex-wrap items-baseline gap-x-2 font-mono">
          <span className="font-semibold text-fg">{formatTokenCount(used)}/{formatTokenCount(limit)} tok</span>
          <span className={cn('rounded-full px-1.5 py-px text-[10px] font-semibold', estimated ? 'bg-muted text-fg-faint' : 'bg-ok-soft text-ok')}>
            {estimated ? 'est' : 'reported'}
          </span>
          <span className={cn('text-[11px] font-semibold', tone === 'ok' ? 'text-fg-faint' : tone === 'warn' ? 'text-warn' : 'text-bad')}>{percent}%</span>
        </span>
      </Fact>
      {breakdownRows.length > 0 ? (
        <Fact term="Sources">
          <span className="flex flex-wrap gap-1.5 font-mono">
            {breakdownRows.map((row) => (
              <span key={row.label} className="rounded-md bg-muted px-1.5 py-0.5">
                <span className="text-fg-faint">{row.label}</span> <span className="font-semibold text-fg-muted">{formatTokenCount(row.value)}</span>
              </span>
            ))}
          </span>
        </Fact>
      ) : null}
      <Fact term="History">
        <span className="font-mono">
          {manifest.history.setting}: {manifest.history.includedTurns} included, {manifest.history.omittedTurns} omitted
          {manifest.history.includedSeqRange !== undefined ? ` · seq ${manifest.history.includedSeqRange[0]}–${manifest.history.includedSeqRange[1]}` : ''}
          {manifest.history.checkpointHash !== undefined ? ` · checkpoint ${manifest.history.checkpointHash.slice(0, 12)}` : ''}
        </span>
      </Fact>
      <Fact term="Tools">{manifest.sources.toolNames.length > 0 ? manifest.sources.toolNames.join(', ') : `${manifest.sources.toolSchemas} schemas`}</Fact>
      {manifest.sources.skills.length > 0 ? <Fact term="Skills">{manifest.sources.skills.map(shortSource).join(', ')}</Fact> : null}
      {manifest.sources.memory.length > 0 ? <Fact term="Memory">{manifest.sources.memory.map(shortSource).join(', ')}</Fact> : null}
      {manifest.sources.child !== undefined ? <Fact term="Role">{manifest.sources.child.definition}</Fact> : null}
      {manifest.sources.parentContext !== undefined ? (
        <Fact term="Parent ctx">{formatTokenCount(manifest.sources.parentContext.chars)} chars · {manifest.sources.parentContext.hash.slice(0, 12)}</Fact>
      ) : null}
      {manifest.omissions.length > 0 ? <Fact term="Omitted"><span className="text-warn">{manifest.omissions.join('; ')}</span></Fact> : null}
      {manifest.sections !== undefined && manifest.sections.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-faint">Context blocks (raw text by hash)</span>
          {manifest.sections.map((section) => (
            <ContextSectionRow key={`${section.kind}:${section.name ?? ''}:${section.hash}`} workspaceId={workspaceId} sessionId={sessionId} section={section} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function Attempts({ attempts }: { readonly attempts: readonly TrajectoryAttempt[] }) {
  if (attempts.length === 0) return <p className="m-0 text-xs text-fg-faint">No physical attempt recorded (a legacy log, or the request never reached the provider).</p>
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {attempts.map((attempt, index) => {
        const state = ATTEMPT_STATE[attempt.state] ?? ATTEMPT_STATE.start
        const stalled = attempt.state === 'end' && attempt.finish === undefined
        return (
          <li key={attempt.attemptId} className="flex min-w-0 flex-col gap-1 rounded-lg border border-line px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <span className="font-semibold text-fg">Attempt {attempt.attempt}</span>
              <span className={cn('font-mono text-[11px]', state.tone)}>{state.label}</span>
              {stalled ? <span className="rounded-full bg-warn/15 px-1.5 py-px font-mono text-[10px] font-semibold text-warn">{attempt.reason ?? 'no finish recorded'}</span> : null}
              {attempt.finish !== undefined ? <span className="font-mono text-[11px] text-fg-faint">finish: {attempt.finish}</span> : null}
              {attempt.committed === true ? <span className="font-mono text-[11px] text-fg-faint">committed to history</span> : null}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-fg-faint">
              {attempt.model !== undefined ? <span>{attempt.provider !== undefined ? `${attempt.provider}/${attempt.model}` : attempt.model}</span> : null}
              {attempt.startedAt !== undefined && attempt.endedAt !== undefined ? <span>ran {formatDuration(attempt.startedAt, attempt.endedAt)}</span> : null}
              {attempt.firstProgressAt !== undefined && attempt.startedAt !== undefined ? <span>first byte {formatDuration(attempt.startedAt, attempt.firstProgressAt)}</span> : null}
              <span title={`request ${attempt.requestId}`}>req {attempt.requestId.slice(0, 8)}</span>
            </div>
            {index < attempts.length - 1 && attempt.reason !== undefined ? (
              <p className="m-0 text-[11px] text-warn">retry followed: {attempt.reason}</p>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function ResponseTab({ turn, step, trace, calls }: {
  readonly turn: TrajectoryTurn
  readonly step: TrajectoryStep
  readonly trace: StepTrace | undefined
  readonly calls: readonly TrajectoryCall[]
}) {
  const answer = step.content !== '' ? step.content : trace?.partial
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {trace?.abandoned !== undefined ? (
        <p className="m-0 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs text-warn">
          An earlier step of this request was abandoned mid-stream ({trace.abandoned.reason}
          {trace.abandoned.at !== undefined ? ` · ${formatTime(trace.abandoned.at)}` : ''}); its text never joined history.
        </p>
      ) : null}
      {trace?.thinking !== undefined ? <RawText text={trace.thinking} label="Thinking (streamed; never part of history)" /> : null}
      {answer !== undefined && answer !== '' ? (
        <div className="min-w-0">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-faint">Answer</span>
          <p className="mt-1 mb-0 text-[13px] leading-5 whitespace-pre-wrap break-words text-fg">{answer}</p>
        </div>
      ) : (
        <p className="m-0 text-xs text-fg-faint">No answer text recorded{turn.outcome === 'open' ? ' — the request may still be running' : ''}.</p>
      )}
      {turn.error !== undefined ? (
        <div className="min-w-0 rounded-lg border border-line px-2.5 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-fg-faint">Turn error</span>
          <p className="m-0 mt-0.5 font-mono text-[11px] text-bad">{turn.error.kind}: {turn.error.message}</p>
        </div>
      ) : null}
      {calls.length > 0 ? (
        <ul aria-label="Tool calls" className="m-0 flex list-none flex-col gap-0.5 p-0">
          {calls.map((call) => <li key={call.id}><ToolCard item={toolItem(call)} /></li>)}
        </ul>
      ) : null}
    </div>
  )
}

/** The request/response inspector for one step of one turn. */
export function StepInspector({ turn, step, trace, calls, workspaceId, sessionId, onBack }: {
  readonly turn: TrajectoryTurn
  readonly step: TrajectoryStep
  /** The step's own trace, when the log recorded enough to build one. */
  readonly trace: StepTrace | undefined
  /** Tool calls this step's answer asked for, in log order. */
  readonly calls: readonly TrajectoryCall[]
  readonly workspaceId?: string | null | undefined
  readonly sessionId?: string | null | undefined
  readonly onBack: () => void
}) {
  const [tab, setTab] = useState<InspectorTab>('summary')
  const manifest = trace?.manifest
  const attempts = trace?.attempts ?? []
  const stepLabel = trace?.stepId !== undefined && !trace.stepId.startsWith('#') ? ` · ${trace.stepId}` : ''

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={`Request inspector: turn ${turn.index}, request ${step.index}`}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-[13px] text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <Icon name="chevronRight" size={13} className="rotate-180" />
          Timeline
        </button>
        <span className="font-mono text-xs text-fg-faint">Turn {turn.index} · request {step.index}{stepLabel}</span>
        <div role="group" aria-label="Inspector views" className="ml-auto flex h-8 items-center rounded-lg bg-muted p-0.5">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn('h-7 rounded-md px-2.5 text-[13px]', tab === item.id ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg')}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {tab === 'summary' ? (
          <div className="flex min-w-0 flex-col gap-3 text-xs">
            <Fact term="Request"><span className="font-mono">{turn.index}.{step.index} · {formatDuration(step.start, step.end)}</span></Fact>
            {turn.model !== undefined ? <Fact term="Model">{turn.model}</Fact> : null}
            <Fact term="Tool calls">{calls.length === 0 ? 'none' : `${calls.length} (${calls.filter((call) => call.state === 'failed').length} failed)`}</Fact>
            {attempts.length > 0 ? (
              <Fact term="Attempts">
                {attempts.length}{attempts.some((attempt) => attempt.state === 'uncertain') ? ' · uncertain settlement' : ''}
              </Fact>
            ) : null}
            {manifest !== undefined ? <ManifestView manifest={manifest} workspaceId={workspaceId} sessionId={sessionId} /> : null}
            {attempts.length > 0 ? <div className="flex min-w-0 flex-col gap-1.5"><span className="text-[10px] font-semibold uppercase tracking-widest text-fg-faint">Physical attempts</span><Attempts attempts={attempts} /></div> : null}
          </div>
        ) : tab === 'request' ? (
          manifest !== undefined ? (
            <div className="flex min-w-0 flex-col gap-3">
              <ManifestView manifest={manifest} workspaceId={workspaceId} sessionId={sessionId} />
              <p className="m-0 text-[11px] text-fg-faint">
                History messages are the transcript itself — the user and assistant rows the log keeps in order.
                Non-history blocks load raw above, by their content hash.
              </p>
            </div>
          ) : (
            <p className="m-0 text-xs text-fg-faint">No context manifest recorded for this request (a legacy log, or recorded before manifests existed).</p>
          )
        ) : (
          <ResponseTab turn={turn} step={step} trace={trace} calls={calls} />
        )}
      </div>
    </div>
  )
}
