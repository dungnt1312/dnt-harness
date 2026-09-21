# Code review — workbench terminal (feat/workbench-terminal)

Scope: `src/web/terminals.ts`, `src/capabilities/shell/detect.ts`, `src/web/server.ts` (terminal routes + `streamTerminals` + `resolveTerminalCwd`), `src/bins/web.ts`, `web/components/workbench/TerminalPanel.tsx`, `web/lib/{api,types,workbench-preferences}.ts`, `web/components/workbench/Workbench.tsx`, `package.json`, `pnpm-workspace.yaml`, the 4 new test files. Out of scope (per brief): Transcript/MessageParts/project.ts/product-ui.spec.

Overall: well-factored, the accepted design decisions are honoured, tests are real (not phantom), the `bash.ts` refactor is a clean extraction with no contract change. Three defects would bite in production; the rest are hygiene.

---

## Blocker

### B1. SSE has no backpressure — a `cat bigfile` can OOM the whole host process
`src/web/terminals.ts:229` (`FLUSH_CEILING_CHARS`) + `src/web/server.ts:3959-3961` (`frame()` ignores `res.write()`'s return).

The flood ceiling bounds **one 16 ms window** (1 MB), not throughput: sustained output is forwarded at up to ~62 MB/s. `res.write()`'s `false` return is discarded, so everything the browser cannot drain accumulates in the Node socket write queue, unbounded. `cat` a 1 GB file (or `yes`) in a terminal and the web host — which also runs the agent, sessions and durable storage — grows the heap until it dies. Every SSE subscriber multiplies it.

Acceptance criterion "output flood bounded" is only half met: memory *inside* the service is bounded (pending + scrollback ring), memory in the *socket* is not.

Fix: in `streamTerminals`, drop frames while the socket is congested, e.g.

```ts
const frame = (envelope: TerminalEnvelope): boolean => {
  if (res.writableLength > 4_000_000) return false   // client is behind
  res.write(`data: ${JSON.stringify(envelope)}\n\n`)
  return true
}
```
and emit one `[output dropped: client behind]` marker per congested run (same one-shot pattern as `live.flooded`). Also consider lowering `FLUSH_CEILING_CHARS` to ~128 KB — xterm cannot render 1 MB per frame anyway, so the extra bytes are pure cost.

### B2. The loopback gate checks the *bind address*, never the *requester*
`src/web/server.ts:1439`, `2916-2921`.

`terminalsLoopback` is computed from `options.host`. It correctly fails closed for `0.0.0.0`/`::`. But once the host is bound to loopback, **any** request reaching the port is served, including one made by a page in the user's browser:

- No `Host` header validation, no `Origin` check, no CSRF token anywhere in `server.ts` (grepped: zero hits).
- A malicious site the user visits can DNS-rebind its own hostname to `127.0.0.1`; the browser then treats `http://evil.test:3082` as same-origin, so the attacker *can read responses* — create a terminal, learn its id, POST input. That is unauthenticated RCE as the host user with no approval prompt.

Caveat, stated plainly: this exposure is **pre-existing and host-wide** (`/api/workspaces/:id/policy`, sessions + Bash already give an equivalent path). The terminal makes it a one-hop, approval-free, quieter path, and the feature brief explicitly asks whether the gate is unbypassable — it is not. The fix is one shared guard in `handle()`, not a terminal-specific patch:

```ts
const hostHeader = String(req.headers.host ?? '')
const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
if (!['127.0.0.1', '::1', 'localhost'].includes(hostname)) { send(403, ...); return }
// plus: reject a cross-origin `Origin` header on state-changing methods
```

Decision is yours (it touches a surface outside this feature) — but shipping a no-approval PTY endpoint behind a gate that a browser can walk through should be a conscious call, not an accident.

---

## Should-fix

### S1. Data frames are emitted after the exit frame
`src/web/terminals.ts:227` — `onData()` has no `if (live.closed) return`.

`kill()`/idle-reap call `close()` immediately, but node-pty keeps draining its buffer and firing `onData` afterwards. Each late chunk schedules a new flush timer on the dead record, appends to an orphan scrollback, and `emit`s a `data` frame for a terminal the client has already removed from `rows`. Within the client's 1.5 s detach window, output is written *after* the `[exited: N]` marker; after it, the frame is silently dropped. Also keeps the dead `LiveTerminal` (up to 256 KB scrollback) alive until the last timer fires.

Fix: first line of `onData`, `if (live.closed) return`.

### S2. Client duplicates scrollback and leaks xterm instances on EventSource reconnect
`web/components/workbench/TerminalPanel.tsx:149-156`.

`EventSource` reconnects automatically (host restart, proxy hiccup, sleep/wake). On reconnect the server resends a full `snapshot`; `attach()` returns the **existing** record and the handler unconditionally does `record.term.write(fromBase64(entry.scrollback))` — the whole ring is appended a second time. Reproducible: restart `npm run web` with the Terminal view open.

Worse case is the empty snapshot after a host restart: `setRows([])` clears the tab strip but nothing calls `detach()`, so the xterm instances and their absolutely-positioned host `<div>`s stay in the DOM and in `attached.current` forever, stacking on every reconnect.

Fix in the `snapshot` branch:
```ts
const seen = new Set(frame.terminals.map((t) => t.id))
for (const id of [...attached.current.keys()]) if (!seen.has(id)) detach(id)
for (const entry of frame.terminals) {
  const record = attach(entry.id, entry.cols, entry.rows)
  record?.term.reset()                       // snapshot is authoritative, not additive
  record?.term.write(fromBase64(entry.scrollback))
}
```

### S3. `shellCatalog()` re-runs `existsSync` ×8 and (on some hosts) two `spawnSync('where', …)` per request
`src/capabilities/shell/detect.ts:97-117`, called from `terminals.shells()` (every `GET /terminals`) **and** again inside `create()` (`src/web/terminals.ts:314`).

On a Windows box whose Git is not at a standard path, every terminal list/open forks `where git` and `where bash` **synchronously on the event loop** — the entire server (chat SSE included) stalls for the duration. It is also an unauthenticated subprocess-spawn trigger.

Installed shells do not change during a process lifetime. Memoize: `let cached: ShellOption[] | undefined` in `detect.ts`, or cache once in `createTerminalService`.

### S4. `cols`/`rows` reach node-pty unvalidated
`src/web/server.ts:2954-2955` (create: only `typeof === 'number'`, not floored, no range) and `2987-2991` (resize: rejects `< 1` but `NaN`/`Infinity` pass the comparison).

`{"cols": NaN}` on resize → node-pty throws a plain `Error('resizing must be done using positive cols and rows')` (`node_modules/.pnpm/node-pty@1.1.0/.../windowsTerminal.js:126`), which is not a `TerminalError`, so it escapes the `catch` at `server.ts:3007` and surfaces as a 500 instead of a 400. `{"cols": 1e9}` on create truncates through the native `COORD` and fails opaquely.

Fix: one clamp helper used by both paths — `Number.isFinite`, `Math.floor`, clamp to `1..1000` cols / `1..500` rows.

### S5. `create()` spawn failures leak as 500 + raw error string
`src/web/terminals.ts:324-331`. If `spawner.spawn` throws anything other than `TerminalError` (bad cwd, ConPTY failure, missing DLL), it propagates past the route's `TerminalError`-only catch to the generic handler at `server.ts:1488-1493`, which returns `String(error)` — including the resolved shell path and, on Windows, the native command line.

Fix: wrap the `spawn` call, rethrow as `new TerminalError('unavailable', …)` with a sanitized message.

### S6. `node-pty` is a hard `dependency`, contradicting "absence is a reported state, never a boot failure"
`package.json:41`.

The module header (`terminals.ts:15-17`) and the acceptance criterion both promise the product installs and serves normally without node-pty. As a `dependencies` entry, a host with no prebuilt and no node-gyp toolchain fails `pnpm install` outright — the whole product, not just terminals. The lazy `import()` + 501 path only helps if the install itself can succeed.

Fix: move to `optionalDependencies` (the lazy import and `probe()` already handle absence correctly).

---

## Nits

- `src/web/server.ts:2936` — `max: 4` hardcoded while `MAX_PER_WORKSPACE` lives in `terminals.ts`; the client renders "At most {max}". Expose it off the service instead (drifts silently if the service is constructed with `maxPerWorkspace`).
- `src/web/server.ts:193-200` vs `1437` — the JSDoc says `defaultCwd` "is deliberately separate from `root`", but the implementation is `defaultCwd ?? options.root ?? process.cwd()`. `bins/web.ts:63-66` repeats the same claim. Either drop the `?? options.root` fallback or fix both comments.
- `src/web/terminals.ts:205-209` — `emit()` has no per-listener guard; one throwing subscriber aborts the fan-out mid-loop and the exception lands inside a node-pty callback. `try { listener(event) } catch { /* a dead stream must not kill the terminal */ }`.
- `src/web/terminals.ts:221-222` — `scrollback.slice()` cuts at a character index, so replay can start mid-ANSI-sequence or on half a surrogate pair (→ U+FFFD after the base64 round trip). Cosmetic; trimming to the next `\n` would be cheap.
- `web/components/workbench/TerminalPanel.tsx:171` — closing the active tab sets `activeId` to `null` even when sibling terminals remain; the panel goes blank until the user clicks another tab. Select the neighbour instead.
- `web/components/workbench/TerminalPanel.tsx:172` — the 1.5 s `detach` timeout is never cleared on unmount (currently harmless: `detach` is idempotent).
- `web/lib/api.ts:765` — `onState` is plumbed but `TerminalPanel` never passes it; a silently reconnecting stream shows no indicator.
- `src/web/server.ts:2981` — base64 is not validated; a malformed `data` silently decodes to garbage keystrokes rather than 400.
- `src/web/server.ts:3275-3279` — `requireWorkspace` short-circuits for `MEMORY_WORKSPACE`, so terminals can be opened under that synthetic workspace id. Probably harmless, but unintended.
- Test gap: `tests/web/server-terminals.spec.ts:244` covers unknown workspace/terminal, but **not** the cross-workspace case — terminal created in workspace A, driven via workspace B's URL. The check at `server.ts:2966`/`2996` is correct; add the regression test that pins it.
- Test gap: no test asserts that a second `snapshot` (reconnect) does not duplicate scrollback — which is exactly why S2 slipped through.

---

## Acceptance criteria — verdict

| Criterion | Verdict |
|---|---|
| No approval question from terminals; agent Bash policy untouched | Pass — no approval import, `bash.ts` policy untouched |
| No terminal traffic in the session log | Pass — `TerminalEnvelope` is a distinct type, no `session.append`, no `ctx.on` |
| Boots + serves everything when node-pty absent | Pass at runtime; **compromised at install time** (S6) |
| Non-loopback bind ⇒ 403, chat unaffected | Pass for the bind check; **gate itself is walkable from a browser** (B2) |
| `server.close()` leaves zero PTYs | Pass — `closeAllConnections()` then `disposeAll()`, ordering is correct; test at line 324 |
| Cap of 4 enforced | Pass — cap check → `terminals.set` has no `await` between them, so no interleaving |
| Idle reap at 30 min | Pass; double-fire protected by `live.closed` |
| Output flood bounded | **Partial** — bounded in-service, unbounded in the socket (B1) |
| `bashTool()` contract unchanged | Pass — `detectShell` was never exported from `src/index.ts`; only `bashTool`/`BashToolOptions` are, unchanged |

Route ordering: verified. No earlier regex in `handle()` shadows `/api/workspaces/:id/terminals` (the nearest, `wsProjectsMatch`/`wsAttachmentsMatch`, are anchored and disjoint), `events` is correctly tested before the id branches, and the `(.+)` tail cannot traverse anything because ids are Map keys, never path segments.

## Unresolved questions

1. B2: is a global `Host`/`Origin` guard in scope for this branch, or a separate hardening task? It is not terminal-specific.
2. B1: acceptable to drop output frames for a congested client (with a visible marker), or is lossless replay-from-ring preferred?
3. S6: does the release target guarantee a node-pty prebuilt on every supported platform? If yes, `dependencies` is defensible and only the module comment needs softening.
4. Is the terminal intentionally reachable under the `MEMORY_WORKSPACE` pseudo-id?
