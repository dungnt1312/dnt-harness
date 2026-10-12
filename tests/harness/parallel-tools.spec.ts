/**
 * Read-only tool calls in one batch run concurrently: consecutive concurrent
 * calls form a group, any other call is a barrier, the log keeps every
 * tool/call and tool/result in the model's original order, and a stop still
 * answers every declared call.
 */
import { describe, expect, it } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  type Agent,
  type Session,
  type ToolDefinition,
} from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

interface Probe {
  readonly log: string[]
  active: number
  peak: number
}

/** A tool that records start/end and holds for `ms`. */
function probeTool(name: string, probe: Probe, options: { readOnly: boolean; ms?: number }): ToolDefinition {
  return {
    name,
    description: name,
    readOnly: options.readOnly,
    parameters: { type: 'object', properties: { tag: { type: 'string' } } },
    async execute(args, exec) {
      const tag = String(args['tag'])
      probe.log.push(`start:${tag}`)
      probe.active += 1
      probe.peak = Math.max(probe.peak, probe.active)
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.ms ?? 40)
          exec.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled: stop requested')) }, { once: true })
        })
      } finally {
        probe.active -= 1
        probe.log.push(`end:${tag}`)
      }
      return `out:${tag}`
    },
  }
}

function boot(calls: readonly { name: string; tag: string }[], limits?: Record<string, number>): { kernel: Kernel; session: Session; agent: Agent; probe: Probe } {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  if (limits !== undefined) kernel.ctx.provide('limits', limits)
  kernel.ctx.llm.register(new FakeScriptedLlm([
    { toolCalls: calls.map((call) => ({ name: call.name, args: { tag: call.tag } })) },
    'done',
  ]))
  const probe: Probe = { log: [], active: 0, peak: 0 }
  kernel.ctx.tools.register(probeTool('Look', probe, { readOnly: true }))
  kernel.ctx.tools.register(probeTool('Change', probe, { readOnly: false }))
  const session = kernel.ctx.sessions.create()
  const agent = kernel.ctx.agents.create(session)
  return { kernel, session, agent, probe }
}

function toolEvents(session: Session): string[] {
  return session.events.flatMap((event) => {
    if (event.type === 'tool/call') return [`call:${event.call.id}`]
    if (event.type === 'tool/result') return [`result:${event.callId}`]
    return []
  })
}

describe('parallel read-only tool calls', () => {
  it('runs consecutive read-only calls concurrently and logs in original order', async () => {
    const { kernel, session, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'b' },
      { name: 'Look', tag: 'c' },
    ])
    agent.send('go')
    await agent.run()

    expect(probe.peak).toBe(3)
    expect(probe.log.slice(0, 3)).toEqual(['start:a', 'start:b', 'start:c'])
    expect(toolEvents(session)).toEqual([
      'call:call-1-0', 'call:call-1-1', 'call:call-1-2',
      'result:call-1-0', 'result:call-1-1', 'result:call-1-2',
    ])
    const outputs = session.events.flatMap((event) => event.type === 'tool/result' ? [event.output] : [])
    expect(outputs).toEqual(['out:a', 'out:b', 'out:c'])
    void kernel.stop()
  })

  it('a non-read-only call is a barrier between groups', async () => {
    const { kernel, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'b' },
      { name: 'Change', tag: 'w' },
      { name: 'Look', tag: 'c' },
    ])
    agent.send('go')
    await agent.run()

    const index = (entry: string): number => probe.log.indexOf(entry)
    expect(index('start:w')).toBeGreaterThan(index('end:a'))
    expect(index('start:w')).toBeGreaterThan(index('end:b'))
    expect(index('start:c')).toBeGreaterThan(index('end:w'))
    expect(probe.peak).toBe(2)
    void kernel.stop()
  })

  it('a hook rewrite to a non-read-only tool runs that call alone', async () => {
    const { kernel, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'b' },
    ])
    kernel.ctx.on('tools/rewrite', async ({ call }, next) => call.args['tag'] === 'b'
      ? next({ call: { ...call, name: 'Change' } })
      : next())
    agent.send('go')
    await agent.run()

    expect(probe.peak).toBe(1)
    expect(probe.log).toEqual(['start:a', 'end:a', 'start:b', 'end:b'])
    void kernel.stop()
  })

  it('an approved out-of-grant read runs alone, before the next call is gated', async () => {
    const { kernel, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'out' },
      { name: 'Look', tag: 'c' },
    ])
    const prepared: string[] = []
    kernel.ctx.tools.setApprovedPathResolver(async (call, allowed) => {
      prepared.push(`prepare:${String(call.args['tag'])}`)
      return allowed && call.args['tag'] === 'out' ? [{ path: '/elsewhere', intent: 'read' as const }] : undefined
    })
    kernel.ctx.on('tools/post-execute', async ({ call }, next) => {
      prepared.push(`ran:${String(call.args['tag'])}`)
      return next()
    })
    agent.send('go')
    await agent.run()

    expect(probe.peak).toBe(1)
    expect(prepared).toEqual(['prepare:a', 'prepare:out', 'ran:a', 'ran:out', 'prepare:c', 'ran:c'])
    void kernel.stop()
  })

  it('a denied call inside a group still gets its result and siblings run', async () => {
    const { kernel, session, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'x' },
      { name: 'Look', tag: 'c' },
    ])
    kernel.ctx.on('tools/pre-execute', async ({ call }, next) => call.args['tag'] === 'x'
      ? { kind: 'deny', reason: 'nope' }
      : next())
    agent.send('go')
    await agent.run()

    expect(probe.log.filter((entry) => entry.startsWith('start:'))).toEqual(['start:a', 'start:c'])
    const results = session.events.flatMap((event) => event.type === 'tool/result' ? [`${event.callId}:${event.output}`] : [])
    expect(results).toEqual(['call-1-0:out:a', 'call-1-1:denied: nope', 'call-1-2:out:c'])
    void kernel.stop()
  })

  it('caps concurrency at limits.readOnlyToolConcurrency', async () => {
    const calls = Array.from({ length: 5 }, (_, index) => ({ name: 'Look', tag: String(index) }))
    const { kernel, session, agent, probe } = boot(calls, { readOnlyToolConcurrency: 2 })
    agent.send('go')
    await agent.run()

    expect(probe.peak).toBe(2)
    expect(session.events.filter((event) => event.type === 'tool/result')).toHaveLength(5)
    void kernel.stop()
  })

  it('a stop during a group answers every call and skips later ones', async () => {
    const { kernel, session, agent, probe } = boot([
      { name: 'Look', tag: 'a' },
      { name: 'Look', tag: 'b' },
      { name: 'Change', tag: 'w' },
    ])
    agent.send('go')
    const run = agent.run()
    await new Promise<void>((resolve) => {
      const poll = (): void => { if (probe.active === 2) resolve(); else setTimeout(poll, 2) }
      poll()
    })
    agent.stop()
    await run

    expect(probe.log).not.toContain('start:w')
    const results = session.events.flatMap((event) => event.type === 'tool/result' ? [event] : [])
    expect(results.map((event) => event.callId)).toEqual(['call-1-0', 'call-1-1', 'call-1-2'])
    expect(results.every((event) => !event.ok)).toBe(true)
    // Already prepared behind the group: its gate answers the stop before dispatch.
    expect(results[2]?.output).toContain('stop requested before')
    expect(session.events.findLast((event) => event.type === 'turn/end')).toMatchObject({ reason: 'cancelled' })
    void kernel.stop()
  })
})
