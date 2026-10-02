import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_SYSTEM } from '../../src/harness/context/builder.ts'

describe('default base prompt', () => {
  it('carries the TodoWrite guidance', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('TodoWrite')
    expect(DEFAULT_BASE_SYSTEM).toContain('in_progress')
    expect(DEFAULT_BASE_SYSTEM).toContain('completed immediately')
  })
})
