import { describe, expect, it } from 'vitest'
import { ancestorsOf, dropKeysUnder, dropUnderSet, isAtOrUnder, joinPath, parentOf, targetFolder, writeErrorText } from './file-tree.ts'

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
})
