import { useMemo, useRef, useState } from 'react'
import Icon from '../common/Icon.tsx'
import { TextInput } from '../ui/TextInput.tsx'
import { cn } from '../../lib/cn.ts'
import { formatDuration } from '../../lib/format.ts'
import type { SseEvent } from '../../lib/types.ts'
import { projectTrajectory, trajectoryMatches, type TrajectoryCall, type TrajectoryStep, type TrajectoryTurn, type TurnOutcome } from './trajectory.ts'
import { slotsOf, type Slot } from './trajectory-slots.ts'
import { ToolCard } from '../chat/MessageParts.tsx'
import { StepInspector } from './StepInspector.tsx'
import { mcpServerOf } from '../../lib/tool-facts.ts'
import type { ViewItem } from '../../lib/project.ts'
import type { OpenPathResolver } from '../../lib/project-paths.ts'

type Lens = 'duration' | 'turns' | 'calls'

const LENSES: readonly { readonly id: Lens; readonly label: string }[] = [
  { id: 'duration', label: 'Duration' },
  { id: 'turns', label: 'Turns' },
  { id: 'calls', label: 'Calls' },
]

const OUTCOME_LABEL: Readonly<Record<TurnOutcome, string>> = {
  open: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  steered: 'Redirected',
  interrupted: 'Interrupted',
  rejected: 'Rejected',
  empty: 'Empty',
  limit: 'Limit',
}

const EMPTY = 'No recorded activity for this conversation yet.'

function durationOf(start: number | undefined, end: number | undefined): string {
  return formatDuration(start, end)
}

const LANES = [
  { kind: 'input', name: 'Input', tone: 'bg-fg-muted' },
  { kind: 'model', name: 'Model', tone: 'bg-fg-faint' },
  { kind: 'tools', name: 'Tools', tone: 'bg-warn' },
] as const

/** Width of one step on the timeline, in pixels. */
const SLOT = 40

function slotLabel(slot: Slot): string {
  if (slot.kind === 'input') return `Turn ${slot.turn.index} input`
  if (slot.kind === 'model') return `Turn ${slot.turn.index}, request ${slot.step.index}`
  return `Turn ${slot.turn.index}, ${slot.calls.length} tool ${slot.calls.length === 1 ? 'call' : 'calls'}`
}

function slotTime(slot: Slot): string {
  if (slot.kind === 'input') return durationOf(slot.turn.start, slot.turn.end)
  if (slot.kind === 'model') return durationOf(slot.step.start, slot.step.end)
  const starts = slot.calls.map((call) => call.start).filter((stamp): stamp is number => stamp !== undefined)
  const ends = slot.calls.map((call) => call.end).filter((stamp): stamp is number => stamp !== undefined)
  return starts.length > 0 && ends.length > 0 ? durationOf(Math.min(...starts), Math.max(...ends)) : ''
}

/**
 * Three lanes, one column per step. Every step sits in exactly one lane, so
 * the lanes alternate like the reference trace: input, model, tools, model…
 */
function Timeline({ slots, selected, onSelect }: {
  readonly slots: readonly Slot[]
  readonly selected: string | null
  readonly onSelect: (key: string) => void
}) {
  return (
    <div className="flex shrink-0 border-b border-line" role="group" aria-label="Conversation timeline">
      <div className="flex shrink-0 flex-col gap-1 pb-2 pl-4 pr-2 pt-6">
        {LANES.map((lane) => <span key={lane.kind} className="h-3 text-right text-[11px] leading-3 text-fg-faint [@media(pointer:coarse)]:h-4 [@media(pointer:coarse)]:leading-4">{lane.name}</span>)}
      </div>
      <div className="min-w-0 flex-1 overflow-x-auto pb-2">
        <div className="flex" style={{ width: slots.length * SLOT }}>
          {slots.map((slot, index) => {
            const opensTurn = slot.kind === 'input'
            const time = slotTime(slot)
            return (
              <div key={slot.key} className={cn('flex shrink-0 flex-col gap-1 pt-1', opensTurn && index > 0 && 'border-l border-line')} style={{ width: SLOT }}>
                <span className="h-4 truncate px-1 font-mono text-[10px] leading-4 text-fg-faint">{opensTurn ? `Turn ${slot.turn.index}` : ''}</span>
                {LANES.map((lane) => (
                  <div key={lane.kind} className="h-3 px-0.5 [@media(pointer:coarse)]:h-4">
                    {lane.kind === slot.kind ? (
                      <button
                        type="button"
                        title={time !== '' ? `${slotLabel(slot)} · ${time}` : slotLabel(slot)}
                        aria-label={slotLabel(slot)}
                        aria-pressed={selected === slot.key}
                        onClick={() => onSelect(slot.key)}
                        className={cn('block h-full w-full rounded-sm', lane.tone, selected === slot.key ? 'outline outline-2 outline-offset-1 outline-fg' : 'hover:opacity-80')}
                      />
                    ) : null}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The transcript's tool item for one call, so the detail row is the chat's own row. */
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

/** Lane tone of each log badge, so a row reads as the mark it came from. */
const BADGE: Readonly<Record<Slot['kind'], { readonly label: string; readonly className: string }>> = {
  input: { label: 'User', className: 'bg-muted text-fg' },
  model: { label: 'Assistant', className: 'bg-muted text-fg-muted' },
  tools: { label: 'Tool', className: 'text-warn' },
}

function Badge({ kind }: { readonly kind: Slot['kind'] }) {
  const badge = BADGE[kind]
  return (
    <span className="flex h-8 w-20 shrink-0 items-center justify-end">
      <span className={cn('rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide', badge.className)}>{badge.label}</span>
    </span>
  )
}

/** One line of prose that opens in place to the full text the log kept. */
function TextRow({ text, empty, meta, onClick }: { readonly text: string; readonly empty: string; readonly meta?: string; readonly onClick?: () => void }) {
  const [open, setOpen] = useState(false)
  const shown = text !== '' ? text : empty
  return (
    <button
      type="button"
      aria-expanded={onClick === undefined ? open : undefined}
      onClick={() => (onClick !== undefined ? onClick() : setOpen((value) => !value))}
      className="-mx-2 flex min-h-8 min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted"
    >
      <span className={cn('min-w-0 flex-1', open && onClick === undefined ? 'whitespace-pre-wrap break-words' : 'truncate', text === '' && 'text-fg-faint')}>{shown}</span>
      {meta !== undefined && meta !== '' ? <span className="shrink-0 font-mono text-xs text-fg-faint">{meta}</span> : null}
    </button>
  )
}

function turnMeta(turn: TrajectoryTurn): string {
  return [OUTCOME_LABEL[turn.outcome], turn.model, durationOf(turn.start, turn.end)].filter((part) => part !== undefined && part !== '').join(' · ')
}

/** One-phrase warning a model row should carry: why this request deserves a look. */
function stepHint(turn: TrajectoryTurn, step: TrajectoryStep): string {
  const trace = turn.traces?.find((candidate) => candidate.stepId === step.stepId)
  if (trace === undefined) return ''
  const parts = [
    trace.abandoned !== undefined ? 'retried' : undefined,
    trace.attempts.some((attempt) => attempt.state === 'uncertain') ? 'uncertain' : undefined,
    trace.attempts.length > 1 ? `${trace.attempts.length} attempts` : undefined,
  ].filter((part) => part !== undefined)
  return parts.length > 0 ? ` · ${parts.join(', ')}` : ''
}

/**
 * Every step of the conversation, in timeline order, readable at once:
 * the prompt, each answer, each tool call. A click on a timeline mark
 * brings its rows into view; a click on a model row opens the request
 * inspector; a click on a row opens what the log recorded.
 */
function StepLog({ slots, selected, openPath, rowRefs, onOpenStep }: {
  readonly slots: readonly Slot[]
  readonly selected: string | null
  readonly openPath?: OpenPathResolver
  readonly rowRefs: Map<string, HTMLElement>
  readonly onOpenStep: (turn: TrajectoryTurn, step: TrajectoryStep) => void
}) {
  return (
    <ol aria-label="Steps" className="m-0 flex list-none flex-col p-0">
      {slots.map((slot) => {
        const current = selected === slot.key
        return (
          <li
            key={slot.key}
            ref={(node) => { if (node !== null) rowRefs.set(slot.key, node); else rowRefs.delete(slot.key) }}
            aria-current={current ? 'step' : undefined}
            className={cn('scroll-mt-2 border-b border-line px-2 py-0.5', current && 'bg-hover')}
          >
            {slot.kind === 'input' ? (
              <div className="flex items-start gap-3">
                <Badge kind="input" />
                <TextRow text={slot.turn.prompt} empty="—" meta={`Turn ${slot.turn.index} · ${turnMeta(slot.turn)}`} />
              </div>
            ) : slot.kind === 'model' ? (
              <div className="flex items-start gap-3">
                <Badge kind="model" />
                <TextRow
                  text={slot.step.content}
                  empty="(tool call only)"
                  meta={`${durationOf(slot.step.start, slot.step.end)}${stepHint(slot.turn, slot.step)}`}
                  onClick={() => onOpenStep(slot.turn, slot.step)}
                />
              </div>
            ) : (
              <ul aria-label={slotLabel(slot)} className="m-0 flex list-none flex-col p-0">
                {slot.calls.map((call) => (
                  <li key={call.id} className="flex items-start gap-3">
                    <Badge kind="tools" />
                    <div className="min-w-0 flex-1"><ToolCard item={toolItem(call)} {...(openPath !== undefined ? { openPath } : {})} /></div>
                  </li>
                ))}
              </ul>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function Duration({ turns, calls, selected, onSelect, openPath, onOpenStep }: {
  readonly turns: readonly TrajectoryTurn[]
  readonly calls: readonly TrajectoryCall[]
  readonly selected: string | null
  readonly onSelect: (key: string) => void
  readonly openPath?: OpenPathResolver
  readonly onOpenStep: (turn: TrajectoryTurn, step: TrajectoryStep) => void
}) {
  const slots = useMemo(() => slotsOf(turns, calls), [turns, calls])
  const rowRefs = useRef(new Map<string, HTMLElement>()).current
  const select = (key: string) => {
    onSelect(key)
    rowRefs.get(key)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Timeline slots={slots} selected={selected} onSelect={select} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <StepLog slots={slots} selected={selected} rowRefs={rowRefs} onOpenStep={onOpenStep} {...(openPath !== undefined ? { openPath } : {})} />
      </div>
    </div>
  )
}

function TurnRow({ turn }: { readonly turn: TrajectoryTurn }) {
  const duration = durationOf(turn.start, turn.end)
  return (
    <li className="flex items-baseline gap-3 border-b border-line px-1 py-2 last:border-b-0">
      <span className="w-14 shrink-0 font-mono text-xs text-fg-faint">Turn {turn.index}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]" title={turn.prompt}>{turn.prompt !== '' ? turn.prompt : '—'}</span>
      <span className="hidden shrink-0 text-xs text-fg-muted sm:block">{OUTCOME_LABEL[turn.outcome]}</span>
      {turn.model !== undefined ? <span className="hidden shrink-0 font-mono text-xs text-fg-faint md:block">{turn.model}</span> : null}
      <span className="w-16 shrink-0 text-right font-mono text-xs text-fg-faint">{turn.calls} {turn.calls === 1 ? 'call' : 'calls'}</span>
      <span className="w-14 shrink-0 text-right font-mono text-xs text-fg-faint">{duration}</span>
    </li>
  )
}

/**
 * Duration, Turns and Calls for the open conversation, projected from the
 * events the workbench already holds. Search narrows Turns and Calls; it
 * never adds a row the log did not record. Opening a model step swaps the
 * Duration view for the request inspector — the whole request, response and
 * physical attempt record of that one call to the model.
 */
export function TrajectoryPanel({ events, openPath, workspaceId = null, sessionId = null }: {
  readonly events: readonly SseEvent[]
  readonly openPath?: OpenPathResolver
  readonly workspaceId?: string | null
  readonly sessionId?: string | null
}) {
  const trajectory = useMemo(() => projectTrajectory(events), [events])
  const [lens, setLens] = useState<Lens>('duration')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [openStep, setOpenStep] = useState<{ readonly turn: TrajectoryTurn; readonly step: TrajectoryStep } | null>(null)

  const turns = useMemo(
    () => trajectory.turns.filter((turn) => trajectoryMatches(turn, undefined, query)),
    [trajectory, query],
  )
  const calls = useMemo(
    () => trajectory.calls.filter((call) => trajectoryMatches(trajectory.turns.find((turn) => turn.id === call.turnId), call, query)),
    [trajectory, query],
  )
  const quiet = trajectory.turns.length === 0 && trajectory.calls.length === 0

  const openInspector = (turn: TrajectoryTurn, step: TrajectoryStep): void => {
    setSelected(`step:${turn.id}:${step.index}`)
    setOpenStep({ turn, step })
  }
  const stepCalls = useMemo(
    () => openStep === null ? [] : calls.filter((call) => call.turnId === openStep.turn.id && call.step === openStep.step.index),
    [calls, openStep],
  )
  const stepTrace = useMemo(() => {
    if (openStep === null || openStep.turn.traces === undefined) return undefined
    const traces = openStep.turn.traces
    return traces.find((candidate) => candidate.stepId === openStep.step.stepId)
      ?? (openStep.step.index <= traces.length ? traces[openStep.step.index - 1] : undefined)
  }, [openStep])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {openStep !== null ? (
        <StepInspector
          turn={openStep.turn}
          step={openStep.step}
          trace={stepTrace}
          calls={stepCalls}
          workspaceId={workspaceId}
          sessionId={sessionId}
          onBack={() => setOpenStep(null)}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
            <div role="group" aria-label="Trajectory view" className="flex h-8 items-center rounded-lg bg-muted p-0.5">
              {LENSES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={lens === item.id}
                  onClick={() => setLens(item.id)}
                  className={cn('h-7 rounded-md px-2.5 text-[13px]', lens === item.id ? 'bg-surface text-fg' : 'text-fg-muted hover:text-fg')}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex min-w-0 basis-48 items-center">
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search…"
                aria-label="Search trajectory"
                leading={<Icon name="search" size={14} />}
              />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-3 px-4 pt-2 text-[11px] text-fg-faint">
            <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-fg-muted" aria-hidden="true" />Input</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-fg-faint" aria-hidden="true" />Model</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-3 rounded-sm bg-warn" aria-hidden="true" />Tools</span>
            <span className="ml-auto font-mono">{trajectory.turns.length} {trajectory.turns.length === 1 ? 'turn' : 'turns'} · {trajectory.calls.length} {trajectory.calls.length === 1 ? 'call' : 'calls'}</span>
          </div>
          {quiet ? (
            <p className="m-0 px-4 py-6 text-center text-sm text-fg-faint">{EMPTY}</p>
          ) : lens === 'duration' ? (
            <Duration turns={turns} calls={calls} selected={selected} onSelect={setSelected} onOpenStep={openInspector} {...(openPath !== undefined ? { openPath } : {})} />
          ) : lens === 'turns' ? (
            <ol aria-label="Turns" className="relative m-0 flex min-h-0 flex-1 list-none flex-col overflow-y-auto px-3 py-1">
              {turns.map((turn) => <TurnRow key={turn.id} turn={turn} />)}
            </ol>
          ) : (
            // `relative` makes this scroller the containing block of every row's
            // sr-only (position:absolute) status text; without it those spans
            // resolve against the viewport and stretch the whole app's scroll.
            // min-h-0 + flex-1 bound the list to the panel. Rows are the chat's
            // own ToolCard, as in the Duration detail.
            <div className="relative min-h-0 flex-1 overflow-y-auto px-4 py-2">
              <ol aria-label="Calls" className="m-0 flex list-none flex-col gap-0.5 p-0">
                {calls.map((call) => <li key={call.id}><ToolCard item={toolItem(call)} {...(openPath !== undefined ? { openPath } : {})} /></li>)}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  )
}
