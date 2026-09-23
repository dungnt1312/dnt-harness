# Brainstorm — Cross-project file scope

Date: 2026-09-23 · Branch: feat/workbench-terminal · Status: accepted, ready for plan

## Context (evidence)
- Grant today = one root: `setRootResolver` → bound project's folder (`src/web/server.ts:761`).
- `resolveGrantedPath` rejects anything outside that root + `deniedRoots` (`src/capabilities/fs/tools.ts:75`).
- Writer lease keyed by `exec.root` (`src/web/server.ts:795`).
- G2 spec listed "external-path grants" as non-goal → this delivery intentionally lifts it.

## Research
| | Codex | ZCode | Claude Code |
|---|---|---|---|
| Read | anywhere (workspace-write) | unrestricted | outside dirs → ask |
| Write | `cwd` + `writable_roots`, else approval | unrestricted, mode-gated only | working + `additionalDirectories`, else ask |
| Extra dirs | `--add-dir`, `sandbox_workspace_write.writable_roots` | none | `--add-dir`, `/add-dir`, `permissions.additionalDirectories` |
| Enforcement | real OS sandbox incl. shell | none (documented) | tool path checks |

Sources: codex `codex-rs/prompts/templates/permissions/sandbox_mode/workspace_write.md`, `codex-rs/protocol/src/permissions.rs`; ZCode `apps/zcode-cli/packages/core/src/tool/path-policy.ts`.

## Contract
- **Outcome:** file tools (Read/Write/Edit/Glob/Grep) can operate across multiple roots: primary project + additional roots (other projects in workspace or arbitrary folders), each `read` or `write`. Paths outside every grant → approval request instead of hard failure.
- **Constraints:** `deniedRoots` stays hard-deny; symlink/junction containment per root preserved; relative paths resolve against primary; mode `permissionDefaults` still apply; full-access mode auto-allows out-of-grant asks; writer lease acquired on the root owning the target path; public tool contracts unchanged; docs must state Bash is still unconfined (no OS sandbox).
- **Non-goals:** OS sandbox / Bash confinement; protected subpaths (`.git` read-only); cross-workspace session moves; per-agent grant overrides.
- **Acceptance:**
  - Read/Edit in a granted additional root succeeds; Write into a `read` grant is refused.
  - Path outside all grants emits `approval/request`; approve → executes, deny → fails.
  - `deniedRoots` path inside an additional root still refused; junction escape from additional root refused.
  - Project-level `additionalDirectories` persist and apply to every session of that project; session `/add-dir` applies only to that session.
  - Two sessions writing the same additional root contend on its lease.
  - Settings UI + composer can add/remove grants; docs updated (`architecture.md`, `capabilities.md`).

## Decisions (user)
- Out-of-grant → ask approval.
- Root sources → other workspace projects + arbitrary paths.
- Grant lifetime → project default + session-temporary additions.

## Risks / open items for plan
- Child agents (`src/harness/agents/executor.ts`) must inherit parent's effective grant — confirm inheritance path.
- Glob/Grep with no path stay on primary; cross-root search only when `path` given.
- Approval "remember" option (allow this dir for session) — decide in plan whether an approved ask adds a session grant.
