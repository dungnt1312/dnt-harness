# Task 6 report — preview ≡ canonical regression matrix

Worktree `.worktrees/ctx-task6`, branch `fix/ctx-task6` (base f525b88). Commit: `test(context): preview and canonical parity matrix` (hash in the final message / `git log -1`).

## Changed
- `tests/harness/context-preview.spec.ts` — kept the 3 existing tests (now share a typed `inputOf`), added 6 in `post-compaction preview equals canonical`. No production code changed.

## How parity is checked
`previewThenCommit`: freeze `session.committedEvents` → `buildContextPreview(frozen, {checkpoint, restoration})` → real `adoptPreparedCompaction` (in-memory `Session`, `restore` returns the same restoration) → `recoverCanonicalCheckpoint` → `buildContext` on the committed log with the recovered checkpoint. No user message is added between. `expectParity` compares messages, tools, `manifest.budget`, `breakdown`, `manifest.sections`, `sections` (hashes), and the full manifest (incl. `history`) with only `includedSeqRange`/`omittedSeqRange` ignored.

## Cases
1. Parity (tools, Read results, restoration `RESTORED_NEW` once, tail kept).
2. Microcompaction: 12×16k Read results at a 30k window; preview and canonical both clear `12 - MICROCOMPACT_KEEP_RECENT`, `preTrimTokens > availableTokens`, `tool-results:` omission present.
3. Attachments: image + text in the retained covered user message and in the uncovered tail; each marker appears once, 2 image parts, `breakdown.messages` equals the sum of message estimates and lies in [2×, 3×) `IMAGE_TOKEN_ESTIMATE` (each image counted once).
4. Restoration replacement: `RESTORED_OLD` committed, then `RESTORED_NEW`; both preview and canonical have exactly one `RESTORED_NEW`, no `RESTORED_OLD`.
5. Summary growth: 20k-char summary over a tiny covered range; `usedTokens` and `breakdown.messages` exceed the pre-compaction values (not clamped).
6. Protect tail: `protectUncoveredHistory` + 8k window throws `compaction-preview-no-fit`; the unprotected build of the same input has an `uncovered-history-dropped` loss and no `TAIL_TURN`, which shows the guard matters.

## Verification
- `pnpm exec vitest run tests/harness/context-preview.spec.ts tests/harness/compaction-restoration-context.spec.ts tests/harness/g3-microcompact.spec.ts tests/harness/g3-context.spec.ts tests/harness/g5-prompt-contract.spec.ts --maxWorkers=1 --no-file-parallelism` → 5 files, 86 tests pass.
- `pnpm run typecheck` → clean.
- Full `pnpm test` not run.

## Finding (not fixed: outside the builder path)
Case 4 first failed: committing a second adoption whose cutoff lies **after the standing checkpoint's `coversSeq` but before that checkpoint's own `compaction/*` events** (e.g. t1 covered, t2 closed during the first compaction transaction, cutoff = end of t2) succeeds in `adoptPreparedCompaction`, but `recoverCanonicalCheckpoint` rejects it and keeps the older checkpoint.
- Cause (`src/harness/context/compaction.ts`): `adoptPreparedCompaction` writes `seedHash` of the *current* checkpoint (line ~409), while `adoptionProven` recomputes the seed from `events.filter(seq <= end.coversSeq)` (line ~74). The first checkpoint's end event sits after that cutoff, so recovery sees no seed and the proof mismatches.
- Effect: `adoptPreparedCompaction` returns/saves a checkpoint that the committed log does not recognise. This is a shared-adoption bug, not a preview bug, and the brief limits fixes to the builder, so I left it. The test avoids it by choosing a cutoff after the first compaction's events (t3), with a code comment.
- Suggested fix: have adoption refuse such a cutoff (`current.coversSeq < cutoff` but `current`'s end seq > cutoff), or make recovery's seed lookup use the checkpoint standing at the end event's position.

## Unresolved
- Should the adoption/recovery seed mismatch above get its own task?

## Fix round 1
- tests/harness/context-preview.spec.ts: replacement case keeps the first commit's canonical and asserts RESTORED_OLD appears exactly once before the replacement; removed redundant `cleared(canonical)` assertion (expectParity covers it).
- `pnpm exec vitest run tests/harness/context-preview.spec.ts --maxWorkers=1 && pnpm run typecheck` → 9/9 passed, typecheck clean.
- Commit 1be1a04 `test(context): prove the replaced restoration was visible first`.
