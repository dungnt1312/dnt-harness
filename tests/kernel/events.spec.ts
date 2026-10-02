/**
 * Cordis tutorial chapter 4 — Events, reproduced on the dnt-harness kernel:
 * typed events through declaration merging, the dispatch-mode contracts, and
 * the waterfall transform/veto walkthrough verbatim from the tutorial.
 */
import { describe, expect, it } from 'vitest'
import { Kernel, Service, type Context } from 'dnt-harness'

declare module 'dnt-harness' {
  interface Events {
    'stats/report'(name: string, count: number): void
    'demo/transform'(input: string, next: (replacement?: string) => Promise<string>): Promise<string>
  }
}

class StatsService extends Service {
  private counts = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'stats')
  }

  bump(name: string): void {
    const next = (this.counts.get(name) ?? 0) + 1
    this.counts.set(name, next)
    this.ctx.emit('stats/report', name, next)
  }
}

describe('events (tutorial ch.4)', () => {
  it('declares, emits, and listens with typed payloads', () => {
    const kernel = new Kernel()
    const stats = new StatsService(kernel.ctx)

    const lines: string[] = []
    kernel.ctx.on('stats/report', (name, count) => {
      lines.push(`[stats] ${name} -> ${count}`)
    })

    stats.bump('tool_call')
    stats.bump('tool_call')
    stats.bump('prompt')

    expect(lines).toEqual([
      '[stats] tool_call -> 1',
      '[stats] tool_call -> 2',
      '[stats] prompt -> 1',
    ])
    void kernel.stop()
  })

  it('waterfall: transforms wrap downstream results', async () => {
    const kernel = new Kernel()

    kernel.ctx.on('demo/transform', async (_input, next) => {
      const downstream = await next()
      return downstream.toUpperCase()
    })

    const result = await kernel.ctx.waterfall('demo/transform', 'hello', async () => 'hello')
    expect(result).toBe('HELLO')
    await kernel.stop()
  })

  it('waterfall: veto short-circuits the chain and the default', async () => {
    const kernel = new Kernel()
    let defaultRuns = 0

    // Listener 1: wrap the downstream result.
    kernel.ctx.on('demo/transform', async (_input, next) => {
      const downstream = await next()
      return downstream.toUpperCase()
    })

    // Listener 2: veto when it owns the decision.
    kernel.ctx.on('demo/transform', async (input, next) => {
      if (input.includes('blocked')) return '** blocked **'
      return next()
    })

    // Nothing vetoes 'hello': the default runs, listener 1 uppercases it.
    const pass = await kernel.ctx.waterfall('demo/transform', 'hello', async () => {
      defaultRuns++
      return 'hello'
    })
    expect(pass).toBe('HELLO')
    expect(defaultRuns).toBe(1)

    // Listener 2 vetoes 'blocked words': the default never runs, and
    // listener 1 uppercases the replacement on the way out.
    const vetoed = await kernel.ctx.waterfall('demo/transform', 'blocked words', async () => {
      defaultRuns++
      return 'blocked words'
    })
    expect(vetoed).toBe('** BLOCKED **')
    expect(defaultRuns).toBe(1)
    await kernel.stop()
  })

  it('waterfall: forwarding arguments through next() replaces them downstream', async () => {
    const kernel = new Kernel()

    kernel.ctx.on('demo/transform', async (_input, next) => {
      return next('replaced')
    })

    const result = await kernel.ctx.waterfall('demo/transform', 'original', async (input) => `default:${input}`)
    expect(result).toBe('default:replaced')
    await kernel.stop()
  })

  it('waterfall: no listeners runs the default directly', async () => {
    const kernel = new Kernel()
    const result = await kernel.ctx.waterfall('demo/transform', 'hello', async () => 'fallback')
    expect(result).toBe('fallback')
    await kernel.stop()
  })

  it('listeners registered by a fiber disappear with it', async () => {
    const kernel = new Kernel()
    const lines: string[] = []

    const stats = new StatsService(kernel.ctx)
    const fiber = kernel.ctx.plugin((ctx: Context) => {
      ctx.on('stats/report', (name, count) => {
        lines.push(`[stats] ${name} -> ${count}`)
      })
    })

    stats.bump('tool_call')
    await fiber.dispose()
    stats.bump('tool_call')

    expect(lines).toEqual(['[stats] tool_call -> 1'])
    await kernel.stop()
  })
})
