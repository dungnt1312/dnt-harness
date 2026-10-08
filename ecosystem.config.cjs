/**
 * pm2 ecosystem for the dnt-harness web host.
 *
 *   pm2 start ecosystem.config.cjs
 *
 * Runs the web bin through tsx so the session log, tools, and SSE stream are
 * live; serve the built client first (npm run build:web).
 *
 * Optional environment variables (read when pm2 loads this file):
 *   PORT                    listen port (default 3082)
 *   DNT_HARNESS_ALLOWED_HOSTS  comma-separated extra Host names/IPs the server
 *                              should answer to, e.g. a LAN IP or reverse-proxy
 *                              hostname. Loopback and the bind host are always
 *                              allowed.
 *
 * These may also live in a `.env` file next to this config (gitignored); real
 * environment variables win over values from the file.
 */
const envFile = require('node:path').join(__dirname, '.env')
if (require('node:fs').existsSync(envFile)) process.loadEnvFile(envFile)

const port = process.env.PORT || '3082'
const allowedHosts = (process.env.DNT_HARNESS_ALLOWED_HOSTS || '').trim()

module.exports = {
  apps: [
    {
      name: 'dnt-harness',
      cwd: __dirname,
      script: 'node_modules/tsx/dist/cli.mjs',
      args: `src/bins/web.ts --port ${port} --root .${allowedHosts ? ` --allowed-host ${allowedHosts}` : ''}`,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 15_000,
      max_memory_restart: '3G',
      autorestart: true,
      env: {
        NODE_ENV: 'development',
      },
    },
  ],
}
