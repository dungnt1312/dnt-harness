// A/B comparison: the SAME prompt, the SAME model, run once through the
// installed opencode CLI and once through this repo's headless harness. Both
// point at the same local OpenAI-compatible gateway (default
// http://127.0.0.1:6536/v1), so the upstream model is literally identical;
// the only variable left is the harness itself.
//
// Two modes:
//
//   lab  (default) - rebuilds a scratch git repo whose working tree holds a
//          "local change" with five seeded issues (ground truth), runs both
//          harnesses on it and grades recall + metrics.
//          Usage: node scripts/e2e/compare-opencode-dnt.mjs [--rounds 2]
//
//   repo - reviews an EXISTING repo (e.g. this branch). Before any model
//          runs, the changed/untracked files are snapshotted; after EACH run
//          the worktree is verified and any drift is auto-restored, then the
//          run is reported as a violation. Nothing in the target repo is
//          ever modified by the harnesses (prompt forbids it) - if it is,
//          the snapshot puts it back.
//          Usage: node scripts/e2e/compare-opencode-dnt.mjs --repo . \
//                   --prompt "Review this branch compared to main. ..." [--rounds 1]
//          To review a live branch without racing concurrent writers (or
//          having their drift auto-restored out from under them), freeze the
//          branch into a throwaway worktree first and point --repo at it:
//            git worktree add --detach %TMP%\review-copy HEAD
//            git diff HEAD --binary > patch; git -C %TMP%\review-copy apply patch
//            (copy every untracked file from `git status -uall` too)
//
//   --timeout <seconds> caps each run (default 300).
//   --only <opencode|dnt> runs just one harness (default: run both).
//
// The generated opencode config disables approval prompts
// (permission.external_directory / permission.doom_loop = allow): dnt runs
// with --yolo, and in `opencode run` an "ask" permission is auto-rejected
// AND the rejection halts the session - one review run died that way when a
// benign `cat` loop was misread as touching an "external directory"
// (target under %TEMP% surfaces as /tmp/... through MSYS bash).
//
// Per round it saves decoded transcripts to <workdir> and prints metrics
// (wall time, tool calls, finding count; recall only in lab mode).
//
// Env overrides:
//   GATEWAY_BASE   default http://127.0.0.1:6536/v1
//   OPENCODE_JS    default <node dir>/node_modules/opencode-ai/bin/opencode
//   COMPARE_WORKDIR default <tmp>/opencode-dnt-compare
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const nodeExec = process.execPath

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const roundsArg = flag('--rounds', '2')
const rounds = Number.isInteger(Number(roundsArg)) && Number(roundsArg) > 0 ? Number(roundsArg) : 2
const timeoutArg = Number(flag('--timeout', '300'))
const runTimeoutMs = Number.isFinite(timeoutArg) && timeoutArg > 0 ? timeoutArg * 1000 : 300_000
const onlyArg = flag('--only', 'both')
const only = ['opencode', 'dnt', 'both'].includes(onlyArg) ? onlyArg : 'both'

const LAB_PROMPT =
  'Review the local uncommitted changes in this repository. List every concrete issue you find, ' +
  'ordered by severity (high/medium/low), each with a file:line reference and a one-line fix. ' +
  'Do not modify any files.'
const prompt = flag('--prompt', LAB_PROMPT)
const repoOverride = flag('--repo', undefined)
const mode = repoOverride ? 'repo' : 'lab'

const gateway = (process.env.GATEWAY_BASE ?? 'http://127.0.0.1:6536/v1').replace(/\/+$/u, '')
const opencodeJs =
  process.env.OPENCODE_JS ??
  path.join(path.dirname(nodeExec), 'node_modules', 'opencode-ai', 'bin', 'opencode')
const bunExec = process.env.BUN_BIN ?? 'bun'
const workdir = process.env.COMPARE_WORKDIR ?? path.join(os.tmpdir(), 'opencode-dnt-compare')
const targetRepo = repoOverride ? path.resolve(repoOverride) : path.join(workdir, 'review-lab')
const ocConfig = path.join(workdir, 'oc-config', 'opencode.json')

const GROUND_TRUTH = [
  ['secret', /sk_live|hardcoded/iu],
  ['off-by-one', /length - 1/u],
  ['floating-promise', /without\s+`?(?:await|returning)|neither awaits nor returns|floating promise|unhandled (?:promise|rejection)/iu],
  ['in-place-sort', /(?:in place|in-place|mutat)/iu],
  ['empty-catch', /(?:empty `catch|catch \{|catch\(\)|swallow)/iu],
]

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function writeOcConfig() {
  fs.mkdirSync(path.dirname(ocConfig), { recursive: true })
  fs.writeFileSync(
    ocConfig,
    `${JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          ocproxy: {
            npm: '@ai-sdk/openai-compatible',
            name: 'ocproxy (local gateway)',
            options: { baseURL: gateway, apiKey: 'local-gateway' },
            models: { 'deepseek-v4.1-flash-free': { name: 'deepseek-v4.1-flash-free' } },
          },
        },
        // Headless parity with dnt's --yolo: opencode defaults to "ask" for
        // external_directory and doom_loop, and `opencode run` auto-rejects
        // those asks. A rejection throws RejectedError, which HALTS the run
        // (v1.2.24). User permission rules merge after the defaults and
        // PermissionNext.evaluate keeps the LAST match, so this wins.
        permission: { external_directory: 'allow', doom_loop: 'allow' },
      },
      null,
      2,
    )}\n`,
  )
}

function buildLab() {
  fs.rmSync(targetRepo, { recursive: true, force: true })
  fs.mkdirSync(path.join(targetRepo, 'src'), { recursive: true })
  const git = (...a) => execFileSync('git', ['-C', targetRepo, ...a], { stdio: 'pipe' }).toString()
  fs.writeFileSync(
    path.join(targetRepo, 'src', 'cart.js'),
    `'use strict'\n\n/** Minimal shopping cart with line totals. */\n\nfunction createCart() {\n  return { items: [] }\n}\n\nfunction addItem(cart, item) {\n  cart.items.push({ sku: item.sku, price: item.price, qty: item.qty })\n}\n\nfunction subtotal(cart) {\n  let total = 0\n  for (const item of cart.items) total += item.price * item.qty\n  return total\n}\n\nmodule.exports = { createCart, addItem, subtotal }\n`,
  )
  fs.writeFileSync(path.join(targetRepo, 'README.md'), '# review-lab\n\nScratch repo for reviewing a local change.\n')
  git('init', '-b', 'main')
  git('config', 'user.email', 'lab@example.com')
  git('config', 'user.name', 'review lab')
  git('add', '.')
  git('commit', '-m', 'base cart module')
  // The local (uncommitted) change under review - five seeded issues.
  fs.writeFileSync(
    path.join(targetRepo, 'src', 'cart.js'),
    `'use strict'\n\n/** Minimal shopping cart with line totals and discounts. */\n\nfunction createCart() {\n  return { items: [] }\n}\n\nfunction addItem(cart, item) {\n  cart.items.push({ sku: item.sku, price: item.price, qty: item.qty })\n}\n\nfunction subtotal(cart) {\n  let total = 0\n  for (const item of cart.items) total += item.price * item.qty\n  return total\n}\n\nfunction applyDiscount(cart, percent) {\n  const eligible = cart.items.slice(0, cart.items.length - 1)\n  const total = eligible.reduce((sum, item) => sum + item.price * item.qty, 0)\n  return total * (1 - percent / 100)\n}\n\nfunction topItems(cart, count) {\n  return cart.items.sort((a, b) => b.price - a.price).slice(0, count)\n}\n\nmodule.exports = { createCart, addItem, subtotal, applyDiscount, topItems }\n`,
  )
  fs.writeFileSync(
    path.join(targetRepo, 'src', 'sync.js'),
    `'use strict'\n\nconst SYNC_TOKEN = 'sk_live_9f4d177ab31c'\n\nasync function pushOrder(order) {\n  return fetch('https://api.example.com/orders', {\n    method: 'POST',\n    headers: { authorization: \`Bearer \${SYNC_TOKEN}\` },\n    body: JSON.stringify(order),\n  })\n}\n\nfunction persist(order) {\n  pushOrder(order)\n}\n\nasync function refreshCatalog() {\n  try {\n    await fetch('https://api.example.com/catalog')\n  } catch (error) {\n  }\n}\n\nmodule.exports = { pushOrder, persist, refreshCatalog, SYNC_TOKEN }\n`,
  )
}

// ---- repo mode safety net -------------------------------------------------

function gitStatusEntries(dir) {
  const raw = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '-z', '-uall'], {
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8')
  const parts = raw.split('\0').filter(Boolean)
  const entries = []
  for (let i = 0; i < parts.length; i += 1) {
    const item = parts[i]
    const status = item.slice(0, 2)
    const file = item.slice(3)
    // In `-z` output a staged rename/copy lists the NEW name first, then the
    // origin as its own NUL field: keep the new name and consume the origin.
    if (status[0] === 'R' || status[0] === 'C') i += 1
    entries.push({ status, path: file.replace(/\\/gu, '/') })
  }
  return entries
}

function snapshotRepo(dir) {
  const snapDir = path.join(workdir, 'repo-snapshot')
  fs.rmSync(snapDir, { recursive: true, force: true })
  fs.mkdirSync(snapDir, { recursive: true })
  const records = []
  for (const entry of gitStatusEntries(dir)) {
    const abs = path.join(dir, entry.path)
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile()
    const record = { status: entry.status, path: entry.path, exists, sha256: null, backup: null }
    if (exists) {
      const buf = fs.readFileSync(abs)
      record.sha256 = sha256(buf)
      record.backup = `file-${records.length}.bin`
      fs.writeFileSync(path.join(snapDir, record.backup), buf)
    }
    records.push(record)
  }
  fs.writeFileSync(path.join(snapDir, 'manifest.json'), `${JSON.stringify(records, null, 2)}\n`)
  return { dir: snapDir, byPath: new Map(records.map((r) => [r.path, r])) }
}

// Restores every file to the snapshot bytes; returns the paths that had drifted.
function verifyRepo(dir, snap) {
  const violations = []
  try {
    execFileSync('git', ['-C', dir, 'reset', '-q'], { stdio: 'pipe' })
  } catch {}
  // 1) files known at snapshot time: byte-compare / restore
  for (const record of snap.byPath.values()) {
    const abs = path.join(dir, record.path)
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile()
    if (record.exists) {
      const same = exists && sha256(fs.readFileSync(abs)) === record.sha256
      if (!same) {
        violations.push(record.path)
        if (exists) fs.rmSync(abs, { force: true })
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.copyFileSync(path.join(snap.dir, record.backup), abs)
      }
    } else if (exists) {
      violations.push(record.path)
      fs.rmSync(abs, { force: true })
    }
  }
  // 2) paths that appeared after the snapshot: undo (untracked: delete; tracked: restore from HEAD)
  for (const entry of gitStatusEntries(dir)) {
    if (snap.byPath.has(entry.path)) continue
    violations.push(entry.path)
    const abs = path.join(dir, entry.path)
    if (entry.status === '??') {
      if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true })
    } else {
      try {
        execFileSync('git', ['-C', dir, 'restore', '--source=HEAD', '--worktree', '--staged', '--', entry.path], { stdio: 'pipe' })
      } catch {}
    }
  }
  return violations
}

// ---- runners ---------------------------------------------------------------

function run(cmd, cmdArgs, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(cmd, cmdArgs, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 300_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        ms: Date.now() - started,
        stdout: stripAnsi(Buffer.concat(out).toString('utf8')),
        stderr: stripAnsi(Buffer.concat(err).toString('utf8')),
      })
    })
    // A failed spawn emits 'error' and may never emit 'close' (and even when
    // both fire, a second resolve is a no-op): never leave the caller hanging.
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        code: -1,
        ms: Date.now() - started,
        stdout: stripAnsi(Buffer.concat(out).toString('utf8')),
        stderr: `${stripAnsi(Buffer.concat(err).toString('utf8'))}${String(error)}`,
      })
    })
  })
}

const runOpencode = () =>
  run(nodeExec, [opencodeJs, 'run', '--model', 'ocproxy/deepseek-v4.1-flash-free', prompt], {
    cwd: targetRepo,
    env: { ...process.env, OPENCODE_CONFIG: ocConfig },
    timeoutMs: runTimeoutMs,
  })

const runDnt = (round) =>
  run(
    bunExec,
    [
      path.join(repo, 'src', 'bins', 'headless.ts'),
      '--provider',
      'ocproxy',
      '--model',
      'deepseek-v4.1-flash-free',
      '--yolo',
      '--root',
      targetRepo,
      '--data-dir',
      path.join(workdir, `dnt-data-${round}`),
      '--message',
      prompt,
    ],
    { cwd: repo, timeoutMs: runTimeoutMs },
  )

function metrics(kind, text) {
  const toolCount =
    kind === 'opencode'
      ? (text.match(/(?:^|\n)\$ /g) ?? []).length + (text.match(/(?:^|\n)\u2192 /g) ?? []).length
      : (text.match(/\[tool\] \w+/g) ?? []).length
  const findings = (text.match(/(?:^|\n)(?:\d+\.|-)\s+\*\*/g) ?? []).length
  const recall = GROUND_TRUTH.filter(([, re]) => re.test(text)).map(([name]) => name)
  return { toolCount, findings, recall }
}

async function checkGateway() {
  try {
    const res = await fetch(`${gateway}/models`, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = await res.json()
    const names = (body.data ?? []).map((m) => m.id)
    if (!names.includes('deepseek-v4.1-flash-free')) {
      throw new Error(`model missing; gateway serves: ${names.slice(0, 8).join(', ')}`)
    }
  } catch (error) {
    console.error(`gateway check failed at ${gateway}: ${error.message}`)
    console.error('start the local gateway (or set GATEWAY_BASE) and retry.')
    process.exit(1)
  }
}

// ---- main -------------------------------------------------------------------

if (!fs.existsSync(opencodeJs)) {
  console.error(`opencode CLI entry not found: ${opencodeJs}`)
  console.error('run this script with the node that has opencode-ai installed, or set OPENCODE_JS.')
  process.exit(1)
}

await checkGateway()
writeOcConfig()
if (mode === 'lab') buildLab()
const snap = mode === 'repo' ? snapshotRepo(targetRepo) : null

console.log(`mode:     ${mode}${mode === 'repo' ? ` (${targetRepo})` : ''}`)
console.log(`gateway:  ${gateway}`)
if (mode === 'repo') {
  console.log(`snapshot: ${snap.byPath.size} changed/untracked files -> ${snap.dir}`)
  console.log(`prompt:   ${prompt}`)
} else {
  console.log(`lab:      ${targetRepo}`)
}
console.log(`opencode: ${opencodeJs} (v${execFileSync(nodeExec, [opencodeJs, '--version']).toString().trim()})`)
console.log(`timeout:  ${runTimeoutMs / 1000}s per run`)
console.log('')

let failed = 0
for (let round = 1; round <= rounds; round += 1) {
  const oc = only === 'dnt' ? null : await runOpencode()
  const ocViolations = oc && mode === 'repo' ? verifyRepo(targetRepo, snap) : []
  const dnt = only === 'opencode' ? null : await runDnt(round)
  const dntViolations = dnt && mode === 'repo' ? verifyRepo(targetRepo, snap) : []
  if (oc) {
    fs.writeFileSync(path.join(workdir, `round-${round}-opencode.txt`), `$ opencode run --model ocproxy/deepseek-v4.1-flash-free "<prompt>"\nexit: ${oc.code}\n\n${oc.stdout}\n----- stderr (opencode prints tool activity here) -----\n${oc.stderr}`)
  }
  if (dnt) {
    fs.writeFileSync(path.join(workdir, `round-${round}-dnt.txt`), `$ bun src/bins/headless.ts --provider ocproxy --model deepseek-v4.1-flash-free --yolo --root <target> --message "<prompt>"\nexit: ${dnt.code}\n\n${dnt.stdout}${dnt.stderr}`)
  }

  // opencode renders tool activity on stderr; grade the merged stream.
  const mOc = oc ? metrics('opencode', `${oc.stdout}\n${oc.stderr}`) : null
  const mDnt = dnt ? metrics('dnt', `${dnt.stdout}\n${dnt.stderr}`) : null
  console.log(`round ${round}:`)
  if (oc) {
    const recallPart = mode === 'lab' ? ` recall=${mOc.recall.length}/5 [${mOc.recall.join(', ')}]` : ''
    console.log(`  opencode   exit=${oc.code} time=${(oc.ms / 1000).toFixed(1)}s tools=${mOc.toolCount} findings=${mOc.findings}${recallPart}`)
  }
  if (dnt) {
    console.log(`  dnt        exit=${dnt.code} time=${(dnt.ms / 1000).toFixed(1)}s tools=${mDnt.toolCount} findings=${mDnt.findings}${mode === 'lab' ? ` recall=${mDnt.recall.length}/5 [${mDnt.recall.join(', ')}]` : ''}`)
  }
  if (mode === 'repo') {
    if (oc) console.log(`  worktree   opencode violations: ${ocViolations.length === 0 ? 'none' : ocViolations.join(', ')}`)
    if (dnt) console.log(`  worktree   dnt violations:      ${dntViolations.length === 0 ? 'none' : dntViolations.join(', ')}`)
  }
  for (const [label, result, violations, m] of [
    ['opencode', oc, ocViolations, mOc],
    ['dnt', dnt, dntViolations, mDnt],
  ]) {
    if (!result) continue
    const missing = mode === 'lab' ? GROUND_TRUTH.filter(([name]) => !m.recall.includes(name)).map(([name]) => name) : []
    if (result.code !== 0 || missing.length > 0 || violations.length > 0) {
      failed += 1
      console.log(`  FAIL ${label}: exit=${result.code} missing=${missing.join(', ') || 'none'} worktree-drift=${violations.length}`)
    }
  }
}

console.log('')
console.log(`transcripts: ${workdir}`)
process.exit(failed === 0 ? 0 : 1)
