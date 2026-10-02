/**
 * The final authority gate: a call admitted at preparation is re-checked
 * immediately before its side effect, so authority that narrowed while it
 * waited (an approval, a stale batch) refuses it truthfully.
 */
import { describe, expect, it } from 'vitest'
import { Kernel, ToolsService, type ToolDefinition } from 'dnt-harness'

function boot(): { kernel: Kernel; ran: string[] } {
  const kernel = new Kernel()
  kernel.ctx.plugin(ToolsService)
  const ran: string[] = []
  const tool: ToolDefinition = {
    name: 'Write',
    description: 'write',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args) {
      ran.push(String(args['path']))
      return 'written'
    },
  }
  kernel.ctx.tools.register(tool)
  return { kernel, ran }
}

describe('tool final gate', () => {
  it('a narrowing between preparation and execution refuses the side effect', async () => {
    const { kernel, ran } = boot()
    let narrowed = false
    kernel.ctx.on('tools/final-gate', async (payload) => (narrowed ? `mode no longer exposes '${payload.call.name}'` : undefined))
    const prepared = await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'a.txt' } })
    narrowed = true // e.g. the root switched to Plan while this call awaited approval
    const result = await prepared.execute()
    expect(result.ok).toBe(false)
    expect(result.output).toBe("denied: mode no longer exposes 'Write'")
    expect(ran).toEqual([])
    await kernel.stop()
  })

  it('an unchanged authority lets the call run, and the gate sees its execution id', async () => {
    const { kernel, ran } = boot()
    const seen: (string | undefined)[] = []
    kernel.ctx.on('tools/final-gate', async (payload) => {
      seen.push(payload.exec.executionId)
      return undefined
    })
    const prepared = await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'b.txt' } })
    const result = await prepared.execute()
    expect(result.ok).toBe(true)
    expect(ran).toEqual(['b.txt'])
    expect(seen).toEqual([prepared.executionId])
    await kernel.stop()
  })

  it('a throwing gate fails closed', async () => {
    const { kernel, ran } = boot()
    kernel.ctx.on('tools/final-gate', async () => { throw new Error('policy store unreadable') })
    const result = await (await kernel.ctx.tools.prepare({ id: 'c1', name: 'Write', args: { path: 'c.txt' } })).execute()
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/final authority check failed: policy store unreadable/)
    expect(ran).toEqual([])
    await kernel.stop()
  })
})
