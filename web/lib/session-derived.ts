/**
 * Derived values computed once per event arrival, not once per frame.
 *
 * The streaming flush lands every rAF while a model is streaming, and the
 * AppShell re-renders with it. Several surfaces below the shell only read a
 * handful of event types (turn boundaries, process traffic, agent traffic,
 * tool traffic) yet re-scanned the whole log each frame. Each derivation here
 * keeps the count of the event types it reads and rescans only when one of
 * those counts changed — the same policy Transcript already applies to its
 * process map (processEventCount). Streaming chunks and unrelated traffic
 * never invalidate them.
 */
import { useMemo, useRef } from 'react'
import type { SseEvent } from './types.ts'
import { isTurnRunning, taskPhase, type TaskPhase } from './project.ts'
import { todosFromEvents, type TodoView } from './todos-view.ts'

interface TypeCounts {
  readonly byType: Readonly<Record<string, number>>
  /** Events flagged `recovery === true` (any type): the recovery note's gate. */
  readonly recovery: number
}

/** How many events of each type the array holds, in one pass. */
function typeCounts(events: readonly SseEvent[]): TypeCounts {
  const byType: Record<string, number> = {}
  let recovery = 0
  for (const event of events) {
    const type = event.type
    byType[type] = (byType[type] ?? 0) + 1
    if (event.recovery === true) recovery += 1
  }
  return { byType, recovery }
}

/** Count only the types a derivation reads; a change there forces a rescan. */
function countOf(counts: TypeCounts, types: readonly string[]): number {
  let total = 0
  for (const type of types) total += counts.byType[type] ?? 0
  return total
}

const TURN_BOUNDARY_TYPES = ['turn/start', 'turn/end'] as const
const TASK_TYPES = ['tool/call', 'tool/result'] as const
const PROCESS_TYPES = ['process/start', 'process/exit'] as const
const AGENT_TYPES = ['agent/child-spawn', 'agent/child-result'] as const

/**
 * One typeCounts pass per events reference, shared by every gate below. When
 * TaskStatus, the Environment panel, and the shell each gate on different
 * type groups, the scan happens once per frame instead of once per gate.
 */
export interface SessionDerivedGates {
  readonly turnCount: number
  readonly taskCount: number
  readonly processCount: number
  readonly agentCount: number
  readonly recoveryCount: number
}

export function useSessionDerivedGates(events: readonly SseEvent[]): SessionDerivedGates {
  return useMemo(() => {
    const counts = typeCounts(events)
    return {
      turnCount: countOf(counts, TURN_BOUNDARY_TYPES),
      taskCount: countOf(counts, TASK_TYPES),
      processCount: countOf(counts, PROCESS_TYPES),
      agentCount: countOf(counts, AGENT_TYPES),
      recoveryCount: counts.recovery,
    }
  }, [events])
}

/**
 * Gated re-derivation: recompute only when `gate` moved (an event type the
 * derivation reads arrived) or an extra dep changed. The derive closure and
 * the event array it closes over change every render — the stream lands a new
 * array each flushed frame — so both hide behind refs and the memo stays
 * keyed on the gate alone, or it would rerun per frame and gate nothing.
 */
function useGated<T>(gate: number, derive: () => T, extraDeps: readonly unknown[]): T {
  const deriveRef = useRef(derive)
  deriveRef.current = derive
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the gate IS the dependency; extraDeps are explicit re-run inputs
  return useMemo(() => deriveRef.current(), [gate, ...extraDeps])
}

/**
 * Everything the shell and its panels read from the log each render, with
 * each value gated on its own event types. Values not touched by a frame's
 * batch keep the previous value; memoized children comparing them by
 * reference see no change and skip their own work.
 */
export interface SessionDerived {
  /** TaskStatus line + the shell's `running` bit: one turn/start…turn/end scan. */
  readonly phase: TaskPhase
  readonly running: boolean
  /** The TaskStatus todo strip and the Environment panel's Tasks section. */
  readonly todos: TodoView
  /** The Environment panel's `Working · <elapsed>` marker. */
  readonly workingSince: number | null
  /** The TaskStatus recovery note (a recovery record inside the open turn). */
  readonly recovered: boolean
}

const EMPTY_TODOS: TodoView = { todos: [] }

/** Newest boundary backwards: an open turn's start stamp, else null. */
function workingSinceOf(events: readonly SseEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/end') return null
    if (event.type === 'turn/start') return event.timestamp ?? null
  }
  return null
}

/** A recovery record inside the open turn — the scan TaskStatus used to do per frame. */
function recoveredOf(events: readonly SseEvent[]): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) continue
    if (event.type === 'turn/start') break
    if (event.recovery === true) return true
  }
  return false
}

/**
 * The shell-level derivation for one conversation's stream. `pending` and
 * `sending` shape the phase, so they are explicit re-run inputs alongside the
 * turn-boundary gate; everything else derives from the event array alone and
 * survives unrelated renders unchanged.
 */
export function useSessionDerivedValues(events: readonly SseEvent[], pending: number, sending: boolean): SessionDerived {
  const gates = useSessionDerivedGates(events)
  const eventsRef = useRef(events)
  eventsRef.current = events
  const phase = useGated(gates.turnCount, () => taskPhase(eventsRef.current, pending, sending), [pending, sending])
  const running = useGated(gates.turnCount, () => isTurnRunning(eventsRef.current), [])
  const todos = useGated(gates.taskCount, () => (gates.taskCount === 0 ? EMPTY_TODOS : todosFromEvents(eventsRef.current)), [])
  const workingSince = useGated(gates.turnCount, () => workingSinceOf(eventsRef.current), [])
  const recovered = useGated(gates.recoveryCount, () => recoveredOf(eventsRef.current), [])
  return { phase, running, todos, workingSince, recovered }
}

export { EMPTY_TODOS }
