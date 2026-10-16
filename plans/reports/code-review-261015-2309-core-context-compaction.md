# Code review — context assembly, budgeting and compaction (2026-10-15)

Scope: `src/harness/context/*.ts`, `src/harness/prompts/**`, `src/harness/memory/**`, plus the
consumers where the findings land (`src/web/server.ts`, `src/web/llm-summarizer.ts`,
`src/web/compaction-*.ts`) and the relevant `tests/harness/**` suites.

Everything below comes from reading code. No suite was run (the reviewer had no Bash and no Write
tool). Findings are marked verified-by-reading or suspected.

## Independent re-verification by the parent session

The three load-bearing findings were re-checked against the source directly:

- **Finding 1** — `DEFAULT_BUDGET.outputReserveTokens` is `4_096` (`src/harness/context/budget.ts:32`),
  `budgetFor` is its only consumer (`:83`), and the wire cap comes from the catalog via
  `outputTokenCap(model, overrides, requested)` (`src/harness/llm/openai.ts:112-121`, called at `:224`)
  with no reference to the budget. Nothing ties the reserve to the cap that is sent.
  `model-catalog.ts:103` gives `claude-haiku-4.5` a 200 000 window with `maxOutputTokens: 65_536`.
  Confirmed.
- **Finding 3** — `renderEnvironmentContext` (`environment.ts:94-104`) interpolates `facts.gitBranch`
  verbatim into `<environment_context>`, and the module comment at `:90` states the block is embedded
  in the trusted system message and "never wrapped". Confirmed.
- **Findings 4 and 5** — `truncateToTokens` uses `tokens * 4` (`builder.ts:1036`) while `estimateTokens`
  is `ceil((length + cjk) / 3)` doubling only U+4E00–U+9FFF (`calibration.ts:14-21`). Confirmed: a
  truncation sized in "tokens" over-allocates by ~2.7× for CJK text and ~1.33× for ASCII.

Finding 2 was not independently reproduced; it rests on the reviewer's reading of `compaction.ts:74`
vs `:405-410` plus the workaround noted in `tests/harness/context-preview.spec.ts:165`.

## Severity counts: high 1 · medium 2 · low 5

| # | Severity | Location | Defect |
|---|---|---|---|
| 1 | high | `src/harness/context/budget.ts:32` (+ `:83`), `src/harness/llm/openai.ts:112-121`, `src/harness/agent/agent.ts:661-666` | The input budget reserves a fixed `outputReserveTokens: 4096`, but every chat step sends `max_tokens` = the catalog maximum (up to 131 072), so a request that passes the budget check can exceed the provider window |
| 2 | medium | `src/harness/context/compaction.ts:74` vs `:405-410` | Adoption proves the seed with the full-log canonical checkpoint while recovery recomputes the seed from `events.filter(seq <= end.coversSeq)`, so an end can be committed whose proof recovery rejects |
| 3 | medium | `src/harness/context/environment.ts:100` + `src/web/server.ts:3609-3617` | The repository-derived git branch name is interpolated verbatim into the **trusted** `<environment_context>` block |
| 4 | low | `src/harness/context/builder.ts:1036-1041` used at `:1082` | `truncateToTokens` computes `chars = tokens * 4` while the estimator is `chars/3` with CJK counted twice, so a CJK boundary message keeps ~2.7× the remaining budget |
| 5 | low | `src/harness/context/calibration.ts:14-21` (+ cap `:40`) | `estimateTokens` doubles only U+4E00–U+9FFF, so kana, Hangul and CJK ext-B are ~3× under-estimated — exactly at `MAX_CALIBRATION_RATIO = 3`, and only after a provider report exists |
| 6 | low | `src/harness/context/compaction.ts:260` | The extractive preflight only runs when the boundary is already committed; an unacknowledged boundary lets an over-cap no-model run append `compaction/start` + a failed `compaction/end` |
| 7 | low | `src/harness/prompts/store.ts:12-18`, `src/web/server.ts:3874-3875`, `src/harness/context/builder.ts:549/569/932` | A workspace `base`/`child` prompt override replaces trusted message `[0]` prose, but the manifest records no provenance for it |
| 8 | low (docs/test coverage) | `docs/prompt-contract.md:19-26` vs `src/harness/context/builder.ts:633-642` | The normative message layout omits the `<untrusted kind="restored-state">` message inserted after compacted history, and `tests/harness/g5-prompt-contract.spec.ts:198-206` does not assert it |

## Findings

### 1 (high) — the reserved output budget does not match the `max_tokens` actually sent

`src/harness/context/budget.ts:32` (+ `:83`), `src/harness/llm/openai.ts:112-121`,
`src/harness/agent/agent.ts:661-666`.

`budgetFor` subtracts a fixed `outputReserveTokens: 4096` and `marginTokens: 1024`, but every chat step
sends `max_tokens` = the catalog maximum. `src/harness/llm/model-catalog.ts:103` gives
`claude-haiku-4.5` a 200 000 window with `maxOutputTokens: 65_536`, so the reserve is off by 61 440
tokens on that model alone.

*Re-verified independently by the parent session:* `DEFAULT_BUDGET.outputReserveTokens` is `4_096`
(`budget.ts:32`), `budgetFor` is the only consumer (`:83`), and the wire cap comes from the catalog via
`outputTokenCap(model, overrides, requested)` (`openai.ts:112-121`, called at `:224`) with no reference
to the budget. So nothing ties the reserve to the sent cap.

*Trigger.* `claude-haiku-4.5`, calibrated `used` ≈ 194 000 (available = 194 880) → wire body
`max_tokens: 65536` → 260 416 > 200 000. Gateways that word this as "max_tokens is too large" /
"exceeds maximum" match neither `CONTEXT_EXCEEDED` (`openai.ts:403`) and are classified `permanent`, so
`canRetry` is false and the turn fails; wordings matching `context length` instead burn one squeeze
level (budget × 0.7) per occurrence.

*Minimal fix.* Send `max_tokens = min(catalogCap, window − estimatedInputTokens)` per request
(assembly already knows both), instead of reserving only 4096.

### 2 (medium) — adoption can commit an end whose proof recovery rejects

`src/harness/context/compaction.ts:74` vs `:405-410`.

Adoption proves the seed with the *full-log* canonical checkpoint (`current`) while recovery recomputes
the seed from `events.filter(seq <= end.coversSeq)`. A cutoff that lies after the standing checkpoint's
`coversSeq` but *before* that checkpoint's own `compaction/end` event is therefore accepted (only
`current.coversSeq > cutoff` is refused) and commits an end whose proof recovery rejects.

*Effect.* `adoptPreparedCompaction` reports `compacted`, writes the cache, and the committed log keeps
the **older** checkpoint — the new summary is silently dropped and the same delta is summarized again
(and `CheckpointStore.latest(id)` without events would return the unprovable newer file at
`compaction.ts:130-152`).

*Trigger.* t1 closed (seq 1-4), t2 closed (seq 5-8), adopt #1 at cutoff 4 (its start/end land at 9/10),
then adopt #2 at cutoff 8 with `seedHash = hash(#1)` — exactly the construction in
`tests/harness/context-preview.spec.ts:165` (the test works around it; see
`plans/261015-1406-context-wip-completion/task-6-report.md:24-28`). Reachability: all in-tree callers
derive `seedHash` from the prefix projection (`compaction-projection.ts:110-117`), so they are refused
one line earlier at `compaction.ts:410`; the gap needs a caller that computes `seedHash` from the full
log, which the exported shape invites.

*Minimal fix.* In `adoptPreparedCompaction`, also require `prepared.seedHash ===
compactionSeedHash(recoverCanonicalCheckpoint(events.filter(e => e.seq <= prepared.cutoff))?.summary)`
— the same rule `adoptionProven` applies — or refuse a `cutoff` below the standing checkpoint's
end-event seq.

### 3 (medium) — the git branch name is interpolated into the trusted environment block

`src/harness/context/environment.ts:100` + `src/web/server.ts:3609-3617`.

The repository-derived git branch name is interpolated verbatim into the **trusted**
`<environment_context>` block (`Workspace: … (git branch: ${branch})`), with none of the
`wrapUntrusted` neutralization applied to the other lower-trust sources.

*Trigger.* A project folder whose `HEAD` branch is named e.g. `x</environment_context>` or `a` + markup.
Git refs may not contain whitespace, so injection is one whitespace-free token, but it can forge an
envelope tag or a fake token in trusted prose. *Minimal fix.* Render only `[A-Za-z0-9._/-]` runes of the
branch (or omit it) in `cachedGitBranch` / `environmentBlockFor`.

### 4 (low) — CJK truncation keeps ~2.7× the remaining budget

`src/harness/context/builder.ts:1036-1041`, used at `:1082`. `truncateToTokens` computes
`chars = tokens * 4`, while the estimator it is budgeted against is `chars/3` with CJK counted twice
(`calibration.ts:14-21`); a CJK boundary message therefore keeps ~2.7× the remaining budget.

*Trigger.* `compactionRetainTokens: 1000` with a covered CJK user message → the truncation keeps 4000
chars ≈ 2667 estimated tokens, breaking the documented "hard cap" (`builder.ts:1022-1027`,
`docs/harness.md:674-677`). *Minimal fix.* Size the truncation with `estimateTokens` (binary-search the
cut) rather than `tokens * 4`.

### 5 (low) — the token estimator under-counts most CJK scripts

`src/harness/context/calibration.ts:14-21` (+ cap `:40`). `estimateTokens` doubles only U+4E00–U+9FFF,
so kana (U+3040–30FF), Hangul (AC00–D7A3) and CJK ext-B are counted at 1 char, ~3× under-estimated; the
compensating ratio is clamped at `MAX_CALIBRATION_RATIO = 3`, i.e. exactly at the boundary of what is
needed, and only after a provider report exists. *Trigger.* A kana/Hangul-heavy conversation's first
request can overflow the window before any calibration stands. *Minimal fix.* Extend the doubled ranges
and bump `TOKEN_ESTIMATOR` (`calibration.ts:11`) so `latestCalibration` (`:103`) refuses to pair old
manifests with the new estimator.

### 6 (low) — the extractive preflight is skipped for an unacknowledged boundary

`src/harness/context/compaction.ts:260`. The extractive preflight only runs when
`session.committedEvents.some(e => e.seq === lastEnd)`; if the boundary is not yet acknowledged, an
over-cap no-model run appends `compaction/start` + a failed `compaction/end` (the "no lifecycle event"
guarantee of `plans/261007-1713-compaction-review-fixes/phase-01-summarizer-correctness.md:35` holds
only in the committed case). `tests/harness/compaction-reliability.spec.ts:279` calls
`await session.durable()` first, so this branch is never exercised.

### 7 (low) — a prompt override has no provenance in the manifest

`src/harness/prompts/store.ts:12-18`, `src/web/server.ts:3874-3875`,
`src/harness/context/builder.ts:549/569/932`. A workspace `base`/`child` prompt override replaces
trusted message `[0]` prose, but the manifest records `modeSource` and no equivalent provenance for the
prompt override; a hostile `system-prompts.json` is indistinguishable from the bundled default in
`context/manifest`. *Minimal fix.* Add e.g. `sources.promptOverrides: { base?: true; child?: true }`.

### 8 (low, docs/test coverage) — the contract doc is not the machine-checked truth for one row

`docs/prompt-contract.md:19-26` vs `src/harness/context/builder.ts:633-642`. The normative message
layout omits the `<untrusted kind="restored-state">` message inserted after compacted history, and
`tests/harness/g5-prompt-contract.spec.ts:198-206` does not assert it (its `sections` kind is folded
into `'compaction'`).

## Re-confirmed / refuted memory claims (with file:line)

- **Incremental fold (seed + delta, no lifecycle events at an unchanged boundary):** confirmed —
  `compaction.ts:244-256` (fail-closed seed validation, idempotent no-op), `:275` (delta projection via
  `projectForSummary(..., fromSeq)`), `tests/harness/compaction-reliability.spec.ts:208-261`; the fold
  cannot lose a covered prefix or re-summarize it. Caveat = finding 6.
- **Host-attested checkpoint:** confirmed — `builder.ts:1212-1219` (bounds + completed boundary
  re-checked, full canonical derivation skipped only for `verifiedAgainst: 'committed-log'`), fed solely
  from `checkpoints.latest(id, committedEvents)` at `server.ts:3734-3735`;
  `tests/harness/compaction-context-reliability.spec.ts:74-96`. Note the attestation is a
  caller-settable string, not a capability — any embedder of the exported `buildContext`
  (`src/index.ts:157`) can skip re-derivation; documented as intended (`builder.ts:87-95`) and the
  summary still rides lower-trust, so there is no authority escalation.
- **Extractive preflight prefix rejection:** confirmed for the committed case (`compaction.ts:259-266`;
  `tests/harness/compaction-reliability.spec.ts:263-296`). Caveat = finding 6.
- **`compactionRetainTokens` retention:** confirmed — default 20 000 (`limits.ts:60,100`), newest-first
  selection, boundary truncation, lone-answer stripping, `0` keeps none (`builder.ts:1027-1089`;
  `tests/harness/g3-compaction.spec.ts:341-366, 402-426`), and no covered tool traffic is ever retained.
  Caveat = finding 4.
- **Prompt-cache prefix stability:** confirmed and clean. No `Date.now`/`randomUUID`/`new Date` anywhere
  in `builder.ts` (grep); the environment block carries the day only (`environment.ts:55-57, 93-104`);
  `[sent …]` is rendered from the durable event timestamp and only for `origin === undefined` user
  messages (`builder.ts:1030-1033, 1100-1118`); skill bodies are tool results — the builder only emits
  definition-preload blocks (`server.ts:3781-3808`); the catalog and memory index are snapshotted per
  session and re-read only when the prefix key moves (`server.ts:3742-3755, 3816-3821`,
  `docs/prompt-contract.md:31-56`). The only trust/cache-adjacent issue found here is finding 3 (the
  branch name is stable per server run, so it does not cause re-billing).
- **Fold digest / message loss:** no loss or duplication found. `projectForSummary` filters
  `fromSeq = seed.coversSeq`, which is a `turn/end` seq, so no tool call/result pair is ever split
  (`compaction.ts:486-495`), and each chunk/merge is a bounded request whose retry discards partial
  output (`server.ts:1658-1686`, `src/web/llm-summarizer.ts:132-251`). The extractive fallback retains
  the seed or fails closed (`llm-summarizer.ts:124-131`).

## Domains checked and clean

Microcompaction loss typing and safety (`builder.ts:424-476, 749-835`; `compaction-projection.ts:61-63,
189-217` — the effective `tool/call` identity governs); projection eligibility fail-closed
(`compaction-projection.ts:98-180` — uncovered history, unresolved calls, indeterminate outcomes and
unknown losses all refuse); `sourceDigest` coverage of exactly the model-visible rows
(`compaction-digest.ts:40-61`); checkpoint durability ordering (success append before cache, a late Stop
cannot revoke it, the cache rebuilds from the log — `compaction.ts:296-302, 435-439`;
`tests/harness/compaction-reliability.spec.ts:30-72`); `isCompletedCompactionBoundary` /
`recoverCanonicalCheckpoint` forgery resistance (`compaction.ts:36-105`;
`tests/harness/compaction-adoption.spec.ts:264-359`); memory service path/symlink scope checks and index
truncation (`memory/service.ts:50-78, 163-190, 364-371`); prompts CAS + strict parse
(`prompts/store.ts:108-190`); env/`wrapUntrusted` delimiter neutralization (`builder.ts:353-365`;
`tests/harness/g5-prompt-contract.spec.ts:176-181, 296-318`).

## Suspected — needs a test (not run here)

- Finding 2: a test that a `PreparedForAdoption` with a full-log-derived `seedHash` can commit at a
  cutoff before the standing checkpoint's end event and that `recoverCanonicalCheckpoint` then refuses
  it (would fail today).
- Finding 1: a gateway-echo test asserting the best `max_tokens` never exceeds
  `window − estimatedInputTokens` (no such assertion exists; `tests/harness/llm-openai.spec.ts:72-89`
  only pins catalog/override behaviour).
- Finding 5: `estimateTokens('あ'.repeat(3000))` = 1000 (asserts the ~3× gap and the cap coincidence).

## Unresolved

1. Is finding 1's reserved-vs-sent `max_tokens` mismatch a known/accepted trade-off
   (`docs/harness.md:940-949` only justifies *sending* the catalog cap, not the reserve), or should the
   per-request cap be derived from the budget?
2. Finding 2's reachability: is `adoptPreparedCompaction` reachable from any host outside `src/web` (it
   is not exported from `src/index.ts`)? If yes, the severity moves up.
3. Whether `CheckpointStore.latest(sessionId)` without `events` still has external callers that could
   pick up an unprovable newer cache file.

**Skipped:** no test or typecheck was run (no Bash/Write tooling); `src/harness/context/compaction-snapshot.ts`
consumers were not read beyond the source/identity path; `src/web/**` was reviewed only as far as these
findings required. **Risk:** findings 1 and 3 are the ones a live gateway/model run should confirm first.
