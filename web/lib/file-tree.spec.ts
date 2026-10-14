import { describe, expect, it } from 'vitest'
import {
  absoluteEntryPath, ancestorsOf, dropKeysUnder, dropUnderSet, isAtOrUnder, joinPath, parentOf,
  PROJECT_FILE_DRAG_TYPE, readProjectFileDrag, targetFolder, writeErrorText, writeProjectFileDrag,
} from './file-tree.ts'

/** A minimal drag store capturing what rows write. */
function dragStore(initial: Readonly<Record<string, string>> = {}): { setData: (type: string, value: string) => void; getData: (type: string) => string; written: Map<string, string> } {
  const written = new Map(Object.entries(initial))
  return {
    written,
    setData: (type, value) => { written.set(type, value) },
    getData: (type) => written.get(type) ?? '',
  }
}

describe('explorer path helpers', () => {
  it('matches a path itself and its descendants, not a sibling prefix', () => {
    expect(isAtOrUnder('src', 'src')).toBe(true)
    expect(isAtOrUnder('src/a.ts', 'src')).toBe(true)
    expect(isAtOrUnder('srcx/a.ts', 'src')).toBe(false)
  })

  it('splits and joins root-relative paths', () => {
    expect(parentOf('a.ts')).toBe('')
    expect(parentOf('src/deep/a.ts')).toBe('src/deep')
    expect(joinPath('', 'a.ts')).toBe('a.ts')
    expect(joinPath('src', 'a.ts')).toBe('src/a.ts')
    expect(ancestorsOf('')).toEqual([])
    expect(ancestorsOf('src/deep')).toEqual(['src', 'src/deep'])
  })

  it('creates inside a selected folder, beside a selected file, else at the root', () => {
    expect(targetFolder(null)).toBe('')
    expect(targetFolder({ path: 'src', kind: 'dir' })).toBe('src')
    expect(targetFolder({ path: 'src/a.ts', kind: 'file' })).toBe('src')
    expect(targetFolder({ path: 'a.ts', kind: 'file' })).toBe('')
  })

  it('drops cached folders and open state at or under a path, keeping identity when nothing changes', () => {
    const nodes = { '': 1, src: 2, 'src/deep': 3, srcx: 4 }
    expect(dropKeysUnder(nodes, 'src')).toEqual({ '': 1, srcx: 4 })
    expect(dropKeysUnder(nodes, 'docs')).toBe(nodes)
    const open = new Set(['src', 'src/deep', 'srcx'])
    expect([...dropUnderSet(open, 'src')]).toEqual(['srcx'])
    expect(dropUnderSet(open, 'docs')).toBe(open)
  })

  it('reads the server error message out of an HTTP error body', () => {
    expect(writeErrorText({ status: 409, body: '{"error":"\'a.ts\' already exists"}' })).toBe("'a.ts' already exists")
    expect(writeErrorText({ status: 502, body: 'Bad gateway' })).toBe('Bad gateway')
    expect(writeErrorText(new Error('offline'))).toBe('offline')
    expect(writeErrorText('boom')).toBe('boom')
  })

  it('builds absolute paths from the project root, not from entry slashes', () => {
    expect(absoluteEntryPath('/work/proj', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(absoluteEntryPath('/work/proj/', 'src/a.ts')).toBe('/work/proj/src/a.ts')
    expect(absoluteEntryPath('/work/proj', '')).toBe('/work/proj')
  })

  it('writes a project-file drag payload with a plain-path fallback, and reads it back strictly', () => {
    expect(PROJECT_FILE_DRAG_TYPE).toBe('application/x-dnt-project-file')
    const store = dragStore()
    writeProjectFileDrag(store, { path: 'src/a b.ts', kind: 'file' })
    expect(store.written.get(PROJECT_FILE_DRAG_TYPE)).toBe('{"path":"src/a b.ts","kind":"file"}')
    expect(store.written.get('text/plain')).toBe('src/a b.ts')
    // A folder writes its folder path, not a trailing slash.
    const folder = dragStore()
    writeProjectFileDrag(folder, { path: 'src', kind: 'dir' })
    expect(folder.written.get('text/plain')).toBe('src')

    expect(readProjectFileDrag({ getData: () => store.getData(PROJECT_FILE_DRAG_TYPE) })).toEqual({ path: 'src/a b.ts', kind: 'file' })
    // Anything but the exact shape is not a project-file drag.
    expect(readProjectFileDrag({ getData: () => '[]' })).toBeNull()
    expect(readProjectFileDrag({ getData: () => '{"path":"a.ts"}' })).toBeNull()
    expect(readProjectFileDrag({ getData: () => '' })).toBeNull()
  })
})
