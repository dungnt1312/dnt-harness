# Phase 1 — Child model resolution + a waitable executor

## Goal

A child runs on an explicitly resolved `(provider, model, thinkingLevel)` triple, stamped
into its own durable log. `wait` becomes cancellable and can wait on several children.

## Files

- `src/harness/agents/executor.ts` — `SpawnRequest.model`, stamp `session/model`, `wait()` rework
- `src/harness/agent/scope.ts` — drop `childOf.modelOverride`
- `src/web/server.ts` — resolve the triple at spawn; drop the two `modelOverride` reads
- `src/harness/session/events.ts` — no change needed (`session/model` already exists)
- `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`

## Steps

1. `SpawnRequest` gains
   `readonly model?: { readonly provider: string; readonly model: string; readonly thinkingLevel?: string | null }`.
   The web host resolves it; the executor does not know about providers.
2. In `spawn()`, right beside the existing `session/child-meta` append and **inside the
   same durability barrier**, append
   `{ type: 'session/model', provider, model, thinkingLevel }` when `request.model` is
   set. Order: `session/model` first, then `child-meta` — a recovered log then shows the
   model before the task.
3. Delete `modelOverride` from `AgentScope.childOf` and from the identity built in
   `spawn()`. Delete the three reads in `server.ts:1191,1333,1334` — `resolveEffectiveModel`
   now finds the pair in the child's own log through `sessionModelOf`, including the
   provider, which the old override could not carry.
4. `resolveEffectiveModel(session, workspaceId)` loses its third parameter.
5. `wait()` becomes
   `wait(workspaceId, childSessionIds: readonly SessionId[], options?: { timeoutMs?: number; signal?: AbortSignal })`
   and resolves when **every** named child has settled, the timeout fires, or the signal
   aborts — whichever comes first. Returns the handles either way (still-running children
   come back as `running`). Empty id list ⇒ every child of the calling root.
   The HTTP route keeps its single-id behaviour by passing one id.
6. Racing the signal must not leak: remove the `setTimeout` on settle and the abort
   listener on return.

## Web-side resolution helper (used by phase 2 and the HTTP route)

`resolveChildModel(parentSession, workspaceId, requested?: string, definitionModel?: string)`:

1. pick the first defined of `requested`, `definitionModel`, else the parent's
   `resolveEffectiveModel(...)` pair → return it unchanged;
2. `provider:model` splits on the first colon; a bare string resolves to the parent's
   provider when that provider advertises it, else the unique usable provider that does
   (`kernel.ctx.llm.providerModels`), else throw naming the candidates;
3. `validateProviderModel(provider, model)` — its error text already lists what is available;
4. carry the parent's `thinkingLevel`.

Keep it in the phase-2 module (`src/web/agent-delegation.ts`) and import it into
`server.ts`; phase 1 may land it there directly.

## Validation

- `npx vitest run tests/harness/g4-agents.spec.ts tests/web/server-g4.spec.ts`
- New cases: child with no model inherits the **parent session's** pair (not the global
  default); a definition model on another provider runs on that provider; an unknown
  model fails at spawn with the available list; `wait` on two children returns both;
  an aborted signal returns immediately.
- `npm run typecheck`

## Risk / rollback

`session/model` in a child log is additive and optional — old child logs replay
unchanged. Rollback is reverting the commit; no storage migration exists to undo.
