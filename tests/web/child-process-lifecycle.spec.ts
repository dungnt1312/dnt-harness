import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer, type LlmProvider } from 'dnt-harness'

it('completed child retains its owner process; cancel stops it and persists exit without rewriting result', async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-child-process-'))
  let calls = 0
  const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() {
    if (calls++ === 0) {
      yield { type: 'toolCalls', calls: [{ id: 'run', name: 'Bash', args: { command: 'sleep 60', run_in_background: true } }] }
      yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
    } else {
      yield { type: 'delta', delta: 'done; command still running' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    }
  } }
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'config.json') })
  const post = (p: string, body: unknown) => fetch(server.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const ws = (await (await fetch(server.url + '/api/workspaces')).json())[0].id
    await fetch(`${server.url}/api/workspaces/${ws}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const project = await (await post(`/api/workspaces/${ws}/projects`, { path: process.cwd() })).json()
    const root = await (await post(`/api/workspaces/${ws}/sessions`, { projectId: project.id })).json()
    const child = await (await post(`/api/workspaces/${ws}/agents/worker`, { rootSessionId: root.id, task: { prompt: 'Start command', requiredResult: 'status' }, grantTools: ['Bash'] })).json()
    await fetch(`${server.url}/api/workspaces/${ws}/sessions/${root.id}/children/${child.childSessionId}?waitMs=5000`)
    const rows = await (await fetch(`${server.url}/api/workspaces/${ws}/sessions/${child.childSessionId}/processes`)).json()
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('running')
    const session = await server.kernel.ctx.sessions.load(child.childSessionId)
    expect(session.events.filter(e => e.type === 'process/start')).toHaveLength(1)
    await post(`/api/workspaces/${ws}/sessions/${root.id}/children/${child.childSessionId}/cancel`, {})
    expect((await (await fetch(`${server.url}/api/workspaces/${ws}/sessions/${child.childSessionId}/processes`)).json())[0].status).toBe('killed')
    expect(session.events.filter(e => e.type === 'process/exit')).toHaveLength(1)
    expect(session.events.filter(e => e.type === 'turn/end').at(-1)).toMatchObject({ reason: 'completed' })
  } finally { await server.close(); await fs.rm(home, { recursive: true, force: true }) }
}, 20_000)

for (const scenario of ['allowed', 'grant', 'plan', 'policy', 'cancel-active', 'child-max'] as const) {
  it(`worker shell lifecycle respects ${scenario}`, async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-child-policy-'))
    const marker = path.join(home, 'marker')
    let calls = 0
    const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() {
      if (calls++ === 0) {
        yield { type: 'toolCalls', calls: [{ id: 'run', name: 'Bash', args: { command: scenario === 'cancel-active' || scenario === 'child-max' ? 'sleep 60' : `echo allowed > '${marker}'`, run_in_background: scenario === 'cancel-active' || scenario === 'child-max' } }] }
        yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
      } else if (scenario === 'cancel-active') { await new Promise(resolve => setTimeout(resolve, 500)); yield { type: 'delta', delta: 'done' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } }
      else { yield { type: 'delta', delta: 'done' }; yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true } }
    } }
    const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'config.json'), ...(scenario === 'policy' ? { blockedTools: ['Bash'] } : {}), limits: { subagentBackgroundBashMaxMs: 50 } })
    const post = (p: string, body: unknown) => fetch(server.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    try {
      const ws = (await (await fetch(server.url + '/api/workspaces')).json())[0].id
      await fetch(`${server.url}/api/workspaces/${ws}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: scenario === 'plan' ? 'plan' : 'full-access' }) })
      const project = await (await post(`/api/workspaces/${ws}/projects`, { path: process.cwd() })).json()
      const root = await (await post(`/api/workspaces/${ws}/sessions`, { projectId: project.id })).json()
      const child = await (await post(`/api/workspaces/${ws}/agents/worker`, { rootSessionId: root.id, task: { prompt: 'Run specified command', requiredResult: 'status' }, ...(scenario === 'grant' ? { grantTools: ['Read'] } : { grantTools: ['Bash'] }) })).json()
      const log = await server.kernel.ctx.sessions.load(child.childSessionId)
      if (scenario === 'cancel-active') {
        const deadline = Date.now() + 5000
        while (!log.events.some(e => e.type === 'process/start') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        expect(log.events.some(e => e.type === 'process/start')).toBe(true)
        const response = await post(`/api/workspaces/${ws}/sessions/${root.id}/children/${child.childSessionId}/cancel`, {})
        expect(response.status).toBe(200)
      } else await fetch(`${server.url}/api/workspaces/${ws}/sessions/${root.id}/children/${child.childSessionId}?waitMs=5000`)
      if (scenario === 'allowed') expect(await fs.readFile(marker, 'utf8')).toContain('allowed')
      else if (scenario === 'grant' || scenario === 'plan' || scenario === 'policy') {
        expect(await fs.stat(marker).catch(() => null)).toBeNull()
        expect(JSON.stringify(log.events)).toMatch(/does not expose|denies|denied/)
      } else {
        const deadline = Date.now() + 5000
        while (!log.events.some(e => e.type === 'process/exit') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        expect(log.events.filter(e => e.type === 'process/exit')).toHaveLength(1)
        expect(log.events.find(e => e.type === 'process/exit')).toMatchObject({ termination: 'killed' })
      }
    } finally { await server.close(); await fs.rm(home, { recursive: true, force: true }) }
  }, 20_000)
}

it('root deletion cleans retained completed-child processes', async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-delete-child-'))
  let calls = 0
  const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() {
    if (calls++ === 0) {
      yield { type: 'toolCalls', calls: [{ id: 'run', name: 'Bash', args: { command: 'sleep 60', run_in_background: true } }] }
      yield { type: 'completion', finishReason: 'tool_calls', transport: 'done', policy: 'strict', transportSettled: true }
    } else {
      yield { type: 'delta', delta: 'done' }
      yield { type: 'completion', finishReason: 'stop', transport: 'done', policy: 'strict', transportSettled: true }
    }
  } }
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'config.json') })
  const post = (p: string, body: unknown) => fetch(server.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const ws = (await (await fetch(server.url + '/api/workspaces')).json())[0].id
    await fetch(`${server.url}/api/workspaces/${ws}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const project = await (await post(`/api/workspaces/${ws}/projects`, { path: process.cwd() })).json()
    const root = await (await post(`/api/workspaces/${ws}/sessions`, { projectId: project.id })).json()
    const child = await (await post(`/api/workspaces/${ws}/agents/worker`, { rootSessionId: root.id, task: { prompt: 'Run', requiredResult: 'status' } })).json()
    await fetch(`${server.url}/api/workspaces/${ws}/sessions/${root.id}/children/${child.childSessionId}?waitMs=5000`)
    const r = server.kernel.ctx.get('processes') as { runningCount(id: never): number }
    expect(r.runningCount(child.childSessionId as never)).toBe(1)
    expect((await fetch(`${server.url}/api/workspaces/${ws}/sessions/${root.id}`, { method: 'DELETE' })).status).toBe(200)
    expect(r.runningCount(child.childSessionId as never)).toBe(0)
  } finally { await server.close(); await fs.rm(home, { recursive: true, force: true }) }
}, 20000)

it('first SSE read does not invent interrupted exit while real exit persistence is queued', async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-exit-bridge-'))
  const server = await createWebServer({ home, configFile: path.join(home, 'config.json') })
  try {
    const ws = (await (await fetch(server.url + '/api/workspaces')).json())[0].id
    const response = await fetch(`${server.url}/api/workspaces/${ws}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const root = await response.json()
    const session = await server.kernel.ctx.sessions.load(root.id)
    session.append({ type: 'process/start', processId: 'proc_delayed', command: 'true', cwd: process.cwd() })
    await session.durable()
    // Model a process whose registry already knows the terminal outcome, while
    // its real exit event is still waiting for the serialized bridge.
    const r = server.kernel.ctx.get('processes') as { read: (session: never, id: string) => unknown }
    const original = r.read.bind(r)
    r.read = (id, proc) => proc === 'proc_delayed' ? { status: 'exited', exitCode: 0, output: '' } : original(id, proc)
    const stream = await fetch(`${server.url}/api/workspaces/${ws}/sessions/${root.id}/events`)
    const reader = stream.body!.getReader()
    await reader.read(); await reader.cancel()
    expect(session.events.filter(e => e.type === 'process/exit')).toHaveLength(0)
  } finally { await server.close(); await fs.rm(home, { recursive: true, force: true }) }
}, 20000)

for (const invalid of [0, -1, NaN, Infinity]) {
  it(`invalid background limit ${invalid} retains default`, async () => {
    const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-invalid-limit-'))
    const server = await createWebServer({ home, configFile: path.join(home, 'config.json'), limits: { subagentBackgroundBashMaxMs: invalid } })
    try { expect(server.kernel.ctx.get('limits')).toMatchObject({ subagentBackgroundBashMaxMs: 3600000 }) }
    finally { await server.close(); await fs.rm(home, { recursive: true, force: true }) }
  })
}
