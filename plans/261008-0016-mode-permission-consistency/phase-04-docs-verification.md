---
phase: 4
title: "Docs and whole-change verification"
status: completed
depends_on: [1, 2, 3]
---

# Phase 4: Docs and whole-change verification

## Steps

1. `docs/capabilities.md:250-255` — replace "In Plan, MCP is exposed only when…" with the
   `mcpExposure` rule (none / read-safe / all; default derivation; explicit opt-in).
1b. State the behavior change: custom modes exposing none of Write/Edit/Bash now default to
   read-safe MCP, including already-stamped conversations at their next request; opt back in with
   `mcpExposure: all` and reselect.
2. `docs/web.md:71` Modes editor paragraph — mention the MCP tools selector.
3. `npm run typecheck` (exit 0).
4. `npx vitest run tests/web/permission-hardening.spec.ts tests/harness/modes.spec.ts tests/web/server-g3.spec.ts tests/harness/memory-tools.spec.ts tests/harness/g3-context.spec.ts web/components/settings/settings-panels.spec.tsx tests/bins/headless.spec.ts tests/web/out-of-grant-approval.spec.ts`.
5. Broad: `npx vitest run tests/web tests/harness`; any failure re-run in isolation; report flaky vs real.
6. Re-run the mode-matrix probe (temp script, deleted after) to confirm bundled matrix unchanged
   and `plan-copy` / read-only custom now hide mutating MCP.

## Success Criteria

- All plan success criteria checked with command evidence.
