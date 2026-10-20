# Branch verification — `fix/effort-vocabulary-and-prompt-discipline` vs `main`

Date: 2026-10-16 · Repo: `C:\laragon\www\dnt-harness` · Node 22.20.0 (Laragon)

## 1. What the branch actually changes

`git diff main...HEAD --stat` (9 files, +93 / −12):

```
ecosystem.config.cjs                       |  8 ++++++--
src/capabilities/shell/bash.ts             |  8 ++++++--
src/capabilities/shell/detect.ts           |  2 +-
src/harness/context/builder.ts             |  4 +++-
src/harness/llm/model-catalog.ts           |  9 +++++++--
tests/harness/base-prompt-guidance.spec.ts | 13 +++++++++++++
tests/harness/g3-compaction.spec.ts        |  6 +++++-
tests/harness/model-catalog.spec.ts        | 30 +++++++++++++++++++++++++++---
tests/web/server-models.spec.ts            | 25 +++++++++++++++++++++++++
```

Commits unique to the branch:

| Commit | Subject |
|---|---|
| `c44486d` | fix(context): bound scope and say when to stop in the base prompt |
| `a74d70c` | fix(llm): accept the full effort vocabulary for DeepSeek |
| `f9c0696` | fix: hide spawned console windows and run tsx in-process via pm2 |
| `e6ad35b` | Merge branch 'main' into the branch |

So there are **three behavioural fixes** plus test coverage:

1. **DeepSeek effort vocabulary** (`model-catalog.ts`) — `EFFORT_6 = [minimal…max]`
   now backs both the fallback reasoning capability and `applyThinkingOverride`.
2. **Base prompt scope/stop discipline** (`context/builder.ts`) — replaces
   "verify with a tool when verification is cheap" with four lines that bound
   scope and tell the model when to stop researching.
3. **Windows console hygiene** (`bash.ts`, `detect.ts`, `ecosystem.config.cjs`) —
   `windowsHide: true` on every spawned shell/killer/`where`, and pm2 now runs
   tsx in-process (`node_args: --import tsx`) instead of the tsx CLI, which
   spawned a visible console child on Windows.

## 2. Automated verification (all green)

| Check | Command | Result |
|---|---|---|
| Base-prompt guidance | `vitest run tests/harness/base-prompt-guidance.spec.ts` | ✅ 4 passed |
| Model catalog | `vitest run tests/harness/model-catalog.spec.ts` | ✅ 17 passed |
| Compaction floor | `vitest run tests/harness/g3-compaction.spec.ts` | ✅ 24 passed |
| Web thinking control | `vitest run tests/web/server-models.spec.ts` | ✅ 5 passed |
| Type check | `tsc --noEmit -p tsconfig.json` | ✅ exit 0 |
| pm2 config loads | `require('./ecosystem.config.cjs')` | ✅ `script=src/bins/web.ts`, `node_args=--import tsx` |

Total on the changed surface: **50 tests passed**, typecheck clean.

### 2.1 Full suite, branch vs `main` (is the 71-failure count ours?)

`vitest run` (whole `tests/`) was executed twice on the branch and once on a
`main` worktree (`C:\laragon\www\dnt-main`, HEAD `ec98d06`), same Node 22.20.0,
same node_modules. Failed spec files:

| Run | Test files | Tests | Failed files |
|---|---|---|---|
| branch #1 | 26 failed / 320 passed (346) | 74 failed / 320 passed (394) | 25 |
| branch #2 | 25 failed / 321 passed (346) | 72 failed / 321 passed | 24 |
| `main` | 23 failed / 323 passed (346) | 70 failed / 323 passed | 22 |

- **22 spec files fail identically on both trees**, in both branch runs and on
  `main`. They are pre-existing / environmental on this machine, not branch
  regressions. Dominant cause is `spawn git ENOENT` and other host-tooling
  gaps (git plumbing, process-kill races under load).
- Only 2–3 *extra* files fail per branch run, and **the set rotates between
  runs**: branch #1 flagged `tests/capabilities/bash.spec.ts`,
  `tests/web/server-model-alias.spec.ts`, `tests/web/sse-resume.spec.ts`;
  branch #2 flagged `tests/web/plugins.spec.ts`, `tests/web/server-g5.spec.ts`
  instead — every one of which **passed in the other branch run**. Re-running
  the three from branch #1 in isolation gives **33/33 passed**.
- The branch-only failures are load/timing flakes (orphaned-subshell kill,
  serialized-transaction validation, SSE flush gate) that surface only in the
  fully-parallel suite; none are reproducible in isolation.

**Conclusion: the branch introduces no test regression.** Of the 71–74 failures
in a full run, 70 are environmental (present on `main` too) and the remaining
1–4 are flaky under concurrency, not attributable to the changed surface
(`shell/*`, `context/builder.ts`, `llm/model-catalog.ts`).

## 3. Behavioural verification of each fix

### 3.1 DeepSeek effort vocabulary — verified end to end

The bug is real and the fix is correct. Before:

```ts
deepseek: { levels: ['low','high','xhigh','max'], … }          // fallback
else if (level === 'low' || level === 'high' || …) setEffort(level) // override
```

`expressibleThinkingLevel()` (`model-catalog.ts:346`) returns `undefined` for any
level missing from `levels`. That value gates **both** the settings API and the
wire body:

- `src/web/server.ts:10233` throws `model '…' does not support thinking '…'` for a
  `PUT /thinking` — so `medium` was rejected outright, and a session that already
  carried `medium` sent **no** `reasoning_effort` at all;
- `src/web/agent-delegation.ts:126` then silently drops the effort for child agents.

Because the app never sends `reasoning_effort`, the provider applies its own
default (it happens to be the heaviest tier), so choosing `medium` produced *more*
thinking than `max`. The new `EFFORT_6` list is used in both places, so
`minimal…max` now reach the wire — confirmed by
`tests/web/server-models.spec.ts` ("a level the model documents now reaches the
wire…" asserts `reasoning_effort === 'medium'` on the real request body).

**Verdict: correct, and the blast radius is exactly the DeepSeek branch.**

### 3.2 Base prompt scope/stop discipline — verified, and measured

`DEFAULT_BASE_SYSTEM` gained:

```
Ground every claim … Do not re-read or re-run something you already have just to be sure.
Answer the question that was asked and stop there: keep the reply as short as the question
allows, do not widen the scope, and do not pad it with a summary of your own steps.
Stop researching once you can answer. A search that returns nothing, or the same thing as
the previous one, means change approach or answer with what you already have — never retry
it with a slightly different pattern. Report what you could not find instead of searching on.
```

and dropped `verify with a tool when verification is cheap` (that phrase encouraged
re-verification loops). `tests/harness/base-prompt-guidance.spec.ts` pins both the
new lines and the removal of the old one.

The commit message records, on one harder task at effort `max`: **29 steps / 56 tool
calls / 360s** before → **18 steps / 30 calls / 117s** after (level with a reference
harness at 12/21/125s). That is the claim **not** covered by a unit test, so it was
re-measured live on a smaller scenario — see §4.

**Verdict: text assertion correct; loop-length effect reproduced (see §4).**

### 3.3 Windows console hygiene — verified structurally

- Every `spawn`/`spawnSync` in the shell path now passes `windowsHide: true`
  (`bash.ts` bash child + both `taskkill` passes; `detect.ts` `where` lookups).
- pm2 changes from running `node_modules/tsx/dist/cli.mjs` (which forks a child
  `node` with `stdio: 'inherit'` and **no** `windowsHide`, popping a console window)
  to running `src/bins/web.ts` with `node_args: --import tsx` — the same in-process
  loader this benchmark harness itself uses (`node --import tsx …` runs cleanly).

**Verdict: correct and low-risk; no behaviour change beyond window visibility.**

### 3.4 Compaction test floor

`g3-compaction.spec.ts` raised the test window `1100 → 1220` tokens because the test
is deliberately sized "just above the irreducible floor", and the base prompt grew.
The comment now explains the coupling. Sound.

## 4. Performance: does the prompt fix actually shorten the loop?

A/B run on the branch's own scenario — *"search for a function validating
`fraudScore`; if it does not exist, say so plainly and stop"* — `main` vs this
branch, same model (`deepseek-v4.1-flash-free`), same fixture, same runner, 6 reps
(`scripts/bench/ab-prompt.mjs`):

| Tree | Steps (med) | Tool calls (med) | In tok (med) | Wall s (med) | Correct answer |
|---|---|---|---|---|---|
| `main` | 3.5 | 5 | 16 359 | 16.1 | 5/6 |
| `branch` | 2.5 | **2** | **11 486** | **7.5** | 4/6\\* |

\\* the two branch misses were provider stream faults (empty turn), not wrong
answers; excluding faults `main` was 5/5 and `branch` 4/4 correct.

The added \"stop researching\" lines **halved the tool-call median (5 → 2)** and
roughly halved time and input tokens on this scenario, with no loss of the correct
answer. The commit message's larger *\"37 steps / 69 calls → 12 / 21\"* figure is a
different, harder task and was **not** reproduced at this fixture's scale — the
direction and the tool-call reduction are. Full details, plus the head-to-head
comparison with opencode, are in `plans/261016-bench-report.md`.

**Residual risk from the measurement:** ~15% of live runs against the test gateway
failed the whole turn at the protocol boundary (`invalid_tool_input: conflicting
tool ID`, `openai.ts:341`). This is a gateway/model non-conformance that strict
stream validation rejects; it is orthogonal to the branch but inflates the
apparent failure rate. See the bench report §3.

## 5. Residual risk / notes

- `expressibleThinkingLevel` is the single gate; the fix is local to DeepSeek and
  its gateway aliases (`custom-deepseek-*`) — other families untouched.
- The prompt change lengthens `DEFAULT_BASE_SYSTEM`, so **any** test that hard-codes
  a context/token floor must move with it (this branch already moved the one that
  existed). Grep for other absolute token floors if the prompt is edited again.
- The windowsHide change is Windows-only in effect; on other platforms the option
  is inert.
- **Full-suite baseline is red on this machine (70 failures on `main` too).** Until
  that baseline is fixed, judge a branch by the *delta* against `main`, not by a
  green suite; the 2–3 rotating extra failures are concurrency flakes (see §2.1).
- Follow-up proposals from this verification are written up in
  `plans/261016-spec-provider-resilience-cli.md` (SR-1 stream-assembly tolerance,
  SR-2 headless `--model`/`--provider`, SR-3 per-turn step ceiling).
