# Compaction Incremental Fold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeated compaction cheap and resilient: seed from the latest valid canonical checkpoint instead of re-folding the entire projection, retry transient summarizer chunk failures, and re-ask once with a hard length constraint when a chunk exceeds the summary cap.

**Root issue being fixed** (evidence: session `session-muurazmurs6jkh`, 5 attempts 2026-10-05→06):

- **A. Full replay:** `projectForSummary()` folds ALL events ≤ boundary; the prior checkpoint is never used as a seed. Attempt #4 folded 3.6M chars for 27 minutes to cover 1,166 new chars, then failed.
- **B. No retry:** summarizer `LogicalRequest` uses `maxAttempts: 1` (`src/web/server.ts`); one transient gateway failure among ~18 sequential chunks discards the whole attempt (attempts #1, #2).
- **C. Uncontrolled accumulation:** a mid-fold chunk that exceeds 24k fails the whole attempt with no re-ask (attempt #4: `compaction summarizer output exceeds 24000 characters`).

**Architecture:** Keep `compactSession` as the transaction owner. Give the `Summarizer` input an optional seed (prior canonical summary + its `coversSeq`); project only the uncovered delta and fold it onto the seed using the existing `<earlier-summary>` merge semantics already used between chunks. Raise summarizer logical-request attempts to `min(4, stepRetries + 1)` mirroring the agent loop. Add one bounded re-ask inside `createCompactionSummarizer` when an oversized answer arrives, with an explicit hard-length instruction. No JSONL, checkpoint-format, or endpoint-shape change.

**Tech Stack:** TypeScript, Vitest.

**Spec deviation (approved by user 2026-10-06, "Làm theo đề xuất, ko cần hỏi lại"):** `docs/superpowers/specs/2026-10-06-compaction-reliability-repair.md` pins "chronological folding of every source character". Incremental folding preserves every character's information via the accumulated checkpoint (produced by the same folding pipeline, same trust level) and folds the delta chronologically. The 200k input envelope and 24k output cap are unchanged.

## Global Constraints

- Do not restart the live web server, invoke paid/live providers, modify live checkpoints or sessions under `~/.dnt-harness/data`, or commit anything. Preserve unrelated dirty changes in the working tree (an in-flight compaction-reliability effort touches the same files; build on top of it, never revert it).
- `compaction/end` remains the only authority; checkpoint JSON stays a rebuildable cache. Existing checkpoint v1 format must load unchanged.
- Idempotence: compacting at an unchanged boundary returns the existing checkpoint without appending lifecycle events or calling the summarizer.
- Fail-closed semantics preserved: empty, non-stop, post-completion, tool-call, still-oversized output never publishes a checkpoint.

## File Map

- `src/harness/context/compaction.ts`: seed input on `CompactionOptions`/`Summarizer`; delta projection in `compactSession`; idempotent no-op at unchanged boundary.
- `src/web/llm-summarizer.ts`: seed-aware first fold; bounded per-chunk retry is host-side (LogicalRequest attempts); cap-aware re-ask with hard length instruction.
- `src/web/server.ts`: seed lookup via `recoverCanonicalCheckpoint`, `maxAttempts: min(4, stepRetries + 1)`.
- Tests: `tests/harness/compaction-reliability.spec.ts`, `tests/harness/g3-compaction.spec.ts`, `tests/web/llm-summarizer.spec.ts`, `tests/web/server-compaction.spec.ts`.
- Docs: `docs/harness.md` compaction section.

### Task 1: Incremental seed from the latest valid checkpoint

**Files:** `src/harness/context/compaction.ts`; tests `tests/harness/compaction-reliability.spec.ts`, `tests/harness/g3-compaction.spec.ts`.

**Interfaces:** Extend `Summarizer` input with optional `seed?: { summary: string; coversSeq: number }`. `CompactionOptions` gains optional `seed` passed through after validation (`validSummary` on the seed summary; seed `coversSeq` must be an existing completed boundary ≤ the new boundary). When a valid seed exists, `compactSession` projects only events with `seed.coversSeq < seq ≤ lastEnd`. Unchanged boundary (seed covers the new `lastEnd` exactly) returns the existing checkpoint material as a new checkpoint write without appending lifecycle events or invoking the summarizer — idempotent.

- [ ] RED: compacting a session whose latest canonical checkpoint covers an earlier boundary projects ONLY the delta (chunk boundary math: first chunk content starts at the first event after `coversSeq`), and the seed summary reaches the summarizer.
- [ ] RED: seed with invalid summary or non-boundary/future `coversSeq` is rejected (fail-closed), not silently ignored.
- [ ] RED: unchanged boundary with a valid seed is a no-op returning the prior checkpoint; no `compaction/start` appended, summarizer not called.
- [ ] GREEN: implement seed validation, delta projection, idempotent no-op.
- [ ] Run targeted harness suites; expected all pass.

### Task 2: Per-chunk bounded retry (host)

**Files:** `src/web/server.ts`; test `tests/web/server-compaction.spec.ts`.

**Interfaces:** Summarizer logical request uses `maxAttempts: Math.min(4, limits.stepRetries + 1)` and inherits the configured first-progress/idle/total deadlines. No change to fail-closed validation after final attempt exhaustion.

- [ ] RED: a summarizer chunk stream that fails transiently once (then emits a valid stop completion) still produces a checkpoint; the retry is visible in the provider stream log.
- [ ] RED: exhaustion after `min(4, stepRetries + 1)` attempts fails closed with the safe error surface (409 + `error` in `compaction/end`, no checkpoint).
- [ ] GREEN: implement; keep attribution/cancellation wiring unchanged.

### Task 3: Cap-aware re-ask inside the summarizer

**Files:** `src/web/llm-summarizer.ts`; test `tests/web/llm-summarizer.spec.ts`.

**Interfaces:** When a chunk's answer would exceed `MAX_SUMMARY_CHARS` (24k), do not fail immediately: discard it and re-issue THE SAME chunk once with an appended hard-length instruction (`Your previous answer was N characters; rewrite the merged summary in at most M characters` where M = cap − headroom). If the re-ask also fails/oversized → fail closed. Cap math unchanged; no truncation.

- [ ] RED: first answer 25k chars → re-ask seen by the stream fn (prompt contains the hard-length line and the same `<conversation>` chunk) → second answer within cap succeeds; final summary is the second answer.
- [ ] RED: oversized twice → fail with the existing error, no partial publication.
- [ ] GREEN: implement re-ask loop (attempt cap 2).
- [ ] Run targeted web suites; expected all pass.

### Task 4: Whole-change verification and docs

- [ ] `npm run typecheck`; `npm test` (or targeted: harness compaction suites + web compaction/summarizer suites); record exit codes and any unrelated failures by name.
- [ ] Update `docs/harness.md`: incremental delta folding from the latest canonical checkpoint, idempotent unchanged-boundary no-op, summarizer retry attempts, cap-aware re-ask. Note the spec deviation approval.
- [ ] Report exact verified scope; no restart/live recovery/commit.
