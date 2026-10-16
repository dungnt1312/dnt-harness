# Core agent loop review fixes (code-review-261015-2309)

All of F1–F7 were still present in the code on 2026-10-16. All are now fixed, each with a regression test.

| ID | Status | Change | Test |
|---|---|---|---|
| F1 | fixed | `src/harness/session/session.ts` `fork()`: `child.committedLog = [...child.log]` (the copy is committed by `store.replace` before the service exposes the child) | `tests/harness/session.spec.ts` "fork counts the copied history as committed…" |
| F2 | fixed | `src/harness/agent/agent.ts` `turn()`: a `claimOwned` flag; a failure before admission (e.g. a throwing pre-step) unshifts the claim back into the inbox | `tests/harness/agent-loop.spec.ts` "a throwing pre-step hands the claimed input back…" |
| F3 | fixed | `src/web/server.ts` `submitMessage` + `queueHookRewake`: after the barrier, adopt `sessions.pendingInputs(session)` again instead of the snapshot taken before the append. The re-read includes the new input, so the separate `enqueueAccepted` is gone | `tests/web/server-g1.spec.ts` "a DELETE that lands while a later POST waits on its barrier stays deleted" |
| F4 | fixed | `src/harness/llm/service.ts` `configureAdmission`: also refuses while `uncertain.size > 0` | `tests/harness/request-lifecycle.spec.ts` "refuses to replace an admission that still holds an unresolved attempt" |
| F5 | fixed | `agent.ts` failure path: `closeOpenStep(turnId)` before `turn/error` | `agent-loop.spec.ts` "a failed step closes its step/start before the turn error" |
| F6 | fixed | `session.ts` `fork()`: the child no longer inherits `durableListener` | same test as F1 |
| F7 | fixed (defect) | `agent.ts` `requeueInjected()` on a non-audited reject and on empty. `docs/harness.md:227` says injected context "must reach the next admitted request", so dropping it breaks the contract | `agent-loop.spec.ts` "a rejected or emptied pre-step keeps injected context…" |
| doc | fixed | `docs/harness.md:947`: the truncation-recovery wording now matches the code (2 recoveries; the 3rd cutoff fails the turn) | — |

The new F2/F3/F5/F7 tests were checked: with each fix reverted they fail, and with the fixes restored they pass.
