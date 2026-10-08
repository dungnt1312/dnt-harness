/** CLAUDE.md layering, imports and caps (spec 2026-10-08-claude-format-parity §A). */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_MD_MAX_FILE_BYTES, importTokens, loadClaudeMd, projectDirectoryChain, renderClaudeMd } from '../../src/harness/instructions/claude-md.ts'

let root: string
let home: string
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'claude-md-')))
  home = path.join(root, 'home')
  await fs.mkdir(home, { recursive: true })
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('CLAUDE.md layers', () => {
  it('orders user < workspace < ancestors < project < local', async () => {
    const userDir = path.join(home, '.claude')
    const ws = path.join(root, 'data', 'ws')
    const project = path.join(home, 'code', 'repo')
    await write(path.join(userDir, 'CLAUDE.md'), 'USER')
    await write(path.join(ws, 'CLAUDE.md'), 'WORKSPACE')
    await write(path.join(home, 'code', 'CLAUDE.md'), 'PARENT')
    await write(path.join(project, 'CLAUDE.md'), 'PROJECT')
    await write(path.join(project, '.claude', 'CLAUDE.md'), 'DOTCLAUDE')
    await write(path.join(project, 'CLAUDE.local.md'), 'LOCAL')
    const files = await loadClaudeMd({ userDir, workspaceDir: ws, projectRoot: project, home })
    expect(files.map((file) => file.content)).toEqual(['USER', 'WORKSPACE', 'PARENT', 'PROJECT', 'DOTCLAUDE', 'LOCAL'])
    expect(files.map((file) => file.layer)).toEqual(['user', 'workspace', 'project', 'project', 'project', 'local'])
    const text = renderClaudeMd(files)
    expect(text.indexOf('USER')).toBeLessThan(text.indexOf('LOCAL'))
    expect(text).toContain(`Contents of ${path.join(project, 'CLAUDE.md')} (project instructions)`)
  })

  it('reads AGENTS.md only where no CLAUDE.md exists', async () => {
    const project = path.join(home, 'repo')
    await write(path.join(project, 'AGENTS.md'), 'AGENTS ONLY')
    expect((await loadClaudeMd({ projectRoot: project, home })).map((file) => file.content)).toEqual(['AGENTS ONLY'])
    await write(path.join(project, 'CLAUDE.md'), 'CLAUDE')
    expect((await loadClaudeMd({ projectRoot: project, home })).map((file) => file.content)).toEqual(['CLAUDE'])
  })

  it('follows @imports (relative, ~/), skips code, cycles and depth > 5', async () => {
    const project = path.join(home, 'repo')
    await write(path.join(home, 'shared.md'), 'SHARED')
    await write(path.join(project, 'AGENTS.md'), 'AGENTS @CLAUDE.md')
    await write(path.join(project, 'CLAUDE.md'), 'See @AGENTS.md and @~/shared.md.\n`@not-this.md`\n```\n@nor-this.md\n```')
    await write(path.join(project, 'not-this.md'), 'NO')
    await write(path.join(project, 'nor-this.md'), 'NO')
    const files = await loadClaudeMd({ projectRoot: project, home })
    // A repository cannot import from home outside its own folder chain.
    expect(files.map((file) => file.content.split(' ')[0])).toEqual(['See', 'AGENTS'])
    expect(files[1]?.importedFrom).toBe(path.join(project, 'CLAUDE.md'))
    // The user layer may import from home (`~/`).
    const userDir = path.join(home, '.claude')
    await write(path.join(userDir, 'CLAUDE.md'), 'USER @~/shared.md')
    expect((await loadClaudeMd({ userDir, home })).map((file) => file.content)).toEqual(['USER @~/shared.md', 'SHARED'])

    const chain = path.join(home, 'chain')
    for (let index = 0; index < 8; index++) await write(path.join(chain, `f${index}.md`), `F${index} @f${index + 1}.md`)
    await write(path.join(chain, 'CLAUDE.md'), '@f0.md')
    const deep = await loadClaudeMd({ projectRoot: chain, home })
    // CLAUDE.md (depth 0) + f0..f4 (depths 1..5)
    expect(deep).toHaveLength(6)
  })

  it('truncates oversized files', async () => {
    const project = path.join(home, 'big')
    await write(path.join(project, 'CLAUDE.md'), 'x'.repeat(CLAUDE_MD_MAX_FILE_BYTES + 100))
    const [file] = await loadClaudeMd({ projectRoot: project, home })
    expect(file?.truncated).toBe(true)
    expect(file?.content.length).toBe(CLAUDE_MD_MAX_FILE_BYTES)
    expect(renderClaudeMd([file!])).toContain('[truncated')
  })

  it('project imports stay inside the project chain and never reach denied roots', async () => {
    const project = path.join(home, 'work', 'repo')
    await write(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY')
    await write(path.join(root, 'outside.md'), 'OUTSIDE')
    await write(path.join(home, 'work', 'shared.md'), 'SHARED IN CHAIN')
    await write(path.join(project, 'secret-link.md'), 'placeholder')
    await fs.rm(path.join(project, 'secret-link.md'))
    await fs.symlink(path.join(home, '.ssh', 'id_ed25519'), path.join(project, 'secret-link.md'))
    await write(path.join(project, 'CLAUDE.md'), `@~/.ssh/id_ed25519 @${path.join(root, 'outside.md')} @../shared.md @secret-link.md`)
    const files = await loadClaudeMd({ projectRoot: project, home, deniedRoots: [path.join(home, '.ssh')] })
    const text = renderClaudeMd(files)
    expect(text).toContain('SHARED IN CHAIN')
    expect(text).not.toContain('PRIVATE KEY')
    expect(text).not.toContain('OUTSIDE')
  })

  it('reads at most the cap from a huge file', async () => {
    const project = path.join(home, 'huge')
    const handle = await fs.open(path.join(await (async () => { await fs.mkdir(project, { recursive: true }); return project })(), 'CLAUDE.md'), 'w')
    await handle.truncate(512 * 1024 * 1024) // sparse 512 MB
    await handle.close()
    const [file] = await loadClaudeMd({ projectRoot: project, home })
    expect(file?.truncated).toBe(true)
    expect(file?.content.length).toBeLessThanOrEqual(CLAUDE_MD_MAX_FILE_BYTES)
  })

  it('never walks above home', () => {
    expect(projectDirectoryChain(path.join(home, 'a', 'b'), home)).toEqual([path.join(home, 'a'), path.join(home, 'a', 'b')])
    expect(projectDirectoryChain('/opt/x/y', home)).toEqual(['/opt/x/y'])
  })

  it('import tokens', () => {
    expect(importTokens('read @a.md, then @./b/c.md; not an email@x.com')).toEqual(['a.md', './b/c.md'])
  })
})
