---
status: completed
branch: feat/workbench-terminal
---

# Workbench Terminal — interactive PTY panel

## Outcome

A real terminal inside the web Workbench: user types, a PTY-backed shell answers with
full colour, resize, `Ctrl+C` and curses apps (`vim`, `top`). Multiple tabs, a shell
picker, sessions that survive a page reload. Completely decoupled from the agent loop —
the agent keeps its captured-output `Bash` tool and its approval gate, unchanged.

## Decisions (user-accepted 2026-09-21)

| Decision | Choice |
|---|---|
| Surface | Panel in the web Workbench, beside Files / Context / Artifacts |
| Fidelity | Real PTY — `node-pty` + `@xterm/xterm` |
| Relationship to agent | **Fully separate**; no shared shell session |
| Approval | **None.** The user types the commands; per-command approval is meaningless here |
| Concurrent terminals | Multiple tabs, capped at 4 per workspace |
| Shell | User-selectable: Git Bash / PowerShell / cmd |
| Lifetime | Survives tab close; reload reattaches; reaped after 30 min idle |
| Feature gate | Enabled by default; refuses to serve when the host is not loopback |

## Constraints / non-goals

- **No agent-loop contact.** The terminal service must not touch `agentScope`,
  `session/event`, `attachApproval`, or `ToolsService`. It is a web-host resource
  wired only in `createWebServer()`, and it is not exported from `src/index.ts`.
- **Not durable.** Terminal output never enters the session log — a single `cat` of a
  large file would break snapshot replay. Scrollback lives in a capped server-side ring
  buffer and dies with the host.
- `bashTool`'s public contract does not change; its approval mode stays `ask`.
- No new transport dependency: output rides SSE, input rides POST, exactly like the
  existing approval bridge.
- Existing `tests/harness/**` and `tests/web/server.spec.ts` must pass untouched.

## Pre-verified ground truth (measured 2026-09-21, this machine)

Windows 11, Node v22.22.0:

- `node-pty@1.1.0` installs from a **prebuilt binary** — no node-gyp, no VS Build Tools.
- It bundles ConPTY `1.23.251008001` (win10-x64) itself.
- Spawning Git Bash `-i` through it works: real prompt, 27 ANSI colour sequences in the
  first 1.6 KB, `resize(120, 40)` triggers a correct shell redraw.
- **npm 11 blocks its install scripts by default** (`npm warn allow-scripts`), leaving the
  native binary uninstalled. `pnpm-workspace.yaml` already carries an `allowBuilds` block.
  Phase 4 must configure this or a fresh clone gets a silently broken terminal.

Git on this machine is at `C:\laragon\bin\git\...`, so the `where git` fallback branch of
the existing detection is the live path — one more reason the detection must not be
duplicated.

## Phases

| # | Phase | Status | Depends |
|---|-------|--------|---------|
| 1 | [Shell detection + TerminalService](phase-01-terminal-service.md) | done | — |
| 2 | [HTTP surface: REST + multiplexed SSE](phase-02-http-surface.md) | done | 1 |
| 3 | [Client: xterm panel with tabs](phase-03-client-panel.md) | done | 2 |
| 4 | [Hardening, packaging, docs](phase-04-hardening-docs.md) | done | 3 |

Each phase must `typecheck` and keep its targeted suite green before the next starts.

## Contracts this change breaks (deliberate)

1. **The Workbench stops being read-only.** `docs/web.md` currently states the Workbench
   is read-only, and `plans/260918-1007-warm-studio-workbench/plan.md` lists "no terminal"
   as a non-goal. That constraint is now superseded; Phase 4 updates the docs rather than
   letting them go stale.
2. **`detectBash` moves out of `bash.ts`.** Internal refactor only; `bashTool()`'s exported
   signature and behaviour are unchanged, and `tests/capabilities/bash.spec.ts` proves it.

## Outcome notes (2026-09-21)

- `plans/260918-1007-warm-studio-workbench/plan.md` lists "no terminal" among its
  non-goals. That constraint is **superseded** by this plan, not retracted: plans
  are stateful records of what was decided then, so it stays as written and the
  correction lives here and in `docs/web.md`.
- `src/bins/web.ts` parsed `--root` and never passed it to `createWebServer` —
  a pre-existing dead flag. It now feeds `terminals.defaultCwd` only.
  Deliberately **not** passed as `root`: that would widen the file tools' legacy
  grant, which is a separate decision from where a user's shell opens.
- Windows PTYs are created with `useConptyDll`. Measured: the default kill path
  forks a console-list helper that dies with `AttachConsole failed` and prints a
  stack trace once the shell has exited (reproduced under plain `node`, so not a
  `tsx` artifact); the DLL path forks nothing. Both reap a backgrounded
  grandchild, so this buys quiet without losing cleanup.
- The Playwright pass uses the repo's fixture pattern (vite + intercepted
  `/api/**`), not a real backend as this plan first assumed — that is how every
  other suite here works. It still exercises the real xterm build in Chromium:
  ANSI colour reaching the DOM and typed keystrokes batching into one request.
  No test spawns a PTY in CI.

## Risks

| Risk | Mitigation |
|---|---|
| Install scripts blocked → no native binary | `allowBuilds` entry + documented npm approval step (Phase 4); service degrades to `501`, never a crash |
| `node-pty` unavailable on another OS/CI | Lazy `await import()`; terminal routes answer `501` with an actionable message, rest of the product unaffected |
| Output flood (`yes`, `cat bigfile`) fills SSE queue | Coalesce `onData` into 16 ms batches; drop past a per-flush ceiling and emit a truncation marker |
| Orphaned PTY processes | `disposeAll()` on `server.close()` + 30-min idle reaper |
| xterm in jsdom unit tests | Mock `@xterm/xterm` in vitest; real rendering covered by Playwright |
| +250 KB initial bundle | `React.lazy` the terminal panel |

## Acceptance

- A user opens the Terminal view, picks a shell, runs `vim`/`top`/a coloured `ls`, hits
  `Ctrl+C`, resizes the panel and the shell reflows — all correct.
- Up to 4 tabs per workspace; the "+" control disables at the cap.
- Closing the browser tab leaves a running build alive; reopening replays scrollback and
  reattaches to the live stream.
- Terminal traffic appears in **no** session log, and opening a terminal produces **no**
  approval question.
- `createWebServer()` boots and serves everything else normally with `node-pty` absent.
- Server bound to a non-loopback host refuses terminal routes with `403`.
- `server.close()` leaves zero surviving PTY processes.
- `npm test`, `npm run typecheck`, `npm run build:web`, `npm run test:browser` all exit 0.
