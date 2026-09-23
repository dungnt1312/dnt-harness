/**
 * Dry-run or apply the v1 → v2 MCP migration for one workspace.
 *
 *   npx tsx src/bins/migrate-mcp.ts --data-dir <home> --workspace <id> [--apply]
 *
 * Without `--apply` the command only prints the plan. It does not open a
 * network connection, spawn a server, or rewrite config.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { applyMigration, dryRunMigration } from '../harness/mcp/migration.ts'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function main(): Promise<void> {
  const dataDir = arg('--data-dir')
  const workspace = arg('--workspace')
  if (dataDir === undefined || workspace === undefined) {
    process.stderr.write('usage: migrate-mcp --data-dir <home> --workspace <id> [--apply]\n')
    process.exitCode = 2
    return
  }
  const file = path.join(dataDir, 'workspaces', workspace, 'mcp.json')
  const raw = await fs.readFile(file, 'utf8')
  if (!process.argv.includes('--apply')) {
    const report = dryRunMigration(raw)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return
  }
  const plan = await applyMigration(dataDir, workspace, raw)
  process.stdout.write(`${JSON.stringify({ applied: true, actions: plan.actions }, null, 2)}\n`)
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
