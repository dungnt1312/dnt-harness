#!/usr/bin/env node
/** MCP 2025-06-18 fixture: newline-delimited JSON-RPC over stdio. */
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)

let listings = 0
// LIST_CHANGED_EVERY_MS: keep announcing tools/list_changed, so a refresh is nearly always in flight.
const listChangedEvery = Number(process.env.LIST_CHANGED_EVERY_MS ?? 0)
if (listChangedEvery > 0) {
  setInterval(() => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`), listChangedEvery)
}

rl.on('line', async (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method === 'initialize') {
    if (process.env.INIT_FILE) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.INIT_FILE, `${process.pid}\n`, 'utf8')
    }
    const initDelay = Number(process.env.INIT_DELAY_MS ?? 0)
    if (initDelay > 0) await new Promise((resolve) => setTimeout(resolve, initDelay))
    send(msg.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0' } })
    return
  }
  if (msg.method === 'tools/list') {
    // LIST_FILE logs every listing; LIST_DELAY_MS slows every listing after the first.
    if (process.env.LIST_FILE) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.LIST_FILE, `${process.pid}\n`, 'utf8')
    }
    listings += 1
    const listDelay = Number(process.env.LIST_DELAY_MS ?? 0)
    if (listings > 1 && listDelay > 0) await new Promise((resolve) => setTimeout(resolve, listDelay))
    send(msg.id, { tools: [
      // QUERY_PROP renames the argument, so two configs can expose different schemas under one tool name.
      { name: 'query', description: 'Query fixture data', inputSchema: { type: 'object', properties: { [process.env.QUERY_PROP ?? 'q']: { type: 'string' } }, required: [process.env.QUERY_PROP ?? 'q'] }, annotations: { readOnlyHint: true } },
      { name: 'interactive', description: 'Needs user interaction', inputSchema: { type: 'object', properties: {} }, annotations: { requiresUserInteraction: true } },
      { name: 'explode', description: 'Return isError', inputSchema: { type: 'object', properties: {} } },
      { name: 'hang', description: 'Never reply (timeout fixture)', inputSchema: { type: 'object', properties: {} } },
    ] })
    if (process.env.BURN_AFTER_LIST === '1') {
      setImmediate(() => {
        for (;;) Math.sqrt(Math.random())
      })
    }
    // A short CPU burst, then idle: the watchdog must not treat it as sustained.
    const burstMs = Number(process.env.BURN_FOR_MS ?? 0)
    if (burstMs > 0) {
      setImmediate(() => {
        const until = Date.now() + burstMs
        while (Date.now() < until) Math.sqrt(Math.random())
      })
    }
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    // The remote side effect, recorded before any reply leaves (or does not).
    if (process.env.SIDE_EFFECT_FILE) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.SIDE_EFFECT_FILE, process.env.SIDE_EFFECT_PID === '1' ? `${name} ${process.pid}\n` : `${name}\n`, 'utf8')
    }
    if (name === 'query') send(msg.id, { content: [{ type: 'text', text: `result:${msg.params?.arguments?.q ?? ''}` }], isError: false })
    else if (name === 'interactive') send(msg.id, { content: [{ type: 'text', text: 'interactive ok' }], isError: false })
    else if (name === 'explode') send(msg.id, { content: [{ type: 'text', text: 'fixture error' }], isError: true })
    else if (name === 'hang') { /* deliberately no reply */ }
    else if (name === 'env') send(msg.id, { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env)) }], isError: false })
    else fail(msg.id, -32601, `unknown tool ${name}`)
  }
})
