---
phase: 3
title: "Instructions and memory guidance truthfulness"
status: completed
---

# Phase 3: Instructions and memory guidance truthfulness

## Context

- `src/harness/modes/bundled.ts:21-22` Ask-before-changes instructions.
- `src/web/server.ts:2512-2519` memory write auto-allow (only `ask` → `allow`, path must be
  `in-grant` memory `.md`).
- `src/harness/memory/context.ts:11-15` `memoryGuidance(roots)` — single write-oriented text.
- Call sites: `src/web/server.ts:2321-2322` (condition: any of Read/Write/Edit/Glob/Grep exposed),
  `src/bins/headless.ts:236`.
- Test: `tests/harness/memory-tools.spec.ts:75-…` asserts current guidance content.

## Design

- Ask-before-changes instructions: append
  "Saving Markdown notes inside the memory folders may proceed without a separate approval."
  ("may" — the web host auto-allows them, `src/web/server.ts:2512-2519`; headless still asks,
  `src/bins/headless.ts:201-206`, so the text must be true for both hosts. Red Team F3: chosen
  over porting the exception to headless to keep scope minimal.) <!-- Red Team: F3 -->
- Already-stamped Ask-before-changes sessions keep their old instructions until reselected
  (snapshot authority, `src/web/server.ts:1907-1915`). Accepted: the old text is stricter than
  behavior (it over-promises asking), never looser; not migrated. <!-- Red Team: F6 -->
- The write variant body stays byte-identical so existing manifests/hashes of write modes don't churn;
  Plan sessions get one new guidance hash on their next request (expected, one-time).
- `memoryGuidance(roots, access: 'read' | 'write' = 'write')`:
  - `write`: current body unchanged (hash-stable for existing sessions).
  - `read`: same roots/frontmatter description, "Read topic Markdown files on demand with
    Read/Glob/Grep." plus "This mode cannot write memory; if something seems worth remembering,
    say so in your reply instead." Keep the "When to use it" check-index sentence, drop the save sentence.
- Call sites pass `'write'` only when the exposed schemas include `Write` or `Edit`; else `'read'`.
  Headless already computes `memoryAccess` (`headless.ts:181`) — reuse it, but derive from exposed
  schemas there too for consistency.

## Files

- Modify: `src/harness/modes/bundled.ts`, `src/harness/memory/context.ts`, `src/web/server.ts`,
  `src/bins/headless.ts`.
- Tests: `tests/harness/memory-tools.spec.ts`; host context test in `tests/harness/g3-context.spec.ts`
  or `tests/web/server-g3.spec.ts` (whichever already asserts memory guidance in an assembled request —
  locate with grep `Memory usage` / `Persistent file memory` before writing).

## Steps (TDD)

1. RED: `memoryGuidance(roots,'read').body` contains "cannot write memory" and not "Write/Edit Markdown".
2. RED: `memoryGuidance(roots)` body unchanged (default write).
3. RED (host): Plan-mode request context contains the read variant; Full-access contains write variant.
   If no existing harness for an assembled web request with memory is cheap, assert at the
   selection helper level instead (extract `memoryGuidanceAccess(exposedNames)` pure function).
4. GREEN; run targeted suites.

## Success Criteria

- Tests pass; existing guidance test unchanged.
