/**
 * pm2 ecosystem for the dnt-harness web host.
 *
 *   pm2 start ecosystem.config.cjs
 *
 * Runs the web bin through tsx so the session log, tools, and SSE stream are
 * live; serve the built client first (npm run build:web).
 */
module.exports = {
  apps: [
    {
      name: 'dnt-harness',
      cwd: __dirname,
      script: 'node_modules/tsx/dist/cli.mjs',
      args: 'src/bins/web.ts --port 3082 --root .',
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
