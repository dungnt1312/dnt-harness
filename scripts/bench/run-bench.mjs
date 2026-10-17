/**
 * Automated benchmark: run the SAME real coding tasks through dnt-harness and
 * opencode, both pointed at the same OpenAI-compatible model endpoint, verify
 * each result, and aggregate performance metrics.
 *
 *   node scripts/bench/run-bench.mjs [--reps 2] [--only fix-bug] [--tasks fix-bug,explain]
 *
 * Emits a JSON report under the run dir and a markdown report under plans/.
 * Requires: a live OpenAI-compatible endpoint at BENCH_BASE_URL.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const REPO = process.cwd()
const NODE = process.execPath
const BUN = process.env.BUN_BIN ?? 'bun'
const OC_BIN = process.env.OC_BIN ?? 'C:\\laragon\\bin\\nodejs\\node-v22.20.0-win-x64\\node_modules\\opencode-ai\\bin\\opencode'
const BASE_URL = process.env.BENCH_BASE_URL ?? 'http://127.0.0.1:6536/v1'
const API_KEY = process.env.BENCH_API_KEY ?? 'bench'
const MODEL = process.env.BENCH_MODEL ?? 'deepseek-v4.1-flash-free'
const TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? '240000')

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const REPS = Number(flag('reps', '2'))
const ONLY = flag('only', '')
const TEMPLATE = path.join(REPO, 'scripts', 'bench', 'tasks', 'discount-bug')

const TASKS = [
  {
    id: 'fix-bug',
    kind: 'edit',
    prompt: 'Run the test suite with the Bash tool: node --test. One test is failing. Find the root cause in the source code (do not modify the test files), apply the smallest correct fix, then run node --test again to confirm the suite passes. In your final reply state the root cause in one sentence.',
  },
  {
    id: 'explain-rounding',
    kind: 'read',
    prompt: 'Without modifying anything, read the code and answer: in which source file does the percentage-discount rounding rule live, and what exact rounding does the test suite expect? Answer in two short sentences.',
  },
  {
    id: 'nonexistent-api',
    kind: 'read',
    prompt: 'Search this project for a function that validates a field named `fraudScore`. If such a thing exists, name the file and line. If it does not exist, say so plainly and stop.',
  },
]

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, args, { ...opts, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8') })
    const timer = setTimeout(() => child.kill('SIGKILL'), (opts.timeoutMs ?? TIMEOUT_MS) + 15000)
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, wallMs: Date.now() - started }) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, wallMs: Date.now() - started }) })
  })
}

async function snapshot(dir) {
  const out = {}
  async function walk(current, prefix) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.name === '.dnt-data' || entry.name === 'node_modules' || entry.name === '.git') continue
      const full = path.join(current, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(full, rel)
      else out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex')
    }
  }
  await walk(dir, '')
  return out
}

async function verify(task, dir) {
  const before = JSON.parse(await fs.readFile(path.join(dir, '..', 'before.json'), 'utf8'))
  const after = await snapshot(dir)
  const changed = Object.keys(after).filter((f) => after[f] !== before[f])
  const removed = Object.keys(before).filter((f) => !(f in after))
  const testsModified = !('test/cart.test.js' in after) || before['test/cart.test.js'] !== after['test/cart.test.js']

  if (task.kind === 'edit') {
    // Neutralize any test edits: restore the pristine suite before verifying.
    await fs.rm(path.join(dir, 'test'), { recursive: true, force: true })
    await fs.cp(path.join(TEMPLATE, 'test'), path.join(dir, 'test'), { recursive: true })
    const test = await run(NODE, ['--test'], { cwd: dir, timeoutMs: 120000 })
    const pass = /# pass (\d+)/.exec(test.stdout)?.[1]
    const fail = /# fail (\d+)/.exec(test.stdout)?.[1]
    return { success: test.code === 0, testsModified, changedFiles: changed.filter((f) => !f.startsWith('test/')), pass: Number(pass ?? -1), fail: Number(fail ?? -1) }
  }

  const text = (await fs.readFile(path.join(dir, '..', 'metrics.json'), 'utf8').then(JSON.parse).catch(() => ({}))).finalText ?? ''
  if (task.id === 'explain-rounding') {
    const ok = changed.length === 0 && removed.length === 0 && /round/i.test(text) && /discount/i.test(text)
    return { success: ok, filesChanged: changed.length + removed.length }
  }
  if (task.id === 'nonexistent-api') {
    const absent = /\b(no|not|never|doesn't|does not|doesn’t|cannot|can't|isn't|is not)\b/i.test(text)
    const ok = changed.length === 0 && removed.length === 0 && absent
    return { success: ok, filesChanged: changed.length + removed.length }
  }
  return { success: false, filesChanged: changed.length + removed.length }
}

async function runDnt(dir, prompt, eventsPath) {
  const metricsPath = path.join(dir, '..', 'metrics.json')
  const res = await run(BUN, [
    path.join('scripts', 'bench', 'harness-agent.mts'),
    '--root', dir, '--data-dir', path.join(dir, '.dnt-data'),
    '--message', prompt, '--metrics', metricsPath,
    ...(eventsPath ? ['--events', eventsPath] : []),
  ], {
    cwd: REPO, timeoutMs: TIMEOUT_MS,
    env: { ...process.env, BENCH_BASE_URL: BASE_URL, BENCH_API_KEY: API_KEY, BENCH_MODEL: MODEL, BENCH_MODE: 'autonomous', BENCH_TIMEOUT_MS: String(TIMEOUT_MS) },
  })
  const metrics = await fs.readFile(metricsPath, 'utf8').then(JSON.parse).catch(() => null)
  return { metrics, wallMs: res.wallMs, stderrTail: res.stderr.slice(-400) }
}

async function runOc(dir, prompt, eventsPath, configPath) {
  const metricsPath = path.join(dir, '..', 'metrics.json')
  const res = await run(NODE, [
    path.join('scripts', 'bench', 'opencode-run.mjs'),
    '--dir', dir, '--message', prompt, '--metrics', metricsPath,
    '--timeout-ms', String(TIMEOUT_MS),
    ...(eventsPath ? ['--events', eventsPath] : []),
  ], {
    cwd: REPO, timeoutMs: TIMEOUT_MS,
    env: { ...process.env, OC_BIN, NODE_BIN: NODE, OPENCODE_CONFIG: configPath, BENCH_BASE_URL: BASE_URL, BENCH_API_KEY: API_KEY, BENCH_MODEL: MODEL, BENCH_PROVIDER: 'bench' },
  })
  const metrics = await fs.readFile(metricsPath, 'utf8').then(JSON.parse).catch(() => null)
  return { metrics, wallMs: res.wallMs, stderrTail: res.stderr.slice(-400) }
}

// ── orchestration ──────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const BENCH_DIR = path.join(os.tmpdir(), `dnt-bench-${stamp}`)
await fs.mkdir(BENCH_DIR, { recursive: true })
const configPath = path.join(BENCH_DIR, 'opencode.json')
const templateHash = await snapshot(TEMPLATE)

const selected = TASKS.filter((t) => ONLY === '' || t.id === ONLY)
const harnesses = [
  { name: 'dnt-harness', run: runDnt },
  { name: 'opencode', run: (dir, prompt, events) => runOc(dir, prompt, events, configPath) },
]

const records = []
for (const task of selected) {
  for (const harness of harnesses) {
    for (let rep = 1; rep <= REPS; rep++) {
      const caseDir = path.join(BENCH_DIR, task.id, harness.name, `rep${rep}`)
      const repoDir = path.join(caseDir, 'repo')
      await fs.mkdir(caseDir, { recursive: true })
      await fs.cp(TEMPLATE, repoDir, { recursive: true })
      await fs.writeFile(path.join(caseDir, 'before.json'), JSON.stringify(await snapshot(repoDir)))

      process.stdout.write(`▶ ${task.id} / ${harness.name} / rep${rep} ... `)
      const { metrics, wallMs, stderrTail } = await harness.run(repoDir, task.prompt, path.join(caseDir, 'events.jsonl'))
      const verdict = await verify(task, repoDir)
      const record = { task: task.id, harness: harness.name, rep, wallMs, stderrTail, verdict, metrics }
      records.push(record)
      await fs.writeFile(path.join(caseDir, 'record.json'), JSON.stringify(record, null, 2))
      const m = metrics ?? {}
      process.stdout.write(`done in ${(wallMs / 1000).toFixed(1)}s — steps=${m.steps ?? '?'} tools=${m.toolCalls ?? '?'} success=${verdict.success}\n`)
    }
  }
}

// ── aggregate ──────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)
const median = (xs) => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); const mid = Math.floor(s.length / 2); return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2 }
const summary = []
for (const task of selected) {
  for (const harness of harnesses) {
    const rs = records.filter((r) => r.task === task.id && r.harness === harness.name)
    // A run that produced no model call (e.g. the provider stream failed the
    // protocol boundary) carries no loop metrics; keep it in the success rate
    // but exclude it from the medians so one fault cannot skew the row.
    const valid = rs.filter((r) => (r.metrics?.steps ?? 0) > 0 && (r.metrics?.errors?.length ?? 0) === 0 && r.metrics?.timedOut !== true)
    const m = (k) => valid.map((r) => r.metrics?.[k] ?? 0)
    summary.push({
      task: task.id, harness: harness.name, runs: rs.length, validRuns: valid.length,
      successRate: rs.filter((r) => r.verdict.success).length / rs.length,
      protocolFaults: rs.filter((r) => (r.metrics?.errors?.length ?? 0) > 0).length,
      stepsMedian: median(m('steps')), toolCallsMedian: median(m('toolCalls')),
      wallSecondsMedian: median(valid.map((r) => r.wallMs / 1000)),
      inputTokensMedian: median(m('inputTokens')), outputTokensMedian: median(m('outputTokens')),
      cachedTokensMedian: median(m('cachedTokens') ?? m('cachedInputTokens')),
      firstRequestInputMedian: median(m('firstRequestInputTokens')),
      failures: rs.filter((r) => !r.verdict.success).map((r) => ({ rep: r.rep, verdict: r.verdict, err: r.metrics?.errors, stderr: r.stderrTail?.slice(0, 200) })),
    })
  }
}

const report = { stamp, model: MODEL, baseUrl: BASE_URL, reps: REPS, tasks: selected.map((t) => t.id), records, summary }
await fs.writeFile(path.join(BENCH_DIR, 'report.json'), JSON.stringify(report, null, 2))

// ── markdown ───────────────────────────────────────────────────────────────
const lines = []
lines.push(`# Benchmark: dnt-harness vs opencode (${stamp})`)
lines.push('')
lines.push(`- Model: \`${MODEL}\` (both harnesses → \`${BASE_URL}\`)`)
lines.push(`- Task fixture: \`scripts/bench/tasks/discount-bug\` (2 of 5 tests failing)`)
lines.push(`- Repetitions per cell: ${REPS}`)
lines.push('')
lines.push('| Task | Harness | Success | Prov. faults | Steps (med) | Tool calls (med) | Wall s (med) | In tok (med) | Out tok (med) | 1st-req in tok |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const s of summary) {
  lines.push(`| ${s.task} | ${s.harness} | ${(s.successRate * 100).toFixed(0)}% | ${s.protocolFaults} | ${s.stepsMedian} | ${s.toolCallsMedian} | ${s.wallSecondsMedian.toFixed(1)} | ${s.inputTokensMedian} | ${s.outputTokensMedian} | ${s.firstRequestInputMedian} |`)
}
lines.push('')
lines.push('## Per-run detail')
lines.push('')
lines.push('| Task | Harness | Rep | Steps | Tools | Wall s | In | Out | Cached | Success |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const r of records) {
  const m = r.metrics ?? {}
  lines.push(`| ${r.task} | ${r.harness} | ${r.rep} | ${m.steps ?? '?'} | ${m.toolCalls ?? '?'} | ${(r.wallMs / 1000).toFixed(1)} | ${m.inputTokens ?? '?'} | ${m.outputTokens ?? '?'} | ${(m.cachedTokens ?? m.cachedInputTokens) ?? '?'} | ${r.verdict.success} |`)
}
lines.push('')
lines.push(`Raw artifacts: \`${BENCH_DIR}\``)
const md = lines.join('\n')
await fs.mkdir(path.join(REPO, 'plans'), { recursive: true })
await fs.writeFile(path.join(REPO, 'plans', `bench-${stamp}.md`), md)
await fs.writeFile(path.join(BENCH_DIR, 'report.md'), md)

process.stdout.write(`\n${md}\n`)
process.exit(0)
