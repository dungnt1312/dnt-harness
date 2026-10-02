/**
 * Read-only project browsing for the workbench: listings and file bodies stay
 * inside the registered project root, refuse traversal and foreign scopes,
 * classify binaries and cap large files.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWebServer, type LlmProvider, type WebServer } from 'dnt-harness'

let project = ''
let searchRoot = ''
let outside = ''
let home = ''
let server: WebServer
let wsId = ''
let projectId = ''
let searchProjectId = ''
let gitRoot = ''
let gitProjectId = ''

const idle: LlmProvider = {
  name: 'idle',
  models: ['idle'],
  async *stream() {
    yield { type: 'delta', delta: 'ok' }
  },
}

beforeAll(async () => {
  project = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-project-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-outside-'))
  home = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-home-'))
  await fs.mkdir(path.join(project, 'src', 'nested'), { recursive: true })
  await fs.writeFile(path.join(project, 'README.md'), '# Title\n', 'utf8')
  await fs.writeFile(path.join(project, 'src', 'index.ts'), 'export const answer = 42\n', 'utf8')
  await fs.writeFile(path.join(project, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]))
  await fs.writeFile(path.join(project, 'big.txt'), 'x'.repeat(1024 * 1024 + 10), 'utf8')
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside', 'utf8')

  // A second root keeps the walk fixtures (hidden, vendored, nested) out of the
  // listing assertions above.
  searchRoot = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-search-'))
  await fs.mkdir(path.join(searchRoot, 'web', 'components'), { recursive: true })
  await fs.mkdir(path.join(searchRoot, 'node_modules', 'pkg'), { recursive: true })
  await fs.mkdir(path.join(searchRoot, '.git'), { recursive: true })
  await fs.writeFile(path.join(searchRoot, 'README.md'), 'root\n', 'utf8')
  await fs.writeFile(path.join(searchRoot, 'web', 'composer.ts'), 'a\n', 'utf8')
  await fs.writeFile(path.join(searchRoot, 'web', 'components', 'composer-chip.ts'), 'b\n', 'utf8')
  await fs.writeFile(path.join(searchRoot, 'node_modules', 'pkg', 'composer.ts'), 'vendored\n', 'utf8')
  await fs.writeFile(path.join(searchRoot, '.git', 'composer.ts'), 'hidden\n', 'utf8')

  server = await createWebServer({ home, providers: [idle], configFile: path.join(home, 'providers.json') })
  wsId = ((await (await fetch(`${server.url}/api/workspaces`)).json()) as { id: string }[])[0]!.id
  const register = async (name: string, root: string): Promise<string> => {
    const created = await fetch(`${server.url}/api/workspaces/${wsId}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path: root }),
    })
    return ((await created.json()) as { id: string }).id
  }
  projectId = await register('Files', project)
  searchProjectId = await register('Search', searchRoot)

  const { execFileSync } = await import('node:child_process')
  gitRoot = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-files-git-'))
  const run = (...args: string[]) => execFileSync('git', args, { cwd: gitRoot })
  run('init', '-q')
  run('config', 'user.email', 'test@dnt-harness')
  run('config', 'user.name', 'dnt-harness')
  await fs.writeFile(path.join(gitRoot, 'README.md'), 'old\n', 'utf8')
  run('add', '.')
  run('commit', '-qm', 'init')
  await fs.writeFile(path.join(gitRoot, 'README.md'), 'new\n', 'utf8')
  await fs.mkdir(path.join(gitRoot, 'src'))
  await fs.writeFile(path.join(gitRoot, 'src', 'new.ts'), 'export const created = true\n', 'utf8')
  gitProjectId = await register('Git', gitRoot)
})

afterAll(async () => {
  await server?.close().catch(() => {})
  for (const dir of [project, searchRoot, outside, home, gitRoot]) await fs.rm(dir, { recursive: true, force: true })
})

const files = (query: string) => fetch(`${server.url}/api/workspaces/${wsId}/projects/${projectId}/files?path=${encodeURIComponent(query)}`)
const file = (query: string) => fetch(`${server.url}/api/workspaces/${wsId}/projects/${projectId}/file?path=${encodeURIComponent(query)}`)
const search = (query: string, limit?: number) =>
  fetch(`${server.url}/api/workspaces/${wsId}/projects/${searchProjectId}/search?q=${encodeURIComponent(query)}${limit !== undefined ? `&limit=${limit}` : ''}`)
const searched = async (query: string, limit?: number): Promise<string[]> =>
  ((await (await search(query, limit)).json()) as { matches: { path: string }[] }).matches.map((match) => match.path)

describe('project file browsing', () => {
  it('lists the root with folders first and root-relative paths', async () => {
    const response = await files('')
    expect(response.status).toBe(200)
    const listing = (await response.json()) as { path: string; entries: { name: string; path: string; kind: string; size?: number }[] }
    expect(listing.path).toBe('')
    expect(listing.entries.map((entry) => `${entry.kind}:${entry.path}`)).toEqual(['dir:src', 'file:big.txt', 'file:logo.bin', 'file:README.md'])
    expect(listing.entries.find((entry) => entry.name === 'README.md')?.size).toBe(8)
  })

  it('lists nested folders using either separator', async () => {
    const listing = (await (await files('src\\')).json()) as { path: string; entries: { path: string }[] }
    expect(listing.entries.map((entry) => entry.path)).toEqual(['src/nested', 'src/index.ts'])
  })

  it('reads text files verbatim', async () => {
    const body = (await (await file('src/index.ts')).json()) as { content: string; binary: boolean; truncated: boolean; size: number }
    expect(body).toMatchObject({ content: 'export const answer = 42\n', binary: false, truncated: false, size: 25 })
  })

  it('classifies binaries without returning their bytes and caps large files', async () => {
    expect(await (await file('logo.bin')).json()).toMatchObject({ binary: true, content: '' })
    const big = (await (await file('big.txt')).json()) as { content: string; truncated: boolean; size: number }
    expect(big.truncated).toBe(true)
    expect(big.size).toBe(1024 * 1024 + 10)
    expect(big.content.length).toBe(1024 * 1024)
  })

  it('refuses traversal, absolute paths and wrong entry kinds', async () => {
    for (const escape of ['../', `../${path.basename(outside)}/secret.txt`, outside, path.join(outside, 'secret.txt')]) {
      expect((await files(escape)).status).toBe(400)
      expect((await file(escape)).status).toBe(400)
    }
    expect((await files('README.md')).status).toBe(400)
    expect((await file('src')).status).toBe(400)
    expect((await file('missing.txt')).status).toBe(400)
  })

  it('fails closed for unknown projects and rejects writes', async () => {
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/nope/files`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/${projectId}/file?path=README.md`, { method: 'PUT', body: 'x' })).status).toBe(405)
  })
})

describe('project git (read-only)', () => {
  it('reports the branch and a changed file with its line counts', async () => {
    const response = await fetch(`${server.url}/api/workspaces/${wsId}/projects/${gitProjectId}/git`)
    expect(response.status).toBe(200)
    const report = (await response.json()) as { branch: string | null; truncated: boolean; changes: { path: string; status: string; added?: number; removed?: number }[] }
    expect(report.branch).not.toBeNull()
    expect(report.truncated).toBe(false)
    const readme = report.changes.find((change) => change.path === 'README.md')
    expect(readme).toMatchObject({ status: 'modified', added: 1, removed: 1 })
    const created = report.changes.find((change) => change.path === 'src/new.ts')
    expect(created?.status).toBe('untracked')
  })

  it('returns a unified diff for one root-relative path', async () => {
    const response = await fetch(`${server.url}/api/workspaces/${wsId}/projects/${gitProjectId}/git?path=${encodeURIComponent('README.md')}`)
    expect(response.status).toBe(200)
    const diff = (await response.json()) as { path: string; binary: boolean; lines: { kind: string; text: string }[] }
    expect(diff.path).toBe('README.md')
    expect(diff.binary).toBe(false)
    expect(diff.lines.some((line) => line.kind === 'del' && line.text === 'old')).toBe(true)
    expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'new')).toBe(true)
  })

  it('shows an untracked file as added lines', async () => {
    const diff = (await (await fetch(`${server.url}/api/workspaces/${wsId}/projects/${gitProjectId}/git?path=${encodeURIComponent('src/new.ts')}`)).json()) as { lines: { kind: string; text: string }[] }
    expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'export const created = true')).toBe(true)
  })

  it('refuses a path that leaves the project and rejects writes', async () => {
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/${gitProjectId}/git?path=../secret`)).status).toBe(400)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/${gitProjectId}/git`, { method: 'POST' })).status).toBe(405)
  })

  it('answers an empty status for a folder that is not a repository', async () => {
    const report = (await (await fetch(`${server.url}/api/workspaces/${wsId}/projects/${projectId}/git`)).json()) as { branch: string | null; changes: unknown[] }
    expect(report).toEqual({ branch: null, changes: [], truncated: false })
  })
})

describe('project file search (composer mentions)', () => {
  it('ranks file-name matches above path matches and returns root-relative paths', async () => {
    expect(await searched('composer')).toEqual(['web/composer.ts', 'web/components/composer-chip.ts'])
  })

  it('matches a path fragment when the file name does not match', async () => {
    expect(await searched('components/')).toEqual(['web/components/composer-chip.ts'])
  })

  it('lists the shallowest files for an empty query', async () => {
    expect(await searched('')).toEqual(['README.md', 'web/composer.ts', 'web/components/composer-chip.ts'])
  })

  it('never walks hidden or vendored trees', async () => {
    const all = await searched('')
    expect(all.some((hit) => hit.startsWith('node_modules/') || hit.startsWith('.git/'))).toBe(false)
  })

  it('honours the limit and reports nothing for a miss', async () => {
    expect(await searched('', 1)).toEqual(['README.md'])
    const body = (await (await search('zzz-nothing')).json()) as { matches: unknown[]; truncated: boolean }
    expect(body).toEqual({ query: 'zzz-nothing', matches: [], truncated: false })
  })

  it('fails closed for unknown projects and rejects writes', async () => {
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/nope/search?q=a`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/workspaces/${wsId}/projects/${searchProjectId}/search?q=a`, { method: 'POST' })).status).toBe(405)
  })
})
