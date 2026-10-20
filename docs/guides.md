# Guides

Practical walkthroughs: getting started, configuration, the CLI, writing a
plugin, and testing.

## Installing the package

```sh
bun add -g dnt-harness
dnt-harness                       # = dnt-harness web, http://127.0.0.1:3082
dnt-harness web --port 4000 --yolo
dnt-harness chat --message "hello"
dnt-harness pair                  # new pairing code for a running --auth server
dnt-harness start pm2 --port 3082 # run the web server under pm2
dnt-harness restart               # restart it, same flags
dnt-harness upgrade               # bun add -g the latest, then restart
```

`dnt-harness upgrade [--name N]` compares the installed version with
`bun info dnt-harness version` and does nothing when it is not newer. Otherwise
it stops the pm2 process (Windows locks files of a running process), runs
`bun add -g dnt-harness@<latest>`, and restarts the process even if the install
failed, so the server is never left down. Without a pm2 process it only
upgrades the package. `dnt-harness --version` prints the installed version.

On Windows `pm2` is a `.cmd` shim, so the launcher runs it through
a shell with quoted arguments. The same commands are meant to work on Linux and
macOS. The release evidence covers Windows, Linux and macOS (see
[release-checklist.md](release-checklist.md)).

`dnt-harness start pm2 [--name N] [web flags]` requires `pm2` on PATH (it prints
`bun add -g pm2` otherwise). It deletes any pm2 process with the same name, starts
`bin/dnt-harness.mjs web <flags>` with `--interpreter bun` and `--time` log
stamps, and runs `pm2 save`.
The process keeps the cwd you ran the command in, which becomes the default
`--root`. Use `pm2 logs|stop|restart <name>` afterwards, and `pm2 startup` once
for start on boot. This is separate from the repo's `ecosystem.config.cjs`, which
is for running from a source checkout.

The `dnt-harness` bin is `bin/dnt-harness.mjs` (shebang `bun`). It imports
`src/bins/{web,headless,pair}.ts`, which Bun runs as TypeScript directly.
The published tarball (`files` in `package.json`) holds
`bin`, `src`, `web-dist`, `skills`, `commands` and `README.md`; `prepack` runs
`vite build`, so `web-dist/` is always fresh. Flags and behavior match the
`bun run web` / `bun run chat` / `bun run pair` scripts below.

Releasing: tag-triggered publish through `.github/workflows/release.yml`. The
publish job needs every gate job (typecheck + `build:web`, deterministic
suites, Linux and macOS runtime/PTY probes, the Windows launcher/PM2 smoke)
and approval in the protected `release`
environment. Every gate is green on the release pull request; the first tag run
is the final proof.
A separate `pack` job (no OIDC token) builds the tarball; `publish` only
uploads it with `npm publish --ignore-scripts`. Follow [release-checklist.md](release-checklist.md); what each
gate covers and the remaining manual evidence are listed there. Check the
contents first with `npm pack --dry-run`.

## Runtimes

| Purpose | Runtime | Check |
|---|---|---|
| Product (CLI, web, PM2 launcher), runtime probes | Bun **1.4.3** (`engines.bun >=1.4.3`) | `bun run probe:runtime` |
| Vitest suite, Vite build | Node **>= 22.19** (22.20 LTS or 24; dev-only, so not in `engines`) | `bun run preflight:node` |

`bun run test` runs `scripts/node-preflight.mjs` first. It refuses Bun and any
Node older than 22.19 (Vitest 3 + Undici 7). Put a supported Node first on PATH
(e.g. `C:\laragon\bin\nodejs\node-v22.20.0-win-x64`). `bun run probe:runtime`
(`scripts/runtime-probes.mjs`) checks that the Bun runtime is 1.4.3, that the
resolved real Undici honors a custom dispatcher (bare `undici` under Bun is a
native shim and does not), and that DNS lookup works. On Linux and macOS,
`bun scripts/pty-probes.mjs --require` exercises real PTY teardown with bash;
add `--shell zsh` for zsh. Elsewhere it skips, and `--require` makes it fail
instead. CI runs bash on Linux and both shells on macOS
([run 39177692003](https://github.com/dungnt1312/dnt-harness/actions/runs/39177692003)), which is the
evidence for the Linux and macOS terminal support claims.

## Getting started (from source)

```sh
bun install             # install dependencies (Bun 1.4.3)
bun run preflight:node  # Node >= 22.19 first on PATH
bun run test            # vitest run under Node (not `bun test`, Bun's own runner)
bun run typecheck       # tsc --noEmit for both tsconfig.json and tsconfig.web.json
bun run probe:runtime   # Bun runtime probes
```

`bun run test` runs the whole vitest suite (kernel, harness, capabilities, web, and a
spawned-CLI smoke test). `bun run typecheck` covers the server side (`src`,
`tests`) and the browser side (`web`, `vite.config.ts`).

## Configuration

Both bins load a repo-root `.env` (gitignored). Variables already in the
process environment win over file entries. `loadRepoEnv()` looks first at
`.env` next to the repo the bin lives in (so running from any cwd still finds
it), then at the process cwd.

`DEEPSEEK_API_KEY` is optional. When it is set, headless registers the
DeepSeek provider and the web host seeds a `deepseek` entry on first boot if
the provider config is empty. A blank value is treated as absent. Neither bin
refuses to start without a key, and neither falls back to a mock provider.

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env   # optional; never commit this file
```

| Variable | Meaning | Default |
|---|---|---|
| `DEEPSEEK_API_KEY` | optional DeepSeek key; empty/whitespace is treated as absent | — |
| `DEEPSEEK_BASE_URL` | API base URL when the key is set | `https://api.deepseek.com` |

## The headless CLI

`bun run chat` runs a REPL. With `DEEPSEEK_API_KEY` it registers DeepSeek;
without a key it still starts, and a model call fails because no provider is
registered.

```sh
bun run chat                                          # interactive REPL; 'exit' / 'quit' quits
bun src/bins/headless.ts --message "hello"            # one-shot
```

Flags for `src/bins/headless.ts`:

| Flag | Meaning |
|---|---|
| `--yolo` | allow unnamed tools / skip mode ask defaults (host blocks, exposure, and interactive MCP still apply) |
| `--root DIR` | workspace root for the filesystem tools |
| `--message TEXT` | one-shot mode instead of the REPL |

The bin composes the full harness on a kernel: `SessionsService`,
`LlmService`, `ToolsService`, `AgentsService`, an approval policy (defaults:
`read`/`glob`/`grep` allowed, `write`/`edit`/`bash` ask on stderr), all
filesystem tools bound to `--root`, and `bashTool()`. Replies and tool traffic
stream to stdout as `session/event` frames arrive.

## The web CLI

```sh
bun run build:web   # one-time: build the React client into web-dist/
bun run web         # serve at http://127.0.0.1:3082
```

See [web.md](web.md) for flags and the full API.

## Writing a plugin

A plugin is anything the kernel can mount: a function, a `Service` subclass, or
an `{ apply }` object. Everything a plugin does is a **registration**, and every
registration is an **effect** — teardown unwinds it automatically, so plugins
never bookkeep removals.

### A service plugin (provides a named capability)

```ts
import { Service, type Context } from 'dnt-harness'

declare module 'dnt-harness' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')           // claims the 'greeter' service name
  }
  greet(who: string): string {
    return `Hello, ${who}!`
  }
}

export function apply(ctx: Context): void {
  ctx.plugin(GreeterService)        // mount it as a child of this fiber
}
```

### A consumer (depends on a service)

```ts
import type { Context } from 'dnt-harness'

export const name = 'consumer-fixture'
export const inject = ['greeter']   // stays 'pending' until 'greeter' exists

export function apply(ctx: Context): void {
  ctx.provide('consumerSaw', ctx.greeter.greet('world'))
}
```

Boot order comes from `inject`, never from mount order: mount the consumer
first and it pends; mounting the provider wakes it. If a required service
disappears, dependents are disposed and re-mounted (pending again until the
service returns).

### Adding an event listener with ownership

```ts
export function apply(ctx: Context): void {
  ctx.on('session/event', (_session, event) => {
    // ...owned by this fiber; removed automatically on unload
  })
}
```

## MCP production migration

`bun src/bins/migrate-mcp.ts --data-dir <home> --workspace <id>` prints a dry run and does not spawn a server or open a network connection. Add `--apply` to write a checksummed backup and a v2 document. Omitted `enabled` is quarantined off. A legacy `oauth` block becomes an external token, not a managed session. The web bin refuses to start when `mcp-compatibility.json` asks for a newer safety kernel than this binary has. Protocol pin, outcomes, and the route inventory are in `docs/decisions/mcp-production-boundaries.md`.

### Composing from a YAML file

```yaml
# cordis.yml
- name: './hello.ts'
- name: './greeter.ts'
- name: './consumer.ts'
- name: './disabled.ts'
  disabled: true
```

```ts
import { Kernel, bootFromFile } from 'dnt-harness'

const kernel = new Kernel()
await bootFromFile(kernel, 'cordis.yml')
await kernel.stop()
```

Each entry is `import()`-ed and mounted on the root context; `disabled: true`
skips the row (patch layers flip this instead of deleting rows).

### Public API surface

Everything is re-exported from the package entry (`src/index.ts`), and the
`dnt-harness` import specifier is aliased in `vitest.config.ts` (and via `paths` in
`tsconfig.json`) for tests. Types extend through declaration merging on
`Events` and `Context`.

## Testing

The suite runs under Vitest on Node >= 22.19 (`tests/**/*.spec.ts`), with
the `dnt-harness` alias pointing at `src/index.ts`. There are no fake timers —
deterministic effect-teardown tests rely on real microtask ordering.

```
tests/
├── bins/headless.spec.ts        CLI smoke: spawns the real bin with --mock
├── capabilities/
│   ├── bash.spec.ts             bash tool: output, exit code, timeout kill
│   └── fs-tools.spec.ts         read/write/edit/glob/grep + root confinement
├── harness/
│   ├── agent-loop.spec.ts       turn/step driver: durable order, inbox,
│   │                            pre-step, request rewriting, fork, invariant
│   ├── agent-tools.spec.ts      the loop with tools in it
│   ├── llm.spec.ts              providers: DeepSeek wire format, mock script
│   ├── session.spec.ts          log vocabulary, deriveMessages, fork
│   └── tools.spec.ts            registry + guarded pipeline + approval
├── kernel/
│   ├── dispatch-modes.spec.ts   emit/parallel/serial/bail/waterfall contracts
│   ├── effects.spec.ts          effect shapes + reverse-order disposal
│   ├── events.spec.ts           bus: disposers, once, prepend, snapshot
│   ├── loader.spec.ts           YAML parse validation + booting a tree
│   └── services.spec.ts         inject, pending wake, dependent restart
├── web/server.spec.ts           REST, SSE snapshot+live, approval round-trip
└── fixtures/                    app.yml + hello/greeter/consumer/disabled.ts
```

### Useful commands

```sh
bun run test             # run once
bun run test:watch       # watch mode
bunx vitest run tests/kernel  # a subset
```

### Running an integration check end-to-end

```sh
bun src/bins/headless.ts --message "hello"
```

…or the real thing:

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env
bun run chat
```
