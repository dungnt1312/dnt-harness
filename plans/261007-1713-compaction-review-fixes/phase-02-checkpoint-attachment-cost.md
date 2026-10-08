---
phase: 2
title: "Checkpoint & attachment cost"
status: completed
priority: P3
effort: "3h"
dependencies: [1]
---

# Phase 2: Checkpoint & attachment cost (F4, F5)

## Goal
Request assembly resolves the canonical checkpoint once per request instead of twice, with no change to cache-repair semantics, and compaction loads only the attachments it will project.

<!-- Red Team: A1/A2/A7/A8 — original (array, length) WeakMap memo rejected: never hits (live vs committed arrays differ; committedLog re-sliced per barrier), skips file repair, unsafe for exported API -->
## Design decision (post red-team)
The original memo design is **dropped**:
- The two per-request calls scan *different* arrays: `checkpoints.latest(…, session.committedEvents)` (`src/web/server.ts:2304`) and `validCompactionCoverage(input.events …)` with `events = session.events` (`server.ts:2309,2336` → `builder.ts:382,774`). A cache keyed by array never hits across them.
- `committedLog` is a fresh `slice` per barrier (`src/harness/session/session.ts:169`), so it never hits between requests either.
- Skipping the checkpoint file read breaks the missing/corrupt cache rebuild contract (`compaction.ts:103-108`; `tests/harness/compaction-reliability.spec.ts:128-138`).

Replacement (minimal, behavior-preserving): **remove the duplicate scan**, keep one.

## Files to Create / Modify
- Modify: `src/harness/context/builder.ts` (`BuildContextInput.compaction` doc + `validCompactionCoverage` L772–776, call at L381–385)
- Modify: `src/web/server.ts` (request assembly L2301–2306; `runCompaction` L1108–1146)
- Modify: `tests/web/server-compaction.spec.ts`
- Modify: `tests/harness/compaction-context-reliability.spec.ts` (buildContext compaction validation; also run `tests/harness/g3-context.spec.ts`, `tests/harness/g5-prompt-contract.spec.ts`)

## Tasks & Steps

### F4 — one canonical scan per request
1. Let the host attest that the checkpoint is canonical, so `buildContext` does not re-derive it from the live log:
   - Extend `BuildContextInput.compaction` with optional `readonly verifiedAgainst?: 'committed-log'`.
   - `server.ts:2304-2305`: set `compaction = { summary, coversSeq, verifiedAgainst: 'committed-log' }` (it already came from `checkpoints.latest(…, committedEvents)`, which returns only canonical values).
   - `builder.ts`: when `verifiedAgainst === 'committed-log'`, skip `recoverCanonicalCheckpoint` but still assert `coversSeq <= lastSeq(input.events)` and `isCompletedCompactionBoundary(input.events, coversSeq)` (O(coversSeq), cheap) — defense in depth retained; when absent (headless/tests/unknown callers), keep the full canonical check unchanged.
2. Do **not** add memo caches; do **not** skip the checkpoint file read in `CheckpointStore.latest`.
3. Tests:
   - Unverified caller with a forged summary → still ignored with omission `compaction: invalid checkpoint ignored; canonical history retained` (builder.ts:384).
   - `verifiedAgainst` with a `coversSeq` not on a completed boundary → ignored with omission.
   - Server test: next request after compaction still reports `compactedThroughSeq` (existing tests at `server-compaction.spec.ts:384`, `:524` stay green).
4. Measurement (optional, not a gate): note before/after time of `buildContext` on a synthetic 50k-event log with 20 compactions in the commit message.

### F5 — scope compaction attachment loading to the delta
1. In `runCompaction`, move the seed lookup (`checkpoints.latest(entry.session.id, entry.session.committedEvents)`, `server.ts:1141`) **before** attachment loading; build `refs` only from `user/message` events with `seq > (seed?.coversSeq ?? 0)`.
<!-- Red Team: A3/B6 — chunk-content assertion passes before the fix -->
2. Test (`tests/web/server-compaction.spec.ts`): `vi.spyOn(AttachmentStore.prototype, 'load')` (store is a local instance, `server.ts:612`, so prototype spy is the seam). Upload attachment A in turn 1, compact, upload B in turn 2, compact again. Assert the `refs` argument of the **compaction-time** call (identify by being called inside the compact route — record calls between the second `fetch(…/compact)` start and response) contains B's id and not A's. This fails before the fix.
3. Out of scope (follow-up): per-request attachment loading of the whole log (`server.ts:2312-2314`, red-team A7).

## Verification
- `npx vitest run tests/harness/compaction-reliability.spec.ts tests/harness/g3-compaction.spec.ts tests/web/server-compaction.spec.ts`
- `npx vitest run tests/harness/compaction-context-reliability.spec.ts tests/harness/g3-context.spec.ts tests/harness/g5-prompt-contract.spec.ts`
- `npm run typecheck`; full `npm test`

## Success Criteria
- [x] Web request path runs `recoverCanonicalCheckpoint` once per request (host side only).
- [x] Cache rebuild tests (`compaction-reliability.spec.ts:128-138`, `server-compaction.spec.ts:209`) unchanged and green.
- [x] Incremental compaction does not load pre-seed attachments (spy-based failing-first test).
- [x] Full suite + typecheck green.
