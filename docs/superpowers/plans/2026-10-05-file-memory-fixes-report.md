# Reviewed file-memory fixes — 2026-10-05

## Outcome and changed files

All five reviewed paths have fixes and focused regression coverage. Original approved plan and report (`2026-10-04-file-memory.md`, `2026-10-04-file-memory-report.md`) were read before implementation; repository retrieval inspected grants, walkers, memory CRUD, Settings routes/client encoding, CLI composition, workspace/project ownership, modes, approval, and context assembly before source edits. Existing migration and terminal edits were preserved; no stash/reset/branch/commit/delegation/dependency changes.

- `src/capabilities/fs/grants.ts`: real memory targets are checked again for sensitive segments and Markdown extension (directories remain valid read/search bases). Ordinary project grants are unchanged. Read/Write/Edit and existing walker grant checks share the refusal.
- `src/harness/memory/service.ts`: all CRUD paths validate trusted root/parent directories and regular non-linked topics; mutations preflight index files before touching topics, including the workspace index initialized for project creates. prepare preflights both scopes before publishing either index. Recursive enumeration skips linked and sensitive trees and index files. Safe relative topic IDs support nested directories, underscores, case and dots, retaining extensionless API IDs and legacy kebab IDs; traversal/absolute/sensitive/index IDs are refused. Title updates change only complete auto-pointer lines whose label equals the old/current title; unrelated prose and custom labels remain unchanged and no pointer is appended by update.
- `src/harness/memory/context.ts`: small shared host-owned scope/index/guidance helper; web and CLI use identical bounded index loading and no auto-extraction.
- `src/web/server.ts`: shared index/guidance projection; invalid or unsafe GET/DELETE IDs return 400 instead of generic 500, preserving 404 for missing reads. Existing encoded-slash route already works and did not require broadening its regex.
- `src/bins/headless.ts`: reuses Default workspace and canonical-root project record, creating a normal project only if no match exists; durably records the session project. Selected workspace mode controls memory switches, schemas/exposure and explicit denies, including under yolo. Only enabled scoped Markdown memory grants carve out data-home storage; shell policies are not widened. Context uses the existing budgeted untrusted builder with both indexes and guidance.
- `tests/harness/file-memory.spec.ts`: real-target file-tool/search restrictions, CRUD symlink matrix, nested linked parents, index preflight/no damage, recursive safe IDs and exact pointer preservation.
- `tests/web/server-g3.spec.ts`: HTTP encoded nested/underscore create/read/list/PATCH/delete, renamed index labels and invalid-ID rejection.
- `tests/bins/headless.spec.ts`: real spawned CLI against local OpenAI-compatible SSE transport through the actual DeepSeek adapter; captures provider context, writes scoped project memory, then verifies disabled memory omits indexes and rejects the same scoped write.
- `docs/superpowers/plans/2026-10-05-file-memory-fixes-report.md`: this report.

Settings client `web/lib/api.ts` already encodes IDs using encodeURIComponent for read/update/delete; no UI source edit was necessary. Settings creates legacy slug IDs as before and can list/edit nested authored topics through the API.

## Exact red/green execution

1. RED `npx vitest run tests/harness/file-memory.spec.ts`: 7 failed, 5 passed. Sensitive alias Read leaked; read/create/update/forget/search link regressions failed; nested topic create was rejected by old kebab-only validation. The combined nested/title test stopped at nested create, so title preservation was not independently observed red.
2. GREEN `npx vitest run tests/harness/file-memory.spec.ts`: 12 passed after grants/CRUD/topic/title changes.
3. RED `npx vitest run tests/bins/headless.spec.ts -t 'real CLI provider'`: 1 failed, 1 skipped; provider received only `remember`, no memory roots/index context.
4. GREEN `npx vitest run tests/bins/headless.spec.ts tests/web/server-g3.spec.ts tests/harness/file-memory.spec.ts`: 36 passed. `npm run typecheck`: backend and web passed.
5. RED `npx vitest run tests/web/server-g3.spec.ts -t 'HTTP memory'`: 1 failed, 21 skipped; invalid GET ID returned 500 rather than 400. Fixed GET/DELETE error mapping. Nested HTTP regression was introduced after service implementation and was not independently run against the original service.
6. RED `npx vitest run tests/harness/file-memory.spec.ts -t 'prepare validates'`: 1 failed, 13 skipped; workspace index had been created before a linked project root was refused. Fixed whole-prepare preflight.
7. Final GREEN command:
   ```sh
   npx vitest run tests/harness/file-memory.spec.ts tests/harness/memory-tools.spec.ts tests/harness/g3-context.spec.ts tests/harness/modes.spec.ts tests/capabilities/fs-tools.spec.ts tests/capabilities/fs-multi-root.spec.ts tests/bins/headless.spec.ts tests/web/server-g2.spec.ts tests/web/server-g3.spec.ts
   ```
   9 files, 122 tests passed.
8. Final `npm run typecheck`: backend and web passed.
9. Final `npm run build:web`: passed, 539 modules transformed.
10. `git diff --check`: passed, including rerun after report addition.

Changed code/tests were re-read and diffs inspected. Shell retrieval searches used rg after the host Grep/Glob unexpectedly returned no matches for existing files.

## Decisions and remaining limitations

- Storage validation is application-level lstat/realpath containment, not an OS sandbox. Concurrent hostile ancestry replacement between validation and filesystem use is not fully eliminated; directory-descriptor/openat-style containment is not implemented. Topic/index publication also remains non-transactional and can race direct external writers, as in the original migration report. Known unsafe links already present fail closed before mutation and regression fixtures assert external data remains unchanged.
- Search skips linked topics/subtrees; linked root/ancestors fail rather than silently browsing them. A linked index does not block topic-only read/search because those operations do not consume or mutate it; it blocks index loading and mutations.
- API IDs are extensionless and ASCII filesystem-safe, not arbitrary Unicode/spaced filenames. Search retains its existing 20-hit default limit. Settings remains workspace-scoped.
- CLI mode selection is resolved at process startup (there is no CLI mode command/live control architecture); changing the selected mode file applies on the next invocation. The test verifies enable/disable across actual invocations. Index contents themselves reload every request. Existing CLI approval continues to gate writes outside yolo; no memory-specific approval bypass was added.
- CLI now uses existing context assembly but does not add skill loading, instruction discovery, checkpoint loading, global profiles or child delegation. These are outside this fix.
- Full Vitest suite, browser/UI mounted tests and live external-provider calls were not run. Local transport integration is complete; no external credentials were used.

## Final review follow-up — 2026-10-05

Retrieved the current service, file-memory tests, server HTTP tests and this report before edits; preserved existing dirty changes. No delegation, commits or dependency changes.

- `src/harness/memory/service.ts`: validate UTF-8 encoded bytes of every topic path component, including the final `.md` suffix, before filesystem preflight or mkdir. Oversized IDs produce `MemoryError('invalid')` (HTTP 400) without creating parents. A 255-byte directory component and 252-byte basename remain valid. Pointer retitling retains captured LF/CRLF separators verbatim and changes only exact automatic pointer lines; custom labels, prose, trailing whitespace and missing final newlines remain untouched.
- `tests/harness/file-memory.spec.ts`: oversized component rejection/no-parent fixtures, valid length boundary, and byte-exact mixed CRLF/LF index retitling.
- `tests/web/server-g3.spec.ts`: oversized POST/GET/PATCH/DELETE IDs return 400 without partial topic directories, plus byte-exact CRLF index retitling through PATCH.
- `docs/superpowers/plans/2026-10-05-file-memory-fixes-report.md`: appended this follow-up.

Exact execution outputs (ANSI styling omitted):

1. RED `npx vitest run tests/harness/file-memory.spec.ts tests/web/server-g3.spec.ts -t 'oversized|CRLF'` — exit 1:
   ```text
   Test Files  2 failed (2)
        Tests  4 failed | 36 skipped (40)
   ```
   Service length regression received `code: 'ENAMETOOLONG'` instead of `invalid`; HTTP length regression received 500 instead of 400. Both CRLF tests retained `Original` instead of `Renamed`.
2. GREEN `npx vitest run tests/harness/file-memory.spec.ts tests/harness/memory-tools.spec.ts tests/web/server-g3.spec.ts && npm run typecheck` — exit 0:
   ```text
   tests/harness/file-memory.spec.ts (16 tests)
   tests/harness/memory-tools.spec.ts (3 tests)
   tests/web/server-g3.spec.ts (24 tests)
   Test Files  3 passed (3)
        Tests  43 passed (43)

   > dnt-harness@0.1.0 typecheck
   > tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.web.json
   ```
   Existing policy migration tests emitted their expected collision/empty/malformed policy warnings. Both backend and web typechecks completed successfully.

Full suite, build and browser tests were not rerun for this follow-up. No blocked or unfinished implementation.
