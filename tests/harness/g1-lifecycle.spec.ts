/**
 * G1 lifecycle: stop during tools, queued-input semantics (never injected
 * into the running turn, never auto-executed after stop), execution budgets,
 * the stream-inactivity watchdog, and storage-failure classification.
 */
import { describe, expect, it } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  type Agent,
  type HarnessLimits,
  type LlmProvider,
  type ModelRequest,
  type Session,
  type SessionEvent,
  type StreamEvent,
  type ToolCall,
  type ToolDefinition,
  type ToolExecution,
} from 'mini-dsh'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

interface Harness {
  kernel: Kernel
  session: Session
  agent: Agent
  requests: ModelRequest[]
  llm: LlmService
}

/** Boot the harness with a scripted provider and a controllable tool set. */
function boot(
  steps: readonly (string | { toolCalls?: readonly { name: string; args: Record<string, unknown> }[] })[],
  extra?: Partial<{ limits: Partial<HarnessLimits> }>,
): Harness {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)
  if (extra?.limits !== undefined) kernel.ctx.provide('limits', extra.limits)

  const requests: ModelRequest[] = []
  const mock = new FakeScriptedLlm(steps)
  const recorder: LlmProvider = {
    name: 'recorder',
    stream(request, options) {
      requests.push(request)
      return mock.stream(request, options)
    },
  }
  kernel.ctx.llm.register(recorder)
  const session = kernel.ctx.sessions.create()
  const agent = kernel.ctx.agents.create(session)
  return { kernel, session, agent, requests, llm: kernel.ctx.llm }
}

/** A gate tool that blocks until released (or aborted) — the controllable side effect. */
function gateTool(name: string, hold: Promise<void>): ToolDefinition {
  return {
    name,
    description: 'blocks until the test releases it',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args: Record<string, unknown>, exec: ToolExecution) {
      // The stop can land before the tool even starts: an already-aborted
      // signal never fires its listener, so bail up front.
      if (exec.signal?.aborted === true) return `${name} cancelled before start`
      await Promise.race([
        hold,
        new Promise<string>((resolve) => {
          exec.signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
        }),
      ])
      return `${name} finished`
    },
  }
}

/** A scripted call factory with stable ids. */
function call(id: string, name: string): ToolCall {
  return { id, name, args: {} }
}

describe('stop semantics', () => {
  it('stop during tools kills no further model request and answers skipped calls truthfully', async () => {
    const hold = new Promise<void>(() => {})
    const h = boot([{ toolCalls: [call('c1', 'Gate'), call('c2', 'Gate')] }, 'never reached'])
    h.kernel.ctx.tools.register(gateTool('Gate', hold))

    const runPromise = (async () => {
      h.agent.send('go')
      await h.agent.run()
    })()
    // Wait until the first tool call is recorded, then stop.
    await new Promise<void>((resolve) => {
      h.kernel.ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call') resolve()
      })
    })
    h.agent.stop()
    await runPromise

    const end = h.session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('cancelled')
    // One model request total: no further request after the stop.
    expect(h.requests).toHaveLength(1)
    // The declared batch is fully answered: the running call was cancelled,
    // the never-started one says so explicitly.
    const results = h.session.events.filter((e) => e.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results.some((e) => e.type === 'tool/result' && e.output.includes('stop requested'))).toBe(true)
    void h.kernel.stop()
  })

  it('a provider that never sends data can be stopped', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { streamFirstEventMs: 30_000 })
    kernel.ctx.llm.register({
      name: 'silent',
      // Ignores the abort signal entirely — the loop's own race must win.
      async *stream(): AsyncIterable<StreamEvent> {
        await new Promise(() => {})
        yield { type: 'delta', delta: 'never' }
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)

    const runPromise = (async () => {
      agent.send('hello?')
      await agent.run()
    })()
    await new Promise((resolve) => setTimeout(resolve, 80))
    agent.stop()
    await runPromise

    const end = session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('cancelled')
    expect(session.events.some((e) => e.type === 'assistant/message' && e.content.includes('never'))).toBe(false)
    void kernel.stop()
  }, 5_000)

  it('the inactivity watchdog fails a silent provider as a provider error', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { streamFirstEventMs: 80 })
    kernel.ctx.llm.register({
      name: 'silent',
      async *stream(): AsyncIterable<StreamEvent> {
        await new Promise(() => {})
        yield { type: 'delta', delta: 'never' }
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    agent.send('hello?')
    await agent.run()

    const error = session.events.find((e) => e.type === 'turn/error')
    expect(error?.type === 'turn/error' && error.kind).toBe('provider')
    const end = session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('failed')
    void kernel.stop()
  }, 5_000)

  it('thinking-length silence before the first event survives when it fits the first-event window', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    // The pre-output silence (150ms) exceeds the between-events window but
    // fits the first-event window — the real shape of an extended-thinking
    // turn whose gateway swallows the reasoning deltas.
    kernel.ctx.provide('limits', { streamFirstEventMs: 1_000, streamInactivityMs: 50 })
    kernel.ctx.llm.register({
      name: 'thinking',
      async *stream(): AsyncIterable<StreamEvent> {
        await new Promise((resolve) => setTimeout(resolve, 150))
        yield { type: 'delta', delta: 'thought it through' }
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    agent.send('hello?')
    await agent.run()

    expect(session.events.some((e) => e.type === 'turn/error')).toBe(false)
    const end = session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('completed')
    expect(session.events.some((e) => e.type === 'assistant/message' && e.content.includes('thought it through'))).toBe(true)
    void kernel.stop()
  }, 5_000)

  it('a stall after output started still fails the turn as a provider error', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(AgentsService)
    kernel.ctx.provide('limits', { streamFirstEventMs: 60_000, streamInactivityMs: 80 })
    kernel.ctx.llm.register({
      name: 'stall-after-first',
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: 'delta', delta: 'started' }
        await new Promise(() => {})
      },
    })
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    agent.send('hello?')
    await agent.run()

    const error = session.events.find((e) => e.type === 'turn/error')
    expect(error?.type === 'turn/error' && error.kind).toBe('provider')
    const end = session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('failed')
    void kernel.stop()
  }, 5_000)
})

describe('input queue', () => {
  it('input accepted while running queues for a later turn and is never injected mid-turn', async () => {
    const release = new Promise<void>((resolve) => {
      setTimeout(resolve, 30)
    })
    const h = boot([{ toolCalls: [call('c1', 'Gate')] }, 'first turn done', 'second turn done'])
    h.kernel.ctx.tools.register(gateTool('Gate', release))

    h.agent.send('first')
    const runPromise = h.agent.run()
    // While the turn is in flight, accept a second input the way hosts do:
    // a durable record (already written in prod) plus an inbox adoption.
    await new Promise<void>((resolve) => {
      h.kernel.ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call') resolve()
      })
    })
    h.agent.enqueueAccepted({ content: 'second', inputId: 'input-second' as never })
    await runPromise

    // The active turn's requests never saw the queued input.
    expect(h.requests[0]?.messages.map((m) => m.content)).not.toContain('second')
    expect(h.requests[1]?.messages.map((m) => m.content)).not.toContain('second')
    // It landed as its own subsequent turn.
    const turns = h.session.events.filter((e) => e.type === 'turn/start')
    expect(turns).toHaveLength(2)
    const userMessages = h.session.events.filter((e) => e.type === 'user/message')
    expect(userMessages.map((e) => (e.type === 'user/message' ? e.content : ''))).toEqual(['first', 'second'])
    void h.kernel.stop()
  })

  it('queued input is not auto-executed after a stop; the next user-triggered run claims it', async () => {
    const hold = new Promise<void>(() => {})
    const h = boot([{ toolCalls: [call('c1', 'Gate')] }, 'first turn done', 'second turn done'])
    h.kernel.ctx.tools.register(gateTool('Gate', hold))

    const runPromise = (async () => {
      h.agent.send('first')
      await h.agent.run()
    })()
    await new Promise<void>((resolve) => {
      h.kernel.ctx.on('session/event', (_session, event) => {
        if (event.type === 'tool/call') resolve()
      })
    })
    h.agent.enqueueAccepted({ content: 'second', inputId: 'input-second' as never })
    h.agent.stop()
    await runPromise

    // One turn only — the stop ended the run without consuming the queue.
    expect(h.session.events.filter((e) => e.type === 'turn/start')).toHaveLength(1)
    expect(h.agent.pendingCount).toBe(1)
    expect(h.requests).toHaveLength(1)

    // A new user-triggered run claims the pending input.
    h.agent.send('third')
    await h.agent.run()
    const userMessages = h.session.events.filter((e) => e.type === 'user/message')
    expect(userMessages.map((e) => (e.type === 'user/message' ? e.content : ''))).toEqual(['first', 'second', 'third'])
    expect(h.requests.at(-1)?.messages.map((m) => m.content)).toContain('second')
    void h.kernel.stop()
  })
})

describe('turn invariants', () => {
  it('a second agent for the same session is the same driver — turns never interleave', async () => {
    const h = boot(['first reply', 'second reply'])
    const twin = h.kernel.ctx.agents.create(h.session)
    expect(twin).toBe(h.agent)

    h.agent.send('one')
    const first = h.agent.run()
    twin.send('two')
    await first
    await twin.run()

    // Sequential turns, never interleaved starts.
    const starts = h.session.events.filter((e) => e.type === 'turn/start')
    expect(starts).toHaveLength(2)
    let open = 0
    for (const event of h.session.events) {
      if (event.type === 'turn/start') open += 1
      if (event.type === 'turn/end') open -= 1
      expect(open).toBeLessThanOrEqual(1)
    }
    void h.kernel.stop()
  })

  it('late events cannot revive a terminal turn', async () => {
    const h = boot(['done'])
    h.agent.send('hi')
    await h.agent.run()

    const open = (): number => {
      let count = 0
      for (const event of h.session.events) {
        if (event.type === 'turn/start') count += 1
        if (event.type === 'turn/end') count -= 1
      }
      return count
    }
    expect(open()).toBe(0)
    // A straggler event for a closed turn arrives (simulated): the pairing
    // stays terminal — nothing reopens it.
    h.session.append({ type: 'assistant/chunk', stepId: 'step-ghost' as never, delta: 'late' })
    expect(open()).toBe(0)
    void h.kernel.stop()
  })

  it('a model change applies to the next request in the SAME turn without interruption', async () => {
    const h = boot([{ toolCalls: [{ name: 'Glob', args: { pattern: '*' } }] }, 'second step reply'])
    h.kernel.ctx.tools.register({
      name: 'Glob',
      description: 'noop',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        return 'no matches'
      },
    })
    // The live control: after the first request completes, the selection
    // changes; the second request of the SAME turn must carry it.
    let flips = 0
    h.kernel.ctx.on('agent/request', async (request, next) => {
      flips += 1
      return next({ ...request, model: flips === 1 ? 'model-a' : 'model-b' })
    })

    h.agent.send('go')
    await h.agent.run()

    expect(h.requests).toHaveLength(2)
    expect(h.requests[0]?.model).toBe('model-a')
    expect(h.requests[1]?.model).toBe('model-b')
    // One turn, two steps, no replay: the first step's answer stayed.
    expect(h.session.events.filter((e) => e.type === 'turn/start')).toHaveLength(1)
    const answers = h.session.events.filter((e) => e.type === 'assistant/message')
    expect(answers[0]?.type === 'assistant/message' && answers[0].controls?.model).toBe('model-a')
    expect(answers[1]?.type === 'assistant/message' && answers[1].controls?.model).toBe('model-b')
    void h.kernel.stop()
  })
})

describe('unbounded turns', () => {
  it('legacy step and deadline overrides no longer cut off a turn', async () => {
    const toolStep = { toolCalls: [call('c', 'Glob')] }
    const h = boot([toolStep, toolStep, toolStep, toolStep, 'done'], {
      limits: { maxSteps: 2, turnDeadlineMs: 1 },
    })
    h.kernel.ctx.tools.register({
      name: 'Glob',
      description: 'slow noop',
      parameters: { type: 'object', properties: {}, required: [] },
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return 'no matches'
      },
    })

    h.agent.send('keep going until done')
    await h.agent.run()

    expect(h.session.events.filter((e) => e.type === 'step/start')).toHaveLength(5)
    expect(h.session.events.some((e) => e.type === 'turn/error' && e.kind === 'limit')).toBe(false)
    const end = h.session.events.findLast((e) => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.reason).toBe('completed')
    void h.kernel.stop()
  })

  it('recorded controls say which model and provider served each step', async () => {
    const h = boot(['plain answer'])
    h.kernel.ctx.on('agent/request', async (request, next) => {
      return next({ ...request, model: 'scripted-v2' })
    })

    h.agent.send('who are you')
    await h.agent.run()

    const message = h.session.events.find((e) => e.type === 'assistant/message')
    expect(message?.type === 'assistant/message' && message.controls).toEqual({ model: 'scripted-v2', provider: 'recorder' })
    void h.kernel.stop()
  })
})

describe('storage failure', () => {
  it('runs halting on storage failure never report the turn completed', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const boom = new Error('disk vanished')
    // A sessions service whose durable path fails after three appends —
    // exactly the mid-turn barrier failure shape.
    const appended: SessionEvent[] = []
    const store = {
      append: (id: unknown, event: SessionEvent): Promise<void> => {
        appended.push(event)
        return appended.length > 3 ? Promise.reject(boom) : Promise.resolve()
      },
      flush: () => Promise.resolve(),
      read: () => Promise.resolve({ events: [] as SessionEvent[], truncatedTail: false }),
      replace: () => Promise.resolve(),
      writeSummary: () => Promise.resolve(),
      readSummary: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
    }
    kernel.ctx.plugin((ctx) => {
      new SessionsService(ctx, 'sessions', { store: store as never })
    })
    kernel.ctx.llm.register(new FakeScriptedLlm(['a reply']))
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)
    agent.send('hello')
    await agent.run()

    // The session is poisoned: nothing after the failed barrier can be
    // claimed durable, so no turn/error or turn/end lands on disk — the
    // open turn becomes `interrupted` at the next recovery, and the run
    // never reported completion.
    expect(session.poisoned).toBe(true)
    expect(session.events.some((e) => e.type === 'turn/end' && e.reason === 'completed')).toBe(false)
    expect(session.events.some((e) => e.type === 'turn/end')).toBe(false)
    void kernel.stop()
  })
})

describe('turn settlement', () => {
  it('agent/turn-settled fires exactly once for a completed turn', async () => {
    const h = boot(['reply'])
    let count = 0
    h.kernel.ctx.on('agent/turn-settled', async () => {
      count += 1
    })
    h.agent.send('go')
    await h.agent.run()
    expect(count).toBe(1)
    void h.kernel.stop()
  })

  it('agent/turn-settled fires exactly once after an extended tool loop', async () => {
    const toolStep = { toolCalls: [call('c', 'Glob')] }
    const h = boot([toolStep, toolStep, toolStep, 'done'], { limits: { maxSteps: 1, turnDeadlineMs: 1 } })
    h.kernel.ctx.tools.register({
      name: 'Glob', description: 'n', parameters: { type: 'object', properties: {}, required: [] },
      async execute() { return 'none' },
    })
    let count = 0
    let reason = ''
    h.kernel.ctx.on('agent/turn-settled', async (state) => {
      count += 1
      reason = state.reason
    })
    h.agent.send('loop')
    await h.agent.run()
    expect(count).toBe(1)
    expect(reason).toBe('completed')
    void h.kernel.stop()
  })
})
