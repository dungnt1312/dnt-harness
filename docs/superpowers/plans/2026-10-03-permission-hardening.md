# Permission Hardening Implementation Plan

> For implementers: execute task-by-task using subagent-driven-development or executing-plans. Use test-driven-development for each behavior change and verification-before-completion before claiming success. This document is a plan, not a claim that the defects are fixed.

**Goal:** Enforce the same effective authority for schemas, preparation, pending approval reevaluation, and the final side-effect boundary. Prevent root/child scope confusion, rewrite identity mismatches, and stale authorizations after mode, guard, or grant changes.

**Architecture:** Preserve the existing agent loop and durable session storage. Introduce shared permission/exposure evaluation and explicit execution scope. Finalize rewrite input before authorization; bind approval evidence to immutable final arguments and execution identity; reevaluate live restrictions before execution. Do not rewrite the application or introduce an OS sandbox.

**Stack:** TypeScript, Node.js, existing kernel event bus, JSONL sessions, Vitest.

## Scope and decisions

- Preserve unrelated working-tree changes. Re-read files before editing; do not reset, clean, stage broadly, or commit unless requested.
- Root mode remains conversation-owned; workspace selection only seeds new conversations.
- Root agents self-root; child agents retain their supplied root identity.
- Child tools are capped at admission-time exposure intersected with definition, explicit spawn grant, and disallowed tools. Later root widening does not add tools; later narrowing removes current usability.
- Host restrictions, mode exposure, child ceiling, unsafe/read-only path restrictions, and guard deny are hard restrictions. Human approval cannot override them.
- Permission precedence stays exact name -> MCP server wildcard -> catch-all -> configured default. Preserve existing yolo semantics: transform configured non-deny defaults, not omitted keys; never bypass explicit denies, ceilings, or interaction requirements.
- Authorization cannot rewrite. Only the rewrite phase changes a call; the finalized call and its arguments are host-owned immutable snapshots.
- Final gate never opens a new question or reruns hooks. If authority newly requires approval and no suitable human approval exists, return a truthful failed tool result requiring a fresh call.
- Guard updates reevaluate each pending entry with its own workspace/root scope and current guard decision, never ambient HTTP scope.
- Out-of-grant target/path intent is snapshotted; the governing exemption is live. A policy-driven allow is not proof that a human approved an outside path.
- Plan MCP exposure requires a non-empty explicit tool allowlist plus the existing read-safe-name filter. This preserves the existing intended feature, but does not guarantee that a remote tool is side-effect-free. Document this limitation; do not trust names or readOnlyHint as a sandbox. Completely disabling MCP in Plan is a separate stronger product option, not silently introduced here.
- Child additional-folder grants are spawn snapshot intersected with current parent effective grants. Parent additions never widen a child; removal or write-to-read downgrade narrows it. This intentionally strengthens revocation semantics.
- Dangerous Commands remains a best-effort heuristic, not a shell security boundary. Fix known comment/newline bypasses without claiming comprehensive shell parsing.
- Already-started tool effects are not rolled back or retroactively cancelled solely by a mode change. Authorization changes apply to unstarted bodies. Existing Stop/process ownership behavior is preserved.

## Findings and evidence baseline

Confirmed runtime probes from review: child root identity overwritten; workspace guard save releases a mode-required pending approval using the wrong policy; wildcard deny and allow-to-ask ignored at final gate; multiline comment hides subsequent command; Write rewritten to Read executes Write implementation; Plan without explicit allowlist reaches approval for read-prefixed MCP names.

Source-traced gaps requiring failing regression tests before implementation: spawn ceiling lacks admission mode; guard checks pre-hook input; live guard changes not enforced at final gate; cached out-of-grant exemption; child grant revocation; guard execution cache cleanup.

Existing passing suites do not cover these cases. Review runs passed 97 tests in six files, and a later run passed 55 tests in six files; these counts are baselines, not security assurances.

## Shared contracts

Proposed modules (adjust names only if existing architecture provides a better seam):

- `src/harness/approval/resolution.ts`: pure canonical permission lookup, reused by initial, pending, and final gates.
- `src/harness/tools/authority.ts`: structural authority types and pure composition of hard denial, permission, and ask requirements. Keep web resource lookups outside this module.
- `src/web/execution-authority.ts`: host resolver for explicit execution scope, root mode, MCP exposure, child ceilings, and current guard requirements; injected seams make tests hermetic.

Authority facts must contain workspaceId, rootSessionId, sessionId, executionId, finalized call fingerprint, mode revision, and guard revision/hash where applicable. A decision is `deny(reason)`, `ask(requirements)`, or `allow`. Ask requirements have stable kinds (tool-policy, dangerous-command, outside-path, interaction) and a subject fingerprint/version when their meaning can change.

An execution-scoped authorization receipt distinguishes policy allow from durable human approval. It binds to the exact finalized call and records which requirements the human saw. A receipt is not model input, not a global reusable tool allow, and not another mutable cache keyed by model call ID. A current hard deny always wins. A newly required or materially changed ask without matching approval fails at final gate. Expiry/Stop/deny never resurrect entries.

Async resource reads can race: resolve a versioned authority snapshot, then recheck its revision immediately before synchronous dispatch admission. Retry evaluation if changed; bound retries and fail closed on persistent churn. Define that admission as the permission linearization point. Do not hold a root lock across a tool body or human approval wait.

## Task 1 — Shared permission resolution and explicit scope

**Files:** Create `src/harness/approval/resolution.ts`, `src/harness/tools/authority.ts`; modify `src/harness/approval/policy.ts`, `src/harness/tools/types.ts`; tests `tests/harness/g1-approval.spec.ts` plus new `tests/harness/authority.spec.ts`.

- [ ] Write failing table-driven tests for canonical aliases, exact override of server wildcard, server wildcard override of catch-all, omitted/default behavior, explicit denies under yolo, and forced interaction asks.
- [ ] Add tests proving a pending entry resolver receives its stamped root/workspace/session/execution scope when called outside agentScope.
- [ ] Implement pure resolution and authority composition. Missing required host execution scope fails closed in the web authority resolver; standalone/headless ToolsService compatibility remains explicit and covered, not guessed.
- [ ] Extend approval options with a scope-aware async authority resolver while preserving legacy policy-source behavior for generic harness consumers. Reevaluate entries individually, not through one ambient policy getter. Make reevaluation awaitable so callers can handle resolver failures and deterministic retirement.
- [ ] Preserve exactly-once settlement and durable allow-before-side-effect ordering. Resolver exceptions deny; no unhandled fire-and-forget promises.
- [ ] Run `npx vitest run tests/harness/g1-approval.spec.ts tests/harness/authority.spec.ts` and verify RED then GREEN.

## Task 2 — Finalized rewrite identity and immutable execution intent

**Files:** Modify `src/harness/tools/service.ts`, `src/harness/tools/types.ts`; tests `tests/harness/tools.spec.ts`, `tests/harness/tool-final-gate.spec.ts`.

- [ ] Add failing tests: Write->Read rewrite invokes Read, never Write; rewrite to unknown tool fails; rewrite to root-required tool fails without root; rewriting away from root-required tool uses final implementation requirements; nested argument mutation after prepare does not change executed input.
- [ ] Complete rewrite before selecting the implementation. Canonicalize and snapshot final call, deep-freezing or equivalently preventing mutation of JSON arguments.
- [ ] Make authorization input non-rewriting. Reject any pre-execute middleware attempt to change tool identity or arguments, and update legacy middleware/tests rather than trusting a changed call after earlier gates.
- [ ] Ensure prepared call, authorization fingerprint, durable intent, selected implementation, and tool body all refer to the same final identity/arguments. Unknown original-tool handling must have an explicit tested contract; do not allow unknown targets to run accidentally.
- [ ] Preserve current execution identity, denied-result post hooks, and approved-path cleanup on all failure branches.
- [ ] Run `npx vitest run tests/harness/tools.spec.ts tests/harness/tool-final-gate.spec.ts`.

## Task 3 — Correct child ownership and pin admission ceiling

**Files:** Modify `src/harness/agent/service.ts`, `src/harness/agent/scope.ts`, `src/harness/agents/executor.ts`, `src/web/agent-delegation.ts`, `src/web/server.ts`; tests `tests/harness/g4-subagent-contract.spec.ts`, `tests/web/server-subagents.spec.ts`, `tests/web/root-mode.spec.ts`.

- [ ] Add failing identity test: supplied rootSessionId survives AgentsService.create; ordinary roots still self-root and repeated create preserves first identity.
- [ ] Add end-to-end HTTP and Agent-tool spawn cases: workspace Full/root Plan forbids child Write/Bash; workspace Plan/root Full admits appropriate child tools; fabricated hidden tool calls deny as well as schema filtering.
- [ ] Extend host-only spawn admission inputs with an explicit resolved exposure ceiling. Both entry points obtain it from the owning root; model grantTools only narrows. Low-level executor tests must provide an explicit fixture ceiling or trusted resolver, not silently infer Full.
- [ ] Intersect admission ceiling with role tools, explicit spawn grant, and disallowed tools. MCP names require explicit grant and admission eligibility. Resolve before durable spawn commitment/queue dispatch so queued children cannot gain rights from later widening.
- [ ] Preserve supplied root identity; retain childOf identity. Test Plan->Full does not add tools to existing/queued child, Full->Plan narrows it, root switching reevaluates child approvals, and siblings remain unaffected.
- [ ] Run `npx vitest run tests/harness/g4-subagent-contract.spec.ts tests/web/server-subagents.spec.ts tests/web/root-mode.spec.ts`.

## Task 4 — One host exposure resolver and Plan MCP allowlist

**Files:** Create `src/web/execution-authority.ts`; modify `src/web/server.ts`, delegation admission wiring; tests `tests/web/server-g3.spec.ts`, `tests/web/server-g5.spec.ts`, new `tests/web/permission-hardening.spec.ts`.

- [ ] Add failing tests that schema filtering, spawn ceiling capture, preparation, and final checks make the same exposure decisions.
- [ ] Extract shared exposure predicate/resolver with explicit scope. Preserve host blockedTools, child cannot Agent, definition ceiling, enabled-server and allowlist checks, and zero-exposure modes.
- [ ] Keep general MCP omitted/empty allowedTools semantics unchanged. For Plan require a concrete non-empty matching allowlist entry and read-safe name; cover omitted, empty, bare name, full name, nonmatching list, unsafe prefix, disabled server, stale fabricated call, and Explorer.
- [ ] Delegate server request schema projection and tool execution gates to this resolver. Never infer permission allow from schema exposure or MCP annotations.
- [ ] Run `npx vitest run tests/web/server-g3.spec.ts tests/web/server-g5.spec.ts tests/web/permission-hardening.spec.ts`.

## Task 5 — Approval evidence and live final authority

**Files:** Modify `src/harness/approval/policy.ts`, `src/harness/tools/service.ts`, `src/harness/tools/types.ts`, `src/web/execution-authority.ts`, `src/web/server.ts`, session event types if additional audit fields are necessary; tests `tests/harness/g1-approval.spec.ts`, `tests/harness/tool-final-gate.spec.ts`, `tests/web/permission-hardening.spec.ts`.

- [ ] Write failing pause-between-prepare-and-execute tests for exact deny, MCP wildcard deny, catch-all deny, allow->ask, and exposure narrowing. Use handshakes, not sleeps.
- [ ] Introduce execution-scoped receipt for durable human approval vs automatic allow; bind call fingerprint, scope, and shown requirement subjects. Old session logs without optional evidence fields remain readable; no execution resumption on restart.
- [ ] Final check resolves current authority using Task 1/4 logic. Deny always fails; ask succeeds only with appropriate receipt. New interaction/guard/path requirements must not be covered by a generic policy allow or an approval that never presented them.
- [ ] Test existing appropriate human approval remains valid when authority changes without changing its requirements; policy-only allow cannot bypass a later ask. Stop after approval but before dispatch must prevent unstarted body.
- [ ] Guard against argument mutation, cross-root receipts, model-call-ID collisions, duplicate settlement, and abandoned preparations retaining authorization state. Define prepared execute as single-use or explicitly prevent duplicated side effects.
- [ ] Exercise authority revision change during async evaluation; re-evaluate or deny before dispatch admission. Preserve already-running body behavior.
- [ ] Run `npx vitest run tests/harness/g1-approval.spec.ts tests/harness/tool-final-gate.spec.ts tests/web/permission-hardening.spec.ts`.

## Task 6 — Post-rewrite guard and safe live settings updates

**Files:** Modify `src/harness/guard/guard.ts`, guard store/types where revisions are needed, `src/web/server.ts`, `src/web/execution-authority.ts`; tests `tests/harness/guard-pipeline.spec.ts`, `tests/web/server-guard.spec.ts`, `tests/web/permission-hardening.spec.ts`.

- [ ] Register only fake Bash tools in guard regression fixtures: capture command text, never call shell.
- [ ] Add failing safe->deny, safe->ask, ask->deny, dangerous->safe rewrite cases. Guard evaluates final command after hooks, independent of prepend registration ordering.
- [ ] Make current guard decision a fact consumed by initial, pending, and final evaluation. Cache by execution/call fingerprint plus config version only as an optimization; never retain an authoritative stale WeakMap match after invalidation.
- [ ] Replace workspace/global guard-save reevaluation calls with per-entry scoped resolution. Await reevaluation; unrelated roots/workspaces must retain their own policy.
- [ ] Test workspace default Full/root Ask: saving unchanged guard config does not autoapprove innocuous pending Bash. Also test inverse defaults and a second workspace.
- [ ] Test pending guard ask->deny then old allow answer stays denied; off->deny after prepare denies; off->ask without human evidence refuses; ask->off removes only the guard requirement, preserving mode/path/interaction asks. Cover inherited global config and workspace overrides.
- [ ] Retire strong guard execution maps on completion, denial, cancellation, expiry, and preparation failure. Test bounded retained state across many calls without exposing private state as a production API solely for tests.
- [ ] Run `npx vitest run tests/harness/guard-pipeline.spec.ts tests/web/server-guard.spec.ts tests/web/permission-hardening.spec.ts`.

## Task 7 — Live path requirements and child grant revocation

**Files:** Modify `src/web/path-scope-guard.ts`, `src/web/server.ts`, `src/web/execution-authority.ts`, `src/harness/tools/service.ts` if grant intersection needs a seam; tests `tests/web/out-of-grant-approval.spec.ts`, `tests/web/path-scope-guard.spec.ts`, `tests/web/folder-grants.spec.ts`, `tests/web/folder-grants-auth.spec.ts`.

- [ ] Add failing exempt/Read-ask -> restricted/Read-allow test: outside read stays pending rather than automatically receiving an approvedPath. Verify human-approved exact path still works.
- [ ] Keep classification target/intent immutable, but derive exemption and current ask requirement from explicit root scope. Final gate must reject policy-only approval when outside access now requires human consent.
- [ ] Narrow child additional grants to spawn snapshot intersected with current owning-parent effective grants, including write/read access. Preserve primary project root handling and protected storage restrictions.
- [ ] Test parent grant addition never expands child, removal and write->read downgrade narrow it during pending/prepared calls, session/project grant changes, and no impact on sibling roots. Snapshot read-only nested-root precedence remains intact.
- [ ] Do not persist a requested session grant on a final authority denial; bind session-grant mutations to appropriate human consent and current validation. Preserve durable grant audit and atomic mutation queues.
- [ ] Run `npx vitest run tests/web/out-of-grant-approval.spec.ts tests/web/path-scope-guard.spec.ts tests/web/folder-grants.spec.ts tests/web/folder-grants-auth.spec.ts`.

## Task 8 — Matcher boundary fixes and documented limits

**Files:** Modify `src/harness/guard/matcher.ts`; tests `tests/harness/guard-matcher.spec.ts`, `tests/harness/guard-pipeline.spec.ts`; docs `docs/harness.md`, `docs/capabilities.md`.

- [ ] Add failing LF/CRLF comment-followed-by-command tests, leading comment lines, multiple comments, quoted #, escaped quotes/hash, escaped newline, and compound commands.
- [ ] Preserve line/command boundaries when removing actual comments; do not collapse newline before stripping. Avoid corrupting quoted literal content to manufacture allow matches. If syntax is unsupported, retain conservative inspection instead of silently discarding executable text.
- [ ] Add fixtures documenting limitations (quoted executable names, escapes, substitutions, heredocs, scripting interpreters, and Windows shells). Do not introduce a partial tokenizer advertised as full shell parsing.
- [ ] Preserve documented custom allow precedence unless explicitly changing its contract; document that a substring allow can exempt a compound command. Recommend narrowly anchored patterns. A redesigned per-command exception system/full parser is deferred, not quietly bundled into this fix.
- [ ] Run `npx vitest run tests/harness/guard-matcher.spec.ts tests/harness/guard-pipeline.spec.ts`.

## Task 9 — Integration verification, review, and documentation

**Files:** Update `docs/harness.md`, `docs/capabilities.md`, `docs/web.md`, and relevant README statements only where behavior changes. Do not rewrite unrelated edits.

- [ ] Document live root mode, immutable child admission ceiling, narrowed grant revocation, final-gate retry behavior, Plan MCP limitations, and guard non-sandbox semantics.
- [ ] Add deterministic cross-feature matrix: rewrite + child + mode switch; guard save + outside-path ask; global guard inheritance + sibling roots; yolo + explicit deny/interaction; permission change at durable intent barrier.
- [ ] Run targeted suites from Tasks 1–8, then `npm run typecheck` and `npm test`. Check both backend and web TypeScript. If a full-suite failure predates this work, reproduce against baseline and report it explicitly; do not label the whole suite passing.
- [ ] Request an independent security-focused code review covering every side-effect entry point and authority lifecycle. Resolve findings with regression tests, then rerun affected checks.
- [ ] Inspect `git diff --check` and task-specific diffs. Verify no unrelated files/hunks were overwritten and no fake-tool repro touched real shell/destructive targets.
- [ ] Report actual commands/results, changed files, deliberate limitations, and any remaining blockers. No commit or merge without user request.

## Dependencies and execution strategy

Run Task 1 first. Task 2 and initial Task 3 ownership tests can proceed independently on disjoint files, but Tasks 3–7 share `src/web/server.ts`: one implementer integrates server wiring, or coordinate serial edits and re-read. Task 4 uses Task 3 admission contract. Task 5 depends on Tasks 1/2/4. Task 6 depends on Task 5 receipts. Task 7 depends on Tasks 3/5. Task 8 can run independently of core changes. Task 9 runs last.

Prefer small reviewed changes per task over one giant security refactor. Tests must fail for the intended missing behavior before implementation; fixture errors are not RED evidence. Do not run dangerous real shell commands as proof.

## Acceptance criteria

- [ ] No child executes a tool outside admission ceiling/current root exposure or resolves workspace mode in place of its owning root.
- [ ] Final recorded call, approved call, and executed implementation/arguments agree.
- [ ] Initial approval, reevaluation, and final gate use identical permission precedence and explicit root scope.
- [ ] Newly narrowed mode/guard/path restrictions deny or retain required asks before side effects; setting saves do not answer unrelated human questions.
- [ ] Human approval is exact-call and requirement-bound; no automatic policy allow is mistaken for human consent.
- [ ] Schema filtering and execution agree, including explicit Plan MCP allowlist and child MCP grants.
- [ ] Child additions never widen grants and parent revocations/downgrades take effect before unstarted file bodies.
- [ ] Multiline comments cannot hide later commands from the intended preset matcher; known heuristic limitations are explicit.
- [ ] Lifecycle state is retired and resolver failures fail closed without hanging waiters or unhandled promises.
- [ ] Regression suites, both typechecks, and full-suite outcome are recorded honestly; unrelated workspace changes remain intact.
