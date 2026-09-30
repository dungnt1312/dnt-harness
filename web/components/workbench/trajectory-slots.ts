/**
 * The Duration timeline as a sequence, not a clock.
 *
 * A conversation spends most of its wall time idle between turns, while a
 * median tool call takes a few milliseconds. On a time axis every step
 * collapses into a sliver and the lanes pile up. Here each step gets one
 * equal slot in the order it happened: the turn's input, then each model
 * request, then the batch of tool calls that request asked for. Calls that
 * ran in parallel share their batch's slot, so they never paint over each
 * other. Durations stay in the labels and the detail pane.
 */
import type { TrajectoryCall, TrajectoryStep, TrajectoryTurn } from './trajectory.ts'

export type Slot =
  | { readonly kind: 'input'; readonly key: string; readonly turn: TrajectoryTurn }
  | { readonly kind: 'model'; readonly key: string; readonly turn: TrajectoryTurn; readonly step: TrajectoryStep }
  | { readonly kind: 'tools'; readonly key: string; readonly turn: TrajectoryTurn; readonly calls: readonly TrajectoryCall[] }

export function slotsOf(turns: readonly TrajectoryTurn[], calls: readonly TrajectoryCall[]): Slot[] {
  const batches = new Map<string, TrajectoryCall[]>()
  for (const call of calls) {
    if (call.turnId === undefined) continue
    const key = `${call.turnId}:${call.step ?? 0}`
    const batch = batches.get(key)
    if (batch === undefined) batches.set(key, [call])
    else batch.push(call)
  }
  const slots: Slot[] = []
  for (const turn of turns) {
    slots.push({ kind: 'input', key: `turn:${turn.id}`, turn })
    // Calls recorded before the turn's first answer still belong to it.
    const early = batches.get(`${turn.id}:0`)
    if (early !== undefined) slots.push({ kind: 'tools', key: `tools:${turn.id}:0`, turn, calls: early })
    for (const step of turn.steps) {
      slots.push({ kind: 'model', key: `step:${turn.id}:${step.index}`, turn, step })
      const batch = batches.get(`${turn.id}:${step.index}`)
      if (batch !== undefined) slots.push({ kind: 'tools', key: `tools:${turn.id}:${step.index}`, turn, calls: batch })
    }
  }
  return slots
}
