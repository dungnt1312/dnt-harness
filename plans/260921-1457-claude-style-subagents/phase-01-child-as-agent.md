---
phase: 1
title: "The child is a real agent"
status: todo
priority: P1
effort: "4h"
dependencies: [0]
---

# Phase 1: The child is a real agent

## Overview

Give a child its own system prompt. The definition's instructions become authoritative
system instructions, a subagent preamble states what the child is and what it owes back,
and the mode's role prose stops mis-framing it. This is the phase the whole plan rests
on: without it, the child has no reason to behave differently from the root.

<!-- Updated: Validation Session 1 - depends on phase 0; capability line states effective exposed schemas subject to policy/approval; stale server refs refreshed -->

## Requirements

Functional:

- A child's system prompt states: it is a subagent named `<definition>`, it works for
  another agent and not for a human, its **final message is the entire deliverable**, the
  user never sees its intermediate work, and it cannot delegate further.
- The definition's `instructions` appear as system instructions, not as user-message text.
- The mode's prose instructions are **replaced** for a child by a one-line capability
  statement listing what the child may do. Rationale: the prose mis-frames (Plan says the
  deliverable is a plan; Full access advertises shell privileges a ceiling may deny) while
  the actual enforcement is the exposure gate.
- The capability statement is honest by construction: the schemas a child request carries
  are **effectively filtered first** — no `Agent`, no MCP tools, nothing outside the
  definition ceiling — and the line says these tools are *exposed*, still subject to host
  policy and approval. Exposure is not a guarantee, and the prompt must not claim it is.
- The instructions are pinned at spawn: editing the `.md` file mid-run does not change a
  running child (same rule as turn-local skill snapshots).
- The context manifest records which definition and which instructions hash the request
  carried, so the inspector can show it.

Non-functional:

- One assembly path: `buildContext` only. No child-specific builder.
- No change to the tool ceiling, the exposure gate, or any permission decision.
- The child's system text must be measured by the existing budget accounting, not bolted
  on after the measurement.

## Architecture

### `AgentScope.childOf` carries the instructions

`src/harness/agent/scope.ts` — add one field:

```ts
readonly childOf?: {
  readonly parentSessionId: SessionId
  readonly parentTurnId: string
  readonly definition: string
  /** The definition body as resolved AT SPAWN — pinned for the child's life. */
  readonly instructions: string
  readonly toolCeiling: readonly string[]
  readonly skills?: readonly string[]
}
```

The executor already holds `request.definition.instructions` where it builds `identity`
(`executor.ts:278-289`), so this is a one-line addition with no extra lookup and pinning
for free.

Recovered children (`executor.ts:154-167`) build a synthetic definition with
`instructions: ''`. That is correct — a recovered child never executes again.

### `buildContext` becomes child-aware

`src/harness/context/builder.ts` — add to `BuildContextInput`:

```ts
/** Present when this request belongs to a CHILD agent (G4). */
readonly child?: {
  readonly definition: string
  readonly instructions: string
}
```

System block composition, for a child, in order:

1. `CHILD_SYSTEM` (new constant) — the subagent preamble.
2. A capability line: `` `You may call: ${schemas.map(s => s.name).join(', ')} (subject
   to host policy and approval).` `` — derived from the already-exposure-filtered
   `input.schemas`, so it is accurate by construction and needs no mode lookup. When
   `schemas` is empty, say so. The child's effective schema list must exclude `Agent`
   (the gate denies delegation at `server.ts:1282-1284` regardless), MCP tools, and
   anything outside `childOf.toolCeiling` (checked at `server.ts:1289-1293`), so the
   line can never advertise a tool the child cannot lawfully attempt.
3. The definition's instructions, as an unwrapped system part, prefixed
   `` `Role — ${child.definition}:` `` — mirroring the existing
   `` `Mode — ${name}:` `` shape at `builder.ts:140-141`.
4. Workspace instructions, wrapped, unchanged — still gated on
   `mode.definition.sources.workspaceInstructions`.

For a root, nothing changes: `BASE_SYSTEM` + the mode block, exactly as today.

Proposed `CHILD_SYSTEM`:

```ts
const CHILD_SYSTEM = [
  'You are a subagent inside mini-dsh, working for another agent — not for a human.',
  'Your FINAL message is the entire deliverable: it is the only thing your caller receives.',
  'Nobody reads your intermediate messages or your tool output, so restate in your final message anything that matters, including the file paths you found.',
  'Do not narrate your progress. Investigate, then answer.',
  'You cannot delegate: there is no subagent available to you.',
].join(' ')
```

The trust question, stated plainly: definition instructions are workspace-owned
configuration files under `<data-dir>/workspaces/<id>/agents/*.md`, the same trust tier
as a workspace-customized mode, which already goes into the system block unwrapped. They
cannot grant a capability — the child ceiling check (`server.ts:1289-1293`) rejects a
tool outside `toolCeiling` on every child tool start regardless of any prompt text.
Phase 1 changes no gate and adds a test proving a definition body cannot obtain a tool
outside its ceiling.

### `renderPacket` stops smuggling the role

`executor.ts:524-536` — drop the `<definition name="…">…</definition>` block. The user
message becomes the brief alone.

### Manifest

Add to `ContextManifest.sources`:

```ts
readonly child?: { readonly definition: string; readonly instructionsHash: string }
```

Populated with the existing `sha256Text` helper.

### Wiring

`src/web/server.ts` — the `agent/context` waterfall around the production `buildContext`
call (`server.ts:1457-1469`) already reads `agentScope.getStore()` into `scope`. Pass:

```ts
...(scope?.childOf !== undefined
  ? { child: { definition: scope.childOf.definition, instructions: scope.childOf.instructions } }
  : {}),
```

## Related Code Files

- Modify: `src/harness/agent/scope.ts` — `childOf.instructions`
- Modify: `src/harness/context/builder.ts` — `BuildContextInput.child`, `CHILD_SYSTEM`,
  system composition, `ContextManifest.sources.child`
- Modify: `src/harness/agents/executor.ts` — pass `instructions` into `identity`; strip
  the definition block from `renderPacket`
- Modify: `src/web/server.ts` — pass `child` into `buildContext`
- Modify: `web/lib/api.ts` — extend `ContextManifestView.sources` with optional child
  metadata
- Modify: `web/components/layout/ContextPanel.tsx` — render the definition name and
  instructions hash in the inspector
- Modify: `web/lib/product-ui.spec.tsx` and manifest browser fixtures — cover the optional
  child source while keeping root manifests compatible
- Modify: `tests/harness/g3-context.spec.ts` — child-aware assembly cases
- Modify: `tests/harness/g4-agents.spec.ts` — the packet no longer carries the definition
- Modify: `docs/capabilities.md`, `docs/harness.md` — the child prompt contract

## Implementation Steps

1. Add `instructions` to `AgentScope.childOf`; populate it in `executor.ts` where
   `identity` is built. Typecheck — the recovered-child path needs `instructions: ''`.
2. Add `BuildContextInput.child` and `CHILD_SYSTEM` to `builder.ts`. Branch the system
   composition on `input.child !== undefined`. Keep the root path byte-identical.
3. Derive the capability line from `input.schemas` **after** the
   `mode.definition.toolExposure.length === 0` reset at `builder.ts:181-186`, so it never
   advertises a tool the request does not carry.
4. Verify the new system text is inside `systemText` before `fixedCost()` measures it
   (`builder.ts:189-208`) — the budget must see it.
5. Add `sources.child` to the manifest; extend `ContextManifestView` and render it in
   `ContextPanel` with UI/browser fixture coverage.
6. Pass `child` from the `buildContext` call site in `server.ts`.
7. Strip the `<definition>` block from `renderPacket`.
8. Update `docs/capabilities.md` (the Agent tool section, lines 119-141) and
   `docs/harness.md` with the child prompt contract.

## Success Criteria

- [x] A child's assembled system prompt contains its definition's instructions.
- [x] A child's assembled system prompt contains the "final message is the deliverable"
      rule and the no-delegation statement.
- [x] A child in **Plan** mode is **not** told "the plan itself is the deliverable"; a
      child in **Full access** is **not** told "shell commands run with host privileges".
- [x] The capability line names exactly the tools in the request's schemas — verified for
      an `explorer` (3 names) and a `worker` with a narrowing `grantTools` — and the
      child's schema list excludes `Agent`, MCP tools, and anything outside the ceiling
      even when the mode exposes them.
- [x] A root's assembled prompt is unchanged: an existing `g3-context` snapshot-style
      assertion still passes untouched.
- [x] A definition whose body instructs the child to call `Bash` is still denied `Bash`
      by the gate when its ceiling excludes it.
- [x] `renderPacket` output contains no `<definition` substring.
- [x] The manifest reports the definition name and instructions hash for a child request,
      `ContextManifestView` accepts it, and `ContextPanel` renders it without changing root
      manifest behavior.
- [x] Editing a workspace definition file while a child runs does not change that child's
      system prompt.
- [x] `npm run typecheck` and `npx vitest tests/harness/g3-context.spec.ts
      tests/harness/g4-agents.spec.ts` pass.

## Risk Assessment

**Definition text in the system block reads as escalation.** It is not — the gate is
independent of the prompt. *Signal it broke:* a test showing a definition body obtaining
a tool outside its ceiling. *Pre-decided response:* that test is written in this phase; if
it ever fails, the gate is the bug, not the prompt placement.

**Dropping mode prose removes a safety sentence.** *Signal:* a child behaving as though
it had authority it lacks. *Response:* the capability line is derived from the actual
exposed schemas, so it is stricter than the prose it replaces. If a child still
misbehaves, add the mode's *restrictions* (not its role framing) to the capability line —
a one-line change, not a redesign.

**Budget regression.** The child system text is new fixed cost that cannot be trimmed.
*Signal:* `ContextBudgetError` on a child that used to fit. *Response:* `CHILD_SYSTEM` is
~5 short sentences (~90 tokens); if a definition body is large enough to matter, that is
the workspace author's own configuration and the error correctly names the cause.

**Root regression.** *Signal:* any existing `g3-context` assertion changing. *Response:*
the root branch must stay literally the current code path; if a diff touches it, revert
and re-branch.
