import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createWebServer } from '../../src/web/server.ts'
import type { SessionId, WorkspaceId } from '../../src/util/brand.ts'

it('filters parent snapshot and live replay, resumes by cursor, and preserves default clients', async () => {
  // A temp provider store keeps the host off the user's real providers.json.
  const root = await fs.mkdtemp(path.join(tmpdir(), 'session-load-perf-'))
  const server = await createWebServer({ providers: [], configFile: path.join(root, 'providers.json') })
  try {
    const wid = 'default'
    const session = server.kernel.ctx.sessions.create(wid as WorkspaceId)
    session.append({ type: 'user/message', turnId: 'turn' as import('../../src/util/brand.ts').TurnId, content: 'full default replay' })
    session.append({ type: 'agent/child-spawn', childSessionId: 'child', parentTurnId: 'turn', definition: 'worker', brief: 'brief' })
    const url = `${server.url}/api/workspaces/${wid}/sessions/${session.id}/events`
    async function frame(query: string) {
      const response = await fetch(url + query)
      const reader = response.body!.getReader()
      let text = ''
      while (!text.includes('\n\n')) text += new TextDecoder().decode((await reader.read()).value)
      await reader.cancel()
      const data = text.split('\n').find(line => line.startsWith('data: '))!
      return { text, envelope: JSON.parse(data.slice(6)) }
    }
    const filtered = await frame('?view=delegations')
    expect(filtered.envelope.events.map((event: { type: string }) => event.type)).toEqual(['agent/child-spawn'])
    expect(filtered.text).toContain('id: 2')
    expect((await frame('')).envelope.events).toHaveLength(2)
    expect((await frame('?cursor=2')).envelope).toEqual({ kind: 'resume', events: [] })
    expect((await frame('?cursor=999')).envelope.kind).toBe('snapshot')
    expect(server.kernel.ctx.sessions.get(session.id as SessionId).events).toHaveLength(2)
    const live = await fetch(url + '?view=delegations&cursor=2')
    const reader = live.body!.getReader()
    await reader.read() // initial empty resume
    session.append({ type: 'user/message', turnId: 'turn' as import('../../src/util/brand.ts').TurnId, content: 'must not leak into parent view' })
    session.append({ type: 'agent/child-result', childSessionId: 'child', parentTurnId: 'turn', status: 'completed' })
    const chunk = new TextDecoder().decode((await reader.read()).value)
    expect(chunk).toContain('agent/child-result')
    expect(chunk).not.toContain('must not leak')
    await reader.cancel()
  } finally { await server.close(); await fs.rm(root, { recursive: true, force: true }) }
})
