/**
 * Kernel lifecycle stabilization — task 2: observable startup settlement and
 * late-completion fencing.
 *
 * Every startup is owned by the kernel: `settle()` drains it, `inspect()`
 * reports the retained diagnostic, a failure publishes exactly one typed
 * `kernel/plugin-failed` event, and nothing a plugin does after its own unload
 * can resurrect it or leak a service, listener, or child plugin.
 */
import { describe, expect, it } from 'vitest'
import { Kernel, type Context, type PluginFailedDetail } from 'dnt-harness'

describe('kernel lifecycle stabilization (task 2)', () => {
  it('async_apply_failure_unwinds_effects', async () => {
    const kernel = new Kernel()
    const ticks: number[] = []
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    const boom = new Error('startup')

    kernel.ctx.plugin({
      name: 'flaky',
      apply: async (ctx: Context) => {
        ctx.provide('flaky-svc', { n: 1 })
        ctx.on('tick', () => {
          ticks.push(1)
        })
        throw boom
      },
    })

    await kernel.settle()

    // The acquired service and listener were unwound by the startup cleanup.
    expect(kernel.services.has('flaky-svc')).toBe(false)
    kernel.events.emit('tick')
    expect(ticks).toEqual([])

    // The original error stays observable and the fiber ends disposed.
    const diagnostic = kernel.inspect().find((d) => d.name === 'flaky')
    expect(diagnostic?.error).toBe(boom)
    expect(diagnostic?.fiber.state).toBe('disposed')

    // Exactly one startup failure event, carrying the original error.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.name).toBe('flaky')
    expect(failures[0]?.phase).toBe('startup')
    expect(failures[0]?.error).toBe(boom)

    await kernel.stop()
  })

  it('sync_apply_failure_is_thrown_and_inspectable', async () => {
    const kernel = new Kernel()
    const boom = new Error('startup')
    let diagnosticFiber: import('dnt-harness').Fiber | undefined

    expect(() => {
      kernel.ctx.plugin({
        name: 'sync-fail',
        apply: (ctx: Context) => {
          ctx.provide('sync-svc', 1)
          diagnosticFiber = ctx.fiber
          throw boom
        },
      })
    }).toThrow(boom)

    // The direct caller already has its error; the cleanup is owned and
    // tracked, not silently dropped.
    await kernel.settle()

    expect(kernel.services.has('sync-svc')).toBe(false)
    const diagnostic = kernel.inspect().find((d) => d.name === 'sync-fail')
    expect(diagnostic?.error).toBe(boom)
    expect(diagnostic?.fiber).toBe(diagnosticFiber)
    expect(diagnosticFiber?.state).toBe('disposed')

    await kernel.stop()
  })

  it('unload_during_loading_never_reactivates', async () => {
    const kernel = new Kernel()
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const fiber = kernel.ctx.plugin({
      name: 'slow',
      apply: async () => {
        await held
      },
    })
    expect(fiber.state).toBe('loading')

    // The plugin is unloaded while its body is still in flight.
    await fiber.dispose()
    expect(fiber.state).toBe('disposed')

    release()
    await kernel.settle()

    // No resurrection: the same single entry stays, never active, no error.
    expect(fiber.state).toBe('disposed')
    const diagnostics = kernel.inspect().filter((d) => d.name === 'slow')
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]?.fiber).toBe(fiber)
    expect(diagnostics[0]?.error).toBeUndefined()
    expect(fiber.state).not.toBe('active')

    await kernel.stop()
  })

  it('rejection_after_unload_is_observable_without_unhandled_rejection', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    let reject: (error: unknown) => void = () => {}
    const held = new Promise<void>((_, rejectPromise) => {
      reject = rejectPromise
    })
    const boom = new Error('late failure')

    const fiber = kernel.ctx.plugin({ name: 'late', apply: () => held })
    await fiber.dispose()

    // The held startup rejects after the fiber is gone. Vitest fails the run
    // on unhandled rejections, so reaching the assertions below already proves
    // the rejection is owned.
    reject(boom)
    await kernel.settle()

    expect(fiber.state).toBe('disposed')
    expect(kernel.inspect().filter((d) => d.name === 'late')).toHaveLength(1)
    expect(kernel.inspect().find((d) => d.name === 'late')?.error).toBe(boom)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.phase).toBe('startup')

    await kernel.stop()
  })

  it('provide_after_unload_does_not_leak_service', async () => {
    const kernel = new Kernel()
    let captured: Context | undefined
    let leakedCalls = 0
    const fiber = kernel.ctx.plugin({
      name: 'holder',
      apply: async (ctx: Context) => {
        captured = ctx
        ctx.on('leak-event', () => {
          leakedCalls++
        })
        await new Promise(() => {})
      },
    })
    await fiber.dispose()
    const owner = captured as Context
    expect(captured).toBeDefined()

    // Every ownership-taking registration refuses once the fiber is gone.
    expect(() => owner.provide('leaked', {})).toThrow()
    expect(() => owner.on('leak-event', () => {})).toThrow()
    expect(() => owner.plugin(() => {})).toThrow()
    expect(() => owner.effect(() => () => {})).toThrow()

    // Nothing leaked into the store, and the listener the plugin owned while
    // it ran no longer receives events after its unload.
    expect(kernel.services.has('leaked')).toBe(false)
    kernel.events.emit('leak-event')
    expect(leakedCalls).toBe(0)

    await kernel.stop()
  })

  it('failure_observer_throw_does_not_mask_original_failure', async () => {
    const kernel = new Kernel()
    let observerCalls = 0
    kernel.events.on('kernel/plugin-failed', () => {
      observerCalls++
      throw new Error('observer boom')
    })
    const boom = new Error('startup')

    kernel.ctx.plugin({
      name: 'flaky',
      apply: async () => {
        throw boom
      },
    })

    await kernel.settle()

    const diagnostic = kernel.inspect().find((d) => d.name === 'flaky')
    expect(diagnostic?.error).toBe(boom)
    expect(diagnostic?.fiber.state).toBe('disposed')
    expect(observerCalls).toBe(1)

    await kernel.stop()
  })

  it('inspect_returns_defensive_copies_with_parent_uid', async () => {
    const kernel = new Kernel()
    let child
    const parent = kernel.ctx.plugin({
      name: 'parent',
      apply: (ctx: Context) => {
        child = ctx.plugin({ name: 'child', apply: () => {} })
      },
    })

    const snapshot = kernel.inspect()
    expect(snapshot).toHaveLength(2)

    // Parent-owned entries carry the owner's uid; root-owned ones report null.
    const childDiagnostic = snapshot.find((d) => d.name === 'child')
    expect(childDiagnostic?.fiber).toBe(child)
    expect(childDiagnostic?.parentUid).toBe(parent.uid)

    const rootDiagnostic = kernel.inspect().find((d) => d.name === 'parent')
    expect(rootDiagnostic?.parentUid).toBeNull()

    // Fresh copies: a second call never aliases the first snapshot, and
    // mutating a detached copy changes nothing the kernel reports.
    expect(kernel.inspect()).not.toBe(snapshot)
    const mutableCopies = kernel.inspect().map((d) => ({ ...d }))
    expect(mutableCopies).toHaveLength(2)
    const detached = mutableCopies.find((d) => d.name === 'child')
    if (detached) detached.error = 'injected'
    expect(kernel.inspect().find((d) => d.name === 'child')?.error).toBeUndefined()

    await kernel.stop()
  })

  it('settle_drains_transitions_but_pending_plugins_are_not_tasks', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin({
      name: 'waiter',
      inject: ['never-provided'],
      apply: () => {},
    })

    expect(kernel.inspect().find((d) => d.name === 'waiter')?.fiber.state).toBe('pending')
    await kernel.settle()
    await kernel.settle()
    // A pending plugin waits for services, not for the kernel: settle does not
    // activate it and does not hang.
    expect(kernel.inspect().find((d) => d.name === 'waiter')?.fiber.state).toBe('pending')

    await kernel.stop()
  })

  it('cleaned_startup_failure_does_not_reject_stop', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    const boom = new Error('startup')

    kernel.ctx.plugin({
      name: 'flaky',
      apply: async () => {
        throw boom
      },
    })
    await kernel.settle()
    expect(failures).toHaveLength(1)
    expect(failures[0]?.phase).toBe('startup')

    await expect(kernel.stop()).resolves.toBeUndefined()
    // The startup failure was already cleaned and reported once; stop must not
    // dispose the fiber again and re-observe the cached error.
    expect(failures).toHaveLength(1)
    expect(failures[0]?.phase).toBe('startup')
  })

  it('double_start_via_stale_flush_snapshot', async () => {
    const kernel = new Kernel()
    let starts = 0

    // Pends on early-svc; when woken, providing late-svc re-entrantly flushes
    // pending entries while the outer flush snapshot is still in flight.
    kernel.ctx.plugin({
      name: 'bridging-provider',
      inject: ['early-svc'],
      apply: (ctx: Context) => {
        ctx.provide('late-svc', {})
      },
    })
    // Pends on late-svc; when woken it must run exactly once, even though the
    // flush pass that wakes it is itself nested inside another flush pass
    // whose snapshot still lists this entry as pending.
    kernel.ctx.plugin({
      name: 'late-waiter',
      inject: ['late-svc'],
      apply: () => {
        starts++
      },
    })
    // The gate publication starts the nested flush cascade.
    kernel.ctx.plugin({
      name: 'gate',
      apply: (ctx: Context) => {
        ctx.provide('early-svc', {})
      },
    })

    await kernel.settle()

    expect(starts).toBe(1)
    const waiter = kernel.inspect().find((d) => d.name === 'late-waiter')
    expect(waiter?.fiber.state).toBe('active')
    expect(kernel.inspect().filter((d) => d.name === 'late-waiter')).toHaveLength(1)
    expect(kernel.services.has('late-svc')).toBe(true)
    expect(kernel.services.has('early-svc')).toBe(true)

    await kernel.stop()
  })

  it('stop_reports_a_cleanup_failure_with_the_teardown_phase', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    const cleanupBoom = new Error('cleanup boom')

    kernel.ctx.plugin({
      name: 'messy',
      apply: (ctx: Context) => {
        ctx.effect(() => () => {
          throw cleanupBoom
        })
      },
    })

    await kernel.stop()

    expect(failures).toHaveLength(1)
    expect(failures[0]?.name).toBe('messy')
    expect(failures[0]?.phase).toBe('teardown')
    expect(String(failures[0]?.error)).toContain('cleanup boom')
  })
})
