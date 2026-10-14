# Task 1: Typed projection và source policy

Worktree `/Users/dungnt/workspace/dnt-harness/.worktrees/effective-context-compaction`; timezone Asia/Saigon; reports Vietnamese, code English. Read this first: it is requirements with exact values. Approved spec: parent `plans/261013-2237-effective-context-compaction/spec.md`, sections 4–5 only as context.

Ownership: create `src/harness/context/compaction-projection.ts`, `tests/harness/compaction-projection.spec.ts`; modify `src/harness/context/builder.ts`, `src/harness/session/events.ts` if necessary; extend `tests/harness/g3-microcompact.spec.ts`. No other product changes unless needed for type exhaustiveness; explain them. No subagents, commits, paid providers, deploy/restart, live data edits. Do not touch parent checkout or other worktrees.

`AssembledContext` adds compactionProjection. Never parse manifest.omissions strings to make policy.

```ts
export type ProjectionLoss =
  | { kind: 'tool-result-cleared'; seq: number; callId: string; policyVersion: 1 }
  | { kind: 'uncovered-history-dropped'; fromSeq: number; throughSeq: number }
  | { kind: 'regenerable-section'; source: string; hash: string }
  | { kind: 'unknown'; reason: string }
export interface CompactionProjection {
  v: 1; policyVersion: 1; history: 'none' | 'recent' | 'compact'
  seed?: { coversSeq: number; hash: string }
  sources: readonly { messageIndex: number; seq: number; turnId: string }[]
  losses: readonly ProjectionLoss[]
}
export type Eligibility = { ok: true } | { ok: false; reason: string }
export function assessProjection(events: readonly SessionEvent[], cutoff: number,
  projection: CompactionProjection): Eligibility
```

TDD: add failing tests for uncovered turn refusal, unknown loss, missing prior seed, seed+delta coverage, invalid history mode, forged/unsafe clear, effective tool-call args, paired parallel results. No seed requires every content event through completed cutoff represented. Ignore metadata-only event churn.

Fixture-generated assert:
```ts
expect(assessProjection(events, cutoff, {
  ...projection,
  losses: [{ kind: 'uncovered-history-dropped', fromSeq: 1, throughSeq: cutoff }],
})).toEqual({ ok: false, reason: 'uncovered-history-dropped' })
```

Run RED then GREEN:
`pnpm --dir <worktree> exec vitest run tests/harness/compaction-projection.spec.ts tests/harness/g3-microcompact.spec.ts tests/harness/g3-context.spec.ts`

Attach source mapping at builder construction to actual assembled request message indices. Emit typed losses at microclear/section-drop/turn-drop sites. Protect unread batch, error results, question/approval/state/child deliverables. MCP output not automatically reproducible by mcp__ name; no rerun side effects. If clear safety needs original event output/error metadata, use it rather than inferring absence of errors from message content.

Ruling: final answer is added by capture promotion (Task 3); assessProjection itself requires complete coverage at cutoff, so an unpromoted final request may be ineligible and caller adds final answer evidence after durable turn. Expose structural seed hash helper if needed, based on canonical summary identity, not ephemeral metadata. Keep old string omissions for UI compatibility alongside typed losses.

Baseline on worktree: 110 tests passed across compaction reliability/context reliability/microcompact/summarizer/server compact. Use codebase-retrieval before edits; if index unavailable, record and use scoped Read/Grep. Do not weaken existing assertions to green tests; correct changed policy expectations with explicit new regression.

Self-review changed files, run typecheck or report concrete errors; report full evidence including commands/results, APIs, changed files and concerns to parent `plans/261013-2237-effective-context-compaction/task-1-report.md` (absolute parent path). Return only DONE/DONE_WITH_CONCERNS/BLOCKED/NEEDS_CONTEXT, files and one-line test summary. No commits.
