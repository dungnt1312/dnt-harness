# Task 6 — Post-compaction preview regression matrix

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–5). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/spec.md` §7.1. Plan text: `/Users/dungnt/workspace/dnt-harness/plans/261014-1328-context-accounting/plan.md`, section "Task 4".

This task adds tests. Change production code only if a test exposes a real bug; then fix it in the shared builder path and say so in the report.

`buildContextPreview(input, { checkpoint, restoration?, protectUncoveredHistory? })` in `src/harness/context/builder.ts` must produce exactly what canonical `buildContext` produces once the checkpoint is committed. Extend `tests/harness/context-preview.spec.ts`:

1. **Parity:** run a real compaction commit (`compactSession` or `adoptPreparedCompaction` from `src/harness/context/compaction.ts` with an in-memory session, following `tests/harness/compaction-adoption.spec.ts` fixtures) with summary `SUMMARY` and a restoration; then build canonical with the recovered checkpoint and the same frozen inputs. Compare messages, tools, `budget`, `breakdown`, `history` (ignore only seq-range telemetry), and section hashes with the preview built before commit. Do not add a new user message between them.
2. **Microcompacted tool results:** history with old Read outputs cleared under pressure; preview and canonical agree.
3. **Attachments:** image and text attachments in retained covered user messages and in the uncovered tail are all present; image cost counted once.
4. **Restoration replacement:** a previous restoration `RESTORED_OLD` is replaced by `RESTORED_NEW`; exactly one `RESTORED_NEW` and no `RESTORED_OLD` in messages.
5. **Summary growth:** a summary longer than what it covers can make the estimate larger; the preview reports it, it is not clamped.
6. **Protect tail:** with `protectUncoveredHistory: true` and a budget too small for the tail, it throws `compaction-preview-no-fit`; it never drops uncovered turns.

```ts
expect(after.messages.filter(m => String(m.content).includes('RESTORED_NEW'))).toHaveLength(1)
expect(after.messages.some(m => String(m.content).includes('RESTORED_OLD'))).toBe(false)
expect(() => buildContextPreview(tinyBudgetInput, { ...preview, protectUncoveredHistory: true })).toThrow('compaction-preview-no-fit')
```

## Verify and commit

```sh
pnpm exec vitest run tests/harness/context-preview.spec.ts tests/harness/compaction-restoration-context.spec.ts tests/harness/g3-microcompact.spec.ts tests/harness/g3-context.spec.ts tests/harness/g5-prompt-contract.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Commit: `test(context): preview and canonical parity matrix`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-6-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
