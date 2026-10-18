/** Opt-in wire projection only; canonical records and default clients stay intact. */
export function replayView<T extends { readonly type: string }>(events: readonly T[], delegationsOnly: boolean): readonly T[] {
  return delegationsOnly ? events.filter((event) => event.type === 'agent/child-spawn' || event.type === 'agent/child-result') : events
}
