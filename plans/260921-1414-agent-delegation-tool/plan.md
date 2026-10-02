---
status: done
branch: feat/workbench-terminal
supersededBy: [260921-1457-claude-style-subagents]
---

> **Partly superseded.** `plans/260921-1457-claude-style-subagents/` replaces this plan's
> `TaskPacket` rendering and result digest — see
> `plans/reports/research-260921-1451-claude-style-subagents.md` for why. The lifecycle,
> per-child model resolution and UI work below stand as delivered.

# Model-driven delegation — the `Agent` tool + per-child model selection

## Outcome

The root model can delegate by itself: spawn bounded children in parallel, wait for their
digests, list and cancel them — through one built-in tool named `Agent`. Every child runs
on an explicitly resolved `(provider, model)` pair that comes from the spawn call, the
role definition, or the parent session, in that order. The main agent can see exactly
which models exist before choosing one.

Research behind this: `plans/reports/research-260921-1403-model-driven-delegation.md`.

## Decisions (user-accepted 2026-09-21)

| Decision | Choice |
|---|---|
| Tool name | `Agent` — already reserved in `RESERVED_TOOL_NAMES` and the G4/G5 specs |
| Shape | Async lifecycle: `action: spawn \| wait \| list \| cancel \| catalog` (Codex `spawn_agent` + `wait_agent(targets[])`) |
| Parallelism | From async spawn, not from parallel tool batches — the step loop stays sequential |
| Permission | `ask` in *Ask before changes*, `allow` in Plan / Edit automatically / Full access |
| Plan mode | Exposed; the mode gate already makes any child there read-only |
| Child model | `provider:model`, chosen per role in Settings **and** overridable by the main agent at spawn |
| Model catalog | Live in the tool description (capped), full list via `action: 'catalog'` |

## Two defects this plan fixes (found while designing the extension)

1. **A child ignores its parent session's model pin.** A fresh child log carries no
   `session/model` event, so `resolveEffectiveModel` takes the `hasEvent === false`
   branch (`src/web/server.ts:519-530`) and falls back to the **global** defaults — not
   the conversation's own choice.
2. **A role model on another provider cannot run.** `childOf.modelOverride` replaces only
   the model and keeps the parent's provider (`server.ts:525`), so a definition naming a
   model that lives on a different provider dies at
   `validateProviderModel` → `unknown model 'x' for provider 'y'`.

Both disappear with one mechanism: **resolve the child's `(provider, model, thinkingLevel)`
at spawn and stamp it into the child's own log as `session/model`** — the existing
ownership boundary — instead of carrying a half-override on the scope.
`AgentScope.childOf.modelOverride` is then dead and is removed.

## Model reference format

`provider:model`, the encoding the web client already uses
(`web/lib/providers.ts:11-19`, first colon is the boundary). A bare `model` is accepted
too and resolves against usable providers: the parent's provider first, otherwise the
single provider advertising it; ambiguous ⇒ error naming the candidates. This keeps
Claude-dialect `model: sonnet` frontmatter working.

Precedence: **spawn argument > definition frontmatter > parent session's effective pair.**
Validation happens at spawn (`validateProviderModel`), so a bad name fails as a readable
tool result instead of at the child's first request.

## Constraints / non-goals

- One level of delegation only; a child never sees `Agent` (three layers: definition
  ceiling, the exposure gate's explicit deny, `SpawnError('depth')`).
- No steering, no `send_message`, no mid-turn follow-up, no second `result` tool — the
  G4 spec forbids them and `wait` already returns persisted digests.
- Parallel tool batches (Claude Code's `partitionToolCalls`) are **out of scope**: that
  rewrites the durability/stop/approval invariants of `agent.ts:405-455` and needs its
  own plan.
- The HTTP routes and the Workbench panel keep working unchanged; they must end up
  calling the same helpers as the tool, not a second implementation.
- Existing `tests/harness/**` and `tests/web/**` stay green.

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | [Child model resolution + waitable executor](phase-01-child-model.md) | done | — |
| 2 | [The `Agent` tool + shared delegation module](phase-02-agent-tool.md) | done | 1 |
| 3 | [UI: role model picker, live child list](phase-03-ui.md) | done | 2 |
| 4 | [Docs, full suite, deploy](phase-04-docs-hardening.md) | done | 3 |

Each phase must typecheck and keep its targeted suite green before the next starts.

## Outcome notes (2026-09-21)

- Delivered as planned. `npm test` 708/708, `npm run typecheck`, `npm run build:web`,
  `npm run test:browser` 68/68 all green; pm2 `dnt-harness` restarted and verified live:
  a child spawned with `model: "viber:claude-sonnet-5"` reported exactly that pair and
  kept it through cancellation, on a host whose default provider is a different one.
- **Behaviour changes a maintainer could mistake for regressions.** A child now
  inherits the *parent conversation's* pair instead of the global default, and a role
  model may live on another provider. Both follow from stamping `session/model` into the
  child's log at spawn; `AgentScope.childOf.modelOverride` is gone because that half-
  override (model without provider) was what made the cross-provider case impossible.
- `ChildExecutor.wait()` is now batch-shaped — `(workspaceId, ids[], {timeoutMs, signal})`
  returning handles — so one `wait` follows several children and a root Stop returns at
  once instead of sitting out the timeout. The single-child HTTP route passes one id.
- The `Agent` tool's description carries the live role and `provider:model` catalogs,
  built synchronously from the in-memory provider list plus a 5 s role cache; the full
  list stays available through `action: "catalog"`. The main agent therefore names ids
  the host can actually serve rather than guessing.
- Deliberately NOT done, per the research: Claude Code's parallel tool batches
  (`partitionToolCalls`) and Codex V2's mailbox steering. Both remain future work with
  their own plans — see `plans/reports/research-260921-1403-model-driven-delegation.md`.

## Risks

| Risk | Mitigation |
|---|---|
| Child blocks on an approval the user never sees (worker + *Ask before changes*) | `wait` reports "awaiting approval" when a child has an open `approval/request`; panel badges it; description steers Plan/read-only work to `explorer` |
| `MAX_ACTIVE_CHILDREN = 3` is global, not per root | Capacity failures return the explicit counter text; the panel shows `active n/3` |
| Root Stop hangs until `wait` times out | `wait` races `exec.signal` (phase 1) |
| Catalog in the tool description inflates every request | Cap at 30 pairs, then a pointer to `action: 'catalog'` |
| Unwaited children are cancelled at turn end | Stated in the tool description and echoed in the `spawn` result |
| Cost multiplies by the number of children | `spawn` echoes the resolved `provider:model`; the panel shows it per child |

## Acceptance

- The root model spawns two children in one turn, they run **concurrently**, and one
  `wait` returns both digests.
- `Agent({action:'spawn', model:'<provider>:<some-model>'})` runs that child on exactly
  that pair; the same works from a role's `model:` frontmatter set in Settings.
- With no model given, the child inherits the **parent session's** pair, not the global
  default.
- A model that does not exist fails as a tool result listing the available ids; the same
  for an unknown role.
- A child calling `Agent` is denied; Chat exposes no `Agent`; a child in Plan cannot write.
- Stop during `wait` returns immediately and cancels the children.
- The Workbench panel shows children the model spawned, with their model, without a reload.
- `npm test`, `npm run typecheck`, `npm run build:web` exit 0; pm2 `dnt-harness` restarted and
  verified live.
