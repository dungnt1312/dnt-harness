/** Delegation facts a root's subagent views read: spawn, resume and result records. */
const DELEGATION_TYPES: ReadonlySet<string> = new Set(['agent/child-spawn', 'agent/child-resume', 'agent/child-result'])

/** Opt-in wire projection only; canonical records and default clients stay intact. */
export function replayView<T extends { readonly type: string }>(events: readonly T[], delegationsOnly: boolean): readonly T[] {
  return delegationsOnly ? events.filter((event) => DELEGATION_TYPES.has(event.type)) : events
}
