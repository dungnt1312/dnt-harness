# Compaction Reliability Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make completed-boundary compaction fail closed, retain actual work, and activate safely in the web host.

**Architecture:** Share canonical message projection, validate summarizer completion, make durable lifecycle facts authoritative for rebuildable atomic cache, and reserve each web session during summarization. Capture fresh pre-trim pressure and trigger automatic compaction only after an eligible turn.

**Tech Stack:** TypeScript, Vitest, existing LLM request lifecycle and JSONL storage.

**Spec:** `docs/superpowers/specs/2026-10-06-compaction-reliability-repair.md` (approved by user instruction to proceed without further questions).

## Global Constraints

- Preserve unrelated dirty changes. Do not commit, restart a live server, invoke paid/live providers, modify live checkpoints, or send live follow-up messages automatically.
- Preserve the existing JSONL prefix and same-session identity. Summary is lower-trust reference data, never promoted to memory.
- Retain chronological folding of every source character, 200,000-character input request envelopes, and 24,000-character output summaries. Input limits are not token-window guarantees.
- Preserve the compact endpoint response shape and decode existing lifecycle/checkpoint formats without inventing missing provenance.
- Keep compaction at completed boundaries. Do not rewrite an active turn to recover context pressure.

## Review Focus

- Missing or unsuccessful completion must not authorize replacing history.
- Cache interruption must leave canonical successful summary recoverable.
- Rewritten tools and attachments must survive summary projection.
- Queued messages and cancellation must not overlap or resurrect summary ownership.
- Trimmed pressure and stale manifests must not suppress or repeat automatic attempts.

## File map

- `src/web/llm-summarizer.ts`: strict completion and bounded answer collection.
- `src/harness/session/events.ts`: shared dated canonical projection.
- `src/harness/context/compaction.ts`: source/summary validation, canonical recovery, atomic cache and core transaction exclusion.
- `src/harness/context/builder.ts`: shared projection, coverage validation and pre-trim pressure.
- `src/harness/limits.ts`: zero-capable configuration.
- `src/web/server.ts`: host reservation, attachments, attribution/cancellation, fresh automatic trigger.
- `src/bins/web.ts`: standard-host pressure 0.85.
- Context/web tests and docs: regression evidence and revised contract.

### Task 1: Strict summarizer and canonical compaction storage

**Files:** Modify summarizer, session events, compaction; tests `tests/web/llm-summarizer.spec.ts`, `tests/harness/g3-compaction.spec.ts`, new `tests/harness/compaction-reliability.spec.ts`.

**Interfaces:** Preserve `compactSession` with optional attachments/signal input. Export shared dated projection and valid canonical checkpoint recovery; allow `CheckpointStore.latest(sessionId, events?)` to validate/rebuild against session facts. Keep v1 cache shape.

- [x] Write parameterized regressions for unsuccessful/missing/duplicate completion, output after completion, toolCalls, empty/oversized custom summary, rewritten calls, attachments, concurrent compaction, cancelled publication, cache failures and legacy/invalid coverage.
- [x] Run targeted suites and confirm each new behavior fails before implementation.
- [x] Implement strict stream validation using `validateCompletion`; shared projection; core bounds/exclusion; durable successful end before atomic cache publication. Recover only qualifying canonical facts and ignore invalid cache.
- [x] Update existing successful scripted streams to emit declared completion; retain chunk bounds and prefix invariance tests.
- [x] Run targeted suites; expected all pass. No commit.

### Task 2: Truthful context pressure and tail configuration

**Files:** Modify builder/limits; tests context compaction/microcompact and limits.

**Interfaces:** Consume Task 1 shared dated projection. Add optional `budget.preTrimTokens` preserving existing manifest fields. Keep configured tail default four; allow zero. Reject unchecked invalid coverage without deleting uncovered history.

- [x] Write failures for rewritten tool projection, zero tail override, malformed/future/active coverage, oversized covered duplication fitting by whole-turn removal, pre-trim pressure exceeding post-trim usage.
- [x] Run targeted suites to confirm RED.
- [x] Implement shared projection and coverage validation, capture pre-trim cost, accept zero-capable limits; preserve uncovered/open history pairing and explicit omissions.
- [x] Run context/limits suites; expected all pass. No commit.

### Task 3: Serialized host compaction and automatic enablement

**Files:** Modify server, web bin; tests `tests/web/server-compaction.spec.ts`, lifecycle/server tests; docs harness/web.

**Interfaces:** Consume Task 1 cache validation and options, Task 2 pressure. Use existing session dispatch queue and LLM stream options/session attribution with configured deadlines. Manual compact returns conflict for duplicate/active reservation and retains API success response.

- [x] Write failures for gated concurrent compact, queued follow-up, Stop/delete/shutdown cancellation, attachments and rebuilt cache on next request, explicit auto disable and fresh pre-trim auto pressure with boundary deduplication.
- [x] Run server compaction suites and confirm RED.
- [x] Implement one host reservation shared by manual/automatic paths including hooks; defer queued execution until reservation settles, propagate cancellation/attribution and load attachments. Trigger only eligible completed turn with fresh compact-mode pressure. Enable 0.85 in standard web bin only.
- [x] Update docs: canonical end authority, cache recovery, strict completion, estimated pre-trim pressure, four optional covered tail turns, zero disable, next-request manifest semantics, headless deferred.
- [x] Run targeted suites; expected all pass. No commit.

### Task 4: Whole-change verification and independent review

- [x] Run `npm run typecheck`, `npm test`, `npm run build:web`; record exit codes and named failures. Preserve baseline evidence for unrelated work.
- [x] Dispatch fresh reviewer against baseline diff, spec and plan; address Important/Critical findings with failing regressions first and rerun suites.
- [x] Report exact verified scope, deferred findings and operational limitations; no restart/live recovery/commit.
