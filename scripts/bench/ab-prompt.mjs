/**
 * A/B the base-prompt change: run the same "search for an API that does not
 * exist" task through the harness source on `main` and on the current branch,
 * and compare loop length. Both trees must contain scripts/bench/harness-agent.mts
 * and have node_modules available.
 *
 *   node scripts/bench/ab-prompt.mjs [--reps 3]
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback }
const REPS = Number(flag('reps', '3'))
const NODE = process.execPath
const BUN = process.env.BUN_BIN ?? 'bun'
const TEMPLATE = path.join(process.cwd(), 'scripts', 'bench', 'tasks', 'discount-bug')
const TREES = [
  { name: 'main', dir: 'C:\\laragon\\www\\dnt-main' },
  { name: 'branch', dir: 'C:\\laragon\\www\\dnt-harness' },
]
const PROMPT = 'Search this project for a function that validates a field named `fraudScore`. If such a thing exists, name the file and line. If it does not exist, say so plainly and stop.'

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true })
    let stdout = '', stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    const t = setTimeout(() => child.kill('SIGKILL'), 240000)
    child.on('close', (code) => { clearTimeout(t); resolve({ code, stdout, stderr }) })
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout, stderr: e.message }) })
  })
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const base = path.join(os.tmpdir(), `dnt-ab-${stamp}`)
await fs.mkdir(base, { recursive: true })
const records = []
for (const tree of TREES) {
  for (let rep = 1; rep <= REPS; rep++) {
    const repoDir = path.join(base, tree.name, `rep${rep}`, 'repo')
    const metricsPath = path.join(base, tree.name, `rep${rep}`, 'metrics.json')
    await fs.mkdir(path.dirname(metricsPath), { recursive: true })
    await fs.cp(TEMPLATE, repoDir, { recursive: true })
    process.stdout.write(`▶ prompt A/B: ${tree.name} rep${rep} ... `)
    const res = await run(BUN, [path.join('scripts', 'bench', 'harness-agent.mts'), '--root', repoDir, '--data-dir', path.join(repoDir, '.dnt-data'), '--message', PROMPT, '--metrics', metricsPath], {
      cwd: tree.dir,
      env: { ...process.env, BENCH_MODEL: process.env.BENCH_MODEL ?? 'deepseek-v4.1-flash-free', BENCH_MODE: 'autonomous', BENCH_TIMEOUT_MS: '200000' },
    })
    const metrics = await fs.readFile(metricsPath, 'utf8').then(JSON.parse).catch(() => null)
    const text = metrics?.finalText ?? ''
    const absent = /\b(no|not|never|doesn't|does not|doesn’t|cannot|can't|isn't|is not)\b/i.test(text)
    records.push({ tree: tree.name, rep, steps: metrics?.steps ?? -1, toolCalls: metrics?.toolCalls ?? -1, inputTokens: metrics?.inputTokens ?? -1, outputTokens: metrics?.outputTokens ?? -1, wallMs: metrics?.wallMs ?? -1, toolSequence: metrics?.toolSequence ?? [], answered: text.trim() !== '', saidAbsent: absent, exit: res.code, stderr: res.stderr.slice(-200) })
    process.stdout.write(`steps=${metrics?.steps} tools=${metrics?.toolCalls} answered=${text.trim() !== ''} absent=${absent}\n`)
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const lines = ['# A/B: base-prompt discipline (main vs branch)', '', `Task: ${PROMPT}`, `Model: ${process.env.BENCH_MODEL ?? 'deepseek-v4.1-flash-free'} · reps: ${REPS}`, '', '| Tree | Steps (med) | Tool calls (med) | In tok (med) | Wall s (med) | Answered (non-empty) | Said "does not exist" |', '|---|---|---|---|---|---|---|']
for (const tree of TREES) {
  const rs = records.filter((r) => r.tree === tree.name)
  lines.push(`| ${tree.name} | ${median(rs.map((r) => r.steps))} | ${median(rs.map((r) => r.toolCalls))} | ${median(rs.map((r) => r.inputTokens))} | ${(median(rs.map((r) => r.wallMs)) / 1000).toFixed(1)} | ${rs.filter((r) => r.answered).length}/${rs.length} | ${rs.filter((r) => r.saidAbsent).length}/${rs.length} |`)
}
lines.push('', '## Per run', '', '| Tree | Rep | Steps | Tools | In tok | Wall s | Answered | Absent | Tool sequence |', '|---|---|---|---|---|---|---|---|---|')
for (const r of records) lines.push(`| ${r.tree} | ${r.rep} | ${r.steps} | ${r.toolCalls} | ${r.inputTokens} | ${(r.wallMs / 1000).toFixed(1)} | ${r.answered} | ${r.saidAbsent} | ${r.toolSequence.join(' ')} |`)
lines.push('', `Raw: \`${base}\``)
const md = lines.join('\n')
await fs.mkdir(path.join(process.cwd(), 'plans'), { recursive: true })
await fs.writeFile(path.join(process.cwd(), 'plans', `ab-prompt-${stamp}.md`), md)
await fs.writeFile(path.join(base, 'report.json'), JSON.stringify({ stamp, records }, null, 2))
process.stdout.write(`\n${md}\n`)
process.exit(0)
