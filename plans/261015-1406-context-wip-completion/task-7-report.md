# Task 7 report — prompt and tool-description contract

Worktree `.worktrees/ctx-task7`, branch `fix/ctx-task7` (base f525b88). Commit `84899ab` — `feat(prompt): task-based tool selection, host-owned MCP precedence, no Bash hints`. Nothing pushed; nothing under `plans/` committed.

## Changes
- `src/harness/context/builder.ts`
  - New `TOOL_SELECTION` (spec §4.1 paragraph verbatim) is shared by `DEFAULT_BASE_SYSTEM` and `DEFAULT_CHILD_SYSTEM`. The child keeps its final-deliverable and no-delegation sentences. The TodoWrite sentence now says "when it is available".
  - `MCP_PRECEDENCE_BLOCK` is pushed into message `[0]` after the base/child prompt and the mode/role, only when a schema name starts with `mcp__`. It sits outside `DEFAULT_BASE_SYSTEM`, so overrides keep it, and it has no dynamic content.
  - `fileScopeText` adds one qualifier line: reading and writing depend on the exposed tools and host policy.
  - The authoring reference keeps the real project/workspace/user paths. The YAML/format lines are replaced by one sentence: the `create-skill` skill when `Skill` is in the schemas, otherwise `docs/agent-guide.md`. `Skill catalog` is named only if `Skill` is present. `Agent catalog` is named only if `Agent` is present and the request is not a child.
- `src/capabilities/shell/bash.ts`
  - Removed `fileToolHint`, `READ_COMMANDS`, `SEARCH_COMMANDS`, `escapeRegExp` and the `hint`/`hintLine` plumbing in both the foreground and background paths.
  - The description now follows §4.2: Bash for metadata and unsupported operations; existing files need an observation; reading through Bash creates none; new files need no Read; successful Write/Edit/ApplyPatch update the observation.
- `src/capabilities/shell/background-tools.ts` — the BashOutput/KillShell descriptions accept the IDs Bash returns, including auto-backgrounded commands, and are scoped to this session.
- `src/harness/modes/bundled.ts` — the `ask-before-changes` instructions are the §4.4 text verbatim. `edit-automatically` uses the same framing for shell commands and deletions. `permissionDefaults`, `readOnlyBash`, `riskyBash` and `outOfGrant` are untouched.
- `src/harness/tools/todo.ts` — at most one `in_progress`; none is fine when finished or not started. Full replacement and validation are unchanged.
- `src/web/server.ts` — only the Skill tool description string changed: the catalog may be in context, and if it is missing or trimmed the model calls `action:'catalog'`.
- `src/capabilities/fs/tools.ts` — unchanged. No description there says Read is the only way to create an observation.
- Docs: `docs/prompt-contract.md` (MCP block position, new MCP and tool-selection/Bash sections, authoring reference) and `docs/capabilities.md` (Bash "No advisory hints" bullet).

## Tests
- `tests/capabilities/bash.spec.ts`
  - The old hint suite is replaced.
  - AC-01: no hint appended for `cat`, `ls`, a leading `cd`, a heredoc or `grep`; output and exit-code suffix are unchanged.
  - AC-02: a `[hint: x]` line printed by the program is kept.
  - The description states the observation rules.
- `tests/harness/g3-context.spec.ts`, new describe `tool and prompt contract`:
  - The file-scope qualifier.
  - AC-07: `create-skill`, `Skill catalog` and `Agent catalog` appear only when the request carries the matching tool, never `Agent catalog` for a child, and none of them in a zero-tool mode.
  - AC-11: the MCP block is present for root, root-role, child, and with base and child overrides; absent without an `mcp__` schema; positioned after the mode/role.
  - AC-12: the same inputs give a byte-identical message `[0]`.
  - AC-06: the `ask-before-changes` and `edit-automatically` wording, plus an exact `toEqual` on both bundled `permissionDefaults` maps and `readOnlyBash`.
- `tests/harness/base-prompt-guidance.spec.ts` — new wording and the shared child principle. `tests/harness/todo-tools.spec.ts` — the at-most-one-`in_progress` wording.
- `tests/harness/g5-prompt-contract.spec.ts` and `tests/web/server-skill-sources.spec.ts` needed no edits. Their trust and ordering assertions still pass.
- AC-03..AC-05 (observation behaviour) rely on the existing fs tests, which pass; I did not duplicate them.

## Verification
- `pnpm exec vitest run tests/capabilities tests/harness tests/web/server-skill-sources.spec.ts --maxWorkers=1 --no-file-parallelism` — 108 files passed, 1622 tests passed, 1 skipped.
- `pnpm run typecheck` — passed (both tsconfigs).
- Not run: full `pnpm test`, the other web specs from spec §7 (server-models and the vision/compaction suites), `pnpm run build:web`. Part B and the other web specs were not touched by this task.

## Concerns / unresolved
- The model-facing text is not benchmarked. Dropping the Bash hints may push some models to use the shell more (spec §9 risk).
- The default prompts changed, so the cache prefix changes once on rollout.
- `server-models.spec.ts:106` was listed in spec §7 as affected, but I did not run it.

## Fix round 1
- KillShell processId description now matches BashOutput (src/capabilities/shell/background-tools.ts).
- Write/Edit/ApplyPatch descriptions: "observed (a successful Read, Write, Edit or ApplyPatch)"; existing-file + unchanged rule kept (src/capabilities/fs/tools.ts).
- tests/web/server-skill-sources.spec.ts: captures the Skill tool schema from the provider request and asserts the catalog recovery hint.
- tests/harness/g3-context.spec.ts: root-role MCP case asserts the marker comes after `Role —`.
- `pnpm exec vitest run tests/capabilities tests/harness/g3-context.spec.ts tests/web/server-skill-sources.spec.ts --maxWorkers=1 --no-file-parallelism && pnpm run typecheck` → 9 files, 169 passed / 1 skipped (pre-existing), typecheck clean.
- Commit e0106a3.
