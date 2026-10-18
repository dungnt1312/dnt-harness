# dnt-harness

A TypeScript agent harness built from scratch: a small plugin-runtime kernel, an agent core (durable session log, LLM streaming seam, turn/step driver), a guarded tool pipeline, and a web UI — designed to stay small enough to read in an afternoon.

The kernel design takes inspiration from the Cordis plugin runtime (everything is a plugin, typed events with five dispatch modes, reversible effects, dependency-driven lifecycle), reimplemented from scratch without importing any of its code. What the harness grew into — tools, modes, skills, memory, workspaces, MCP — has since developed well beyond that starting point.

## Documentation

Full docs live in [`docs/`](docs/README.md):

- [agent-guide.md](docs/agent-guide.md) — agent onboarding: create skills/agents, choose scope and use harness context
- [claude-format.md](docs/claude-format.md) — instruction files, imports, hooks and custom agents
- [prompt-contract.md](docs/prompt-contract.md) — context assembly, trust, budgets and overrides
- [architecture.md](docs/architecture.md) — layers, module map, core invariants
- [kernel.md](docs/kernel.md) — the mini-Cordis plugin kernel
- [harness.md](docs/harness.md) — session log, LLM seam, turn/step driver, tools, approval
- [capabilities.md](docs/capabilities.md) — filesystem and bash tools
- [web.md](docs/web.md) — the web host API and React client
- [skills.md](docs/skills.md) — skill layers, SKILL.md format, the Skill tool
- [guides.md](docs/guides.md) — setup, config, CLI, plugin authoring, testing

## Status

- **Phase 0–1 (done)** — plugin kernel: event bus with all five dispatch modes, fiber lifecycle with reverse-order effect disposal, service store with `inject` dependency tracking, and a YAML composition loader. 37 tests cover the kernel's event, effect, service, and loader mechanics.
- **Phase 2 (done)** — agent core: durable session log (event sourcing, `deriveMessages()`, fork), LLM streaming seam (`agent/request` + `llm/stream` waterfalls, mock + DeepSeek SSE providers), and the turn/step driver (inbox with `send`/`inject`, `agent/pre-step`, `agent/turn-stopping`). Headless CLI chats multi-turn.
- **Phase 3 (done)** — tool pipeline: `ToolsService` with the guarded `tools/pre-execute` → execute → `tools/post-execute` path, approval policy (allow/ask/deny riding pre-execute), and the canonical built-in tools `Read`/`Write`/`Edit`/`Glob`/`Grep`/`Bash` (legacy lowercase names normalize at the boundary). The loop spends another step while tools owe the model their results, with no turn deadline or step budget — the model decides when the turn ends, unless the user stops it. Verified end-to-end against the real DeepSeek API.
- **Phase 4 (done)** — web UI: `createWebServer` (REST + SSE) with the React client (`web/`, built by Vite). The client renders purely from the session event stream — snapshot replay plus live `session/event` frames — and approval questions ride the same stream, answered over `POST /api/approvals/:id`; routing to the right session goes through the ambient agent scope (`AsyncLocalStorage`), so concurrent sessions share one policy listener without cross-talk. A failed step closes its turn durably (`turn/end: failed`). The UI is product-grade: collapsible thinking panel, expandable tool cards, session rename/delete/search, a stop button (`turn/end: stopped`), syntax-highlighted code blocks, toasts, and a mobile drawer. 105 tests cover kernel, harness, capabilities, and the web API.
- **Phase 5 — G1 reliable harness (done)**: file-first durable storage (`events.jsonl` canonical + rebuildable `summary.json`), restart recovery (interrupted turns, unknown-outcome records, invalidated approvals), durable input queue with `clientRequestId` dedup, stop/cancellation propagation with truthful `cancelled` turns, provider-inactivity watchdogs, expiry-bound approvals recorded as durable events, and the six built-in tools with granted-root containment, observed-state conflict detection, and a real-Bash adapter (Git Bash on Windows, actionable disable when absent). Session data lives under `--data-dir` (default `~/.dnt-harness/data` for the web host). Tool containment is application-level — not an OS sandbox, and Bash is not path-confined.
- **Phase 6 — G2 workspaces & isolation (done)**: Work/Life-style environments with strict ownership at the service boundary — sessions are born into one workspace (routes under `/api/workspaces/:wid/...`; foreign ids are 404, never a leak), project binding (`project.json`) drives the file-tool grant so a session without a project has no filesystem access, overlapping/nested project roots are rejected across workspaces, and one app-local writer lease serializes write-capable executions per project folder. Permission remains workspace-scoped, while provider configuration and the default model/thinking selection are **global** (durable, shared by every workspace): each new session snapshots that global default and then resolves its controls independently at each model request. Session `provider: null, model: null` is an explicit non-sendable blank, while `thinkingLevel: null` selects the model default; only legacy sessions with no `session/model` event inherit the live global default. The web client gets a workspace switcher with activity/approval badges and project binding for new sessions. Isolation is application-level only — shell and trusted code run with host privileges, and this is stated in the UI/docs rather than claimed away.
- **Phase 7 — G3 modes, context, skills, memory (done)**: five bundled modes (Chat, Ask before changes, Edit automatically, Plan, Full access) plus workspace-owned custom Markdown modes; the third live control (mode) gates tool exposure as a hard ceiling at the next tool start and reassembles context at the next request, with pending approvals re-evaluated (newly unexposed calls cancel). One mode-driven context builder assembles every request with a truthful per-request manifest (mode/model revisions, source hashes, budget, omissions); budget = window − output reserve − margin with explicit trim order (skills → memory → oldest completed turns) and loud failure. `history: none/recent/compact`, manual compaction at completed boundaries into immutable checkpoints. Skills (on-demand `Skill` tool, hash-pinned, Turn-local) and memory (Markdown entries, five scoped tools, keyword search, conflict detection) live per workspace.
- **Phase 8 — G4 agents & compatibility (done)**: layered Claude-format agent definitions (project `.claude/agents/*.md` > workspace `agents/*.md` > user `~/.claude/agents/*.md` > bundled Explorer/Worker/Reviewer/Verifier, validation + hashes), one-level delegation through the SAME G1 loop and G3 builder (prose briefs, isolated child sessions, no built-in active/spawn count caps, unbounded child turns), child tool ceiling = mode exposure ∩ definition ∩ spawn grant enforced at every gate (no escalation via mode switches), internal spawn/list/wait/cancel lifecycle over HTTP, root Stop cancels descendants, durable spawn intent in child logs, Claude sub-agent import (supported subset + blocking-field reports, never executes imports) and a version-pinned Codex adapter that reports unsupported semantics.
- **Phase 9 — G5 MCP & hooks (done)**: workspace-owned strict `mcp.json`, Claude Code `settings.json` hooks (see docs/claude-format.md), AES-256-GCM `secrets.json` with masked management and rotation reconnect; MCP 2025-06-18 stdio (newline JSON-RPC subprocess) plus Streamable HTTP POST/SSE with session IDs and Bearer/OAuth access-token references; `mcp__server__tool` registration with workspace-isolated dynamic schemas, allowlist exposure, default-ask/wildcard policies, host `blockedTools`, Chat/Plan/Explorer/Worker ceilings, timeout/AbortSignal/cancel notification/process-tree cleanup, 3× retry, 5-failure circuit breaker and health reconnect, plus CPU/memory/lifetime watchdogs on stdio servers (application control, not OS controllers). Command hooks cover PreToolUse block/rewrite (final args re-bound before durable intent), PostToolUse flag, UserPromptSubmit inject, SessionStart/End audit and PreCompact gate, managed from the Settings → MCP/Hooks/Secrets panels. Audit events store hashed args/results, durations, identity — never raw secrets. Claude/Codex MCP imports record provenance, stay disabled, and never spawn. Browser-interactive OAuth authorization and pinned upstream compatibility fixtures remain explicit production follow-ups, not claimed complete; the plugin marketplace is G6.
- Phase 10 (planned) — dynamic plugins: patch layers, hot (un)load, provider swap restarting dependents.

## Install

```sh
bun add -g dnt-harness   # Bun >= 1.4.3 (the verified runtime for this release)
dnt-harness              # web UI at http://127.0.0.1:3082
```

**Runtimes.** The runtime is Bun **1.4.3** (`engines.bun >=1.4.3`). That is
the version verified for outbound policy (real Undici under Bun) and PTY
teardown; older Bun is unsupported. Developing from source also needs Node
**>= 22.19** (22.20 LTS or 24): Vitest and Vite run under Node, and
`bun run test` fails fast through `scripts/node-preflight.mjs` on older Node.
`bun run probe:runtime` checks the installed Bun (Undici dispatcher honored,
DNS policy). See [docs/migration-runtime-hardening.md](docs/migration-runtime-hardening.md)
for behaviour changes in this release.

**Platform support.** Terminal (PTY) support is claimed only where it has
been verified. Windows (node-pty/ConPTY) has local smoke evidence. Linux
(Bun built-in PTY) is gated by the `runtime-probes` CI job
(`bun scripts/pty-probes.mjs --require`); that gate is wired but pending
its first green CI run, so Linux evidence is not yet recorded. **macOS terminal support is
unverified** and is not claimed until zsh/Bash smoke evidence exists. See
[docs/release-checklist.md](docs/release-checklist.md).

`dnt-harness` has three subcommands; everything after the subcommand is passed
to the underlying bin (see [docs/guides.md](docs/guides.md) for flags):

| Command | Does |
|---|---|
| `dnt-harness [web] [--port N --root DIR --yolo --auth --allowed-host H --oauth-origin https://H --data-dir DIR]` | serve the web UI (default) |
| `dnt-harness chat [--message "hi"]` | headless REPL or one-shot |
| `dnt-harness pair [--data-dir DIR]` | mint a pairing code for a running `--auth` server |
| `dnt-harness start pm2 [--name N] [web flags]` | run the web server under pm2 (needs `bun add -g pm2`) |
| `dnt-harness restart [--name N]` | restart the pm2 process, keeping the flags it was started with |
| `dnt-harness upgrade [--name N]` | install the latest version from npm, then restart the pm2 process |

`start pm2` registers the server with pm2 (default name `dnt-harness`, replacing
an existing process of that name so new flags apply), runs `pm2 save`, and keeps
the folder you ran it from as the default `--root`. For start on boot, run
`pm2 startup` once.

Sessions and provider config live in `~/.dnt-harness/`. Add a provider in
Settings, or set `DEEPSEEK_API_KEY` in the environment before the first start.
The package ships TypeScript source and runs it with Bun directly; the web
client is prebuilt, so no build step is needed after installing.

### Upgrading from 0.2.x (Node)

0.3.0 runs on Bun instead of Node + tsx, so the launcher needs `bun` on PATH.
`dnt-harness upgrade` from a 0.2.x install still uses npm and leaves a launcher
that cannot start without Bun. Move over once, by hand:

```sh
# install Bun >= 1.4.3 first: https://bun.sh
npm rm -g dnt-harness
bun add -g dnt-harness
dnt-harness restart      # only if it runs under pm2
```

Sessions and providers in `~/.dnt-harness/` are unchanged. A pm2 process that
was started under 0.2.x should be re-registered with `dnt-harness start pm2`
so pm2 launches it through Bun.

## Getting started (from source)

```sh
bun install             # Bun 1.4.3
bun run preflight:node  # Node >= 22.19 must be first on PATH for Vitest/Vite
bun run test            # vitest run under Node (not `bun test`, Bun's own runner)
bun run typecheck
bun run build:web
bun run probe:runtime   # Bun runtime probes (Undici dispatcher, DNS policy)
```

The Workbench terminal uses Bun's built-in PTY on POSIX (Linux gated in CI,
pending its first green run; macOS unverified, see above). On Windows
it needs `node-pty`, which places a prebuilt binary and a bundled ConPTY DLL
from its install script; `trustedDependencies` in `package.json` allows that
script. Everything else runs normally without it — a missing PTY backend
disables the terminal and nothing else.

## Configuration

Both bins load a repo-root `.env` (gitignored); variables already in the
process environment win over file entries. `DEEPSEEK_API_KEY` is optional:
when set, headless registers DeepSeek and the web host seeds a `deepseek`
entry on an empty provider config. Neither bin refuses to start without it.
Optional: `DEEPSEEK_BASE_URL` (defaults to the public API). Never commit the key.

```sh
echo 'DEEPSEEK_API_KEY=sk-...' > .env
```

### Renamed from mini-dsh

The project was called **mini-dsh**. Existing installs keep working without changes:

- **Data home**: `~/.dnt-harness/` is used once it exists; until then the old `~/.mini-dsh/` (sessions, `providers.json`, secrets) is used as-is. To adopt the new name, stop the server and rename the folder: `mv ~/.mini-dsh ~/.dnt-harness`.
- **Environment**: every `MINI_DSH_*` variable is still honoured as its `DNT_HARNESS_*` equivalent (`DNT_HARNESS_AUTH`, `DNT_HARNESS_BASH`, `DNT_HARNESS_CHILD_PASS_ENV`, …); an explicitly set new name wins.
- **Browser state**: drafts, theme and workbench tabs stored under `mini-dsh.*` are copied to `dnt-harness.*` on first load.
- **PM2**: the process is now `dnt-harness` — `pm2 delete mini-dsh && pm2 start ecosystem.config.cjs`.

## Chat

```sh
bun run chat           # REPL; registers DeepSeek only when the key is set
bun src/bins/headless.ts --message "hello"   # one-shot
```

## Web

```sh
bun run build:web      # build the React client into web-dist/
bun run web            # serve it at http://127.0.0.1:3082 (--yolo, --root, --port)
```

The toolbar switches the active model (`PUT /api/model`, offered names come
from the provider's `models` list; every step's request is stamped through
the `agent/request` waterfall) and the workspace folder (`PUT /api/folder`,
re-scoping the fs/bash tools through live root accessors without
re-registering them). The sidebar lists sessions with search, rename
(`PATCH /api/sessions/:id`) and delete (`DELETE /api/sessions/:id`), and the
composer turns into a Stop button while a turn runs
(`POST /api/sessions/:id/stop`, closing it with a durable
`turn/end: stopped`). Ctrl/Cmd+K starts a new session.

The browser client is stateless by design: it holds no model state of its
own — the transcript (including a collapsible thinking trace for reasoning
models and expandable tool cards) is projected from the durable session
events streamed over SSE, approval questions arrive on the same stream, and
answers go back over one POST.

## The kernel

```
src/kernel/
├── events.ts    EventBus: emit / parallel / serial / bail / waterfall
├── fiber.ts     Plugin lifecycle states + reverse-order effect disposal
├── store.ts     Flat service store; additions wake pending plugins
├── context.ts   Fiber-owned context proxy; ctx.<name> reads the store
├── service.ts   Base class claiming a service name on construction
├── registry.ts  Kernel: mounts plugins, tracks inject dependencies
└── loader.ts    cordis.yml → plugin tree through dynamic import()
```

### Concepts (shared vocabulary with Cordis-inspired kernels)

| dnt-harness | Cordis term |
|---|---|
| `Kernel` | Cordis app + Loader assembly |
| `Context` proxy over `ServiceStore` | `Context` + `ReflectService` |
| `Fiber` (`pending → loading → active → unloading → disposed`, `failed`) | `Fiber` state machine |
| `ctx.effect(() => disposer)` | `ctx.effect()` — registrations are effects |
| `inject: string[]` + pending wake | service dependencies, not load order |
| `declare module 'dnt-harness'` merging on `Events`/`Context` | declaration merging on Cordis interfaces |
| `bootFromFile(kernel, 'cordis.yml')` | profile/bundle composition (simplified) |

### Dispatch modes

| Mode | Await | Order | Returns |
|---|---|---|---|
| `emit` | no | registration | nothing |
| `parallel` | all together | concurrent | nothing (observer failures contained) |
| `serial` | in order | registration | first bail value stops the chain |
| `bail` | no | registration | synchronous first-bail |
| `waterfall` | chain | outermost→innermost | each listener wraps or vetoes via `next()` |

A waterfall listener that only observes must call `next()`; returning without it is a deliberate veto — a standing rule this kernel keeps by design.

## The harness

```
src/harness/
├── storage/   File-first session store: events.jsonl canonical, summary.json rebuildable
├── session/   Durable log: SessionEvent union, deriveMessages(), fork
├── llm/       Seam: provider registry + agent-facing stream, mock + DeepSeek
├── agent/     Turn/step driver: inbox, pre-step admission, turn-stopping
├── tools/     Registry + guarded pipeline: pre-execute -> run -> post-execute
├── approval/  Policy riding tools/pre-execute: allow | ask | deny
├── workspace/ Workspace registry, project binding, ownership, writer leases
├── modes/     Five bundled + custom file modes
├── context/   Mode-driven builder: budget, trim order, compaction, manifest
├── skills/    Workspace skill files + on-demand loading
├── memory/    Workspace/project Markdown memory + five tools
├── agents/    Definitions, bounded one-level delegation, Claude/Codex adapters
├── mcp/       MCP client (stdio + Streamable HTTP), config/secrets, health/breaker
├── hooks/     Command hook runner behind the tool-gate waterfalls
└── limits.ts  Centralized bounded-execution defaults

src/capabilities/
├── fs/        Read/Write/Edit/Glob/Grep tools, granted-root containment
└── shell/     Bash tool: timeout, process-tree kill, exit-code report
```

The turn flow:

```
turn/start
  claim inbox (injected context waits for a user message to wake the driver)
  -> agent/pre-step (waterfall)      reject | enter(contents)
     reject, or a first enter rewritten empty -> close the turn with no step
     step/start
     append admitted input as user/message
     derive model history from the log (+ tool schemas)
     agent/request (waterfall) -> llm/stream (waterfall) -> assistant/chunk*
     assistant/message (+toolCalls)
     tool/call* -> tools/pre-execute -> execute -> tools/post-execute -> tool/result*
     step/end
     tools ran -> they owe the model their results -> next step
  -> agent/turn-stopping (serial)
turn/end
```

Three standing invariants:

- **Model-visible means logged.** Every model request is `session.deriveMessages()` at that moment; a test asserts it with tools in the loop.
- **Raw `assistant/chunk` events preserve replay and UI fidelity** but never re-enter model history — only the assembled `assistant/message` projects.
- **A denied or failing tool is a result, not an exception.** The model sees the denial reason and the turn continues — policy never crashes the loop.

## License

MIT


## English workbench UI

The web client now uses an English workbench shell. Switch workspaces in the app bar; filter registered projects and conversation history in navigation. Start **New conversation**, select a project or **Chat only**, and use **Manage projects** to open workspace project registration. Project registration and rename use scoped APIs. Removal refuses bound conversations with HTTP 409 and never deletes the folder or detaches conversations.

Model and mode controls live in the composer. The optional Context inspector is read-only and closed by default. Settings is full-height and retains Providers, Agents, MCP, Hooks and Secrets, with explicit global/workspace/current-conversation scope. User text, names, paths, IDs, tool output and imported content are never translated.

Workspace session listings may include optional `createdAt`/`updatedAt` from existing event-backed summaries. Empty conversations omit these fields; clients must not invent dates. No existing request or approval wire format changed.

See [design guidelines](docs/design-guidelines.md) for geometry, ownership and safety rules. Run `npm run test:browser` for fixture-backed Chromium interactions and screenshots. Visual signoff, native 200% zoom, screen-reader review and long-history performance acceptance remain pending; generated screenshots are not approved baselines.
