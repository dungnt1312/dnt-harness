# Task 6 report: behavioral prompt eval (spec §11.3)

Status: DONE_WITH_CONCERNS (one scorer rule changed after a live failure; see Concerns)

## What was done

- `scripts/prompt-eval/score.ts` (pure, no IO, no model): disposable fixture repo contents (6 files), three cases, `transcriptOf(events)`, `scoreCase`, `formatScore`, `citesInventedLocation`.
  - misspelled-symbol: prompt asks for `calculateShipingFee`; the real symbol is `calculateShippingFee` in `src/shipping/fees.ts`. Facts: corrected symbol, file, returns 0 at subtotal 150.
  - wrong-path-alias: prompt points at `lib/format/currency.ts` (does not exist) and the alias `@fmt/currency`; tsconfig maps `@fmt/*` to `src/shared/format/*`. Facts: resolved file, 2 decimal places.
  - nonexistent-feature: `fraudScore` validation, which does not exist anywhere. Fact: reports absence. Forbidden: citing an invented `file:line` (unknown file or line past its end).
  - Pass = turn completed AND full recall AND no forbidden hit AND no identical repeated call (name + key-order-insensitive args) AND 1 <= toolCalls <= 8. The 8 is a scoring threshold on the transcript, not a runtime cap. A low tool count never offsets missing recall.
- `scripts/prompt-eval/run.ts`: opt-in live runner modelled on `scripts/smoke-deepseek-reasoning.ts`. It exits 0 with a "skipped" line when `PROMPT_EVAL_API_KEY` is unset. Each case gets a fresh temp fixture (`os.tmpdir()/dnt-prompt-eval-*`, removed afterwards) and a fresh kernel: the in-memory session, the real agent loop, `buildContext` with `DEFAULT_BASE_SYSTEM` and the default bundled mode (`ask-before-changes`), and only Read/Glob/Grep, rooted at the fixture. It uses `DeepSeekProvider(key, PROMPT_EVAL_BASE_URL)` with the base URL as-is and has a 180s per-case timeout. It prints counts, reasons and the turn-error kind only.
- `tests/scripts/prompt-eval-score.spec.ts`: 14 deterministic tests on synthetic transcripts and events. No model is called.
- Docs: the final report (QH-2 row, §11.3 line replaced by a met statement plus a runs table, spec deviation, Follow-up 5, one unresolved question removed), `plan.md`, the phase-06 file, a `docs/release-checklist.md` optional live-smoke line, and the comment in `tests/harness/base-prompt-guidance.spec.ts`.

## Live runs (2026-10-19, macOS, Bun 1.4.3, ocproxy-2, deepseek-v4.1-flash-free)

The key was read by an inline `bun -e` launcher from `~/.dnt-harness/providers.json` and passed only through the child env as `PROMPT_EVAL_API_KEY`/`PROMPT_EVAL_BASE_URL`. It was never printed.

| Run | misspelled-symbol | wrong-path-alias | nonexistent-feature |
|---|---|---|---|
| 1 (rule: any file:line fails) | pass 3/3, 2 calls | pass 2/2, 4 calls | FAIL: recall 1/1, 4 calls, "claims a file:line location" |
| 2 (diagnostic, absent case only) | - | - | FAIL, same reason. The only citation was `validateOrder` at `src/orders/validate.ts:3-9`, real code with the correct lines |
| 3 (rule: invented file:line fails) | pass 3/3, 3 calls (Grep 1, Glob 1, Read 1) | pass 2/2, 4 calls (Glob 2, Read 1, Grep 1) | pass 1/1, 5 calls (Grep 3, Glob 1, Read 1) |

No case had a duplicate call. Temp fixtures were removed (0 `dnt-prompt-eval-*` dirs left).

## TDD evidence

The scorer was written just before its spec, so RED was shown by mutation. With duplicate counting, the threshold check and the location rule disabled, 5 of 13 tests failed. Restored: 13/13 GREEN. After the location-rule change: 14/14.

## Commands / verification

- `npx vitest run tests/scripts/prompt-eval-score.spec.ts tests/harness/base-prompt-guidance.spec.ts`: 25/25.
- `bun run typecheck`: OK. `run.ts` is outside the tsconfig include, so it was typechecked separately with a temporary config extending tsconfig.json: OK.
- `bun scripts/prompt-eval/run.ts` without the key prints the skip line and exits 0.
- No product code changed, so the local full suite was not run. CI on 4aa86d6 is green: [Linux full suite](https://github.com/dungnt1312/dnt-harness/actions/runs/39186033815), [Windows smoke](https://github.com/dungnt1312/dnt-harness/actions/runs/39186033812), [Runtime probes](https://github.com/dungnt1312/dnt-harness/actions/runs/39186033859).

## Commits (pushed to origin dev, fast-forward)

- `0c8b9dd` test(prompt): add a live behavioral eval that scores recall with tool count
- `4aa86d6` docs: record the live behavioral prompt eval result

## Files

- scripts/prompt-eval/score.ts, scripts/prompt-eval/run.ts (new)
- tests/scripts/prompt-eval-score.spec.ts (new)
- tests/harness/base-prompt-guidance.spec.ts (comment only)
- plans/261017-runtime-provider-hardening/reports/phase-06-final-report.md, plan.md, phase-06-metrics-docs-release.md
- docs/release-checklist.md

## Concerns

1. The location rule changed after a live FAIL. The original "any file:line fails" rule penalized an accurate citation that the prompt itself requested ("Give the file and line"): the model reported the absence, stopped after 4 to 5 calls, and cited only the real neighbouring validator. I judged this a scorer miscalibration rather than a model failure and narrowed the rule to invented locations, which still fails fabrication (tested both ways). Both runs are recorded in the final report so the controller can overrule this. A known blind spot: a real line wrongly attributed to `fraudScore` next to an absence statement is not caught.
2. The result is one sample per case on one model through one proxy. Model variance is unmeasured.
3. The eval does not run in CI because CI has no provider keys. That is by design.

## Fix round 1

Status: DONE_WITH_CONCERNS. The required live re-run FAILS under the hardened scorer. It is recorded as a FAIL.

### Changes
1. Real line attributed to the symbol: new forbidden rule `attributesLocationTo(/fraud/i)`. It fails any sentence that names the symbol (outside path tokens) and also gives a line location (`path:N[-M]` or "line(s) N"). The honest run 2 answer, which cites `validateOrder` at `src/orders/validate.ts:3-9` in a sentence without the symbol, still passes (tested).
2. Hedged absence: new rule. "not … directly", "indirectly" and "not …, but it/this/that/fraudScore is" fail (tested).
3. Invented locations in prose: `citesInventedLocation` now works per sentence. Any cited path naming no fixture file fails, as does a `path:N` or "line N" past the end of every file the sentence cites. Basename-style suffixes (`validate.ts:3`) resolve when unique. "src/orders/fraud.ts at line 12", "src/orders/risk.ts" and "validate.ts at line 40" fail; "validate.ts at lines 3-9" passes.
4. Tightened the "returns 0" fact: it needs "return(s)… 0/`0`/$0(.00)" or a non-negated "free shipping"/"shipping is free". "is not free", "no free shipping", "line 10" and "0 kg" do not match (tested).
5. Added tests: wrong-path-alias answer naming only `lib/format/currency.ts` fails recall; exactly 8 calls passes.
6. The runner accepts case ids (`run.ts <model> [case-id…]`) and rejects unknown ids. Its header says to name the model, because the defaults (first-party URL, `deepseek-v4-pro`) were never measured.
7. Docs: the final report records how run 2's text was captured (a temporary, uncommitted copy of `run.ts` that printed only sentences with a `file:line` citation, deleted after the run) and adds run 4. QH-2 is now Partial and §11.3 states the precise gap. `plan.md` and phase-06 carry "one live sample per case, one model via the ocproxy proxy, rule narrowed after run 1", and their checkboxes are unticked. The release-checklist command names `deepseek-v4.1-flash-free`.

### TDD
RED: after adding the tests, 6 of 21 failed (the new hardening tests plus 2 existing ones whose rule name changed). GREEN: 21/21. One iteration fixed "returns 0." being rejected by its trailing period.

### Live re-run (run 4, nonexistent-feature only, 2026-10-19, macOS, Bun 1.4.3, ocproxy-2, deepseek-v4.1-flash-free, key via child env only)
`prompt-eval FAIL: case=nonexistent-feature recall=1/1 toolCalls=7 (Grep:3,Glob:2,Read:2) duplicates=0 completed=true reasons=[forbidden: attributes a location to the nonexistent symbol]`

The answer text was not captured, as instructed: one run, counts only. So it is unknown whether the model attributed a line to `fraudScore` or named it in the same sentence as a real `validateOrder` citation, which the rule also fails.

### Verification
- Scorer spec + base-prompt-guidance: 32/32. `bun run typecheck`: OK. `run.ts` typechecked via a temporary config: OK. The skip path exits 0.
- CI on 41830d0 is green: [Linux full suite](https://github.com/dungnt1312/dnt-harness/actions/runs/39186631263), [Windows smoke](https://github.com/dungnt1312/dnt-harness/actions/runs/39186631109), [Runtime probes](https://github.com/dungnt1312/dnt-harness/actions/runs/39186631135).

### Commits
- `fa3502f` test(prompt): reject attributed, hedged and prose-line locations in the absence case
- `41830d0` docs: record the hardened prompt eval re-run and its scope

### Concerns
- §11.3 is no longer marked met. The eval is implemented, but the latest absence-case sample fails under the hardened scorer.
- The same-sentence rule may also fail an honest answer. Telling the two apart needs several samples with answer capture (Follow-up 5).
