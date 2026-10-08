# Global subagent model aliases

Date: 2026-10-08
Status: Design agreed in conversation; written-spec review pending.

## Intent and accepted scope

Let the operator switch subagent model settings centrally without editing every role or spawn instruction. A global, operator-named alias contains a provider, model and thinking level. Roles can select a default alias, and the parent agent can override it for an individual spawn.

Accepted decisions:

- Alias storage is global across workspaces and projects.
- The operator enters the alias name; no predefined aliases or inferred mappings.
- Each alias configures provider, model and thinking level.
- Both role defaults and explicit spawn requests can reference aliases.
- References use the plain alias name: no `@`, prefix or separate tool field.
- Resolution checks for an existing alias first, then uses the existing model resolver.
- A found alias with an unusable target fails spawn; it never falls back.
- Changes affect future spawns, not already-created children or the parent conversation.

## Existing integration points

Observed code and contracts:

- `src/web/agent-delegation.ts`: `resolveChildModel`, `resolveModelReference`, `resolveModelAlias`, `describeRoleModel`, `agentTool`.
- `src/web/server.ts`: `childModelFor` connects resolution to provider validation; agent catalog projects role model resolution.
- `src/web/provider-store.ts`: versioned global provider/default storage.
- `src/harness/llm/model-catalog.ts`: shared thinking vocabulary and model capabilities.
- `web/components/settings/AgentsPanel.tsx`: role model selection and resolved-model display.
- `web/components/settings/SettingsModal.tsx`: settings navigation.
- `web/lib/types.ts` and `web/lib/api.ts`: client contracts.
- `docs/harness.md`: child model precedence and durable `session/model` snapshot at spawn.

The current resolver prioritizes the spawn reference, then role model, then parent controls. Role definitions also support heuristic Claude aliases and legacy inheritance for unresolved role references. Custom aliases must be resolved before this legacy fallback boundary.

## Alias data and persistence

Each alias stores:

- `name`: operator-entered unique name.
- `provider`: concrete configured provider ID.
- `model`: concrete model ID, not another alias.
- `thinkingLevel`: explicit supported level or `null` for Model default.

The alias collection is stored with the global provider configuration using its serialized, atomic persistence boundary. Loading older configuration without aliases yields an empty collection. Existing provider/default writes must retain aliases, and alias writes must retain providers/defaults. Do not publish a mutation to runtime state before persistence succeeds.

Names are trimmed and matched exactly, case-sensitively. They must be nonempty and contain no whitespace, colon, control characters, or `@`; other printable characters are accepted. Colon is reserved for direct `provider:model` references. `inherit` is reserved to preserve existing role semantics. Duplicate names are rejected. Renaming creates the new name and removes the old name atomically; it does not rewrite role files or existing instructions. The editor explains that users must update references after renaming.

No recursive alias targets, project overrides, automatically seeded mappings, or composer alias syntax are introduced.

## Resolution contract

First select the reference using existing precedence:

1. Nonempty explicit spawn `model`.
2. Role `model`, if present and not inheritance.
3. Parent conversation controls.

For a selected reference:

1. Trim and look for an exact alias-name match.
2. If found, validate the alias target and produce its provider/model/thinking snapshot. Any target error fails spawn before child creation.
3. If not found, apply existing direct-model and legacy Claude-role resolution semantics without change.

An alias overrides a bare model or built-in Claude alias of the same name. An explicit `provider:model` bypasses alias lookup because alias names cannot contain a colon.

The UI warns about collisions with advertised model IDs and built-in Claude aliases but permits them. It does not claim all possible model collisions can be detected for providers accepting arbitrary model IDs.

If an alias is deleted, its old name is no longer an alias. It is resolved as a model reference under existing semantics; if a model with that name exists it can run. This consequence is intentional and shown in deletion guidance. A still-existing but invalid alias never enters this fallback.

`thinkingLevel: null` means the target model's configured default, not parent or global thinking. An explicit level replaces parent thinking. Validate explicit levels against the target model's supported controls so aliases do not silently claim an ignored override.

Resolve at spawn admission and persist the concrete child controls through the existing child session snapshot. Tool-driven and manual HTTP-driven spawn must share the resolver. Updating aliases does not repoint global model defaults or alter parent controls.

## Settings and model selection

Add a Global settings entry named Model aliases.

The panel provides list, create, edit and delete. The editor contains a user-entered name, provider/model selection, and model-appropriate thinking selection including Model default. Display the resolved target and thinking value, and show actionable invalid-target status. Disabled providers cannot be selected for new valid mappings. An existing broken mapping remains visible and can be repaired or deleted.

Settings → Agents offers alias choices alongside direct models and inheritance. Save the plain alias name in existing `model` frontmatter. Preserve existing source-layer ownership rules; do not modify bundled or user/project role files behind the operator's back.

The manual subagent spawn form offers the same aliases. The Agent tool description/catalog makes current alias names and target settings discoverable to the parent model. Invalid aliases are identified as unusable rather than advertised as valid choices. A stale catalog is not execution authority: admission rechecks current configuration.

Role display distinguishes inheritance, resolved direct models, resolved aliases including thinking, and broken aliases that block spawn. It must not label a broken custom alias as inheriting.

No changes to composer mention parsing are necessary.

## Provider changes and failures

Creating/updating an alias validates name, provider availability, model acceptance and thinking support. A validation failure leaves persisted and runtime state unchanged.

Deleting/disabling a provider or removing a model is still allowed. Referencing aliases remain stored but become invalid; never silently rewrite their targets. Model capability changes can also invalidate an explicit thinking selection.

At spawn, errors name the alias and the unavailable provider, model or unsupported thinking setting. No child is created for alias-resolution failure.

Alias storage read/write failures are surfaced. Alias editing must use the same serialized transaction discipline as provider/default mutations to avoid lost fields under concurrent writes. Mutations operate on individual aliases rather than trusting a stale client snapshot of the whole collection. Expected-version/conflict handling details belong in the implementation plan, but concurrent independent alias edits must not overwrite each other.

Existing children retain their snapshot. If their provider later becomes unavailable, ordinary existing execution validation applies; alias retention does not guarantee continued provider availability.

## Acceptance criteria and verification

1. An operator creates a named global alias containing provider, model and thinking; it is available across workspaces and survives restart.
2. A role using that name spawns with the alias target; an explicit spawn alias overrides the role choice.
3. Editing one alias changes subsequent children using it without editing their roles; an earlier child's stored controls remain unchanged.
4. Explicit alias thinking wins over parent thinking; Model default does not inherit parent thinking.
5. A present alias with a disabled/deleted provider, removed model or unsupported thinking fails without creating a child or falling back.
6. An alias colliding with a bare model or Claude alias wins; direct `provider:model` selects the concrete model.
7. No alias match preserves existing explicit-model, role-model and parent-inheritance behavior, including legacy unresolved-role behavior.
8. Deletion and rename obey plain-name resolution and clearly explain reference consequences.
9. Tool and manual spawn agree; role UI accurately reports broken aliases as blocking.
10. Provider/default updates retain aliases, alias updates retain other configuration, and failed persistence does not publish new state.
11. Alias forms support keyboard operation, validation feedback and existing settings discard safeguards.

Verification includes pure resolver tests; persistence upgrade/round-trip and concurrent mutation tests; HTTP CRUD and both spawn-surface integration tests; settings and role/spawn picker tests; typecheck/build and relevant existing delegation/provider regressions. No passing-test claims have been made during design.

## Delivery boundary

This document approves a design, not product implementation. After the operator reviews the written spec, create an implementation plan and ask for its execution method. Existing unrelated working-tree changes are outside scope and must remain untouched.
