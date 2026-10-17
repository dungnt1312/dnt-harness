/**
 * pm2 ecosystem for the dnt-harness web host.
 *
 *   pm2 start ecosystem.config.cjs
 *
 * Runs the web bin with Bun so the session log, tools, and SSE stream are
 * live; serve the built client first (bun run build:web).
 *
 * Optional environment variables (read when pm2 loads this file):
 *   PORT                    listen port (default 3082)
 *   DNT_HARNESS_ALLOWED_HOSTS  comma-separated extra Host names/IPs the server
 *                              should answer to, e.g. a LAN IP or reverse-proxy
 *                              hostname. Loopback and the bind host are always
 *                              allowed.
 *   DNT_HARNESS_OAUTH_ORIGINS  comma-separated https origins the app is reached
 *                              at, e.g. https://harness.example.com. MCP OAuth
 *                              sign-in from another machine then redirects back
 *                              to it and finishes on its own; without it, the
 *                              person pastes back the address the browser ended
 *                              on. Loopback needs no entry.
 *
 * These may also live in a `.env` file next to this config (gitignored); real
 * environment variables win over values from the file.
 */
const envFile = require('node:path').join(__dirname, '.env')
if (require('node:fs').existsSync(envFile)) process.loadEnvFile(envFile)

/**
 * The Bun binary as an absolute path. pm2 spawns its interpreter without a
 * shell, so on Windows a bare `bun` that is only an npm .cmd shim fails with
 * ENOENT while pm2 still lists the app as online. `BUN_BIN` wins; otherwise
 * PATH is searched for the real executable, including the binary an npm
 * global install keeps beside its shim.
 */
function resolveBun() {
  if (process.env.BUN_BIN) return process.env.BUN_BIN
  const fs = require('node:fs')
  const path = require('node:path')
  const exe = process.platform === 'win32' ? 'bun.exe' : 'bun'
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const candidate of [path.join(dir, exe), path.join(dir, 'node_modules', 'bun', 'bin', exe)]) {
      if (fs.existsSync(candidate)) return candidate
    }
  }
  return 'bun'
}

const port = process.env.PORT || '3082'
const allowedHosts = (process.env.DNT_HARNESS_ALLOWED_HOSTS || '').trim()
const oauthOrigins = (process.env.DNT_HARNESS_OAUTH_ORIGINS || '').trim()

module.exports = {
  apps: [
    {
      name: 'dnt-harness',
      cwd: __dirname,
      script: 'src/bins/web.ts',
      args: `--port ${port} --root .${allowedHosts ? ` --allowed-host ${allowedHosts}` : ''}${oauthOrigins ? ` --oauth-origin ${oauthOrigins}` : ''}`,
      interpreter: resolveBun(),
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 15_000,
      // Bun holds ~20% more RSS than Node on the same data; 3G caused restart loops.
      max_memory_restart: '4G',
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
}
