/**
 * The web bin: boots the harness behind an HTTP server and prints the URL.
 * A `DEEPSEEK_API_KEY` seeds a real DeepSeek provider on first boot; without
 * it the server still starts so the browser Settings panel can add any
 * OpenAI-completions compatible provider. Sessions persist under
 * `--data-dir` (default `<homedir>/.mini-dsh/data`) and reopen on restart.
 * Serve the built client first:
 *
 *   npm run build:web
 *   npm run web [-- --port 3082 --root . --yolo]
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { createWebServer } from '../web/server.ts'
import type { ApprovalMode } from '../harness/approval/policy.ts'
import { loadRepoEnv } from './env.ts'

// A repo-root .env supplies DEEPSEEK_API_KEY when the process environment
// does not carry it. Real environment variables win over file entries.
loadRepoEnv()

interface CliOptions {
  readonly port: number
  readonly root: string
  readonly dataDir: string
  readonly yolo: boolean
}

function parseArgs(argv: readonly string[]): CliOptions {
  let port = 3082
  let root = process.cwd()
  let dataDir = path.join(homedir(), '.mini-dsh', 'data')
  let yolo = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port') port = Number(argv[i + 1] ?? port) || port
    else if (arg === '--root') root = argv[i + 1] ?? root
    else if (arg === '--data-dir') dataDir = argv[i + 1] ?? dataDir
    else if (arg === '--yolo') yolo = true
  }
  return { port, root, dataDir, yolo }
}

async function main(): Promise<void> {
  const { port, root, dataDir, yolo } = parseArgs(process.argv.slice(2))

  const policy: Readonly<Record<string, ApprovalMode>> = {
    Read: 'allow',
    Glob: 'allow',
    Grep: 'allow',
    Write: 'ask',
    Edit: 'ask',
    Bash: 'ask',
  }

  const server = await createWebServer({
    home: dataDir,
    // Claude Code user skills are a read-only layer under workspace skills.
    userSkillsDir: path.join(homedir(), '.claude', 'skills'),
    seedDeepseekFromEnv: true,
    ...(yolo ? {} : { policy }),
    defaultMode: yolo ? 'allow' : 'ask',
    // `--root` picks where an unbound Workbench terminal opens. It is not
    // passed as `root`: that would widen the file tools' legacy grant, which
    // is a separate decision from where a user's shell starts.
    terminals: { defaultCwd: root },
    port,
  })

  process.stdout.write(`mini-dsh web: ${server.url}\n`)
  if (process.env['DEEPSEEK_API_KEY']?.trim() === '') {
    process.stderr.write('DEEPSEEK_API_KEY is blank; configure a provider in the web Settings panel.\n')
  } else if (process.env['DEEPSEEK_API_KEY'] === undefined) {
    process.stderr.write('no provider seeded; open Settings to add an OpenAI-completions compatible provider.\n')
  }

  process.on('SIGINT', () => {
    // First interrupt: close gracefully. A second interrupt exits at once,
    // in case teardown itself is stuck.
    process.on('SIGINT', () => process.exit(130))
    void server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('shutdown failed', error)
        process.exit(1)
      },
    )
  })
}

void main()
