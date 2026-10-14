import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { searchProjectFiles } from '../../src/web/project-files.ts'

let root = ''

const write = async (rel: string): Promise<void> => {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true })
  await fs.writeFile(path.join(root, rel), 'x\n')
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-search-'))
  await write('README.md')
  await write('.claude/settings.json')
  await write('.github/workflows/ci.yml')
  await write('.env.example')
  await write('.DS_Store')
  await write('.git/config')
  await write('node_modules/pkg/index.js')
})

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('searchProjectFiles dot folders', () => {
  it('finds files inside dot folders such as .claude', async () => {
    const { matches } = await searchProjectFiles(root, '.claude')
    expect(matches.map((m) => m.path)).toEqual(['.claude/settings.json'])
  })

  it('finds dot files and nested dot-folder files', async () => {
    expect((await searchProjectFiles(root, '.env')).matches.map((m) => m.path)).toEqual(['.env.example'])
    expect((await searchProjectFiles(root, 'ci.yml')).matches.map((m) => m.path)).toEqual(['.github/workflows/ci.yml'])
  })

  it('still skips .git, node_modules and .DS_Store', async () => {
    const paths = (await searchProjectFiles(root, '')).matches.map((m) => m.path)
    expect(paths).not.toContain('.git/config')
    expect(paths).not.toContain('node_modules/pkg/index.js')
    expect(paths).not.toContain('.DS_Store')
    expect(paths).toContain('.claude/settings.json')
  })
})
