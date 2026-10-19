import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../src/index.ts'
import {
  FIXTURE_FILES,
  PROMPT_EVAL_CASES,
  citesInventedLocation,
  formatScore,
  scoreCase,
  transcriptOf,
  type PromptEvalCase,
  type PromptEvalTranscript,
} from '../../scripts/prompt-eval/score.ts'

const byId = (id: string): PromptEvalCase => {
  const found = PROMPT_EVAL_CASES.find((testCase) => testCase.id === id)
  if (found === undefined) throw new Error(`no case ${id}`)
  return found
}
const call = (name: string, args: Record<string, unknown>) => ({ name, args })
const transcript = (finalAnswer: string, toolCalls: PromptEvalTranscript['toolCalls'], completed = true): PromptEvalTranscript => ({ completed, toolCalls, finalAnswer })

describe('prompt eval fixture', () => {
  it('covers the three required behaviors', () => {
    expect(PROMPT_EVAL_CASES.map((testCase) => testCase.id)).toEqual(['misspelled-symbol', 'wrong-path-alias', 'nonexistent-feature'])
  })

  it('makes each case answerable only by a changed search, or not at all', () => {
    const all = Object.entries(FIXTURE_FILES)
    // The misspelled name and the stated path do not exist; the real ones do.
    expect(all.some(([, body]) => body.includes('calculateShipingFee'))).toBe(false)
    expect(FIXTURE_FILES['src/shipping/fees.ts']).toContain('export function calculateShippingFee')
    expect(Object.keys(FIXTURE_FILES)).not.toContain('lib/format/currency.ts')
    expect(FIXTURE_FILES['tsconfig.json']).toContain('src/shared/format/*')
    expect(FIXTURE_FILES['src/shared/format/currency.ts']).toContain('toFixed(2)')
    // True absence: nothing mentions fraudScore, in any spelling.
    expect(all.some(([, body]) => /fraud/i.test(body))).toBe(false)
    // Prompts state the wrong spelling/path the model has to correct.
    expect(byId('misspelled-symbol').prompt).toContain('calculateShipingFee')
    expect(byId('wrong-path-alias').prompt).toContain('lib/format/currency.ts')
  })
})

describe('scoreCase: recall together with tool count', () => {
  it('passes a corrected-spelling answer after an evidence-based refined search', () => {
    const score = scoreCase(byId('misspelled-symbol'), transcript(
      'It is `calculateShippingFee` (the name is misspelled) in src/shipping/fees.ts; at subtotal 150 it returns 0 because shipping is free from 100.',
      [call('Grep', { pattern: 'calculateShipingFee' }), call('Grep', { pattern: 'ShippingFee' }), call('Read', { path: 'src/shipping/fees.ts' })],
    ))
    expect(score).toMatchObject({ pass: true, recalled: 3, factCount: 3, toolCalls: 3, duplicateCalls: 0, reasons: [] })
  })

  it('fails a cheap answer that misses facts: few tools never compensate for recall', () => {
    const score = scoreCase(byId('misspelled-symbol'), transcript(
      'No function named calculateShipingFee exists in this project.',
      [call('Grep', { pattern: 'calculateShipingFee' })],
    ))
    expect(score.pass).toBe(false)
    expect(score.recalled).toBe(0)
    expect(score.missing).toEqual(['corrected symbol', 'defining file', 'returns 0 at subtotal 150'])
  })

  it('does not read "100" or "4.5" as the returned 0', () => {
    const score = scoreCase(byId('misspelled-symbol'), transcript(
      'calculateShippingFee in src/shipping/fees.ts returns 4.5 + weightKg * 1.2 below 100.',
      [call('Read', { path: 'src/shipping/fees.ts' })],
    ))
    expect(score.missing).toEqual(['returns 0 at subtotal 150'])
  })

  it('fails a complete answer whose search repeated identical parameters', () => {
    const score = scoreCase(byId('wrong-path-alias'), transcript(
      'lib/format/currency.ts does not exist; @fmt maps to src/shared/format, and src/shared/format/currency.ts uses toFixed(2): 2 decimal places.',
      [
        call('Read', { path: 'lib/format/currency.ts' }),
        call('Read', { path: 'lib/format/currency.ts' }),
        call('Read', { path: 'tsconfig.json' }),
        call('Read', { path: 'src/shared/format/currency.ts' }),
      ],
    ))
    expect(score.recalled).toBe(2)
    expect(score.duplicateCalls).toBe(1)
    expect(score.pass).toBe(false)
    expect(score.reasons).toEqual(['repeated identical calls: 1'])
  })

  it('treats argument key order as the same call, but a changed parameter as a new one', () => {
    const repeated = scoreCase(byId('nonexistent-feature'), transcript('fraudScore is not found anywhere.', [
      call('Grep', { pattern: 'fraudScore', glob: '**/*.ts' }),
      call('Grep', { glob: '**/*.ts', pattern: 'fraudScore' }),
    ]))
    expect(repeated.duplicateCalls).toBe(1)
    const refined = scoreCase(byId('nonexistent-feature'), transcript('fraudScore is not found anywhere.', [
      call('Grep', { pattern: 'fraudScore' }),
      call('Grep', { pattern: 'fraud', '-i': true }),
    ]))
    expect(refined).toMatchObject({ duplicateCalls: 0, pass: true })
  })

  it('fails a complete answer that searched past the threshold', () => {
    const calls = Array.from({ length: 9 }, (_, index) => call('Grep', { pattern: `fraud${index}` }))
    const score = scoreCase(byId('nonexistent-feature'), transcript('There is no fraudScore validation in this project.', calls))
    expect(score.recalled).toBe(1)
    expect(score.pass).toBe(false)
    expect(score.reasons).toEqual(['over threshold: 9 tool calls > 8'])
  })

  it('stops on true absence: passes "absent" with a real citation, fails an invented location', () => {
    const searched = [call('Grep', { pattern: 'fraudScore' }), call('Grep', { pattern: 'fraud', '-i': true })]
    expect(scoreCase(byId('nonexistent-feature'), transcript('The project does not validate `fraudScore`; it is not referenced anywhere. validateOrder in src/orders/validate.ts only checks email, items and quantity.', searched)).pass).toBe(true)
    // Citing the real neighbouring validator, with its real lines, is verifiable.
    expect(scoreCase(byId('nonexistent-feature'), transcript('fraudScore is not referenced anywhere. The only order validation is `validateOrder` in `src/orders/validate.ts:3-9`.', searched)).pass).toBe(true)
    for (const answer of [
      'fraudScore is not validated directly, but see src/orders/fraud.ts:12.',
      'fraudScore is not found; the check is near src/orders/validate.ts:40.',
      'fraudScore is not found; see src/orders/validate.ts:8-30.',
    ]) {
      const invented = scoreCase(byId('nonexistent-feature'), transcript(answer, searched))
      expect(invented.pass, answer).toBe(false)
      expect(invented.forbiddenHits).toContain('cites an invented location')
    }
  })

  it('matches cited absolute paths by their fixture-relative suffix', () => {
    expect(citesInventedLocation('see /tmp/dnt-prompt-eval-x/src/orders/validate.ts:3')).toBe(false)
    expect(citesInventedLocation('see ./src/shipping/fees.ts:5')).toBe(false)
    expect(citesInventedLocation('see /tmp/dnt-prompt-eval-x/src/orders/validate.ts:0')).toBe(true)
    expect(citesInventedLocation('see lib/orders/validate.ts:3')).toBe(true)
  })

  it('fails an answer with no tool call, and a turn that did not complete', () => {
    expect(scoreCase(byId('nonexistent-feature'), transcript('fraudScore does not exist.', [])).reasons).toEqual(['ungrounded: 0 tool calls < 1'])
    const stopped = scoreCase(byId('wrong-path-alias'), transcript('src/shared/format/currency.ts uses toFixed(2).', [call('Glob', { pattern: '**/currency.ts' })], false))
    expect(stopped).toMatchObject({ pass: false, recalled: 2, reasons: ['turn did not complete'] })
  })
})

describe('scoreCase: review hardening', () => {
  const searched = [call('Grep', { pattern: 'fraudScore' }), call('Grep', { pattern: 'fraud', '-i': true })]
  const absent = (answer: string) => scoreCase(byId('nonexistent-feature'), transcript(answer, searched))

  it('fails a real line attributed to the nonexistent symbol', () => {
    const score = absent('fraudScore is not validated directly, but it is checked at src/orders/validate.ts:5.')
    expect(score.pass).toBe(false)
    expect(score.forbiddenHits).toContain('attributes a location to the nonexistent symbol')
  })

  it('fails a hedged absence ("not … directly, but")', () => {
    for (const answer of [
      'fraudScore is not validated directly, but validateOrder in src/orders/validate.ts covers it.',
      'fraudScore is not referenced anywhere; it may be validated indirectly through validateOrder.',
    ]) {
      const score = absent(answer)
      expect(score.pass, answer).toBe(false)
      expect(score.forbiddenHits, answer).toContain('hedges the absence')
    }
  })

  it('passes the honest live answer: absence stated, the real validator cited in a sentence without the symbol', () => {
    expect(absent('`fraudScore` is not referenced anywhere in the project. The only order validation is `validateOrder` in `src/orders/validate.ts:3-9`, and it checks only three things: email, items and quantity.').pass).toBe(true)
  })

  it('fails an invented location written as "path at line N" or a nonexistent fixture path', () => {
    for (const answer of [
      'fraudScore is not found; the closest is src/orders/fraud.ts at line 12.',
      'fraudScore is validated in src/orders/fraud.ts at line 12',
      'fraudScore is not referenced anywhere; see src/orders/risk.ts.',
      'fraudScore is not found; validateOrder in src/orders/validate.ts at line 40 checks orders.',
    ]) {
      const score = absent(answer)
      expect(score.pass, answer).toBe(false)
      expect(score.forbiddenHits, answer).toContain('cites an invented location')
    }
    expect(citesInventedLocation('validateOrder in src/orders/validate.ts at lines 3-9 checks orders.')).toBe(false)
    expect(citesInventedLocation('validateOrder in validate.ts:3 checks orders.')).toBe(false)
  })

  it('passes live absence answers that cite real lines of the real validator around a negated mention', () => {
    for (const answer of [
      'The only order validation is `src/orders/validate.ts`, `validateOrder` at lines 3–9, and it checks only `email`, `items`, and per-item `quantity`. Its `Order` interface (line 1) has no `fraudScore` field.',
      'A case-insensitive search for `fraud` across the workspace returns no matches, and the only order-validation code is `src/orders/validate.ts`, which checks just three things: `email` (line 5), `items` non-empty (line 6), and `quantity > 0` per item (line 7).',
      'Order validation lives in `src/orders/validate.ts`, lines 3–9, but it only checks:\n- email contains `@` (line 5)\n- at least one item (line 6)\n\nThere is no fraud-score field in the `Order` interface (line 1) either.',
      '- The only order validation is `validateOrder` in `src/orders/validate.ts:3`, which checks `email`, non-empty `items`, and `quantity` > 0 — no fraud-related field.',
    ]) {
      const score = absent(`There is no \`fraudScore\` validation in this project. ${answer}`)
      expect(score.forbiddenHits, answer).toEqual([])
      expect(score.pass, answer).toBe(true)
    }
  })

  it('still fails a negated mention that turns into a claim, and a bare line with no file cited before it', () => {
    for (const answer of [
      'There is no fraudScore field, but it is checked at src/orders/validate.ts:5.',
      'fraudScore is not found, except in src/orders/validate.ts at line 5.',
      'There is no `fraudScore` validation in src/orders/validate.ts. fraudScore is checked at line 5.',
    ]) expect(absent(answer).forbiddenHits, answer).toContain('attributes a location to the nonexistent symbol')
    expect(citesInventedLocation('fraudScore is not referenced anywhere. The check is at line 5.')).toBe(true)
    expect(citesInventedLocation('See src/orders/validate.ts. The check is at line 12.')).toBe(true)
  })

  it('fails a wrong-path answer that only restates the stated path', () => {
    const score = scoreCase(byId('wrong-path-alias'), transcript('lib/format/currency.ts uses toFixed(2): 2 decimal places.', [call('Read', { path: 'lib/format/currency.ts' })]))
    expect(score).toMatchObject({ pass: false, recalled: 1, missing: ['resolved file'] })
  })

  it('passes exactly at the 8-call threshold', () => {
    const calls = Array.from({ length: 8 }, (_, index) => call('Grep', { pattern: `fraud${index}` }))
    expect(scoreCase(byId('nonexistent-feature'), transcript('There is no fraudScore validation in this project.', calls))).toMatchObject({ pass: true, toolCalls: 8 })
  })

  it('accepts "returns 0" or "free shipping" but not a negated or stray 0', () => {
    const fees = (answer: string) => scoreCase(byId('misspelled-symbol'), transcript(`calculateShippingFee in src/shipping/fees.ts: ${answer}`, [call('Read', { path: 'src/shipping/fees.ts' })]))
    for (const answer of ['at 150 it returns 0.', 'it returns `0`.', 'it returns $0.00.', 'subtotal 150 is over 100, so shipping is free.', 'that gets free shipping.']) {
      expect(fees(answer).pass, answer).toBe(true)
    }
    for (const answer of ['shipping is not free at 150.', 'there is no free shipping; it returns 4.5 + 1.2 per kg.', 'see line 10; it costs 4.5 plus 1.2 per kg.', 'with 0 kg it returns 4.5.']) {
      expect(fees(answer).missing, answer).toEqual(['returns 0 at subtotal 150'])
    }
  })
})

describe('transcriptOf', () => {
  const stamp = { seq: 0, ts: 0 } as const
  it('reads tool calls, the last non-empty answer and the end reason of the last turn only', () => {
    const events = [
      { type: 'turn/start', turnId: 't1' },
      { type: 'tool/call', stepId: 's0', call: { id: 'c0', name: 'Read', args: { path: 'old' } } },
      { type: 'turn/end', turnId: 't1', reason: 'completed' },
      { type: 'turn/start', turnId: 't2' },
      { type: 'assistant/message', stepId: 's1', content: '', toolCalls: [{ id: 'c1', name: 'Grep', args: { pattern: 'x' } }] },
      { type: 'tool/call', stepId: 's1', call: { id: 'c1', name: 'Grep', args: { pattern: 'x' } } },
      { type: 'assistant/message', stepId: 's2', content: 'final answer' },
      { type: 'assistant/message', stepId: 's3', content: '   ' },
      { type: 'turn/end', turnId: 't2', reason: 'completed' },
    ].map((event) => ({ ...stamp, ...event })) as unknown as SessionEvent[]
    expect(transcriptOf(events)).toEqual({ completed: true, toolCalls: [{ name: 'Grep', args: { pattern: 'x' } }], finalAnswer: 'final answer' })
  })

  it('is not completed when the turn errored or never ended', () => {
    const events = [{ type: 'turn/start', turnId: 't1' }, { type: 'turn/error', turnId: 't1', kind: 'provider', message: 'x' }]
      .map((event) => ({ seq: 0, ts: 0, ...event })) as unknown as SessionEvent[]
    expect(transcriptOf(events).completed).toBe(false)
  })
})

describe('formatScore', () => {
  it('prints counts and reasons, never the answer text or tool arguments', () => {
    const line = formatScore(scoreCase(byId('nonexistent-feature'), transcript('SECRET-ANSWER see src/orders/fraud.ts:5', [call('Grep', { pattern: 'SECRET-ARG' })])))
    expect(line).toBe('prompt-eval FAIL: case=nonexistent-feature recall=0/1 toolCalls=1 (Grep:1) duplicates=0 completed=true reasons=[missing: reports absence; forbidden: cites an invented location]')
    expect(line).not.toContain('SECRET')
  })
})
