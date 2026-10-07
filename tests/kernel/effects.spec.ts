/**
 * Cordis tutorial chapter 2 — Lifecycle and effects, reproduced on the
 * dnt-harness kernel: effects run at load, unwind in reverse on unload, child
 * fibers dispose with their parent, and async disposers are awaited.
 */
import { describe, expect, it } from 'vitest'
import { Fiber, Kernel, type Context } from 'dnt-harness'

/** Externally-resolvable promise, for holding cleanup open in tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

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

describe('fiber teardown (once-only completion)', () => {
  it('concurrent dispose waits for the same cleanup', async () => {
    const done = deferred<void>()
    let calls = 0
    const fiber = new Fiber('test')
    fiber.effect(() => async () => {
      calls++
      await done.promise
    })
    const a = fiber.dispose()
    const b = fiber.dispose()
    let bFinished = false
    void b.then(() => {
      bFinished = true
    })
    await Promise.resolve()
    expect(bFinished).toBe(false)
    done.resolve()
    await Promise.all([a, b])
    expect(calls).toBe(1)
    expect(fiber.state).toBe('disposed')
  })

  it('early disposer racing unload is once and awaited', async () => {
    const fiber = new Fiber('test')
    let calls = 0
    const gate = deferred<void>()

    const disposer = fiber.effect(() => async () => {
      calls++
      await gate.promise
    })

    // Attach a catch up front: this teardown will surface through dispose().
    let earlyFinished = false
    void disposer().catch(() => {
      earlyFinished = true
    })
    let unloadFinished = false
    const unload = fiber.dispose().then(() => {
      unloadFinished = true
    })

    // Neither the early disposer nor the unload may settle while cleanup runs.
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toBe(1)
    expect(earlyFinished).toBe(false)
    expect(unloadFinished).toBe(false)

    gate.resolve()
    await unload
    expect(calls).toBe(1)
    expect(fiber.state).toBe('disposed')
    expect(fiber.getEffects()).toEqual([])
  })

  it('cleanup errors do not skip remaining effects', async () => {
    const fiber = new Fiber('test')
    const logs: string[] = []

    fiber.effect(() => () => void logs.push('first'))
    fiber.effect(() => () => {
      logs.push('second')
      throw new Error('second failed')
    })
    fiber.effect(() => () => void logs.push('third'))

    // Catch immediately: the rejection is asserted below, not left dangling.
    const outcome = fiber.dispose().then(
      () => 'resolved',
      (error: unknown) => `rejected:${String(error)}`,
    )
    const result = await outcome
    expect(result).toContain('rejected:AggregateError')
    expect(result).toContain('second failed')
    expect(logs).toEqual(['third', 'second', 'first'])
    expect(fiber.state).toBe('failed')
    expect(fiber.getEffects()).toEqual([])

    // A late caller observes the cached failed outcome.
    await expect(fiber.dispose()).rejects.toThrow(/second failed/)
  })

  it('iterable cleanup attempts every disposer', async () => {
    const fiber = new Fiber('test')
    const logs: string[] = []

    fiber.effect(() => [
      () => void logs.push('iter first'),
      () => {
        logs.push('iter middle')
        throw new Error('iter middle failed')
      },
      () => void logs.push('iter last'),
    ])

    const outcome = fiber.dispose().then(
      () => 'resolved',
      (error: unknown) => `rejected:${String(error)}`,
    )
    const result = await outcome
    expect(result).toContain('rejected:AggregateError')
    expect(result).toContain('iter middle failed')
    // Reverse order continues past the throwing early disposer.
    expect(logs).toEqual(['iter last', 'iter middle', 'iter first'])
    expect(fiber.state).toBe('failed')
    expect(fiber.getEffects()).toEqual([])
  })

  it('failing early disposer rejects dispose with the error exactly once', async () => {
    // Test-level unhandled-rejection tripwire: vitest reports any rejection
    // that reaches the process unobserved, which is exactly what this
    // regression guards against.
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)

    const fiber = new Fiber('regress')
    const gate = deferred<void>()

    const disposer = fiber.effect(() => async () => {
      await gate.promise
      throw new Error('early failed')
    })

    // Call the early disposer and let its rejection land immediately: the
    // returned promise must be observed (caught) right here.
    gate.resolve()
    await expect(disposer()).rejects.toThrow('early failed')

    // Whole-fiber dispose must still learn about the failure, exactly once.
    await expect(fiber.dispose()).rejects.toThrow(AggregateError)
    await expect(fiber.dispose()).rejects.toThrow(/early failed/)
    await expect(fiber.dispose()).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors.length === 1 &&
        error.errors[0] instanceof Error &&
        error.errors[0].message === 'early failed'
      )
    })
    expect(fiber.state).toBe('failed')
    expect(fiber.getEffects()).toEqual([])

    // Let the process drain; nothing may surface as unhandled.
    await new Promise((resolve) => setImmediate(resolve))
    expect(unhandled).toEqual([])

    process.off('unhandledRejection', onUnhandled)
  })
})
