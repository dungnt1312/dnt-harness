#!/usr/bin/env node
// CLI launcher for the npm package. The harness ships as TypeScript source
// (Node refuses to strip types inside node_modules), so run it through tsx.
//
//   dnt-harness [web] [--port 3082 --root . --yolo --auth ...]
//   dnt-harness chat [--message "hi"]
//   dnt-harness pair [--data-dir <dir>]
//   dnt-harness start pm2 [--name dnt-harness] [web flags]
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entries = { web: 'web.ts', chat: 'headless.ts', pair: 'pair.ts' }
const args = process.argv.slice(2)

const USAGE = `Usage: dnt-harness [web|chat|pair|start pm2] [options]
  web (default)   serve the UI at http://127.0.0.1:3082  (--port --root --yolo --auth --allowed-host --data-dir)
  chat            headless REPL or one-shot (--message "...")
  pair            mint a pairing code for a running --auth server
  start pm2       run the web server under pm2 (restart on crash, survives reboot after "pm2 startup")
                  extra flags go to web; --name <n> sets the pm2 name (default dnt-harness)
`

/** Run pm2 with inherited stdio; exits the process when pm2 is missing or fails. */
function pm2(pm2Args, { allowFail = false } = {}) {
  const result = spawnSync('pm2', pm2Args, { stdio: 'inherit' })
  if (result.error?.code === 'ENOENT') {
    process.stderr.write('dnt-harness: pm2 is not installed. Run: npm i -g pm2\n')
    process.exit(1)
  }
  if (result.status !== 0 && !allowFail) process.exit(result.status ?? 1)
  return result.status ?? 1
}

function startPm2(rest) {
  let name = 'dnt-harness'
  const webArgs = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--name') name = rest[++i] ?? name
    else webArgs.push(rest[i])
  }
  // pm2 describe succeeds only for a registered process; replace it so a changed
  // port/root/flag set takes effect instead of silently keeping the old one.
  const probe = spawnSync('pm2', ['describe', name], { stdio: 'ignore' })
  if (probe.error?.code === 'ENOENT') pm2(['-v'])
  if (probe.status === 0) pm2(['delete', name])
  const script = fileURLToPath(import.meta.url)
  // pm2 keeps the invoking cwd, which web uses as the default --root.
  pm2(['start', script, '--name', name, '--time', '--', 'web', ...webArgs])
  pm2(['save'])
  process.stdout.write(`\ndnt-harness is running under pm2 as "${name}".\n  logs:    pm2 logs ${name}\n  stop:    pm2 stop ${name}\n  reboot:  pm2 startup   (run once, then "pm2 save")\n`)
}

if (args[0] === 'start' && args[1] === 'pm2') {
  startPm2(args.slice(2))
} else if (args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(USAGE)
} else {
  const command = args[0] !== undefined && Object.hasOwn(entries, args[0]) ? args.shift() : 'web'
  process.argv.splice(2, process.argv.length, ...args)
  const { register } = await import('tsx/esm/api')
  register()
  await import(new URL(`../src/bins/${entries[command]}`, import.meta.url).href)
}
