import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { MutationStore } from '../../src/harness/mcp/mutation-store.ts'

it.each(['', '{"kind":"commit","id":"previous","at":0}\n'])('removes a torn mutation tail before the next append (prefix=%s)', async (prefix) => {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-mutation-tail-'))
  try {
    await fs.writeFile(path.join(home, 'mcp-mutations.jsonl'), `${prefix}{"kind":"intent"`)
    const store = new MutationStore(home)
    expect(await store.recover()).toEqual([])
    const id = await store.begin({ mutation: 'config', workspaceId: 'ws', target: path.join(home, 'config.json'), backup: undefined })
    await store.commit(id)
    expect(await new MutationStore(home).recover()).toEqual([])
  } finally { await fs.rm(home, { recursive: true, force: true }) }
})
