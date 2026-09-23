---
title: Cross-project file scope
date: 2026-09-23
summary: "Multi-root file grants with out-of-grant approvals; lessons on waterfall payloads, stamped approval scope, Win32 path normalization"
---

# Cross-project file scope

﻿## What happened
Implemented cross-project file scope (plan `plans/260923-1439-cross-project-file-scope`): file tools now use the project folder plus extra granted folders (project `additionalDirectories`, session `session/grants`, child spawn snapshot), each read or read-write. Paths outside every grant become an approval (forced even when the tool is `allow`, skipped for modes with `outOfGrant: allow` and `--yolo`); root sessions may answer "allow this folder for the session". Leases for foreign folders are taken after approval and are hierarchical. UI: Settings > Projects > Extra folders, composer folder chip, approval card scope warning.

## Lessons
- Kernel waterfall `next(...)` replaces the whole payload: a rewrite listener that forwards only `{ call }` drops `exec`. The dangerous guard now forwards `exec`, and the path-scope guard re-resolves the grant when it is missing.
- `forceAsk` must use the call's stamped scope: `reevaluate()` runs from HTTP handlers with no agent scope, and an ambient fallback would auto-allow a pending out-of-grant question from another workspace. `forceAsk(call, scope)` now carries it.
- Lexical containment is not enough on Windows: `locked.\x`, short names, and junctions inside a read-write folder can land in a nested read-only one. Fixed with segment refusal (trailing dot/space) plus on-disk re-classification of the matched grant.
- UNC paths must be refused before any `stat`/`realpath` (NTLM leak), so out-of-grant classification is purely lexical.

## Verification
typecheck clean; full suite 1036/1036; build:web ok; pm2 restarted, live `GET .../grants` answered. Red-team (37 raw → 16 findings, 15 applied) and code review (7/10, H1 fixed).

## Next steps
- `tests/harness/g4-subagent-contract.spec.ts` "never durably completes a parent when its completed child log cannot flush" is flaky; the spec and executor are being edited by concurrent subagent-lifecycle work, and it fails without this change too.
- Missing tests: bearer-principal rejection, retargeted project-grant follow, post-spawn parent grant invisibility.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
