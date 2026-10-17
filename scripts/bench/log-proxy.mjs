/**
 * Dev-only logging reverse proxy for the benchmark: forwards /v1/* to an
 * upstream OpenAI-compatible endpoint and appends every request body and the
 * raw (SSE) response to a log file. Used to see exactly what the model sends.
 *
 *   node scripts/bench/log-proxy.mjs 6537 http://127.0.0.1:6536 logs.txt
 */
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 6537)
const upstream = new URL(process.argv[3] ?? 'http://127.0.0.1:6536')
const logFile = process.argv[4] ?? 'proxy.log'

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks)
    if (req.method === 'POST' && body.length > 0) {
      try {
        const json = JSON.parse(body.toString('utf8'))
        appendFileSync(logFile, `\n===== REQUEST ${new Date().toISOString()} ${req.url} =====\n${JSON.stringify({ model: json.model, messages: json.messages, tools: (json.tools ?? []).map((t) => t.function?.name), stream: json.stream, reasoning_effort: json.reasoning_effort, thinking: json.thinking }, null, 2)}\n`)
      } catch { /* not json */ }
    }
    const proxy = http.request(
      { hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: { ...req.headers, host: upstream.host } },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        let buffered = ''
        if (req.method === 'POST' && (upstreamRes.headers['content-type'] ?? '').includes('event-stream')) {
          appendFileSync(logFile, `----- RESPONSE STREAM -----\n`)
          upstreamRes.on('data', (d) => {
            buffered += d.toString('utf8')
            for (const line of buffered.split('\n').slice(0, -1)) {
              if (line.startsWith('data:') && line.includes('tool_calls')) appendFileSync(logFile, `${line}\n`)
            }
            buffered = buffered.split('\n').slice(-1)[0] ?? ''
            res.write(d)
          })
          upstreamRes.on('end', () => res.end())
        } else {
          upstreamRes.pipe(res)
        }
      },
    )
    proxy.on('error', (error) => { if (!res.headersSent) res.writeHead(502); res.end(`upstream: ${error.message}`) })
    proxy.write(body)
    proxy.end()
  })
})

server.listen(port, '127.0.0.1', () => process.stdout.write(`log-proxy http://127.0.0.1:${port} -> ${upstream.origin} (log: ${logFile})\n`))
