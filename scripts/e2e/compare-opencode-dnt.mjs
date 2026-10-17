// A/B comparison: the SAME prompt, the SAME model, run once through the
// installed opencode CLI and once through this repo's headless harness. Both
// point at the same local OpenAI-compatible gateway (default
// http://127.0.0.1:6536/v1), so the upstream model is literally identical;
// the only variable left is the harness itself.
//
// Modes:
//
//   lab  (default) - rebuilds a scratch git repo whose working tree holds a
//          "local change" with five seeded issues (ground truth), runs both
//          harnesses on it and grades recall + metrics.
//          Usage: node scripts/e2e/compare-opencode-dnt.mjs [--rounds 2]
//
//   repo-copy - reviews an EXISTING repo (e.g. this branch) WITHOUT touching
//          it. The source is frozen with read-only, hardened Git (no hooks,
//          fsmonitor, filters, textconv, optional locks or index refresh);
//          then every contestant/run gets its own fresh repository rebuilt
//          from the object store: HEAD, index (staged) and worktree layers
//          are reconstructed separately and verified before the agent runs.
//          Submodules, unmerged entries, symlinks/invalid paths on Windows
//          and sensitive tracked paths (.env*, *.pem, *.key, ...) are
//          refused. Ignored files are never copied; untracked files only with
//          --include-untracked (listed before any agent starts).
//          Copies hold ONLY the HEAD commit (shallow: no history, no other
//          branches/tags/remotes) plus staged blobs; sensitive paths in the
//          HEAD tree are refused too. Partial clones are refused. Git runs
//          from an absolute PATH-resolved executable with `-C`, never from
//          the repo directory, with all transports disabled.
//          Usage: node scripts/e2e/compare-opencode-dnt.mjs --repo-copy . \
//                   --prompt "Review this branch compared to main. ..." [--rounds 1]
//
//   repo - runs directly in a DISPOSABLE target this script created earlier
//          (a run copy under <workdir>/runs-*). Ordinary checkouts are
//          refused: the disposable marker is only written into directories
//          the script itself creates and must match <workdir>'s registry.
//
// Nothing is ever reset/restored/deleted. After each run the target is
// diffed (added/modified/deleted files, index entries, all refs, HEAD,
// .git/config, hooks, info/); timed-out agents get their whole process
// tree killed; drift
// fails the run (nonzero exit) and the target is preserved for inspection.
// In repo-copy mode the source fingerprint (HEAD, refs, raw index bytes,
// tracked + untracked bytes) is re-checked after every run as well.
// Copies are independent repos, not a sandbox: an agent running as the same
// OS user can still reach the source by absolute path.
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
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runContestant, runFailed, runProcess } from './agent-run.mjs'
import {
  RepoSafetyError,
  assertDisposable,
  createDisposableDir,
  freezeSource,
  git as hardenedGit,
} from './repo-freeze.mjs'

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
const repoCopyArg = flag('--repo-copy', undefined)
const includeUntracked = args.includes('--include-untracked')
if (repoOverride && repoCopyArg) {
  console.error('--repo and --repo-copy are mutually exclusive')
  process.exit(2)
}
const mode = repoOverride ? 'repo' : repoCopyArg ? 'repo-copy' : 'lab'

const gateway = (process.env.GATEWAY_BASE ?? 'http://127.0.0.1:6536/v1').replace(/\/+$/u, '')
const opencodeJs =
  process.env.OPENCODE_JS ??
  path.join(path.dirname(nodeExec), 'node_modules', 'opencode-ai', 'bin', 'opencode')
const bunExec = process.env.BUN_BIN ?? 'bun'
const workdir = process.env.COMPARE_WORKDIR ?? path.join(os.tmpdir(), 'opencode-dnt-compare')
const targetRepo = repoOverride ? path.resolve(repoOverride) : null
const ocConfig = path.join(workdir, 'oc-config', 'opencode.json')
// Caller-owned record of directories this script created (marker tokens).
const registry = path.join(workdir, 'disposable-registry.json')
const runsDir = path.join(workdir, `runs-${new Date().toISOString().replace(/[:.]/gu, '-')}`)
const labRepo = path.join(runsDir, 'review-lab')
const copySource = repoCopyArg ? path.resolve(repoCopyArg) : labRepo

const GROUND_TRUTH = [
  ['secret', /sk_live|hardcoded/iu],
  ['off-by-one', /length - 1/u],
  ['floating-promise', /without\s+`?(?:await|returning)|neither awaits nor returns|floating promise|unhandled (?:promise|rejection)/iu],
  ['in-place-sort', /(?:in place|in-place|mutat)/iu],
  ['empty-catch', /(?:empty `catch|catch \{|catch\(\)|swallow)/iu],
]


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
  // Fresh per invocation (never rm -rf a fixed path); copies are built from it.
  createDisposableDir(labRepo, registry)
  const targetRepo = labRepo
  fs.mkdirSync(path.join(targetRepo, 'src'), { recursive: true })
  const git = (...a) => hardenedGit(targetRepo, a).toString()
  fs.writeFileSync(
    path.join(targetRepo, 'src', 'cart.js'),
    `'use strict'\n\n/** Minimal shopping cart with line totals. */\n\nfunction createCart() {\n  return { items: [] }\n}\n\nfunction addItem(cart, item) {\n  cart.items.push({ sku: item.sku, price: item.price, qty: item.qty })\n}\n\nfunction subtotal(cart) {\n  let total = 0\n  for (const item of cart.items) total += item.price * item.qty\n  return total\n}\n\nmodule.exports = { createCart, addItem, subtotal }\n`,
  )
  fs.writeFileSync(path.join(targetRepo, 'README.md'), '# review-lab\n\nScratch repo for reviewing a local change.\n')
  git('symbolic-ref', 'HEAD', 'refs/heads/main')
  git('config', 'core.autocrlf', 'false')
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

// ---- runners ---------------------------------------------------------------

const run = runProcess

const runOpencode = (target) =>
  run(nodeExec, [opencodeJs, 'run', '--model', 'ocproxy/deepseek-v4.1-flash-free', prompt], {
    cwd: target,
    env: { ...process.env, OPENCODE_CONFIG: ocConfig },
    timeoutMs: runTimeoutMs,
  })

const runDnt = (round, target) =>
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
      target,
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

// Everything that can refuse runs before the gateway is touched.
let snapshot = null
let sourceBefore = null
try {
  if (mode === 'repo') assertDisposable(targetRepo, registry)
  if (mode === 'repo-copy' || mode === 'lab') {
    if (mode === 'lab') buildLab()
    snapshot = freezeSource(copySource, { includeUntracked: includeUntracked || mode === 'lab' })
    sourceBefore = snapshot.fingerprint
  }
} catch (error) {
  if (!(error instanceof RepoSafetyError)) throw error
  console.error(error.message)
  process.exit(2)
}

await checkGateway()
writeOcConfig()

console.log(`mode:     ${mode}${mode === 'repo' ? ` (${targetRepo}, disposable)` : ` (source ${copySource})`}`)
console.log(`gateway:  ${gateway}`)
if (snapshot) {
  const staged = snapshot.entries.length
  const modified = snapshot.worktree.filter((w) => w.state !== 'same').length
  console.log(`frozen:   HEAD ${snapshot.head ?? '(unborn)'}, ${staged} index entries, ${modified} worktree changes`)
  if (snapshot.untracked.length > 0) {
    console.log(`untracked copied (${snapshot.untracked.length}):`)
    for (const file of snapshot.untracked) console.log(`  ${file.path}`)
  } else if (snapshot.untrackedSkipped > 0) {
    console.log(`untracked: ${snapshot.untrackedSkipped} file(s) NOT copied (pass --include-untracked to opt in)`)
  }
  console.log(`runs:     ${runsDir}`)
}
if (mode !== 'lab') console.log(`prompt:   ${prompt}`)
console.log(`opencode: ${opencodeJs} (v${execFileSync(nodeExec, [opencodeJs, '--version']).toString().trim()})`)
console.log(`timeout:  ${runTimeoutMs / 1000}s per run`)
console.log('')

function contestant(label, round, launch) {
  return runContestant({
    snapshot,
    targetDir: snapshot ? path.join(runsDir, `round-${round}-${label}`) : targetRepo,
    registry,
    sourceBefore,
    sourceRoot: snapshot?.root,
    launch,
  })
}

let failed = 0
let stop = false
for (let round = 1; round <= rounds && !stop; round += 1) {
  const ocRun = only === 'dnt' ? null : await contestant('opencode', round, runOpencode)
  const dntRun = only === 'opencode' || (mode === 'repo' && ocRun?.drift.length) ? null : await contestant('dnt', round, (t) => runDnt(round, t))
  const oc = ocRun?.result ?? null
  const dnt = dntRun?.result ?? null
  const ocViolations = ocRun?.drift ?? []
  const dntViolations = dntRun?.drift ?? []
  // A drifted shared --repo target would contaminate every later run.
  if (mode === 'repo' && (ocViolations.length > 0 || dntViolations.length > 0)) stop = true
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
  for (const [label, entry] of [['opencode', ocRun], ['dnt', dntRun]]) {
    if (!entry) continue
    console.log(`  drift      ${label.padEnd(8)} ${entry.drift.length === 0 ? 'none' : entry.drift.join('; ')}${entry.target ? ` (${entry.target})` : ''}`)
  }
  if (stop) console.log('  stopping: --repo target drifted; artifacts preserved, nothing restored')
  for (const [label, entry, m] of [
    ['opencode', ocRun, mOc],
    ['dnt', dntRun, mDnt],
  ]) {
    if (!entry) continue
    const missing = mode === 'lab' ? GROUND_TRUTH.filter(([name]) => !m.recall.includes(name)).map(([name]) => name) : []
    if (runFailed(entry, missing)) {
      failed += 1
      console.log(`  FAIL ${label}: exit=${entry.result.code}${entry.result.timedOut ? ' (timeout)' : ''} missing=${missing.join(', ') || 'none'} drift=${entry.drift.length}`)
    }
  }
  if ([ocRun, dntRun].some((entry) => entry?.sourceChanged.length > 0)) stop = true
}

console.log('')
console.log(`transcripts: ${workdir}`)
process.exit(failed === 0 ? 0 : 1)
