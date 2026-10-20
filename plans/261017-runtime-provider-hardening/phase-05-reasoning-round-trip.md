# Phase 05 — Reasoning round-trip + history compatibility

## Context Links

- Spec §10 PH-4.
- Code: `src/harness/agent/agent.ts`, `src/harness/session/events.ts`, `src/harness/llm/{types,openai}.ts`, `src/harness/context/*`, `src/web/{compaction-capture,agent-delegation,server}.ts`, `src/harness/agents/executor.ts`.

## Overview

- Priority: P1 for native DeepSeek thinking + tools.
- Status: Implemented, committed `355056f`. Pending gate: PH4-G live DeepSeek smoke (no `DEEPSEEK_API_KEY`); no native thinking+tools support claim until it passes. Deviation: default replay window = whole conversation, gate = active tool loop. Report: [reports/phase-05-reasoning-round-trip.md](./reports/phase-05-reasoning-round-trip.md).
- Preserve required reasoning without locking legacy sessions or replaying sensitive/injected text unnecessarily.

## Key Insights

- Reasoning chunks are currently UI-only; assistant messages lack reasoning.
- Native DeepSeek docs require reasoning replay for tool-call loops; exact earlier-turn requirement needs evidence.
- Length-truncated assistant messages can be continued in-turn.
- Compaction digest v1 hashes assistant content and tool ids.

## Requirements

- Add optional reasoning `{ text, complete, source }` to durable assistant messages/model messages.
- `source` uses route identity v1 from Phase 4, including credential generation.
- Accumulate per successful attempt; reset on retry/abandon.
- Replay window is profile-defined. Default strict DeepSeek window: assistant messages after the latest user message in the active tool loop. Older reasoning is omitted.
- Strict gate checks only replay window. Legacy history outside window does not block.
- Length continuation records an explicit incomplete state; strict profile must use a verified continuation rule or fail with actionable message. Do not fabricate.
- Replay only to profiles that require reasoning; supporting-but-not-required profiles omit it by default.
- Count replayed reasoning in context estimate and size bounds.
- Apply secret-shape redaction before persistence/replay. Redacted reasoning is not marked byte-faithful.
- Apply reasoning aging: older reasoning is not resurrected after source tool results are compacted; outside replay window it is omitted.

## Compatibility Matrix

| Consumer | Decision |
|---|---|
| `events.ts` projection | Project eligible reasoning only for target profile/window |
| Compaction digest/snapshot | Dual-read v1; v2 only for sessions/snapshots with reasoning-bearing replay |
| `compaction-capture.ts` final answer | Compare content and reasoning only when snapshot v2 includes it |
| `agent-delegation.ts` | Never include reasoning in inherited parent text |
| `executor.ts` child result | Never include reasoning in child report |
| `session/service.ts` recovery | Preserve tool-call recovery; reasoning has no execution meaning |
| `server.ts` SSE/replay/export | Keep existing authenticated UI behavior; no public export by default; audit raw event exposure |
| headless renderer | Do not print stored reasoning twice |

## Architecture

- Agent captures; event stores; projection selects; adapter serializes.
- Profile owns field, requirement, replay window.
- Compaction keeps a v1 validator for old sidecars and adds v2 only where semantics change.

## Related Code Files

- Modify: `src/harness/agent/agent.ts`, `src/harness/session/events.ts`, `src/harness/llm/{types,openai}.ts`.
- Modify: `src/harness/context/{builder,compaction-digest,compaction-snapshot,compaction-projection}.ts`.
- Modify: `src/web/{compaction-capture,agent-delegation,server}.ts`, `src/harness/agents/executor.ts`, `src/harness/session/service.ts`, `src/bins/headless.ts`.
- Modify if validators require it: storage event decoding/validation modules.
- Tests: agent loop, session/event projection, OpenAI adapter, context/compaction, web replay/delegation, executor, headless/web fake gateway E2E.

## Implementation Steps

1. Gather native DeepSeek evidence for replay window and length continuation.
2. Add fixtures: legacy session + new user turn, active tool loop, length continuation, abandoned attempt, credential rotation, compacted 0.3 session.
3. Extend types and validators.
4. Capture/redact reasoning per attempt.
5. Implement windowed projection and adapter serialization.
6. Add strict pre-network gate only for replay window.
7. Add compaction dual-read v1/v2.
8. Update all consumers in matrix.
9. Run fake E2E and opt-in native smoke.

## Todo List

- [x] Replay-window evidence (report §1; default `conversation` replay, tool-loop gate).
- [x] Fixtures.
- [x] Types/validators.
- [x] Per-attempt capture/redaction.
- [x] Windowed projection.
- [x] Strict gate.
- [x] Compaction dual-read.
- [x] Consumer matrix complete.
- [x] PH4 tests (A–F).
- [ ] PH4-G live smoke: `scripts/smoke-deepseek-reasoning.ts` added, not run (needs `DEEPSEEK_API_KEY`).

## Success Criteria

- PH4-A through PH4-G pass after amendments.
- Legacy DeepSeek session can start a new user turn when old turns are outside replay window.
- Pre-upgrade compacted session resumes using v1 snapshot without re-summarization.
- Credential/account change does not replay prior reasoning.
- Reasoning never leaks to delegation/child reports.

## Risk Assessment

- Provider replay requirement differs from evidence: profile window is explicit and testable.
- Compaction migration storm: dual-read v1.
- Injection/secret persistence: redaction, aging, minimal replay window.

## Security Considerations

- Reasoning is untrusted assistant-derived text and may repeat tool injections.
- Never replay outside required window or across credential generation.
- Treat raw events/forks as sensitive data.

## Next Steps

- Phase 6 docs/release after native support decision.
