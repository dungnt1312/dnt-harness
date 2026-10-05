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
      args: 'src/bins/web.ts --port 3082 --root . --allowed-host 100.120.204.10,dungnts-mac-mini.tail034a88.ts.net,dungnts-mac-mini,harness.smarttraffic.today',
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
    {
      // Cloudflare Tunnel for harness.smarttraffic.today -> 127.0.0.1:3082.
      // Ingress lives in ~/.cloudflared/dnt-harness.yml; Zero Trust (Cloudflare
      // Access) policies are attached to that hostname in the CF dashboard.
      name: 'dnt-harness-tunnel',
      cwd: __dirname,
      script: '/opt/homebrew/bin/cloudflared',
      args: 'tunnel --config /Users/dungnt/.cloudflared/dnt-harness.yml run dnt-harness',
      interpreter: 'none',
      exec_mode: 'fork',
      instances: 1,
      kill_timeout: 10_000,
      max_memory_restart: '500M',
      autorestart: true,
    },
  ],
}
