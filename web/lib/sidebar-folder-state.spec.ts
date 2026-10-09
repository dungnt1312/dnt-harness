// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCollapsedFolders, storeCollapsedFolders } from './sidebar-folder-state.ts'

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
