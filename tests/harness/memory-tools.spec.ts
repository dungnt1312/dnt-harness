import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryService } from 'dnt-harness'
import { agentScope } from '../../src/harness/agent/scope.ts'
import { memoryTools } from '../../src/harness/memory/tools.ts'
import type { ProjectId, SessionId, WorkspaceId } from '../../src/util/brand.ts'

const homes: string[] = []

async function setup(): Promise<{ home: string; memory: MemoryService }> {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-memory-tools-'))
  homes.push(home)
  return { home, memory: new MemoryService(home) }
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })))
})

describe('memory tools', () => {
  it('exposes the full sha256 on create, read, and update', async () => {
    const { memory } = await setup()
    const tools = new Map(memoryTools(memory).map((tool) => [tool.name, tool]))
    const workspaceId = 'ws-test' as WorkspaceId
    const projectId = 'project-test' as ProjectId
    const scope = { sessionId: 'session-test' as SessionId, workspaceId, projectId }

    await agentScope.run(scope, async () => {
      const created = await tools.get('MemoryCreate')!.execute({ id: 'smoke', title: 'Title', body: 'Body' }, { root: '' })
      const hash = /sha256 ([a-f0-9]{64})/.exec(created)?.[1]
      expect(hash).toHaveLength(64)

      const read = await tools.get('MemoryRead')!.execute({ id: 'smoke' }, { root: '' })
      expect(read).toContain(`[sha256 ${hash}]`)

      const updated = await tools.get('MemoryUpdate')!.execute(
        { id: 'smoke', body: 'Updated', expectedHash: hash },
        { root: '' },
      )
      expect(updated).toMatch(/sha256 [a-f0-9]{64}/)
    })
  })

  it('rejects a blank update before publication and preserves the valid entry', async () => {
    const { memory } = await setup()
    const scope = { workspaceId: 'ws-test' as WorkspaceId, projectId: 'project-test' as ProjectId }
    const created = await memory.create(scope, { id: 'preserved', title: 'Valid', body: 'Keep me' })

    await expect(memory.update(scope, {
      id: 'preserved',
      title: ' ',
      body: ' ',
      expectedHash: created.hash,
    })).rejects.toThrow(/non-empty title and body/)

    const after = await memory.read(scope, 'preserved')
    expect(after.title).toBe('Valid')
    expect(after.body).toBe('Keep me')
    expect(after.hash).toBe(created.hash)
  })

  it('rejects truncated update hashes at the tool boundary', async () => {
    const { memory } = await setup()
    const update = memoryTools(memory).find((tool) => tool.name === 'MemoryUpdate')!
    await agentScope.run({ sessionId: 'session-test' as SessionId, workspaceId: 'ws-test' as WorkspaceId }, async () => {
      await expect(update.execute({ id: 'smoke', expectedHash: 'abc123' }, { root: '' }))
        .rejects.toThrow(/must be a SHA-256 hash from MemoryRead/)
    })
  })
})
