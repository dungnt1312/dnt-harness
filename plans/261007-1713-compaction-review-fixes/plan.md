---
title: "Compaction review fixes"
description: "Fix seed loss in extractive fallback, re-ask length/budget, futile contextExceeded retries, summarizer delimiter forgery, duplicate per-request checkpoint scan and compaction attachment over-load (2026-10-08 review + red team)."
status: completed
priority: P1
effort: 6h
branch: main
tags: [compaction, context, reliability, perf]
blockedBy: []
blocks: []
created: 2026-10-08
---

# Compaction review fixes

## Overview

Review of the session compaction feature (2026-10-08) found five actionable defects.
Pipeline under change: `runCompaction` (`src/web/server.ts:1094`) → `compactSession`
(`src/harness/context/compaction.ts:169`) → `createCompactionSummarizer`
(`src/web/llm-summarizer.ts:45`); request-time consumption in `buildContext`
(`src/harness/context/builder.ts:381`) via `checkpoints.latest` (`src/web/server.ts:2304`).

| # | Finding | Severity | Phase |
|---|---------|----------|-------|
| F1 | No-model extractive fallback ignores `seed` → incremental compaction replaces old summary with delta only (silent context loss; reproduced with a probe test) | Medium | 1 |
| F2 | Re-ask prompt reports `summary.length` captured *before* the overflowing delta → for a single oversized delta it reports **0** characters "over the limit"; never a number above the cap | Low | 1 |
| F3 | Summarizer wrapper retries `contextExceeded` errors with identical input (up to 4×, with backoff) — `LogicalRequest.canRetry` treats `contextExceeded` as retryable for the agent-loop squeeze path | Low | 1 |
| F4 | `recoverCanonicalCheckpoint` (O(E × compactions)) runs twice per request (`checkpoints.latest` on committed log + `validCompactionCoverage` on live log) — fix: host attests, builder does cheap boundary check only | Low/perf | 2 |
| F5 | Compaction loads attachments for **every** `user/message`, though incremental fold projects only `seq > seed.coversSeq` | Low/perf | 2 |
| F6 | Summarizer envelope (`<earlier-summary>`, `<conversation>`) interpolates content verbatim → forged closing tags escape the reference block (red team B2) | Medium | 1 |

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Incremental compaction never loses covered context on any summarizer path | P1 |
| 2 | Summarizer re-ask/retry behavior is truthful, within input budget, and bounded to useful attempts; envelope delimiters unforgeable | P2 |
| 3 | One canonical checkpoint scan per request (was two); cache-repair semantics unchanged | P3 |

## Non-goals

- Changing the 24k summary cap (`MAX_COMPACTION_SUMMARY_CHARS`), chunk size, or prompt headings.
- Summary saturation metrics, tool-result truncation in `projectForSummary`, async automatic compaction (review item #6 — design follow-ups, separate plan).
- Changing `LogicalRequest.canRetry` semantics for the agent loop.
- Memoizing `recoverCanonicalCheckpoint` or skipping checkpoint file reads (rejected by red team).
- Per-request attachment loading of the whole log (`src/web/server.ts:2312-2314`) — follow-up.

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | [Phase 1: Summarizer correctness](./phase-01-summarizer-correctness.md) | Completed | — |
| 2 | [Phase 2: Checkpoint & attachment cost](./phase-02-checkpoint-attachment-cost.md) | Completed | 1 (shares `src/web/server.ts`, `runCompaction`) |

## Success Criteria

- [x] F1–F6 each covered by a failing-first test that now passes (F4 is a refactor: covered by retained + new validation tests).
- [x] `npx vitest run tests/web/llm-summarizer.spec.ts tests/web/server-compaction.spec.ts tests/harness/compaction-reliability.spec.ts tests/harness/g3-compaction.spec.ts tests/harness/compaction-context-reliability.spec.ts web/hooks/useSessionStream.compaction.spec.ts` green.
- [x] `npm run typecheck` clean; full `npm test` green.
- [x] No change to the event schema (`compaction/start`, `compaction/end`) or checkpoint JSON format.

## Notes

- Working tree on `main` is dirty with unrelated changes (`src/web/server.ts` has 43+/11− unrelated diff). Implementation must not revert or reformat those hunks; stage only compaction hunks when committing.

## Red Team Review

Session 2026-10-08. Reviewers: A = Assumption Destroyer (`cliproxy:claude-opus-5-5`), B = Security Adversary (`cliproxy:gpt-6-sol`). Tier: Light (2 phases). 15 findings → 13 accepted, 2 rejected. User prompt expired; dispositions applied per adjudicator recommendation.

| # | Finding | Sev | Disposition | Applied to |
|---|---------|-----|-------------|------------|
| A1 | F4 memo never hits: live vs committed arrays; committedLog re-sliced per barrier (`server.ts:2304,2309,2336`; `session.ts:169`) | High | Accept — F4 redesigned to remove duplicate scan | Phase 2 |
| A2/B4 | In-memory skip of checkpoint file read breaks missing/corrupt cache rebuild (`compaction.ts:103-108`) | Med | Accept — skip dropped | Phase 2 |
| A3/B6 | F5 chunk-content test passes before fix (`compaction.ts:213,249`) | High | Accept — prototype spy on `AttachmentStore.load` | Phase 2 |
| A4 | Extractive seed+delta over cap → permanent failure + lifecycle event spam (`compaction.ts:205,236-241`; `server.ts:1170-1176`) | High | Accept — preflight before `compaction/start` | Phase 1 |
| A5 | F2 wording breaks `llm-summarizer.spec.ts:169`; bug reports 0 not 23987; `produced` scoping | Med | Accept | Phase 1 |
| A6 | F3 test must throw `ProviderError` pre-delta; cover headers path (`request-lifecycle.ts:114,180`) | Med | Accept | Phase 1 |
| A7/B5 | (array, length) key unsafe for exported API / in-place mutation | Med | Accept — moot (memo dropped) | Phase 2 |
| A8 | F4 tests vacuous; missing `g3-compaction.spec.ts` | Med | Accept — tests replaced, spec added to verification | Phase 2 |
| B1 | Extractive concat lacks provenance → injected role labels | Med | Reject — extractive output was already raw source; request-time `wrapUntrusted` (`builder.ts:271-282,452-459`) unchanged; F6 covers summarizer envelope | — |
| B2 | Summarizer delimiter forgery (`llm-summarizer.ts:59-62`) | High | Accept — new F6 | Phase 1 |
| B3 | Re-ask exceeds 200k input budget (`llm-summarizer.ts:63-66,74-75`) | Med | Accept — `REASK_RESERVE` | Phase 1 |
| B7 | Per-request attachment loading of whole log (`server.ts:2312-2314`) | Med | Reject for this plan — out of scope, recorded as follow-up | Non-goals |

### Whole-Plan Consistency Sweep
- Decision delta: F4 memo → host attestation; F6 added; F1 preflight (`extractiveCap`); F2 wording `at least N`; `REASK_RESERVE`; Phase 2 depends on Phase 1.
- Searched plan files for `WeakMap`, `memo`, `Map<sessionId`, `previous answer was`, `extractive: true`, `F1–F5`: stale occurrences only in this Red Team table, Phase 1 F2 step 3 (the old assertion being replaced), and Phase 2's "Design decision (post red-team)" note (intentional history).
- Overview table, goals, non-goals, phase dependencies, success criteria and verification commands reconciled.
- Unresolved contradictions: none.

<!-- slug: compaction-review-fixes -->
