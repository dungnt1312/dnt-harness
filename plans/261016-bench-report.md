# Benchmark report — dnt-harness vs opencode (real tasks, live model)

Date: 2026-10-16 · Model: `deepseek-v4.1-flash-free` (both harnesses → the same
OpenAI-compatible endpoint) · Runner: `scripts/bench/` (see its README) · Node 22.20.0

## TL;DR

- **Capability parity on a real bug-fix task**: both harnesses fixed the failing
  suite **3/3** (verified by restoring the pristine tests and re-running them, so
  editing tests cannot pass).
- **Loop length**: comparable. dnt-harness used slightly fewer steps (6 vs 7 on
  the fix task; 3 vs 5 on the "does not exist" task); opencode retried more.
- **Context overhead — the biggest difference**: dnt-harness's first request is
  **~4.6k input tokens**; opencode's is **~22.1k** → dnt sends **~4.8× less**
  baseline context (system prompt + tool schemas) on every first request.
- **The branch's prompt fix works**: on the exact "search for an API that does
  not exist" scenario, the branch **halved tool calls (5 → 2)** and **~halved
  time/tokens** vs `main`, while keeping the correct answer.
- **Reliability gap (provider interop)**: ~15% of dnt-harness runs failed the
  whole turn at the protocol boundary (`invalid_tool_input: conflicting tool ID`)
  against this gateway; opencode tolerated the same endpoint on every run.

---

## 1. Head-to-head (3 tasks × 3 reps)

Fixture `scripts/bench/tasks/discount-bug`: a 5-test suite where 2 tests fail
because `src/discounts.js` uses `Math.floor` instead of round-half-up.

| Task | Harness | Success | Prov. faults | Steps (med) | Tool calls (med) | Wall s (med) | In tok (med) | Out tok (med) | 1st-req in tok |
|---|---|---|---|---|---|---|---|---|---|
| fix-bug | dnt-harness | 100% | 0 | 6 | 10 | 21.1 | 36 918 | 1 039 | **4 594** |
| fix-bug | opencode | 100% | 0 | 7 | 10 | 38.1 | 26 618 | 1 150 | **22 101** |
| explain-rounding | dnt-harness | 67%\* | 1 | 3 | 5 | 13.7 | 15 336 | 516 | **4 578** |
| explain-rounding | opencode | 100% | 0 | 3 | 4 | 18.4 | 24 080 | 537 | **22 078** |
| nonexistent-api | dnt-harness | 100% | 0 | 3 | 3 | 10.9 | 14 465 | 534 | **4 583** |
| nonexistent-api | opencode | 100% | 0 | 5 | 4 | 21.9 | 22 812 | 272 | **22 080** |

\* dnt-harness `explain-rounding` 67% is **one provider stream fault**, not a
capability failure (the run produced no model answer). Excluding faults it was 2/2.
The medians in that row were computed by a runner version that still included the
faulted run; excluding it moves the `In tok` median only from 15 336 to ~15 361, so
the row is representative (the aggregator now excludes faults by default).

**Reading the token columns.** `firstRequestInputTokens` is the cleanest
cross-harness number: the input tokens of request #1 = the harness's system
prompt + tool schemas. dnt-harness consistently sends **~4.6k**; opencode
**~22.1k** — a **~17.5k-token head start on every conversation**, i.e. **~4.8×**
less baseline context.

The `In tok` column is **not** directly comparable: dnt sums `prompt_tokens`
(including cache hits), while opencode's `input` excludes cache and reports
`cache.read` separately (opencode read 100k–182k cached tokens across its steps).
opencode therefore pays more on request #1 but re-reads a large stable prefix
from cache; dnt sends a smaller prefix but caches a smaller share of it. Both are
sensible; only `firstRequestInputTokens` isolates the overhead.

**Steps / tool calls / wall time** are comparable and noisy. On the fix task both
took 10 tool calls; dnt did it in 6 steps vs opencode's 7 and ~half the wall time
(21s vs 38s), but opencode's median is inflated by a 57.7s run — endpoint latency
varied 6–57s per request during the run, so treat wall time as indicative only.

Raw artifacts: `%TEMP%\dnt-bench-2026-10-16T15-19-06-901Z` (+ `plans/bench-2026-10-16T15-19-06-901Z.md`).

## 2. Verifying the branch's prompt-discipline change (main vs branch)

Same task run through the harness source on `main` and on this branch (the only
relevant difference is `DEFAULT_BASE_SYSTEM`), 6 reps each:

Task: *"Search this project for a function that validates a field named
`fraudScore` … if it does not exist, say so plainly and stop."*

| Tree | Steps (med) | Tool calls (med) | In tok (med) | Wall s (med) | Correct answer |
|---|---|---|---|---|---|
| `main` | 3.5 | 5 | 16 359 | 16.1 | 5/6 |
| `branch` | 2.5 | 2 | 11 486 | 7.5 | 4/6\* |

\* the two branch misses were **provider stream faults** (no model answer), not
wrong answers. Excluding faults: `main` 5/5, `branch` 4/4 correct.

**Effect reproduced, honestly scoped.** The branch's added lines
("Stop researching once you can answer … never retry it with a slightly different
pattern") cut the tool-call median **5 → 2** and roughly halved time and input
tokens on this scenario. The commit message records a larger effect on a harder
task at effort `max` (**29 steps / 56 calls / 360s → 18 steps / 30 calls / 117s**);
this small fixture reproduces the direction and the tool-call reduction, not that
magnitude.

Raw artifacts: `%TEMP%\dnt-ab-2026-10-16T15-35-04-929Z` (+ `plans/ab-prompt-*.md`).

## 3. Reliability finding — provider stream interop (real gap)

Across ~45 live dnt-harness runs, **~15%** failed the entire turn with:

```
turn/error kind=provider  message="conflicting tool ID"
```

raised at `src/harness/llm/openai.ts:341` (`invalid_tool_input`) when a tool-call
fragment re-uses a stream index with a different id. opencode completed **every**
run against the same endpoint.

- This is a **gateway/model non-conformance** (duplicate or shifted tool-call id
  at one index) that dnt-harness rejects strictly at the protocol boundary.
- Strict rejection is defensible (a corrupt tool call must not be executed), but
  the **blast radius is the whole turn** — one bad stream kills an otherwise fine
  session with no retry, whereas the harness retries genuinely transient errors.
- **Recommendation**: treat `invalid_tool_input` on the *stream* as retryable
  (bounded, once), or accept-and-merge when the id changes at a slot that has not
  yet been published. Either keeps the strictness without losing the turn.

Seen in: `fix-bug/dnt-harness/rep2` (run 2), `explain-rounding/dnt-harness/rep1`
(run 3), A/B `main` rep3 and `branch` rep1/rep2.

## 4. Harness-level findings noticed during the work

1. **The headless CLI cannot choose a model or provider** (`src/bins/headless.ts`):
   there is no `--model`/`--provider`, no `session/model` event, and no read of the
   provider-store default — the request goes out with `model: undefined`, so the
   provider falls back to `models[0]` (`deepseek-chat` for `DeepSeekProvider`).
   The benchmark worked around this by stamping `providerName`/`model` in an
   `agent/context` listener (exactly what the web host does). A `--model` flag
   would remove a real footgun for scripted runs.
2. **The DeepSeek effort fix is real and observable** — `medium`/`minimal` now
   reach the wire (see `plans/261016-branch-verify.md` §3.1).
3. **No harness-level step ceiling** (by design): the only bound is the wall-clock
   watchdog; a wandering model can run long. opencode has `max-steps`. This is the
   structural gap the prompt-discipline commit is compensating for.

## 5. Threats to validity

- Small n (3 reps head-to-head, 6 reps A/B) on one model and one machine, through a
  shared local gateway with high per-request latency variance (6–57s).
- opencode here is the **installed CLI v1.2.24**; the source tree reviewed for the
  gap analysis is v2.0.31. Both are "opencode", but agent-loop details differ.
- dnt-harness ran in `autonomous` mode with allow-all approval (to match
  opencode's non-interactive `build` agent); mode instructions differ by design.
- Token accounting differs between the two (documented in §1); only
  `firstRequestInputTokens` is a like-for-like comparison.
