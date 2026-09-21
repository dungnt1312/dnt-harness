# Phase 2 — HTTP surface: REST + multiplexed SSE

Expose the Phase 1 service over the existing transport. No new dependency.

## Context

`src/web/server.ts` already streams SSE with a 25 s heartbeat and answers POSTs; the
approval bridge is precisely the "stream out, POST back" shape this needs. Browsers cap
HTTP/1.1 at ~6 connections per origin and the chat stream already owns one, so every
terminal in a workspace shares **one** SSE stream rather than opening its own.

## Requirements

- Workspace-scoped routes, matching the existing `…/:wid/…` families and their
  fail-closed ownership re-check.
- One multiplexed SSE endpoint per workspace.
- Terminal frames never enter `WebEnvelope` or the session event stream.
- Loopback-only enforcement, and a clean `501` when `node-pty` is missing.

## Files

| File | Change |
|---|---|
| `src/web/server.ts` | edit — construct the service, route wiring, dispose on close |
| `src/bins/web.ts` | edit — pass the bind host so the loopback gate can be evaluated |
| `tests/web/server-terminals.spec.ts` | **new** |

## Steps

1. **Construct** the terminal service in `createWebServer()` alongside the other
   services. Add `WebServerOptions.terminals?: { enabled?: boolean; spawner?: PtySpawner }`
   — `enabled` defaults to true, `spawner` exists so tests inject a fake.

2. **Routes** (all under the workspace-ownership check already used by sibling families):

   | Route | Behaviour |
   |---|---|
   | `GET …/:wid/terminals` | `{ terminals: TerminalInfo[], shells: ShellOption[], max: 4 }` |
   | `POST …/:wid/terminals` | body `{ shellId?, projectId?, cols, rows }` → `201 TerminalInfo` |
   | `DELETE …/:wid/terminals/:tid` | kill → `{ killed: true }` |
   | `POST …/:wid/terminals/:tid/input` | body `{ data }` (base64) → `202` |
   | `POST …/:wid/terminals/:tid/resize` | body `{ cols, rows }` → `200` |
   | `GET …/:wid/terminals/events` | multiplexed SSE |

3. **SSE envelope** — a separate type from `WebEnvelope`, deliberately:

   ```ts
   type TerminalEnvelope =
     | { kind: 'snapshot'; terminals: TerminalSnapshot[] }  // info + base64 scrollback
     | { kind: 'created';  terminal: TerminalInfo }
     | { kind: 'data';     terminalId: string; data: string }   // base64
     | { kind: 'exit';     terminalId: string; exitCode: number; reason: 'exit' | 'killed' | 'idle' }
   ```

   Payloads are base64 because PTY output is a byte stream that may split a UTF-8
   sequence across chunks; the client decodes and feeds xterm. Reuse the existing 25 s
   heartbeat and the `close`-time listener disposal so a dropped tab leaks nothing.

4. **cwd resolution.** `projectId` present → that project's working folder, validated
   through the existing project lookup; absent → the workspace root. A path that is not
   an existing directory is `400`. The user can `cd` out afterwards — the same honest
   caveat `docs/web.md` already states for the `Bash` tool.

5. **Gates.**
   - Service unavailable (`node-pty` missing) → `501` with the resolution hint.
   - `terminals.enabled === false` → `404`, as if the family did not exist.
   - Bind host outside `127.0.0.1` / `::1` → `403` on every terminal route, with an
     explanatory body. `src/bins/web.ts` passes the host it listens on; the gate lives in
     the server so a programmatic embedder cannot skip it by accident.

6. **Shutdown.** `server.close()` already forces connections down before stopping the
   kernel; add `terminals.disposeAll()` to that path so no PTY outlives the host.

## Validation

```sh
npx vitest run tests/web/server-terminals.spec.ts tests/web/server.spec.ts
npm run typecheck
```

New spec covers: create → list → input → resize → kill round trip; SSE snapshot then live
`data`; `exit` on shell exit; cap → `400`; unknown workspace → `404`; unknown terminal →
`404`; unavailable service → `501`; non-loopback host → `403`; `disposeAll` on close.
`tests/web/server.spec.ts` must pass unchanged — proof the terminal family is additive.

## Risk / rollback

Additive routes plus one line in the shutdown path. Setting `terminals.enabled = false`
removes the whole surface without touching anything else; a full revert is Phase 2's diff
alone, since Phase 1 is independently inert.
