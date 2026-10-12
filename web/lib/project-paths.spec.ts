import { describe, expect, it } from 'vitest'
import { baseName, memoryTabForReference, memoryTabOf, memoryTabPath, toProjectRelative } from './project-paths.ts'

describe('memory tabs', () => {
  const ws = 'ws-mur65pzr745ftn'
  const home = `/Users/me/.dnt-harness/data/workspaces/${ws}/memory`
  it('maps a recorded memory path of this workspace to a virtual tab, per tier', () => {
    expect(memoryTabForReference(`${home}/projects/project-abc/MEMORY.md`, ws)).toBe('memory://projects/project-abc/MEMORY.md')
    expect(memoryTabForReference(`${home}/workspace/topics/a.md`, ws)).toBe('memory://workspace/topics/a.md')
  })
  it('refuses another workspace, traversal and a bare folder', () => {
    expect(memoryTabForReference(`${home}/workspace/a.md`, 'ws-other')).toBeNull()
    expect(memoryTabForReference(`${home}/workspace/../../x.md`, ws)).toBeNull()
    expect(memoryTabForReference(`${home}/workspace`, ws)).toBeNull()
    expect(memoryTabForReference('src/a.ts', ws)).toBeNull()
  })
  it('round-trips a tab path and titles it by the file name', () => {
    expect(memoryTabOf(memoryTabPath({ projectId: 'p1', file: 'x/MEMORY.md' }))).toEqual({ projectId: 'p1', file: 'x/MEMORY.md' })
    expect(memoryTabOf(memoryTabPath({ file: 'a.md' }))).toEqual({ file: 'a.md' })
    expect(memoryTabOf('src/a.ts')).toBeNull()
    expect(baseName('memory://projects/p1/topics/note.md')).toBe('note.md')
  })
})

describe('toProjectRelative', () => {
  it('maps absolute paths inside the root, ignoring separator and drive-letter case', () => {
    expect(toProjectRelative('C:\\Work\\app', 'c:/work/app/src/index.ts')).toBe('src/index.ts')
    expect(toProjectRelative('/home/me/app/', '/home/me/app/README.md')).toBe('README.md')
  })
  it('keeps relative paths root-relative', () => {
    expect(toProjectRelative('C:/work/app', './src\\x.ts')).toBe('src/x.ts')
  })
  it('refuses paths outside the root, the root itself and traversal', () => {
    expect(toProjectRelative('C:/work/app', 'C:/work/application/x.ts')).toBeNull()
    expect(toProjectRelative('/home/me/app', '/home/me/App/x.ts')).toBeNull()
    expect(toProjectRelative('C:/work/app', 'C:/work/app')).toBeNull()
    expect(toProjectRelative('C:/work/app', '../secret.txt')).toBeNull()
    expect(toProjectRelative('C:/work/app', '')).toBeNull()
  })
  it('names a tab from the last segment', () => {
    expect(baseName('src/components/App.tsx')).toBe('App.tsx')
  })
})
