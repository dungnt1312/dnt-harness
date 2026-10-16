# Task 2 — Part B remainder: one final request, vision, handoff, window, legacy listener

Worktree: `/Users/dungnt/workspace/dnt-harness/.worktrees/context-accounting` (after Tasks 0–1). Spec: `/Users/dungnt/workspace/dnt-harness/plans/261015-1347-context-tool-prompt-contract/spec.md` §5 (Part B) — read it fully; acceptance criteria AC-13..AC-22 in §6 are your target.

After Task 0 the host has one assembly function (merged `assembleRequest` in `src/web/server.ts`) used by the `agent/context` listener and by `reconstructFromLog`. Read Task 0's report first: `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-0-report.md`.

TDD: for each item write the failing test first and record the RED reason.

## 1. One final request object (D4)

The capture is armed with `{ ...projected, messages, tools }`, which loses the resolved `model`/`providerName`/`thinkingLevel` and, when the mode exposes no tools, resurrects `projected.tools`. Build the final request **once** (controls + `contextId` + messages + tools-or-absent) and use that same object for `captures.arm(...)` and for the value returned to the agent.

Test: capture a request through the existing capture/compaction test harness (see `tests/web/compaction-wiring.spec.ts`, `tests/web/server-compaction-effective.spec.ts`) for a session whose model differs from the global default, and for a zero-tool custom mode; the captured request's `model`/`providerName` equal the session pair, and `tools` is absent in the zero-tool case.

## 2. Vision fallback only names a tool that exists (D5, AC-16)

`src/harness/llm/adaptive-vision.ts`: change `textOnlyVisionFallback(messages, describeAvailable: boolean)`. When `true`, keep today's text. When `false`, say the current model cannot see image pixels and no image-description tool is available in this request, so the agent must say it cannot view the image. Never mention `DescribeImage` in that case. Update every caller (builder, any remaining adapter). In the builder, `describeAvailable` = the request's final schemas include `DescribeImage`.

Tests: `tests/harness/adaptive-vision.spec.ts` both branches; `tests/harness/g3-context.spec.ts` non-native build with and without `DescribeImage` in schemas.

## 3. Compaction handoff adapts to the target model (D6, AC-17)

The handoff request built from a snapshot (`src/web/compaction-generator.ts` `requestFor`, sent by `retryingCompactionStream`, which bypasses `agent/request`) forwards image parts unchanged. After `retarget`, if the target model is not native-vision (same `supportsNativeVision(model, override)` rule the host uses for chat), replace image parts with the fallback using `describeAvailable: false` (the handoff runs no tools). Keep the stored snapshot on disk unchanged. Native target: unchanged.

Test: a snapshot containing an image part handed to a non-native target yields a handoff request with no image parts and no `DescribeImage` mention; native target keeps the image.

## 4. One window for model-without-provider (D12, AC-18)

The assembly returns `DEFAULT_BUDGET` when provider is absent but model is set, while compaction uses `resolveModelBudget({ model })`. Use `resolveModelBudget({ model, contextTokens? })` whenever a model is known (operator override only exists with a provider). `DEFAULT_BUDGET` only when there is no model.

Test: in the server test harness, a session with a model and no provider gets a manifest `contextLimitTokens` equal to the window compaction uses.

## 5. Remove the legacy `agent/request` duplication

The `agent/request` listener still re-resolves controls (command model, thinking) and calls `adaptRequestVision` for requests without `contextId`. Every web agent request now passes through the assembly. Reduce the listener to what is still needed (if nothing, delete it) and delete `adaptRequestVision` if unused. If some request path legitimately reaches `agent/request` without assembly, keep only that path and explain in the report with evidence.

Test: existing `server-session-model`, `server-adaptive-vision`, `server-native-vision`, `server-models` stay green.

## 6. Command model rules (AC-13, AC-20)

Confirm and pin with tests:
- A slash command with `model:` pointing at a model with a smaller window: manifest `contextLimitTokens`, the dispatched request's `model`, and the capture all match the command model. An invalid command model falls back to the conversation model.
- `reconstructFromLog` while a command grant is active uses the session model, not the command model.

Add these in `tests/web/server-session-model.spec.ts` (or the nearest suite that already drives slash commands; search for `turnCommandGrants` / `model:` frontmatter usage in tests).

## Verify and commit

```sh
pnpm exec vitest run tests/harness/adaptive-vision.spec.ts tests/harness/g3-context.spec.ts tests/harness/g5-prompt-contract.spec.ts tests/web/server-session-model.spec.ts tests/web/server-adaptive-vision.spec.ts tests/web/server-native-vision.spec.ts tests/web/server-models.spec.ts tests/web/server-g3.spec.ts tests/web/compaction-wiring.spec.ts tests/web/server-compaction-effective.spec.ts tests/web/compaction-host.spec.ts tests/web/server-compaction.spec.ts --maxWorkers=1 --no-file-parallelism
pnpm run typecheck
```

Use the files that exist. Commit: `fix(context): one final request for capture and dispatch; vision-aware handoff and fallback`.

Report to `/Users/dungnt/workspace/dnt-harness/plans/261015-1406-context-wip-completion/task-2-report.md`. Return only status, commit hash(es), one-line test summary, concerns.
