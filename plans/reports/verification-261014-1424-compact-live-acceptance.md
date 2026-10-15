# Live compaction acceptance — 2026-10-14

## Result

The legacy fold's actual failure was reproduced with `cliproxy / claude-sonnet-5-5`, then a revised draft-repair policy completed the source and produced a durable 10,747-character checkpoint through cutoff 25891. Reopening the file-backed store recovered the same canonical summary; a real model continuation ended with `stop` and preserved sampled constraints and pending work. This is ONE successful run of the final revision, not a 3/3 stability gate. Performance remains slow: summary generation took 966.5 s; the complete probe including continuation took 988.4 s.

Changes exist only on `fix/compact-live-acceptance` in `.worktrees/compact-live-acceptance`. No commit, merge, deployment, live-session write or rollout change was performed.

## Source and safety

Read-only source: session `session-mv5ffu5ceex0a5`, log prefix through 25891, canonical seed through 8840. Exact projected delta: 2,035,031 characters. A separate FileSessionStore in a private temporary directory held each copy. At the end of each run the live log's original byte prefix was checked unchanged. Provider config was consumed by the existing adapter in process; credentials were not printed or copied to reports. Generated summaries contain private conversation data and were not checked into the repository.

No attachment byte loader or live PreCompact hooks were run by the probe. The real-provider run exercised the production legacy summarizer, adapter, LLM service, core compactSession, canonical store recovery and context builder, NOT the complete HTTP/browser path or a full server-process restart. Existing scripted HTTP tests cover that host path separately. Do not describe this as browser E2E acceptance.

## Runs

| Run | Revision | Summary requests | Summary stream time | Result |
|---|---|---:|---:|---|
| Baseline | unchanged | 3 | 238.0 s | chunk 2 and its re-ask crossed 24k; no new checkpoint |
| Trial 1 | complete draft repair, old nine-heading instruction retained | 18 | 1347.1 s | compact succeeded, summary 16,417 chars, store recovery passed; continuation cap 4k caused `length` |
| Trial 2 | same repair revision | 3 | 254.1 s | repair exceeded 24k again |
| Trial 3 | dedicated compression instruction, 12k then 8k targets | 14 | 966.5 s | 13 raw chunks, 1 repair; compact/store recovery/continuation passed |

Trial 1 continuation was rechecked from its existing copied checkpoint (no repeated compaction), with a bounded prompt and 12k output budget: stop, 28.8 s. There were one baseline plus three full post-change trials; no further full model runs were made.

Reported summary usage totals across these runs: 2,423,075 input tokens and 430,762 output tokens. These are LOWER BOUNDS because baseline overflow streams and Trial 2 repair were cancelled before usage arrived. Continuation usage is stored separately in private probe metrics. No monetary charge can be computed from these token totals without actual gateway pricing; unknown usage was not represented as zero spend.

## Root cause and fix

Baseline chunk 1: 20,806 chars, stop. Chunk 2 was interrupted at 24,004 chars; re-ask interrupted at 24,002 chars. The old re-ask resent about 186k characters of raw source and the same exhaustive synthesis instruction. Usage tokens alone had not established this; stream character measurements did.

The fix collects a COMPLETE settled draft with a 96k hard memory bound. Over 24k it sends the draft alone for compression, not raw source, with continuation-focused priorities and a 12k target. One additional repair targets 8k if needed. Last repair still refuses over 24k; no character slicing can authorize a checkpoint. A missing/invalid completion, tool output, tail failure or cancellation still refuses.

The effective generator is intentionally unchanged: this run only verified legacy fold repair. Its original oversize re-ask can still fail; no general model fidelity guarantee is claimed.

## Continuation quality review

The final summary and actual continuation were read manually. Sampled surviving facts: no push without user approval; no restart/deploy of the live server; protect unrelated dirty checkout changes; TDD workflow; Git panel final merge 58b16fe; clean/smudge/LFS issue remains deferred; full main suite had not been run at that historical cutoff; cleanup/push/restart decisions remain pending. Continuation explicitly labels the state historical and unverified since then. This is a sampled review, not exhaustive semantic equivalence of all 2 MB of source.

## Tests

New RED tests demonstrated complete-draft loss after the overflow boundary, invalid completion repair, bounded collection, and second smaller compression. They went GREEN after the corresponding changes. Existing tests that pinned the old same-source re-ask were updated to the deliberate new repair contract; final overflow refusal remains covered.

`pnpm test`: 331 files, 4198 passed, 2 skipped, 1 failed:
`tests/web/path-scope-guard.spec.ts > path-scope guard > executions sharing a model call id keep separate matches`.
Targeted sequential rerun: llm-summarizer, server-compaction, compaction-generator, path-scope-guard — 94 passed. `pnpm run typecheck` passed. No web code changed; build:web was not rerun.

## Remaining gates

- Final revision stability is not 3/3; only the last of three development trials used the final instruction.
- Real HTTP server restart/browser cancel/progress were not retested here.
- Legacy recovery is still slow and expensive; this fix prevents the demonstrated raw re-ask failure, not its sequential-fold cost.
- Effective generator live acceptance and rollout remain pending.
