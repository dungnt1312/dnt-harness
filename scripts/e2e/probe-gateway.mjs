// Control probe for the live gateway — the baseline that isolates relay-side
// flake from anything the harness does. Sends a minimal, well-formed
// OpenAI-compatible chat request (streaming, tool schema, reasoning effort,
// usage) N times directly to the endpoint and counts non-200 responses.
//
// Measured use (2026-10-17, deepseek-v4.1-flash-free via the opencode proxy):
// 24/24 HTTP 200 — while the same endpoint intermittently answered a relay 400
// ("Upstream request failed: Invalid request parameters…") to harness runs.
// See plans/261016-implementation-report.md §4.7.
//
// Usage: node scripts/e2e/probe-gateway.mjs [N]
// Env:   E2E_UPSTREAM — gateway base URL (default http://127.0.0.1:6536)
//        E2E_MODEL    — model id (default deepseek-v4.1-flash-free)
const upstream = process.env['E2E_UPSTREAM'] ?? 'http://127.0.0.1:6536'
const model = process.env['E2E_MODEL'] ?? 'deepseek-v4.1-flash-free'
const n = Number(process.argv[2] ?? 24)

const body = {
  model,
  messages: [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: 'Read marker.txt, then list the workspace files with Glob, then reply with how many tool calls you made.' },
  ],
  stream: true,
  stream_options: { include_usage: true },
  reasoning_effort: 'medium',
  tools: [{
    type: 'function',
    function: {
      name: 'Glob',
      description: 'List files matching a pattern',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
    },
  }],
}

let fails = 0
for (let i = 1; i <= n; i++) {
  const started = Date.now()
  try {
    const res = await fetch(`${upstream}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.status === 200) {
      const text = await res.text()
      process.stdout.write(`probe ${i}/${n}: 200 (${Date.now() - started}ms, ${text.length}b, done=${text.includes('[DONE]')})\n`)
    } else {
      fails += 1
      const text = (await res.text()).slice(0, 220)
      process.stdout.write(`probe ${i}/${n}: HTTP ${res.status} (${Date.now() - started}ms) body=${JSON.stringify(text)}\n`)
    }
  } catch (error) {
    fails += 1
    process.stdout.write(`probe ${i}/${n}: network error ${String(error).slice(0, 160)}\n`)
  }
}
process.stdout.write(`\n=== control probe: ${n - fails}/${n} ok, ${fails} failed ===\n`)
