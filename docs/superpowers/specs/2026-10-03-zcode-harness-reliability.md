# Agent-loop and harness reliability — ZCode-informed supplement

Status: **proposed for user review**. Scope A (end-to-end reliability) selected by the user on 2026-10-03. This document does not authorize implementation or claim the findings are fixed.

## 1. Outcome and boundaries

Make interrupted model requests, Stop/Steer, tool starts, child settlement, compaction and restart produce bounded, truthful outcomes. Preserve the existing kernel, Agent, ToolsService, LlmService, child executor and file-first sessions. A user should not need to send “continue” for a retryable pre-output gateway reset, and should never see successful completion fabricated from a truncated response or unresolved cleanup.

This is a behavioral supplement to:
- [G1 reliable harness](2026-09-09-g1-reliable-harness-design.md).
- [G3 context and modes](2026-09-09-g3-modes-context-skills-memory-design.md).
- [G4 bounded agents](2026-09-09-g4-agents-tools-compatibility-design.md).
- [Root execution domain](2026-09-24-root-session-execution-domain-design.md): preserve current root-local admission and shared-file behavior; do not reintroduce old global writer leases. Its proposed header must not be interpreted as blanket approval of every historical provision.
- [ZCode command lifecycle](2026-10-03-zcode-command-lifecycle.md): preserve foreground/background ownership semantics.
- [Permission-hardening plan](../plans/2026-10-03-permission-hardening.md): coordinate the finalized-call and final-authority boundary; do not build another approval subsystem.

Non-goals: full ZCode parity, workflow/scheduler engine, SQLite migration, detached/recursive agents, provider fallback, mid-turn user-message injection, shell sandboxing, side-effect rollback/replay, automatic crash resumption, automatic regeneration after visible partial output, reactive mid-turn summarization, output-token auto-continuation, new terminal UI.

## 2. Research provenance and limitations

Reference: **zai-org/ZCode commit `29628c9acdb81b703bbd4080c207a0e7ce5e276e`**, verified against GitHub main and the local research checkout. All upstream links in §12 pin this commit. Research inspected source; it did not run ZCode or demonstrate its complete production behavior. ZCode is a reference, not a correctness oracle.

Local baseline: current dirty working tree on 2026-10-03, HEAD `a6aeade`; source line numbers are navigation aids, not immutable historical snapshots. Existing unrelated edits must be preserved. Prior review ran 95 local tests in agent-loop, g1-lifecycle, llm-openai and subagent-stability, all passing; that is not coverage of all findings below.

Session `session-musavygbe1wx2u`, canonical `events.jsonl` observations (UTC+07):
- Line 4149, 18:46:29: cancelled; caller/source of Stop is not established by the record.
- Lines 4386–4387, 18:49:07: internal `terminated`, then failed. Missing cause/stack prevents definitive transport attribution.
- Lines 4394–4395, 18:49:59: provider gateway disconnect before `response.completed`, then failed. No assistant chunk appears in that request's step; unlogged argument activity is unknown.
- No watchdog-timeout record establishes a timeout explanation for these two failures.

Local in-memory adapter reproductions (no live provider): an HTTP-200 gateway disconnect before output becomes `ProviderError(transient=false)`; partial text followed by EOF without `[DONE]` returns success. These reproduce mechanisms, not the historical wire traffic.

## 3. Options and decision

1. Patch only the observed disconnect. Smallest change, but leaves false EOF success, Stop races and unbounded lifecycle.
2. **Recommended: strengthen contracts at existing seams.** Provider completion/failure facts, attempt budgets, mandatory terminal barrier, atomic tool-start admission, consistent projection and durable compaction. Preserve current architecture and execution vocabulary.
3. Adopt ZCode's runtime/recovery architecture. Larger migration, incompatible persistence/input semantics, increased replay and integration risk; rejected for scope A.

The proposal below follows option 2. Architectural changes are limited to provider-neutral facts, lifecycle gates and testable host injection seams—not new Task/Job/Run domain entities.

## 4. Evidence-backed gap inventory

Labels: **U** existing requirement unmet in inspected code; **N** new clarification/amendment; **V** existing capability requiring verification. Upstream evidence IDs refer to §12.

| ID | Priority / class | Local evidence | Gap and relevant upstream reference |
| --- | --- | --- | --- |
| R1 | P0 / U+N | `src/harness/llm/openai.ts:246–296`; `llm/types.ts:126` | EOF finalizes text/calls without completion proof; finish reason absent. Z1/Z4 motivate explicit terminal facts, but do not prove ZCode universally enforces them. |
| R2 | P1 / U | `openai.ts:208–219,259–261`; `agent/agent.ts:594–604` | Broad fetch-error retry, unclassified read errors, HTTP-200 disconnect not transient, nested budgets. Z2/Z3. |
| R3 | P1 / U+N | `agent.ts:532–577`; `openai.ts:229–238` | No silence limit after first progress; reader cleanup absent. Z3/Z5. |
| R4 | P1 / U+N | `openai.ts:282–287,339–361,120–123` | Call identity/index and memory bounds missing; diagnostic truncation happens after full body read. Z4. |
| R5 | P0 / U+N | `agent.ts:338–391,424–434`; `web/server.ts:918–925,1048`; `agents/executor.ts:1074` | Cancellation/failure bypass normal child-closing barrier; bookkeeping can be released while children run. Z6/Z7. |
| R6 | P0 / U | `agent.ts:654–688`; `tools/service.ts:230–246` | Stop after preparation/intent flush can still start a tool; final authority check is asynchronous, prepared execution reusable. Coordinate permission plan. Z8. |
| R7 | P1 / U+N | `agent.ts:353–356`; `agents/executor.ts:1033–1035` | Join error swallowed, report marked consumed before durable model-visible handoff. Existing test explicitly expects completed on continuation failure. Z6. |
| R8 | P1 / U+N | `agent.ts:331`; `limits.ts`; `llm/service.ts:87` | No turn step/lifetime budgets or shared per-physical-request provider cap in this path. Z5/Z7. |
| R9 | P1 / U+N | `agent.ts:287–293,393–395`; `session/service.ts:365–448` | Pre-admission hook exception does not return live claimed inputs. Durable restart reconstruction exists and must remain. Z9. |
| R10 | P1 / U | `session/events.ts:297`; `context/builder.ts:788`; `context/compaction.ts:191` | Alternate projections can retain declared rather than effective rewritten calls. Z10 motivates projection fidelity. |
| R11 | P1 / U+N | `context/compaction.ts:41–75,140`; `web/llm-summarizer.ts:28–43` | Checkpoint direct write, weak validation, incomplete successful-end authority; summarizer lacks in-stream output/time bounds and silently selects prefix. Z10/Z11. |
| R12 | P2 / V+N | `session/service.ts:198–229,391`; `storage/events-jsonl.ts:72,176`; `session/events.ts:60` | Strong existing recovery/durability needs fault matrix; limited structured request diagnostics. Z9/Z11/Z12. |

P0 denotes execution safety/false terminal outcome, not proof of a production incident. Line ranges are evidence for mechanisms; historical cause claims remain limited to §2.

## 5. Model request, stream and retry contracts

### 5.1 Completion is not EOF

Extend the provider-neutral stream vocabulary with explicit terminal facts: normalized finish reason (`stop`, `tool_calls`, `length`, `content_filter`, `error`, `unknown`), safe raw reason where useful, and transport completion status. An iterable ending by itself is not proof of successful model completion.

- OpenAI chat-completions compatibility: a valid choice finish reason establishes semantic completion; `[DONE]` establishes transport completion. Normal success requires a valid completion policy for that adapter. A clean EOF after a valid successful choice finish may be accepted for documented gateways omitting `[DONE]`; EOF after text/tool fragments alone is incomplete. `[DONE]` without a choice finish is not sufficient by default. Any relaxed compatibility profile must be explicit, fixture-tested and visible in diagnostics, never inferred from nonempty content.
- A received provider error always wins over earlier progress. Malformed final buffered data must not be silently dropped. Decode/parse complete SSE records correctly, including multi-line data and terminal tail handling; reject incomplete tail rather than inventing success.
- Final calls are buffered and batch-validated until the request's successful terminal boundary. For `[DONE]` responses, that marker ends the protocol response: validate all preceding records and finish/call facts, cancel unread transport, then yield the validated batch and terminal success. Trailing bytes are outside that response and never processed as additional model output. For the documented finish/EOF profile, EOF plus validated successful finish establishes the boundary. Before either boundary every received error invalidates the response; after acceptance no further provider events may invalidate or extend it. Transport cleanup uncertainty still blocks tool dispatch and terminal publication until ownership is resolved. No tool preparation, approval or execution before these gates.
- `length` means truncated, not completed. Preserve bounded partial text and end the turn with explicit non-success metadata. Do not execute any calls from that truncated response. Output continuation is deferred.
- `content_filter`, unknown or conflicting finish reasons have explicit non-success handling. The user sees actionable category and partial-output state, not an ordinary completed turn.
- All built-in adapters and mock providers must emit/translate completion facts. Generic provider integrations need an explicit compatibility capability; do not silently assume old iterables complete successfully.

### 5.2 Progress and commitment are different

Model progress: nonempty text/thinking, or a valid tool-input fragment. Accounting, empty deltas and SSE heartbeat/comments are not model progress.

Retry commitment: nonempty answer/thinking published into the transcript, or a complete validated tool batch accepted by the loop. Usage, empty deltas and buffered partial tool arguments do not commit output. Fragments from a failed pre-commit attempt are discarded, never concatenated with the retry.

Once committed, this scope prohibits automatic regeneration even if no tool ran. Keep partial UI content visibly failed/cancelled/truncated; it is not an assembled successful `assistant/message` and is excluded from future model context. No automatic tool replay at any point.

### 5.3 Structured classification and one aggregate budget

Provider failures retain bounded structured facts: reason, phase, safe code/status/request ID, retryability, output-commit state, attempt counts and sanitized cause category. Suggested reasons: cancelled, connect/read/reset, first-progress timeout, idle timeout, total timeout, rate limit, server error, auth/configuration, quota/business denial, context exceeded, malformed protocol, invalid tool input, incomplete completion and output limit.

- Classify known transient network resets/read failures and suitable HTTP/gateway failures. Unknown fetch exceptions, TLS verification, bad URL/configuration, authentication and business quota denials do not become retryable merely because they occurred during fetch.
- User Stop, shutdown, logical-request deadline and turn/child budget exhaustion are never provider retries. Attempt-local first-progress/idle timeout may retry only before commitment and within the aggregate budget. Preserve the abort cause; user Stop wins a simultaneous transport failure.
- A single aggregate physical-attempt ledger covers adapter HTTP retries, empty response, pre-commit stream recovery and context-squeeze retries. Every actual fetch consumes one attempt. A provider must not conceal unlimited retries from the owner.
- Use one retry coordinator for built-in adapters; classification/parsing stays in adapters. Direct standalone adapter use may have an explicit bounded policy, but must not stack independent budgets under the agent.
- Retry only if classified eligible, before commitment, within total request/turn deadlines and attempt count. Reassemble context for each new attempt; apply live controls to that next request and record actual selected controls. No silent provider fallback.
- Honor bounded Retry-After and capped exponential jitter. Release provider permit before sleep and reacquire per attempt. Sleep is cancellable and removes timers/listeners on every exit.
- Context exceeded follows bounded squeezing, not generic transport backoff. Reassemble measurably tighter context; if protected input/schemas alone cannot fit, fail with actionable context error. Never repeatedly send identical rejected payloads.

Normative retry classification (eligibility never bypasses commitment, cleanup or aggregate budgets):

| Failure | Eligible before commitment? |
| --- | --- |
| Known reset/read disconnect; clean EOF lacking semantic completion but containing only syntactically valid incomplete tool fragments; empty stream | Yes, once transport ownership is settled. |
| First-progress/idle timeout; suitable 429/5xx or typed gateway transient failure | Yes, with bounded backoff/Retry-After where applicable. |
| Context exceeded | Squeeze path only, within the same physical-attempt budget. |
| Malformed SSE/JSON, inconsistent tool identity, invalid complete tool arguments, size-limit violation | No. Do not treat data corruption as an empty response. |
| `length`, content filter, unknown/conflicting finish, auth/config/TLS/business denial | No; explicit actionable non-success. |
| Stop/shutdown/logical deadline/turn limit, or any failure after commitment | No. |

### 5.4 Bounded resources and transport cleanup

Separate first-progress wait, inter-progress idle and total logical-request deadline. Heartbeats may support transport diagnostics but cannot reset model idle or total deadlines. Long reasoning with no wire progress may legitimately exceed idle; document this tradeoff and permit trusted per-provider/model overrides.

Abort the attempt transport on timeout/failure/consumer return. Cancel unread body and release reader lock in `finally`. Iterator cleanup is best-effort and bounded; cleanup failure cannot replace the primary error. An uncooperative provider must not hang Stop; retain any unresolved ownership/permit rather than claiming the physical request ended. Do not dispatch overlapping retries while termination of the previous physical attempt remains unknown.

Enforce streaming byte limits, not only displayed-string truncation: SSE buffered frame, call count, each argument body, aggregate model output, and error-body reads. Whole batch validation checks index shape/range, stable nonempty ID/name, unique response-local IDs, JSON-object arguments and size caps. Do not repair invalid JSON into `{}`. Inconsistent/incomplete batches execute zero tools.

### 5.5 Physical-attempt admission

Host-injected admission is shared by roots, children and summarizers using a configured provider connection. A cancelled waiter makes zero fetches. Acquire before the physical request; release exactly once only when transport ownership is settled. Backoff holds no permit. Observer failures must not leak a ticket or change execution outcome. This is a semaphore seam, not a workflow scheduler or a new child-capacity policy.

## 6. Turn terminalization, Stop and Steer

Introduce a mandatory terminal-preparation path used by completed, rejected, empty, failed, limit, cancelled and steered outcomes. Optional `turn-settled` observers remain post-terminal notifications, not cleanup authorities.

Order:
1. Close old-turn spawn/tool/model admission, serialized with spawn commitment.
2. Prevent further work on that turn; abort active work where the terminal reason requires it.
3. Retire approval waiters; join/cancel owned active descendants as appropriate. Await verified child/process settlement within cleanup grace.
4. Settle/requeue claimed inputs according to admission state; account for every declared tool call.
5. Durably close open step with its truthful status, record terminal reason/error and flush.
6. Publish verified terminal state, then invoke contained observers/release bookkeeping.

Failure and cancellation cleanup must run even when session persistence is poisoned. A poisoned store cannot claim a durable terminal record; the runtime still owns cleanup and reports storage failure honestly. If cleanup cannot be confirmed, stay cancelling/uncertain, retain handles/capacity, and prohibit replacement execution in that session. A timeout must not erase ownership. Reconciliation can confirm cleanup later; it cannot replay work.

Unresolved ownership is held in a host runtime registry keyed by session/turn/execution or physical-attempt ID, independently of the driver promise and session residency. When storage is writable, append a bounded `execution/uncertain` fact and subsequent reconciliation fact; if poisoned, preserve the live fence and surface the inability to persist. Reload within the same host does not release that fence or permit. Only a verified local operation/transport terminal callback or supported process-tree reconciliation clears live ownership; user input cannot clear it.

After host restart, old model sockets cannot be re-adopted: mark their local attempts interrupted and create fresh host permit accounting, while retaining the historical uncertainty marker. This establishes local connection termination, not proof that remote generation/billing stopped. Unknown tool/process effects remain unknown and require explicit inspection/reconciliation before replacement side-effecting execution; missing child/tool results follow existing recovery rules. Restart alone never replays work. The spec does not promise control over remote provider computation after socket closure.

**Process exception:** root-owned committed background Bash is not an active foreground turn resource and survives root Stop per command-lifecycle spec. Foreground processes abort with the turn. Normal child completion preserves its committed background processes; explicit child cancellation kills/flushed them before parent child cancellation is confirmed. No ownership transfer or child resurrection.

Required child continuation is correctness-sensitive: an exception cannot become “nothing owed.” Surface failure, run mandatory cleanup, and never record completed without known resolution. The parent owns the report-delivery ledger, keyed by parent turn and child result identity. Lookup is read-only. A durable model-visible context handoff stages the report; it is acknowledged as delivered only after that request has a validated successful terminal response and a durable assistant outcome referencing the staged report IDs. Provider failure does not silently consume it. Retain staged context in canonical history, so any pre-commit retry includes it without duplicate insertion. On a later explicit user execution, staged/owed reports can be included once as identified prior results or resolved by explicit dismissal; this reuses evidence, never reruns child tools. Ledger states survive reload independently of per-turn admission bookkeeping.

### Narrow root Steer amendment

Current stop-and-new-turn behavior is retained as a proposed amendment to older no-steering language:
- Ordinary busy input queues for another turn; never inject it into the active turn.
- Explicit root steer cancels current turn and descendants, awaits the same mandatory barrier, then admits pending inputs oldest first in a new turn.
- Stop after steer cancels successor intent; steer may upgrade a stop before verified settlement. Shutdown/admission closure wins over both.
- No successor request/tool starts until previous ownership is resolved. No child steering, same-turn guide injection or resumable child execution.

All workspace/legacy/headless Stop entry points invoke the same control contract. HTTP 202 means `stopRequested/cancelling`, not `stopped: true` while the root still runs. A verified stopped state is published only after settlement.

## 7. Tool and input admission

### Tool-start linearization

A prepared execution is a single-consumption capability bound to immutable finalized call, selected implementation, execution ID, authority receipt and turn signal. Concurrent/repeated execute calls cause at most one body invocation; duplicates return an explicit consumed-capability error, not a second side effect.

- Rewrite before choosing implementation/authorizing; rebind to the finalized tool or reject unsupported cross-name rewrite. Recorded intent and body use identical final arguments/identity.
- Persist final intent before side effects. Recheck cancellation after preparation, after durability and inside the final start gate after every awaited authority lookup.
- Current hard deny wins. A newly required/materially changed ask needs matching exact-call human approval; final gate does not open a fresh question.
- Resolve versioned authority, then synchronously validate signal/revision and consume the capability immediately before body invocation with no intervening await. Retry evaluation on changed revision within a small bound; fail closed on churn.
- After start, no rollback; already-completed operations remain completed. Calls declared but never started get truthful cancellation/denial results. Running noncancellable operations retain ownership until settled; Stop cannot fabricate completion.

The permission-hardening work owns authority composition/receipts. This supplement adds cancellation and consumption invariants to that same seam.

### Input ownership

Durable accepted-input IDs/order/dedup/attachments remain authoritative. Claiming into pre-step is not admission. On pre-step exception or cancellation before durable admission, restore unadmitted input oldest first and clear claims; do not auto-rerun a failed hook. Accepted input remains visible as pending without restart. Ephemeral `send()` input should not silently disappear either.

Admission is a durable ordered prefix: transcript or explicit rejected/empty settlement precedes acknowledgement of consumption. Restart reconstructs pending inputs without automatically running them. Middleware replacement may settle the original ID without attaching it to unrelated inserted text. Duplicate client requests never create duplicate execution.

## 8. Context, compaction and recovery

Preserve current squeezing, protected unanswered call/result batches, projection-only microcompaction, immutable canonical JSONL and completed-boundary summaries. Do not enable reactive mid-turn summarization here.

- One effective-call projection supplies normal history, budgeted builder, summaries and reopened model history. UI may additionally display attempted provider declarations, clearly distinguished from effective calls. Never produce duplicate/mismatched tool-result pairs.
- Existing failed partial chunks stay UI-only. Bound their storage/publication; document that future model context does not contain them. They cannot be promoted to completed declarations on reload.
- Distinguish verified model window metadata from token-count estimation. A known context window does not make chars/4 usage exact; provider usage only calibrates a clearly identified compatible request baseline.
- Summarization receives cancellable deadline/output/input budgets and shares provider admission. Stop/delete/shutdown cancels it. Cap output during streaming; endless stream/no-data stream must settle. Explicitly disclose bounded input selection; never silently summarize only the oldest prefix while forgetting important recent state.
- A successful canonical `compaction/end` contains summary, covered boundary and provenance sufficient to rebuild checkpoint cache. Cache write alone cannot authorize history replacement. Checkpoint files are rebuildable derived state, committed atomically with sync/rename where supported; no fake power-loss guarantee beyond platform tests.
- Commit canonical successful summary before making the checkpoint eligible. If cache publication fails after canonical commit, rebuild from that fact; do not report semantic summary failure or trust an uncommitted cache. A compaction/start without committed end is interrupted on recovery.
- Validate cache against canonical fact: finite integer matching covered sequence, eligible completed boundary, exact summary/provenance, no future or active-turn coverage. Missing/corrupt cache falls back to rebuild/history, never missing task context. Eligibility is versioned: a legacy canonical end may qualify only if it contains sufficient summary/boundary/provenance to validate under an explicit compatibility decoder. Otherwise ignore its legacy cache and rebuild context from intact canonical history; never manufacture missing summary/provenance or omit covered events just because a cache exists. Add fixtures for old ends lacking summary, old checkpoint-only data and corrupt caches; preserve readability even if the resulting full history requires squeezing.
- Serialize compact eligibility against input/turn admission. No summarization replacement of an active turn. Repeated squeeze/compaction attempts cannot loop indefinitely; protected oversized state fails loudly.

Restart retains existing behavior: single-flight load, torn-tail quarantine, middle corruption blocks continuation, approvals invalidated, unfinished turns interrupted, missing tool result synthesized as **outcome unknown**, never tool failure/no-effect proof. New request requires explicit user action. Recovery is idempotent over durable prefixes and cannot cache half-recovered state or recreate deleted sessions.

## 9. Proposed limits and configuration

Numbers below are **proposed defaults requiring approval and fixture validation**, not copied ZCode guarantees. Centralize them in HarnessLimits/config validation. Positive finite integer durations/counts only; malformed config fails visibly or uses a documented fallback. No unbounded sentinel in scope A.

| Limit | Proposed default | Notes |
| --- | --- | --- |
| First model progress | 600 s | Preserve current generous first-event window. Starts after physical admission, not queueing. |
| Model progress idle | 300 s | New; trusted provider/model override allowed; reasoning-silence tradeoff visible. |
| Logical request deadline | 30 min | Includes admission queue, all attempts, squeeze and backoff. |
| Physical attempts / logical request | 4 | Includes initial request; replaces stacked built-in budgets. |
| Retry delay | 1 s base / 30 s cap + jitter | Existing adapter already has jitter; do not claim it is missing. |
| Root turn steps / wall time | 256 / 4 h | Includes continuation steps; time includes tools/approval/join. Limits are independent. |
| Child steps / wall time | 128 / 1 h | Definition/spawn grants may narrow; not reset by retries. |
| Provider in-flight attempts | 4 per configured connection | Trusted host config; applies to roots/children/summarizers. |
| Cleanup grace | 10 s | Past it unresolved ownership remains cancelling/uncertain, not success. |
| SSE buffered frame | 1 MiB | Reject before unbounded accumulation; encoded-byte accounting. |
| Tool calls / response | 128 | Whole-batch validation. |
| Tool arguments | 2 MiB per call / 8 MiB aggregate | Do not truncate executable JSON; fail before tools. |
| Model output / attempt | 8 MiB | Includes reasoning; previews/storage must also be bounded. |
| Error diagnostic read | 16 KiB bytes / 4,000-char display | Cancel reader at cap; don't read entire body first. |
| Summarizer | 120 s / 64 KiB output | Abort/output enforced during generation. Input selection separately bounded and disclosed. |

Keep command-lifecycle defaults (120 s foreground / 600 s maximum wait / 1 h child background) unchanged. Turn expiry cancels owned foreground work and child execution, not previously committed root background processes. Join remains at most its existing configured bound and remaining turn budget.

A repeated-call heuristic is diagnostic only initially: identical arguments do not prove no progress. Hard step/time caps terminate loops; no speculative tool deduplication/replay suppression based merely on a hash.

## 10. Diagnostics and compatibility

Optional provider-neutral observer/status seam reports bounded facts: logical request/physical attempt IDs, session/turn/step attribution, actual provider/model, phase, queue/wait time, first/last progress times, finish state, commitment, retry decision/delay, cancellation source and cleanup certainty. Persist compact attempt start/end/retry facts at meaningful boundaries, not every byte/heartbeat.

- Durable attempt records correlate to step and actual controls even on failed requests, not only successful assistant messages. Attempt outcome is terminal exactly once; projection ignores diagnostics as model content.
- Default diagnostic data excludes prompts, raw tool arguments, credentials, cookies, URL query credentials, encoded media and arbitrary headers. Allowlist metadata; bound nested error causes; sanitize public errors separately from canonical conversation content. Intentional authenticated transcript/context inspection remains possible.
- Observer failures are contained; mandatory durability/admission/cleanup failures are not observers and cannot be swallowed. Telemetry callbacks cannot hold/leak permits.
- Extend events with optional backward-compatible fields/new variants and update closed-union readers, exports, UI projection and storage validators. Old logs remain readable; missing historical completion/attempt metadata is `unknown`, not retroactively fabricated. Do not require old sessions to replay or regenerate.
- Show retrying/waiting/cancelling separately from completed. Partial/truncated output and cleanup uncertainty are visible after reload. Changes must work in web and headless hosts; PTY behavior is unaffected.

## 11. Acceptance matrix and delivery gates

Tests use controllable async iterators, fake clock/RNG, latches around await boundaries and storage fault injection. Live models are not correctness oracles. Keep real shell/process-tree and temporary-filesystem integration tests for OS/resource guarantees.

| Test ID | Scenario | Required outcome |
| --- | --- | --- |
| A01 | Text or valid JSON call then EOF, no semantic finish | Incomplete provider outcome; zero tool prepare/body calls. |
| A02 | Valid finish + `[DONE]`; documented valid-finish/EOF profile | Success exactly once; compatibility policy recorded; no implicit relaxation. |
| A03 | `length`, filter, conflicting finish, gateway error after content | Non-success, labeled partial output; zero calls from rejected response. |
| A04 | Usage/empty delta/partial args then transient reset | Safe bounded retry; no duplicate chunks, stale fragments or tools. |
| A05 | Nonempty text/thinking then transient failure | No retry; failed UI partial, excluded model history after reload. |
| A06 | Reset/read termination/429/503 versus TLS/auth/quota/bad URL | Correct typed classification; one aggregate physical-attempt cap. |
| A07 | Context overflow repeated under multilingual estimation error | Smaller reassembly within budget; protected pairs/input preserved; final actionable failure. |
| A08 | First progress stall; mid-argument stall; infinite heartbeats | Relevant deadline aborts; cleanup/ownership honest; Stop wins races. |
| A09 | Never-resolving iterator/return or transport ignores abort | Driver responsive; unresolved ownership blocks unsafe overlap; no permit released as if settled. |
| A10 | Infinite error body/no-newline frame/endless arguments | Bounded consumption, body cancelled, no raw sensitive error payloads. |
| A11 | Interleaved calls, conflicting IDs/names, sparse/huge indices, duplicate IDs, invalid/oversized JSON | Valid batches assemble; invalid batch invokes zero tools. |
| A12 | Cap=1 across root/child/summary, retry and queued Stop | No overlapping admitted physical requests; no permit in backoff; observer throw cannot leak. |
| A13 | Stop during prepare, durable flush or final-authority await | No unstarted body; every declared call accounted for. |
| A14 | Prepared capability executed twice; rewrite; allow→ask/deny race | At most one correctly rebound body; immutable exact-call gates; stale receipt denied. |
| A15 | Root provider/internal/storage failure while child runs/awaits approval | Admission closed and cleanup attempted on all paths; no terminal success before verified settlement. |
| A16 | Spawn races terminalization; child cleanup is paused | Spawn belongs to old turn and is drained, or rejected; no orphan/new admission after closing. |
| A17 | Steer while child cleanup paused, then Stop/shutdown | No successor model/tool before barrier; latest Stop/closure leaves input queued. |
| A18 | Join throws, report retrieved then handoff persistence fails, uncertain child | No false completed/consumed claim; report inspectable and child ownership retained. |
| A19 | Endless tool loop; turn/child deadline during tool/approval/join | One limit outcome; cleanup awaited, queued input untouched, no automatic replay. |
| A20 | Pre-step throws; input-admission durable prefix crash/restart | Unadmitted input remains visible/ordered/deduplicated; no restart autorun. |
| A21 | Tool name/args rewritten, microcompact/summary/reopen | Shared effective-call/result projection; no stale identities or orphan pairs. |
| A22 | Summarizer hangs/endless output/oversize input; Stop/delete | Bounded cancellation; exclusions disclosed; canonical history unchanged. |
| A23 | Compaction cache write/sync/rename failure or crash before/after end | Only canonical committed summary authorizes replacement; rebuildable cache; dangling operation interrupted. |
| A24 | Future/active range, malformed cache/provenance, deleted caches | Reject invalid range; rebuild/fallback without losing current task. |
| A25 | Torn tail/middle corruption/failed recovery append/concurrent load | Existing quarantine/blocking preserved; no half-cache or duplicate recovery/replay. |
| A26 | Root Stop versus background commitment; normal child finish versus cancel | Command ownership contract preserved; cancellation process exit flushed before parent result; no child resurrection. |
| A27 | Diagnostic canaries, observer throw, old event fixtures, web/headless Stop | No secret leakage/leaked permits; backward read compatibility; requested vs verified stopped distinguished. |

Delivery order, not an implementation plan:
1. Completion/error/bounded parser contracts (R1–R4), aggregate retry facts and tests.
2. Mandatory terminal barrier + tool-start admission + input/report ownership (R5–R9), coordinated with permission work.
3. Projection/compaction/recovery correctness (R10–R12).
4. Provider admission, diagnostics/UI integration and full fault/compatibility matrix.

Before implementation: user approves contracts/defaults and narrow Steer amendment; resolve overlap with permission-hardening owner; convert this spec to a separately reviewed implementation plan. Before claiming completion: failing regressions first, then targeted/full tests, both typechecks, legacy-event compatibility and supported-OS process/storage integration evidence. No commit/restart/live retry is authorized by this document.

## 12. Pinned upstream evidence and deliberate non-adoptions

Every path below is relative to `apps/zcode-cli/packages/` at the pinned commit.

- **Z1 — retry boundary:** [stream-retry-boundary.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/stream-retry-boundary.ts#L6-L24). Buffers lifecycle/tool-input prelude; nonempty text/reasoning commits. Learn the boundary, not automatic regeneration.
- **Z2 — classification:** [failure-classifier.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts#L115-L294). Distinguishes cancellation, idle, business, auth and TLS. Avoid importing provider-specific codes without applicable fixtures.
- **Z3 — retry/stream:** [retry-policy.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/retry-policy.ts#L13-L38), [stream-idle-timeout.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/stream-idle-timeout.ts#L98-L166), [runner-stream.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-stream.ts#L825-L944). Useful capped jitter/status/read race; not a guarantee every cleanup path closes transport.
- **Z4 — completed tools/model:** [streaming-tool-call-assembler.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/streaming-tool-call-assembler.ts#L79-L110), [runtime model.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/model.ts#L390-L479). Tool-end gating and explicit finish metadata; upstream also defaults finish to unknown, so stricter local completion policy is our decision.
- **Z5 — physical admission:** [request-admission.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/request-admission.ts#L7-L59). Acquire/release each attempt, no ticket while backoff. Its awaited onAdmitted callback precedes wrapper construction; local observer containment must avoid ticket leaks on callback failure.
- **Z6 — lifecycle:** [turn-machine.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/agent/turn-machine.ts#L92-L103), [subagent.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts#L370-L418). Phase validation and conditional abort cleanup; neither proves every upstream failure drains ownership.
- **Z7 — loop boundaries:** [turn-loop.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-loop.ts#L43-L109), [runtime-command-queue.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts#L72-L110). Abort checks around awaited preparation and command ownership leases. Not evidence of a universal step cap.
- **Z8 — permission races:** [permission-flow.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/tool/executor/permission-flow.ts#L178-L230), [permission-input-recheck.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/tool/executor/permission-input-recheck.ts#L50-L82). Response races and modified input rechecks; conditional upstream reapproval is not our universal exact-call authority guarantee.
- **Z9 — durable input:** [session-inputs.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts#L1-L35), [promotion](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/session-inputs.ts#L191-L245). Learn durable admitted/promoted ledger invariant, not SQLite implementation.
- **Z10 — context:** [compact.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/compact.ts#L313-L380), [session-history-hydrator.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/agent/session-history-hydrator.ts#L149-L200). Usage-calibrated context/reactive compact and restored completed tool content; mid-turn summary replacement remains deferred locally.
- **Z11 — recovery:** [compact-persistence.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/compact-persistence.ts#L200-L255), [cold-session-resume.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-session-resume.ts#L49-L110), [fs-fault-injection.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/storage/fs-fault-injection.ts). Interrupted compact reconciliation, single-flight activation and operation-targeted fault injection; not authorization for local execution resume.
- **Z12 — diagnostics:** [runner-debug-redaction.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-debug-redaction.ts), [runner-network-headers.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/runner-network-headers.ts). Media/header redaction reference; name-based header filters are not universal secret safety.

Do not adopt without a separate decision:
- [retry-budget.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/retry-budget.ts): unbounded retry sentinel/off-peak indefinite retry conflicts with bounded scope A.
- [streaming-recovery.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/streaming-recovery.ts#L140-L220): anchor/tail discard after published output would change local no-post-output-retry contract.
- [tool-input-normalization.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/adapters/src/model/tool-input-normalization.ts#L24-L48): malformed JSON fallback can turn invalid intent into default-argument operation; keep strict validation.
- [turn-output-token-continuation.ts](https://github.com/zai-org/ZCode/blob/29628c9acdb81b703bbd4080c207a0e7ce5e276e/apps/zcode-cli/packages/core/src/runtime/methods/turn-output-token-continuation.ts#L12-L56): bounded continuation is interesting but adds model steps/behavior beyond this proposal.
- Same-turn guide/Stop-hook continuation, child resume, workflow orchestration and SQLite storage remain outside scope. Numerical defaults above are local proposals, not claims of ZCode equivalence.
