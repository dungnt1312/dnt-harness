import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FILE_BYTES, readProjectFile } from '../../src/web/project-files.ts'

let root = ''
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-read-flags-'))
  await fs.writeFile(path.join(root, 'plain.ts'), 'export const a = 1\n')
  await fs.writeFile(path.join(root, 'crlf.txt'), 'a\r\nb\r\n')
  await fs.writeFile(path.join(root, 'bom.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# t\n')]))
  await fs.writeFile(path.join(root, 'empty.txt'), '')
  await fs.writeFile(path.join(root, 'nul.bin'), Buffer.from([0x41, 0x00, 0x42]))
  await fs.writeFile(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  await fs.writeFile(path.join(root, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]))
  await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(MAX_FILE_BYTES + 1))
})

afterAll(async () => { await fs.rm(root, { recursive: true, force: true }) })

describe('readProjectFile edit flags', () => {
  it('marks plain, CRLF, BOM and empty UTF-8 files editable with the hash of their bytes', async () => {
    for (const name of ['plain.ts', 'crlf.txt', 'bom.md', 'empty.txt']) {
      const file = await readProjectFile(root, name)
      expect(file.editable, name).toBe(true)
      expect(file.hash, name).toBe(sha(await fs.readFile(path.join(root, name))))
    }
  })

  it('keeps content exactly as before (CRLF and BOM character included)', async () => {
    expect((await readProjectFile(root, 'crlf.txt')).content).toBe('a\r\nb\r\n')
    expect((await readProjectFile(root, 'bom.md')).content).toBe('\uFEFF# t\n')
  })

  it('marks binary, invalid UTF-8 and UTF-16 files not editable', async () => {
    for (const name of ['nul.bin', 'latin1.txt', 'utf16.txt']) {
      expect((await readProjectFile(root, name)).editable, name).toBe(false)
    }
  })

  it('gives a truncated file no hash and no edit', async () => {
    const big = await readProjectFile(root, 'big.txt')
    expect(big.truncated).toBe(true)
    expect(big.editable).toBe(false)
    expect(big.hash).toBeUndefined()
  })
})
