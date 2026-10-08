/**
 * The web bin: boots the harness behind an HTTP server and prints the URL.
 * When `DEEPSEEK_API_KEY` is set and the provider config is empty, first
 * boot seeds a DeepSeek entry. Without a key the server still starts so
 * the browser Settings panel can add any OpenAI-completions compatible
 * provider. Sessions persist under `--data-dir` (default
 * `<homedir>/.dnt-harness/data`) and reopen on restart.
 * Serve the built client first:
 *
 *   npm run build:web
 *   npm run web [-- --port 3082 --root . --yolo --auth --allowed-host <name,ip>]
 *
 * The listener is loopback-only, so control-plane pairing stays off unless
 * `--auth` (or `DNT_HARNESS_AUTH=1`) asks for it.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { assertSchemaFloor } from '../harness/mcp/migration.ts'
import { createWebServer } from '../web/server.ts'
import { defaultSecretRoots } from '../capabilities/fs/secret-roots.ts'
import { loadRepoEnv, repoRoot, resolveAppHome } from './env.ts'

// `~/.dnt-harness`, or the pre-rename `~/.mini-dsh` while only that exists.
const appHome = resolveAppHome()

// A repo-root .env supplies DEEPSEEK_API_KEY when the process environment
// does not carry it. Real environment variables win over file entries.
loadRepoEnv()

interface CliOptions {
  readonly port: number
  readonly root: string
  readonly dataDir: string
  readonly yolo: boolean
  readonly auth: boolean
  readonly allowedHosts: readonly string[]
}

function parseArgs(argv: readonly string[]): CliOptions {
  let port = 3082
  let root = process.cwd()
  let dataDir = path.join(appHome, 'data')
  let yolo = false
  // The bin binds loopback only, so a local run is already limited to this
  // machine's user: pairing is opt-in. Turn it on whenever the port is shared
  // beyond that user, e.g. behind a proxy or a forwarded tunnel.
  let auth = process.env['DNT_HARNESS_AUTH'] === '1'
  // Extra names the Host allowlist should answer to — a reverse proxy's
  // hostname or the tailnet IP when served through `tailscale serve`.
  const allowedHosts: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') port = Number(argv[i + 1] ?? port) || port
    else if (arg === '--root') root = argv[i + 1] ?? root
    else if (arg === '--data-dir') dataDir = argv[i + 1] ?? dataDir
    else if (arg === '--yolo') yolo = true
    else if (arg === '--auth') auth = true
    else if (arg === '--no-auth') auth = false
    else if (arg === '--allowed-host') {
      for (const host of (argv[i + 1] ?? '').split(',')) {
        const trimmed = host.trim().toLowerCase()
        if (trimmed !== '') allowedHosts.push(trimmed)
      }
    }
  }
  return { port, root, dataDir, yolo, auth, allowedHosts }
}

async function main(): Promise<void> {
  const { port, root, dataDir, yolo, auth, allowedHosts } = parseArgs(process.argv.slice(2))
  await assertSchemaFloor(dataDir)

  const server = await createWebServer({
    home: dataDir,
    // Providers live next to the data dir's parent home (see resolveAppHome).
    configFile: path.join(appHome, 'providers.json'),
    // Claude Code user skills are a read-only layer under workspace skills.
    userSkillsDir: path.join(homedir(), '.claude', 'skills'),
    // Claude Code user layer: CLAUDE.md, settings.json hooks, agents/.
    userClaudeDir: path.join(homedir(), '.claude'),
    // Skills shipped with the app land in the read-only bundled layer.
    bundledSkillsDir: path.join(repoRoot(), 'skills'),
    // Credential folders stay off-limits to file tools in every mode.
    secretRoots: defaultSecretRoots(homedir()),
    seedDeepseekFromEnv: true,
    limits: { automaticCompactionPressure: 0.85 },
    ...(yolo ? { yolo: true, defaultMode: 'allow' as const } : { defaultMode: 'ask' as const }),
    // `--root` picks where an unbound Workbench terminal opens. It is not
    // passed as `root`: that would widen the file tools' legacy grant, which
    // is a separate decision from where a user's shell starts.
    terminals: { defaultCwd: root },
    port,
    controlPlaneAuth: auth,
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
  })

  process.stdout.write(`dnt-harness web: ${server.url}\n`)
  if (auth) {
    const pairing = server.auth.issuePairingCode()
    process.stdout.write(`pairing code (single use, expires in 5 minutes): ${pairing.code}\n`)
  }

  let shuttingDown = false
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) {
      process.exit(signal === 'SIGINT' ? 130 : 143)
      return
    }
    shuttingDown = true
    void server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('shutdown failed', error)
        process.exit(1)
      },
    )
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  process.stderr.write(`dnt-harness web: failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
