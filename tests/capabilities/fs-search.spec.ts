import { promises as fs, type Dirent } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { globTool, grepTool } from '../../src/capabilities/fs/tools.ts'

let root: string
beforeEach(async () => { root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-search-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
const glob = (pattern: string, args = {}, extra = {}) => globTool().execute({ pattern, ...args }, { root, ...extra })
const grep = (pattern: string, args = {}, extra = {}) => grepTool().execute({ pattern, ...args }, { root, ...extra })
async function put(file: string, text = 'needle\n') {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), text)
}
function hugeSnapshot() {
  const original = fs.readdir.bind(fs)
  const entries = Array.from({ length: 20_001 }, (_, i) => ({
    name: `link-${String(i).padStart(5, '0')}`, isSymbolicLink: () => true,
    isDirectory: () => false, isFile: () => false,
  }) as Dirent)
  return vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, options: unknown) =>
    String(dir) === path.join(root, '.superpowers') ? Promise.resolve(entries) : original(dir, options as never)) as typeof fs.readdir)
}

describe('search reliability', () => {
  it('does not traverse irrelevant subtrees for shallow, exact or literal-prefix globs', async () => {
    await put('.superpowers/a.txt')
    await put('README.md')
    await put('src/index.ts')
    await put('src/deep/util.ts')
    const spy = hugeSnapshot()
    expect(await glob('*')).toContain('README.md')
    expect(await glob('*.md')).toBe('README.md')
    expect(await glob('src/index.ts')).toBe('src/index.ts')
    expect(await glob('src/**/*.ts')).toContain('src/deep/util.ts')
    expect(spy.mock.calls.some(([dir]) => String(dir) === path.join(root, '.superpowers'))).toBe(false)
  })

  it('supports brace choices at root and nested levels without duplicates', async () => {
    await put('index.ts'); await put('web/App.tsx'); await put('web/index.html')
    expect((await glob('**/*.{html,css,vue,jsx,tsx,ts,js}')).split('\n').sort()).toEqual(['index.ts', 'web/App.tsx', 'web/index.html'])
    expect(await glob('*.{ts,tsx}', { path: 'web' })).toBe('web/App.tsx')
    expect((await glob('{index.ts,web/**/*.tsx,index.ts}')).split('\n')).toEqual(['index.ts', 'web/App.tsx'])
    expect(await glob('src/**/*.ts')).toBe('no matches')
    await put('srcfoo/file.ts')
    expect(await glob('src/**/*.ts')).toBe('no matches')
  })

  it('rejects malformed and excessive brace expansions', async () => {
    for (const pattern of ['*.{ts,tsx', '*.{ts,}', '*.ts}', `*.{${Array.from({length: 65}, (_, i) => i).join(',')}}`]) {
      await expect(glob(pattern)).rejects.toThrow(/pattern|brace|choices/i)
    }
  })

  it('prunes project gitignore rules, applies negations and nested rules, but not zcodeignore', async () => {
    await put('.gitignore', '.superpowers/\n.worktrees/\n*.log\n!keep.log\n/root-only.txt\n')
    await put('.zcodeignore', 'src/\n')
    await put('.superpowers/snapshot.ts'); await put('.worktrees/copy.ts')
    await put('src/keep.ts'); await put('src/skip.ts'); await put('src/debug.log')
    await put('src/.gitignore', 'skip.ts\n!debug.log\n')
    await put('keep.log'); await put('drop.log'); await put('root-only.txt'); await put('src/root-only.txt')
    const spy = hugeSnapshot()
    const files = await glob('**/*')
    expect(files).toContain('src/keep.ts'); expect(files).toContain('keep.log'); expect(files).toContain('src/debug.log')
    expect(files).toContain('src/root-only.txt'); expect(files.split('\n')).not.toContain('root-only.txt')
    expect(files).not.toContain('snapshot.ts'); expect(files).not.toContain('copy.ts'); expect(files).not.toContain('skip.ts'); expect(files).not.toContain('drop.log')
    expect(spy.mock.calls.some(([dir]) => String(dir) === path.join(root, '.superpowers'))).toBe(false)
    expect(await grep('needle')).toContain('src/keep.ts:1: needle')
  })

  it('allows includeIgnored and explicit ignored scopes/patterns without disabling unrelated ignores', async () => {
    await put('.gitignore', 'snapshots/\nother/\n*.log\n')
    await put('snapshots/a.ts'); await put('other/b.ts'); await put('src/debug.log')
    expect(await glob('**/*.ts')).toBe('no matches')
    expect(await glob('snapshots/**/*.ts')).toBe('snapshots/a.ts')
    expect(await glob('**/snapshots/**/*.ts')).toBe('snapshots/a.ts')
    expect(await glob('*.ts', { path: 'snapshots' })).toBe('snapshots/a.ts')
    expect(await glob('src/debug.log')).toBe('src/debug.log')
    expect(await glob('**/*.ts', { includeIgnored: true })).toContain('other/b.ts')
    expect(await grep('needle', { path: 'snapshots' })).toBe('snapshots/a.ts:1: needle')
    expect(await grep('needle', { includeIgnored: true })).toContain('src/debug.log:1: needle')
    expect(await glob('*.log', { path: 'src' })).toBe('no matches')
  })

  it('keeps descendant file rules when entering an ignored scope, and honors directory negation semantics', async () => {
    await put('.gitignore', 'snapshots/\n*.log\ncache/*\n!cache/keep/\n')
    await put('snapshots/a.ts'); await put('snapshots/debug.log')
    await put('cache/keep/a.ts'); await put('cache/drop/b.ts')
    expect(await glob('**/*.ts')).toBe('cache/keep/a.ts')
    expect(await glob('**/*', { path: 'snapshots' })).toBe('snapshots/a.ts')
    expect(await glob('snapshots/**/*')).toBe('snapshots/a.ts')
    expect(await glob('**/snapshots/**/*')).toBe('snapshots/a.ts')
  })

  it('does not apply a denied gitignore and never loads rules above an additional granted root', async () => {
    await put('.gitignore', 'src/\n'); await put('src/index.ts')
    const readSpy = vi.spyOn(fs, 'readFile')
    expect(await glob('**/*.ts', {}, { deniedRoots: [path.join(root, '.gitignore')] })).toBe('src/index.ts')
    expect(readSpy.mock.calls.some(([file]) => String(file) === path.join(root, '.gitignore'))).toBe(false)
    const other = await fs.mkdtemp(path.join(tmpdir(), 'dnt-granted-search-'))
    try {
      await fs.writeFile(path.join(other, '.gitignore'), '*.log\n')
      await fs.writeFile(path.join(other, 'app.ts'), 'x')
      await fs.writeFile(path.join(other, 'debug.log'), 'x')
      expect(await glob('**/*', { path: other }, { additionalRoots: [{ path: other, access: 'write' }] })).toContain(path.join(other, 'app.ts'))
      expect(await glob('**/*.log', { path: other }, { additionalRoots: [{ path: other, access: 'write' }] })).toBe('no matches')
    } finally { await fs.rm(other, { recursive: true, force: true }) }
  })

  it('matches globstar only on whole segments, including zero segments and consecutive globstars', async () => {
    await put('src/a.ts'); await put('src/deep/b.ts'); await put('srcfoo/c.ts')
    expect((await glob('src/**/*.ts')).split('\n')).toEqual(['src/a.ts', 'src/deep/b.ts'])
    expect((await glob('**/**/a.ts')).split('\n')).toEqual(['src/a.ts'])
    expect(await glob('src/*/*.ts')).toBe('src/deep/b.ts')
    expect(await glob('src/*.ts')).toBe('src/a.ts')
  })

  it('reports exhausted traversal even with zero matches; preserves partial hits and the warning under output caps', async () => {
    await put('!first.ts'); await put('.superpowers/a.txt'); await put('src/last.ts')
    hugeSnapshot()
    const empty = await glob('**/*.missing')
    expect(empty).toContain('search incomplete: walk budget exhausted')
    expect(empty).not.toMatch(/^no matches/)
    const hits = await glob('**/*.ts')
    expect(hits).toContain('!first.ts'); expect(hits).toContain('search incomplete:')
    expect(await glob('**/*.ts', {}, { outputLimit: 160 })).toContain('search incomplete:')
    expect(await grep('absent')).toContain('search incomplete: walk budget exhausted')
    const found = await grep('needle')
    expect(found).toContain('!first.ts:1: needle'); expect(found).toContain('search incomplete:')
  })

  it('reports unreadable directories rather than an exhaustive no matches', async () => {
    await put('broken/a.ts')
    const original = fs.readdir.bind(fs)
    vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, options: unknown) => {
      if (String(dir) === path.join(root, 'broken')) return Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
      return original(dir, options as never)
    }) as typeof fs.readdir)
    expect(await glob('**/*.ts')).toContain('search incomplete:')
  })

  it('reports filesystem failures inspecting a literal prefix, and honors cancellation during prefix checks', async () => {
    await put('src/deep/a.ts')
    const original = fs.lstat.bind(fs)
    vi.spyOn(fs, 'lstat').mockImplementation(((file: string) => {
      if (String(file) === path.join(root, 'src')) return Promise.reject(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
      return original(file)
    }) as typeof fs.lstat)
    expect(await glob('src/**/*.ts')).toContain('search incomplete:')
    vi.restoreAllMocks()
    const controller = new AbortController()
    vi.spyOn(fs, 'lstat').mockImplementation(((file: string) => {
      if (String(file) === path.join(root, 'src')) controller.abort()
      return original(file)
    }) as typeof fs.lstat)
    await expect(glob('src/deep/a.ts', {}, { signal: controller.signal })).rejects.toThrow(/cancelled/)
  })

  it('does not read symlink/denied ignore files or follow symlink directories; exact and prefix paths remain confined', async () => {
    const outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-search-out-'))
    try {
      await fs.writeFile(path.join(outside, 'rules'), 'src/\n')
      await fs.symlink(path.join(outside, 'rules'), path.join(root, '.gitignore'))
      await fs.symlink(outside, path.join(root, 'leak'))
      await put('src/index.ts')
      expect(await glob('**/*.ts')).toBe('src/index.ts')
      expect(await glob('leak/**/*')).toBe('no matches')
      await expect(glob('../*')).rejects.toThrow(/escapes|outside|pattern/)
      expect(await glob('src/index.ts', {}, { deniedRoots: [path.join(root, 'src')] })).toBe('no matches')
      await expect(glob('**/*', { includeIgnored: true }, { signal: AbortSignal.abort() })).rejects.toThrow(/cancelled/)
    } finally { await fs.rm(outside, { recursive: true, force: true }) }
  })
})
