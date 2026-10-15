import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUNDLED_MODES } from '../../src/harness/modes/bundled.ts'
import { canonicalCall } from '../../src/harness/tools/names.ts'
import { patchReceipt } from '../../src/capabilities/fs/patch.ts'
import { fsTools, type ToolExecution } from 'dnt-harness'
import { FileObservations } from '../../src/capabilities/fs/observation.ts'
import { targetPaths } from '../../src/capabilities/fs/grants.ts'

let root: string
let exec: ToolExecution
const tools = new Map(fsTools().map((tool) => [tool.name, tool]))
const run = (name: string, args: Record<string, unknown>) => {
  const tool = tools.get(name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool.execute(args, exec)
}
const patch = (body: string) => run('ApplyPatch', { patch_text: `*** Begin Patch\n${body}\n*** End Patch` })
const put = async (name: string, content: string | Buffer) => {
  await fs.writeFile(path.join(root, name), content)
  await run('Read', { path: name })
}
const read = (name: string) => fs.readFile(path.join(root, name), 'utf8')
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'apply-patch-'))
  exec = { root, sessionId: 'patch-session' as never, observations: new FileObservations() }
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('ApplyPatch', () => {
  it('exposes canonical identity and conservative mode permissions', () => {
    expect(canonicalCall({ id: 'a', name: 'apply_patch', args: {} }).name).toBe('ApplyPatch')
    for (const mode of BUNDLED_MODES) {
      expect(mode.toolExposure.includes('ApplyPatch')).toBe(mode.id !== 'plan')
      if (mode.id !== 'plan') expect(mode.permissionDefaults['ApplyPatch']).toBe(['autonomous', 'full-access'].includes(mode.id) ? 'allow' : 'ask')
    }
  })
  it('retains landed receipts when a later filesystem operation fails', async () => {
    await put('a', 'a\n')
    await put('b', 'b\n')
    const unlink = fs.unlink.bind(fs)
    const spy = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (String(file) === path.join(root, 'b')) throw new Error('simulated I/O failure')
      return unlink(file)
    })
    let error = ''
    try { await patch('*** Delete File: a\n*** Delete File: b') } catch (caught) { error = String(caught) } finally { spy.mockRestore() }
    expect(patchReceipt(error)?.files.map((file) => file.path)).toEqual(['a'])
    expect(patchReceipt(error)?.error).toContain('simulated I/O failure')
    expect(await read('b')).toBe('b\n')
    await expect(read('a')).rejects.toThrow()
  })
  it('checks symlink escapes and read-only grants before any mutation', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'patch-out-'))
    try {
      await fs.writeFile(path.join(outside, 'a'), 'outside\n')
      await fs.symlink(outside, path.join(root, 'link'))
      await expect(patch('*** Delete File: link/a')).rejects.toThrow()
      exec = { ...exec, additionalRoots: [{ path: outside, access: 'read' }] }
      await expect(patch(`*** Add File: ${path.join(outside, 'new')}\n+no`)).rejects.toThrow()
      expect(await fs.readFile(path.join(outside, 'a'), 'utf8')).toBe('outside\n')
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })
  it('preserves executable mode on move and never publishes a partially written add', async () => {
    await put('exec', 'old\n')
    await fs.chmod(path.join(root, 'exec'), 0o755)
    await patch('*** Update File: exec\n*** Move to: moved\n@@\n-old\n+new')
    expect((await fs.stat(path.join(root, 'moved'))).mode & 0o777).toBe(0o755)
    const link = fs.link.bind(fs)
    const spy = vi.spyOn(fs, 'link').mockImplementation(async (from, to) => {
      if (String(to) === path.join(root, 'new')) throw new Error('publication failed')
      return link(from, to)
    })
    try { await expect(patch('*** Add File: new\n+content')).rejects.toThrow(/publication failed/) } finally { spy.mockRestore() }
    await expect(read('new')).rejects.toThrow()
    expect((await fs.readdir(root)).some((name) => name.startsWith('.patch-'))).toBe(false)
  })
  it('supports insertion/deletion and does not introduce a final newline', async () => {
    await put('a', 'one\nlast')
    await patch('*** Update File: a\n@@\n one\n+middle\n last')
    expect(await read('a')).toBe('one\nmiddle\nlast')
    await patch('*** Update File: a\n@@\n-middle\n last')
    expect(await read('a')).toBe('one\nlast')
  })
  it('applies distant hunks once and preserves a missing final newline', async () => {
    await put('a.ts', 'one\nkeep\nthree')
    const output = await patch('*** Update File: a.ts\n@@\n-one\n+ONE\n@@\n-three\n+THREE')
    expect(await read('a.ts')).toBe('ONE\nkeep\nTHREE')
    expect(output).toContain('"type":"update"')
    await run('Edit', { path: 'a.ts', old: 'THREE', new: '3' })
  })
  it('supports add, delete and move with edits in one call', async () => {
    await put('old.txt', 'old\n')
    await put('gone.txt', 'gone\n')
    await patch('*** Add File: nested/new.txt\n+hello\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-old\n+new\n*** Delete File: gone.txt')
    expect(await read('nested/new.txt')).toBe('hello\n')
    expect(await read('moved.txt')).toBe('new\n')
    await expect(read('gone.txt')).rejects.toThrow()
    await expect(read('old.txt')).rejects.toThrow()
  })
  it('verifies every file and every hunk before any mutation', async () => {
    await put('a', 'a\n')
    await put('b', 'b\n')
    await expect(patch('*** Update File: a\n@@\n-a\n+A\n*** Update File: b\n@@\n-missing\n+B')).rejects.toThrow(/not found/)
    expect(await read('a')).toBe('a\n')
    await expect(patch('*** Update File: a\n@@\n-a\n+A\n@@\n-missing\n+x')).rejects.toThrow()
    expect(await read('a')).toBe('a\n')
  })
  it('requires Read and refuses stale observations, including deletes', async () => {
    await fs.writeFile(path.join(root, 'a'), 'a\n')
    await expect(patch('*** Delete File: a')).rejects.toThrow(/never read/)
    await run('Read', { path: 'a' })
    await fs.writeFile(path.join(root, 'a'), 'external\n')
    await expect(patch('*** Delete File: a')).rejects.toThrow(/changed/)
    expect(await read('a')).toBe('external\n')
  })
  it('rejects ambiguous and whitespace-only approximate matches', async () => {
    await put('a', 'same\nsame\n')
    await expect(patch('*** Update File: a\n@@\n-same\n+new')).rejects.toThrow(/ambiguous/)
    await put('b', '  value\n')
    await expect(patch('*** Update File: b\n@@\n-value\n+new')).rejects.toThrow(/not found/)
  })
  it('uses @@ context to disambiguate and End of File to anchor', async () => {
    await put('a', 'first\nsame\nsecond\nsame\n')
    await patch('*** Update File: a\n@@ second\n-same\n+last\n*** End of File')
    expect(await read('a')).toBe('first\nsame\nsecond\nlast\n')
  })
  it('preserves BOM, UTF-16 and mixed line endings outside changed lines', async () => {
    await put('a', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\r\nkeep\ntwo\r\n', 'utf16le')]))
    await patch('*** Update File: a\n@@\n keep\n-two\n+TWO')
    const bytes = await fs.readFile(path.join(root, 'a'))
    expect(bytes).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\r\nkeep\nTWO\r\n', 'utf16le')]))
  })
  it('never overwrites existing add or move destinations', async () => {
    await put('a', 'a\n')
    await put('b', 'b\n')
    await expect(patch('*** Add File: b\n+new')).rejects.toThrow(/exists/)
    await expect(patch('*** Update File: a\n*** Move to: b\n@@\n-a\n+A')).rejects.toThrow(/exists/)
    expect(await read('a')).toBe('a\n')
    expect(await read('b')).toBe('b\n')
  })
  it('rejects duplicate paths and symlink aliases', async () => {
    await put('a', 'a\n')
    await expect(patch('*** Delete File: a\n*** Add File: a\n+new')).rejects.toThrow(/duplicate/)
    await fs.symlink(path.join(root, 'a'), path.join(root, 'alias'))
    await expect(patch('*** Delete File: a\n*** Delete File: alias')).rejects.toThrow(/duplicate/)
    expect(await read('a')).toBe('a\n')
  })
  it('checks all source/destination grants and denies escapes before writing', async () => {
    await put('a', 'a\n')
    await expect(patch('*** Update File: a\n@@\n-a\n+A\n*** Add File: ../escape\n+bad')).rejects.toThrow()
    expect(await read('a')).toBe('a\n')
    expect(targetPaths({ name: 'ApplyPatch', args: { patch_text: '*** Begin Patch\n*** Update File: a\n*** Move to: b\n@@\n-a\n+A\n*** End Patch' } })).toEqual([{ target: 'a', intent: 'write' }, { target: 'b', intent: 'write' }])
  })
  it.each(['', '*** Begin Patch\n*** End Patch', '*** Begin Patch\n*** Update File: a\n@@\nwat\n*** End Patch', 'junk\n*** Begin Patch\n*** Delete File: a\n*** End Patch'])('rejects malformed or empty patch: %s', async (patch_text) => {
    await expect(run('ApplyPatch', { patch_text })).rejects.toThrow()
  })
  it('honors cancellation before mutations', async () => {
    await put('a', 'a\n')
    exec = { ...exec, signal: AbortSignal.abort() }
    await expect(patch('*** Delete File: a')).rejects.toThrow(/cancel/)
    expect(await read('a')).toBe('a\n')
  })
})
