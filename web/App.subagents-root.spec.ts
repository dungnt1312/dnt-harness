import { describe, expect, it } from 'vitest'
import { subagentsRootSession } from './App.tsx'

describe('subagents root session', () => {
  it('lists a root conversation delegation from itself', () => {
    expect(subagentsRootSession({ id: 's1' })).toBe('s1')
    expect(subagentsRootSession({ id: 's2', parentSessionId: null })).toBe('s2')
  })

  it('lists a subagent conversation delegation from its parent — a child has no children of its own', () => {
    expect(subagentsRootSession({ id: 'c1', parentSessionId: 's1' })).toBe('s1')
  })

  it('has no root without an open conversation', () => {
    expect(subagentsRootSession(null)).toBeNull()
  })
})
