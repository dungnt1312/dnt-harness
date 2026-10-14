# Compaction: where the time went, and what was changed

Date: 2026-10-14. Branch `fix/compact-live-acceptance` (worktree `.worktrees/compact-live-acceptance`). Nothing is committed, merged or deployed.

## Outcome

Compacting the same session now takes **374 s instead of 966 s** end to end (342 s of model streaming, 5 requests instead of 14), and it has never failed on the 24,000-character cap since the change. The earlier fix made the compaction pass; this change removes most of what made it slow.

This is one live run of the final code. It is not a 3/3 stability result.

## What the review found

The 2.01 million characters the fold had to read were not conversation. Typed user text and assistant answers were about 2.5 %. The rest was tool arguments (36 %, mostly whole file bodies in `Write`/`Edit` and long `Bash` scripts) and tool results (about 60 %, mostly `Read`, `Agent`, `Bash` and `Edit` output). The summarizer was re-reading files the agent had already written to disk. That produced 10 to 13 sequential chunks, each re-writing the whole running summary at about 160 output tokens per second, which is where the minutes went. The 24,000 limit was only where it first showed.

## Changes

1. `projectForSummary` (`src/harness/context/compaction.ts`) keeps typed user text and assistant answers whole. A tool argument value over 600 characters keeps its first 200 and a measured note (`<N chars omitted>`). A tool result over 1,500 characters keeps its head and tail and a note. The summarizer is told what it did not read; nothing is dropped silently.
2. The recovery confirmation's call estimate now uses the same projection, so the number the user approves is the number that runs.
3. The shipped web bin turns `compactionEffectiveEnabled` on (`src/bins/web-limits.ts`). Background precompute stays off. The automatic compaction threshold (0.85) is unchanged, as requested. Library defaults for embedded hosts are unchanged.

Tests written first and seen failing: `compaction-summary-source.spec.ts` (7), `web-bin-limits.spec.ts` (3), and one new case in `compaction-source.spec.ts`.

## Live measurement (same session copy, cutoff 25891, `claude-sonnet-5-5`)

| | Before reduction | After reduction |
|---|---:|---:|
| Source the summarizer reads | 2,035,031 chars | 837,773 chars |
| Summary requests | 14 | 5 |
| Model streaming time | 966.5 s | 342.3 s |
| Whole probe | 988 s | 374 s |
| Input / output tokens | 1,049,285 / 155,422 | 434,095 / 53,454 |
| Summary | 10,747 chars | 14,056 chars |
| Repair needed | yes (1) | no |
| Stored, reopened from disk, continuation `stop` | yes | yes |

I read the summary and the continuation answer. Constraints and decisions (port Zed 1:1, run real git commands, never push or restart without approval, protect unrelated uncommitted files), the final merge state and the open decisions all survived, and the answer says plainly that it did not check the repository since then. This is a sampled read, not proof of equivalence over 2 MB.

Cap choice: results at 4,000 characters left the source at 1,048,358 characters (5.3 chunks); 1,500 gave 837,773 (4.2 chunks). I took 1,500. A 1,000 cap was not tried and would trade more detail for speed.

## Risks and limits

- Bulk is no longer visible to the summarizer, so a continuation must `Read` a file again to see its content. The sampled continuation did not depend on file bodies. A task that does is not covered.
- The effective path is on in the web bin, but this run used the legacy fold. The effective path (one request) was NOT run live, so its real speed and its 24,000 limit are unmeasured. If a session has no snapshot (for example every session that existed before this build), the first compaction still asks for slow recovery and then uses the shortened fold.
- 5 requests at about 70 s each are still sequential. The time is output-bound.
- Not tested live: the HTTP server restart, the browser Stop button, progress rows.

## Verification

- `pnpm run typecheck`: clean.
- `pnpm test`: 333 files, 4,212 tests, 4,207 passed, 2 skipped, 3 failed: `server-g1 > steer > delivery:steer stops the running turn…`, `server-g1 > steer > POST /steer runs input a stop left queued…`, `server-g4 > the model delegates for itself…`. All three passed on two reruns of their files, and all three failed intermittently on the base commit before this work.
- `build:web` was not rerun; no web code changed.

## Unresolved questions

1. Should the web bin ship with the effective path on before it has had a live run? The alternative is to keep it off and run one live acceptance first.
2. Is 1,500 characters the right result cap for you, or should it be lower?
3. Do you want a 3/3 stability run on the final code? It costs about 435k input and 53k output tokens per run.
