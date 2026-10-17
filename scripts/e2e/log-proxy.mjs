// E2E logging reverse proxy: forwards /v1/* to the real local gateway and
// records, per request, exactly the wire surface the SR work is about —
// affinity header, body field names (max_tokens vs max_completion_tokens),
// `store`, `stream_options`, `prompt_cache_key`, `reasoning_effort` and any
// provider-option keys that must NOT appear.
//
// Usage: node log-proxy.mjs <port> <upstreamBase>
// Env:   E2E_LOG      — JSONL request log path
//        E2E_SSE_DIR  — per-response SSE tee dir (sse-<n>.jsonl)
//        E2E_REQ_DIR  — per-request body capture dir (req-<n>.json /
//                       res-<n>.json) so a failing live request can be
//                       replayed byte-for-byte afterwards
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

const port = Number(process.argv[2] ?? 6797)
const upstream = process.argv[3] ?? 'http://127.0.0.1:6536'
const logFile = process.env['E2E_LOG']
const sseDir = process.env['E2E_SSE_DIR']
const reqDir = process.env['E2E_REQ_DIR']
if (reqDir !== undefined) fs.mkdirSync(reqDir, { recursive: true })
let reqNo = 0
let captureNo = 0

const observed = ['tool_choice', 'parallel_tool_calls', 'response_format', 'stop', 'temperature', 'top_p', 'seed']

const server = http.createServer(async (req, res) => {
  let raw = Buffer.alloc(0)
  for await (const part of req) raw = Buffer.concat([raw, part])
  let body = null
  try { body = JSON.parse(raw.toString('utf8')) } catch { /* non-JSON passthrough */ }
  if (logFile !== undefined && body !== null) {
    const entry = {
      url: req.url,
      method: req.method,
      affinity: String(req.headers['x-session-affinity'] ?? ''),
      model: body['model'],
      keys: Object.keys(body).sort(),
      max_tokens: body['max_tokens'],
      max_completion_tokens: body['max_completion_tokens'],
      store: body['store'],
      include_usage: body['stream_options']?.['include_usage'],
      prompt_cache_key: body['prompt_cache_key'],
      reasoning_effort: body['reasoning_effort'],
      foreign: observed.filter((key) => key in body),
    }
    fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`)
  }
  let captureId
  if (reqDir !== undefined && body !== null) {
    captureId = ++captureNo
    fs.writeFileSync(path.join(reqDir, `req-${captureId}.json`), JSON.stringify({ url: req.url, method: req.method, affinity: String(req.headers['x-session-affinity'] ?? ''), body }))
  }
  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': String(req.headers['content-type'] ?? 'application/json'),
        ...(req.headers['authorization'] !== undefined ? { authorization: String(req.headers['authorization']) } : {}),
      },
      ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: raw }),
    })
    res.writeHead(upstreamRes.status, {
      'content-type': upstreamRes.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-cache',
    })
    if (captureId !== undefined) fs.writeFileSync(path.join(reqDir, `res-${captureId}.json`), JSON.stringify({ status: upstreamRes.status }))
    let teeFile
    if (sseDir !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      reqNo += 1
      teeFile = path.join(sseDir, `sse-${reqNo}.jsonl`)
      fs.appendFileSync(teeFile, `${JSON.stringify({ status: upstreamRes.status, 'content-type': upstreamRes.headers.get('content-type') })}\n`)
    }
    if (upstreamRes.body !== null) {
      for await (const part of Readable.fromWeb(upstreamRes.body)) {
        if (teeFile !== undefined) fs.appendFileSync(teeFile, `${JSON.stringify({ chunk: Buffer.from(part).toString('utf8') })}\n`)
        res.write(part)
      }
    }
    res.end()
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `log-proxy upstream failure: ${error instanceof Error ? error.message : String(error)}` } }))
  }
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`log-proxy listening on ${port} -> ${upstream}\n`)
})
