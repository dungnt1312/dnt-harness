# Session switching performance

Implemented the accepted review recommendations without changing unrelated pending agent/MCP edits. No commit, push, or host restart was performed.

## Changes

- Scope-fence stream output synchronously before effects reset React state. Newly selected sessions never mount the previous transcript.
- Keep recently viewed histories/projectors in a hook-owned LRU cache: at most four inactive sessions and a conservative 16 MB serialized-payload weight budget. Active history is outside this inactive-cache budget. Oversized histories are not retained.
- Restore cached rows immediately, then request events with a query cursor. Native Last-Event-ID reconnect headers take precedence. Invalid cursors fall back to a complete replacement snapshot, resetting both projector and compactor.
- Use SSE frame ids even when compaction drops the final raw event; project buffered rAF events before caching. Dispose old callbacks and do not cache actionable approvals/questions.
- Replace count-only gates with reference-sensitive group revisions. Transcript maps skip chunk-only updates, while same-count replacement snapshots invalidate derived values. Input lifecycle and turn boundaries also invalidate their dependent phase/recovery values.
- Start transcript mounting with a viewport-sized tail of 30–100 blocks instead of 300. Existing Load earlier items adds up to 300 blocks. This is smaller initial mounting, not full variable-height virtualization.
- Document the contract in docs/web.md.

## Verification

- New stale-scope and pending-buffer tests failed before implementation and pass afterward.
- Final affected suite: 8 files, 27 tests passed.
- Typecheck passed.
- Final production web build passed; the existing >500 kB chunk warning remains.
- Full suite rerun: 262 files passed; 2,839 tests passed and one skipped. The first full run failed two tests (manifest restart and MCP workspace isolation); both passed in isolation and the full rerun passed. No claim of baseline proof for the first-run failures.
- git diff --check passed.
- Node SSR synthetic 1,000-turn Markdown sample: previously about 108 ms and 465 KB rendered HTML; after smaller initial tail, 24.4–47.2 ms and 59 KB rendered HTML. This is not browser click-to-paint latency and excludes network/layout.

## Limits

No browser session-switch latency/p95 measurement or full browser E2E run was performed. Cache budget is a conservative payload estimate, not a heap-byte guarantee. Each hook owns its own cache; the app has separate viewed-session and parent-session streams. A newly opened/evicted/oversized history still receives full replay. DOM and disclosure state still remount when switching transcripts, but fewer initial blocks are mounted.
