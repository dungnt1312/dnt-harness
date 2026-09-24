#!/usr/bin/env node
/** MCP 2025-06-18 fixture: newline-delimited JSON-RPC over stdio. */
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const send = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)

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
    send(msg.id, { tools: [
      { name: 'query', description: 'Query fixture data', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true } },
      { name: 'interactive', description: 'Needs user interaction', inputSchema: { type: 'object', properties: {} }, annotations: { requiresUserInteraction: true } },
      { name: 'explode', description: 'Return isError', inputSchema: { type: 'object', properties: {} } },
      { name: 'hang', description: 'Never reply (timeout fixture)', inputSchema: { type: 'object', properties: {} } },
    ] })
    if (process.env.BURN_AFTER_LIST === '1') {
      setImmediate(() => {
        for (;;) Math.sqrt(Math.random())
      })
    }
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    // The remote side effect, recorded before any reply leaves (or does not).
    if (process.env.SIDE_EFFECT_FILE) {
      const { appendFileSync } = await import('node:fs')
      appendFileSync(process.env.SIDE_EFFECT_FILE, `${name}\n`, 'utf8')
    }
    if (name === 'query') send(msg.id, { content: [{ type: 'text', text: `result:${msg.params?.arguments?.q ?? ''}` }], isError: false })
    else if (name === 'interactive') send(msg.id, { content: [{ type: 'text', text: 'interactive ok' }], isError: false })
    else if (name === 'explode') send(msg.id, { content: [{ type: 'text', text: 'fixture error' }], isError: true })
    else if (name === 'hang') { /* deliberately no reply */ }
    else fail(msg.id, -32601, `unknown tool ${name}`)
  }
})
