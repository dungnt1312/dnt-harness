/**
 * opencode benchmark runner.
 *
 * Runs `opencode run --format json` against a local OpenAI-compatible endpoint
 * (so both harnesses hit the same model), captures the NDJSON event stream, and
 * writes a metrics JSON. The verifier runs separately in the orchestrator.
 *
 * Env:
 *   OC_BIN          path to the opencode bin script (node entrypoint)
 *   NODE_BIN        node 22 executable
 *   BENCH_BASE_URL  OpenAI-compatible base URL
 *   BENCH_API_KEY   bearer token (any string)
 *   BENCH_MODEL     model id
 *   BENCH_PROVIDER  provider id in the generated opencode config (default 'bench')
 *   OC_CONFIG       path to write the temp opencode config
 *
 * Args: --dir DIR --message TEXT --metrics FILE [--events FILE] [--timeout-ms N]
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const dir = arg('dir')
const message = arg('message')
const metricsPath = arg('metrics')
const eventsPath = arg('events')
const timeoutMs = Number(arg('timeout-ms', '240000'))
if (!dir || !message || !metricsPath) throw new Error('usage: --dir DIR --message TEXT --metrics FILE')

const model = process.env.BENCH_MODEL ?? 'deepseek-v4.1-flash-free'
const provider = process.env.BENCH_PROVIDER ?? 'bench'
const baseUrl = process.env.BENCH_BASE_URL ?? 'http://127.0.0.1:6536/v1'
const nodeBin = process.env.NODE_BIN ?? process.execPath
const ocBin = process.env.OC_BIN
const configPath = process.env.OC_CONFIG ?? process.env.OPENCODE_CONFIG

if (configPath) {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `${provider}/${model}`,
    autoupdate: false,
    share: 'disabled',
    permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
    provider: {
      [provider]: {
        npm: '@ai-sdk/openai-compatible',
        name: provider,
        options: { baseURL: baseUrl, apiKey: process.env.BENCH_API_KEY ?? 'bench' },
        models: { [model]: { name: model } },
      },
    },
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
}

const started = Date.now()
let timedOut = false
const events = []
let stderr = ''

const child = spawn(nodeBin, [ocBin, 'run', '--format', 'json', '-m', `${provider}/${model}`, message], {
  cwd: dir,
  env: { ...process.env, ...(configPath ? { OPENCODE_CONFIG: configPath } : {}) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try { events.push(JSON.parse(trimmed)) } catch { /* non-JSON noise */ }
  }
})
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })

const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)

await new Promise((resolve) => { child.on('close', resolve); child.on('error', resolve) })
clearTimeout(timer)
if (buffer.trim() !== '') { try { events.push(JSON.parse(buffer.trim())) } catch { /* ignore */ } }

const wallMs = Date.now() - started
const byType = (t) => events.filter((e) => e.type === t)
const toolUses = byType('tool_use')
const stepFinishes = byType('step_finish')
const texts = byType('text')

// A field not reported by every step stays undefined ("unknown"), never 0.
const measured = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
const sumField = (pick) => {
  if (stepFinishes.length === 0) return undefined
  let acc = 0
  for (const e of stepFinishes) {
    const v = measured(pick(e.part?.tokens ?? {}))
    if (v === undefined) return undefined
    acc += v
  }
  return acc
}
// opencode's `tokens.input` EXCLUDES cache reads (non-cached input); cache
// reads are reported separately under `tokens.cache.read`.
const inputTokens = sumField((t) => t.input)
const outputTokens = sumField((t) => t.output)
const reasoningTokens = sumField((t) => t.reasoning)
const cachedTokens = sumField((t) => t.cache?.read)
const inputInclusiveTokens = inputTokens !== undefined && cachedTokens !== undefined ? inputTokens + cachedTokens : undefined

const metrics = {
  harness: 'opencode',
  model, provider,
  ok: !timedOut && child.exitCode === 0 && byType('error').length === 0,
  timedOut,
  exitCode: child.exitCode,
  wallMs,
  steps: byType('step_start').length,
  toolCalls: toolUses.length,
  failedToolResults: toolUses.filter((e) => e.part?.state?.status !== 'completed').length,
  toolSequence: toolUses.map((e) => e.part?.tool),
  inputSemantics: 'non-cached',
  inputTokens, outputTokens, reasoningTokens, cachedTokens, inputInclusiveTokens,
  // Inclusive total: non-cached input + cache reads (once) + output.
  totalTokens: inputInclusiveTokens !== undefined && outputTokens !== undefined ? inputInclusiveTokens + outputTokens : undefined,
  // Non-cached first-request input (comparable only via inclusive semantics).
  firstRequestInputTokens: measured(stepFinishes[0]?.part?.tokens?.input),
  finalText: texts.at(-1)?.part?.text ?? '',
  errors: byType('error').map((e) => e.error?.data?.message ?? e.error?.name ?? 'error'),
  stderrTail: stderr.slice(-500),
}

writeFileSync(metricsPath, JSON.stringify(metrics, null, 2))
if (eventsPath) writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n'))
process.stdout.write(`BENCH_RESULT ${JSON.stringify(metrics)}\n`)
process.exit(0)
