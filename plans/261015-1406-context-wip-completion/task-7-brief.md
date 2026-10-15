# Task 7 — Part A: prompt and tool contract

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–6). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261015-1347-context-tool-prompt-contract/spec.md` **§4 (Part A) is your requirements**, with the exact English texts to use verbatim; AC-01..AC-12 in §6 are your target. Read §2 and §3 for what not to change.

Summary of the edits (the spec has the details and exact wording):

1. `src/harness/context/builder.ts`
   - Replace the tool-discipline sentences of `DEFAULT_BASE_SYSTEM` with the §4.1 paragraph; make the TodoWrite sentence conditional ("when available"). Same tool-selection principle in `DEFAULT_CHILD_SYSTEM`, keeping its final-deliverable and no-delegation sentences.
   - File scope (§4.3): add a short qualifier that reading and writing still depend on the request's tool exposure and policy.
   - Harness authoring reference (§4.3): keep the real project/workspace/user paths; replace the YAML/format lines with one sentence pointing to the `create-skill` skill (only when `Skill` is in the request's schemas) or `docs/agent-guide.md` in the source repo; mention `Agent catalog` only when `Agent` is in the schemas and never for a child; mention `Skill catalog` only when `Skill` is present.
   - MCP precedence block (§4.3): fixed text from the spec, placed in message `[0]` after base/child prompt and mode/role, rendered only when the request's schemas include a name starting with `mcp__`; for root, root-role and child; outside `DEFAULT_BASE_SYSTEM` so overrides keep it.
2. `src/capabilities/shell/bash.ts`: delete `fileToolHint`, `READ_COMMANDS`, `SEARCH_COMMANDS`, `escapeRegExp` if only used there, and the `hint`/`hintLine` plumbing in `execute` (both foreground and background paths). Rewrite the description per §4.2 (existing files need an observation; reading through Bash creates none; new files need no Read; successful Write/Edit/ApplyPatch update the observation).
3. `src/capabilities/shell/background-tools.ts`: BashOutput/KillShell descriptions accept IDs Bash returns, including commands moved to the background automatically.
4. `src/harness/modes/bundled.ts`: `ask-before-changes` instructions = the §4.4 text verbatim; `edit-automatically` same framing for shell and deletion. Do not touch `permissionDefaults`, `readOnlyBash`, `riskyBash`, `outOfGrant`.
5. `src/harness/tools/todo.ts`: at most one `in_progress`; none is fine when finished or not started.
6. Skill tool description in `src/web/server.ts` (search `name: 'Skill'`): the catalog may be in context; if missing or trimmed, call `action:'catalog'`.
7. `src/capabilities/fs/tools.ts`: only if a description claims Read is the only way to create an observation, correct it.

## Tests

Update tests that assert the old wording and add the ones the spec requires. Known affected: `tests/capabilities/bash.spec.ts` (remove hint cases; add AC-01 no hint for `cat`/`rg`/`ls`/leading `cd`/heredoc, AC-02 program-printed `[hint: x]` kept), `tests/harness/g3-context.spec.ts`, `tests/harness/g5-prompt-contract.spec.ts`, `tests/harness/base-prompt-guidance.spec.ts`, `tests/web/server-skill-sources.spec.ts` (around the `Harness authoring reference` assertion), `tests/harness/todo-tools.spec.ts`. Add:
- MCP block present with an `mcp__x__y` schema for root, child and with a base/child override; absent without MCP schemas (AC-11).
- Zero-tool custom mode and a child without Agent/Skill: no `Agent catalog`, no `Skill catalog`, no `create-skill` (AC-07).
- Same inputs → byte-identical message `[0]` (AC-12).
- Bundled mode permission maps unchanged (snapshot the `permissionDefaults` objects before/after in the test, AC-06).
- Observation behavior (AC-03..AC-05) is covered by existing fs tests; run them, do not duplicate.

Assert meaning, not every comma.

## Verify and commit

```sh
pnpm exec vitest run tests/capabilities tests/harness/g3-context.spec.ts tests/harness/g5-prompt-contract.spec.ts tests/harness/base-prompt-guidance.spec.ts tests/harness/todo-tools.spec.ts tests/web/server-skill-sources.spec.ts tests/harness/modes.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Use the files that exist. Update `docs/prompt-contract.md` (MCP block position, authoring reference, no Bash hints) and `docs/capabilities.md` (Bash section). Commit: `feat(prompt): task-based tool selection, host-owned MCP precedence, no Bash hints`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-7-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
