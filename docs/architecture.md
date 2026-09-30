# Architecture

mini-dsh is built as a series of layers, each depending only on the ones below
it. Nothing reaches upward: the kernel does not know about sessions or tools,
the harness does not know about HTTP, and the web host is just another plugin
composition that consumes the harness through the context.

```
┌─────────────────────────────────────────────────────────────┐
│ web host (src/web/server.ts + web/ React client)            │
│   REST + SSE over the harness; renders from session/event   │
├─────────────────────────────────────────────────────────────┤
│ agent harness (src/harness/)                                │
│   storage · session log · llm seam · turn/step driver ·     │
│   tools · approval · workspaces · modes/context · skills ·  │
│   memory · agents/delegation · mcp client · hooks           │
├─────────────────────────────────────────────────────────────┤
│ capabilities (src/capabilities/)                            │
│   fs tools · bash tool (registered into the harness)        │
├─────────────────────────────────────────────────────────────┤
│ plugin kernel (src/kernel/)                                 │
│   EventBus · Fiber · ServiceStore · Context · Kernel ·      │
│   loader                                                     │
└─────────────────────────────────────────────────────────────┘
```

## Layer 0 — the kernel (mini-Cordis)

The kernel is a self-contained, Cordis-shaped plugin runtime. It has no notion
of agents, LLMs, or tools; it only provides the mechanics of composition:

- **One typed event bus** (`EventBus`) with five dispatch modes — `emit`,
  `parallel`, `serial`, `bail`, `waterfall` — and per-plugin ownership: a
  listener registered through `ctx.on()` is removed automatically when its
  plugin unloads.
- **Fiber lifecycle** (`Fiber`): `pending → loading → active → unloading →
  disposed`, plus `failed`. Every registration a plugin makes is an *effect*
  with a disposer; teardown runs them in reverse order, awaited.
- **Flat service store** (`ServiceStore`): named capabilities published through
  `ctx.provide()`, read as `ctx.<name>` through a proxy, and consumed
  declaratively through `inject: string[]`.
- **Dependency-driven boot** (`Kernel`): boot order comes from `inject`, never
  from mount order. Missing dependencies leave a plugin `pending`; mounting a
  provider wakes it. Losing a required service disposes and re-mounts every
  dependent.
- **Composition loader** (`loader.ts`): a `cordis.yml`-style YAML file turns
  into a plugin tree through dynamic `import()`.

Everything else in the project is a plugin mounted on this kernel.

## Layer 1 — the harness

The harness composes the kernel's services into an agent runtime:

- **SessionsService** provides `ctx.sessions` — a registry of durable,
  append-only conversation logs.
- **LlmService** provides `ctx.llm` — a provider registry (`register`/`use`/
  `active`) plus a single streaming entry point (`ctx.llm.stream(request)`).
  Providers (`DeepSeekProvider`, `MockLlmProvider`) are the only model-aware
  code; the seam is the whole contract.
- **AgentsService** provides `ctx.agents` — creates `Agent` drivers bound to a
  session.
- **ToolsService** provides `ctx.tools` — a registry of model-facing tools and
  the guarded execution pipeline.
- **attachApproval** is not a service; it is a *listener* that attaches an
  allow/ask/deny policy to the `tools/pre-execute` waterfall.

The driver is the `Agent` class: it runs the turn/step flow over an inbox, and
writes every durable fact (user messages, assistant chunks, tool calls and
results, turn/step boundaries) to the session log. See [harness.md](harness.md)
for the exact flow.

Beyond that core, the harness ships one subsystem per directory — each owns one
concept, and the web host is the composition that wires them together:

| Subsystem | Owns |
|---|---|
| `storage/` | The file-first session store: `events.jsonl` is canonical, `summary.json` is a rebuildable index, with durability barriers and torn-tail quarantine |
| `workspace/` | The workspace registry: workspaces, project binding, ownership checks at the service boundary, per-root writer leases |
| `modes/` + `context/` | Four bundled + custom file modes; the single mode-driven context builder with budget, trim order, compaction, and a per-request manifest |
| `skills/` | Workspace skill files and the on-demand, mode-gated `Skill` tool |
| `memory/` | Workspace/project-scoped Markdown memory and its five tools |
| `agents/` | Agent definitions, bounded one-level delegation, and the Claude-first/Codex compatibility adapters |
| `mcp/` | The workspace-scoped MCP client (stdio + Streamable HTTP), config/secrets stores, health/retry/circuit breaker |
| `hooks/` | The command hook runner behind the tool-gate waterfalls |

Every isolation guarantee in these subsystems is **application-level**:
workspace ownership, filesystem containment (including granted extra
folders), MCP subprocess watchdogs, and writer leases are all enforced inside
the app. There is no OS sandbox — shell and trusted code run with host
privileges — and the docs and UI say so rather than claiming otherwise.

## Layer 2 — capabilities

Capabilities are just tools registered into `ctx.tools`:

- **`fsTools()`** — the canonical `Read`, `Write`, `Edit`, `Glob`, `Grep` tools.
  Paths resolve against the grant resolved per execution
  (`tools.setRootResolver`): the project folder plus any additional granted
  folders (project `additionalDirectories`, session `session/grants`, a
  child's spawn snapshot), each read-only or read-write, with per-folder
  symlink/junction containment, refusal of network/device paths, and denied
  roots for application-internal storage. Paths outside every granted folder
  become an approval in the web host. Containment is application-level, not
  an OS sandbox.
- **`bashTool(options)`** — one real Bash command per call (Git Bash's
  `bash.exe` on Windows, `/bin/bash` elsewhere, `MINI_DSH_BASH` to override),
  with a timeout, stop-cancellation, and process-tree cleanup. Bash means
  Bash: an unsupported environment disables the tool with an actionable error,
  and a shell is never path-confined.

The grant is resolved per execution through the ambient agent scope, so a
session's own folder overrides the server default without re-registering
anything.

## Layer 3 — web host

`createWebServer()` boots a fresh kernel, mounts the harness services, registers
the provider and tools, and attaches an approval listener whose policy is solely
the selected mode's `permissionDefaults`; its `askUser` answerer routes questions
over SSE. `--yolo` maps asks to allows but preserves explicit denies. The host
exposes everything over HTTP:

- **REST** for meta, model/folder switching, session listing/creation, message
  sending, and approval answering.
- **SSE** (`GET /api/sessions/:id/events`) streams a snapshot of the durable log
  and then live `session/event` frames — the client is stateless by design.
- The **React client** (`web/`) renders purely from that stream: transcript,
  tool cards, approval banners.

Routing approval questions to the *right* session uses the ambient
[`agentScope`](https://nodejs.org/api/async_hooks.html) (`AsyncLocalStorage`),
which the `Agent.run()` driver populates while a turn is in flight — so
concurrent sessions share one policy listener without cross-talk.

## Cross-cutting: the event vocabulary

Typed events are declared through TypeScript declaration merging against the
package entry. Producers dispatch them, and consumers listen — both fully
typed:

```ts
declare module 'mini-dsh' {
  interface Events {
    'session/event'(session: Session, event: SessionEvent): void
  }
}
```

The event names are grouped by producer:

| Prefix | Producer | Dispatch mode |
|---|---|---|
| `session/event` | `Session.append` | `emit` (observer) |
| `llm/stream` | `LlmService.stream` | `waterfall` |
| `agent/pre-step` | `Agent.turn` | `waterfall` |
| `agent/request` | `Agent.step` | `waterfall` |
| `agent/turn-stopping` | `Agent.turn` | `serial` (observer) |
| `tools/pre-execute` | `ToolsService.execute` | `waterfall` |
| `tools/post-execute` | `ToolsService.execute` | `waterfall` |
| `web/approval` | web approval bridge | `emit` (observer) |

## The three invariants

1. **Model-visible means logged.** The agent never builds a request from memory
   or ad-hoc state — every step calls `session.deriveMessages()`. A test
   (`agent-loop.spec.ts`) asserts each request equals the log projection at that
   moment, even with tools in the loop.
2. **Chunks never re-enter model history.** `assistant/chunk` events stream to
   the UI for fidelity, but only the assembled `assistant/message` is a durable
   model-visible fact.
3. **A denied or failing tool is a result, not an exception.** The tool
   pipeline converts policy denials and thrown errors into a failed
   `ToolResult` the model sees; the loop never crashes on policy.

## Lifecycle in one picture

```
Kernel constructor
  └─ ctx (root fiber) mounts plugins: SessionsService, LlmService,
     ToolsService, AgentsService (services, so `inject` order is free)
  └─ tools registered as effects (unwind when their fiber unloads)
  └─ approval attached as a ctx.on('tools/pre-execute') listener
  └─ provider registered (ctx.llm.register) as an effect
      └─ agents.create(session) → Agent bound to a durable log
          └─ agent.send(msg); await agent.run()
              └─ turn() … step() … tool pipeline … turn/end
Kernel.stop()
  └─ detaches store observer, disposes every fiber (reverse effect order),
     then the root fiber
```
