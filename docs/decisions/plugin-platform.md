# Plugin platform

Status: proposed (2026-09-30). Not implemented — this document is the contract to review before any phase starts.
Scope: the in-process plugin platform. It freezes the loading path, the namespace rules, the HTTP route seam, and the SDK surface policy. Later phases implement them; they do not rename them.

## Two tiers of extension

dnt-harness already has two out-of-process extension tiers, both in production shape and unchanged by this spec:

- **MCP servers** are external tool plugins: their tools enter the same registry, the same guarded pipeline, and the same approval gates as built-ins (`docs/decisions/mcp-production-boundaries.md`).
- **Hooks** are external lifecycle scripts with blocking decisions (`src/harness/hooks/runner.ts`).

"Plugin" in the rest of this document means the third tier: an **in-process kernel plugin** mounted on the kernel. The kernel (`src/kernel/`) and every seam a plugin needs on the agent side already exist and are dogfooded — the harness itself mounts as plugins. What is missing is the platform around the kernel: no production bin loads a composition file, the web host has no route registration seam, and the package surface is not published. This spec closes exactly those three gaps and nothing else.

## Composition and loading

- The composition file is `plugins.yml` at the resource home (the same home that holds modes, skills, and agent definitions). Both bins read it after core services mount; the headless bin reads it too.
- Entries use the existing `ConfigEntry` shape only: `name` and `disabled`. Load order is deterministic: core services first, file entries in file order, then `--plugin <path>` flags in flag order. Relative specifiers resolve against the composition file; bare package names import from the host process.
- `--plugin <path>` is a repeatable CLI flag on both bins for development and tests. Flag entries mount after file entries.
- **Fail loud on boot.** A composition entry that fails to parse, import, or start refuses the boot with the underlying error. Recovery is `disabled: true` on the row, then restart. There is no partial host.
- `parseConfig` rejects unknown fields. A silently ignored `options:` key would lie to a plugin author; the shape is reserved, and adding it later is a reviewed change.
- **No hot reload.** A restart applies changes; the restart is already the operational unit (PM2).

## Namespace

- The host owns the bare service names: `sessions`, `llm`, `tools`, `agents`, `workspaces`, `modes`, `skills`, `memory`, `mcp-store`, `agent-definitions`, `limits`, `http`. This list is the reservation; it lives in one place and is exported.
- A plugin-provided service must use a dotted name: `<plugin>.<service>`. `Context.provide` rejects a reserved bare name when called from a non-root fiber — loud at mount, not at first read.
- Event names follow the same split: core events are bare (`tools/pre-execute`, `session/event`); a plugin's own events are `<plugin>/...`. The `Events` interface stays open through declaration merging.

## Kernel preconditions

Two documented caveats are fixed before M1 ships, because both become contract violations once third-party plugins exist:

- **Parent-preserving restart.** Today a dependency-driven restart re-mounts the child root-owned and silently drops the parent linkage (`Context.plugin` doc, `src/kernel/context.ts`). The restart re-mounts under the owning parent fiber; the caveat is deleted, and a test pins the parent linkage across a dependency restart.
- **Startup failure is observable.** An async `apply` failure currently only `console.error`s. The kernel emits a typed `kernel/plugin-failed` event (name, error, fiber), the fiber stays queryable as `failed`, and the diagnostics route below reports it.

## HTTP route seam

- The host provides an `http` service. A plugin registers a route with `ctx.http.route({ method, pattern, handler, audit })`. Patterns are anchored regexes, matching the existing `handleApi` idiom.
- Dispatcher order: static files → auth/CSRF boundary (unchanged) → registered plugin routes → the legacy `handleApi` cascade. Plugin routes run behind the same default-deny authentication as built-ins; there is no bearer-scope bypass.
- **A plugin cannot make a route public.** Public paths are host code (`isPublicPath`); v1 has no API to extend them. A plugin route is always authenticated.
- Registration requires an `audit` field with the credential and owner, merged into the route inventory (`src/harness/mcp/route-inventory.ts`). A test asserts every registered plugin route appears in the inventory — the same invariant the built-ins are held to.
- SSE is allowed: a handler owns the response and may stream (the terminal precedent). Long-lived streams still count against the host's connection limits.
- Built-in routes migrate to the table opportunistically; the cascade stays until all are moved. No big-bang rewrite of `server.ts`.

## Agent-side seams (already contract)

These exist and this spec freezes them as the plugin contract, unchanged: `ToolsService.register` as a fiber effect with canonical names; the four pipeline points `tools/rewrite`, `tools/pre-execute`, `tools/final-gate`, `tools/post-execute`; the observable events `agent/pre-step`, `agent/context`, `agent/request`, `agent/turn-stopping`, `agent/turn-settled`, `llm/stream`, `session/event`, `web/approval`, `web/approval-settled`, `web/turn-error`. A plugin that rewrites or denies a call is subject to the same rule as a policy: a denial is a result the model sees, never an exception into the loop.

## SDK surface policy (gated)

This phase is blocked until the root-session isolation work lands: it rekeys execution identity, and plugins read those shapes. Freezing before it would freeze the wrong surface.

- `package.json` gains an `exports` map exposing only `"."` — types and import. Deep-path imports from outside the package stop being supported.
- The exported surface is what `src/index.ts` re-exports. Versioning is semver against that surface; while `0.x`, breaking surface changes are allowed in minors and recorded in the docs index.
- Enforcement is a tripwire test (`tests/sdk-surface.spec.ts`) that imports every name `src/index.ts` promises and fails when one goes missing. Publishing the package is a separate decision, not part of this spec.

## Trust and failure containment

- A plugin is arbitrary Node code running in the host process with the host user's full authority. It is trusted-local by definition; there is no sandbox and none is claimed. Distribution beyond local files (a marketplace, G6) is out of scope and would need its own threat model.
- `emit` is synchronous and fail-fast by design. A plugin that throws from an `emit` listener is a plugin bug and may take the dispatch down with it; guarded paths (`waterfall`/`serial` in the tools pipeline) already contain listener errors into `ToolResult`s. Plugins are documented to never throw from plain listeners.
- A failed plugin fiber does not take the host down: its registrations unwind, dependents pends, the rest keeps serving, and the failure is visible on the diagnostics route.

## Diagnostics

`GET /api/plugins` (authenticated, inventoried) reports, per mounted plugin: name, source, fiber state, `inject`, and effect count. It is the v1 control surface; there is no enable/disable API — the file is the control, a restart applies it. This route is the future anchor for a settings panel if one is ever wanted.

## What this does not protect against

In-process plugins share the process: they can read anything the process can, including every provider key and every session log. Route authentication does not protect against a plugin registering a route that proxies them out. `disabled: true` requires the operator to edit the file — a malicious local plugin could re-enable itself before the next boot. Containment claims stay false until an out-of-process tier (MCP) is the recommended path for untrusted authors.

## Milestones

- **M1 — Composition + diagnostics.** `plugins.yml` in both bins, `--plugin` flag, strict `parseConfig`, reserved-name enforcement, parent-preserving restart, `kernel/plugin-failed`, `GET /api/plugins`. Acceptance: kernel restart-ownership test; a `tests/web/plugins.spec.ts` covering boot, disable, fail-loud boot refusal, and the diagnostics route; bin smoke tests.
- **M2 — Route seam.** `http` service, registration contract with mandatory audit inventory, dispatcher integration, at least one built-in route migrated, plugin route end-to-end (auth enforced, public rejected). Acceptance: `tests/web/route-seam.spec.ts` plus the route-inventory completeness test.
- **M3 — Surface freeze** (gated on root-session isolation). `exports` map, tripwire test, versioning note, and the plugin authoring guide promoted from `docs/guides.md` into a standalone document.

Out of scope for all milestones: UI extension surface, plugin static assets (`/plugins/<name>/`), hot reload, sandboxing, per-workspace plugin sets, plugin config options, marketplace.
