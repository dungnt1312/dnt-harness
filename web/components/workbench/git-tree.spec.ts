import { describe, expect, it } from 'vitest'
import type { GitChange, GitStaging } from '../../lib/api.ts'
import { buildTree, folderStageTargets, folderToggleState, visibleNodes } from './git-tree.ts'

const change = (path: string, staging: GitStaging = 'unstaged'): GitChange => ({
  path, status: 'modified', indexStatus: ' ', worktreeStatus: 'M', created: false, deleted: false, conflicted: false, staging,
})

const label = (node: ReturnType<typeof buildTree>[number]): string =>
  node.kind === 'dir' ? `d:${node.name}@${node.depth}` : `f:${node.change.path}@${node.depth}`

describe('buildTree (Zed git_panel.rs:864-998)', () => {
  it('lists directories before files, in name order, with depths', () => {
    const nodes = buildTree([change('z.ts'), change('src/b.ts'), change('src/a.ts'), change('docs/x.md'), change('a.ts')])
    expect(nodes.map(label)).toEqual([
      'd:docs@0', 'f:docs/x.md@1',
      'd:src@0', 'f:src/a.ts@1', 'f:src/b.ts@1',
      'f:a.ts@0', 'f:z.ts@0',
    ])
  })

  it('compacts a directory with no files and exactly one child directory (a/b/c)', () => {
    const nodes = buildTree([change('src/web/a.ts'), change('src/web/b.ts'), change('docs/x.md'), change('z.ts')])
    expect(nodes.map(label)).toEqual([
      'd:docs@0', 'f:docs/x.md@1',
      'd:src/web@0', 'f:src/web/a.ts@1', 'f:src/web/b.ts@1',
      'f:z.ts@0',
    ])
    const deep = buildTree([change('a/b/c/d.ts')])
    expect(deep.map(label)).toEqual(['d:a/b/c@0', 'f:a/b/c/d.ts@1'])
  })

  it('does not compact a directory that holds a file next to its child directory', () => {
    const nodes = buildTree([change('src/index.ts'), change('src/web/a.ts')])
    expect(nodes.map(label)).toEqual(['d:src@0', 'd:web@1', 'f:src/web/a.ts@2', 'f:src/index.ts@1'])
  })

  it('a directory node carries every change beneath it and its full path as the key', () => {
    const nodes = buildTree([change('src/a.ts'), change('src/sub/b.ts')])
    const src = nodes[0]!
    expect(src.kind).toBe('dir')
    if (src.kind === 'dir') {
      expect(src.path).toBe('src')
      expect(src.entries.map((entry) => entry.path)).toEqual(['src/a.ts', 'src/sub/b.ts'])
    }
    expect(new Set(nodes.map((node) => node.key)).size).toBe(nodes.length)
  })
})

describe('visibleNodes', () => {
  it('hides the children of a collapsed folder, nested ones included', () => {
    const nodes = buildTree([change('src/index.ts'), change('src/web/a.ts'), change('z.ts')])
    expect(visibleNodes(nodes, new Set(['src'])).map(label)).toEqual(['d:src@0', 'f:z.ts@0'])
    expect(visibleNodes(nodes, new Set(['src/web'])).map(label)).toEqual(['d:src@0', 'd:web@1', 'f:src/index.ts@1', 'f:z.ts@0'])
  })
})

describe('folder checkbox (Zed git_panel.rs:3300-3345, 3407-3428)', () => {
  it('is checked when every descendant is staged, indeterminate when any is staged or partial, else unchecked', () => {
    expect(folderToggleState([change('a', 'staged'), change('b', 'staged')])).toBe('selected')
    expect(folderToggleState([change('a', 'staged'), change('b')])).toBe('indeterminate')
    expect(folderToggleState([change('a', 'partial')])).toBe('indeterminate')
    expect(folderToggleState([change('a'), change('b')])).toBe('unselected')
  })

  it('a click stages only descendants not already staged, or unstages only those not already unstaged', () => {
    expect(folderStageTargets([change('a', 'staged'), change('b')], 'indeterminate')).toEqual({ paths: ['b'], intent: 'stage' })
    expect(folderStageTargets([change('a', 'staged'), change('b', 'staged')], 'selected')).toEqual({ paths: ['a', 'b'], intent: 'unstage' })
    expect(folderStageTargets([change('a'), change('b', 'partial')], 'unselected')).toEqual({ paths: ['a', 'b'], intent: 'stage' })
  })
})
