// @vitest-environment jsdom
import { createElement, act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { closeFileTab, removeFileTabs, renameFileTabs, settleInProject, settleSavedDraft, switchProject, useWorkbenchFiles, type FilesState, type WorkbenchFiles } from './useWorkbenchFiles.ts'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

  it('closing a tab drops its draft and its chosen view mode', () => {
    const next = closeFileTab({ ...withDrafts, modes: { 'src/b.ts': 'split', 'a.ts': 'code' } }, 'src/b.ts')
    expect(next.openFiles).toEqual(['a.ts', 'src/deep/c.ts'])
    expect(next.drafts['src/b.ts']).toBeUndefined()
    expect(next.modes).toEqual({ 'a.ts': 'code' })
  })

  it('moves view modes with a renamed folder and drops them under a deleted one', () => {
    const modes = { 'src/b.ts': 'split', 'src/deep/c.ts': 'preview', 'a.ts': 'code' } as const
    expect(renameFileTabs({ ...withDrafts, modes }, 'src', 'lib').modes).toEqual({ 'lib/b.ts': 'split', 'lib/deep/c.ts': 'preview', 'a.ts': 'code' })
    expect(removeFileTabs({ ...withDrafts, modes }, 'src').modes).toEqual({ 'a.ts': 'code' })
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

})

describe('switchProject', () => {
  const empty: FilesState = { folder: '', openFiles: [], activeFile: null, focus: null, drafts: {} }
  const dirty: FilesState = {
    folder: 'src',
    openFiles: ['a.ts', 'b.ts'],
    activeFile: 'b.ts',
    focus: null,
    drafts: { 'b.ts': { text: 'B', baseHash: 'h', dirty: true } },
  }
  const clean: FilesState = { ...dirty, drafts: { 'b.ts': { text: 'b', baseHash: 'h', dirty: false } } }

  it('stashes a state with a dirty draft and restores it, tabs and drafts intact, on return', () => {
    const away = switchProject(new Map(), 'A', dirty, 'B')
    expect(away.state).toEqual(empty)
    expect(away.stash.get('A')).toBe(dirty)
    const back = switchProject(away.stash, 'B', away.state, 'A')
    expect(back.state).toBe(dirty)
    expect(back.stash.has('A')).toBe(false)
  })

  it('does not stash a clean state and drops an older stash of that project', () => {
    expect(switchProject(new Map(), 'A', clean, 'B').stash.size).toBe(0)
    expect(switchProject(new Map([['A', dirty]]), 'A', clean, 'B').stash.has('A')).toBe(false)
  })

  it('gives an empty state when the entered project has no stash', () => {
    expect(switchProject(new Map([['A', dirty]]), 'B', clean, 'C').state).toEqual(empty)
  })

  it('entering no project gives an empty state and keeps the stash; leaving none never stashes', () => {
    const stash = new Map([['A', dirty]])
    const toNone = switchProject(stash, 'B', dirty, null)
    expect(toNone.state).toEqual(empty)
    expect(toNone.stash.get('A')).toBe(dirty)
    expect(toNone.stash.get('B')).toBe(dirty)
    const fromNone = switchProject(new Map(), null, dirty, 'A')
    expect(fromNone.stash.size).toBe(0)
  })

  it('does not mutate the stash it was given', () => {
    const stash = new Map([['A', dirty]])
    switchProject(stash, 'B', dirty, 'A')
    expect([...stash.keys()]).toEqual(['A'])
  })
})

describe('settleInProject', () => {
  const file = (text: string, hash = 'h'): FilesState => ({
    folder: '', openFiles: ['README.md'], activeFile: 'README.md', focus: null,
    drafts: { 'README.md': { text, baseHash: hash, dirty: true } },
  })
  const live = file('b-live', 'hb')
  const stashedA = file('a2', 'ha')

  it('settles the stashed entry of a non-live project and leaves the live state alone', () => {
    const stash = new Map([['A', stashedA]])
    const next = settleInProject(live, 'B', stash, 'A', 'README.md', 'a2', 'ha2')
    expect(next.live).toBe(live)
    expect(next.stash.has('A')).toBe(false)
    expect(stash.get('A')).toBe(stashedA)
  })

  it('keeps a stashed entry that holds newer text, rebased on the saved hash', () => {
    const next = settleInProject(live, 'B', new Map([['A', stashedA]]), 'A', 'README.md', 'older', 'ha2')
    expect(next.live).toBe(live)
    expect(next.stash.get('A')?.drafts['README.md']).toEqual({ text: 'a2', baseHash: 'ha2', dirty: true })
  })

  it('settles the live state for the live key and leaves the stash alone', () => {
    const stash = new Map([['A', stashedA]])
    const next = settleInProject(live, 'B', stash, 'B', 'README.md', 'b-live', 'hb2')
    expect(next.live.drafts).toEqual({})
    expect(next.stash).toBe(stash)
    const newer = settleInProject(live, 'B', stash, 'B', 'README.md', 'older', 'hb2')
    expect(newer.live.drafts['README.md']).toEqual({ text: 'b-live', baseHash: 'hb2', dirty: true })
  })

  it('changes nothing for an unknown key', () => {
    const stash = new Map([['A', stashedA]])
    const next = settleInProject(live, 'B', stash, 'C', 'README.md', 'a2', 'x')
    expect(next.live).toBe(live)
    expect(next.stash).toBe(stash)
  })

  it('changes nothing when the stashed entry has no draft at the path', () => {
    const stash = new Map([['A', stashedA]])
    const next = settleInProject(live, 'B', stash, 'A', 'other.md', 'a2', 'x')
    expect(next.live).toBe(live)
    expect(next.stash).toBe(stash)
  })
})

describe('useWorkbenchFiles across projects', () => {
  let root: Root | undefined
  let host: HTMLDivElement
  afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove() })

  const mountProbe = async (): Promise<() => WorkbenchFiles> => {
    let files!: WorkbenchFiles
    const Probe = (): null => { files = useWorkbenchFiles('A'); return null }
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(createElement(Probe)))
    return () => files
  }

  it('closes a clean tab at once and asks before closing one with unsaved changes', async () => {
    const files = await mountProbe()
    await act(async () => { files().openFile('clean.ts'); files().openFile('dirty.ts'); files().setDraft('dirty.ts', { text: 'x', baseHash: 'h', dirty: true }) })
    await act(async () => files().closeFile('clean.ts'))
    expect(files().openFiles).toEqual(['dirty.ts'])
    expect(files().closeRequest).toBeNull()

    await act(async () => files().closeFile('dirty.ts'))
    expect(files().closeRequest).toBe('dirty.ts')
    expect(files().openFiles).toEqual(['dirty.ts'])

    await act(async () => files().cancelClose())
    expect(files().closeRequest).toBeNull()
    expect(files().openFiles).toEqual(['dirty.ts'])
    expect(files().drafts['dirty.ts']?.text).toBe('x')

    await act(async () => files().closeFile('dirty.ts'))
    await act(async () => files().confirmClose())
    expect(files().closeRequest).toBeNull()
    expect(files().openFiles).toEqual([])
    expect(files().drafts).toEqual({})
  })

  it('remembers the view mode per tab', async () => {
    const files = await mountProbe()
    await act(async () => { files().openFile('README.md'); files().setMode('README.md', 'split') })
    expect(files().modes).toEqual({ 'README.md': 'split' })
    await act(async () => files().closeFile('README.md'))
    expect(files().modes).toBeUndefined()
  })

  it('shows an unsaved draft again after switching away and back', async () => {
    let files!: WorkbenchFiles
    const Probe = ({ projectKey }: { projectKey: string }): null => { files = useWorkbenchFiles(projectKey); return null }
    const show = (key: string): ReactElement => createElement(Probe, { projectKey: key })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(show('A')))
    await act(async () => { files.openFile('a.ts'); files.setDraft('a.ts', { text: 'mine', baseHash: 'h', dirty: true }) })
    await act(async () => root!.render(show('B')))
    expect(files.openFiles).toEqual([])
    expect(files.drafts).toEqual({})
    await act(async () => root!.render(show('A')))
    expect(files.openFiles).toEqual(['a.ts'])
    expect(files.activeFile).toBe('a.ts')
    expect(files.drafts['a.ts']).toEqual({ text: 'mine', baseHash: 'h', dirty: true })
  })

  it('settles a save that returns after a project switch in the project it started in', async () => {
    let files!: WorkbenchFiles
    const Probe = ({ projectKey }: { projectKey: string }): null => { files = useWorkbenchFiles(projectKey); return null }
    const show = (key: string): ReactElement => createElement(Probe, { projectKey: key })
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    await act(async () => root!.render(show('A')))
    await act(async () => { files.openFile('README.md'); files.setDraft('README.md', { text: 'a2', baseHash: 'ha', dirty: true }) })
    const savingKey = files.projectKey
    expect(savingKey).toBe('A')
    await act(async () => root!.render(show('B')))
    await act(async () => { files.openFile('README.md'); files.setDraft('README.md', { text: 'a2', baseHash: 'hb', dirty: true }) })
    // The PUT for A returns while B is showing.
    await act(async () => files.settleDraft(savingKey, 'README.md', 'a2', 'ha2'))
    expect(files.drafts['README.md']).toEqual({ text: 'a2', baseHash: 'hb', dirty: true })
    await act(async () => root!.render(show('A')))
    expect(files.drafts['README.md']).toBeUndefined()
  })
})
