import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer, type LlmProvider } from 'dnt-harness'

it('shutdown fences a pending agent command before joining the runner', async () => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-shutdown-'))
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const provider: LlmProvider = { name: 'scripted', models: ['scripted'], async *stream() {
    entered(); await gate
    yield { type: 'toolCalls', calls: [{ id: 'late', name: 'Bash', args: { command: 'sleep 60', run_in_background: true } }] }
  } }
  const server = await createWebServer({ home, providers: [provider], configFile: path.join(home, 'config.json') })
  const post = (p: string, body: unknown) => fetch(server.url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const ws = (await (await fetch(server.url + '/api/workspaces')).json())[0].id
    await fetch(`${server.url}/api/workspaces/${ws}/mode`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ modeId: 'full-access' }) })
    const project = await (await post(`/api/workspaces/${ws}/projects`, { path: process.cwd() })).json()
    const root = await (await post(`/api/workspaces/${ws}/sessions`, { projectId: project.id })).json()
    await post(`/api/workspaces/${ws}/sessions/${root.id}/messages`, { content: 'run' })
    await started
    const r = server.kernel.ctx.get('processes') as { runningCount(id: never): number; canRegister(id: never): { ok: boolean } }
    const closing = server.close(); release(); await closing
    expect(r.canRegister(root.id as never)).toMatchObject({ ok: false })
    expect(r.runningCount(root.id as never)).toBe(0)
  } finally { release(); await fs.rm(home, { recursive: true, force: true }) }
}, 20000)
