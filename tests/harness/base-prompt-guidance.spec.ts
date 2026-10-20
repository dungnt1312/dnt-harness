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
    expect(DEFAULT_BASE_SYSTEM).toContain('Do not repeat a hypothesis or search parameters without new information')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/Do not re-read or re-run what you already have just to be sure/)
    expect(DEFAULT_BASE_SYSTEM).toContain('report it as absent and stop')
  })

  it('allows evidence-based refinement instead of banning any pattern change (QH-1 §11.3)', () => {
    // The old absolute ban ("never retry it with a slightly different pattern")
    // blocked the right move for a misspelled symbol or a wrong alias/path.
    expect(DEFAULT_BASE_SYSTEM).not.toMatch(/never retry it with a slightly different pattern/)
    expect(DEFAULT_BASE_SYSTEM).toMatch(/refine only when evidence points somewhere new/)
    expect(DEFAULT_BASE_SYSTEM).toMatch(/a corrected spelling, alias or path/)
  })

  it('re-verifies when something changed instead of a blanket "verify once"', () => {
    expect(DEFAULT_BASE_SYSTEM).not.toContain('verify once')
    expect(DEFAULT_BASE_SYSTEM).toMatch(/verify again after code or data changed, after an error, or while a concern is unresolved/)
  })

  it('stays no longer than the pre-calibration wording (budget-sensitive goldens)', () => {
    // The pre-calibration span (Ground… up to tool selection) was 756 chars; a
    // longer draft pushed tight-budget compaction fixtures over their window.
    const calibrated = DEFAULT_BASE_SYSTEM.slice(DEFAULT_BASE_SYSTEM.indexOf('Ground every claim'), DEFAULT_BASE_SYSTEM.indexOf('Use the narrowest'))
    expect(calibrated.length).toBeLessThanOrEqual(756)
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

/**
 * Behavioral fixtures (string-level). Each scenario names the prompt clauses a
 * model needs to take the right action. This checks that the guidance exists,
 * not how a live model behaves. The opt-in live eval of the first three cases,
 * scoring recall together with tool count, is `scripts/prompt-eval/run.ts`
 * (scorer tests: tests/scripts/prompt-eval-score.spec.ts).
 */
describe('prompt behavioral fixtures (string-level)', () => {
  const scenarios: Array<{ name: string; needs: RegExp[]; forbids: RegExp[] }> = [
    {
      name: 'misspelled symbol: Grep "applyDiscount" finds nothing; the file defines applyDiscounts → refine the spelling',
      needs: [/refine only when evidence points somewhere new/, /corrected spelling/],
      forbids: [/never retry it with a slightly different pattern/],
    },
    {
      name: 'wrong alias/path: import "@/lib/x" does not resolve; tsconfig maps @ → src → search the mapped path',
      needs: [/alias or path/],
      forbids: [/never retry/],
    },
    {
      name: 'true absence: fraudScore is not in the project → stop after evidence-based searches and say so',
      needs: [/Do not repeat a hypothesis or search parameters without new information/, /report it as absent and stop/, /Stop researching once you can answer/],
      forbids: [],
    },
    {
      name: 'after an edit the tests must be re-run, even though they ran before',
      needs: [/verify again after code or data changed/],
      forbids: [/verify once/],
    },
  ]
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      for (const need of scenario.needs) expect(DEFAULT_BASE_SYSTEM).toMatch(need)
      for (const forbid of scenario.forbids) expect(DEFAULT_BASE_SYSTEM).not.toMatch(forbid)
    })
  }
})
