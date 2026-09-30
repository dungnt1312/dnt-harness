# Guides

Practical walkthroughs: getting started, configuration, the CLI, writing a
plugin, and testing.

## Getting started

```sh
npm install        # install dependencies (Node >= 22.19.0)
npm test           # vitest run
npm run typecheck  # tsc --noEmit for both tsconfig.json and tsconfig.web.json
```

`npm test` runs the whole vitest suite (kernel, harness, capabilities, web, and a
spawned-CLI smoke test). `npm run typecheck` covers the Node side (`src`,
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

`npm run chat` runs a REPL. With `DEEPSEEK_API_KEY` it registers DeepSeek;
without a key it still starts, and a model call fails because no provider is
registered.

```sh
npm run chat                                          # interactive REPL; 'exit' / 'quit' quits
npx tsx src/bins/headless.ts --message "hello"        # one-shot
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
npm run build:web   # one-time: build the React client into web-dist/
npm run web         # serve at http://127.0.0.1:3082
```

See [web.md](web.md) for flags and the full API.

## Writing a plugin

A plugin is anything the kernel can mount: a function, a `Service` subclass, or
an `{ apply }` object. Everything a plugin does is a **registration**, and every
registration is an **effect** — teardown unwinds it automatically, so plugins
never bookkeep removals.

### A service plugin (provides a named capability)

```ts
import { Service, type Context } from 'mini-dsh'

declare module 'mini-dsh' {
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
import type { Context } from 'mini-dsh'

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

`npx tsx src/bins/migrate-mcp.ts --data-dir <home> --workspace <id>` prints a dry run and does not spawn a server or open a network connection. Add `--apply` to write a checksummed backup and a v2 document. Omitted `enabled` is quarantined off. A legacy `oauth` block becomes an external token, not a managed session. The web bin refuses to start when `mcp-compatibility.json` asks for a newer safety kernel than this binary has. Protocol pin, outcomes, and the route inventory are in `docs/decisions/mcp-production-boundaries.md`.

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
import { Kernel, bootFromFile } from 'mini-dsh'

const kernel = new Kernel()
await bootFromFile(kernel, 'cordis.yml')
await kernel.stop()
```

Each entry is `import()`-ed and mounted on the root context; `disabled: true`
skips the row (patch layers flip this instead of deleting rows).

### Public API surface

Everything is re-exported from the package entry (`src/index.ts`), and the
`mini-dsh` import specifier is aliased in `vitest.config.ts` (and via `paths` in
`tsconfig.json`) for tests. Types extend through declaration merging on
`Events` and `Context`.

## Testing

The suite runs under Vitest in a Node environment (`tests/**/*.spec.ts`), with
the `mini-dsh` alias pointing at `src/index.ts`. There are no fake timers —
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
npm test                 # run once
npm run test:watch       # watch mode
npx vitest run tests/kernel   # a subset
```

### Running an integration check end-to-end

```sh
npx tsx src/bins/headless.ts --message "hello"
```

…or the real thing:

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env
npm run chat
```
