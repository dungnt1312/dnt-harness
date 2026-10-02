/**
 * The turn/step driver: inbox claim semantics, durable event ordering, the
 * agent/pre-step and agent/request waterfalls, turn-stopping observation,
 * fork/resume mid-conversation, and the model-visible-means-logged
 * invariant.
 */
import { describe, expect, it } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  messageText,
  ProviderError,
  SessionsService,
  ToolsService,
  type Agent,
  type LlmProvider,
  type ModelRequest,
  type Session,
} from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

interface Harness {
  kernel: Kernel
  session: Session
  agent: Agent
  llm: LlmService
}

/** Boot the full harness with a scripted provider and one agent. */
function harness(replies: readonly string[], provider?: LlmProvider): Harness {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(AgentsService)
  kernel.ctx.llm.register(provider ?? new FakeScriptedLlm(replies))

  const session = kernel.ctx.sessions.create()
  const agent = kernel.ctx.agents.create(session)
  return { kernel, session, agent, llm: kernel.ctx.llm }
}

describe('agent loop', () => {
  it('one turn produces the durable event order turn→step→chunks→message→turn/end', async () => {
    const { kernel, session, agent } = harness(['Hi there'])

    agent.send('hello')
    await agent.run()

    expect(session.events.map((event) => event.type)).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/chunk',
      'assistant/chunk',
      'assistant/message',
      'step/end',
      'turn/end',
    ])
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('completed')
    expect(session.deriveMessages()).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there' },
    ])
    void kernel.stop()
  })

  it('multi-turn conversation carries projected history', async () => {
    const { kernel, session, agent } = harness(['first reply', 'second reply'])

    agent.send('one')
    await agent.run()
    agent.send('two')
    await agent.run()

    expect(session.deriveMessages()).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'two' },
      { role: 'assistant', content: 'second reply' },
    ])
    void kernel.stop()
  })

  it('messages queued before run are claimed into one turn', async () => {
    const { kernel, session, agent } = harness(['batched'])

    agent.send('first')
    agent.send('second')
    await agent.run()

    const turns = session.events.filter((event) => event.type === 'turn/start')
    const messages = session.events.filter((event) => event.type === 'user/message')
    expect(turns).toHaveLength(1)
    expect(messages.map((event) => event.type === 'user/message' && event.content)).toEqual(['first', 'second'])
    void kernel.stop()
  })

  it('injected context waits in the inbox until a user message wakes the driver', async () => {
    const { kernel, session, agent, llm } = harness(['ok'])
    const seen: ModelRequest[] = []
    llm.register({
      name: 'recorder',
      async *stream(request) {
        seen.push(request)
        yield { type: 'delta', delta: 'ok' }
      },
    })
    llm.use('recorder')

    agent.inject('workspace note: the build is green')
    await agent.run()
    expect(seen).toHaveLength(0)

    agent.send('go')
    await agent.run()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.messages.map((message) => message.content)).toEqual([
      'workspace note: the build is green',
      'go',
    ])
    void kernel.stop()
  })

  it('a pre-step veto closes a durable turn with no step and no model call', async () => {
    const { kernel, session, agent, llm } = harness(['should not stream'])
    let modelCalls = 0
    llm.register({
      name: 'counter',
      async *stream() {
        modelCalls++
        yield { type: 'delta', delta: 'x' }
      },
    })
    llm.use('counter')

    kernel.ctx.on('agent/pre-step', async (_claim) => {
      return { kind: 'reject', reason: 'policy' }
    })

    agent.send('forbidden')
    await agent.run()

    expect(modelCalls).toBe(0)
    expect(session.events.map((event) => event.type)).toEqual(['turn/start', 'turn/error', 'turn/end'])
    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({
      type: 'turn/error',
      kind: 'rejected',
      message: 'policy',
    })
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('rejected')
    void kernel.stop()
  })

  it('a model stream that yields nothing fails the turn durably instead of completing silently', async () => {
    const { kernel, session, agent, llm } = harness(['unused'])
    llm.register({
      name: 'silent',
      async *stream() {
        // A gateway that accepts the request and closes the stream cleanly:
        // zero deltas, zero tool calls.
      },
    })
    llm.use('silent')

    agent.send('hello')
    await agent.run()

    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({
      type: 'turn/error',
      kind: 'provider',
    })
    expect(
      session.events.find((event) => event.type === 'turn/error')?.type === 'turn/error'
        && session.events.find((event) => event.type === 'turn/error')?.message,
    ).toMatch(/empty response/)
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('failed')
    void kernel.stop()
  })

  it('a thinking-only stream with no answer fails the turn as a provider error', async () => {
    const { kernel, session, agent, llm } = harness(['unused'])
    llm.register({
      name: 'reasoner',
      async *stream() {
        yield { type: 'delta', delta: 'thinking hard', thinking: true }
      },
    })
    llm.use('reasoner')

    agent.send('hello')
    await agent.run()

    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({
      type: 'turn/error',
      kind: 'provider',
    })
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('failed')
    void kernel.stop()
  })

  it('provider-surfaced failures are recorded as kind provider, not internal', async () => {
    const { kernel, session, agent, llm } = harness(['unused'])
    llm.register({
      name: 'relay',
      async *stream() {
        throw new ProviderError('relay: HTTP 502: upstream unavailable')
      },
    })
    llm.use('relay')

    agent.send('hello')
    await agent.run()

    expect(session.events.find((event) => event.type === 'turn/error')).toMatchObject({
      type: 'turn/error',
      kind: 'provider',
      message: 'relay: HTTP 502: upstream unavailable',
    })
    void kernel.stop()
  })

  it('a tool abort that loses the stop race still closes the turn as cancelled', async () => {
    const kernel = new Kernel()
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    const session = kernel.ctx.sessions.create()
    const agent = kernel.ctx.agents.create(session)

    let toolStarted = false
    kernel.ctx.tools.register({
      name: 'Hang',
      description: 'waits for abort, then rejects like a killed child process',
      parameters: { type: 'object', properties: {}, required: [] },
      execute: (_args, exec) =>
        new Promise((_resolve, reject) => {
          toolStarted = true
          exec.signal?.addEventListener('abort', () => reject(new Error('This operation was aborted')))
        }),
    })

    const scripted: LlmProvider = {
      name: 'scripted',
      models: ['scripted'],
      async *stream() {
        yield { type: 'toolCalls', calls: [{ id: 'c1', name: 'Hang', args: {} }] }
      },
    }
    kernel.ctx.llm.register(scripted)

    agent.send('go')
    const running = agent.run()
    while (!toolStarted) await new Promise((resolve) => setTimeout(resolve, 1))
    agent.stop()
    await running

    expect(session.events.some((event) => event.type === 'turn/error')).toBe(false)
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('cancelled')
    void kernel.stop()
  })

  describe('steer and stop', () => {
    /** A provider that answers `first` only after `release()`, then `second` immediately. */
    function gatedHarness() {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let calls = 0
      let started!: () => void
      const firstStarted = new Promise<void>((resolve) => { started = resolve })
      const provider: LlmProvider = {
        name: 'gated',
        models: ['gated'],
        async *stream(_request, options) {
          calls += 1
          if (calls === 1) {
            started()
            // Hang until released or aborted, like a slow model.
            await new Promise<void>((resolve, reject) => {
              void gate.then(resolve)
              options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            })
            yield { type: 'delta', delta: 'first' }
            return
          }
          yield { type: 'delta', delta: `reply ${calls}` }
        },
      }
      const h = harness([], provider)
      return { ...h, release, firstStarted, calls: () => calls }
    }
    const accept = (agent: Agent, session: Session, content: string): void => {
      const inputId = `in-${content}` as never
      session.append({ type: 'input/queued', inputId, content })
      agent.enqueueAccepted({ content, inputId })
    }
    const turnEnds = (session: Session): string[] =>
      session.events.flatMap((event) => event.type === 'turn/end' ? [event.reason] : [])
    const userTexts = (session: Session): string[] =>
      session.events.flatMap((event) => event.type === 'user/message' ? [event.content] : [])

    it('steer stops the running turn as steered and runs old + new queue in one turn, in order', async () => {
      const { kernel, session, agent, firstStarted } = gatedHarness()
      accept(agent, session, 'one')
      const run = agent.run()
      await firstStarted
      accept(agent, session, 'queued-before')
      accept(agent, session, 'steered')
      agent.steer()
      await run

      expect(turnEnds(session)).toEqual(['steered', 'completed'])
      expect(userTexts(session)).toEqual(['one', 'queued-before', 'steered'])
      // Both follow-ups were claimed by the same, second turn.
      const second = session.events.filter((event) => event.type === 'turn/start')[1]
      const inSecond = session.events.filter((event) => event.type === 'user/message' && second?.type === 'turn/start' && event.turnId === second.turnId)
      expect(inSecond).toHaveLength(2)
      expect(agent.busy).toBe(false)
      void kernel.stop()
    })

    it('a plain stop leaves input queued after it unrun (fix B) — only steer runs it', async () => {
      const { kernel, session, agent, firstStarted } = gatedHarness()
      accept(agent, session, 'one')
      const run = agent.run()
      await firstStarted
      agent.stop()
      // Sent while the stop is still settling: it stays queued.
      accept(agent, session, 'after-stop')
      await run

      expect(turnEnds(session)).toEqual(['cancelled'])
      expect(userTexts(session)).toEqual(['one'])
      expect(agent.pendingCount).toBe(1)
      void kernel.stop()
    })

    it('steer upgrades a stop already in progress', async () => {
      const { kernel, session, agent, firstStarted } = gatedHarness()
      accept(agent, session, 'one')
      const run = agent.run()
      await firstStarted
      agent.stop()
      accept(agent, session, 'steered')
      agent.steer()
      await run

      expect(turnEnds(session)).toEqual(['steered', 'completed'])
      expect(userTexts(session)).toEqual(['one', 'steered'])
      void kernel.stop()
    })

    it('a Stop after a Steer wins: the queue stays queued', async () => {
      const { kernel, session, agent, firstStarted } = gatedHarness()
      accept(agent, session, 'one')
      const run = agent.run()
      await firstStarted
      accept(agent, session, 'steered')
      agent.steer()
      agent.stop()
      await run

      expect(turnEnds(session)).toEqual(['cancelled'])
      expect(userTexts(session)).toEqual(['one'])
      expect(agent.pendingCount).toBe(1)
      void kernel.stop()
    })

    it('a steer during pre-step hands the claimed input back instead of cancelling it unanswered', async () => {
      const { kernel, session, agent } = harness(['answer'])
      let releasePreStep!: () => void
      const preStepGate = new Promise<void>((resolve) => { releasePreStep = resolve })
      let entered!: () => void
      const inPreStep = new Promise<void>((resolve) => { entered = resolve })
      let gated = true
      kernel.ctx.on('agent/pre-step', async (_claim, next) => {
        if (gated) {
          gated = false
          entered()
          await preStepGate
        }
        return next()
      })
      accept(agent, session, 'A')
      const run = agent.run()
      await inPreStep
      accept(agent, session, 'B')
      agent.steer()
      releasePreStep()
      await run

      expect(turnEnds(session)).toEqual(['steered', 'completed'])
      // The steered turn logged nothing for A: no user/message, no step.
      const steeredEnd = session.events.findIndex((event) => event.type === 'turn/end')
      const steeredTurn = session.events.slice(0, steeredEnd)
      expect(steeredTurn.some((event) => event.type === 'user/message' || event.type === 'step/start')).toBe(false)
      // A runs, answered, together with B in the completed turn.
      const answered = session.events.slice(steeredEnd + 1)
      expect(answered.flatMap((event) => event.type === 'user/message' ? [event.content] : [])).toEqual(['A', 'B'])
      expect(session.events.filter((event) => event.type === 'input/settled' && event.inputId === 'in-A')).toHaveLength(1)
      void kernel.stop()
    })

    it('adoptPending restores log order when a handed-back input sits behind newer input', async () => {
      const { kernel, session, agent } = harness(['batched'])
      // Inbox already holds C; the log says B (older) and C are pending.
      accept(agent, session, 'C')
      agent.adoptPending([
        { content: 'B', inputId: 'in-B' as never },
        { content: 'C', inputId: 'in-C' as never },
      ])
      await agent.run()
      expect(userTexts(session)).toEqual(['B', 'C'])
      void kernel.stop()
    })

    it('steer while idle is a no-op: nothing stops, nothing auto-runs', async () => {
      const { kernel, session, agent } = harness(['unused'])
      accept(agent, session, 'waiting')
      agent.steer()
      await Promise.resolve()

      expect(session.events.some((event) => event.type === 'turn/start')).toBe(false)
      expect(agent.busy).toBe(false)
      void kernel.stop()
    })

    it('a stop between turns does not open the next turn on an aborted controller', async () => {
      const { kernel, session, agent } = harness(['a', 'b'])
      // Stop from inside the first turn's settle hook: the turn already
      // completed, the queued input must not open a turn that dies unanswered.
      let stopped = false
      kernel.ctx.on('agent/turn-settled', async () => {
        if (stopped) return
        stopped = true
        accept(agent, session, 'next')
        agent.stop()
      })
      agent.send('first')
      await agent.run()

      expect(turnEnds(session)).toEqual(['completed'])
      expect(userTexts(session)).toEqual(['first'])
      expect(agent.pendingCount).toBe(1)
      void kernel.stop()
    })
  })

  it('a pre-step rewrite to empty closes the turn without spending a step', async () => {
    const { kernel, session, agent } = harness(['unused'])

    kernel.ctx.on('agent/pre-step', async (_claim, next) => {
      return next({ contents: [] })
    })

    agent.send('will be emptied')
    await agent.run()

    expect(session.events.map((event) => event.type)).toEqual(['turn/start', 'turn/end'])
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('empty')
    void kernel.stop()
  })

  it('pre-step insertion preserves accepted input identity and attachments on the original content', async () => {
    const { kernel, session, agent } = harness(['ok'])
    const attachment = { id: 'a'.repeat(64), name: 'note.txt', mediaType: 'text/plain', bytes: 4 } as const
    kernel.ctx.on('agent/pre-step', async (claim, next) => next({ contents: ['injected context', ...claim.contents] }))

    agent.enqueueAccepted({ content: 'original', inputId: 'input-original' as never, attachments: [attachment] })
    await agent.run()

    const messages = session.events.filter((event) => event.type === 'user/message')
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'user/message', content: 'injected context' })
    expect(messages[0]?.type === 'user/message' && messages[0].inputId).toBeUndefined()
    expect(messages[1]).toMatchObject({ type: 'user/message', content: 'original', inputId: 'input-original', attachments: [attachment] })
    void kernel.stop()
  })

  it('an inserted duplicate string does not steal accepted input metadata', async () => {
    const { kernel, session, agent } = harness(['ok'])
    kernel.ctx.on('agent/pre-step', async (claim, next) => next({ contents: [claim.contents[0] ?? '', ...claim.contents] }))

    agent.enqueueAccepted({ content: 'same', inputId: 'input-same' as never })
    await agent.run()

    const messages = session.events.filter((event) => event.type === 'user/message')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.type === 'user/message' && messages[0].inputId).toBeUndefined()
    expect(messages[1]).toMatchObject({ type: 'user/message', content: 'same', inputId: 'input-same' })
    void kernel.stop()
  })

  it('a rejected accepted input is durably settled and is not pending again', async () => {
    const { kernel, session, agent } = harness(['unused'])
    session.append({ type: 'input/queued', inputId: 'input-rejected', content: 'blocked' })
    await session.durable()
    agent.enqueueAccepted({ content: 'blocked', inputId: 'input-rejected' as never })
    kernel.ctx.on('agent/pre-step', async () => ({ kind: 'reject', reason: 'policy' }))

    await agent.run()

    expect(kernel.ctx.sessions.pendingInputs(session)).toEqual([])
    expect(session.events.some((event) => event.type === 'input/settled' && event.outcome === 'rejected')).toBe(true)
    void kernel.stop()
  })

  it('agent/request listeners can rewrite the request the model receives', async () => {
    const { kernel, agent, llm } = harness(['fine'])
    const seen: string[] = []
    llm.register({
      name: 'spy',
      async *stream(request) {
        for (const message of request.messages) seen.push(messageText(message.content))
        yield { type: 'delta', delta: 'fine' }
      },
    })
    llm.use('spy')

    kernel.ctx.on('agent/request', async (request, next) => {
      return next({
        ...request,
        messages: [{ role: 'system', content: 'be terse' }, ...request.messages],
      })
    })

    agent.send('hello')
    await agent.run()

    expect(seen).toEqual(['be terse', 'hello'])
    void kernel.stop()
  })

  it('turn-stopping listeners observe before turn/end is appended', async () => {
    const { kernel, session, agent } = harness(['reply'])
    const trace: string[] = []

    kernel.ctx.on('agent/turn-stopping', async () => {
      const types = session.events.map((event) => event.type)
      trace.push(types.includes('step/end') ? 'saw step/end' : 'missing step/end')
      trace.push(types.includes('turn/end') ? 'saw turn/end (wrong)' : 'no turn/end yet')
    })

    agent.send('hi')
    await agent.run()

    expect(trace).toEqual(['saw step/end', 'no turn/end yet'])
    void kernel.stop()
  })

  it('invariant: every model request equals the log projection at that moment', async () => {
    const { kernel, session, agent, llm } = harness(['a', 'b'])
    const projections: string[][] = []
    llm.register({
      name: 'auditor',
      async *stream(request) {
        projections.push(request.messages.map((message) => messageText(message.content)))
        yield { type: 'delta', delta: 'audited' }
      },
    })
    llm.use('auditor')

    agent.send('one')
    await agent.run()
    agent.send('two')
    await agent.run()

    // Each request must be reconstructable from the log as it stood then.
    expect(projections).toEqual([['one'], ['one', 'audited', 'two']])
    expect(session.deriveMessages().map((message) => message.content)).toEqual(['one', 'audited', 'two', 'audited'])
    void kernel.stop()
  })

  it('fork mid-conversation resumes from the copied history', async () => {
    const { kernel, session, agent, llm } = harness(['first reply', 'fork reply', 'parent reply'])
    llm.use('scripted')

    agent.send('one')
    await agent.run()

    const boundary = session.events[session.events.length - 1]?.seq
    const child = await kernel.ctx.sessions.fork(session, boundary)

    const childAgent = kernel.ctx.agents.create(child)
    childAgent.send('from the fork')
    await childAgent.run()

    agent.send('from the parent')
    await agent.run()

    expect(child.deriveMessages()).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'from the fork' },
      { role: 'assistant', content: 'fork reply' },
    ])
    expect(session.deriveMessages()).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'from the parent' },
      { role: 'assistant', content: 'parent reply' },
    ])
    void kernel.stop()
  })

  it('run() while running is a no-op guard; status returns to idle', async () => {
    const { kernel, agent } = harness(['done'])
    agent.send('x')
    await agent.run()
    expect(agent.status).toBe('idle')
    void kernel.stop()
  })
})
