/**
 * The file tools' text model: CRLF/BOM/UTF-16 files read as LF text and keep
 * their bytes on edit, binary files are refused, conservative Edit fallbacks
 * (gutter, trailing whitespace, indentation, quotes) stay unique-or-refuse,
 * Claude-style argument aliases canonicalize, and a child agent inherits its
 * parent's observations under the same hash check.
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fsTools, type ToolExecution } from 'dnt-harness'
import { FileObservations } from '../../src/capabilities/fs/observation.ts'
import { decodeDocument, spliceDocument, BinaryFileError } from '../../src/capabilities/fs/text-document.ts'
import { findEditMatch } from '../../src/capabilities/fs/edit-match.ts'
import { canonicalCall } from '../../src/harness/tools/names.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dnt-harness-text-doc-'))
  roots.push(root)
  const tools = new Map(fsTools().map((tool) => [tool.name, tool]))
  const invoke = (name: string, args: Record<string, unknown>, exec: ToolExecution) => tools.get(name)!.execute(args, exec)
  const observations = new FileObservations()
  const session: ToolExecution = { root, sessionId: 'root-a' as never, observations }
  return { root, invoke, session, observations }
}

describe('text document model', () => {
  it('folds CRLF for the model and splices back with the original bytes intact', () => {
    const doc = decodeDocument(Buffer.from('a\r\nb\nc\r\n'), 'mixed.txt')
    expect(doc.text).toBe('a\nb\nc\n')
    expect(doc.mixedEol).toBe(true)
    expect(doc.eol).toBe('crlf')
    const start = doc.text.indexOf('b')
    expect(spliceDocument(doc, [{ start, end: start + 1, text: 'B1\nB2' }])).toBe('a\r\nB1\r\nB2\nc\r\n')
  })

  it('refuses binary content and marks invalid UTF-8 read-only', () => {
    expect(() => decodeDocument(Buffer.from([0x50, 0x4b, 0x00, 0x03]), 'x.zip')).toThrow(BinaryFileError)
    const lossy = decodeDocument(Buffer.from([0x61, 0xff, 0x62]), 'latin.txt')
    expect(lossy.writable).toBe(false)
  })

  it('Edit on a CRLF file matches LF `old` and keeps CRLF everywhere', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'win.ts'), 'const a = 1\r\nconst b = 2\r\nconst c = 3\r\n')
    expect(await invoke('Read', { path: 'win.ts' }, session)).toBe('1\tconst a = 1\n2\tconst b = 2\n3\tconst c = 3')
    const result = await invoke('Edit', { path: 'win.ts', old: 'const a = 1\nconst b = 2\n', new: 'const a = 10\nconst b = 20\nconst x = 0\n' }, session)
    expect(result).toMatch(/^edited win\.ts\n/)
    expect(await fs.readFile(path.join(root, 'win.ts'), 'utf8')).toBe('const a = 10\r\nconst b = 20\r\nconst x = 0\r\nconst c = 3\r\n')
    // The tool's own write is observed: a follow-up edit needs no re-read.
    await invoke('Edit', { path: 'win.ts', old: 'const c = 3', new: 'const c = 30' }, session)
    expect(await fs.readFile(path.join(root, 'win.ts'), 'utf8')).toBe('const a = 10\r\nconst b = 20\r\nconst x = 0\r\nconst c = 30\r\n')
  })

  it('Write over an existing file keeps its BOM and line endings', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('old\r\n')]))
    expect(await invoke('Read', { path: 'bom.txt' }, session)).toBe('1\told')
    await invoke('Write', { path: 'bom.txt', content: 'new\nlines\n' }, session)
    const bytes = await fs.readFile(path.join(root, 'bom.txt'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(bytes.subarray(3).toString('utf8')).toBe('new\r\nlines\r\n')
  })

  it('UTF-16LE files round-trip through Edit', async () => {
    const { root, invoke, session } = await setup()
    const file = path.join(root, 'wide.txt')
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('xin chào\r\n', 'utf16le')]))
    await invoke('Read', { path: 'wide.txt' }, session)
    await invoke('Edit', { path: 'wide.txt', old: 'chào', new: 'chào bạn' }, session)
    const bytes = await fs.readFile(file)
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(bytes.subarray(2).toString('utf16le')).toBe('xin chào bạn\r\n')
  })

  it('binary files are refused by Read and Edit', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]))
    await expect(invoke('Read', { path: 'blob.bin' }, session)).rejects.toThrow(/binary/)
  })

  it('Read caps the window and tells the model where to continue', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'long.txt'), Array.from({ length: 2_500 }, (_, i) => `line ${i + 1}`).join('\n'))
    const output = await invoke('Read', { path: 'long.txt' }, session)
    expect(output.split('\n')).toHaveLength(2_001)
    expect(output).toMatch(/showing lines 1-2000 of 2500; continue with offset 2001\]$/)
  })

  it('a not-found error shows the closest current lines with numbers', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'hint.ts'), 'function a() {\n  return compute(1)\n}\n')
    await invoke('Read', { path: 'hint.ts' }, session)
    await expect(invoke('Edit', { path: 'hint.ts', old: 'function a() {\n  return compute(2)\n}', new: 'x' }, session))
      .rejects.toThrow(/not found[\s\S]*Closest lines[\s\S]*1\tfunction a\(\) \{/)
  })

  it('identical old and new are rejected', async () => {
    const { root, invoke, session } = await setup()
    await fs.writeFile(path.join(root, 'same.txt'), 'abc')
    await invoke('Read', { path: 'same.txt' }, session)
    await expect(invoke('Edit', { path: 'same.txt', old: 'abc', new: 'abc' }, session)).rejects.toThrow(/identical/)
  })
})

describe('Edit fallback matchers', () => {
  const file = 'class A {\n  run() {\n    go(\u2018x\u2019)   \n    stop()\n  }\n}\n'

  it('strips a pasted Read gutter from old and new', () => {
    const match = findEditMatch(file, '4\t    stop()', '4\t    halt()', false)
    expect(match).toMatchObject({ kind: 'matched', strategy: 'line-numbers-stripped', splices: [{ text: '    halt()' }] })
  })

  it('tolerates trailing whitespace differences', () => {
    const match = findEditMatch(file, "    go(\u2018x\u2019)\n    stop()\n", '    done()\n', false)
    expect(match).toMatchObject({ kind: 'matched', strategy: 'trailing-whitespace' })
  })

  it('matches a different base indentation and re-indents the replacement', () => {
    const match = findEditMatch(file, 'run() {\n  go(\u2018x\u2019)\n  stop()\n}', 'run() {\n  stop()\n}', false)
    expect(match).toMatchObject({ kind: 'matched', strategy: 'indentation', splices: [{ text: '  run() {\n    stop()\n  }' }] })
  })

  it('normalizes typographic quotes', () => {
    const match = findEditMatch(file, "go('x')", "go('y')", false)
    expect(match).toMatchObject({ kind: 'matched', strategy: 'quotes' })
  })

  it('a fallback that matches more than one place is ambiguous, never a guess', () => {
    const twice = 'if (a) {\n  b()\n}\n  if (a) {\n    b()\n  }\n'
    expect(findEditMatch(twice, '\tif (a) {\n\t  b()\n\t}', 'x', false)).toMatchObject({ kind: 'ambiguous', strategy: 'indentation', lines: [1, 4] })
  })

  it('replaceAll uses exact matching only', () => {
    expect(findEditMatch(file, "go('x')", 'y', true)).toMatchObject({ kind: 'not-found' })
  })
})

describe('argument aliases and inherited observations', () => {
  it('canonicalizes Claude-style file tool arguments; canonical names win', () => {
    expect(canonicalCall({ id: '1', name: 'Edit', args: { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true } }).args)
      .toEqual({ path: 'a.ts', old: 'x', new: 'y', replaceAll: true })
    expect(canonicalCall({ id: '2', name: 'Read', args: { path: 'real.ts', file_path: 'alias.ts' } }).args).toEqual({ path: 'real.ts' })
    const untouched = { id: '3', name: 'Bash', args: { file_path: 'kept' } }
    expect(canonicalCall(untouched)).toBe(untouched)
  })

  it('a child agent may edit what its parent read, but only while the bytes are unchanged', async () => {
    const { root, invoke, session, observations } = await setup()
    await fs.writeFile(path.join(root, 'shared.txt'), 'parent saw this')
    await invoke('Read', { path: 'shared.txt' }, session)
    const child: ToolExecution = { root, sessionId: 'child-1' as never, observations, observationParents: ['root-a' as never] }
    await invoke('Edit', { path: 'shared.txt', old: 'parent', new: 'child' }, child)
    expect(await fs.readFile(path.join(root, 'shared.txt'), 'utf8')).toBe('child saw this')

    const sibling: ToolExecution = { root, sessionId: 'child-2' as never, observations, observationParents: ['root-a' as never] }
    await expect(invoke('Edit', { path: 'shared.txt', old: 'saw', new: 'wrote' }, sibling)).rejects.toThrow(/changed on disk/)
    const stranger: ToolExecution = { root, sessionId: 'other' as never, observations }
    await expect(invoke('Edit', { path: 'shared.txt', old: 'saw', new: 'wrote' }, stranger)).rejects.toThrow(/never read/)
  })
})
