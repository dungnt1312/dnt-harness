/**
 * The agent loop with tools: durable event ordering for the tool round-trip,
 * the projection of tool traffic into model history, unbounded tool
 * continuation, and the logged-context invariant once tools join the loop.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AgentsService,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  bashTool,
  deriveMessages,
  fsTools,
  type Agent,
  type LlmProvider,
  type ModelRequest,
  type Session,
} from 'dnt-harness'
import { FakeScriptedLlm } from '../support/fake-llm.ts'

let root = ''

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-agent-tools-'))
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

/** Boot the full harness with fs tools rooted at the temp workspace. */
function bootHarness(steps: readonly (string | { toolCalls: readonly { name: string; args: Record<string, unknown> }[] })[]): {
  kernel: Kernel
  session: Session
  agent: Agent
  llm: LlmService
  requests: ModelRequest[]
} {
  const kernel = new Kernel()
  kernel.ctx.plugin(SessionsService)
  kernel.ctx.plugin(LlmService)
  kernel.ctx.plugin(ToolsService)
  kernel.ctx.plugin(AgentsService)

  const requests: ModelRequest[] = []
  const mock = new FakeScriptedLlm(steps)
  // The recorder wraps the mock so behavior (tool calls, scripted replies)
  // stays deterministic while every request is captured.
  const recorder: LlmProvider = {
    name: 'recorder',
    stream(request) {
      requests.push(request)
      return mock.stream(request)
    },
  }
  kernel.ctx.llm.register(recorder)

  for (const tool of fsTools()) {
    kernel.ctx.tools.register(tool)
  }
  kernel.ctx.tools.register(bashTool())
  kernel.ctx.tools.setRootResolver(() => ({ root }))

  const session = kernel.ctx.sessions.create()
  const agent = kernel.ctx.agents.create(session)
  return { kernel, session, agent, llm: kernel.ctx.llm, requests }
}

describe('agent loop with tools', () => {
  it('a tool round-trip spends two steps and logs call plus result durably', async () => {
    await fs.writeFile(path.join(root, 'fact.txt'), 'the sky is blue', 'utf8')
    const { kernel, session, agent } = bootHarness([
      { toolCalls: [{ name: 'read', args: { path: 'fact.txt' } }] },
      'the file says the sky is blue',
    ])

    agent.send('what does fact.txt say?')
    await agent.run()

    // Structure with the streaming chunks collapsed: the reply text length
    // is asserted separately so word-splitting stays an implementation
    // detail of the mock provider.
    const structure = session.events
      .filter((event) => event.type !== 'assistant/chunk')
      .map((event) => event.type)
    expect(structure).toEqual([
      'turn/start',
      'step/start',
      'user/message',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'step/end',
      'turn/end',
    ])

    const toolCall = session.events.find((event) => event.type === 'tool/call')
    const toolResult = session.events.find((event) => event.type === 'tool/result')
    expect(toolCall?.type === 'tool/call' && toolCall.executionId).toMatch(/^exec-/)
    expect(toolResult?.type === 'tool/result' && toolResult.executionId).toBe(
      toolCall?.type === 'tool/call' ? toolCall.executionId : undefined,
    )
    expect(toolResult?.type === 'tool/result' && toolResult.ok).toBe(true)
    expect(toolResult?.type === 'tool/result' && toolResult.output).toBe('1\tthe sky is blue')

    const chunks = session.events.filter((event) => event.type === 'assistant/chunk')
    const assembled = chunks.map((event) => (event.type === 'assistant/chunk' ? event.delta : '')).join('')
    expect(assembled).toBe('the file says the sky is blue')
    void kernel.stop()
  })

  it('deriveMessages projects the assistant toolCalls and the tool result answer', async () => {
    await fs.writeFile(path.join(root, 'fact.txt'), 'pi is 3.14', 'utf8')
    const { kernel, session, agent } = bootHarness([
      { toolCalls: [{ name: 'read', args: { path: 'fact.txt' } }] },
      'done',
    ])

    agent.send('read it')
    await agent.run()

    const messages = session.deriveMessages()
    expect(messages).toEqual([
      { role: 'user', content: 'read it' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1-0', name: 'Read', args: { path: 'fact.txt' } }],
      },
      { role: 'tool', content: '1\tpi is 3.14', toolCallId: 'call-1-0' },
      { role: 'assistant', content: 'done' },
    ])
    void kernel.stop()
  })

  it('the follow-up request carries the tool schemas and the tool result', async () => {
    await fs.writeFile(path.join(root, 'fact.txt'), 'x', 'utf8')
    const { kernel, session, agent, requests } = bootHarness([
      { toolCalls: [{ name: 'read', args: { path: 'fact.txt' } }] },
      'done',
    ])
    kernel.ctx.llm.use('recorder')

    agent.send('go')
    await agent.run()

    expect(requests).toHaveLength(2)
    const names = requests[0]?.tools?.map((schema) => schema.name) ?? []
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    // Legacy aliases are normalized, never exposed as duplicates.
    expect(names.filter((name) => name.toLowerCase() === name)).toEqual([])

    const followUp = requests[1]?.messages
    expect(followUp?.at(-1)).toEqual({ role: 'tool', content: '1\tx', toolCallId: 'call-1-0' })
    void kernel.stop()
    void session
  })

  it('projects rewritten tool arguments into the follow-up model request', async () => {
    await fs.writeFile(path.join(root, 'rewritten.txt'), 'rewritten value', 'utf8')
    const { kernel, agent, requests } = bootHarness([
      { toolCalls: [{ name: 'Read', args: { path: 'original.txt' } }] },
      'done',
    ])
    kernel.ctx.llm.use('recorder')
    kernel.ctx.on('tools/rewrite', async ({ call }, next) => next({
      call: { ...call, id: 'rewritten-call-id', args: { path: 'rewritten.txt' } },
    }))

    agent.send('read it')
    await agent.run()

    const assistant = requests[1]?.messages.find((message) => message.role === 'assistant')
    expect(assistant?.role === 'assistant' && assistant.toolCalls?.[0]).toEqual({
      id: 'rewritten-call-id',
      name: 'Read',
      args: { path: 'rewritten.txt' },
    })
    void kernel.stop()
  })

  it('tool preparation failures become results and the turn can continue', async () => {
    const { kernel, session, agent } = bootHarness([
      { toolCalls: [{ name: 'Glob', args: { pattern: '*' } }] },
      'handled failure',
    ])
    kernel.ctx.on('tools/pre-execute', async () => { throw new Error('gate exploded') })

    agent.send('go')
    await agent.run()

    const result = session.events.find((event) => event.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.ok).toBe(false)
    expect(result?.type === 'tool/result' && result.output).toContain('tool preparation failed: gate exploded')
    expect(session.events.findLast((event) => event.type === 'turn/end')).toMatchObject({ type: 'turn/end', reason: 'completed' })
    void kernel.stop()
  })

  it('a denied tool still owes the model its (failed) result and another step', async () => {
    const { kernel, session, agent } = bootHarness([
      { toolCalls: [{ name: 'write', args: { path: 'blocked.txt', content: 'x' } }] },
      'acknowledged the denial',
    ])
    kernel.ctx.on('tools/pre-execute', async () => {
      return { kind: 'deny', reason: 'read-only policy' }
    })

    agent.send('write it')
    await agent.run()

    const toolResult = session.events.find((event) => event.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.ok).toBe(false)
    expect(toolResult?.type === 'tool/result' && toolResult.output).toBe('denied: read-only policy')

    const stepStarts = session.events.filter((event) => event.type === 'step/start')
    expect(stepStarts).toHaveLength(2)
    void kernel.stop()
  })

  it('a turn keeps spending steps while tools are called, without a bound', async () => {
    // Four tool-call steps then a final text reply: the loop must run all
    // five steps — no step limit truncates the tool chain.
    const toolStep = { toolCalls: [{ name: 'glob', args: { pattern: '*' } }] }
    const { kernel, session, agent } = bootHarness([
      toolStep,
      toolStep,
      toolStep,
      toolStep,
      'finally done',
    ])

    agent.send('loop through tools')
    await agent.run()

    const stepStarts = session.events.filter((event) => event.type === 'step/start')
    expect(stepStarts).toHaveLength(5)
    const last = session.events[session.events.length - 1]
    expect(last?.type === 'turn/end' && last.reason).toBe('completed')
    void kernel.stop()
  })

  it('invariant: with tools in the loop every request equals the log projection', async () => {
    await fs.writeFile(path.join(root, 'inv.txt'), 'answer=42', 'utf8')
    const { kernel, session, agent, requests } = bootHarness([
      { toolCalls: [{ name: 'read', args: { path: 'inv.txt' } }] },
      'done',
    ])
    kernel.ctx.llm.use('recorder')

    agent.send('check')
    await agent.run()

    // The recorder saw two requests. Each must equal the projection of the
    // log prefix at its moment: request 1 right after the user message was
    // appended, request 2 right after step 1 closed with its tool result.
    expect(requests).toHaveLength(2)
    const events = session.events
    const firstUser = events.findIndex((event) => event.type === 'user/message')
    const firstStepEnd = events.findIndex((event) => event.type === 'step/end')

    expect(requests[0]?.messages).toEqual(deriveMessages(events.slice(0, firstUser + 1)))
    expect(requests[1]?.messages).toEqual(deriveMessages(events.slice(0, firstStepEnd + 1)))
    expect(requests[1]?.messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', content: '1\tanswer=42', toolCallId: 'call-1-0' },
    ])
    void kernel.stop()
  })
})
