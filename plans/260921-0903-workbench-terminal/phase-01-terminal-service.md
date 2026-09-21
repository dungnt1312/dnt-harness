# Phase 1 — Shell detection + TerminalService

Server core only. No HTTP, no client. Ends with a fully unit-tested service that can
spawn, stream, resize, cap and reap PTY sessions.

## Context

`src/capabilities/shell/bash.ts:43` holds a private `detectBash()` that resolves Git Bash
on Windows (explicit option → `MINI_DSH_BASH` → known install paths → `where git`
fallback, deliberately skipping WSL launchers). The terminal needs the same resolution
plus two more shells. Duplicating it would let the agent's shell and the user's shell
drift apart on exactly the machines where detection is hardest.

## Requirements

- One shell-resolution module serving both `bashTool` and the terminal service.
- A terminal service whose PTY spawner is **injectable**, so the whole suite runs with no
  native dependency.
- `node-pty` imported lazily; its absence is a reported state, not a boot failure.

## Files

| File | Change |
|---|---|
| `src/capabilities/shell/detect.ts` | **new** — `detectShell()`, `shellCatalog()` |
| `src/capabilities/shell/bash.ts` | edit — import detection, delete the private copy |
| `src/web/terminals.ts` | **new** — `createTerminalService()` |
| `tests/web/terminals.spec.ts` | **new** |
| `tests/capabilities/bash.spec.ts` | must stay green untouched |

## Steps

1. **Extract detection.** Move `detectBash` into `detect.ts` as
   `detectShell(explicit?: string): { executable: string | undefined; hint: string }`,
   byte-identical in behaviour. Re-point `bashTool` at it. Run
   `tests/capabilities/bash.spec.ts` before writing anything else — this refactor must be
   provably inert.

2. **Add the shell catalog.** `shellCatalog(): ShellOption[]` where
   `ShellOption = { id: 'bash' | 'powershell' | 'cmd', label, executable, args }`:
   - `bash` → `detectShell()`, args `['-i']`
   - `powershell` → `powershell.exe` (Windows only), no args
   - `cmd` → `cmd.exe` (Windows only), no args
   Entries whose executable does not resolve are omitted, so the client picker only ever
   offers shells that exist. On POSIX the catalog is `bash` alone.

3. **TerminalService.** In `src/web/terminals.ts`:

   ```ts
   export interface PtySpawner {
     spawn(file: string, args: string[], opts: PtySpawnOptions): PtyHandle
   }
   export interface TerminalService {
     readonly available: boolean
     shells(): ShellOption[]
     list(workspaceId: WorkspaceId): TerminalInfo[]
     create(input: CreateTerminalInput): Promise<TerminalInfo>
     write(id: string, data: string): void
     resize(id: string, cols: number, rows: number): void
     kill(id: string): void
     scrollback(id: string): string
     subscribe(workspaceId: WorkspaceId, listener: TerminalListener): () => void
     disposeAll(): void
   }
   ```

   Per terminal the service holds: `id`, `workspaceId`, `shellId`, `cwd`, `cols`, `rows`,
   the PTY handle, a scrollback ring buffer, and `lastActivity`.

4. **Default spawner** does `await import('node-pty')` on first use. On failure the
   service sets `available = false` and every `create()` rejects with the resolution hint,
   mirroring how `bashTool` disables itself with an actionable error instead of
   substituting something else.

5. **Backpressure.** `onData` appends to a pending buffer flushed on a 16 ms timer, not
   per chunk. Ring buffer capped at 256 KB (oldest bytes dropped). If a single flush
   window exceeds 1 MB, discard the excess and emit
   `\r\n[output truncated: too fast]\r\n` once, so a runaway `yes` cannot grow the SSE
   queue without bound.

6. **Caps and reaping.** Max 4 live terminals per workspace; `create()` past the cap
   throws a typed cap error. An unref'd 60 s interval kills terminals idle for more than
   30 min and notifies subscribers with an `exit` event. `disposeAll()` kills every PTY.

7. **Subscription** is per workspace and multiplexed: one listener receives
   `{ terminalId, … }` events for every terminal in that workspace.

## Validation

```sh
npx vitest run tests/capabilities/bash.spec.ts tests/web/terminals.spec.ts
npm run typecheck
```

`tests/web/terminals.spec.ts` drives a fake `PtySpawner` (an `EventEmitter` handle) and
covers: create/list/kill lifecycle, the 4-per-workspace cap, ring-buffer truncation,
16 ms coalescing, flood truncation marker, idle reaping (with an injected short
`idleMs`), multiplexed subscribe/dispose, `disposeAll()`, and `available === false`
behaviour when the spawner import fails.

## Risk / rollback

The only change to existing code is the detection extraction. If `bash.spec.ts` regresses,
revert that single edit — `terminals.ts` is additive and unreferenced until Phase 2.
