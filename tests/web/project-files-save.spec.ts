import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withFileLock } from '../../src/capabilities/fs/observation.ts'
import { ProjectWriteError, saveProjectFile } from '../../src/web/project-files-write.ts'
import { MAX_FILE_BYTES } from '../../src/web/project-files.ts'

let root = ''
let outside = ''
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const bytesOf = (rel: string): Promise<Buffer> => fs.readFile(path.join(root, rel))
const hashOf = async (rel: string): Promise<string> => sha(await bytesOf(rel))

async function failure(promise: Promise<unknown>): Promise<ProjectWriteError> {
  try { await promise } catch (error) { if (error instanceof ProjectWriteError) return error; throw error }
  throw new Error('expected a ProjectWriteError')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-save-root-'))
  outside = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-save-out-'))
  await fs.mkdir(path.join(root, 'src'))
  await fs.mkdir(path.join(root, '.git'))
  await fs.writeFile(path.join(root, '.git', 'config'), '[core]\n')
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'crlf.txt'), 'one\r\ntwo\r\n')
  await fs.writeFile(path.join(root, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# t\n')]))
  await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await fs.writeFile(path.join(root, 'nul.bin'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside\n')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

describe('saveProjectFile', () => {
  it('saves new content and returns the new size and hash', async () => {
    const result = await saveProjectFile(root, 'src/a.ts', 'export const a = 2\n', await hashOf('src/a.ts'))
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(result).toEqual({ path: 'src/a.ts', size: 19, hash: await hashOf('src/a.ts') })
  })

  it('keeps CRLF line endings whatever the editor sent', async () => {
    await saveProjectFile(root, 'crlf.txt', 'one\ntwo\nthree\n', await hashOf('crlf.txt'))
    expect((await bytesOf('crlf.txt')).toString('utf8')).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('keeps one BOM, whether or not the content carries the BOM character', async () => {
    await saveProjectFile(root, 'bom.md', '\uFEFF# changed\n', await hashOf('bom.md'))
    expect([...(await bytesOf('bom.md')).subarray(0, 4)]).toEqual([0xef, 0xbb, 0xbf, 0x23])
    await saveProjectFile(root, 'bom.md', '# again\n', await hashOf('bom.md'))
    const bytes = await bytesOf('bom.md')
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('# again\n')
  })

  it('answers 409 with the current hash when the file changed since it was read, and writes nothing', async () => {
    const stale = await hashOf('src/a.ts')
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'agent edit\n')
    const error = await failure(saveProjectFile(root, 'src/a.ts', 'mine\n', stale))
    expect(error.status).toBe(409)
    expect(error.currentHash).toBe(await hashOf('src/a.ts'))
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('agent edit\n')
  })

  it('answers 404 for a missing file and 400 for a folder', async () => {
    expect((await failure(saveProjectFile(root, 'src/nope.ts', 'x', sha('')))).status).toBe(404)
    expect((await failure(saveProjectFile(root, 'src', 'x', sha('')))).status).toBe(400)
  })

  it('refuses binary and non-UTF-8 files', async () => {
    expect((await failure(saveProjectFile(root, 'nul.bin', 'x', await hashOf('nul.bin')))).status).toBe(400)
    expect((await failure(saveProjectFile(root, 'latin1.txt', 'x', await hashOf('latin1.txt')))).status).toBe(400)
    expect([...(await bytesOf('latin1.txt'))]).toEqual([0x63, 0x61, 0x66, 0xe9, 0x0a])
  })

  it('answers 413 when the saved file would exceed the viewer limit', async () => {
    const error = await failure(saveProjectFile(root, 'src/a.ts', 'x'.repeat(MAX_FILE_BYTES + 1), await hashOf('src/a.ts')))
    expect(error.status).toBe(413)
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1\n')
  })

  it('refuses the root, traversal, absolute paths and .git in any case', async () => {
    for (const raw of ['', '../x', path.join(outside, 'secret.txt'), '.git/config', '.GIT/config']) {
      expect((await failure(saveProjectFile(root, raw, 'x', sha('')))).status, raw).toBe(400)
    }
    expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('refuses a symlink that leads out of the project', async () => {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'leak.txt'))
    const error = await failure(saveProjectFile(root, 'leak.txt', 'pwned\n', sha('outside\n')))
    expect(error.status).toBe(400)
    expect(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('outside\n')
  })

  it('saves through an in-project symlink and keeps the link', async () => {
    await fs.symlink(path.join(root, 'src', 'a.ts'), path.join(root, 'alias.ts'))
    await saveProjectFile(root, 'alias.ts', 'via link\n', await hashOf('src/a.ts'))
    expect((await fs.lstat(path.join(root, 'alias.ts'))).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('via link\n')
  })

  it('refuses a symlink whose target is inside .git', async () => {
    await fs.symlink(path.join(root, '.git', 'config'), path.join(root, 'gitcfg'))
    const error = await failure(saveProjectFile(root, 'gitcfg', 'x\n', await hashOf('.git/config')))
    expect(error.status).toBe(400)
    expect(await fs.readFile(path.join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  it('refuses protected storage', async () => {
    const denied = [path.join(root, 'src')]
    expect((await failure(saveProjectFile(root, 'src/a.ts', 'x', await hashOf('src/a.ts'), denied))).status).toBe(400)
  })

  it('refuses when a parent folder is swapped for a link out of the project while the save waits on the lock', async () => {
    const original = 'export const a = 1\n'
    await fs.writeFile(path.join(outside, 'a.ts'), original)
    const expected = await hashOf('src/a.ts')
    const key = await fs.realpath(path.join(root, 'src', 'a.ts'))
    let saving: Promise<unknown> = Promise.resolve()
    await withFileLock(key, undefined, async () => {
      saving = saveProjectFile(root, 'src/a.ts', 'pwned\n', expected).then(() => undefined, (error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fs.rename(path.join(root, 'src'), path.join(root, 'src-old'))
      await fs.symlink(outside, path.join(root, 'src'))
    })
    const error = await saving
    expect(error).toBeInstanceOf(ProjectWriteError)
    expect([400, 409]).toContain((error as ProjectWriteError).status)
    expect(await fs.readFile(path.join(outside, 'a.ts'), 'utf8')).toBe(original)
    expect(await fs.readFile(path.join(root, 'src-old', 'a.ts'), 'utf8')).toBe(original)
  })

  it('answers 404 when the file is deleted while the save waits on the lock', async () => {
    const expected = await hashOf('src/a.ts')
    const key = await fs.realpath(path.join(root, 'src', 'a.ts'))
    let saving: Promise<unknown> = Promise.resolve()
    await withFileLock(key, undefined, async () => {
      saving = saveProjectFile(root, 'src/a.ts', 'x\n', expected).then(() => undefined, (error: unknown) => error)
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fs.rm(path.join(root, 'src', 'a.ts'))
    })
    const error = await saving
    expect(error).toBeInstanceOf(ProjectWriteError)
    expect((error as ProjectWriteError).status).toBe(404)
  })

  it('accepts an uppercase expected hash', async () => {
    const result = await saveProjectFile(root, 'src/a.ts', 'upper\n', (await hashOf('src/a.ts')).toUpperCase())
    expect(result.path).toBe('src/a.ts')
    expect(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8')).toBe('upper\n')
  })

  it('leaves no temporary file behind', async () => {
    await saveProjectFile(root, 'src/a.ts', 'b\n', await hashOf('src/a.ts'))
    expect((await fs.readdir(path.join(root, 'src'))).sort()).toEqual(['a.ts'])
  })
})
