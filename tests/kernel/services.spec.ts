/**
 * Cordis tutorial chapter 3 — Services, reproduced on the dnt-harness kernel:
 * a plugin provides a named capability, consumers depend on it through
 * `inject`, load order is irrelevant, missing providers pend silently, and
 * dependents restart when a required service disappears and returns.
 */
import { describe, expect, it, vi } from 'vitest'
import { Kernel, Service, type Context, type PluginFailedDetail } from 'dnt-harness'

declare module 'dnt-harness' {
  interface Context {
    greeter: GreeterService
  }
}

export class GreeterService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'greeter')
  }

  greet(who: string): string {
    return `Hello, ${who}!`
  }
}

const greeterPlugin = (ctx: Context) => {
  ctx.plugin(GreeterService)
}

describe('services and inject (tutorial ch.3)', () => {
  it('provides a service and consumes it through inject', () => {
    const kernel = new Kernel()
    const seen: string[] = []

    const consumer = {
      name: 'consumer',
      inject: ['greeter'],
      apply: (ctx: Context) => {
        seen.push(ctx.greeter.greet('world'))
      },
    }

    kernel.ctx.plugin(greeterPlugin)
    kernel.ctx.plugin(consumer)

    expect(seen).toEqual(['Hello, world!'])
    void kernel.stop()
  })

  it('mount order is irrelevant — dependencies, not file order, decide', () => {
    const kernel = new Kernel()
    const seen: string[] = []

    const consumer = {
      name: 'consumer',
      inject: ['greeter'],
      apply: (ctx: Context) => {
        seen.push(ctx.greeter.greet('world'))
      },
    }

    // Consumer first: it pends until the provider mounts, then runs.
    kernel.ctx.plugin(consumer)
    kernel.ctx.plugin(greeterPlugin)

    expect(seen).toEqual(['Hello, world!'])
    void kernel.stop()
  })

  it('a missing provider leaves the consumer pending — no crash, no run', () => {
    const kernel = new Kernel()
    let ran = false

    const fiber = kernel.ctx.plugin({
      name: 'consumer',
      inject: ['greeter'],
      apply: () => {
        ran = true
      },
    })

    expect(fiber.state).toBe('pending')
    expect(ran).toBe(false)
    void kernel.stop()
  })

  it('mounting the provider later wakes the pending consumer', () => {
    const kernel = new Kernel()
    let ran = false

    const fiber = kernel.ctx.plugin({
      name: 'consumer',
      inject: ['greeter'],
      apply: () => {
        ran = true
      },
    })
    expect(fiber.state).toBe('pending')

    kernel.ctx.plugin(greeterPlugin)
    expect(fiber.state).toBe('active')
    expect(ran).toBe(true)
    void kernel.stop()
  })

  it('losing a required service restarts the dependent against its return', async () => {
    const kernel = new Kernel()
    let consumerRuns = 0

    const provider = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('greeter', {
          greet: (who: string) => `Hello, ${who}!`,
        })
      },
    }

    const consumerFiber = kernel.ctx.plugin({
      name: 'consumer',
      inject: ['greeter'],
      apply: () => {
        consumerRuns++
      },
    })

    const providerFiber = kernel.ctx.plugin(provider)
    expect(consumerFiber.state).toBe('active')
    expect(consumerRuns).toBe(1)

    await providerFiber.dispose()
    await vi.waitFor(() => {
      // The old consumer fiber was disposed; the re-mounted entry pends.
      expect(consumerFiber.state).toBe('disposed')
    })

    // The service returns: the re-mounted consumer runs again.
    kernel.ctx.plugin(provider)
    await vi.waitFor(() => {
      expect(consumerRuns).toBe(2)
    })
    await kernel.stop()
  })

  it('ctx.get reads optional services without inject', () => {
    const kernel = new Kernel()
    const seen: string[] = []

    kernel.ctx.plugin((ctx: Context) => {
      const greeter = ctx.get('greeter') as GreeterService | undefined
      seen.push(greeter?.greet('maybe') ?? 'no greeter available')
    })
    expect(seen).toEqual(['no greeter available'])

    kernel.ctx.plugin(greeterPlugin)
    kernel.ctx.plugin((ctx: Context) => {
      const greeter = ctx.get('greeter') as GreeterService | undefined
      seen.push(greeter?.greet('maybe') ?? 'no greeter available')
    })
    expect(seen).toEqual(['no greeter available', 'Hello, maybe!'])
    void kernel.stop()
  })

  it('a duplicate provider fails loud', () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(greeterPlugin)

    expect(() => kernel.ctx.plugin(greeterPlugin)).toThrow(/already provided/)
    void kernel.stop()
  })

  it('pending_consumer_failure_does_not_fail_publisher', async () => {
    const kernel = new Kernel()
    const boom = new Error('consumer startup failed')

    const provider = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('greeter', { greet: (who: string) => `Hello, ${who}!` })
      },
    }

    // The consumer pends; the provider's publication inside its own start is
    // what wakes it. The woken consumer throws synchronously during that wake
    // pass — the throw is contained at the producer and never reaches the
    // caller who mounted the provider.
    kernel.ctx.plugin({
      name: 'woken-consumer',
      inject: ['greeter'],
      apply: () => {
        throw boom
      },
    })

    let providerFiber: import('dnt-harness').Fiber | undefined
    expect(() => {
      providerFiber = kernel.ctx.plugin(provider)
    }).not.toThrow()

    await kernel.settle()

    expect(providerFiber?.state).toBe('active')
    // The publisher stays active and owns its service; the failed consumer does not.
    expect(kernel.services.has('greeter')).toBe(true)
    const failed = kernel.inspect().find((d) => d.name === 'woken-consumer')
    expect(failed?.error).toBe(boom)
    expect(failed?.fiber.state).toBe('disposed')

    // Removing the publisher disposes it and, with it, its cleanup-owned
    // service — even though a consumer failed during the wake pass earlier.
    await providerFiber?.dispose()
    await kernel.settle()
    expect(kernel.services.has('greeter')).toBe(false)

    await kernel.stop()
  })

  it('failed_entry_does_not_restart_on_dependency_removal', async () => {
    const kernel = new Kernel()
    let consumerRuns = 0
    const boom = new Error('consumer startup failed')

    // The consumer pends, then is woken by the provider's publication inside
    // that provider's own startup — a kernel-internal wake — and fails. That
    // first run retires the entry for good.
    const consumer = {
      name: 'consumer',
      inject: ['greeter'],
      apply: () => {
        consumerRuns++
        throw boom
      },
    }
    const provider = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('greeter', { greet: (who: string) => `Hello, ${who}!` })
      },
    }

    kernel.ctx.plugin(consumer)
    const providerFiber = kernel.ctx.plugin(provider)
    await kernel.settle()

    expect(consumerRuns).toBe(1)
    expect(kernel.inspect().find((d) => d.name === 'consumer')?.error).toBe(boom)
    expect(providerFiber.state).toBe('active')

    // The service goes away and returns: only live pending entries react; the
    // retired consumer never restarts.
    await providerFiber.dispose()
    await kernel.settle()
    expect(consumerRuns).toBe(1)

    kernel.ctx.plugin(provider)
    await kernel.settle()
    expect(consumerRuns).toBe(1)
    await kernel.stop()
  })

  it('restarted_child_stays_parent_owned', async () => {
    const kernel = new Kernel()
    let runs = 0
    let parent: import('dnt-harness').Fiber | undefined
    let child: import('dnt-harness').Fiber | undefined
    const providerDef = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('greeter', { greet: (who: string) => `Hello, ${who}!` })
      },
    }

    kernel.ctx.plugin({
      name: 'parent',
      apply: (ctx: Context) => {
        child = ctx.plugin({
          name: 'consumer',
          inject: ['greeter'],
          apply: () => {
            runs++
          },
        })
      },
    })
    parent = kernel.inspect().find((d) => d.name === 'parent')?.fiber
    const provider = kernel.ctx.plugin(providerDef)
    await kernel.settle()

    // Started once under the parent.
    expect(runs).toBe(1)
    expect(child?.state).toBe('active')
    expect(kernel.inspect().find((d) => d.name === 'consumer')?.parentUid).toBe(parent?.uid)

    // Dependency loss disposes the child and its replacement pends again —
    // as a NEW generation fiber, but still parent-owned.
    await provider.dispose()
    await kernel.settle()
    expect(child?.state).toBe('disposed')
    const restarted = kernel.inspect().find((d) => d.name === 'consumer')
    expect(restarted).toBeDefined()
    expect(restarted?.fiber).not.toBe(child)
    expect(restarted?.fiber.state).toBe('pending')
    expect(restarted?.parentUid).toBe(parent?.uid)

    // The service returns: the replacement runs, still owned by the parent.
    kernel.ctx.plugin(providerDef)
    await kernel.settle()
    expect(runs).toBe(2)
    expect(kernel.inspect().find((d) => d.name === 'consumer')?.fiber).toBe(restarted?.fiber)
    expect(kernel.inspect().find((d) => d.name === 'consumer')?.parentUid).toBe(parent?.uid)
    expect(kernel.inspect().filter((d) => d.name === 'consumer')).toHaveLength(1)

    // Disposing the parent disposes the logical entry — including its
    // replacement generation — leaving no owned child behind.
    await parent?.dispose()
    await kernel.settle()
    expect(restarted?.fiber.state).toBe('disposed')
    const owned = kernel.inspect().filter((d) => d.name === 'consumer')
    expect(owned).toHaveLength(1)
    expect(owned[0]?.parentUid).toBe(parent?.uid)
    expect(owned[0]?.fiber.state).not.toBe('active')
    expect(owned[0]?.fiber.state).not.toBe('pending')

    await kernel.stop()
  })

  it('dispose_initial_handle_after_restart_closes_entry', async () => {
    const kernel = new Kernel()
    let runs = 0
    let initial: import('dnt-harness').Fiber | undefined
    const providerDef = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('greeter', { greet: (who: string) => `Hello, ${who}!` })
      },
    }

    const consumer = kernel.ctx.plugin({
      name: 'consumer',
      inject: ['greeter'],
      apply: () => {
        runs++
      },
    })
    const provider = kernel.ctx.plugin(providerDef)
    await kernel.settle()
    expect(runs).toBe(1)
    initial = consumer

    // Remove the provider: the replacement generation pends on the SAME
    // logical entry while the old handle is already disposed.
    await provider.dispose()
    await kernel.settle()
    expect(initial.state).toBe('disposed')
    const replacement = kernel.inspect().find((d) => d.name === 'consumer')?.fiber
    expect(replacement).toBeDefined()
    expect(replacement).not.toBe(initial)
    expect(replacement?.state).toBe('pending')

    // The STALE initial handle must still reach the logical entry: disposing
    // it closes admission, so the replacement generation is cleaned too.
    await initial.dispose()
    await kernel.settle()
    expect(replacement?.state).toBe('disposed')
    expect(kernel.inspect().filter((d) => d.name === 'consumer')).toHaveLength(1)

    // A closed entry is out of the wake pool: the service returning must not
    // apply it again, and no extra diagnostic appears.
    kernel.ctx.plugin(providerDef)
    await kernel.settle()
    expect(runs).toBe(1)
    expect(kernel.inspect().filter((d) => d.name === 'consumer')).toHaveLength(1)

    await kernel.stop()
  })

  it('two_dependency_removals_coalesce', async () => {
    const kernel = new Kernel()
    let applies = 0
    let cleanups = 0
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })

    kernel.ctx.plugin({
      name: 'consumer',
      inject: ['svc-a', 'svc-b'],
      apply: (ctx: Context) => {
        applies++
        ctx.effect(() => async () => {
          cleanups++
          await barrier
        })
      },
    })
    kernel.ctx.plugin({
      name: 'provider-a',
      apply: (ctx: Context) => {
        ctx.provide('svc-a', 1)
      },
    })
    kernel.ctx.plugin({
      name: 'provider-b',
      apply: (ctx: Context) => {
        ctx.provide('svc-b', 2)
      },
    })
    await kernel.settle()
    expect(applies).toBe(1)

    // Both dependencies vanish while the first cleanup is still held: the
    // second removal must coalesce into the in-flight transition instead of
    // queueing a second teardown+remount.
    const providerA = kernel.inspect().find((d) => d.name === 'provider-a')?.fiber
    const providerB = kernel.inspect().find((d) => d.name === 'provider-b')?.fiber
    void providerA?.dispose()
    await vi.waitFor(() => expect(cleanups).toBe(1))
    void providerB?.dispose()

    // Both services return while the coalesced cleanup is still held.
    kernel.ctx.plugin({
      name: 'provider-a-2',
      apply: (ctx: Context) => {
        ctx.provide('svc-a', 1)
      },
    })
    kernel.ctx.plugin({
      name: 'provider-b-2',
      apply: (ctx: Context) => {
        ctx.provide('svc-b', 2)
      },
    })

    release()
    await kernel.settle()

    // One cleanup, then exactly one fresh apply — not one per removal.
    expect(cleanups).toBe(1)
    expect(applies).toBe(2)
    expect(kernel.inspect().filter((d) => d.name === 'consumer')).toHaveLength(1)
    const entry = kernel.inspect().find((d) => d.name === 'consumer')
    expect(entry?.fiber.state).toBe('active')
    expect(kernel.services.has('svc-a')).toBe(true)
    expect(kernel.services.has('svc-b')).toBe(true)

    await kernel.stop()
  })

  it('parent_dispose_during_restart_prevents_remount', async () => {
    const kernel = new Kernel()
    let applies = 0
    let cleanups = 0
    let release: () => void = () => {}
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    let parent: import('dnt-harness').Fiber | undefined

    kernel.ctx.plugin({
      name: 'parent',
      apply: (ctx: Context) => {
        kernel.plugin(
          {
            name: 'child',
            inject: ['svc-a'],
            apply: (ctx: Context) => {
              applies++
              ctx.effect(() => async () => {
                cleanups++
                await barrier
              })
            },
          },
          ctx.fiber,
        )
      },
    })
    parent = kernel.inspect().find((d) => d.name === 'parent')?.fiber
    const provider = kernel.ctx.plugin({
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('svc-a', 1)
      },
    })
    await kernel.settle()
    expect(applies).toBe(1)

    // The dependency-driven teardown is in flight (cleanup held) when the
    // parent unloads: the racing restart must not remount anything.
    void provider.dispose()
    await vi.waitFor(() => expect(cleanups).toBe(1))
    await parent?.dispose()

    release()
    await kernel.settle()

    // Exactly one cleanup, no second apply, and no live child remains.
    expect(cleanups).toBe(1)
    expect(applies).toBe(1)
    const owned = kernel.inspect().filter((d) => d.name === 'child')
    expect(owned).toHaveLength(1)
    expect(owned[0]?.fiber.state).not.toBe('active')
    expect(owned[0]?.fiber.state).not.toBe('pending')
    expect(owned[0]?.parentUid).toBe(parent?.uid)
    expect(kernel.services.has('svc-a')).toBe(false)

    await kernel.stop()
  })

  it('failed_cleanup_blocks_replacement', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    let applies = 0
    const cleanupBoom = new Error('cleanup boom')

    kernel.ctx.plugin({
      name: 'consumer',
      inject: ['svc-a'],
      apply: (ctx: Context) => {
        applies++
        ctx.effect(() => () => {
          throw cleanupBoom
        })
      },
    })
    const providerDef = {
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('svc-a', 1)
      },
    }
    const provider = kernel.ctx.plugin(providerDef)
    await kernel.settle()
    expect(applies).toBe(1)

    // The dependency goes away; the entry's cleanup fails. The teardown
    // failure is published and the entry must NOT be replaced: a cleanup
    // that failed cannot prove the plugin was unwound safely.
    await provider.dispose()
    await kernel.settle()

    expect(applies).toBe(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.name).toBe('consumer')
    expect(failures[0]?.phase).toBe('teardown')
    expect(String(failures[0]?.error)).toContain('cleanup boom')

    // No second apply ever — not now, and not when the service returns.
    kernel.ctx.plugin(providerDef)
    await kernel.settle()
    expect(applies).toBe(1)
    expect(failures).toHaveLength(1)
    expect(kernel.inspect().filter((d) => d.name === 'consumer')).toHaveLength(1)

    await kernel.stop()
  })

  it('disposed_pending_child_never_wakes', async () => {
    const kernel = new Kernel()
    let applies = 0

    const child = kernel.plugin({
      name: 'child',
      inject: ['svc-a'],
      apply: () => {
        applies++
      },
    })
    expect(child.state).toBe('pending')

    // Dispose the pending child while its dependency is still missing.
    await child.dispose()
    await kernel.settle()

    // The dependency arrives: the disposed entry must stay out of the wake
    // pool entirely — no apply, no new diagnostic, no resurrection.
    kernel.ctx.plugin({
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('svc-a', 1)
      },
    })
    await kernel.settle()

    expect(applies).toBe(0)
    expect(child.state).toBe('disposed')
    expect(kernel.inspect().filter((d) => d.name === 'child')).toHaveLength(1)
    expect(kernel.inspect().find((d) => d.name === 'child')?.fiber.state).toBe('disposed')

    await kernel.stop()
  })
})
