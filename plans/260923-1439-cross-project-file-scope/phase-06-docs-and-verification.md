---
title: "Phase 6: Docs and verification"
status: todo
priority: P2
effort: "0.5d"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Docs and verification

## Overview
Make docs match the new scope model and run the full gate.

## Requirements
- Update smallest owning sections: `docs/architecture.md` (Layer 2 fs tools: multi-root grants; isolation paragraph), `docs/capabilities.md` (containment: primary + additional roots, out-of-grant approval, blocked UNC/device paths, junction escapes hard-denied, Bash still unconfined; error text at `:46`), `docs/web.md` (grant endpoints, auth, UI), modes doc for `outOfGrant`.
- State headless = single root, out-of-grant hard-fails.
- Historical specs (G2) are not edited; the decision lives in architecture docs.
- Tool descriptions (`Read/Write/Edit/Glob/Grep`) mention absolute paths into granted folders.
- Full gate: `npm test`, typecheck, lint, `npm run build:web`, `pm2 restart dnt-harness`, live check.

## Related Code Files
- Modify: `docs/architecture.md`, `docs/capabilities.md`, `docs/web.md`, `docs/harness.md` (modes section, if it owns mode fields), `src/capabilities/fs/tools.ts` (descriptions)

## Implementation Steps
1. Edit docs; verify every claim against code (endpoint paths, field names, error text).
2. Grep `docs/` + README for "workspace root"/single-root claims and reconcile.
3. Run full gate; fix regressions, never weaken tests.
4. `/ak:code-review` — security-sensitive change to path containment and approvals.

## Success Criteria
- [x] All gates green; review has no open high-severity findings.
- [x] Docs contain no single-root claims that contradict behavior.

## Risk Assessment
- Stale doc statements elsewhere; mitigated by step 2.
