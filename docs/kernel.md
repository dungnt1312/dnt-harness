# The mini-Cordis kernel

The kernel is a self-contained plugin runtime inspired by the Cordis ideas —
everything is a plugin, typed events with five dispatch modes, reversible
effects, and dependency-driven lifecycle — reimplemented from scratch without
importing any of its code. This document walks each file in `src/kernel/`.

## Module map

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

## EventBus (`events.ts`)

One bus, one flat namespace of event names, and a *dispatch mode baked into
each dispatch call*. Producers pick the mode that matches the contract; the
method name is the mode.

```ts
const bus = new EventBus()
bus.on('stats/report', (name: string, count: number) => {
  console.log(name, count)
})
bus.emit('stats/report', 'turns', 3)
```

### The five dispatch modes

| Mode | Await | Order | Returns |
|---|---|---|---|
| `emit` | no | registration | nothing |
| `parallel` | all together | concurrent | `Promise<void>` (observer failures contained) |
| `serial` | in order | registration | first bail value stops the chain |
| `bail` | no | registration | synchronous first-bail |
| `waterfall` | chain | outermost→innermost | each listener wraps or vetoes via `next()` |

**Bail values** are `null`, `false`, and `undefined`-free: any other returned
value (a string, `true`, an object, `0`) is a bail and stops the chain.

**Waterfall** is around-middleware: the final dispatch argument is the
innermost `next`. Each listener wraps the rest of the chain:

- calling `next()` delegates — with the original arguments when called with
  none, or with replacement arguments when called with some;
- returning *without* calling `next()` vetoes the rest of the chain.

A waterfall listener that only observes must call `next()` — a standing rule
this kernel keeps by design.

### Typing

Plugins declare event signatures through TypeScript declaration merging, then
dispatch and listen fully typed:

```ts
declare module 'dnt-harness' {
  interface Events {
    'stats/report'(name: string, count: number): void
  }
}
```

Every method also carries an untyped string-key overload for code that
dispatches dynamically (loaders, bridges).

### Ownership and disposal

- `on()` / `once()` return a disposer; calling it twice reports `false` the
  second time.
- `once` auto-disposes after its first call.
- `{ prepend: true }` (or passing `true`) registers ahead of existing listeners.
- Dispatch iterates a **snapshot** of currently registered listeners: removing a
  listener during a dispatch takes effect on the *next* dispatch, not the
  running one.
- Listener ownership is normally handled by `ctx.on()` (see Context), which ties
  the listener to the fiber's effect list.

## Fiber (`fiber.ts`)

A fiber is *one loaded plugin instance*: its lifecycle state plus the set of
cleanup-aware effects it registered.

### Lifecycle

```
pending → loading → active → unloading → disposed
                     ↘ failed
```

- `pending` — the plugin was mounted but its `inject` requirements are missing.
- `loading` → `active` — the plugin body ran (and its async startup settled).
- `failed` — the body threw (sync) or its promise rejected. Sync failures
  propagate to the mounter; async startup failures log loudly to the console.
- `unloading` → `disposed` — `dispose()` runs every collected disposer in
  reverse registration order, awaiting each one.

### Effects

`fiber.effect(execute, label?)` runs `execute()` immediately and collects the
disposer it produces. Accepted effect shapes:

```ts
type Effect =
  | (() => unknown)                    // a plain disposer
  | Promise<() => unknown>             // a promise of a disposer
  | Iterable<() => unknown>            // several disposers (run in reverse)
```

The returned disposer tears that one effect down and settles once done; calling
it twice is a no-op. Effects can be created only while the fiber is
`pending`/`loading`/`active` — creating one on an unloading/disposed/failed fiber
throws. `getEffects()` returns a diagnostics tree of labels and nested children.

**Everything a plugin registers is an effect.** `ctx.on`, `ctx.once`,
`ctx.provide`, `ctx.plugin`, and the `Service` base class all funnel their
cleanup through `fiber.effect`, so teardown unwinds predictably and plugins
never bookkeep removals.

## ServiceStore (`store.ts`)

A flat, per-kernel map of service name → value.

- `get` / `has` — read.
- `set` — **fails loud** when the name is already provided, so a duplicate
  provider is never silent. Replacing a service goes through
  remove-then-add (see `Context.provide` + `Kernel` restart logic).
- `delete` — removes a value, returns whether one was actually removed.
- `onChange(listener)` — observes additions/removals; returns a disposer. The
  kernel uses this to wake pending plugins and to restart dependents of a
  removed service.

## Context (`context.ts`)

The runtime half of the context: an instance carries the kernel and the
owning fiber, and exposes the plugin-facing surface:

| Member | Purpose |
|---|---|
| `ctx.events` | the shared event bus |
| `ctx.on` / `ctx.once` | register a listener **owned by the fiber** (auto-disposed on unload) |
| `ctx.emit` / `parallel` / `serial` / `bail` / `waterfall` | dispatch, mirroring the bus |
| `ctx.effect(execute, label?)` | register a cleanup-aware effect |
| `ctx.provide(name, value)` | publish a service; unregisters when the fiber unloads |
| `ctx.get(name)` | read an optional service without declaring an `inject` |
| `ctx.plugin(target)` | mount a child plugin; disposed with this fiber |

`createContext()` wraps the instance in a `Proxy`: **reads of unknown string
properties resolve against the service store** — so `ctx.tools` reads the
`tools` service without importing its provider, and `ctx.greeter` is statically
typed through declaration merging:

```ts
declare module 'dnt-harness' {
  interface Context {
    greeter: GreeterService
  }
}
```

Known members (methods, `events`, `fiber`) shadow services of the same name —
service names share one flat namespace with them. Reading an unknown name
returns `undefined` (an optional service), never throws.

### Service (`service.ts`)

The `Service` base class is the convenient way to publish a named capability:
its constructor calls `ctx.provide(name, this)`, so a service subclass is both a
plugin (mount it, and the name appears on the context) and a runtime object.

```ts
class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }
  greet(who: string): string {
    return `Hello, ${who}!`
  }
}
```

## Kernel (`registry.ts`)

The kernel owns one `EventBus`, one `ServiceStore`, and the set of mounted
plugins. Its root context (`kernel.ctx`) is where plugins are mounted.

### Plugin shapes

```ts
type PluginTarget =
  | ((ctx: Context) => void | Promise<void>)              // a function
  | { name?: string; inject?: string[]; apply(ctx) }      // an object
  | (new (ctx: Context) => unknown)                       // a Service subclass
```

`resolvePlugin` normalizes any shape:

- a **Service subclass** is mounted by instantiating it (the constructor claims
  the service name);
- a **function** runs directly; a function target may carry a static `inject`
  property;
- an **object** delegates to its `apply`.

### Dependency-driven lifecycle

Boot order comes from `inject`, never from mount order:

- Mounting a plugin with missing requirements leaves its fiber `pending` and the
  body does not run.
- **Adding** a service flushes pending plugins — a new provider may satisfy them
  now.
- **Removing** a required service disposes every loaded dependent and re-mounts
  it; it pends until the service returns. (A dependent of a service removed
  during teardown is not restarted — `stop()` detaches the observer first.)

`ctx.plugin(target)` ties the child to the parent fiber; `kernel.plugin()` mounts
root-owned.

### Teardown

`kernel.stop()` is the whole-kernel shutdown verdict:

- **Fenced synchronously.** From the moment `stop()` is called, nothing mounts
  (both `kernel.plugin()` and `ctx.plugin()` throw), restarts and wake-ups are
  suppressed, and the store observer is detached. Mounting after a completed
  stop refuses loud — never a silent pending plugin.
- **One cached verdict.** The first call starts the shutdown; every other call —
  concurrent or issued later — awaits the *same* promise. A stop that found
  unresolved teardown failures rejects with one `AggregateError` listing each
  failure, and keeps rejecting with that same aggregate; a clean stop keeps
  resolving. No cleanup ever re-runs for a later caller.
- **Every cleanup is attempted.** One entry's failing disposer never skips
  another entry's cleanup or the root fiber's unwind; each failure is collected,
  published once as a `teardown` failure, and listed in the aggregate.
- **Already-settled failures are not replayed.** A startup failure whose cleanup
  already ran (fiber `disposed`, diagnostic retained in `inspect()`) is history:
  stop skips it and still resolves.
- **Owned work is drained; foreign work is not awaited.** Stop waits for the
  cleanups and kernel-owned transitions it starts — including `trackUndo` undo
  paths. It does *not* wait for a `loading` body still parked on its own I/O:
  arbitrary in-flight JavaScript cannot be cancelled from outside, so stop
  fences the late completion instead (the entry can never activate, and any
  publication the body attempts after its unload throws). A host that must bound
  that wait wraps `stop()` in its own deadline — the web server and headless bin
  use `boundedCleanup`, which intentionally gives up (and reports ownership as
  retained) rather than force-releasing.

`settle()` remains a drain API, not an activation-success guarantee: it resolves
when every kernel-owned transition has settled; callers inspect `inspect()` for
failed entries and `pending` fibers.

## Loader (`loader.ts`)

A composition file (in the Cordis YAML style) turns into a plugin tree:

```yaml
- name: './hello.ts'
- name: './greeter.ts'
- name: './consumer.ts'
- name: './disabled.ts'
  disabled: true
```

- `parseConfig(source)` validates the shape: the root must be a list, each row a
  mapping with a non-empty string `name`, and `disabled` must be a boolean when
  present.
- `loadPluginModule(specifier, baseUrl)` imports the module and picks its plugin:
  the default export when present, otherwise the module namespace itself (a
  named-export function plugin), otherwise an `{ apply }` export.
- `boot(kernel, source, baseUrl)` / `bootFromFile(kernel, path)` parse, import
  every enabled entry, and mount it on the kernel's root context, returning the
  mounted fibers in file order.

Example fixture consumer (dependency declared, order irrelevant):

```ts
export const name = 'consumer-fixture'
export const inject = ['greeter']

export function apply(ctx: Context): void {
  ctx.provide('consumerSaw', ctx.greeter.greet('world'))
}
```

## Reading further

- The kernel's own test suite covers the mechanics end to end in
  `tests/kernel/`: dispatch modes, effects and disposal, the service store,
  and the composition loader (`dispatch-modes.spec.ts`, `effects.spec.ts`,
  `events.spec.ts`, `services.spec.ts`, `loader.spec.ts`).
- Public exports: `src/kernel/index.ts`.
