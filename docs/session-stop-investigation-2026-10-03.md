# Session stop investigation — 2026-10-03

Read-only diagnosis; no runtime configuration or implementation changes made.

## Scope and provenance

User reported repeated stops, including with claude-opus-5-5. Inspected canonical local JSONL files with bounded JSON parsing; line numbers below refer to physical JSONL lines. Current source was inspected, not assumed to be a historical snapshot. The Opus continuation was located as a different root session from the originally supplied id.

Session directory prefix `D` = `/Users/dungnt/.dnt-harness/data/workspaces/ws-mur65pzr745ftn/sessions/`.

- Original: `D/session-mur8pjtjpx39m7/events.jsonl`; first human prompt at line 7: “Dùng superpower, a đang lên dở plan cho core, kiểm tra tiến độ và tiếp tục. lên plan cho a”; initial model timestamp at line 1: 2026-10-03 00:31:35.960 local (+07).
- Matching Opus root: `D/session-murr19djuhiuof/events.jsonl`; first human prompt at line 7: “docs/superpowers/plans/2026-10-02-core-release-roadmap.md r eview plan này c ho a”; model timestamp at line 1: 2026-10-03 09:04:35.383 local (+07).
- This match is based on model, errors and related document work; not an explicit new session id supplied by the user.

## Verified observations

Original root failed at 08:44:13.679, exactly 120.005 seconds after its final visible chunk (original JSONL:52359,52361), then completed a continuation at 08:55:06.004 (original JSONL:53045).

Opus root failed twice:

| Last visible model output | Error | Gap | Evidence in Opus root JSONL |
| --- | --- | --- | --- |
| 09:31:58.162 | 09:33:58.164 | 120.002 seconds | lines 982–984 |
| 09:35:43.706 | 09:37:43.707 | 120.001 seconds | lines 1000,1002–1003 |

Both errors say `provider stream stayed inactive past the limit`. Context manifests identify cliproxy/claude-opus-5-5 (Opus root JSONL:974,990). Text before both failures announces rewriting Phase 6 (Opus root JSONL:975–982,991–1000). This is not proof of subsequent wire traffic.

Two Opus child sessions also failed with `cliproxy: stream ended without any model output` (D/session-murrk8m22u1lu3/events.jsonl:263–264; D/session-murrlxjwq5m8ol/events.jsonl:146–147). These are distinct from the root inactivity errors; no assertion that they share a root cause.

Earlier zcode errors occurred approximately 300 seconds after their context manifests, while chunks continued until milliseconds before failure (original JSONL:242,17897–17898;18339,38197–38198;38213,50601–50602). These show a gateway-reported timeout, not proven Cloudflare connection failure. Prior tunnel-specific attribution and prior reported times were unsupported/incorrect.

## Confirmed implementation mechanism

`src/harness/agent/agent.ts:504–520` re-arms the watchdog only when the provider async iterator yields an event. Defaults are 600 seconds before first event and 120 seconds afterward (`src/harness/limits.ts:46–47`).

`src/harness/llm/openai.ts:276–285` accumulates streaming tool-call arguments without yielding any event. Completed calls are yielded only at `[DONE]` or EOF (`src/harness/llm/openai.ts:244–245,289–292`). Consequently continuous tool-argument wire traffic can be misclassified as inactivity by the agent.

This implementation problem affects all models using this adapter. A long Write/Edit/Bash argument stream following a short text introduction is vulnerable; changing the model does not eliminate the mechanism. SSE comments are also discarded (`src/harness/llm/openai.ts:239–242`), but whether heartbeats should reset the watchdog is a separate semantics question.

## Reproduction

Ran a local in-memory mocked fetch through the actual OpenAiCompletionsProvider, without contacting any provider and without changing files. It emitted initial text, then tool argument fragments every 40 ms. At 220 ms the result was:

`{"elapsedMs":220,"wireChunks":6,"toolFragmentsProduced":5,"nextAgentEventYielded":false}`

The next agent event (`toolCalls`) appeared only at completion. This proves progress invisibility. It is a compressed adapter experiment, not a replay of the production requests or a full agent timeout integration test.

A read-only independent reviewer confirmed the same mechanism and reported absent coverage for real adapter tool-fragment streams crossing watchdog windows (`tests/harness/g1-lifecycle.spec.ts:173–249`; `tests/harness/llm-openai.spec.ts:15–25`).

## Verdict and limitations

Immediate cause of the two matching Opus stops: local harness inactivity watchdog, precisely 120 seconds after last yielded model event. Confirmed code-level issue: watchdog is blind to in-flight tool arguments. The text preceding both failures makes this a strong operational hypothesis, but canonical logs do not record raw tool argument fragments; actual wire activity during those requests is unknown. A truly stalled upstream remains possible.

No evidence here establishes gateway overload from parallel agents, Cloudflare as the cause, or a defect in a superpowers skill. No model substitution is a demonstrated remedy. Distinct empty-output failures require additional wire evidence.

A decisive follow-up would measure received wire/tool-fragment activity and yielded-event activity for the same request, without recording content or credentials. No live retry, server restart or code fix was performed in this investigation.
