import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fsTools, type ToolExecution } from 'mini-dsh'
import { FileObservations, replaceFile } from '../../src/capabilities/fs/observation.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-fs-conflict-'))
  roots.push(root)
  const tools = new Map(fsTools().map((tool) => [tool.name, tool]))
  const invoke = (name: string, args: Record<string, unknown>, exec: ToolExecution) => tools.get(name)!.execute(args, exec)
  const observations = new FileObservations()
  const a = { root, sessionId: 'root-a' as never, observations }
  const b = { root, sessionId: 'root-b' as never, observations }
  return { root, invoke, a, b }
}

describe('optimistic native file mutations', () => {
  it('a ranged read observes the whole file; a sibling change makes overwrite conflict', async () => {
    const { root, invoke, a, b } = await setup()
    await fs.writeFile(path.join(root, 'note.txt'), 'one\ntwo\nthree\n')
    expect(await invoke('Read', { path: 'note.txt', offset: 2, limit: 1 }, a)).toBe('2\ttwo\n… [showing lines 2-2 of 3; continue with offset 3]')
    await invoke('Read', { path: 'note.txt' }, b)
    await invoke('Write', { path: 'note.txt', content: 'from b' }, b)
    await expect(invoke('Write', { path: 'note.txt', content: 'from a' }, a)).rejects.toThrow(/conflict.*re-read/i)
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('from b')
  })

  it('refuses overwriting a file never observed by the executing session', async () => {
    const { root, invoke, a } = await setup()
    await fs.writeFile(path.join(root, 'note.txt'), 'original')
    await expect(invoke('Write', { path: 'note.txt', content: 'blind' }, a)).rejects.toThrow(/conflict.*read it before/i)
    await expect(invoke('Edit', { path: 'note.txt', old: 'original', new: 'blind' }, a)).rejects.toThrow(/conflict.*read it before/i)
    expect(await fs.readFile(path.join(root, 'note.txt'), 'utf8')).toBe('original')
  })

  it('two concurrent creates of one path never silently overwrite each other', async () => {
    const { root, invoke, a, b } = await setup()
    const results = await Promise.allSettled([
      invoke('Write', { path: 'same.txt', content: 'A' }, a),
      invoke('Write', { path: 'same.txt', content: 'B' }, b),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect(['A', 'B']).toContain(await fs.readFile(path.join(root, 'same.txt'), 'utf8'))
  })

  it('a failed publication keeps the previous bytes and leaves no temporary file', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'mini-dsh-replace-'))
    roots.push(root)
    const target = path.join(root, 'occupied')
    // Publishing over a directory path fails; the directory must survive and
    // no `.occupied.tmp-*` debris may remain beside it.
    await fs.mkdir(path.join(target, 'inner'), { recursive: true })
    await expect(replaceFile(target, 'payload')).rejects.toThrow()
    expect((await fs.readdir(root)).filter((name) => name.includes('.tmp-'))).toEqual([])
    expect((await fs.stat(target)).isDirectory()).toBe(true)
  })

  it('a stale explicit hash never overwrites bytes another writer just published', async () => {
    const { root, invoke, a } = await setup()
    await fs.writeFile(path.join(root, 'appeared.txt'), 'first writer')
    // Another writer publishes its own bytes; `a` only holds the OLD hash.
    await fs.writeFile(path.join(root, 'appeared.txt'), 'mine')
    await expect(invoke('Write', { path: 'appeared.txt', content: 'from a', expectedSha256: shaOfContent('first writer') }, a)).rejects.toThrow(/conflict/)
    expect(await fs.readFile(path.join(root, 'appeared.txt'), 'utf8')).toBe('mine')
  })
})

function shaOfContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
