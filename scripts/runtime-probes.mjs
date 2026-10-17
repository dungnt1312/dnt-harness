#!/usr/bin/env bun
// Runtime probes: prints the real runtime (not inferred) and verifies the
// facts later phases depend on. Must run under Bun: `bun scripts/runtime-probes.mjs`.
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { lookup } from 'node:dns/promises'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_BUN = '1.4.3'
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const git = spawnSync('git', ['--version'], { encoding: 'utf8' })
console.log(JSON.stringify({
  platform: process.platform,
  arch: process.arch,
  bun: process.versions.bun ?? null,
  nodeCompat: process.versions.node,
  execPath: process.execPath,
  git: git.stdout?.trim() || null,
}, null, 2))

record('runtime is Bun', Boolean(process.versions.bun), process.versions.bun ?? 'not Bun')
record(`Bun version is ${REQUIRED_BUN}`, process.versions.bun === REQUIRED_BUN, process.versions.bun)

/** True when the module's Agent routes connections through a custom connect hook. */
async function dispatcherHonored(mod, origin) {
  let connected = false
  const base = mod.buildConnector?.({})
  if (typeof base !== 'function') return { honored: false, reason: 'no buildConnector export' }
  const agent = new mod.Agent({ connect: (opts, cb) => { connected = true; return base(opts, cb) } })
  try {
    const res = await mod.request(origin, { dispatcher: agent })
    await res.body.text()
    return { honored: connected, reason: connected ? 'connect hook invoked' : 'connect hook bypassed' }
  } catch (error) {
    return { honored: false, reason: String(error?.message ?? error) }
  } finally {
    await agent.close?.().catch(() => {})
  }
}

const server = createServer((_req, res) => res.end('ok'))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
try {
  // Bun intercepts the bare specifier (even via require.resolve), so resolve the package file explicitly.
  const pkgJson = createRequire(import.meta.url).resolve('undici/package.json')
  const entry = path.join(path.dirname(pkgJson), JSON.parse(readFileSync(pkgJson, 'utf8')).main ?? 'index.js')
  const real = await import(pathToFileURL(entry).href)
  const realResult = await dispatcherHonored(real, origin)
  record('resolved undici entry honors dispatcher', realResult.honored, `${entry}: ${realResult.reason}`)
  const fetchResult = await dispatcherHonored({ ...real, request: async (url, opts) => {
    const res = await real.fetch(url, opts)
    return { body: { text: () => res.text() } }
  } }, origin)
  record('resolved undici fetch honors dispatcher', fetchResult.honored, fetchResult.reason)
  // Phase 1 relies on bare `undici` being Bun's native shim; fail loudly if Bun changes that.
  const bare = await import('undici')
  const bareResult = await dispatcherHonored(bare, origin)
  record("bare 'undici' is Bun's shim (dispatcher bypassed)", !bareResult.honored, bareResult.reason)
} finally {
  server.close()
}

try {
  const addresses = await lookup('localhost', { all: true })
  record('DNS lookup (localhost)', addresses.length > 0, addresses.map((a) => a.address).join(', '))
} catch (error) {
  record('DNS lookup (localhost)', false, String(error))
}

if (process.platform !== 'win32') {
  const bash = spawnSync('bash', ['-c', 'echo "$BASH_VERSION"'], { encoding: 'utf8' })
  record('real bash available', bash.status === 0, bash.stdout?.trim() || bash.error?.message)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} probes passed`)
process.exit(failed.length === 0 ? 0 : 1)
