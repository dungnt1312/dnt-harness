# ApplyPatch

## Contract
- Outcome: a separate ApplyPatch tool edits multiple regions/files in one structured patch; chat and workbench show landed changes.
- Constraints: retain Read-before-mutation, grant checks for every source/destination, locks, conflict checks, encoding/BOM/EOL and existing tool compatibility. Preserve unrelated working-tree edits.
- Non-goals: shell patch execution, fuzzy ambiguous matching, cross-file rollback, new dependencies.
- Acceptance: targeted parser/filesystem/permission/UI tests, full tests, typecheck and web build; report existing failures separately.

## Design
Use ZCode-compatible Begin/End Patch, Add/Update/Delete File, Move to, @@ context and End of File markers. Independently implement a strict parser and exact, unique line matching. Match hunks against the original document and publish each file once. Verify all sections before writes; acquire canonical file locks in sorted order and revalidate paths/hashes. Refuse duplicate or aliased source/destination paths and existing move destinations. Return JSON receipts with per-file edit regions and line positions, including landed files in errors on partial I/O failure. UI derives diff/counts from receipts, never assumes a failed batch changed nothing.

Trade-offs: ApplyPatch is a separate tool with a small schema and compact diff input, rather than a dual-shape Edit schema. Multi-file writes cannot be one filesystem transaction; receipts must retain partial success. Edit automatically conservatively asks for ApplyPatch because it can delete files.

## Steps
1. Inspect filesystem helpers and all hardcoded tool surfaces.
2. Add parser/application tests, implement patch parsing and safe execution.
3. Register permissions/exposure/agents and integrate UI receipts, change tracking, diff rendering.
4. Run targeted and broad checks; review security, partial failure and compatibility.

Source reference inspected: zai-org/ZCode aac4755666d09fdcd70272fcf063c077a639015f. No source code copied.

## Verification and review
- Implemented all four steps. Inline review added complete multi-path approval binding, atomic no-clobber publication for adds/move destinations, executable-mode preservation, and partial-failure receipts.
- Targeted final run: 9 files, 151 tests passed (filesystem/patch, path guard, authority, out-of-grant, context and UI projections/rendering).
- `pnpm run typecheck`: passed. `git diff --check`: passed.
- `pnpm run build:web`: final run passed; CodeMirror mixed-import and large-chunk warnings remain. One intermediate build failed in precompression with ENOENT on a web-dist asset; subsequent build passed.
- Final `pnpm test`: 339 test files passed, 4319 tests passed, 2 skipped, but command exits 1 because three uncaught CSS.escape errors originate at `web/components/workbench/GitChangeList.tsx:114` in git-panel-split/git-panel-entries specs. That source was not modified for ApplyPatch.
- Earlier suite runs exposed timing failures in server-g1/context-meter (23 tests passed on isolated rerun) and an order-dependent path-scope-guard test. The latter now keys parked executions by path rather than arrival order; final suite assertions all pass.
- Browser/live model smoke, deployment/restart and independent-agent review were not performed. No commit created; unrelated pre-existing working-tree changes preserved.
- Limits: no cross-file rollback, hard-link publication requires filesystem hard-link support, and custom mode/agent exposure lists are not silently widened.

