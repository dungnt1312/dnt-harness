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

  it('bounds scope and says when to stop, so a high effort level cannot loop on search', () => {
    // Measured: without these the same model on the same task spent 37 steps /
    // 69 tool calls at effort `max` — repeatedly grepping one file for an API
    // that did not exist — against 12 steps / 21 calls for the same request
    // driven by a prompt that carried the discipline below. Verification is
    // still owed; re-verifying ground already covered is not.
    expect(DEFAULT_BASE_SYSTEM).toContain('Answer the question that was asked and stop there')
    expect(DEFAULT_BASE_SYSTEM).toContain('Stop researching once you can answer')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/never retry it with a slightly different pattern/)
    expect(DEFAULT_BASE_SYSTEM).toMatch(/do not re-read or re-run something you already have/)
    expect(DEFAULT_BASE_SYSTEM).toContain('verify once with a tool when that is cheap')
  })

  it('selects tools by task, not semantic-search-first, and shares the principle with the child prompt', () => {
    expect(DEFAULT_BASE_SYSTEM).toContain('prefer the dedicated file and search tools over shell commands')
    expect(DEFAULT_BASE_SYSTEM).toContain('any line range of them, with Read')
    expect(DEFAULT_BASE_SYSTEM).toContain('Use Bash to run programs (builds, tests, Git, package managers)')
    expect(DEFAULT_BASE_SYSTEM).not.toMatch(/Prefer the narrowest tool/)
    expect(DEFAULT_CHILD_SYSTEM).toContain('narrowest available tool that fits the task')
    expect(DEFAULT_CHILD_SYSTEM).toContain('Your FINAL message is the entire deliverable')
    expect(DEFAULT_CHILD_SYSTEM).toContain('You cannot delegate')
  })
})
