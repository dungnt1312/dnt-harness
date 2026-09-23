/**
 * The web bin: boots the harness behind an HTTP server and prints the URL.
 * A `DEEPSEEK_API_KEY` seeds a real DeepSeek provider on first boot; without
 * it the server still starts so the browser Settings panel can add any
 * OpenAI-completions compatible provider. Sessions persist under
 * `--data-dir` (default `<homedir>/.mini-dsh/data`) and reopen on restart.
 * Serve the built client first:
 *
 *   npm run build:web
 *   npm run web [-- --port 3082 --root . --yolo --auth]
 *
 * The listener is loopback-only, so control-plane pairing stays off unless
 * `--auth` (or `MINI_DSH_AUTH=1`) asks for it.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { assertSchemaFloor } from '../harness/mcp/migration.ts'
import { createWebServer } from '../web/server.ts'
import { loadRepoEnv } from './env.ts'

// A repo-root .env supplies DEEPSEEK_API_KEY when the process environment
// does not carry it. Real environment variables win over file entries.
loadRepoEnv()

interface CliOptions {
  readonly port: number
  readonly root: string
  readonly dataDir: string
  readonly yolo: boolean
  readonly auth: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  let port = 3082
  let root = process.cwd()
  let dataDir = path.join(homedir(), '.mini-dsh', 'data')
  let yolo = false
  // The bin binds loopback only, so a local run is already limited to this
  // machine's user: pairing is opt-in. Turn it on whenever the port is shared
  // beyond that user, e.g. behind a proxy or a forwarded tunnel.
  let auth = process.env['MINI_DSH_AUTH'] === '1'
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') port = Number(argv[i + 1] ?? port) || port
    else if (arg === '--root') root = argv[i + 1] ?? root
    else if (arg === '--data-dir') dataDir = argv[i + 1] ?? dataDir
    else if (arg === '--yolo') yolo = true
    else if (arg === '--auth') auth = true
    else if (arg === '--no-auth') auth = false
  }
  return { port, root, dataDir, yolo, auth }
}

async function main(): Promise<void> {
  const { port, root, dataDir, yolo, auth } = parseArgs(process.argv.slice(2))
  await assertSchemaFloor(dataDir)

  const server = await createWebServer({
    home: dataDir,
    // Claude Code user skills are a read-only layer under workspace skills.
    userSkillsDir: path.join(homedir(), '.claude', 'skills'),
    seedDeepseekFromEnv: true,
    ...(yolo ? { yolo: true, defaultMode: 'allow' as const } : { defaultMode: 'ask' as const }),
    // `--root` picks where an unbound Workbench terminal opens. It is not
    // passed as `root`: that would widen the file tools' legacy grant, which
    // is a separate decision from where a user's shell starts.
    terminals: { defaultCwd: root },
    port,
    controlPlaneAuth: auth,
  })

  process.stdout.write(`mini-dsh web: ${server.url}\n`)
  if (auth) {
    const pairing = server.auth.issuePairingCode()
    process.stdout.write(`pairing code (single use, expires in 5 minutes): ${pairing.code}\n`)
  }
  if (process.env['DEEPSEEK_API_KEY']?.trim() === '') {
    process.stderr.write('DEEPSEEK_API_KEY is blank; configure a provider in the web Settings panel.\n')
  } else if (process.env['DEEPSEEK_API_KEY'] === undefined) {
    process.stderr.write('no provider seeded; open Settings to add an OpenAI-completions compatible provider.\n')
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

void main()
