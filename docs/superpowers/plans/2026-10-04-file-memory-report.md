# File memory migration implementation report

## Changes

- `src/harness/memory/service.ts`: preserves the legacy workspace/project topic paths and frontmatter (including title, pin and timestamps); initializes missing indexes exclusively, never regenerates existing indexes; loads bounded Unicode-safe index snippets; parses agent-authored `name`, `description`, and `type`/`metadata.type`; API create/update/forget operates on the topic files, checks hashes and maintains pointers. Existing unindexed topic files remain discoverable through the API. Legacy pinned values are retained only as metadata.
- `src/web/server.ts`: no longer registers dedicated memory tools. Each enabled request prepares workspace and current project indexes, injects pointers as untrusted reference, and advertises ordinary file access for eligible roots. Both memory source switches must be enabled. Existing project grants and pre-existing terminal changes were preserved. The mode permission resolver auto-allows asks on scoped Markdown Write/Edit only; explicit deny still wins.
- `src/capabilities/fs/grants.ts`, `src/harness/tools/service.ts`, `src/harness/tools/types.ts`: host-owned memory grant carve-out from app-storage deny, filtered to Markdown paths and sensitive segment restrictions; realpath containment checks prevent symlink escapes; run-time grant intersections revoke access on mode changes.
- `src/harness/modes/bundled.ts`: removed dedicated memory names from bundled exposure/permissions and known-tool list. `web/components/settings/MemoryPanel.tsx`, `web/components/settings/ModesPanel.tsx`: clarify indexes vs pin metadata. `docs/harness.md`, `docs/web.md`: describe file-based scoped indexes. `tests/harness/file-memory.spec.ts`: focused index, migration, API conflict/frontmatter, path escape tests.

## Verification

- Baseline `npx vitest run tests/harness/memory-tools.spec.ts tests/harness/g3-context.spec.ts tests/web/server-g3.spec.ts`: 49 passed before edits.
- Red `npx vitest run tests/harness/file-memory.spec.ts`: 3 failed as intended (missing root/prepare/index).
- `npx vitest run tests/harness/file-memory.spec.ts tests/harness/memory-tools.spec.ts tests/harness/g3-context.spec.ts tests/harness/modes.spec.ts`: 43 passed.
- Final `npx vitest run tests/harness/file-memory.spec.ts tests/harness/memory-tools.spec.ts`: 6 passed.
- `npm run typecheck`: passed (rerun after last service edit).
- `npm run build:web`: passed.
- `git diff --check`: passed.
- `npx vitest run tests/harness/file-memory.spec.ts tests/web/server-g3.spec.ts tests/harness/modes.spec.ts`: 33 passed, 1 failed: server-g3 context/body count now 2 rather than 1 after the new memory context. Earlier baseline 49 passed. This expectation was not updated.

## Review follow-up (2026-10-04)

- `src/capabilities/fs/grants.ts` now classifies an eligible memory root as readable for directory searches; reads inside it remain Markdown-only, sensitive segments and explicit nested denies remain blocked. `src/capabilities/fs/tools.ts` rechecks every walk directory and file with grant resolution rather than skipping the whole app-home tree or opening it wholesale.
- `src/harness/memory/service.ts` checks the home-relative root ancestry before/after creation and before index load, rejects linked ancestors and a non-regular/symlink MEMORY.md, and patches known frontmatter keys without discarding agent-owned metadata on API update.
- `tests/harness/file-memory.spec.ts` covers root Glob/Grep/Read/Write/Edit, denied/disabled/read-only child scopes, linked ancestors/index and metadata preservation; `tests/web/server-g3.spec.ts` exercises the real server tool pipeline and checks the semantic system context body instead of a global count. `docs/capabilities.md` describes file-based memory instead of retired tools.
- Verification: `npx vitest run tests/harness/file-memory.spec.ts tests/web/server-g3.spec.ts` passed (26/26); `npm run typecheck`, `npm run build:web`, and `git diff --check` passed. A subsequent focused memory test passed (5/5) after adding explicit-deny and child/read-only assertions. No full-suite or browser run. Earlier failed runs during implementation (home path alias and a test cast) were fixed and rerun.

## Limitations / unfinished

- Review follow-up adapted the server-g3 expectation and ran a server file-tool integration regression; no full Vitest or browser suite was run.
- The old `memoryTools` exported compatibility factory remains usable to direct callers/tests but is not runtime-registered; persisted custom mode tool names can still mention those names but they resolve to no registered tool.
- CRUD index pointer appends and direct file writes can race; API update still uses atomic replace after a hash recheck, but concurrent writers between recheck and replace remain a known limitation. Settings currently edits the workspace scope only.
- File-tool default Grep/Glob root in a project session is still the project directory; point its `path` explicitly at one of the memory roots to search memory. No automatic memory extraction is added.
- Existing terminal dirty files were left intact. No commit, stash, reset, branch, or dependency changes were performed.

## Full-suite regression follow-up

- Full-suite log `.superpowers/sdd/file-memory/full-tests.log`: 3 failing tests (G2 unbound Read, SSE context count, G1 steer) and one `server-guard.spec.ts` suite teardown `ENOTEMPTY`; 182 other test files passed. The guard suite's 17 tests passed before its teardown error.
- `src/web/server.ts` now keeps the primary grant empty for projectless workspace sessions and supplies memory as additional scoped roots. `src/harness/tools/service.ts` retains the no-root refusal for relative paths while admitting explicit absolute memory-root paths; execution rechecks the live memory grants. `tests/web/server-g2.spec.ts` covers both sides over HTTP. `tests/web/server.spec.ts` expects distinct system and memory `context/body` events and checks their kinds.
- G1 steering was not changed: the isolated four-suite run and the subsequent six-suite run both passed its original assertions. The `server-guard.spec.ts` suite also passed in both reruns, including teardown; the logged `ENOTEMPTY` did not reproduce. Neither failure was attributed to file memory.
- Red check: `npx vitest run tests/web/server-g2.spec.ts -t 'unbound Read rejects'` failed before code changes (memory index blocked). Initial four-suite run still failed G2; after implementation a focused run exposed a test fixture that matched the memory guidance rather than the user's message, corrected before verification.
- Green checks: `npx vitest run tests/web/server-g2.spec.ts -t 'unbound Read|projects drive'` (2 passed), `npm run typecheck` (passed), `npx vitest run tests/web/server-g1.spec.ts tests/web/server-g2.spec.ts tests/web/server.spec.ts tests/web/server-g3.spec.ts tests/harness/file-memory.spec.ts tests/web/server-guard.spec.ts` (100 passed), `git diff --check` (passed). Full suite was not rerun after these fixes; browser/build not run.

## Final scoped security fix

- `src/capabilities/fs/grants.ts`: only the designated host application-storage ancestor is carved out for eligible memory roots. Explicit root, subpath, and other ancestor denies remain effective for lexical and real paths. Existing readable child directories may serve as Glob/Grep search bases; non-Markdown files, sensitive segments and symlink escapes remain refused.
- `src/harness/tools/types.ts`, `src/harness/tools/service.ts`, `src/web/server.ts`: carry hostStorageRoot separately from deniedRoots through host grant creation and execution-time narrowing; no shell grant change. `tests/harness/file-memory.spec.ts`: explicit root/subpath/ancestor deny, missing designation, child directory search, sensitive segment and symlink regressions.
- RED: `npx vitest run tests/harness/file-memory.spec.ts` failed on child directory classification (1/5). First combined run after implementation passed fs suites but failed server-g2/g3 because hostStorageRoot had not propagated through ToolsService; its memory assertion also needed updating to include the new child note. First `npm run typecheck` failed on two strict typing issues; corrected.
- GREEN: `npx vitest run tests/harness/file-memory.spec.ts tests/capabilities/fs-tools.spec.ts tests/capabilities/fs-multi-root.spec.ts tests/web/server-g2.spec.ts tests/web/server-g3.spec.ts` (70/70); `npm run typecheck` (backend and web passed); `git diff --check` (passed). No full-suite, build or browser run for this fix.
