# Phase 05 — Reasoning round-trip + history compatibility

Status: implemented, **uncommitted**. Base: HEAD `31239c3` (Phase 4).

## 1. Evidence (step 1)

| Source | What it says |
|---|---|
| DeepSeek official, Thinking Mode guide (https://api-docs.deepseek.com/guides/thinking_mode, read 2026-10-18; zh-cn page says the same) | `reasoning_content` comes back at the same level as `content`. If the request **carries `tools`**, "the `reasoning_content` of all previous turns should be passed back to the API and will be concatenated into the context". Without `tools` it "does not need to be passed back; even if passed … it will be ignored". Tool calls section: "for requests carrying the `tools` parameter, the `reasoning_content` must be fully passed back to the API in all subsequent requests — even for turns where the model did not perform a tool call. If your code does not correctly pass back `reasoning_content`, the API will return a 400 error." Its sample replays Turn 1's reasoning in the Turn 2 request too. |
| 400 wording seen live (third-party probe, `HenryZ838978/deepseek-harness` spec/01, 2026-05-09; also opencode issue #24190) | `{"error":{"message":"The \`reasoning_content\` in the thinking mode must be passed back to the API.","type":"invalid_request_error"}}`. The probe reproduced it 3/3 when the previous tool-call assistant message lacked the field. It recommends stripping reasoning across user-turn boundaries, but that contradicts the official "all previous turns". opencode #24190 reports the 400 on the **follow-up user turn** after a tool turn. |
| craft-agents #703 | V4 can return `reasoning_content: ""`. The empty string must be sent back as-is and not dropped. |
| Length continuation | Neither the docs nor the probes define a rule for continuing a reply cut off at `finish_reason: length` with reasoning. Nothing proves a cut-off reasoning is accepted as complete. |

**Decisions taken from this evidence**

- Native DeepSeek profile `{ field: 'reasoning_content', required: true, replayWindow: 'conversation' }`. Every assistant message still in the request that has complete reasoning from **this route** gets it back, as the docs say for requests with tools.
- The strict pre-network gate covers only the **active tool loop** (assistant messages after the latest user message). All sources agree that window is mandatory. A gap there can only come from a route switch or a cut-off reply, never from legacy history. Older gaps (legacy turns, the other route's turns) are left out. They are never filled in or trimmed. If the live endpoint does refuse such a gap, its 400 is turned into the same actionable message ("start a new session, or explicitly reset…"). No retry, no fabrication.
- This deviates from the plan default (plan: tool-loop window). The plan's `tool-loop` window is still available as an explicit profile value (`replayWindow: 'tool-loop'`). The default follows the official text.
- Length: the record is kept with `complete: false` and is never replayed. The host truncation notice is a `user` message, so it closes the tool loop and the cut reply sits outside the gate. Strict therefore needs no continuation rule. Without proof, nothing gets sent.
- Requests without `tools` never carry the field and are never gated (the docs say the field is ignored there).

## 2. Files

| File | Change |
|---|---|
| `src/harness/llm/reasoning.ts` (new) | Pure policy: `ReasoningProfile` + `normalizeReasoningProfile` (rejects reserved `role/content/tool_calls/name/tool_call_id/…`, malformed identifiers, unknown keys and windows), `isNativeDeepSeekEndpoint` (exact host `api.deepseek.com`), `resolveReasoningProfile` (override > native > none), `planReasoningReplay` (eligible indexes + tool-loop `missing`), `selectReasoning`/`withoutReasoning` (per-route projection/aging), `capturedReasoning` (secret-shape redaction → `redacted: true`), `isReasoningPayload` (validator), the endpoint-400 regex and reset hint. `SECRET_SHAPES`/`redactSecrets` moved here from `openai.ts` (reused, not duplicated). |
| `src/harness/llm/types.ts` | `ReasoningPayload { text, complete, source, redacted? }`; optional `ModelMessage.reasoning`; `ModelCompletion.reasoningSource`; optional `LlmProvider.reasoningReplay(model)` + `ReasoningReplay`. |
| `src/harness/llm/openai.ts` | `reasoning?: ReasoningProfile` option. `reasoningReplay()` returns `routeKey(routeIdentity(model))` (v1 + `k2:` HMAC credential). With tools + a required profile: the replay plan runs **before fetch**, missing in-loop records throw an actionable `ProviderError` (phase `connect`), and eligible records are serialized under the profile field (`""` only for a recorded, proven-complete empty thinking). The completion carries `reasoningSource`. An endpoint 400 matching DeepSeek's wording gets the reset hint. |
| `src/harness/agent/agent.ts` | Per-attempt `thinking` / `reasoningSource`, reset together with `full/calls` on every attempt (retry, squeeze, abandon). Published on `assistant/message` only after a valid completion that named a source; `length` → `complete: false`; error/cancel never reach the append. |
| `src/harness/session/events.ts` | Optional `reasoning` on `assistant/message`; the projection carries it (selection happens downstream). |
| `src/harness/storage/events-jsonl.ts` | Strict validation only when the field is present; legacy lines untouched. |
| `src/harness/llm/service.ts` | `LlmService.reasoningReplay(provider, model)`. |
| `src/harness/context/builder.ts` | `BuildContextInput.reasoningReplay`. History keeps only reasoning this route would replay (same source, complete, in window, request has tools), so it is counted in `historyMessageCost` (budget/trim/manifest/ceiling). Retained covered answers drop reasoning (aging). `estimateConversationTokens` accepts it too. |
| `src/harness/context/compaction-digest.ts` | Dual-read digest: a prefix without any reasoning gives the exact v1 rows/hash; a reasoning-bearing prefix uses v2 rows that include `reasoning`. |
| `src/harness/context/compaction-snapshot.ts` | `v: 1 \| 2`; `snapshotSchemaFor`; the validator accepts both and requires the version to match the content (a v1 snapshot carrying reasoning, or a v2 without it, is refused). |
| `src/web/compaction-capture.ts` | Snapshot version from content; final-answer reasoning compared only when the snapshot carries it (v2). |
| `src/web/compaction-generator.ts` | Snapshot size estimates include reasoning. |
| `src/web/llm-summarizer.ts` | Cache-aware summarizer takes the final answer as a string (unchanged) or as a message (with reasoning). |
| `src/web/provider-store.ts` | `ProviderConfig.reasoning` normalized at parse; an invalid one is dropped (the entry stays generic). |
| `src/web/server.ts` | Instantiates with `entry.reasoning`; passes `reasoningReplay` to the builder and to the candidate gain estimate; snapshot final answers keep reasoning only when the captured route replays it; cache-aware summarizer gets the message form under the same condition. SSE audit: `clientEvent()` strips the stored `reasoning` from `assistant/message` frames (snapshot/resume/live). The UI keeps showing thinking from `assistant/chunk`, as before. No new export. |
| `src/bins/headless.ts` | Instantiates with `entry.reasoning`; passes `reasoningReplay` to the builder; renderer comment (stored record never printed). |
| `src/harness/agents/executor.ts`, `src/web/agent-delegation.ts`, `src/harness/session/service.ts` | No behaviour change (they read `content` / `toolCalls` only); comments pin the matrix decision. |
| `scripts/smoke-deepseek-reasoning.ts` (new) | PH4-G opt-in live smoke. Skips (exit 0) without `DEEPSEEK_API_KEY`; in-memory sessions; prints counts/status only. **Not run** (no key in env). |
| Tests | `tests/harness/reasoning-round-trip.spec.ts` (new, 21), `tests/bins/headless.spec.ts` (+1 real-CLI PH4-A). |

## 3. Acceptance coverage

- **PH4-A**: a fake strict DeepSeek gateway (real HTTP/SSE, 400 on a missing or mismatched `reasoning_content` with tools) through the real `OpenAiCompletionsProvider` + agent loop: thinking, then 2 parallel tool calls, then request 2 carries the exact streamed reasoning, `call_a/call_b` ids and results, then the final answer, completed. Also the real CLI process with a `providers.json` `reasoning: { required: true }` override. Empty thinking is replayed as `""` only under the profile. A generic endpoint with a `deepseek-*` model id sends nothing, so the strict gateway rejects it (the model id alone does not enable replay).
- **PH4-B**: file-backed session, restart (new kernel, same hasher), new turn: every prior turn is replayed with its own reasoning. Same for a fork. A credential rotation (re-registered provider) and a model switch send none of the old route's text, only the new route's own in-loop reasoning.
- **PH4-C**: surrogate pair split across deltas re-joined; empty thinking; tool and no-tool assistants; multiple turns in order; estimate covered under PH4-F.
- **PH4-D**: abandoned attempt (transient mid-stream failure) is not mixed into the retry. `length` gives `complete: false`, no tool executed from the cut batch, not eligible, not blocking. Error and cancel produce no `assistant/message`. Secret-shaped text is masked with `redacted: true`.
- **PH4-E**: a legacy JSONL line without the field reads; a malformed record is a schema error. A legacy tool turn followed by a new user turn completes against the loop-strict gateway, and legacy turns get no field. Missing/partial/foreign in-loop reasoning fails **before fetch** with the "new session / reset" message. A mid-loop model switch is stopped before its request. An endpoint 400 gives the hint and one request (no retry). A no-tools request has no field and no gate.
- **PH4-F**: estimate grows by exactly `estimateTokens(reasoning)` for the matching route and not for others or without tools; `estimateConversationTokens` too. Aging: retained covered answer and tool-loop window drop old reasoning. A v1 log digest equals the hand-computed pre-phase-05 rows; the v1 snapshot validates and loads through the store (no re-summarization). v2 round-trips through the store; a reasoning change changes the digest and invalidates the snapshot; a mislabelled version is refused; a forged final-answer reasoning is not promoted.
- **PH4-G**: script added, gated, not run (no key). Native thinking+tools support should not be claimed until it passes.
- Profile: reserved keys and malformed fields rejected; precedence (override can opt in a relay and opt out the native host); look-alike host rejected; the store drops invalid profiles.
- Mutation check: blanking wire serialization fails 5 tests; dropping agent thinking capture fails 7.

## 4. Results

- Typecheck: `bun run typecheck` exit 0 (both tsconfigs).
- Affected specs: 19 core files / 566 tests pass (llm-openai, effective-model, provider-error-classification, agent-loop, agent-tools, length-recovery, compaction-snapshot, compaction-capture, g3-compaction, compaction-context-reliability, context-calibration, llm-summarizer, provider-store, g4-subagent-contract, compaction-precompute, stream-completion, llm-review-regressions, attempt-events, request-lifecycle). Web server-*/sse-resume/headless/compaction-* group: 38 files / 528 pass; 5 failures are all baseline (server-skill-sources 3, server-project-git-actions 2). New: reasoning-round-trip 21/21, headless 13/13.
- Full suite (Windows, Node 22.20): 30 failed files / 323 passed / 1 skipped; 84 failed / 4744 passed / 35 skipped; 5 errors. Baseline: 25 / 66 / 4.
  - Non-baseline files, re-run in isolation: `scripts/repo-freeze` 69/69, `web/mcp-oauth-connect` 13/13, `web/project-git-branches` 17/17, `web/server-project-git-v2` 8/8, `web/server-session-model` 26/26, `processes/registry` 9/9. All pass, so these are load flakes (same class Phase 4 recorded). A grouped re-run of those six had one failure, also load-dependent.
  - Every other failing file is on the baseline list. No Phase 5 regression found.

## 5. Deviations

- **Default window `conversation` (not the plan's tool-loop)**, from the official "all previous turns" text; the gate stays tool-loop-only as the plan requires, and `tool-loop` remains a valid explicit profile value.
- Reasoning is recorded **only** for routes whose profile requires it. Other routes keep thinking UI-only, as before, so there is no new persistence or disclosure for generic providers.
- `ModelCompletion.reasoningSource` (adapter → loop) is how the source gets in, instead of the agent re-resolving the route.
- The `reasoning` profile is accepted from `providers.json` (store boundary); no REST create/patch field was added (out of scope; an invalid stored value is dropped).
- The SSE stream now omits the stored `reasoning` record (security audit); UI thinking display is unchanged (chunks).

## Review fixes (code review 7.5/10, 2026-10-18)

- **H1** `openai.ts`: thinking is read from `delta.reasoning_content` **and** `delta[profile.field]` (UI chunks unchanged; identical mirrored text is read once). The completion names `reasoningSource` only when the parsed reasoning is **proven whole**. No source is named when thinking arrives under a reasoning-like key the route does not parse (`reasoning`, `reasoning_text`, `thinking`, …), or when two keys disagree. Then no record is written and the strict gate asks for a reset, instead of `""` being sent in place of lost text. Tests: relay streaming `delta.reasoning` with a `field: 'reasoning'` override (recorded and replayed under that field); default profile plus a `delta.reasoning` relay (no record, gate fires before the network).
- **M1** `builder.ts`: covered messages are stripped of reasoning **before** `retainedCoveredMessages` sizes them. Test fails if the order is reverted.
- **M2** `reasoning.ts`: `capturedReasoning` always returns a record that passes `isReasoningPayload`. An empty source gives no record; a source over 1024 chars is replaced by `h:<sha256>` via `reasoningSourceKey`, which the adapter also uses for planning and `reasoningReplay`, so matching still works. Test writes a record with a long source and reads the JSONL back.
- **M3 (done, not just documented)**: thinking `assistant/chunk` deltas are redacted **before persistence** by `StreamRedactor`. It holds back the trailing token run (≤512 chars, linear scan) so a secret split across deltas is still masked, and flushes on a valid completion; an abandoned attempt's held tail is dropped. It runs in the adapter (with the route API key) and again in the agent loop, so any provider is covered. The record is assembled from the exact persisted pieces and marked `redacted: true` if either layer masked anything. Documented limit: a token longer than 512 chars split exactly at the cap may escape the shape match. The exact API key is still masked in the adapter.
- **M4** `server.ts`: capture, reconstruction and the cache-aware summary all use `handoffAnswer` → `handoffAnswerReasoning`. It places the answer before the summary instruction (a user message) and asks the replay plan. Result: `conversation` keeps the reasoning; `tool-loop`, another route, incomplete reasoning, or no tools drop it.
- **Low**:
  - Reserved keys extended (`__proto__`, `constructor`, `prototype`, `prefix`, `type`, `id`, `index`, `function`, …); field names may not start with `_`.
  - An invalid stored profile logs `console.warn` with the provider id and the validation message only.
  - The API key is passed to redaction at capture (adapter redactor and `capturedReasoning({ apiKey })`).
  - The cancel test is now deterministic (the provider triggers `stop()` in-stream).
  - New tests: SSE `clientEvent` stripping (now exported), summarizer route gate through the strict adapter, builder with no tools.
- **Typed classification**: the gate error has `classification: 'reasoning_replay_missing'`; the endpoint's 400 refusal has `'reasoning_replay_rejected'`. Public reason stays `unknown` (non-retryable), so validators and consumers are unaffected.

Verification: typecheck exit 0 (both tsconfigs). Affected specs: 30 files / 751 tests pass (reasoning-round-trip 32, headless, llm/agent/compaction/web server-compaction/subagents/session-model/models/sse-resume, …). Mutation checks: reverting M1 or H1 fails the matching tests. Full suite not re-run for this round.

## 6. Risks / follow-ups

- If the live endpoint enforces older turns more strictly than our gate, legacy sessions with tools get the actionable 400 hint on their next tool request (no silent failure, no fabrication). PH4-G must confirm before any support claim.
- Redaction masks token shapes only. Other sensitive text in reasoning still persists in the log, same as chunks already did.
- A process without the persisted hasher (unusable data dir) has process-local identities, so after a restart reasoning is not replayed and the strict gate asks for a new session inside an open tool loop. That is never a wrong reuse.
- Rollback: an older binary ignores the unknown `reasoning` field. Snapshot v2 sidecars are refused by old validators, which fall back to fold.
- Re-run PH4 attempt-boundary tests (`reasoning-round-trip` PH4-C/D) after any rebase onto the HC plan.
