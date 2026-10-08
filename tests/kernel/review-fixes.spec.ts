/**
 * Regression tests for the kernel review findings: contained `parallel`
 * observers, promise-only `checkedWaterfall`, dependency-ordered stop,
 * rejecting explicit disposal, no unhandled rejection from a rejected
 * disposer promise, and early-disposed effects leaving no fiber record.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EventBus, Fiber, Kernel, type Context, type PluginFailedDetail } from 'dnt-harness'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('kernel review fixes', () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled)
    unhandled.length = 0
  })

  it('parallel_contains_a_synchronously_throwing_listener', async () => {
    const bus = new EventBus()
    const ran: string[] = []
    bus.on('x', () => {
      ran.push('first')
      throw new Error('sync boom')
    })
    bus.on('x', async () => {
      ran.push('second')
    })
    await expect(bus.parallel('x')).resolves.toBeUndefined()
    expect(ran).toEqual(['first', 'second'])
  })

  it('checked_waterfall_turns_a_first_listener_sync_throw_into_a_rejection', async () => {
    const bus = new EventBus()
    const boom = new Error('first boom')
    bus.on('w', () => {
      throw boom
    })
    let result: unknown
    expect(() => {
      result = bus.checkedWaterfall('w', {}, () => 'default')
    }).not.toThrow()
    await expect(result).rejects.toBe(boom)

    // The terminal default throwing synchronously with no listeners, too.
    const empty = new EventBus()
    let terminal: unknown
    expect(() => {
      terminal = empty.checkedWaterfall('w', {}, () => {
        throw boom
      })
    }).not.toThrow()
    await expect(terminal).rejects.toBe(boom)
  })

  it('stop_unwinds_inject_consumer_before_its_provider_even_when_mounted_first', async () => {
    const kernel = new Kernel()
    const seen: unknown[] = []
    // Mounted FIRST, starts SECOND (woken by the provider).
    kernel.ctx.plugin({
      name: 'consumer',
      inject: ['svc'],
      apply: (ctx: Context) => {
        ctx.effect(() => () => {
          seen.push(ctx.get('svc'))
        })
      },
    })
    kernel.ctx.plugin({
      name: 'provider',
      apply: (ctx: Context) => {
        ctx.provide('svc', 'live')
      },
    })
    await kernel.settle()
    await kernel.stop()
    expect(seen).toEqual(['live'])
  })

  it('explicit_dispose_rejects_when_cleanup_throws_and_publishes_once', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    const boom = new Error('cleanup boom')
    const fiber = kernel.ctx.plugin({
      name: 'bad',
      apply: (ctx: Context) => {
        ctx.effect(() => () => {
          throw boom
        })
      },
    })
    await expect(fiber.dispose()).rejects.toBeInstanceOf(AggregateError)
    await expect(kernel.disposeFiber(fiber)).rejects.toBeInstanceOf(AggregateError)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.phase).toBe('teardown')
    // Already published: stop keeps it in its verdict (existing contract, see
    // services.spec failed_cleanup_blocks_replacement) but never re-publishes.
    await expect(kernel.stop()).rejects.toThrow(/1 unresolved teardown failure/)
    expect(failures).toHaveLength(1)
  })

  it('owner_dispose_rejects_with_child_cleanup_failure_published_once_for_the_child', async () => {
    const kernel = new Kernel()
    const failures: PluginFailedDetail[] = []
    kernel.events.on('kernel/plugin-failed', (detail) => {
      failures.push(detail)
    })
    const boom = new Error('child boom')
    const parent = kernel.ctx.plugin({
      name: 'parent',
      apply: (ctx: Context) => {
        ctx.plugin({
          name: 'child',
          apply: (childCtx: Context) => {
            childCtx.effect(() => () => {
              throw boom
            })
          },
        })
      },
    })
    const error = await parent.dispose().then(
      () => undefined,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([boom])
    // Published once, against the child — never again against the owner.
    expect(failures.map((f) => f.name)).toEqual(['child'])
    await expect(kernel.stop()).rejects.toThrow(/1 unresolved teardown failure/)
    expect(failures).toHaveLength(1)
  })

  it('rejected_disposer_promise_is_not_unhandled_before_teardown', async () => {
    process.on('unhandledRejection', onUnhandled)
    const fiber = new Fiber('f')
    const boom = new Error('disposer promise boom')
    fiber.effect(() => Promise.reject<() => unknown>(boom))
    await flush()
    await flush()
    expect(unhandled).toEqual([])
    // Teardown still observes the rejection as the effect's cleanup failure.
    await expect(fiber.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(fiber.state).toBe('failed')
  })

  it('early_disposal_removes_the_effect_record', async () => {
    const fiber = new Fiber('f')
    const dispose = fiber.effect(() => () => {}, 'temp')
    fiber.effect(() => () => {}, 'kept')
    await dispose()
    expect(fiber.getEffects().map((e) => e.label)).toEqual(['kept'])
  })

  it('ctx_on_and_once_early_removal_leaves_no_effect_record', async () => {
    const kernel = new Kernel()
    let ctx!: Context
    kernel.ctx.plugin({
      name: 'listener',
      apply: (c: Context) => {
        ctx = c
      },
    })
    const baseline = ctx.fiber.getEffects().length
    for (let i = 0; i < 50; i++) {
      const off = ctx.on('loop', () => {})
      expect(off()).toBe(true)
      expect(off()).toBe(false)
      const offOnce = ctx.once('loop', () => {})
      expect(offOnce()).toBe(true)
    }
    expect(ctx.fiber.getEffects()).toHaveLength(baseline)

    // A once listener that FIRES also retires its effect record.
    let fired = 0
    ctx.once('loop', () => {
      fired++
    })
    ctx.emit('loop')
    ctx.emit('loop')
    expect(fired).toBe(1)
    await flush()
    expect(ctx.fiber.getEffects()).toHaveLength(baseline)
    await kernel.stop()
  })
})
