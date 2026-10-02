/**
 * Cordis tutorial chapter 2 — Lifecycle and effects, reproduced on the
 * dnt-harness kernel: effects run at load, unwind in reverse on unload, child
 * fibers dispose with their parent, and async disposers are awaited.
 */
import { describe, expect, it } from 'vitest'
import { Kernel, type Context } from 'dnt-harness'

describe('fiber effects (tutorial ch.2)', () => {
  it('runs the effect body at load and its disposer on unload', async () => {
    const kernel = new Kernel()
    const logs: string[] = []
    const tick = () => logs.push('tick')

    const heartbeat = (ctx: Context) => {
      logs.push('heartbeat plugin loading')
      ctx.effect(() => {
        return () => {
          logs.push('heartbeat cleaned up')
        }
      })
    }

    const fiber = kernel.ctx.plugin(heartbeat)
    tick()
    tick()
    tick()
    await fiber.dispose()

    expect(logs).toEqual([
      'heartbeat plugin loading',
      'tick',
      'tick',
      'tick',
      'heartbeat cleaned up',
    ])
    await kernel.stop()
  })

  it('disposes effects in reverse registration order', async () => {
    const kernel = new Kernel()
    const logs: string[] = []

    const fiber = kernel.ctx.plugin((ctx) => {
      ctx.effect(() => () => logs.push('first cleaned'))
      ctx.effect(() => () => logs.push('second cleaned'))
      ctx.effect(() => () => logs.push('third cleaned'))
    })
    await fiber.dispose()

    expect(logs).toEqual(['third cleaned', 'second cleaned', 'first cleaned'])
    await kernel.stop()
  })

  it('awaits async disposers before settle', async () => {
    const kernel = new Kernel()
    let settled = false

    const fiber = kernel.ctx.plugin((ctx) => {
      ctx.effect(() => {
        return async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          settled = true
        }
      })
    })

    const disposed = fiber.dispose()
    expect(settled).toBe(false)
    await disposed
    expect(settled).toBe(true)
    expect(fiber.state).toBe('disposed')
    await kernel.stop()
  })

  it('disposes child fibers with their parent', async () => {
    const kernel = new Kernel()
    let childCleaned = false

    const child = (ctx: Context) => {
      ctx.effect(() => () => {
        childCleaned = true
      })
    }

    const parent = kernel.ctx.plugin((ctx) => {
      ctx.plugin(child)
    })

    await parent.dispose()
    expect(childCleaned).toBe(true)
    await kernel.stop()
  })

  it('accepts a promise of a disposer and an iterable of disposers', async () => {
    const kernel = new Kernel()
    const logs: string[] = []

    const fiber = kernel.ctx.plugin((ctx) => {
      ctx.effect(async () => {
        await Promise.resolve()
        return () => logs.push('promise disposer')
      })
      ctx.effect(function* () {
        yield () => logs.push('generator disposer 1')
        yield () => logs.push('generator disposer 2')
      })
    })

    await fiber.dispose()
    expect(logs).toEqual([
      'generator disposer 2',
      'generator disposer 1',
      'promise disposer',
    ])
    await kernel.stop()
  })

  it('rejects new effects once the fiber is disposed', async () => {
    const kernel = new Kernel()
    const fiber = kernel.ctx.plugin(() => {})
    await fiber.dispose()

    expect(() => fiber.effect(() => () => {})).toThrow(/cannot create effect/)
    await kernel.stop()
  })

  it('double dispose is a no-op', async () => {
    const kernel = new Kernel()
    let cleanups = 0
    const fiber = kernel.ctx.plugin((ctx) => {
      ctx.effect(() => () => {
        cleanups++
      })
    })

    await fiber.dispose()
    await fiber.dispose()
    expect(cleanups).toBe(1)
    await kernel.stop()
  })
})
