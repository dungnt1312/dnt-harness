/**
 * Explorer writes: create, rename and delete stay inside the project root,
 * never overwrite, never follow a link in the last segment, and refuse the
 * root itself and `.git`.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createProjectEntry,
  deleteProjectEntry,
  ProjectWriteError,
  renameProjectEntry,
} from '../../src/web/project-files-write.ts'

let root = ''
let outside = ''

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-write-root-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-write-outside-'))
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true })
  await fs.writeFile(path.join(root, 'src', 'index.ts'), 'x\n', 'utf8')
  await fs.writeFile(path.join(root, 'README.md'), '# r\n', 'utf8')
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n', 'utf8')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const exists = (rel: string): Promise<boolean> => fs.lstat(path.join(root, rel)).then(() => true, () => false)

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ProjectWriteError) return error.status
    throw error
  }
  return 200
}

describe('createProjectEntry', () => {
  it('creates an empty file and a folder', async () => {
    expect(await createProjectEntry(root, 'src/new.ts', 'file')).toEqual({ name: 'new.ts', path: 'src/new.ts', kind: 'file', size: 0 })
    expect(await fs.readFile(path.join(root, 'src', 'new.ts'), 'utf8')).toBe('')
    expect(await createProjectEntry(root, 'docs', 'dir')).toEqual({ name: 'docs', path: 'docs', kind: 'dir' })
    expect((await fs.stat(path.join(root, 'docs'))).isDirectory()).toBe(true)
  })

  it('accepts either separator', async () => {
    expect((await createProjectEntry(root, 'src\\other.ts', 'file')).path).toBe('src/other.ts')
  })

  it('answers 409 when the name exists and never overwrites', async () => {
    expect(await status(createProjectEntry(root, 'README.md', 'file'))).toBe(409)
    expect(await fs.readFile(path.join(root, 'README.md'), 'utf8')).toBe('# r\n')
    expect(await status(createProjectEntry(root, 'src', 'dir'))).toBe(409)
  })

  it('answers 404 when the parent folder is missing', async () => {
    expect(await status(createProjectEntry(root, 'missing/a.ts', 'file'))).toBe(404)
    expect(await status(createProjectEntry(root, 'missing/a', 'dir'))).toBe(404)
  })

  it('answers 400 when the parent is a file', async () => {
    expect(await status(createProjectEntry(root, 'README.md/a.ts', 'file'))).toBe(400)
  })
})

describe('renameProjectEntry', () => {
  it('renames a file and a folder in place', async () => {
    expect(await renameProjectEntry(root, 'README.md', 'NOTES.md')).toEqual({ path: 'NOTES.md', kind: 'file' })
    expect(await exists('NOTES.md')).toBe(true)
    expect(await exists('README.md')).toBe(false)
    expect(await renameProjectEntry(root, 'src', 'lib')).toEqual({ path: 'lib', kind: 'dir' })
    expect(await exists('lib/index.ts')).toBe(true)
  })

  it('answers 409 when the destination exists', async () => {
    await fs.writeFile(path.join(root, 'other.md'), 'o\n', 'utf8')
    expect(await status(renameProjectEntry(root, 'README.md', 'other.md'))).toBe(409)
    expect(await fs.readFile(path.join(root, 'other.md'), 'utf8')).toBe('o\n')
  })

  it('answers 404 for a missing source and 400 for the same name', async () => {
    expect(await status(renameProjectEntry(root, 'nope.md', 'x.md'))).toBe(404)
    expect(await status(renameProjectEntry(root, 'README.md', 'README.md'))).toBe(400)
  })

  it('allows a case-only rename on a case-insensitive volume', async () => {
    const insensitive = await fs.stat(path.join(root, 'readme.md')).then(() => true, () => false)
    if (!insensitive) return
    expect(await renameProjectEntry(root, 'README.md', 'Readme.md')).toEqual({ path: 'Readme.md', kind: 'file' })
    expect(await fs.readdir(root)).toContain('Readme.md')
  })

  it('renames an existing entry whose name ends in whitespace', async () => {
    await fs.writeFile(path.join(root, 'trail '), 't\n', 'utf8')
    expect(await renameProjectEntry(root, 'trail ', 'trail.txt')).toEqual({ path: 'trail.txt', kind: 'file' })
    expect(await exists('trail.txt')).toBe(true)
    expect(await exists('trail ')).toBe(false)
  })

  it('answers 409 when renaming onto a hard link of the same file', async () => {
    await fs.link(path.join(root, 'README.md'), path.join(root, 'b.md'))
    expect(await status(renameProjectEntry(root, 'README.md', 'b.md'))).toBe(409)
    expect(await exists('README.md')).toBe(true)
    expect(await exists('b.md')).toBe(true)
  })

  it('renames a symlink itself, not its target', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
    expect(await renameProjectEntry(root, 'link.txt', 'moved.txt')).toEqual({ path: 'moved.txt', kind: 'file' })
    expect((await fs.lstat(path.join(root, 'moved.txt'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })
})

describe('deleteProjectEntry', () => {
  it('deletes a file and a non-empty folder', async () => {
    expect(await deleteProjectEntry(root, 'README.md')).toEqual({ path: 'README.md' })
    expect(await exists('README.md')).toBe(false)
    expect(await deleteProjectEntry(root, 'src')).toEqual({ path: 'src' })
    expect(await exists('src')).toBe(false)
  })

  it('deletes a symlink pointing outside without touching its target', async () => {
    await fs.symlink(outside, path.join(root, 'out-link'))
    expect(await deleteProjectEntry(root, 'out-link')).toEqual({ path: 'out-link' })
    expect(await exists('out-link')).toBe(false)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('deletes an existing entry whose name starts with whitespace', async () => {
    await fs.writeFile(path.join(root, ' lead'), 'l\n', 'utf8')
    expect(await deleteProjectEntry(root, ' lead')).toEqual({ path: ' lead' })
    expect(await exists(' lead')).toBe(false)
    expect(await exists('README.md')).toBe(true)
  })

  it('deletes a broken symlink', async () => {
    await fs.symlink(path.join(root, 'gone'), path.join(root, 'broken'))
    expect(await deleteProjectEntry(root, 'broken')).toEqual({ path: 'broken' })
    expect(await exists('broken')).toBe(false)
  })

  it('answers 404 for a missing entry', async () => {
    expect(await status(deleteProjectEntry(root, 'nope.md'))).toBe(404)
  })
})

describe('refusals', () => {
  it('refuses the project root for every operation', async () => {
    for (const raw of ['', '.', '/', './']) {
      expect(await status(deleteProjectEntry(root, raw))).toBe(400)
      expect(await status(renameProjectEntry(root, raw, 'x'))).toBe(400)
      expect(await status(createProjectEntry(root, raw, 'dir'))).toBe(400)
    }
    expect(await exists('README.md')).toBe(true)
  })

  it('refuses dot segments that resolve to the root or an ancestor', async () => {
    for (const raw of ['./.', '././', 'src/.', './src', 'src/./index.ts']) {
      expect(await status(deleteProjectEntry(root, raw)), raw).toBe(400)
      expect(await status(renameProjectEntry(root, raw, 'x'))).toBe(400)
      expect(await status(createProjectEntry(root, raw, 'dir'))).toBe(400)
    }
    expect(await exists('README.md')).toBe(true)
    expect(await exists('src/index.ts')).toBe(true)
  })

  it('refuses case variants of .git', async () => {
    expect(await status(deleteProjectEntry(root, '.GIT'))).toBe(400)
    expect(await status(renameProjectEntry(root, '.Git', 'x'))).toBe(400)
    expect(await status(createProjectEntry(root, '.GIT/hooks', 'dir'))).toBe(400)
    expect(await status(renameProjectEntry(root, 'README.md', '.GIT'))).toBe(400)
    expect(await exists('.git')).toBe(true)
    expect(await exists('README.md')).toBe(true)
  })

  it('refuses an ancestor of a denied root', async () => {
    const denied = [path.join(root, 'src', 'nested')]
    expect(await status(deleteProjectEntry(root, 'src', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'src', 'lib', denied))).toBe(400)
    expect(await exists('src/nested')).toBe(true)
    expect(await exists('lib')).toBe(false)
  })

  it('refuses case variants of a denied root and its ancestors on a case-insensitive volume', async () => {
    const insensitive = await fs.stat(path.join(root, 'readme.md')).then(() => true, () => false)
    if (!insensitive) return
    const denied = [path.join(root, 'src', 'nested')]
    expect(await status(deleteProjectEntry(root, 'SRC', denied))).toBe(400)
    expect(await status(deleteProjectEntry(root, 'src/NESTED', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'SRC', 'lib', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'src/NESTED', 'other', denied))).toBe(400)
    expect(await status(createProjectEntry(root, 'src/NESTED/x.ts', 'file', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'src/index.ts', 'NESTED', denied))).toBe(400)
    expect(await exists('src/nested')).toBe(true)
    expect(await exists('src/index.ts')).toBe(true)
    expect(await exists('lib')).toBe(false)
    expect(await exists('src/other')).toBe(false)
  })

  it('refuses a case variant of a denied root that is a direct child of the project', async () => {
    const insensitive = await fs.stat(path.join(root, 'readme.md')).then(() => true, () => false)
    if (!insensitive) return
    await fs.mkdir(path.join(root, '.ssh'))
    await fs.writeFile(path.join(root, '.ssh', 'id'), 'k\n', 'utf8')
    const denied = [path.join(root, '.ssh')]
    expect(await status(deleteProjectEntry(root, '.SSH', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, '.SSH', 'x', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'README.md', '.SSH', denied))).toBe(400)
    expect(await exists('.ssh/id')).toBe(true)
  })

  it('refuses .git and anything under it', async () => {
    expect(await status(deleteProjectEntry(root, '.git'))).toBe(400)
    expect(await status(createProjectEntry(root, '.git/hooks', 'dir'))).toBe(400)
    expect(await status(renameProjectEntry(root, '.git', 'git'))).toBe(400)
    expect(await status(renameProjectEntry(root, 'README.md', '.git'))).toBe(400)
    expect(await status(createProjectEntry(root, 'src/.git', 'dir'))).toBe(400)
    expect(await exists('.git')).toBe(true)
  })

  it('refuses traversal and absolute paths', async () => {
    for (const raw of ['../x', `../${path.basename(outside)}/secret.txt`, path.join(outside, 'secret.txt'), 'C:/x']) {
      expect(await status(deleteProjectEntry(root, raw))).toBe(400)
      expect(await status(createProjectEntry(root, raw, 'file'))).toBe(400)
    }
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('refuses a parent folder that is a symlink out of the root', async () => {
    await fs.symlink(outside, path.join(root, 'escape'))
    expect(await status(createProjectEntry(root, 'escape/new.txt', 'file'))).toBe(400)
    expect(await status(deleteProjectEntry(root, 'escape/secret.txt'))).toBe(400)
    expect(await status(renameProjectEntry(root, 'escape/secret.txt', 'x.txt'))).toBe(400)
    expect(await fs.readdir(outside)).toEqual(['secret.txt'])
  })

  it('refuses invalid names', async () => {
    for (const name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', ' lead', 'trail ', 'x'.repeat(256)]) {
      expect(await status(renameProjectEntry(root, 'README.md', name)), JSON.stringify(name)).toBe(400)
    }
    expect(await status(createProjectEntry(root, 'src/ spaced', 'file'))).toBe(400)
    expect(await status(createProjectEntry(root, 'trailing ', 'file'))).toBe(400)
    expect(await exists('trailing')).toBe(false)
    expect(await exists('README.md')).toBe(true)
  })

  it('refuses paths inside denied roots', async () => {
    const denied = [path.join(root, 'src')]
    expect(await status(deleteProjectEntry(root, 'src', denied))).toBe(400)
    expect(await status(createProjectEntry(root, 'src/new.ts', 'file', denied))).toBe(400)
    expect(await status(renameProjectEntry(root, 'src', 'lib', denied))).toBe(400)
    expect(await exists('src/index.ts')).toBe(true)
  })
})
