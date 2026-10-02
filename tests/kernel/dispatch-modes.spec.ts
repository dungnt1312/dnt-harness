/**
 * Dispatch-mode contracts on the raw EventBus: emit order, parallel
 * concurrency, serial/bail first-wins, disposer and once semantics.
 */
import { describe, expect, it } from 'vitest'
import { EventBus } from 'dnt-harness'

describe('EventBus dispatch modes', () => {
  it('emit runs listeners in registration order and ignores return values', () => {
    const bus = new EventBus()
    const calls: string[] = []

    bus.on('modes/emit', () => {
      calls.push('first')
      return 'ignored'
    })
    bus.on('modes/emit', () => {
      calls.push('second')
    })

    bus.emit('modes/emit')
    expect(calls).toEqual(['first', 'second'])
  })

  it('emit with no listeners is a no-op', () => {
    const bus = new EventBus()
    expect(() => bus.emit('modes/empty')).not.toThrow()
  })

  it('parallel runs listeners concurrently and settles them all', async () => {
    const bus = new EventBus()
    let running = 0
    let maxConcurrent = 0
    const finished: string[] = []

    bus.on('modes/parallel', async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
      finished.push('slow')
    })
    bus.on('modes/parallel', async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      running--
      finished.push('fast')
    })

    await bus.parallel('modes/parallel')
    expect(maxConcurrent).toBe(2)
    expect(finished).toEqual(['fast', 'slow'])
  })

  it('parallel contains observer failures', async () => {
    const bus = new EventBus()
    let secondRan = false

    bus.on('modes/parallel-fail', async () => {
      throw new Error('observer exploded')
    })
    bus.on('modes/parallel-fail', async () => {
      secondRan = true
    })

    await expect(bus.parallel('modes/parallel-fail')).resolves.toBeUndefined()
    expect(secondRan).toBe(true)
  })

  it('serial awaits in order and the first bail value stops the rest', async () => {
    const bus = new EventBus()
    const calls: string[] = []

    bus.on('modes/serial', async () => {
      calls.push('first')
      return undefined
    })
    bus.on('modes/serial', async () => {
      calls.push('second')
      return 'second wins'
    })
    bus.on('modes/serial', async () => {
      calls.push('third')
      return 'third never returned'
    })

    const result = await bus.serial('modes/serial')
    expect(result).toBe('second wins')
    expect(calls).toEqual(['first', 'second'])
  })

  it('bail is the synchronous serial: first truthy return stops the chain', () => {
    const bus = new EventBus()
    const calls: string[] = []

    bus.on('modes/bail', () => {
      calls.push('first')
      return false
    })
    bus.on('modes/bail', () => {
      calls.push('second')
      return 'denied by second'
    })
    bus.on('modes/bail', () => {
      calls.push('third')
      return true
    })

    const result = bus.bail('modes/bail')
    expect(result).toBe('denied by second')
    expect(calls).toEqual(['first', 'second'])
  })

  it('serial and bail fall through to undefined when nobody bails', async () => {
    const bus = new EventBus()
    bus.on('modes/none', () => undefined)

    expect(bus.bail('modes/none')).toBeUndefined()
    expect(await bus.serial('modes/none')).toBeUndefined()
  })

  it('on returns a disposer; double calls report false', () => {
    const bus = new EventBus()
    const dispose = bus.on('modes/dispose', () => {})

    expect(dispose()).toBe(true)
    expect(dispose()).toBe(false)

    const calls: number[] = []
    bus.on('modes/dispose', (value: number) => calls.push(value))
    bus.emit('modes/dispose', 1)
    expect(calls).toEqual([1])
  })

  it('a disposed listener no longer fires', () => {
    const bus = new EventBus()
    const calls: number[] = []
    const dispose = bus.on('modes/removed', (value: number) => calls.push(value))

    dispose()
    bus.emit('modes/removed', 1)
    expect(calls).toEqual([])
  })

  it('once fires the listener a single time', () => {
    const bus = new EventBus()
    const calls: number[] = []

    bus.once('modes/once', (value: number) => calls.push(value))
    bus.emit('modes/once', 1)
    bus.emit('modes/once', 2)

    expect(calls).toEqual([1])
  })

  it('prepend registers ahead of existing listeners', () => {
    const bus = new EventBus()
    const calls: string[] = []

    bus.on('modes/prepend', () => calls.push('ordinary'))
    bus.on(
      'modes/prepend',
      () => calls.push('prepended'),
      { prepend: true },
    )

    bus.emit('modes/prepend')
    expect(calls).toEqual(['prepended', 'ordinary'])
  })

  it('a listener removed during a dispatch still fires in it, not in the next', () => {
    const bus = new EventBus()
    const calls: string[] = []

    const disposeSecond = bus.on('modes/mutating', () => {
      calls.push('second')
    })
    bus.on('modes/mutating', () => {
      calls.push('first')
      disposeSecond()
    })

    // The dispatch iterates a snapshot: removal mid-dispatch takes effect on
    // the next dispatch, not the running one.
    bus.emit('modes/mutating')
    expect(calls).toEqual(['second', 'first'])

    bus.emit('modes/mutating')
    expect(calls).toEqual(['second', 'first', 'first'])
  })
})
