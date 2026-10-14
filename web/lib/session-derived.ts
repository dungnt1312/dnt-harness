/**
 * Derived values computed once per event arrival, not once per frame.
 *
 * The streaming flush lands every rAF while a model is streaming, and the
 * AppShell re-renders with it. Several surfaces below the shell only read a
 * handful of event types (turn boundaries, process traffic, agent traffic,
 * tool traffic) yet re-scanned the whole log each frame. Each derivation here
 * tracks revisions of the event groups it reads. Reference comparisons also
 * detect replacement snapshots with identical counts. Streaming chunks and
 * unrelated traffic never invalidate these derivations.
 */
import { useMemo, useRef } from 'react'
import type { SseEvent } from './types.ts'
import { isCompactionRunning, isTurnRunning, taskPhase, type TaskPhase } from './project.ts'
import { todosFromEvents, type TodoView } from './todos-view.ts'

const TURN_BOUNDARY_TYPES = ['turn/start', 'turn/end'] as const
const TASK_TYPES = ['tool/call', 'tool/result'] as const
const PROCESS_TYPES = ['process/start', 'process/exit'] as const
const AGENT_TYPES = ['agent/child-spawn', 'agent/child-result'] as const
/** A compaction's progress; a turn start also settles it (a job a crash left dangling is not running). */
const COMPACTION_TYPES = ['compaction/job', 'turn/start'] as const

/**
 * One grouping pass per events reference in this hook, shared by its gates.
 * The legacy *Count field names carry revisions, not absolute event counts.
 */
export interface SessionDerivedGates {
  readonly turnCount: number
  readonly taskCount: number
  readonly processCount: number
  readonly agentCount: number
  readonly recoveryCount: number
  readonly inputRevision: number
  readonly compactionRevision: number
}

export function useSessionDerivedGates(events: readonly SseEvent[]): SessionDerivedGates {
  const previous = useRef<{ groups: readonly (readonly SseEvent[])[]; revisions: number[] }>({ groups: [[], [], [], [], [], [], []], revisions: [0, 0, 0, 0, 0, 0, 0] })
  return useMemo(() => {
    const groups: SseEvent[][] = [[], [], [], [], [], [], []]
    for (const event of events) {
      if ((TURN_BOUNDARY_TYPES as readonly string[]).includes(event.type)) groups[0]!.push(event)
      if ((TASK_TYPES as readonly string[]).includes(event.type)) groups[1]!.push(event)
      if ((PROCESS_TYPES as readonly string[]).includes(event.type)) groups[2]!.push(event)
      if ((AGENT_TYPES as readonly string[]).includes(event.type)) groups[3]!.push(event)
      if (event.type === 'input/queued' || event.type === 'input/settled' || event.type === 'user/message') groups[5]!.push(event)
      if ((COMPACTION_TYPES as readonly string[]).includes(event.type)) groups[6]!.push(event)
      // Recovery is relative to the open turn, so boundaries invalidate it too.
      if (event.recovery === true || (TURN_BOUNDARY_TYPES as readonly string[]).includes(event.type)) groups[4]!.push(event)
    }
    const old = previous.current
    const revisions = groups.map((group, index) => {
      const before = old.groups[index]!
      const same = group.length === before.length && group.every((event, at) => event === before[at])
      return same ? old.revisions[index]! : old.revisions[index]! + 1
    })
    previous.current = { groups, revisions }
    return { turnCount: revisions[0]!, taskCount: revisions[1]!, processCount: revisions[2]!, agentCount: revisions[3]!, recoveryCount: revisions[4]!, inputRevision: revisions[5]!, compactionRevision: revisions[6]! }
  }, [events])
}

/**
 * Gated re-derivation: recompute only when `gate` moved (an event type the
 * derivation reads arrived) or an extra dep changed. The derive closure and
 * the event array it closes over change every render — the stream lands a new
 * array each flushed frame — so both hide behind refs and the memo stays
 * keyed on the gate alone, or it would rerun per frame and gate nothing.
 */
export function useGated<T>(gate: number, derive: () => T, extraDeps: readonly unknown[]): T {
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
  /** A compaction is in progress. It is not a turn, so `running` stays false; the composer offers Stop for it. */
  readonly compacting: boolean
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
  const phase = useGated(gates.turnCount, () => taskPhase(eventsRef.current, pending, sending), [pending, sending, gates.inputRevision])
  const running = useGated(gates.turnCount, () => isTurnRunning(eventsRef.current), [])
  const todos = useGated(gates.taskCount, () => todosFromEvents(eventsRef.current), [])
  const workingSince = useGated(gates.turnCount, () => workingSinceOf(eventsRef.current), [])
  const recovered = useGated(gates.recoveryCount, () => recoveredOf(eventsRef.current), [])
  const compacting = useGated(gates.compactionRevision, () => isCompactionRunning(eventsRef.current), [])
  return { phase, running, todos, workingSince, recovered, compacting }
}

export { EMPTY_TODOS }
