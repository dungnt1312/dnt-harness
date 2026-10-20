#!/usr/bin/env node
// Vitest + Undici 7 require Node >= 22.19.0. Fail fast with an actionable message.
const MIN = [22, 19, 0]
const current = process.versions.node.split('.').map(Number)
const ok = current[0] !== MIN[0] ? current[0] > MIN[0] : current[1] !== MIN[1] ? current[1] > MIN[1] : current[2] >= MIN[2]
if (process.versions.bun) {
  console.error('node-preflight: run under Node, not Bun (Vitest is the Node test runner here).')
  process.exit(1)
}
if (!ok) {
  console.error(`node-preflight: Node ${process.versions.node} at ${process.execPath} is unsupported; need >= ${MIN.join('.')}.`)
  console.error('Put a Node >= 22.19 first on PATH (e.g. C:\\laragon\\bin\\nodejs\\node-v22.20.0-win-x64) and re-run.')
  process.exit(1)
}
console.log(`node-preflight: Node ${process.versions.node} OK (${process.execPath})`)
