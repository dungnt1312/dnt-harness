/**
 * The Trajectory workbench view: three lenses on the durable session log.
 *
 * Duration, Turns and Calls are derived here and nowhere else, from the same
 * events the transcript projects. Nothing is fetched, and a timestamp the log
 * did not stamp is never invented — a span with no end simply has no duration.
 */
import { toolFacts } from '../../lib/tool-facts.ts'
import { isMcpOutcome, type ContextManifestView, type SseEvent, type ToolCall } from '../../lib/types.ts'

/** How a recorded call ended, in the same terms the transcript uses. */
export type CallState = 'running' | 'ok' | 'failed' | 'unknown'

/** Why a turn's bar closed. An open turn has no reason yet. */
export type TurnOutcome = 'open' | 'completed' | 'failed' | 'cancelled' | 'steered' | 'interrupted' | 'rejected' | 'empty' | 'limit'

export interface TrajectorySegment {
  /** Model time, from the request's start to the assembled answer. */
  readonly kind: 'model' | 'tool'
  readonly start: number
  readonly end: number
  /** The call this tool span came from, so a click can open it. */
  readonly callId?: string
}

/** One model request inside a turn: the gap between two tool batches. */
export interface TrajectoryStep {
  readonly index: number
  /** The log's step id, when the message carried one (legacy logs did not). */
  readonly stepId?: string
  readonly start: number
  readonly end: number
  /** What the model answered, when the log kept the text. */
  readonly content: string
  /** Tool calls the answer named. */
  readonly calls: number
}

/** What one physical attempt at a request recorded, exactly as the log kept it. */
export interface TrajectoryAttempt {
  readonly state: 'start' | 'end' | 'uncertain' | 'reconciled'
  readonly attempt: number
  readonly requestId: string
  readonly attemptId: string
  readonly provider?: string
  readonly model?: string
  readonly queuedAt?: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly firstProgressAt?: number
  readonly lastProgressAt?: number
  readonly finish?: string
  readonly reason?: string
  readonly committed?: boolean
}

/** Why a step has no answer of its own. */
export interface StepAbandonment {
  readonly reason: string
  readonly stepId?: string
  readonly at?: number
}

/** Everything one model request said, in the shape the inspector renders. */
export interface StepTrace {
  /** The finalized answer's step id; a `#N` fallback for legacy logs without one. */
  readonly stepId: string
  /** The assembled request's manifest, when the log recorded one. */
  readonly manifest?: ContextManifestView
  /** Non-history context blocks by sha256, fetchable raw through the body route. */
  readonly sections?: NonNullable<ContextManifestView['sections']>
  /** Every physical attempt, in log order. */
  readonly attempts: readonly TrajectoryAttempt[]
  /** A mid-stream failure abandoned an earlier step of this request. */
  readonly abandoned?: StepAbandonment
  /** Answer text streamed before the message finalized (a live step only). */
  readonly partial?: string
  /** Full streamed reasoning, folded across chunks. */
  readonly thinking?: string
}

/** How a turn failed, exactly as the log classified it. */
export interface TrajectoryError {
  readonly kind: string
  readonly message: string
  readonly at?: number
}

export interface TrajectoryCall {
  readonly id: string
  readonly name: string
  /** What the call acted on: a path, a pattern, a command. */
  readonly target: string
  readonly fullTarget: string
  /** One phrase for the recorded output; absent while the call is unfinished. */
  readonly digest?: string
  readonly state: CallState
  /** Set when the call's own event carried one. */
  readonly start?: number
  /** Set when the matching result carried one. */
  readonly end?: number
  readonly turnId?: string
  /**
   * The model request whose answer asked for this call: 1 for the turn's first
   * request. 0 means the call was recorded before any answer in its turn.
   */
  readonly step?: number
  /** The call exactly as recorded, for the expandable detail row. */
  readonly call: ToolCall
  /** The recorded result, when there is one. */
  readonly result?: {
    readonly ok: boolean
    readonly output: string
    readonly recovery?: true
    readonly outcome?: 'success' | 'error' | 'indeterminate' | 'audit_fault'
    readonly invocationId?: string
  }
}

export interface TrajectoryTurn {
  /** The turn's own id, or a synthetic one for a legacy log that omitted it. */
  readonly id: string
  readonly index: number
  readonly outcome: TurnOutcome
  /** The user text that opened the turn; empty when the log has none. */
  readonly prompt: string
  /** The model that served the turn's last answer. */
  readonly model?: string
  readonly start?: number
  /** The turn/end timestamp; absent while the turn is open. */
  readonly end?: number
  readonly calls: number
  readonly failedCalls: number
  /** One entry per model request the turn made. */
  readonly steps: readonly TrajectoryStep[]
  /** One trace per request that produced a message, in log order; absent on legacy logs. */
  readonly traces?: readonly StepTrace[]
  /** How the turn failed, when the log classified it. */
  readonly error?: TrajectoryError
  /** Tool marks, filled in after every call has been paired with its result. */
  segments: TrajectorySegment[]
}

export interface Trajectory {
  readonly turns: readonly TrajectoryTurn[]
  readonly calls: readonly TrajectoryCall[]
  /** Earliest and latest stamped instant across every turn and call. */
  readonly extent: { readonly start: number; readonly end: number } | null
}

const KNOWN_REASONS: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'steered', 'interrupted', 'rejected', 'empty', 'limit'])

function outcomeOf(reason: string | undefined): TurnOutcome {
  if (reason !== undefined && KNOWN_REASONS.has(reason)) return reason as TurnOutcome
  // A turn/end whose reason the log does not name still closed; it did not succeed.
  return reason === undefined ? 'open' : 'failed'
}

/** A call with no result is running only while its turn is. A closed turn makes it unknown. */
function callState(result: SseEvent | undefined, turnOpen: boolean): CallState {
  if (result === undefined) return turnOpen ? 'running' : 'unknown'
  if (result.recovery === true || result.outcome === 'indeterminate' || result.outcome === 'audit_fault') return 'unknown'
  return result.ok === true ? 'ok' : 'failed'
}

interface OpenTurn {
  id: string
  index: number
  start?: number
  prompt: string
  model?: string
  /** When the model request in flight began. */
  stepStart?: number
  /** Answer text of the request in flight. */
  stepContent: string
  /** Calls the answer in flight named. */
  stepCalls: number
  steps: TrajectoryStep[]
  /** The request in flight, under construction. */
  trace?: StepTraceDraft
  /** Requests that produced a message, in log order. */
  traces: StepTraceDraft[]
  error?: TrajectoryError
  segments: TrajectorySegment[]
  calls: number
  failedCalls: number
}

interface StepTraceDraft {
  stepId: string
  manifest?: ContextManifestView
  sections?: NonNullable<ContextManifestView['sections']>
  attempts: TrajectoryAttempt[]
  partial: string
  thinking: string
  abandoned?: StepAbandonment
}

function finalizeTrace(draft: StepTraceDraft, key: number): StepTrace {
  return {
    stepId: draft.stepId !== '' ? draft.stepId : `#${key}`,
    attempts: draft.attempts,
    ...(draft.manifest !== undefined ? { manifest: draft.manifest } : {}),
    ...(draft.sections !== undefined ? { sections: draft.sections } : {}),
    ...(draft.abandoned !== undefined ? { abandoned: draft.abandoned } : {}),
    ...(draft.partial !== '' ? { partial: draft.partial } : {}),
    ...(draft.thinking !== '' ? { thinking: draft.thinking } : {}),
  }
}

function clearStep(turn: OpenTurn): void {
  delete turn.stepStart
}

/** `exactOptionalPropertyTypes` forbids assigning undefined; a fresh request drops the draft instead. */
function clearTrace(turn: OpenTurn): void {
  delete turn.trace
}

interface OpenCall {
  call: ToolCall
  event: SseEvent
  turnId?: string
  step?: number
}

/**
 * Project the log into turns and calls.
 *
 * A `tool/result` whose call was never recorded is dropped: showing it would
 * claim a call that did not happen. A second result for the same call is
 * ignored, matching the transcript, which keeps the first one.
 */
export function projectTrajectory(events: readonly SseEvent[]): Trajectory {
  const turns: TrajectoryTurn[] = []
  const calls: TrajectoryCall[] = []
  const openCalls = new Map<string, OpenCall>()
  const callTurns = new Map<string, OpenTurn>()
  let turn: OpenTurn | null = null
  let synthetic = 0

  const settle = (reason: string | undefined, at: number | undefined, turnId: string | undefined): void => {
    // A turn/end names its turn. One that names some other turn does not close the open one.
    if (turn === null || (turnId !== undefined && turnId !== '' && turn.id !== turnId)) return
    const target = turn
    const traces = target.traces.length > 0
      ? target.traces.map((draft, at_) => finalizeTrace(draft, at_ + 1))
      : undefined
    const error = target.error
    turns.push({
      id: target.id,
      index: target.index,
      outcome: outcomeOf(reason),
      prompt: target.prompt,
      ...(target.model !== undefined ? { model: target.model } : {}),
      ...(target.start !== undefined ? { start: target.start } : {}),
      ...(at !== undefined ? { end: at } : {}),
      calls: target.calls,
      failedCalls: target.failedCalls,
      steps: target.steps,
      ...(traces !== undefined ? { traces } : {}),
      ...(error !== undefined ? { error } : {}),
      segments: target.segments,
    })
    turn = null
  }

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        if (turn !== null) settle(undefined, event.timestamp, turn.id)
        turn = {
          id: event.turnId !== undefined && event.turnId !== '' ? event.turnId : `turn-${synthetic += 1}`,
          index: turns.length + 1,
          ...(event.timestamp !== undefined ? { start: event.timestamp, stepStart: event.timestamp } : {}),
          prompt: '',
          stepContent: '',
          stepCalls: 0,
          steps: [],
          traces: [],
          segments: [],
          calls: 0,
          failedCalls: 0,
        }
        break
      }
      case 'user/message': {
        if (turn !== null && event.content !== undefined && turn.prompt === '') turn.prompt = event.content
        break
      }
      case 'assistant/message': {
        if (turn === null) break
        if (event.controls?.model !== undefined && event.controls.model !== '') turn.model = event.controls.model
        if (event.content !== undefined && event.content !== '') turn.stepContent = event.content
        turn.stepCalls = event.toolCalls?.length ?? 0
        // The answer closes the request. The next one starts once its tools return.
        if (turn.stepStart !== undefined && event.timestamp !== undefined && event.timestamp >= turn.stepStart) {
          turn.steps.push({
            index: turn.steps.length + 1,
            ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
            start: turn.stepStart,
            end: event.timestamp,
            content: turn.stepContent,
            calls: turn.stepCalls,
          })
          // The finalized message supersedes the streamed partial, but the
          // trace keeps the rest: manifest, attempts, thinking, abandonment.
          if (turn.trace !== undefined) {
            turn.trace.partial = ''
            turn.traces.push(turn.trace)
            delete turn.trace
          }
          clearStep(turn)
          turn.stepContent = ''
          turn.stepCalls = 0
        }
        break
      }
      case 'assistant/chunk': {
        if (turn?.trace === undefined) break
        const delta = event.delta ?? ''
        if (delta === '') break
        if (event.thinking === true) turn.trace.thinking = `${turn.trace.thinking}${delta}`
        else turn.trace.partial = `${turn.trace.partial}${delta}`
        break
      }
      case 'step/start': {
        if (turn === null || event.timestamp === undefined) break
        turn.stepStart ??= event.timestamp
        if (turn.trace === undefined) {
          turn.trace = { stepId: event.stepId ?? '', attempts: [], partial: '', thinking: '' }
        } else if (event.stepId !== undefined) {
          // A retry re-asks under a fresh step id; the trace follows the one that answers.
          turn.trace.stepId = event.stepId
        }
        break
      }
      case 'step/abandoned': {
        // The abandoned step's partial text never became history; the next
        // step/start re-asks the whole request. Its evidence rides the trace
        // of the request that finally answered, so nothing is lost.
        if (turn === null) break
        if (turn.trace !== undefined) {
          turn.trace.abandoned = {
            reason: event.reason ?? 'unknown',
            ...(event.stepId !== undefined ? { stepId: event.stepId } : {}),
            ...(event.timestamp !== undefined ? { at: event.timestamp } : {}),
          }
        }
        clearStep(turn)
        break
      }
      case 'context/manifest': {
        if (turn === null || event.manifest === undefined) break
        if (turn.trace === undefined) turn.trace = { stepId: '', attempts: [], partial: '', thinking: '' }
        turn.trace.manifest = event.manifest
        if (event.manifest.sections !== undefined) turn.trace.sections = event.manifest.sections
        break
      }
      case 'model/attempt': {
        if (turn === null || event.fact === undefined) break
        if (turn.trace === undefined) {
          turn.trace = { stepId: event.fact.attribution?.stepId ?? '', attempts: [], partial: '', thinking: '' }
        } else if (turn.trace.stepId === '' && event.fact.attribution?.stepId !== undefined) {
          turn.trace.stepId = event.fact.attribution.stepId
        }
        const fact = event.fact
        turn.trace.attempts.push({
          state: fact.state,
          attempt: fact.attempt,
          requestId: fact.requestId,
          attemptId: fact.attemptId,
          ...(fact.provider !== undefined ? { provider: fact.provider } : {}),
          ...(fact.model !== undefined ? { model: fact.model } : {}),
          ...(fact.queuedAt !== undefined ? { queuedAt: fact.queuedAt } : {}),
          ...(fact.startedAt !== undefined ? { startedAt: fact.startedAt } : {}),
          ...(fact.endedAt !== undefined ? { endedAt: fact.endedAt } : {}),
          ...(fact.firstProgressAt !== undefined ? { firstProgressAt: fact.firstProgressAt } : {}),
          ...(fact.lastProgressAt !== undefined ? { lastProgressAt: fact.lastProgressAt } : {}),
          ...(fact.finish !== undefined ? { finish: fact.finish } : {}),
          ...(fact.reason !== undefined ? { reason: fact.reason } : {}),
          ...(fact.committed ? { committed: true } : {}),
        })
        break
      }
      case 'turn/error': {
        if (turn === null) break
        turn.error = {
          kind: event.kind ?? 'internal',
          message: event.message ?? '',
          ...(event.timestamp !== undefined ? { at: event.timestamp } : {}),
        }
        break
      }
      case 'execution/uncertain':
      case 'execution/reconciled':
        break // Physical settlement does not close a logical turn.
      case 'tool/call': {
        if (event.call === undefined || openCalls.has(event.call.id)) break
        openCalls.set(event.call.id, { call: event.call, ...(turn !== null ? { turnId: turn.id, step: turn.steps.length } : {}), event })
        if (turn !== null) {
          callTurns.set(event.call.id, turn)
          turn.calls += 1
        }
        break
      }
      case 'tool/result': {
        const open = event.callId !== undefined ? openCalls.get(event.callId) : undefined
        if (open === undefined || event.callId === undefined) break
        const owner = callTurns.get(event.callId)
        const state = callState(event, owner !== undefined && turn === owner)
        if (owner !== undefined && state === 'failed') owner.failedCalls += 1
        const facts = toolFacts(open.call, { ok: event.ok === true, output: event.output ?? '' })
        calls.push({
          id: open.call.id,
          name: facts.name,
          target: facts.target,
          fullTarget: facts.fullTarget,
          ...(facts.digest !== undefined && facts.digest !== '' ? { digest: facts.digest } : {}),
          state,
          ...(open.event.timestamp !== undefined ? { start: open.event.timestamp } : {}),
          ...(event.timestamp !== undefined ? { end: event.timestamp } : {}),
          ...(open.turnId !== undefined ? { turnId: open.turnId } : {}),
          ...(open.step !== undefined ? { step: open.step } : {}),
          call: open.call,
          result: {
            ok: event.ok === true,
            output: event.output ?? '',
            ...(event.recovery === true ? { recovery: true as const } : {}),
            ...(isMcpOutcome(event.outcome) ? { outcome: event.outcome } : {}),
            ...(event.invocationId !== undefined ? { invocationId: event.invocationId } : {}),
          },
        })
        openCalls.delete(event.callId)
        break
      }
      case 'turn/end':
        settle(event.reason, event.timestamp, event.turnId)
        break
      default:
        break
    }
  }

  if (turn !== null) {
    const dangling = turn
    // A still-open turn's streaming trace is the inspector's live view: keep it
    // when anything said it exists, drop a stray empty one.
    if (dangling.trace !== undefined && (dangling.trace.attempts.length > 0 || dangling.trace.abandoned !== undefined || dangling.trace.partial !== '' || dangling.trace.manifest !== undefined)) {
      dangling.traces.push(dangling.trace)
      delete dangling.trace
    }
    const traces = dangling.traces.length > 0
      ? dangling.traces.map((draft, at_) => finalizeTrace(draft, at_ + 1))
      : undefined
    turns.push({
      id: dangling.id,
      index: dangling.index,
      outcome: 'open',
      prompt: dangling.prompt,
      ...(dangling.model !== undefined ? { model: dangling.model } : {}),
      ...(dangling.start !== undefined ? { start: dangling.start } : {}),
      calls: dangling.calls,
      failedCalls: dangling.failedCalls,
      steps: dangling.steps,
      ...(traces !== undefined ? { traces } : {}),
      ...(dangling.error !== undefined ? { error: dangling.error } : {}),
      segments: dangling.segments,
    })
  }

  // Whatever is still unmatched ended with no result. Its turn decides the state.
  for (const open of openCalls.values()) {
    const owner = callTurns.get(open.call.id)
    const facts = toolFacts(open.call)
    calls.push({
      id: open.call.id,
      name: facts.name,
      target: facts.target,
      fullTarget: facts.fullTarget,
      state: owner !== undefined && turns.some((item) => item.id === owner.id && item.outcome === 'open') ? 'running' : 'unknown',
      ...(open.event.timestamp !== undefined ? { start: open.event.timestamp } : {}),
      ...(open.turnId !== undefined ? { turnId: open.turnId } : {}),
      ...(open.step !== undefined ? { step: open.step } : {}),
      call: open.call,
    })
  }
  calls.sort((left, right) => left.start === right.start ? 0 : (left.start ?? 0) - (right.start ?? 0))

  // One mark per call, inside the turn it belongs to. Overlapping calls each
  // keep their own span: a turn holds many calls at once, so remembering only
  // the latest one would drop the rest.
  const byTurn = new Map(turns.map((item) => [item.id, item]))
  for (const call of calls) {
    const owner = call.turnId !== undefined ? byTurn.get(call.turnId) : undefined
    if (owner?.start === undefined || call.start === undefined) continue
    const end = call.end ?? (owner.outcome === 'open' ? undefined : owner.end)
    if (end === undefined || end <= call.start) continue
    owner.segments.push({ kind: 'tool', start: call.start, end, callId: call.id })
  }

  const stamps = [
    ...turns.flatMap((item) => [item.start, item.end]),
    ...calls.flatMap((item) => [item.start, item.end]),
  ].filter((stamp): stamp is number => stamp !== undefined)
  const extent = stamps.length === 0 ? null : { start: Math.min(...stamps), end: Math.max(...stamps) }
  return { turns, calls, extent }
}

/** Case-insensitive containment across the fields a row is identified by. */
export function trajectoryMatches(turn: TrajectoryTurn | undefined, call: TrajectoryCall | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  const haystack = [
    turn?.prompt, turn?.model, turn?.outcome, turn !== undefined ? `turn ${turn.index}` : undefined,
    call?.name, call?.target, call?.fullTarget, call?.digest, call?.state,
  ]
  return haystack.some((field) => field?.toLowerCase().includes(needle))
}
