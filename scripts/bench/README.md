# Benchmark harness — dnt-harness vs opencode

Automated, reproducible performance comparison between this harness and the
installed `opencode` CLI, both pointed at the **same** OpenAI-compatible model
endpoint so only the harness differs.

## Layout

| File | Job |
|---|---|
| `tasks/discount-bug/` | The real coding task fixture: a tiny cart/pricing library with 2 of 5 tests failing (`Math.floor` vs `Math.round` in `src/discounts.js`). |
| `harness-agent.mts` | Boots this project's harness (the `headless.ts` composition) against a chosen provider/model/mode and writes metrics JSON. |
| `opencode-run.mjs` | Runs `opencode run --format json` against the same endpoint and writes metrics JSON. |
| `run-bench.mjs` | Orchestrator: fresh copy of the fixture per run, both harnesses × 3 tasks × N reps, verifies each result, aggregates, writes a markdown + JSON report to `plans/`. |
| `ab-prompt.mjs` | A/B the base-prompt change: same task through the `main` worktree vs this branch. |
| `log-proxy.mjs` | Dev-only logging reverse proxy to inspect raw model requests/streams. |

## Usage

The drivers run on Node 22; the dnt agent itself runs on Bun (`bun` on PATH,
or `BUN_BIN=<path>`). Both need a live OpenAI-compatible endpoint:

```sh
# Node 22 (Laragon) and Bun >= 1.3 on PATH
export BENCH_BASE_URL=http://127.0.0.1:6536/v1
export BENCH_MODEL=deepseek-v4.1-flash-free

node scripts/bench/run-bench.mjs --reps 3          # full comparison
node scripts/bench/run-bench.mjs --only fix-bug --reps 2
node scripts/bench/ab-prompt.mjs --reps 3          # main vs branch prompt
```

Outputs land in `plans/261016-bench-<stamp>.md` and under the OS temp run dir
(path printed at the end), including raw `events.jsonl` and `metrics.json`.

## Metrics

- **steps** — model calls in the turn (`step/start` for dnt-harness, `step_start` for opencode).
- **toolCalls** — tool invocations.
- **firstRequestInputTokens** — the input tokens of the very first request = the
  harness's prompt + tool-schema overhead (the cleanest cross-harness number).
- **input/output/cached tokens** — summed across model calls.
- **wallMs**, **success** — verified: the edit task restores the pristine test
  suite and runs `node --test` (so editing tests cannot pass); read tasks must
  leave the tree unchanged and answer correctly.

## Notes / gotchas

- opencode must be pointed at the endpoint with a generated config (`OPENCODE_CONFIG`);
  its free zen tier refuses non-app clients.
- The opencode child must get `stdio: ['ignore', …]` or it blocks reading stdin.
- A rare provider stream fault (a tool-call id changing at the same index) makes
  this harness fail the turn at the protocol boundary (`invalid_tool_input`); such
  runs are counted as `Prov. faults` and excluded from the loop medians.
