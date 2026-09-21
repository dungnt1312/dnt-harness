# Phase 4 — Hardening, packaging, docs

## Context

Two things are only provable end to end: that a native dependency actually installs on a
clean clone, and that no PTY survives a shutdown. Both are handled here, together with the
documentation this feature contradicts.

## Requirements

- A fresh clone gets a working terminal, or a clear message saying why not.
- Zero orphaned processes across shutdown, idle and crash paths.
- Docs state what the terminal is and — just as importantly — what it is not.

## Files

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | edit — allow `node-pty` builds |
| `README.md` | edit — the npm install-scripts approval step |
| `docs/web.md` | edit — Workbench is no longer read-only; route family; terminal section |
| `docs/capabilities.md` | edit — shell detection now shared, if it says otherwise |
| `tests/browser/terminal.e2e.ts` | **new** |

## Steps

1. **Packaging.** `pnpm-workspace.yaml` currently holds `allowBuilds: { esbuild: false }`;
   add `node-pty: true`. For npm users document
   `npm install-scripts approve node-pty`, because npm 11 silently skips the build
   otherwise and the failure surfaces much later as a missing binary. This was hit for
   real while validating the approach, so it is a certainty, not a precaution.

2. **Process hygiene** (the standing process-management rule):
   - `server.close()` → `disposeAll()`, asserted by a test that checks the PTY handles
     were killed.
   - Idle reaper verified with an injected short `idleMs`.
   - Confirm on Windows that killing a PTY takes its children with it; ConPTY normally
     handles this, but it is checked rather than assumed — the existing `Bash` tool needed
     an explicit `taskkill /T` for the same reason, and if the PTY path shows the same
     leak it gets the same treatment.

3. **Loopback gate** exercised end to end: boot on `0.0.0.0`, confirm every terminal route
   answers `403` while chat keeps working.

4. **Docs.**
   - `docs/web.md`: correct the read-only Workbench claim; add the route family row; add a
     terminal section stating plainly that it is **ephemeral** (never in the session log,
     gone on restart), **user-only** (no approval gate, by design — the user is the one
     typing), **separate from the agent loop**, loopback-only, capped at 4 per workspace,
     and reaped after 30 min idle.
   - `docs/capabilities.md`: note that shell resolution is shared between the `Bash` tool
     and the terminal, so there is one answer to "which shell is this".
   - Record in this plan that `plans/260918-1007-warm-studio-workbench/plan.md`'s "no
     terminal" non-goal is superseded, rather than editing that closed plan — plans are
     stateful records, not evergreen authority.

5. **Playwright** `tests/browser/terminal.e2e.ts` against a real backend: open the view,
   run a coloured command, assert ANSI colour reaches the DOM, resize and assert reflow,
   `Ctrl+C` a sleep, reload the page and assert scrollback plus a live session return.

## Validation

```sh
npm test
npm run typecheck
npm run build:web
npm run test:browser
```

All four exit 0. Manual matrix at 1280, 1440 and 1920px in both themes (the Workbench
docks at ≥1280; below that it is a sheet, which is checked at 768 and 375 for layout
sanity rather than terminal usability).

## Risk / rollback

Docs and configuration, plus one shutdown hook. The riskiest item is the child-process
kill behaviour on Windows; if ConPTY leaves strays, the mitigation is the `taskkill /T`
pattern already proven in `src/capabilities/shell/bash.ts:100`.
