import { describe, expect, it } from 'vitest'
import { closeFileWithDraft, removeFileTabs, renameFileTabs, settleSavedDraft } from './useWorkbenchFiles.ts'

const state = {
  folder: 'src',
  openFiles: ['README.md', 'src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'],
  activeFile: 'src/deep/b.ts',
  focus: { line: 4, seq: 2 },
  drafts: {},
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
      drafts: {},
    })
  })

  it('closes every tab under a deleted folder and resets the shown folder', () => {
    expect(removeFileTabs(state, 'src')).toEqual({
      folder: '',
      openFiles: ['README.md', 'srcx/c.ts'],
      activeFile: 'srcx/c.ts',
      focus: null,
      drafts: {},
    })
  })

  it('keeps the front tab and its focus when the deleted path is elsewhere', () => {
    const next = removeFileTabs(state, 'README.md')
    expect(next.openFiles).toEqual(['src/a.ts', 'src/deep/b.ts', 'srcx/c.ts'])
    expect(next.activeFile).toBe('src/deep/b.ts')
    expect(next.focus).toEqual({ line: 4, seq: 2 })
  })

  it('shows the fixed view when the last tab goes', () => {
    expect(removeFileTabs({ folder: '', openFiles: ['a.ts'], activeFile: 'a.ts', focus: null, drafts: {} }, 'a.ts'))
      .toEqual({ folder: '', openFiles: [], activeFile: null, focus: null, drafts: {} })
  })

  it('returns the same state when nothing matches', () => {
    expect(removeFileTabs(state, 'docs')).toBe(state)
  })
})

describe('drafts', () => {
  const draft = (text: string, dirty = true) => ({ text, baseHash: 'h', dirty })
  const withDrafts = {
    folder: '',
    openFiles: ['a.ts', 'src/b.ts', 'src/deep/c.ts'],
    activeFile: 'a.ts',
    focus: null,
    drafts: { 'src/b.ts': draft('B'), 'src/deep/c.ts': draft('C'), 'a.ts': draft('A', false) },
  }

  it('moves drafts with a renamed folder', () => {
    expect(renameFileTabs(withDrafts, 'src', 'lib').drafts).toEqual({ 'lib/b.ts': draft('B'), 'lib/deep/c.ts': draft('C'), 'a.ts': draft('A', false) })
  })

  it('drops drafts under a deleted path', () => {
    expect(removeFileTabs(withDrafts, 'src').drafts).toEqual({ 'a.ts': draft('A', false) })
  })

  it('asks before closing a tab with unsaved changes and keeps it when refused', () => {
    const asked: string[] = []
    const kept = closeFileWithDraft(withDrafts, 'src/b.ts', (message) => { asked.push(message); return false })
    expect(kept).toBe(withDrafts)
    expect(asked).toEqual(['Discard unsaved changes to b.ts?'])
  })

  it('closes and drops the draft when confirmed', () => {
    const next = closeFileWithDraft(withDrafts, 'src/b.ts', () => true)
    expect(next.openFiles).toEqual(['a.ts', 'src/deep/c.ts'])
    expect(next.drafts['src/b.ts']).toBeUndefined()
  })

  it('settleSavedDraft drops the draft when it still equals the saved text', () => {
    const next = settleSavedDraft(withDrafts, 'src/b.ts', 'B', 'h2')
    expect(next.drafts['src/b.ts']).toBeUndefined()
    expect(next.drafts['a.ts']).toEqual(draft('A', false))
  })

  it('settleSavedDraft keeps newer text and rebases it on the saved hash', () => {
    const next = settleSavedDraft(withDrafts, 'src/b.ts', 'older', 'h2')
    expect(next.drafts['src/b.ts']).toEqual({ text: 'B', baseHash: 'h2', dirty: true })
  })

  it('settleSavedDraft returns the same state when there is no draft', () => {
    expect(settleSavedDraft(withDrafts, 'missing.ts', 'x', 'h2')).toBe(withDrafts)
  })

  it('closes a clean draft without asking', () => {
    const next = closeFileWithDraft(withDrafts, 'a.ts', () => { throw new Error('must not ask') })
    expect(next.openFiles).toEqual(['src/b.ts', 'src/deep/c.ts'])
    expect(next.drafts['a.ts']).toBeUndefined()
  })
})
