/**
 * Cordis tutorial chapter 3 — Services, reproduced on the dnt-harness kernel:
 * a plugin provides a named capability, consumers depend on it through
 * `inject`, load order is irrelevant, missing providers pend silently, and
 * dependents restart when a required service disappears and returns.
 */
import { describe, expect, it, vi } from 'vitest'
import { Kernel, Service, type Context } from 'dnt-harness'

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
})
