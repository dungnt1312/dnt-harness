import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_SYSTEM } from '../../src/harness/context/builder.ts'

describe('default base prompt', () => {
  it('carries the TodoWrite trigger; the detailed rules live in the tool description', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('TodoWrite')
    // The base prompt deliberately does NOT repeat the tool description's
    // behavioral rules (exactly one in_progress, complete immediately) —
    // they live in one place: the TodoWrite tool schema. See
    // docs/prompt-contract.md and the g5 golden test.
    expect(DEFAULT_BASE_SYSTEM).not.toContain('in_progress')
  })

  it('anchors environment, evidence, tool discipline, and language mirroring', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('<environment_context>')
    expect(DEFAULT_BASE_SYSTEM).toContain('Ground every claim')
    expect(DEFAULT_BASE_SYSTEM).toContain('narrowest tool')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/user's language/)
  })
})
