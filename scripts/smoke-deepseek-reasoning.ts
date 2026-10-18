/**
 * Opt-in LIVE smoke of DeepSeek thinking + tools through the real adapter and
 * agent loop (the provider-agnostic reasoning round-trip, on one real endpoint).
 *
 *   DEEPSEEK_API_KEY=… bun scripts/smoke-deepseek-reasoning.ts [model]
 *
 * Without DEEPSEEK_API_KEY it exits 0 and does nothing (never runs in CI by
 * accident). Sessions live in memory only: no transcript, reasoning text or key
 * is written anywhere. Output is a pass/fail line with counts, never content.
 *
 * What it proves: turn 1 calls tools in thinking mode, request 2 replays the
 * recorded `reasoning_content` (the endpoint answers 400 otherwise), turn 2 —
 * a new user message on the same session — replays every prior turn and also
 * completes.
 */
import { AgentsService, DeepSeekProvider, Kernel, LlmService, SessionsService, ToolsService, type ToolDefinition } from '../src/index.ts'

const key = process.env['DEEPSEEK_API_KEY']
if (key === undefined || key.trim() === '') {
  process.stdout.write('PH4-G skipped: DEEPSEEK_API_KEY is not set\n')
  process.exit(0)
}
const model = process.argv[2] ?? 'deepseek-v4-pro'

const clock: ToolDefinition = {
  name: 'GetDate', description: 'Returns today\'s date as YYYY-MM-DD.', readOnly: true,
  parameters: { type: 'object', properties: {} },
  execute: async () => '2026-10-18',
}
const weather: ToolDefinition = {
  name: 'GetWeather', description: 'Weather for a city on a date (YYYY-MM-DD).', readOnly: true,
  parameters: { type: 'object', properties: { city: { type: 'string' }, date: { type: 'string' } }, required: ['city', 'date'] },
  execute: async () => 'Cloudy 7~13°C',
}

const kernel = new Kernel()
kernel.ctx.plugin(SessionsService)
kernel.ctx.plugin(LlmService)
kernel.ctx.plugin(ToolsService)
kernel.ctx.plugin(AgentsService)
kernel.ctx.tools.register(clock)
kernel.ctx.tools.register(weather)
kernel.ctx.llm.register(new DeepSeekProvider(key, process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com'))
kernel.ctx.on('agent/request', async (request, next) => next({ ...request, model, thinkingLevel: 'high' }), true)

const session = kernel.ctx.sessions.create()
const agent = kernel.ctx.agents.create(session)
let failed = false
try {
  for (const prompt of ['What is the weather in Hangzhou tomorrow? Use the tools.', 'And in Guangzhou tomorrow? Use the tools.']) {
    agent.send(prompt)
    await agent.run()
    const end = session.events.findLast((event) => event.type === 'turn/end')
    const error = session.events.findLast((event) => event.type === 'turn/error')
    const assistants = session.events.filter((event) => event.type === 'assistant/message')
    const reasoned = assistants.filter((event) => event.type === 'assistant/message' && event.reasoning?.complete === true).length
    const tools = session.events.filter((event) => event.type === 'tool/result').length
    const ok = end?.type === 'turn/end' && end.reason === 'completed'
    // Counts and status only — never message or reasoning text.
    process.stdout.write(`PH4-G ${ok ? 'pass' : 'FAIL'}: model=${model} assistants=${assistants.length} withReasoning=${reasoned} toolResults=${tools}${!ok && error?.type === 'turn/error' ? ` error=${error.message.slice(0, 160)}` : ''}\n`)
    if (!ok || tools === 0) failed = true
  }
} finally {
  await kernel.stop()
}
process.exit(failed ? 1 : 0)
