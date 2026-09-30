/**
 * Opaque cross-boundary ids: branded so a `SessionId` never flows where a
 * `TurnId` is expected, mirroring the upstream `dsh-brand` utility.
 */
declare const brand: unique symbol

/** A `T` that carries a phantom `B` tag, statically distinct from plain `T`. */
export type Branded<T, B extends string> = T & { readonly [brand]: B }

/** Identifies one durable conversation log. */
export type SessionId = Branded<string, 'SessionId'>
/** Identifies one turn inside a session. */
export type TurnId = Branded<string, 'TurnId'>
/** Identifies one model request inside a turn. */
export type StepId = Branded<string, 'StepId'>
/** Identifies one host-owned tool execution, independent of the model call id. */
export type ExecutionId = Branded<string, 'ExecutionId'>
/** Identifies one durably accepted user input, stable across restarts. */
export type InputId = Branded<string, 'InputId'>
/** Identifies one workspace environment; stable across renames. */
export type WorkspaceId = Branded<string, 'WorkspaceId'>
/** Identifies one project bound to a workspace. */
export type ProjectId = Branded<string, 'ProjectId'>

/**
 * Mint an id that is unique across process restarts, not just within one
 * process: durable logs reference these ids, so a fresh process must never
 * mint one an old log already carries. Time-ordered prefix keeps ids roughly
 * sortable; the random tail disambiguates same-millisecond mints.
 */
function durableId(prefix: string): string {
  const time = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `${prefix}-${time}${rand}`
}

/** Mint a fresh session id; unique across restarts. */
export function newSessionId(): SessionId {
  return durableId('session') as SessionId
}

/** Mint a fresh turn id; unique across restarts. */
export function newTurnId(): TurnId {
  return durableId('turn') as TurnId
}

/** Mint a fresh step id; unique across restarts. */
export function newStepId(): StepId {
  return durableId('step') as StepId
}

/** Mint a fresh host-owned tool execution id; unique across restarts. */
export function newExecutionId(): ExecutionId {
  return durableId('exec') as ExecutionId
}

/** Mint a fresh pending-input id; unique across restarts. */
export function newInputId(): InputId {
  return durableId('input') as InputId
}

/** Mint a fresh workspace id; unique across restarts. */
export function newWorkspaceId(): WorkspaceId {
  return durableId('ws') as WorkspaceId
}

/** Mint a fresh project id; unique across restarts. */
export function newProjectId(): ProjectId {
  return durableId('project') as ProjectId
}
