#!/usr/bin/env node
/**
 * Per-tool failure rates from durable session logs.
 *
 *   node scripts/tool-health.mjs [--data <dir>] [--since <ISO date>] [--tools Read,Write,Edit]
 *
 * Scans every `events.jsonl` under the data dir (default ~/.dnt-harness/data),
 * pairs `tool/call` with `tool/result`, and buckets failures by message.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const option = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? undefined : argv[index + 1]
}
const dataDir = option('data') ?? path.join(os.homedir(), '.dnt-harness', 'data')
const since = option('since') !== undefined ? Date.parse(option('since')) : 0
const toolFilter = new Set((option('tools') ?? 'Read,Write,Edit').split(','))

const CATEGORIES = [
  ['not found', /not found in/],
  ['ambiguous', /ambiguous edit|matches \d+ places/],
  ['never read', /never read/],
  ['changed since read', /changed (on disk|after)/],
  ['no such file', /no such file/],
  ['binary / encoding', /binary|not valid UTF-8/],
  ['outside grants', /escapes the workspace|application-internal|outside/],
  ['bad arguments', /argument '|must be a/],
  ['no change', /identical/],
  ['recovery', /outcome unknown|interrupted/],
]

async function* logs(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* logs(full)
    else if (entry.name === 'events.jsonl') yield full
  }
}

function resultText(event) {
  const value = event.output ?? event.result ?? event.content
  return typeof value === 'string' ? value : JSON.stringify(value ?? '')
}

function isError(event, text) {
  if (typeof event.ok === 'boolean') return !event.ok
  return event.isError === true || event.error !== undefined || /^error: /.test(text)
}

const stats = new Map()
let sessions = 0
for await (const file of logs(dataDir)) {
  sessions++
  const calls = new Map()
  const text = await fs.readFile(file, 'utf8')
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof event.timestamp === 'number' && event.timestamp < since) continue
    if (event.type === 'tool/call' && event.call !== undefined) calls.set(event.call.id, event.call.name)
    if (event.type !== 'tool/result') continue
    const name = calls.get(event.callId ?? event.call?.id ?? event.id) ?? event.name ?? event.call?.name
    if (name === undefined || !toolFilter.has(name)) continue
    const entry = stats.get(name) ?? { calls: 0, failed: 0, categories: new Map() }
    entry.calls++
    const body = resultText(event)
    if (isError(event, body)) {
      entry.failed++
      const category = CATEGORIES.find(([, pattern]) => pattern.test(body))?.[0] ?? 'other'
      entry.categories.set(category, (entry.categories.get(category) ?? 0) + 1)
    }
    stats.set(name, entry)
  }
}

console.log(`${sessions} session log(s) under ${dataDir}${since > 0 ? ` since ${new Date(since).toISOString()}` : ''}\n`)
for (const [name, entry] of [...stats].sort()) {
  const rate = entry.calls === 0 ? 0 : (100 * entry.failed) / entry.calls
  console.log(`${name.padEnd(6)} ${String(entry.calls).padStart(6)} calls  ${String(entry.failed).padStart(5)} failed  ${rate.toFixed(1)}%`)
  for (const [category, count] of [...entry.categories].sort((a, b) => b[1] - a[1])) {
    console.log(`         ${String(count).padStart(5)}  ${category}`)
  }
}
