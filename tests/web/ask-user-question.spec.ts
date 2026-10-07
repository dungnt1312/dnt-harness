/**
 * AskUserQuestion end to end: the tool's own validation, the web bridge
 * (SSE `question` frames, `POST /api/questions/:id`), and the bundled-mode
 * exposure that lets it run without a permission prompt.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebEnvelope, type WebServer } from 'dnt-harness'
import { FakeScriptedLlm } from './fake-llm.ts'
import { parseQuestions, validateAnswers } from '../../src/harness/tools/ask-user.ts'
import { BUNDLED_MODES, KNOWN_MODE_TOOLS } from '../../src/harness/modes/bundled.ts'

let root = ''
let server: WebServer
let baseUrl = ''
let startCount = 0

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-ask-'))
})

afterAll(async () => {
  await server?.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function start(steps: readonly (string | { toolCalls: readonly { name: string; args: Record<string, unknown> }[] })[], extra?: Parameters<typeof createWebServer>[0]): Promise<void> {
  server = await createWebServer({
    root,
    providers: [new FakeScriptedLlm(steps)],
    configFile: path.join(root, `providers-ask-${startCount++}.json`),
    ...extra,
  })
  baseUrl = server.url
}

class SseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''

  constructor(response: Response) {
    if (response.body === null) throw new Error('test setup: no SSE body')
    this.reader = response.body.getReader()
  }

  async until(until: (envelope: WebEnvelope) => boolean, timeoutMs = 5_000): Promise<WebEnvelope[]> {
    const seen: WebEnvelope[] = []
    const deadline = Date.now() + timeoutMs
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error(`timeout waiting for envelope; saw ${JSON.stringify(seen.map((e) => e.kind))}`)
      const chunk = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), remaining)),
      ])
      if (chunk.done) return seen
      this.buffer += this.decoder.decode(chunk.value, { stream: true })
      let boundary = this.buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const frame = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        boundary = this.buffer.indexOf('\n\n')
        const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
        if (dataLine === undefined) continue
        const envelope = JSON.parse(dataLine.slice('data: '.length)) as WebEnvelope
        seen.push(envelope)
        if (until(envelope)) return seen
      }
    }
  }
}

async function post(pathname: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

const QUESTIONS = [
  {
    question: 'Which database should the migration target?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'PostgreSQL', description: 'Recommended: already in staging' },
      { label: 'SQLite', description: 'Zero-ops local option' },
    ],
  },
]

describe('ask-user tool shape', () => {
  it('parses and validates questions', () => {
    const questions = parseQuestions({ questions: QUESTIONS })
    expect(questions).toHaveLength(1)
    expect(questions[0]?.options.map((o) => o.label)).toEqual(['PostgreSQL', 'SQLite'])
    expect(questions[0]?.multiSelect).toBe(false)
  })

  it('rejects duplicate labels, empty arrays, and too many questions', () => {
    expect(() => parseQuestions({ questions: [] })).toThrow()
    expect(() => parseQuestions({ questions: [{ question: 'a?', options: [{ label: 'x' }, { label: 'x' }] }] })).toThrow()
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `q${i}?`, options: [{ label: 'a' }, { label: 'b' }] }))
    expect(() => parseQuestions({ questions: five })).toThrow(/at most 4/)
  })

  it('validateAnswers keeps the offered order and refuses unknown labels', () => {
    const questions = parseQuestions({ questions: QUESTIONS })
    const answers = validateAnswers(questions, [{ selected: ['SQLite'] }])
    expect(answers[0]?.selected).toEqual(['SQLite'])
    expect(() => validateAnswers(questions, [{ selected: ['MySQL'] }])).toThrow(/not an offered option/)
    expect(() => validateAnswers(questions, [{ selected: ['PostgreSQL', 'SQLite'] }])).toThrow(/single choice/)
    expect(validateAnswers(questions, [{ selected: [], other: 'Use CockroachDB' }])).toEqual([{ selected: [], other: 'Use CockroachDB' }])
    expect(() => validateAnswers(questions, [{}])).toThrow()
  })

  it('is exposed and allowed by every bundled mode', () => {
    for (const mode of BUNDLED_MODES) {
      expect(mode.toolExposure, mode.id).toContain('AskUserQuestion')
      expect(mode.permissionDefaults['AskUserQuestion'], mode.id).toBe('allow')
    }
    expect(KNOWN_MODE_TOOLS).toContain('AskUserQuestion')
  })
})

describe('ask-user web bridge', () => {
  it('rides the stream; the answer becomes the tool result the model reads', async () => {
    await start([
      { toolCalls: [{ name: 'AskUserQuestion', args: { questions: QUESTIONS } }] },
      'migration target chosen',
    ])
    const { id } = await (await post('/api/sessions')).json() as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'plan the migration' })

    const frames = await sse.until((envelope) => envelope.kind === 'question')
    const question = frames.find((e) => e.kind === 'question')
    expect(question?.kind === 'question' && question.questions[0]?.options.map((o) => o.label)).toEqual(['PostgreSQL', 'SQLite'])

    const allow = await post(`/api/questions/${question?.kind === 'question' ? question.questionId : ''}`, { answers: [{ selected: ['PostgreSQL'] }] })
    expect(allow.status).toBe(200)

    const rest = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const result = rest.find((e) => e.kind === 'session' && e.event.type === 'tool/result' && e.event.callId.startsWith('call-'))
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.ok).toBe(true)
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.output).toContain('PostgreSQL')
  })

  it('declining tells the model instead of failing the call', async () => {
    await start([
      { toolCalls: [{ name: 'AskUserQuestion', args: { questions: QUESTIONS } }] },
      'carried on without an answer',
    ])
    const { id } = await (await post('/api/sessions')).json() as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'plan the migration' })
    const frames = await sse.until((envelope) => envelope.kind === 'question')
    const question = frames.find((e) => e.kind === 'question')

    await post(`/api/questions/${question?.kind === 'question' ? question.questionId : ''}`, { decline: true })

    const rest = await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
    const result = rest.filter((e) => e.kind === 'session' && e.event.type === 'tool/result').at(-1)
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.ok).toBe(true)
    expect(result?.kind === 'session' && result.event.type === 'tool/result' && result.event.output).toContain('declined')
  })

  it('a malformed answer is a 400, an unknown question a 404, and both leave the waiter open until answered', async () => {
    await start([
      { toolCalls: [{ name: 'AskUserQuestion', args: { questions: QUESTIONS } }] },
      'done',
    ])
    const { id } = await (await post('/api/sessions')).json() as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'plan' })
    const frames = await sse.until((envelope) => envelope.kind === 'question')
    const question = frames.find((e) => e.kind === 'question')
    const questionId = question?.kind === 'question' ? question.questionId : ''

    expect((await post(`/api/questions/${questionId}`, { answers: [{ selected: ['MySQL'] }] })).status).toBe(400)
    expect((await post(`/api/questions/${questionId}`, { answers: 'nope' })).status).toBe(400)
    expect((await post('/api/questions/question-missing', { decline: true })).status).toBe(404)

    // Still answerable after the rejected attempts.
    const ok = await post(`/api/questions/${questionId}`, { answers: [{ selected: ['SQLite'] }] })
    expect(ok.status).toBe(200)
    // Double answers are late: the waiter is gone.
    expect((await post(`/api/questions/${questionId}`, { decline: true })).status).toBe(404)
    await sse.until((envelope) => envelope.kind === 'session' && envelope.event.type === 'turn/end')
  })

  it('stopping the turn cancels the question card', async () => {
    await start([
      { toolCalls: [{ name: 'AskUserQuestion', args: { questions: QUESTIONS } }] },
      'never reached',
    ])
    const { id } = await (await post('/api/sessions')).json() as { id: string }
    const sse = new SseReader(await fetch(`${baseUrl}/api/sessions/${id}/events`))
    void post(`/api/sessions/${id}/messages`, { content: 'plan' })
    const frames = await sse.until((envelope) => envelope.kind === 'question')
    const question = frames.find((e) => e.kind === 'question')
    const questionId = question?.kind === 'question' ? question.questionId : ''

    await post(`/api/sessions/${id}/stop`)
    await sse.until((envelope) => envelope.kind === 'question-settled')
    expect((await post(`/api/questions/${questionId}`, { decline: true })).status).toBe(404)
  })
})
