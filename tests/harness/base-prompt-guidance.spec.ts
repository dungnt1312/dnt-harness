import { describe, expect, it } from 'vitest'
import { DEFAULT_BASE_SYSTEM, DEFAULT_CHILD_SYSTEM } from '../../src/harness/context/builder.ts'

describe('default base prompt', () => {
  it('carries the TodoWrite trigger; the detailed rules live in the tool description', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('TodoWrite')
    // The base prompt deliberately does NOT repeat the tool description's
    // behavioral rules (at most one in_progress, complete immediately) —
    // they live in one place: the TodoWrite tool schema. See
    // docs/prompt-contract.md and the g5 golden test.
    expect(DEFAULT_BASE_SYSTEM).not.toContain('in_progress')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/TodoWrite tool when it is available/)
  })

  it('anchors environment, evidence, tool discipline, and language mirroring', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('<environment_context>')
    expect(DEFAULT_BASE_SYSTEM).toContain('Ground every claim')
    expect(DEFAULT_BASE_SYSTEM).toContain('narrowest available tool that fits the task')
    expect(DEFAULT_BASE_SYSTEM).toContain('the host enforces permissions and approvals')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/user's language/)
  })

  it('selects tools by task, not semantic-search-first, and shares the principle with the child prompt', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('Use Bash for builds, tests, Git, package managers, metadata inspection')
    expect(DEFAULT_BASE_SYSTEM).not.toMatch(/Prefer the narrowest tool/)
    expect(DEFAULT_CHILD_SYSTEM).toContain('narrowest available tool that fits the task')
    expect(DEFAULT_CHILD_SYSTEM).toContain('Your FINAL message is the entire deliverable')
    expect(DEFAULT_CHILD_SYSTEM).toContain('You cannot delegate')
  })
})
