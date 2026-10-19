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
      expect(invented.forbiddenHits).toEqual(['cites an invented file:line'])
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
    expect(line).toBe('prompt-eval FAIL: case=nonexistent-feature recall=0/1 toolCalls=1 (Grep:1) duplicates=0 completed=true reasons=[missing: reports absence; forbidden: cites an invented file:line]')
    expect(line).not.toContain('SECRET')
  })
})
