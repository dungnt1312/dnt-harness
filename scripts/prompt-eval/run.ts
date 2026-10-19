/**
 * Opt-in LIVE behavioral prompt eval: a misspelled symbol, a wrong path/alias
 * that needs a changed search, and a nonexistent feature that must be reported
 * absent. Scores recall together with tool use (see `score.ts`).
 *
 *   PROMPT_EVAL_API_KEY=… [PROMPT_EVAL_BASE_URL=…] bun scripts/prompt-eval/run.ts [model]
 *
 * Without PROMPT_EVAL_API_KEY it exits 0 and does nothing (never runs in CI by
 * accident). The base URL is used as-is; the provider appends
 * `/chat/completions`.
 *
 * Each case gets a fresh disposable fixture repository in the OS temp dir and
 * a fresh kernel: the real agent loop, the real context builder with the
 * default base prompt and default mode, and the real Read/Glob/Grep tools
 * rooted at the fixture. Write tools and Bash are not registered. Sessions
 * live in memory only; no transcript is written. Output is one line per case
 * with counts, never answer text, tool arguments or the key.
 */
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  AgentsService,
  BUNDLED_MODES,
  DEFAULT_MODE_ID,
  DeepSeekProvider,
  Kernel,
  LlmService,
  SessionsService,
  ToolsService,
  fsTools,
} from '../../src/index.ts'
import { buildContext } from '../../src/harness/context/builder.ts'
import { resolveModelBudget } from '../../src/harness/context/budget.ts'
import { renderEnvironmentContext } from '../../src/harness/context/environment.ts'
import { FIXTURE_FILES, PROMPT_EVAL_CASES, formatScore, scoreCase, transcriptOf, type PromptEvalCase, type PromptEvalScore } from './score.ts'

const key = process.env['PROMPT_EVAL_API_KEY']
if (key === undefined || key.trim() === '') {
  process.stdout.write('prompt-eval skipped: PROMPT_EVAL_API_KEY is not set\n')
  process.exit(0)
}
const baseUrl = process.env['PROMPT_EVAL_BASE_URL'] ?? 'https://api.deepseek.com'
const model = process.argv[2] ?? 'deepseek-v4-pro'
const CASE_TIMEOUT_MS = 180_000
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const modeDefinition = BUNDLED_MODES.find((definition) => definition.id === DEFAULT_MODE_ID)
if (modeDefinition === undefined) throw new Error(`bundled mode ${DEFAULT_MODE_ID} is missing`)
const mode = { definition: modeDefinition, source: 'bundled' as const }

async function writeFixture(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'dnt-prompt-eval-')))
  for (const [relative, body] of Object.entries(FIXTURE_FILES)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, body)
  }
  return root
}

async function runCase(testCase: PromptEvalCase, apiKey: string): Promise<{ score: PromptEvalScore; errorKind: string | undefined }> {
  const root = await writeFixture()
  const kernel = new Kernel()
  try {
    kernel.ctx.plugin(SessionsService)
    kernel.ctx.plugin(LlmService)
    kernel.ctx.plugin(ToolsService)
    kernel.ctx.plugin(AgentsService)
    for (const tool of fsTools()) if (READ_TOOLS.has(tool.name)) kernel.ctx.tools.register(tool)
    kernel.ctx.tools.setRootResolver(() => ({ root }))
    kernel.ctx.llm.register(new DeepSeekProvider(apiKey, baseUrl))

    const session = kernel.ctx.sessions.create()
    kernel.ctx.on('agent/context', async (projected, next) => {
      const schemas = kernel.ctx.tools.schemas().filter((schema) => mode.definition.toolExposure.includes(schema.name))
      const environment = renderEnvironmentContext({ now: new Date(), platform: process.platform, arch: process.arch, nodeVersion: process.version, workspacePath: root })
      const assembled = buildContext({
        events: session.events, mode, modeRevision: 0, model, providerName: 'deepseek', schemas, activeSkills: [], pinnedMemory: [],
        budget: resolveModelBudget({ model }),
        ...(environment !== undefined ? { environment } : {}),
        ...(projected.squeeze !== undefined ? { squeeze: projected.squeeze } : {}),
        fileScope: { primary: root, additional: [], outsideAsks: true },
      })
      return next({ ...projected, model, messages: assembled.messages, tools: schemas, outputCeilingTokens: assembled.maxOutputTokens })
    }, true)

    const agent = kernel.ctx.agents.create(session)
    const timer = setTimeout(() => agent.stop(), CASE_TIMEOUT_MS)
    try {
      agent.send(testCase.prompt)
      await agent.run()
    } finally {
      clearTimeout(timer)
    }
    const error = session.events.findLast((event) => event.type === 'turn/error')
    return { score: scoreCase(testCase, transcriptOf(session.events)), errorKind: error?.type === 'turn/error' ? error.kind : undefined }
  } finally {
    await kernel.stop()
    await rm(root, { recursive: true, force: true })
  }
}

let failed = false
for (const testCase of PROMPT_EVAL_CASES) {
  let outcome: Awaited<ReturnType<typeof runCase>>
  try {
    outcome = await runCase(testCase, key)
  } catch (error) {
    process.stdout.write(`prompt-eval FAIL: case=${testCase.id} error=${error instanceof Error ? error.name : 'unknown'}\n`)
    failed = true
    continue
  }
  // The error kind only, never its message: a provider message can echo request details.
  process.stdout.write(`${formatScore(outcome.score)} model=${model}${outcome.errorKind !== undefined ? ` turnError=${outcome.errorKind}` : ''}\n`)
  if (!outcome.score.pass) failed = true
}
process.exit(failed ? 1 : 0)
