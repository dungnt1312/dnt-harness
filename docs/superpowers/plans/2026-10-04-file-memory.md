# File-based Memory Implementation Plan

> **For agentic workers:** Use subagent-driven-development to implement this plan. Steps use checkbox syntax.

**Goal:** Replace advertised dedicated memory tools with ordinary file tools, matching the current dntspace-app Markdown/index design without losing existing harness memory.

**Architecture:** Retain workspace/project storage ownership. Markdown files become the source of truth and MEMORY.md is loaded as bounded untrusted reference, not pinned bodies. Ordinary file tools receive narrowly scoped memory access; preserve file observation/conflict and explicit deny boundaries.

**Tech Stack:** TypeScript, Node filesystem, Vitest, existing context and tool pipeline.

**Spec:** User-approved proposal in conversation: complete switch to current dntspace-app approach, migrate existing data, no auto-extraction.

## Global Constraints
- No automatic extraction.
- Preserve existing memory data and unrelated dirty working tree changes.
- Scope remains workspace/project, not global profile.
- Index maximum 200 lines and 25 * 1024 UTF-8 bytes; never split UTF-8.
- Types: user, feedback, project, reference.
- No memory content may alter authorization; explicit deny and symlink/path containment checks remain effective.
- Existing UI/API must work with new agent-authored Markdown; pinned fields may survive only as compatibility metadata, never body injection.

## Review Focus
- Symlink, traversal, foreign scope and non-Markdown writes cannot exploit memory grants.
- Migration must be idempotent and never overwrite an existing agent-maintained index.
- Unicode and oversized index loading obey both bounds.
- Disabling memory removes injections/access at next request; child access stays within role grants.
- Existing CRUD and direct file edits use one source of truth and preserve conflicts.

### Task 1: Complete file memory integration
**Files:** Memory service and tests; filesystem path guard/tool pipeline; context builder and server root/child request construction; bundled modes/roles; memory UI/API types if necessary; capabilities and harness docs.
**Interfaces:** Introduce MemoryService methods for scope roots, idempotent migration/index preparation and bounded index snippets. Use existing filesystem tool interfaces and untrusted context wrappers rather than creating replacement dedicated tools.
- [ ] Inspect current reference source at /Users/dungnt/workspace/dntspace-app/src-tauri/src/memory.rs and its current prompt/permission integration. Ignore obsolete reference plans.
- [ ] Write failing tests for index bounds, no pinned body injection, migration of legacy entries, user-authored frontmatter, retired tool exposure, allowed scoped Markdown writes and denied escape/non-md/foreign-scope writes.
- [ ] Run focused tests and establish baseline failures separately.
- [ ] Implement memory roots and index migration preserving legacy body/title/timestamps, supporting ordinary frontmatter name/description/type and metadata.type. Ensure legacy APIs can read/write new files. Do not regenerate agent-owned index each request.
- [ ] Integrate both workspace and current project index, guidance and absolute root paths into bounded untrusted context when enabled. Ordinary file reads/searches can browse only eligible roots; Write/Edit may auto-allow only safe .md paths there, without widening shell, explicit denies or child role capability. Retire five memory tools from runtime registration and exposure. Preserve exported compatibility functions only if necessary, not advertised tools.
- [ ] Update UI copy away from pinned-body behavior and documentation to describe indexes and ordinary file tools.
- [ ] Run focused tests and npm run typecheck, record exact results and pre-existing failures.

### Task 2: Whole-change review and verification
- [ ] Review changed files against all global constraints and five review focus items.
- [ ] Fix findings with covering regression tests.
- [ ] Run focused tests, typecheck and build:web; report actual results without conflating baseline failures.

## Execution Decisions
User explicitly authorized implementation without further questions. Work in the current checkout to preserve and test integration with existing uncommitted server changes; do not stash, reset, commit unrelated files, merge, or push. Existing dirty files are terminal-related including src/web/server.ts and docs/web.md; preserve those edits. No automatic worktree creation or branch changes.
