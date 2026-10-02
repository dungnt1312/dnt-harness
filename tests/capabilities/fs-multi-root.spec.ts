/**
 * Multi-root grants for the file tools: a primary root plus additional
 * read-only / read-write folders. Covers resolution (relative → primary,
 * absolute → longest containing root), access enforcement, out-of-grant
 * errors that touch no filesystem, UNC/device refusal, junction escapes
 * from an additional root, approved one-shot paths, and Glob/Grep output
 * that feeds back into Read without leaving the grants.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  classifyTarget,
  fsTools,
  OutOfGrantError,
  targetPaths,
  type GrantedRoot,
  type ToolDefinition,
  type ToolExecution,
} from 'dnt-harness'

let base = ''
let primary = ''
let shared = ''
let docs = ''
let outside = ''
let tools: Map<string, ToolDefinition>

beforeAll(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-multiroot-')))
  primary = path.join(base, 'primary')
  shared = path.join(base, 'shared')
  docs = path.join(base, 'docs')
  outside = path.join(base, 'outside')
  for (const dir of [primary, shared, path.join(shared, 'locked'), docs, outside]) await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(shared, 'lib.ts'), 'export const shared = 1\n', 'utf8')
  await fs.writeFile(path.join(shared, 'locked', 'keep.ts'), 'keep\n', 'utf8')
  await fs.writeFile(path.join(docs, 'guide.md'), 'needle in docs\n', 'utf8')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8')
  tools = new Map(fsTools().map((tool) => [tool.name, tool]))
})

afterAll(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

function tool(name: string): ToolDefinition {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`test setup: missing tool '${name}'`)
  return definition
}

const grants = (): GrantedRoot[] => [
  { path: shared, access: 'write' },
  { path: path.join(shared, 'locked'), access: 'read' },
  { path: docs, access: 'read' },
]

function exec(extra: Partial<ToolExecution> = {}): ToolExecution {
  return { root: primary, additionalRoots: grants(), ...extra }
}

describe('multi-root file grants', () => {
  it('relative paths still resolve against the primary root', async () => {
    await tool('Write').execute({ path: 'a.txt', content: 'primary' }, exec())
    expect(await fs.readFile(path.join(primary, 'a.txt'), 'utf8')).toBe('primary')
  })

  it('absolute paths inside a read-write additional root read and write', async () => {
    expect(await tool('Read').execute({ path: path.join(shared, 'lib.ts') }, exec())).toContain('shared = 1')
    await tool('Edit').execute({ path: path.join(shared, 'lib.ts'), old: '1', new: '2' }, exec())
    expect(await fs.readFile(path.join(shared, 'lib.ts'), 'utf8')).toContain('shared = 2')
  })

  it('a read-only root is readable but refuses writes, and the longest containing root wins', async () => {
    expect(await tool('Read').execute({ path: path.join(docs, 'guide.md') }, exec())).toContain('needle')
    await expect(tool('Write').execute({ path: path.join(docs, 'new.md'), content: 'x' }, exec())).rejects.toThrow(/read-only granted folder/)
    // locked/ is a read-only folder nested inside the read-write shared root.
    await expect(tool('Edit').execute({ path: path.join(shared, 'locked', 'keep.ts'), old: 'keep', new: 'x' }, exec())).rejects.toThrow(/read-only granted folder/)
    expect(await tool('Read').execute({ path: path.join(shared, 'locked', 'keep.ts') }, exec())).toContain('keep')
  })

  it('a nested read-only folder cannot be written through a link or a Windows-normalized name', async () => {
    // A junction inside the read-write root that points into its read-only child.
    await fs.symlink(path.join(shared, 'locked'), path.join(shared, 'alias'), 'junction')
    await expect(tool('Edit').execute({ path: path.join(shared, 'alias', 'keep.ts'), old: 'keep', new: 'x' }, exec()))
      .rejects.toThrow(/different granted folder|read-only granted folder/)
    if (process.platform === 'win32') {
      // `locked.` is `locked` on disk; it must not classify as the parent root.
      await expect(tool('Edit').execute({ path: `${path.join(shared, 'locked')}.\\keep.ts`, old: 'keep', new: 'x' }, exec())).rejects.toThrow(/dot or space/)
      await expect(tool('Write').execute({ path: `${path.join(shared, 'locked')} \\new.ts`, content: 'x' }, exec())).rejects.toThrow(/dot or space/)
    }
    expect(await fs.readFile(path.join(shared, 'locked', 'keep.ts'), 'utf8')).toBe('keep\n')
  })

  it('a path outside every grant throws OutOfGrantError without touching the filesystem', async () => {
    const stat = vi.spyOn(fs, 'stat')
    const realpath = vi.spyOn(fs, 'realpath')
    try {
      const target = path.join(outside, 'secret.txt')
      const error = await tool('Read').execute({ path: target }, exec()).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(OutOfGrantError)
      expect(String(error)).toMatch(/escapes the workspace root/)
      expect(stat).not.toHaveBeenCalled()
      expect(realpath).not.toHaveBeenCalled()
    } finally {
      stat.mockRestore()
      realpath.mockRestore()
    }
  })

  it('UNC, device, and reserved-name paths are refused lexically', async () => {
    const stat = vi.spyOn(fs, 'stat')
    try {
      for (const target of ['\\\\attacker.example\\share\\x', '//attacker.example/share/x', '\\\\?\\C:\\x', '\\\\.\\pipe\\x']) {
        await expect(tool('Read').execute({ path: target }, exec())).rejects.toThrow(/network \(UNC\) and device paths/)
      }
      if (process.platform === 'win32') {
        await expect(tool('Read').execute({ path: 'NUL.txt' }, exec())).rejects.toThrow(/reserved device name/)
        await expect(tool('Write').execute({ path: 'sub/con', content: 'x' }, exec())).rejects.toThrow(/reserved device name/)
      }
      expect(stat).not.toHaveBeenCalled()
    } finally {
      stat.mockRestore()
    }
    const unc = classifyTarget(exec(), '\\\\host\\s\\x', 'read')
    expect(unc.kind).toBe('blocked')
  })

  it('a junction inside an additional root that points outside is refused, not approvable', async () => {
    await fs.symlink(outside, path.join(shared, 'leak'), 'junction')
    await expect(tool('Read').execute({ path: path.join(shared, 'leak', 'secret.txt') }, exec())).rejects.toThrow(/escapes the workspace root/)
    expect(classifyTarget(exec(), path.join(shared, 'leak', 'secret.txt'), 'read').kind).toBe('in-grant')
  })

  it('denied roots inside an additional root stay refused', async () => {
    const internal = path.join(shared, '.internal')
    await fs.mkdir(internal, { recursive: true })
    await fs.writeFile(path.join(internal, 'log.jsonl'), '{}', 'utf8')
    await expect(tool('Read').execute({ path: path.join(internal, 'log.jsonl') }, exec({ deniedRoots: [internal] }))).rejects.toThrow(/application-internal storage/)
  })

  it('an approved out-of-grant path works for exactly that path and intent', async () => {
    const target = path.join(outside, 'secret.txt')
    const approved = exec({ approvedPaths: [{ path: target, intent: 'read' }] })
    expect(await tool('Read').execute({ path: target }, approved)).toContain('outside')
    await expect(tool('Write').execute({ path: target, content: 'x' }, approved)).rejects.toBeInstanceOf(OutOfGrantError)
    await expect(tool('Read').execute({ path: path.join(outside, 'other.txt') }, approved)).rejects.toBeInstanceOf(OutOfGrantError)
    const writable = exec({ approvedPaths: [{ path: path.join(outside, 'new.txt'), intent: 'write' }] })
    await tool('Write').execute({ path: path.join(outside, 'new.txt'), content: 'ok' }, writable)
    expect(await fs.readFile(path.join(outside, 'new.txt'), 'utf8')).toBe('ok')
  })

  it('an approved path that resolves through a link is refused', async () => {
    const linkDir = path.join(base, 'linked')
    await fs.symlink(outside, linkDir, 'junction')
    const target = path.join(linkDir, 'secret.txt')
    await expect(tool('Read').execute({ path: target }, exec({ approvedPaths: [{ path: target, intent: 'read' }] }))).rejects.toThrow(/resolves through a link/)
  })

  it('Grep and Glob print absolute paths outside the primary that Read accepts back', async () => {
    const grep = await tool('Grep').execute({ pattern: 'needle', path: docs }, exec())
    const hit = grep.split('\n')[0] ?? ''
    const file = hit.slice(0, hit.lastIndexOf(':', hit.lastIndexOf(':') - 1))
    expect(path.isAbsolute(file)).toBe(true)
    expect(await tool('Read').execute({ path: file }, exec())).toContain('needle')

    const glob = await tool('Glob').execute({ pattern: '*.md', path: docs }, exec())
    expect(glob.split('\n')).toContain(path.join(docs, 'guide.md'))
    const inPrimary = await tool('Glob').execute({ pattern: '*.txt' }, exec())
    expect(inPrimary.split('\n')).toContain('a.txt')
  })

  it('targetPaths reports the paths and intent of file-tool calls', () => {
    expect(targetPaths({ name: 'Write', args: { path: 'x', content: '' } })).toEqual([{ target: 'x', intent: 'write' }])
    expect(targetPaths({ name: 'Grep', args: { pattern: 'x' } })).toEqual([{ target: '.', intent: 'read' }])
    expect(targetPaths({ name: 'Bash', args: { command: 'ls' } })).toEqual([])
  })
})
