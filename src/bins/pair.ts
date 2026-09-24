/**
 * Mint a fresh single-use pairing code from the running web server:
 *
 *   npm run pair [-- --data-dir <dir>]
 *
 * The server publishes an operator channel (its URL and a random key) in
 * `<data-dir>/auth/operator.json` while control-plane auth is on. Reading
 * that file requires the OS user that runs the host, so this is the recovery
 * path when the startup code expired or a browser lost its session. The code
 * is printed once and is never passed on a command line or in a URL.
 */
import { homedir } from 'node:os'
import path from 'node:path'
import { OPERATOR_HEADER, readOperatorChannel } from '../web/operator-channel.ts'

function dataDirFrom(argv: readonly string[]): string {
  const index = argv.indexOf('--data-dir')
  const explicit = index >= 0 ? argv[index + 1] : undefined
  return explicit ?? path.join(homedir(), '.mini-dsh', 'data')
}

async function main(): Promise<void> {
  const dataDir = dataDirFrom(process.argv.slice(2))
  let channel
  try {
    channel = await readOperatorChannel(dataDir)
  } catch {
    process.stderr.write(`no running web server with control-plane auth publishes an operator channel under ${dataDir}\n`)
    process.exitCode = 1
    return
  }
  const response = await fetch(`${channel.url}/api/auth/pairing-code`, {
    method: 'POST',
    headers: { [OPERATOR_HEADER]: channel.key },
  }).catch((error: unknown) => {
    process.stderr.write(`the web server at ${channel.url} did not answer: ${String(error instanceof Error ? error.message : error)}\n`)
    return undefined
  })
  if (response === undefined) {
    process.exitCode = 1
    return
  }
  if (!response.ok) {
    process.stderr.write(`the web server refused a pairing code (HTTP ${response.status}); restart it if the operator file is stale\n`)
    process.exitCode = 1
    return
  }
  const issued = await response.json() as { code: string; expiresAt: number }
  const minutes = Math.max(1, Math.round((issued.expiresAt - Date.now()) / 60_000))
  process.stdout.write(`pairing code (single use, expires in ${minutes} minutes): ${issued.code}\n`)
}

void main()
