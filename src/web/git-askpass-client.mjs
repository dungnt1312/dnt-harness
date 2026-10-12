#!/usr/bin/env node
/**
 * Askpass client (Zed `askpass::main` / `main_from_args`): send the prompt to
 * the session socket and print the answer. Remaining arguments are the prompt
 * (joined with NUL); without any, the prompt is read from stdin, which is how
 * the generated `askpass.sh` passes it. Never prints anything but the answer.
 */
import net from 'node:net'

const argv = process.argv.slice(2)
const flag = argv.findIndex((arg) => arg.startsWith('--askpass='))
if (flag < 0) {
  process.stderr.write('askpass: missing --askpass=<socket>\n')
  process.exit(1)
}
const socket = argv[flag].slice('--askpass='.length)
const args = argv.filter((_, index) => index !== flag)

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = []
    process.stdin.on('data', (chunk) => chunks.push(chunk))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)))
    process.stdin.on('error', reject)
  })
}

function fail(message) {
  process.stderr.write(`askpass: ${message}\n`)
  process.exit(1)
}

let prompt
try {
  prompt = args.length > 0 ? Buffer.from(args.join('\0'), 'utf8') : await readStdin()
} catch (error) {
  fail(`error reading from stdin: ${error instanceof Error ? error.message : String(error)}`)
}
if (prompt.at(-1) !== 0) prompt = Buffer.concat([prompt, Buffer.from([0])])

const response = []
const stream = net.createConnection(socket)
stream.on('error', (error) => fail(`socket ${socket}: ${error.message}`))
stream.on('connect', () => stream.write(prompt))
stream.on('data', (chunk) => response.push(chunk))
stream.on('end', () => {
  process.stdout.write(Buffer.concat(response), (error) => {
    if (error) fail('error writing to stdout')
  })
})
