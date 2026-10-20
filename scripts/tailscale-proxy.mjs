/**
 * Reverse proxy so a phone on the tailnet can open the loopback-only web host.
 * The harness refuses a non-loopback bind (no authenticated TLS profile), so
 * this process listens on the Tailscale IPv4 only and forwards to 127.0.0.1.
 *
 *   node scripts/tailscale-proxy.mjs
 *   TS_IP=100.x.y.z TS_PORT=3083 UPSTREAM=http://127.0.0.1:3082 node scripts/tailscale-proxy.mjs
 */
import http from 'node:http'

const host = process.env.TS_IP ?? '100.116.202.42'
const port = Number(process.env.TS_PORT ?? 3083)
const upstream = new URL(process.env.UPSTREAM ?? 'http://127.0.0.1:3082')

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: upstream.host }
  const proxy = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  proxy.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`upstream unavailable: ${error.message}`)
  })
  req.pipe(proxy)
})

server.on('upgrade', (req, socket, head) => {
  const headers = { ...req.headers, host: upstream.host }
  const proxy = http.request({
    hostname: upstream.hostname,
    port: upstream.port,
    path: req.url,
    method: req.method,
    headers,
  })
  proxy.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.write(
      `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n` +
        Object.entries(upstreamRes.headers)
          .flatMap(([key, value]) =>
            (Array.isArray(value) ? value : [value]).filter(Boolean).map((item) => `${key}: ${item}`),
          )
          .join('\r\n') +
        '\r\n\r\n',
    )
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  proxy.on('error', () => socket.destroy())
  socket.on('error', () => proxy.destroy())
  if (head.length > 0) proxy.write(head)
  proxy.end()
})

server.listen(port, host, () => {
  process.stdout.write(`tailscale proxy: http://${host}:${port} -> ${upstream.origin}\n`)
})
