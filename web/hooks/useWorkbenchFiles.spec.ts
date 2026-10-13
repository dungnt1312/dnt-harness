import { describe, expect, it } from 'vitest'
import { removeFileTabs, renameFileTabs } from './useWorkbenchFiles.ts'

const state = {
  folder: 'src',
  openFiles: ['README.md', 'src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'],
  activeFile: 'src/deep/b.ts',
  focus: { line: 4, seq: 2 },
}

describe('renameFileTabs', () => {
  it('rewrites a renamed file tab and keeps its focus', () => {
    expect(renameFileTabs(state, 'src/deep/b.ts', 'src/deep/z.ts')).toEqual({
      ...state,
      openFiles: ['README.md', 'src/a.ts', 'src/deep/z.ts', 'srcx/c.ts'],
      activeFile: 'src/deep/z.ts',
    })
  })

  it('rewrites every tab under a renamed folder and the shown folder, not a sibling prefix', () => {
    expect(renameFileTabs(state, 'src', 'lib')).toEqual({
      ...state,
      folder: 'lib',
      openFiles: ['README.md', 'lib/a.ts', 'lib/deep/b.ts', 'srcx/c.ts'],
      activeFile: 'lib/deep/b.ts',
    })
  })

  it('returns the same state when nothing matches', () => {
    expect(renameFileTabs(state, 'docs', 'notes')).toBe(state)
  })
})

describe('removeFileTabs', () => {
  it('closes a deleted file tab and reveals its right neighbour', () => {
    expect(removeFileTabs({ ...state, activeFile: 'src/a.ts' }, 'src/a.ts')).toEqual({
      folder: 'src',
      openFiles: ['README.md', 'src/deep/b.ts', 'srcx/c.ts'],
      activeFile: 'src/deep/b.ts',
      focus: null,
    })
  })

  it('closes every tab under a deleted folder and resets the shown folder', () => {
    expect(removeFileTabs(state, 'src')).toEqual({
      folder: '',
      openFiles: ['README.md', 'srcx/c.ts'],
      activeFile: 'srcx/c.ts',
      focus: null,
    })
  })

  it('keeps the front tab and its focus when the deleted path is elsewhere', () => {
    const next = removeFileTabs(state, 'README.md')
    expect(next.openFiles).toEqual(['src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'])
    expect(next.activeFile).toBe('src/deep/b.ts')
    expect(next.focus).toEqual({ line: 4, seq: 2 })
  })

  it('shows the fixed view when the last tab goes', () => {
    expect(removeFileTabs({ folder: '', openFiles: ['a.ts'], activeFile: 'a.ts', focus: null }, 'a.ts'))
      .toEqual({ folder: '', openFiles: [], activeFile: null, focus: null })
  })

  it('returns the same state when nothing matches', () => {
    expect(removeFileTabs(state, 'docs')).toBe(state)
  })
})
