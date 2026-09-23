# Phase 2 — The `Agent` tool + one shared delegation module

## Goal

The root model delegates by itself, in parallel, choosing the child's model, and can see
the role and model catalogs without guessing.

## Files

- **new** `src/web/agent-delegation.ts` — shared spawn/list/wait/cancel helpers, model
  resolution, the tool factory
- `src/web/server.ts` — register the tool; deny `Agent` for children; HTTP routes call the
  shared helpers
- `src/harness/modes/bundled.ts` — exposure + permission defaults
- `tests/harness/g4-agents.spec.ts`, `tests/web/server-g4.spec.ts`

## The contract

```jsonc
{
  "action": "spawn" | "wait" | "list" | "cancel" | "catalog",
  // spawn
  "definition": "explorer",
  "objective": "…",                       // required for spawn
  "constraints": [], "references": [],
  "requiredResult": "bounded summary with file references",
  "grantTools": ["Read", "Grep"],          // narrows the definition; never widens
  "model": "provider:model",               // optional; overrides the role's own model
  // wait / cancel
  "childIds": ["…"],                       // wait: default = every child of this turn
  "timeoutMs": 30000                       // wait only; capped at 120 000
}
```

Results are compact JSON text:

- `spawn` → `{childSessionId, definition, model:"provider:model", status:"running", active:"2/3", droppedGrants:[…]}`
- `wait` → handles with the executor digest (≤4 000 chars + ≤20 file refs); a child still
  running comes back `running` with `hint:"call wait again"`; a child with an open
  `approval/request` comes back `awaitingApproval:true`
- `list` → every child of this root · `cancel` → handles after cancellation
- `catalog` → `{roles:[{name, description, model?, tools}], models:["provider:model", …]}`

Failures are `ok:false` with actionable text: capacity (`3 active` / `8 per turn`),
unknown role **plus the catalog**, unknown model **plus the available ids**, depth.

## Description (what the model reads)

States: one level only; children run concurrently up to 3; **wait before finishing the
turn or running children are cancelled**; `grantTools` only narrows; and the live catalog
— role names with one-line descriptions, plus up to 30 `provider:model` ids, then
`+N more — use action:"catalog"`. Built through `ToolDefinition.schema()`, which is
synchronous and therefore reads the in-memory provider list and a cached role listing
refreshed on definition writes.

## Steps

1. Module exports `createDelegation(deps)` returning `{ spawn, list, wait, cancel, catalog, resolveChildModel, tool }`.
   All authority comes from `agentScope` — never from tool arguments.
2. `spawn` resolves: scope → workspace + parent session; `parentTurnId` = the last
   `turn/start` in the parent log (`server.ts:1954` does the same); definition via
   `AgentDefinitionService.resolve`; model via `resolveChildModel` (phase 1).
3. Register the tool next to `Skill` (`server.ts:835`), `requiresRoot: false`.
4. In the prepend gate (`server.ts:1087`) deny `Agent` when `scope.childOf !== undefined`,
   reason `one-level delegation: a child agent cannot delegate`.
5. Rewrite the HTTP handlers at `server.ts:1930-2045` to call the shared helpers.
6. `bundled.ts`: `Agent` into `KNOWN_MODE_TOOLS`; `toolExposure` for `plan`,
   `ask-before-changes`, `edit-automatically`, `full-access`; `permissionDefaults`
   `Agent: 'ask'` for ask-before-changes, `'allow'` for the other three. Chat unchanged.

## Validation

- `npx vitest run tests/harness/g4-agents.spec.ts tests/web/server-g4.spec.ts tests/harness/modes.spec.ts`
- New cases: tool spawns a child and `wait` returns its digest; two spawns run
  concurrently; a child calling `Agent` is denied; Chat denies `Agent`; capacity failure
  text; unknown role lists the catalog; `model` argument beats the definition's;
  `catalog` lists roles and `provider:model` ids; Stop during `wait` returns at once.
- `npm run typecheck`

## Risk / rollback

The tool is additive; removing it from `toolExposure` disables delegation without
touching the runtime. The HTTP refactor is the only behaviour-preserving edit that could
regress the panel — `tests/web/server-g4.spec.ts` covers those routes today and must pass
unmodified.
