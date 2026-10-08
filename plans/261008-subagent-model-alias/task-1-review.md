# Task 1 independent review — c8cc98e

Spec FAIL; quality REQUEST_CHANGES; whole branch not ready.

1. P1 src/web/agent-delegation.ts:131: role reference converted by Claude heuristic before custom lookup. Alias sonnet/opus collision bypasses alias-first and fail-closed. Lookup original role reference first.
2. P2 src/web/server.ts:6209: POST validates target outside serialized mutation; queued disable/delete/remove may commit first, creating invalid alias. Validate within callback against current state.
3. P2 src/web/server.ts:6212: revision reset 1 creates ABA after delete/recreate or rename reuse. Use generation/revision never reused across lifetimes, preserved across restart.
4. P2 web/components/settings/ModelAliasesPanel.tsx:44: thinking options show all levels, not model capabilities. Filter via expressibleThinkingLevel, reset invalid level on model change.
5. P2 web/components/settings/ModelAliasesPanel.tsx:43: empty-catalog provider accepts any concrete model server-side but UI cannot enter one. Add concrete model ID text input for empty catalog.
6. P2 web/components/workbench/AgentRunsPanel.tsx:202: blank option labeled inherit sends undefined and therefore uses role default. Label Use role default / conversation fallback.
7. P2 web/components/workbench/AgentRunsPanel.tsx:80: role catalog omits root project binding, so project roles missing. Pass root projectId into panel/catalog.
8. P2 web/components/settings/ModelAliasesPanel.tsx:49: Delete bypasses discard guard and discards dirty draft. Wrap with guardDiscard.
9. P2 src/web/provider-store.ts:85: read errors other than ENOENT silently become empty collection, risking destructive overwrite. Surface non-ENOENT failures and block mutation.

Reviewer: cliproxy:gpt-6.1-sol. No rerun of existing 164 tests/build/typecheck. Reviewer tool role could not write artifact; controller recorded returned findings verbatim in substance here.
