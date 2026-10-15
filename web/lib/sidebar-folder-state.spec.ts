// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCollapsedFolders, storeCollapsedFolders, loadExpandedFolders, storeExpandedFolders } from './sidebar-folder-state.ts'

describe('sidebar folder collapse persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('restores collapsed folders only for the requested workspace', () => {
    storeCollapsedFolders('w1', { projectA: true, projectB: false, __automations__: true })

    expect(loadCollapsedFolders('w1')).toEqual({ projectA: true, __automations__: true })
    expect(loadCollapsedFolders('w2')).toEqual({})
  })

  it('ignores malformed or non-boolean stored values', () => {
    window.localStorage.setItem('dnt-harness.sidebar-collapsed.w1', JSON.stringify({ projectA: true, projectB: 'yes', projectC: false }))

    expect(loadCollapsedFolders('w1')).toEqual({ projectA: true })
  })
})

describe('sidebar folder expansion persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('restores expansion counts only for the requested workspace', () => {
    storeExpandedFolders('w1', { projectA: 10, __automations__: 5 })

    expect(loadExpandedFolders('w1')).toEqual({ projectA: 10, __automations__: 5 })
    expect(loadExpandedFolders('w2')).toEqual({})
  })

  it('ignores malformed or non-finite stored values', () => {
    window.localStorage.setItem('dnt-harness.sidebar-expanded.w1', JSON.stringify({ projectA: 10, projectB: 'many', projectC: 0 }))

    expect(loadExpandedFolders('w1')).toEqual({ projectA: 10, projectC: 0 })
  })
})
