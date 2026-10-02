/**
 * The durable session log: stamped appends, `session/event` broadcast, model
 * history projection, and fork boundaries.
 */
import { describe, expect, it, vi } from 'vitest'
import { Kernel, SessionsService } from 'dnt-harness'

/** Boot a kernel with the session service mounted. */
function boot(): Kernel {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  return kernel
}

describe('session log', () => {
  it('stamps appends with increasing seq and broadcasts session/event', () => {
    const kernel = boot()
    const session = kernel.ctx.sessions.create()
    const seen: number[] = []
    kernel.ctx.on('session/event', (emitter, event) => {
      if (emitter === session) seen.push(event.seq)
    })

    session.append({ type: 'turn/start', turnId: 'turn-1' as never })
    session.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'hi' })
    session.append({ type: 'turn/end', turnId: 'turn-1' as never, reason: 'completed' })

    expect(session.events.map((event) => event.seq)).toEqual([1, 2, 3])
    expect(session.events.map((event) => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(seen).toEqual([1, 2, 3])
    void kernel.stop()
  })

  it('queues canonical persistence before isolating throwing and rejecting live observers', async () => {
    const kernel = new Kernel()
    const writes: number[] = []
    const store = {
      append: async (_id: string, event: { seq: number }) => { writes.push(event.seq) },
      flush: async () => {},
      read: async () => ({ events: [], truncatedTail: false }),
      replace: async () => {},
      writeSummary: async () => {},
      readSummary: async () => undefined,
      list: async () => [],
      remove: async () => {},
    }
    kernel.ctx.plugin((ctx) => { new SessionsService(ctx, 'sessions', { store: store as never }) })
    const session = kernel.ctx.sessions.create()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const removeThrowing = kernel.ctx.on('session/event', () => { throw new Error('throwing observer') })

    expect(() => session.append({ type: 'user/message', turnId: 't1' as never, content: 'saved' })).not.toThrow()
    await session.durable()
    await Promise.resolve()
    expect(writes).toEqual([1])
    expect(session.events).toHaveLength(1)
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('event observer failed'),
      expect.objectContaining({ message: 'throwing observer' }),
    )

    removeThrowing()
    kernel.ctx.on('session/event', async () => { throw new Error('rejecting observer') })
    expect(() => session.append({ type: 'turn/end', turnId: 't1' as never, reason: 'completed' })).not.toThrow()
    await session.durable()
    await Promise.resolve()
    expect(writes).toEqual([1, 2])
    warning.mockRestore()
    await kernel.stop()
  })

  it('deriveMessages projects user/assistant order and skips chunks and markers', () => {
    const kernel = boot()
    const session = kernel.ctx.sessions.create()

    session.append({ type: 'turn/start', turnId: 'turn-1' as never })
    session.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'hello' })
    session.append({ type: 'step/start', turnId: 'turn-1' as never, stepId: 'step-1' as never })
    session.append({ type: 'assistant/chunk', stepId: 'step-1' as never, delta: 'Hi ' })
    session.append({ type: 'assistant/chunk', stepId: 'step-1' as never, delta: 'there' })
    session.append({ type: 'assistant/message', stepId: 'step-1' as never, content: 'Hi there' })
    session.append({ type: 'step/end', turnId: 'turn-1' as never, stepId: 'step-1' as never })
    session.append({ type: 'turn/end', turnId: 'turn-1' as never, reason: 'completed' })
    session.append({ type: 'turn/start', turnId: 'turn-2' as never })
    session.append({ type: 'user/message', turnId: 'turn-2' as never, content: 'again' })

    expect(session.deriveMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'again' },
    ])
    void kernel.stop()
  })

  it('fork copies up to the boundary, rebases seq, and diverges afterwards', async () => {
    const kernel = boot()
    const parent = kernel.ctx.sessions.create()

    parent.append({ type: 'turn/start', turnId: 'turn-1' as never })
    parent.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'stay' })
    parent.append({ type: 'assistant/message', stepId: 'step-1' as never, content: 'kept' })
    parent.append({ type: 'turn/end', turnId: 'turn-1' as never, reason: 'completed' })
    parent.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'cut me' })

    const child = await kernel.ctx.sessions.fork(parent, 4)
    expect(child.events).toHaveLength(4)
    expect(child.events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(child.deriveMessages()).toEqual([
      { role: 'user', content: 'stay' },
      { role: 'assistant', content: 'kept' },
    ])
    expect(child.id).not.toBe(parent.id)

    child.append({ type: 'user/message', turnId: 'turn-9' as never, content: 'child only' })
    expect(parent.events).toHaveLength(5)
    expect(child.events).toHaveLength(5)
    expect(parent.deriveMessages().at(-1)).toEqual({ role: 'user', content: 'cut me' })
    expect(child.deriveMessages().at(-1)).toEqual({ role: 'user', content: 'child only' })
    void kernel.stop()
  })

  it('fork without a boundary copies everything', async () => {
    const kernel = boot()
    const parent = kernel.ctx.sessions.create()
    parent.append({ type: 'turn/start', turnId: 'turn-1' as never })
    parent.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'all' })

    const child = await kernel.ctx.sessions.fork(parent)
    expect(child.events).toHaveLength(2)
    void kernel.stop()
  })

  it('get fails loud on an unknown id', () => {
    const kernel = boot()
    expect(() => kernel.ctx.sessions.get('session-nope' as never)).toThrow(/no session/)
    void kernel.stop()
  })

  it('resume: a stored session keeps projecting history for later turns', async () => {
    const kernel = boot()
    const ctx = kernel.ctx
    const first = ctx.sessions.create()
    first.append({ type: 'user/message', turnId: 'turn-1' as never, content: 'earlier' })

    const resumed = ctx.sessions.get(first.id)
    expect(resumed.deriveMessages()).toEqual([{ role: 'user', content: 'earlier' }])
    void kernel.stop()
  })
})
