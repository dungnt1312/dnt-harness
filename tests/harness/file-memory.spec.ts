import { afterEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryService } from '../../src/harness/memory/service.ts'
import { classifyTarget, resolveInGrants } from '../../src/capabilities/fs/grants.ts'
import { fsTools } from '../../src/capabilities/fs/tools.ts'
import type { WorkspaceId, ProjectId } from '../../src/util/brand.ts'

const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true }))) })
async function setup() {
  const home = await fs.mkdtemp(path.join(tmpdir(), 'file-memory-'))
  homes.push(home)
  const memory = new MemoryService(home)
  const scope = { workspaceId: 'ws' as WorkspaceId, projectId: 'one' as ProjectId }
  return { home, memory, scope }
}

it('prepare fast path skips topic reads when a regular index exists and preserves its text', async () => {
  const { memory, scope } = await setup()
  const root = memory.root(scope)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'note.md'), '---\ntitle: Note\n---\n\nTopic body\n')
  const indexText = 'Agent index\n'
  await fs.writeFile(path.join(root, 'MEMORY.md'), indexText)
  const readFile = vi.spyOn(fs, 'readFile')
  try {
    await memory.prepare(scope)
    expect(readFile).not.toHaveBeenCalled()
  } finally {
    readFile.mockRestore()
  }
  expect(await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8')).toBe(indexText)
})

it('migrates legacy entries once, preserves existing index and exposes direct authored files', async () => {
  const { memory, scope } = await setup()
  const created = await memory.create(scope, { id: 'old', title: 'Original', body: 'Legacy body', pinned: true })
  const root = memory.root(scope)
  await fs.writeFile(path.join(root, 'MEMORY.md'), 'Agent index\n')
  await fs.writeFile(path.join(root, 'new.md'), '---\nname: New note\ndescription: Hook\ncustom: keep-me\nmetadata:\n  type: feedback\n  source: agent\n---\n\nDirect edit\n')
  await memory.prepare(scope)
  await memory.prepare(scope)
  expect(await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8')).toBe('Agent index\n')
  expect((await memory.read(scope, 'old')).body).toBe('Legacy body')
  expect((await memory.read(scope, 'old')).createdAt).toBe(created.createdAt)
  expect((await memory.read(scope, 'new')).title).toBe('New note')
  // metadata.type surfaces so the settings tree can show the kind; create() stamps `reference`.
  expect((await memory.read(scope, 'new')).type).toBe('feedback')
  expect((await memory.read(scope, 'old')).type).toBe('reference')
  await fs.writeFile(path.join(root, 'bare.md'), '---\ntitle: Bare\n---\n\nNo kind\n')
  expect((await memory.read(scope, 'bare')).type).toBeUndefined()
  expect((await memory.search(scope, 'Direct'))[0]?.id).toBe('new')
  const updated = await memory.update(scope, { id: 'new', body: 'Edited through API', expectedHash: (await memory.read(scope, 'new')).hash })
  expect(await fs.readFile(path.join(root, 'new.md'), 'utf8')).toContain('type: feedback\n  source: agent')
  expect(await fs.readFile(path.join(root, 'new.md'), 'utf8')).toContain('custom: keep-me')
  await fs.writeFile(path.join(root, 'new.md'), 'Changed by agent')
  await expect(memory.update(scope, { id: 'new', body: 'Stale edit', expectedHash: updated.hash })).rejects.toMatchObject({ code: 'conflict' })
})

it('refuses linked memory ancestry and a linked index', async () => {
  const { home, memory, scope } = await setup()
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'memory-outside-'))
  homes.push(outside)
  await fs.mkdir(path.join(home, 'workspaces'), { recursive: true })
  await fs.symlink(outside, path.join(home, 'workspaces', 'ws'))
  await expect(memory.prepare(scope)).rejects.toMatchObject({ code: 'scope' })
  await expect(memory.index(scope)).rejects.toMatchObject({ code: 'scope' })
  await fs.rm(path.join(home, 'workspaces', 'ws'))
  await memory.prepare(scope)
  await fs.writeFile(path.join(outside, 'index.md'), 'outside secret')
  await fs.rm(path.join(memory.root(scope), 'MEMORY.md'))
  await fs.symlink(path.join(outside, 'index.md'), path.join(memory.root(scope), 'MEMORY.md'))
  await expect(memory.index(scope)).rejects.toMatchObject({ code: 'scope' })
})

it('bounds Unicode index to both 200 lines and 25KiB, without splitting UTF-8', async () => {
  const { memory, scope } = await setup()
  const root = memory.root(scope)
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, 'MEMORY.md'), Array(300).fill('🍀'.repeat(100)).join('\n'))
  const text = await memory.index(scope)
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(25 * 1024)
  expect(text.includes('�')).toBe(false)
  expect(text).toContain('WARNING')
})

it('file tools browse scoped memory roots without browsing app home', async () => {
  const { home, memory, scope } = await setup()
  await memory.prepare(scope)
  const root = memory.root(scope)
  const project = await fs.mkdtemp(path.join(tmpdir(), 'memory-project-'))
  homes.push(project)
  const exec = { root: project, additionalRoots: [{ path: root, access: 'write' as const }], deniedRoots: [home], hostStorageRoot: home, memoryRoots: [root] }
  const tool = (name: string) => fsTools().find((item) => item.name === name)!
  expect(classifyTarget(exec, root, 'read').kind).toBe('in-grant')
  await fs.mkdir(path.join(root, 'subfolder'))
  await fs.writeFile(path.join(root, 'subfolder', 'note.md'), 'child needle')
  expect(classifyTarget(exec, path.join(root, 'subfolder'), 'read').kind).toBe('in-grant')
  expect(await tool('Glob').execute({ path: path.join(root, 'subfolder'), pattern: '*.md' }, exec)).toContain('subfolder/note.md')
  expect(await tool('Grep').execute({ path: path.join(root, 'subfolder'), pattern: 'child needle' }, exec)).toContain('subfolder/note.md')
  await tool('Write').execute({ path: path.join(root, 'note.md'), content: 'memory needle' }, exec)
  expect(await tool('Read').execute({ path: path.join(root, 'note.md') }, exec)).toContain('memory needle')
  expect(await tool('Glob').execute({ path: root, pattern: '**/*.md' }, exec)).toContain('note.md')
  expect(await tool('Grep').execute({ path: root, pattern: 'needle' }, exec)).toContain('memory needle')
  await tool('Edit').execute({ path: path.join(root, 'note.md'), old: 'needle', new: 'updated' }, exec)
  expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toBe('memory updated')
  await fs.writeFile(path.join(root, 'secret.txt'), 'needle')
  await fs.mkdir(path.join(root, 'secrets'))
  await fs.writeFile(path.join(root, 'secrets', 'hidden.md'), 'needle')
  expect(await tool('Grep').execute({ path: root, pattern: 'needle' }, exec)).toContain('subfolder/note.md')
  expect(await tool('Grep').execute({ path: root, pattern: 'needle' }, exec)).not.toContain('secrets/hidden.md')
  expect(await tool('Glob').execute({ path: root, pattern: '**/*' }, exec)).not.toContain('secret.txt')
  await expect(tool('Read').execute({ path: path.join(root, 'secret.txt') }, exec)).rejects.toThrow()
  await expect(tool('Write').execute({ path: path.join(root, 'secret.txt'), content: 'no' }, exec)).rejects.toThrow()
  await expect(tool('Read').execute({ path: path.join(home, 'p.json') }, exec)).rejects.toThrow()
  const explicitlyDenied = { ...exec, deniedRoots: [home, path.join(root, 'note.md')] }
  await expect(tool('Read').execute({ path: path.join(root, 'note.md') }, explicitlyDenied)).rejects.toThrow()
  expect(await tool('Glob').execute({ path: root, pattern: 'note.md' }, explicitlyDenied)).toBe('no matches')
  for (const denied of [root, path.join(root, 'subfolder')]) {
    const blocked = { ...exec, deniedRoots: [home, denied] }
    const target = path.join(denied, 'note.md')
    expect(classifyTarget(blocked, target, 'read').kind).toBe('denied')
    await expect(tool('Read').execute({ path: target }, blocked)).rejects.toThrow(/application-internal storage/)
    await expect(tool('Glob').execute({ path: denied, pattern: '*.md' }, blocked)).rejects.toThrow(/application-internal storage/)
  }
  const { hostStorageRoot: _hostStorageRoot, ...undesignated } = exec
  await expect(tool('Read').execute({ path: path.join(root, 'note.md') }, undesignated)).rejects.toThrow(/application-internal storage/)
  const ancestorDenied = { ...exec, deniedRoots: [home, path.dirname(root)] }
  await expect(tool('Read').execute({ path: path.join(root, 'note.md') }, ancestorDenied)).rejects.toThrow(/application-internal storage/)
  await expect(tool('Glob').execute({ path: path.join(root, 'secrets'), pattern: '*.md' }, exec)).rejects.toThrow()
  await fs.symlink(home, path.join(root, 'linked'))
  await expect(tool('Grep').execute({ path: path.join(root, 'linked'), pattern: 'needle' }, exec)).rejects.toThrow(/escapes the memory root/)
  const disabled = { ...exec, additionalRoots: [], memoryRoots: [] }
  await expect(tool('Read').execute({ path: path.join(root, 'note.md') }, disabled)).rejects.toThrow()
  const child = { ...exec, additionalRoots: [{ path: root, access: 'read' as const }] }
  await expect(tool('Write').execute({ path: path.join(root, 'child.md'), content: 'no' }, child)).rejects.toThrow()
})

it('real memory targets retain sensitive and Markdown restrictions for every file tool', async () => {
  const { home, memory, scope } = await setup()
  await memory.prepare(scope)
  const root = memory.root(scope)
  const exec = { root: home, additionalRoots: [{ path: root, access: 'write' as const }], deniedRoots: [home], hostStorageRoot: home, memoryRoots: [root] }
  await fs.mkdir(path.join(root, 'secrets'))
  await fs.writeFile(path.join(root, 'secrets', 'hidden.md'), 'private needle')
  await fs.writeFile(path.join(root, 'hidden.txt'), 'private needle')
  for (const [alias, target] of [['public.md', 'secrets/hidden.md'], ['text.md', 'hidden.txt']]) {
    await fs.symlink(path.join(root, target!), path.join(root, alias!))
    for (const name of ['Read', 'Write', 'Edit']) {
      const tool = fsTools().find((item) => item.name === name)!
      await expect(tool.execute({ path: path.join(root, alias!), content: 'damage', old: 'private', new: 'damage' }, exec)).rejects.toThrow()
    }
    for (const name of ['Glob', 'Grep']) {
      const result = await fsTools().find((item) => item.name === name)!.execute({ path: root, pattern: name === 'Glob' ? '**/*' : 'needle' }, exec)
      expect(result).not.toContain(alias)
    }
  }
  expect(await fs.readFile(path.join(root, 'secrets', 'hidden.md'), 'utf8')).toBe('private needle')
})

it.each(['read', 'create', 'update', 'forget', 'search'] as const)('CRUD %s refuses topic, root and ancestor links before damage', async (operation) => {
  for (const link of ['topic', 'root', 'ancestor', 'index']) {
    const { home, memory, scope } = await setup()
    const entry = await memory.create(scope, { id: 'note', title: 'Note', body: 'original' })
    const root = memory.root(scope)
    const outside = path.join(home, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'note.md'), 'external original')
    await fs.writeFile(path.join(outside, 'MEMORY.md'), 'external index')
    const linked = link === 'topic' ? path.join(root, 'note.md') : link === 'index' ? path.join(root, 'MEMORY.md') : link === 'root' ? root : path.join(home, 'workspaces', 'ws')
    await fs.rm(linked, { recursive: true })
    await fs.symlink(link === 'topic' ? path.join(outside, 'note.md') : link === 'index' ? path.join(outside, 'MEMORY.md') : outside, linked)
    // Search excludes unsafe topics; reads need not access an unrelated index.
    if (link === 'index' && (operation === 'read' || operation === 'search')) continue
    const action = operation === 'read' ? memory.read(scope, 'note') : operation === 'create' ? memory.create(scope, { id: link === 'topic' ? 'note' : 'new', title: 'New', body: 'damage' }) : operation === 'update' ? memory.update(scope, { id: 'note', title: 'Damage', expectedHash: entry.hash }) : operation === 'forget' ? memory.forget(scope, 'note') : memory.search(scope, '')
    if (operation === 'search' && link === 'topic') expect(await action).toEqual([])
    else await expect(action).rejects.toThrow()
    expect(await fs.readFile(path.join(outside, 'note.md'), 'utf8')).toBe('external original')
    expect(await fs.readFile(path.join(outside, 'MEMORY.md'), 'utf8')).toBe('external index')
    if (link === 'index' && operation === 'forget') expect(await fs.readFile(path.join(root, 'note.md'), 'utf8')).toContain('original')
  }
})

it('nested linked parents and linked workspace index fail closed before project mutations', async () => {
  const { home, memory, scope } = await setup()
  await memory.prepare(scope)
  const root = memory.root(scope)
  const outside = path.join(home, 'outside')
  await fs.mkdir(outside)
  await fs.writeFile(path.join(outside, 'note.md'), 'outside data')
  await fs.symlink(outside, path.join(root, 'topics'))
  await expect(memory.read(scope, 'topics/note')).rejects.toThrow()
  await expect(memory.create(scope, { id: 'topics/new', title: 'No', body: 'No' })).rejects.toThrow()
  await expect(memory.update(scope, { id: 'topics/note', title: 'No', expectedHash: '' })).rejects.toThrow()
  await expect(memory.forget(scope, 'topics/note')).rejects.toThrow()
  expect(await memory.search(scope, '')).toEqual([])
  expect(await fs.readFile(path.join(outside, 'note.md'), 'utf8')).toBe('outside data')
  const workspaceRoot = memory.root({ workspaceId: scope.workspaceId })
  await fs.writeFile(path.join(outside, 'index.md'), 'outside index')
  await fs.rm(path.join(workspaceRoot, 'MEMORY.md'))
  await fs.symlink(path.join(outside, 'index.md'), path.join(workspaceRoot, 'MEMORY.md'))
  await expect(memory.create(scope, { id: 'new', title: 'No', body: 'No' })).rejects.toThrow()
  await expect(fs.stat(path.join(root, 'new.md'))).rejects.toThrow()
})

it('prepare validates all scopes before initializing either index', async () => {
  const { home, memory, scope } = await setup()
  const root = memory.root(scope)
  await fs.mkdir(path.dirname(root), { recursive: true })
  const outside = path.join(home, 'outside')
  await fs.mkdir(outside)
  await fs.symlink(outside, root)
  await expect(memory.prepare(scope)).rejects.toThrow()
  await expect(fs.stat(path.join(memory.root({ workspaceId: scope.workspaceId }), 'MEMORY.md'))).rejects.toThrow()
})

it('nested and underscore topics round-trip and only exact auto pointers are retitled', async () => {
  const { memory, scope } = await setup()
  const entry = await memory.create(scope, { id: 'topics/deploy', title: 'Deploy', body: 'deploy body' })
  await memory.create(scope, { id: 'deployment_notes', title: 'Notes', body: 'notes body' })
  const index = path.join(memory.root(scope), 'MEMORY.md')
  await fs.appendFile(index, 'Custom [Deploy](topics/deploy.md) prose\n- [Custom label](topics/deploy.md)\n')
  await memory.update(scope, { id: entry.id, title: 'Deployment', expectedHash: entry.hash })
  expect(await fs.readFile(index, 'utf8')).toBe('- [Deployment](topics/deploy.md)\n- [Notes](deployment_notes.md)\nCustom [Deploy](topics/deploy.md) prose\n- [Custom label](topics/deploy.md)\n')
  expect((await memory.search(scope, '')).map((row) => row.id).sort()).toEqual(['deployment_notes', 'topics/deploy'])
  await memory.forget(scope, entry.id)
  await expect(memory.read(scope, entry.id)).rejects.toThrow()
  for (const id of ['../escape', '/absolute', 'secrets/note', 'topics/../note', 'MEMORY', 'topics/MEMORY']) await expect(memory.create(scope, { id, title: 'No', body: 'No' })).rejects.toThrow()
})

it('rejects oversized encoded topic components before creating any parents', async () => {
  for (const id of ['a'.repeat(253), 'a'.repeat(255), `topics/${'a'.repeat(255)}`, `topics/${'a'.repeat(256)}/note`]) {
    const { home, memory, scope } = await setup()
    await expect(memory.create(scope, { id, title: 'No', body: 'No' })).rejects.toMatchObject({ code: 'invalid' })
    expect(await fs.readdir(home)).toEqual([])
  }
  const { memory, scope } = await setup()
  const id = `${'a'.repeat(255)}/${'b'.repeat(252)}`
  expect((await memory.create(scope, { id, title: 'Boundary', body: 'Fits' })).id).toBe(id)
})

it('retitles automatic CRLF pointers without rewriting unrelated bytes or line endings', async () => {
  const { memory, scope } = await setup()
  const entry = await memory.create(scope, { id: 'topics/note', title: 'Original', body: 'Body' })
  const index = path.join(memory.root(scope), 'MEMORY.md')
  const before = '# Authored index  \r\n- [Original](topics/note.md)\r\n- [Custom label](topics/note.md)\r\nProse [Original](topics/note.md)\nFinal without newline'
  await fs.writeFile(index, before)
  await memory.update(scope, { id: entry.id, title: 'Renamed', expectedHash: entry.hash })
  expect(await fs.readFile(index, 'utf8')).toBe(before.replace('- [Original](topics/note.md)', '- [Renamed](topics/note.md)'))
})

it('memory grant refuses non-md writes, foreign scopes, symlinks and escapes', async () => {
  const { home, memory, scope } = await setup()
  await memory.prepare(scope)
  const root = memory.root(scope)
  const exec = { root: await fs.mkdtemp(path.join(home, 'project-')), additionalRoots: [{ path: root, access: 'write' as const }], deniedRoots: [home], hostStorageRoot: home, memoryRoots: [root] }
  expect(classifyTarget(exec, path.join(root, 'ok.md'), 'write').kind).toBe('in-grant')
  await expect(resolveInGrants(exec, path.join(root, 'ok.md'), 'write')).resolves.toBe(path.join(root, 'ok.md'))
  for (const target of [path.join(root, 'bad.txt'), path.join(root, '..', 'other.md'), path.join(home, 'workspaces', 'other', 'memory', 'workspace', 'x.md')]) {
    await expect(resolveInGrants(exec, target, 'write')).rejects.toThrow()
  }
  await fs.symlink(home, path.join(root, 'escape'))
  await expect(resolveInGrants(exec, path.join(root, 'escape', 'x.md'), 'write')).rejects.toThrow()
})
