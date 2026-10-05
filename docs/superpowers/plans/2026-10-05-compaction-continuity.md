# Compaction Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair full-history summarization and continuity, then safely rebuild the affected live session checkpoint.

**Architecture:** Sequential bounded summarizer calls fold every source chunk into an accumulated summary; errors prevent publication rather than authorizing partial coverage. The context builder retains a covered raw tail and all uncovered history, with explicit same-session framing. Recovery uses the existing compact endpoint after backup and verification.

**Tech Stack:** TypeScript, Vitest, existing OpenAI-compatible stream provider, JSONL/checkpoint storage.

**Spec:** `docs/superpowers/specs/2026-10-05-compaction-continuity.md`

## Global Constraints

- Preserve 200,000 characters as the maximum conversation-source payload per summarizer request, including accumulated summary; preserve 24,000 characters as the maximum returned summary.
- Original JSONL is immutable as an existing prefix; normal lifecycle appends are permitted. Do not promote summaries into memory.
- Keep existing API response and checkpoint schema compatible.
- Preserve unrelated dirty UI changes. No automatic commits or live server restart without checking the running process and obtaining approval if it would interrupt other work.
- Do not commit user logs or secrets; do not automatically send a follow-up message to the live session.

## Review Focus

- Oversized single tool output and Unicode chunk boundaries: every source character is processed in chronological order without splitting a surrogate pair.
- A later chunk failing after successful earlier chunks: no new checkpoint is eligible and original history remains intact.
- No-model fallback or explicit `maxChars` cap: reject insufficient bounds rather than claim omitted source was summarized.
- Tail zero and more than four uncovered turns: uncovered decisions survive; covered raw tail is optional.
- Provider wire serialization: both system instructions and lower-trust summary reach the local HTTP adapter; external gateway behavior remains separately unverified.

---

## File map

- `src/web/llm-summarizer.ts`: bounded sequential folding and strict output/fallback limits.
- `src/harness/context/compaction.ts`: complete-source coverage contract and fail-closed explicit cap; structured prompt update.
- `src/harness/context/builder.ts`: covered raw tail, uncovered history, continuation framing.
- `src/harness/limits.ts`: update tail option documentation if necessary, not the default value.
- Tests: `tests/web/llm-summarizer.spec.ts`, `tests/harness/g3-compaction.spec.ts`, `tests/web/server-compaction.spec.ts`, `tests/harness/llm-openai.spec.ts`.
- `docs/harness.md`: revised retention/summarizer contract.
- `docs/compaction-continuity-recovery-2026-10-05.md`: sanitized operational recovery evidence, created during execution.

### Task 1: Summarize all source without silently authorizing partial coverage

**Files:** Modify `src/web/llm-summarizer.ts`, `src/harness/context/compaction.ts`; test `tests/web/llm-summarizer.spec.ts`, `tests/harness/g3-compaction.spec.ts`.

**Interfaces:** Consume existing `StreamFn(request: ModelRequest): AsyncIterable<StreamEvent>`, `Summarizer({text, model?}): Promise<string>`, `compactSession(session, checkpoints, summarizer, options): Promise<CompactionCheckpoint>`. Keep public signatures and checkpoint v1 unchanged; `maxChars` becomes a rejecting source cap rather than a slicing permission.

- [ ] **Step 1: Add failing summarizer regression tests.** Build a synthetic >1.1M-character transcript with markers at start, middle, and end, ending with `44f6ada`, `60 suites / 1.204 tests`, and four pending items from the spec. A scripted stream records each request, returns a compact evolving summary, and proves concatenating newly submitted source chunks reproduces the original transcript exactly. Assert each source payload including prior summary is <=200,000 characters; later calls carry prior output; final output includes latest-state markers. Add an oversized single-line input and emoji at a chunk boundary. Do not use real user logs.
- [ ] **Step 2: Add failure assertions.** Replace the existing suffix-truncation expectation: >24,000 output throws, including a single oversized delta; no further deltas are consumed after detecting overflow. Empty output or a second-call exception rejects. No-model fallback returns exact small input and rejects input over 24,000 rather than returning its first 120 lines. A `compactSession` test with insufficient `maxChars` expects rejection, no successful end/new checkpoint, and intact JSONL prefix. A later-chunk failure test preserves the previous checkpoint.
- [ ] **Step 3: Run RED.** `npx vitest run tests/web/llm-summarizer.spec.ts tests/harness/g3-compaction.spec.ts`; new complete-source and fail-closed tests must fail against current prefix slicing.
- [ ] **Step 4: Implement sequential folding in `createCompactionSummarizer`.** Keep short-input single-call prompt compatible. For later calls place accumulated summary in an explicit separate reference envelope and the next source chunk in `<conversation>`. Reserve its length plus envelope overhead before choosing new chunk size; prefer newline boundaries and avoid splitting UTF-16 surrogate pairs. Update the prompt to merge earlier summary with newer source, resolve superseded state, and preserve current task, exact identifiers and pending work. Enforce 24,000 output during streaming; reject oversize/empty outputs. `extractiveSummary(text: string): string` keeps exact bounded source or throws; `compactSession` rejects source above explicit `maxChars` instead of slicing.
- [ ] **Step 5: Run GREEN.** Re-run the Task 1 command; all tests pass. Do not commit automatically.

### Task 2: Preserve covered tail and all uncovered history

**Files:** Modify `src/harness/context/builder.ts`, option comments in `src/harness/limits.ts`, `docs/harness.md`; test `tests/harness/g3-compaction.spec.ts`.

**Interfaces:** Keep `BuildContextInput.compaction?: {summary: string; coversSeq: number}` and `compactionTailTurns?: number`. Interpret tail as latest covered completed turns retained raw; uncovered history is always eligible until existing budget trimming. Default remains four.

- [ ] **Step 1: Update/add failing window tests.** In existing `TAIL_LOG`, checkpoint seq 5/tail 0 must include second, third, fourth and open turns, but not first request; no `compaction tail dropped` omission. Checkpoint seq 18/tail 1 must retain fourth request/answer plus open turn with included range beginning at fourth turn start. Add >4 uncovered completed turns with a decision marker in the first: marker survives without budget pressure. Covered-tail tool call/result survive together. Assert no-checkpoint and history none/recent behavior unchanged. Add low-budget fixture proving whole-turn budget drops remain recorded and open task survives.
- [ ] **Step 2: Run RED.** `npx vitest run tests/harness/g3-compaction.spec.ts`; new uncovered-history and covered-tail assertions fail.
- [ ] **Step 3: Implement `historyWindow` semantics.** Find starts of completed turns covered by the checkpoint; if tail positive, retain at most that many latest covered turns by starting at their oldest retained start. With zero covered tail start at `coversSeq + 1`. Never advance past uncovered turns merely to limit count. Remove obsolete tail-drop omission machinery where unused, and preserve current-turn safety. Add trusted framing before the lower-trust summary: `This is the same conversation continuing after compaction, not a new session. Use the compacted history as reference for prior work; recent raw conversation may supersede it.` Do not embed summary instructions in authoritative text.
- [ ] **Step 4: Update documentation.** Explain covered raw duplication, all uncovered history, explicit budget omissions, chronological folding and strict fallback/output errors; remove old statements saying older uncovered turns drop after four.
- [ ] **Step 5: Run GREEN.** `npx vitest run tests/harness/g3-compaction.spec.ts tests/harness/g3-microcompact.spec.ts`; all tests pass. Do not commit automatically.

### Task 3: Prove end-to-end continuity and local wire preservation

**Files:** Test `tests/web/server-compaction.spec.ts`, `tests/harness/llm-openai.spec.ts`; adjust Task 1–2 implementation only for demonstrated defects.

**Interfaces:** Consume existing compact endpoint `POST /api/workspaces/:ws/sessions/:id/compact`, unchanged `{coversSeq, summaryChars}`, existing server test provider and adapter fetch interception.

- [ ] **Step 1: Add regression tests before adjustments.** Extend scripted web fixture with long source, late latest-state markers and continuation `Còn vấn đề gì không`. Record summarizer and next-turn requests; assert all long-source portions are submitted, final checkpoint contains current markers, next request contains summary + recent raw tail + same-conversation framing, same session ID, and original JSONL prefix intact. Second-chunk failure returns 409 and does not replace previous checkpoint. Adapter fetch test sends base system, wrapped compaction system and a user message; assert serialized HTTP `messages` retains both system blocks in order. Do not make live paid provider calls in tests.
- [ ] **Step 2: Run targeted verification.** `npx vitest run tests/web/server-compaction.spec.ts tests/web/llm-summarizer.spec.ts tests/harness/g3-compaction.spec.ts tests/harness/g3-microcompact.spec.ts tests/harness/llm-openai.spec.ts`; expected all pass.
- [ ] **Step 3: Run broad checks.** `npm run typecheck` and `npm test`; report actual results, distinguish unrelated failures using existing evidence or a non-destructive baseline comparison, never stash unrelated UI work casually.
- [ ] **Step 4: Obtain fresh whole-change review.** Reviewer checks chunk coverage, output bounds, history pairing, omission honesty and live recovery safety. Resolve verified findings, rerun affected checks, record tested revision/diff. No commit without explicit request.

### Task 4: Safely restore the named live session

**Files:** Create sanitized `docs/compaction-continuity-recovery-2026-10-05.md`; backups outside repository. No direct JSONL editing.

**Interfaces:** Updated server compact endpoint; `CheckpointStore` remains keyed under `<home>/workspaces/<session-id>/checkpoints`, actual log under `<home>/workspaces/<workspace-id>/sessions/<session-id>/events.jsonl`.

- [ ] **Step 1: Inspect live runtime without mutation.** Identify listener process/port, whether it serves updated sources, authentication requirements, and session idle status. Do not expose provider credentials. If applying code requires restarting a shared process, request approval; leave recovery pending until resolved.
- [ ] **Step 2: Back up verified idle session data.** Copy current checkpoints and original JSONL to a timestamped private backup under `~/.dnt-harness/backups/`; record original prefix byte length and SHA-256. Session: `session-muth6xq0uluol5`, workspace: `ws-mur65pzr745ftn`. Do not delete old checkpoint; successful recompact can publish a newer one.
- [ ] **Step 3: Recompact using updated server.** POST compact once through authenticated loopback endpoint. Failures remain explicit; do not install a guessed summary or send a user message. Record the successful new boundary and summary length, or leave recovery clearly blocked.
- [ ] **Step 4: Validate recovery without starting an agent.** Check new summary accurately retains pre-compact `44f6ada`, `60 suites / 1.204 tests`, Phase 3/runtime status and four remaining work items; account for later agent claims as later statements, not proof those earlier items were resolved. Verify original JSONL bytes are still an identical prefix and no user/message was appended. Build context offline against the new checkpoint and verify latest raw covered tail and continuation framing are present.
- [ ] **Step 5: Record sanitized evidence and remaining gateway uncertainty.** Include commands/results, backup location, prefix hash, boundary, and local wire test verdict. An unobserved external gateway remains unverified; do not call that fixed merely because manifest records a block. Report implementation, checks and recovery status to the user.
