// E2E fake gateway for dnt-harness wire tests.
//
// Speaks just enough OpenAI chat-completions SSE for the real adapter, with
// modes that reproduce gateway faults deterministically:
//   plain              — one text answer (sanity)
//   resend-before-args — re-sends the tool-call header (fresh id) before any
//                        argument text; the SR-1 fix must tolerate it
//   resend-after-args  — re-sends the header after arguments started; must
//                        stay a hard `conflicting tool ID` failure
//   flaky-then-ok      — first request answers HTTP 500, later ones succeed;
//                        proves the session affinity survives a step retry
//   null-id-continuation — the live opencode-relayed shape: the header carries
//                        a real id, every continuation fragment repeats it as
//                        `id: null` with a blank name
//   multi-null-id      — two parallel calls (indexes arrive out of order) whose
//                        interleaved continuation fragments all use the live
//                        `id: null`/blank-name shape
//   placeholder-then-id — a blank id placeholder arrives first; the real
//                        identity shows up on a later fragment
//   http-400           — every request answers HTTP 400 with a structured JSON
//                        error body; the surfaced turn message must carry the
//                        relay's excerpt, and a 400 must never be retried
//
// Usage: node fake-gateway.mjs <port> <mode>
// Env:   E2E_LOG           — JSONL request log path
import http from 'node:http'
import fs from 'node:fs'

const port = Number(process.argv[2] ?? 6790)
const mode = process.argv[3] ?? 'plain'
const logFile = process.env['E2E_LOG']

let reqNo = 0

const chunk = (res, obj) => {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* client gone */ }
}
const delta = (d, finish) => ({ choices: [{ index: 0, delta: d, ...(finish !== undefined ? { finish_reason: finish } : {}) }] })
const usageChunk = () => ({
  choices: [],
  usage: { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132, prompt_tokens_details: { cached_tokens: 0 } },
})
const header = (id) => delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name: 'Glob', arguments: '' } }] })
const args = (text) => delta({ tool_calls: [{ index: 0, function: { arguments: text } }] })
const text = (content) => delta({ content })
const role = () => delta({ role: 'assistant' })

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
const sendText = (res, content) => {
  res.writeHead(200, SSE_HEADERS)
  chunk(res, role())
  chunk(res, text(content))
  chunk(res, delta({}, 'stop'))
  chunk(res, usageChunk())
  try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
  res.end()
}
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  let raw = ''
  req.on('data', (b) => { raw += b })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* log what we can */ }
    const n = ++reqNo
    const messages = Array.isArray(body.messages) ? body.messages : []
    const assistantIds = messages
      .filter((m) => m['role'] === 'assistant' && Array.isArray(m['tool_calls']))
      .flatMap((m) => m['tool_calls'].map((t) => t['id']))
    if (logFile !== undefined) {
      fs.appendFileSync(logFile, `${JSON.stringify({
        req: n,
        url: req.url,
        model: body['model'],
        affinity: String(req.headers['x-session-affinity'] ?? ''),
        assistantIds,
        roles: messages.map((m) => m['role']),
      })}\n`)
    }
    switch (mode) {
      case 'plain':
        sendText(res, 'e2e-plain-ok')
        break
      case 'resend-before-args':
        if (n === 1) {
          res.writeHead(200, SSE_HEADERS)
          chunk(res, role())
          chunk(res, header('call_a'))
          chunk(res, header('call_b')) // re-sent header, fresh id, no args yet
          chunk(res, args('{"pattern":"*"}'))
          chunk(res, delta({}, 'tool_calls'))
          chunk(res, usageChunk())
          try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
          res.end()
        } else {
          sendText(res, 'e2e-after-resend')
        }
        break
      case 'resend-after-args':
        if (n === 1) {
          res.writeHead(200, SSE_HEADERS)
          chunk(res, role())
          chunk(res, header('call_a'))
          chunk(res, args('{"pat'))
          chunk(res, header('call_b')) // header re-sent after arguments started
          chunk(res, args('tern":"*"}'))
          chunk(res, delta({}, 'tool_calls'))
          chunk(res, usageChunk())
          try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
          res.end()
        } else {
          sendText(res, 'e2e-after-resend-after-args')
        }
        break
      case 'null-id-continuation':
        // The exact live shape: the header carries a real id, every
        // continuation fragment repeats it as `null` with a blank name.
        if (n === 1) {
          res.writeHead(200, SSE_HEADERS)
          chunk(res, role())
          chunk(res, delta({ tool_calls: [{ index: 0, id: 'call_real', type: 'function', function: { name: 'Glob', arguments: '' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: '{"' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: 'pattern' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: '":"*"}' } }] }))
          chunk(res, delta({}, 'tool_calls'))
          chunk(res, usageChunk())
          try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
          res.end()
        } else {
          sendText(res, 'e2e-null-id-ok')
        }
        break
      case 'multi-null-id':
        // Two parallel calls: the headers arrive out of order and every
        // continuation fragment carries the live `id: null`/blank-name shape.
        if (n === 1) {
          res.writeHead(200, SSE_HEADERS)
          chunk(res, role())
          chunk(res, delta({ tool_calls: [{ index: 1, id: 'call_two', type: 'function', function: { name: 'Glob', arguments: '' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name: 'Glob', arguments: '' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: '{"' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 1, id: null, type: null, function: { name: '', arguments: '{"' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 1, id: null, type: null, function: { name: '', arguments: 'pattern' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: 'pattern' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: null, type: null, function: { name: '', arguments: '":"e2e-multi-a"}' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 1, id: null, type: null, function: { name: '', arguments: '":"e2e-multi-b"}' } }] }))
          chunk(res, delta({}, 'tool_calls'))
          chunk(res, usageChunk())
          try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
          res.end()
        } else {
          sendText(res, 'e2e-multi-ok')
        }
        break
      case 'placeholder-then-id':
        // A blank id placeholder arrives first; the real identity shows up on a
        // later fragment. Only the real id may reach the wire.
        if (n === 1) {
          res.writeHead(200, SSE_HEADERS)
          chunk(res, role())
          chunk(res, delta({ tool_calls: [{ index: 0, id: '', function: { name: 'Glob', arguments: '' } }] }))
          chunk(res, delta({ tool_calls: [{ index: 0, id: 'call_late', function: { arguments: '{"pattern":"e2e-late"}' } }] }))
          chunk(res, delta({}, 'tool_calls'))
          chunk(res, usageChunk())
          try { res.write('data: [DONE]\n\n') } catch { /* client gone */ }
          res.end()
        } else {
          sendText(res, 'e2e-late-ok')
        }
        break
      case 'http-400':
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end('{"error":{"type":"unknown","message":"injected relay rejection: bad tool sequence"}}')
        break
      case 'flaky-then-ok':
        if (n === 1) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end('{"error":{"message":"injected transient upstream failure"}}')
        } else {
          sendText(res, 'e2e-after-retry')
        }
        break
      default:
        sendText(res, `e2e-unknown-mode:${mode}`)
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-gateway listening on ${port} mode=${mode}\n`)
})
