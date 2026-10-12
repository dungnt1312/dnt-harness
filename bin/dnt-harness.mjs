#!/usr/bin/env node
// CLI launcher for the npm package. The harness ships as TypeScript source
// (Node refuses to strip types inside node_modules), so run it through tsx.
//
//   dnt-harness [web] [--port 3082 --root . --yolo --auth ...]
//   dnt-harness chat [--message "hi"]
//   dnt-harness pair [--data-dir <dir>]
//   dnt-harness start pm2 [--name dnt-harness] [web flags]
//   dnt-harness restart [--name dnt-harness]
//   dnt-harness upgrade [--name dnt-harness]
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entries = { web: 'web.ts', chat: 'headless.ts', pair: 'pair.ts' }
const args = process.argv.slice(2)
const DEFAULT_NAME = 'dnt-harness'

const USAGE = `Usage: dnt-harness [web|chat|pair|start pm2|restart|upgrade] [options]
  web (default)   serve the UI at http://127.0.0.1:3082  (--port --root --yolo --auth --allowed-host --data-dir)
  chat            headless REPL or one-shot (--message "...")
  pair            mint a pairing code for a running --auth server
  start pm2       run the web server under pm2 (restart on crash, survives reboot after "pm2 startup")
                  extra flags go to web; --name <n> sets the pm2 name (default ${DEFAULT_NAME})
  restart         restart the pm2 process, keeping the flags it was started with
  upgrade         install the latest dnt-harness from npm, then restart the pm2 process
  --version       print the installed version
`

const isWindows = process.platform === 'win32'

// On Windows, pm2 and npm are .cmd shims. Node cannot spawn those without a
// shell, so build one command line and quote any argument that needs it.
function quote(arg) {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

function run(command, commandArgs, options = {}) {
  return isWindows
    ? spawnSync([command, ...commandArgs.map(quote)].join(' '), { shell: true, ...options })
    : spawnSync(command, commandArgs, options)
}

/** Run with inherited stdio and return the exit status (1 when it could not start). */
function runVisible(command, commandArgs) {
  return run(command, commandArgs, { stdio: 'inherit' }).status ?? 1
}

function requirePm2() {
  if (run('pm2', ['-v'], { stdio: 'ignore' }).status === 0) return
  process.stderr.write('dnt-harness: pm2 is not installed. Run: npm i -g pm2\n')
  process.exit(1)
}

/** pm2 describe succeeds only for a process pm2 has registered under that name. */
function isRegistered(name) {
  return run('pm2', ['describe', name], { stdio: 'ignore' }).status === 0
}

function must(status) {
  if (status !== 0) process.exit(status)
}

function installedVersion() {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/** True when `a` is a higher major.minor.patch than `b` (prerelease tags ignored). */
function isNewer(a, b) {
  const parts = (v) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

/** Pull `--name <n>` out of the args; everything else is returned untouched. */
function takeName(rest) {
  let name = DEFAULT_NAME
  const others = []
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--name') name = rest[++i] ?? name
    else others.push(rest[i])
  }
  return { name, others }
}

function startPm2(rest) {
  const { name, others } = takeName(rest)
  requirePm2()
  // Replace an existing process so a changed port/root/flag set takes effect
  // instead of silently keeping the old one.
  if (isRegistered(name)) must(runVisible('pm2', ['delete', name]))
  const script = fileURLToPath(import.meta.url)
  // pm2 keeps the invoking cwd, which web uses as the default --root.
  must(runVisible('pm2', ['start', script, '--name', name, '--time', '--', 'web', ...others]))
  must(runVisible('pm2', ['save']))
  process.stdout.write(`\ndnt-harness is running under pm2 as "${name}".\n  logs:     pm2 logs ${name}\n  restart:  dnt-harness restart\n  upgrade:  dnt-harness upgrade\n  reboot:   pm2 startup   (run once, then "pm2 save")\n`)
}

function restartPm2(rest) {
  const { name } = takeName(rest)
  requirePm2()
  if (!isRegistered(name)) {
    process.stderr.write(`dnt-harness: pm2 has no process named "${name}". Run: dnt-harness start pm2\n`)
    process.exit(1)
  }
  must(runVisible('pm2', ['restart', name, '--update-env']))
  must(runVisible('pm2', ['save']))
}

function upgrade(rest) {
  const { name } = takeName(rest)
  const current = installedVersion()
  const view = run('npm', ['view', 'dnt-harness', 'version'], { encoding: 'utf8' })
  const latest = view.status === 0 ? String(view.stdout).trim() : ''
  if (latest === '') {
    process.stderr.write('dnt-harness: could not read the latest version from npm.\n')
    process.exit(1)
  }
  if (!isNewer(latest, current)) {
    process.stdout.write(`dnt-harness ${current} is already the latest version.\n`)
    return
  }
  process.stdout.write(`Upgrading dnt-harness ${current} -> ${latest}\n`)

  const managed = run('pm2', ['-v'], { stdio: 'ignore' }).status === 0 && isRegistered(name)
  // Stop first: on Windows a running process keeps its files locked, which
  // breaks the replacement of native modules such as node-pty.
  if (managed) must(runVisible('pm2', ['stop', name]))
  const installed = runVisible('npm', ['i', '-g', `dnt-harness@${latest}`])
  // Bring the server back even when the install failed, so it is never left down.
  if (managed) {
    must(runVisible('pm2', ['restart', name, '--update-env']))
    must(runVisible('pm2', ['save']))
  }
  if (installed !== 0) {
    process.stderr.write('dnt-harness: npm install failed; the previous version is still in place.\n')
    process.exit(installed)
  }
  process.stdout.write(managed
    ? `\nUpgraded to ${latest} and restarted "${name}".\n`
    : `\nUpgraded to ${latest}. No pm2 process "${name}" was running; start it with: dnt-harness start pm2\n`)
}

if (args[0] === 'start' && args[1] === 'pm2') {
  startPm2(args.slice(2))
} else if (args[0] === 'restart') {
  restartPm2(args.slice(1))
} else if (args[0] === 'upgrade') {
  upgrade(args.slice(1))
} else if (args[0] === '--version' || args[0] === '-v') {
  process.stdout.write(`${installedVersion()}\n`)
} else if (args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(USAGE)
} else {
  const command = args[0] !== undefined && Object.hasOwn(entries, args[0]) ? args.shift() : 'web'
  process.argv.splice(2, process.argv.length, ...args)
  const { register } = await import('tsx/esm/api')
  register()
  await import(new URL(`../src/bins/${entries[command]}`, import.meta.url).href)
}
