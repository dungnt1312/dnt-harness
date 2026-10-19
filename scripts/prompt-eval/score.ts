/**
 * Behavioral prompt eval: the fixture repository, the cases and the scorer.
 *
 * Pure (no IO, no model): `run.ts` drives a live model through the real agent
 * loop and hands the resulting session events here; the spec in
 * `tests/scripts/prompt-eval-score.spec.ts` feeds synthetic transcripts.
 *
 * Each case scores recall (the facts a correct answer must state) together
 * with tool use. A case passes only when the answer is complete AND the
 * search was disciplined: no claim the evidence cannot support, no identical
 * call repeated without new information, and a tool count within the case's
 * scoring threshold. The threshold judges the transcript afterwards; it is
 * not a runtime step cap, and a low tool count never compensates for missing
 * recall.
 */
import type { SessionEvent } from '../../src/index.ts'

/** Files of the disposable fixture repository, relative path → content. */
export const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'package.json': `${JSON.stringify({ name: 'shop-fixture', private: true, type: 'module' }, null, 2)}\n`,
  'tsconfig.json': `${JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@fmt/*': ['src/shared/format/*'] } } }, null, 2)}\n`,
  'README.md': '# shop-fixture\n\nA tiny cart library: shipping fees, price formatting and order validation.\n',
  'src/shipping/fees.ts': [
    'export const FREE_SHIPPING_THRESHOLD = 100',
    '',
    '/** Flat fee plus a per-kilogram rate; free at or above the threshold. */',
    'export function calculateShippingFee(subtotal: number, weightKg: number): number {',
    '  if (subtotal >= FREE_SHIPPING_THRESHOLD) return 0',
    '  return 4.5 + weightKg * 1.2',
    '}',
    '',
  ].join('\n'),
  'src/shared/format/currency.ts': [
    'export function formatPrice(amount: number): string {',
    '  return `$${amount.toFixed(2)}`',
    '}',
    '',
  ].join('\n'),
  'src/cart/summary.ts': [
    "import { calculateShippingFee } from '../shipping/fees.ts'",
    "import { formatPrice } from '@fmt/currency'",
    '',
    'export interface CartLine { readonly price: number; readonly quantity: number; readonly weightKg: number }',
    '',
    'export function cartSummary(lines: readonly CartLine[]): string {',
    '  const subtotal = lines.reduce((sum, line) => sum + line.price * line.quantity, 0)',
    '  const weight = lines.reduce((sum, line) => sum + line.weightKg * line.quantity, 0)',
    '  const shipping = calculateShippingFee(subtotal, weight)',
    '  return `${formatPrice(subtotal)} + ${formatPrice(shipping)} shipping`',
    '}',
    '',
  ].join('\n'),
  'src/orders/validate.ts': [
    'export interface Order { readonly email: string; readonly items: readonly { readonly sku: string; readonly quantity: number }[] }',
    '',
    'export function validateOrder(order: Order): string[] {',
    '  const errors: string[] = []',
    "  if (!order.email.includes('@')) errors.push('email')",
    "  if (order.items.length === 0) errors.push('items')",
    "  for (const item of order.items) if (item.quantity <= 0) errors.push(`quantity:${item.sku}`)",
    '  return errors',
    '}',
    '',
  ].join('\n'),
}

export interface PromptEvalCase {
  readonly id: string
  readonly prompt: string
  /** Each fact is satisfied when ANY of its patterns matches the final answer. */
  readonly facts: readonly { readonly name: string; readonly anyOf: readonly RegExp[] }[]
  /** Claims the evidence cannot support; any hit fails the case. */
  readonly forbidden: readonly { readonly name: string; readonly hit: (answer: string) => boolean }[]
  /** Fewest tool calls a grounded answer needs (0 = none required). */
  readonly minToolCalls: number
  /** Scoring threshold for a disciplined search of this five-file fixture. */
  readonly maxToolCalls: number
}

const lineCount = (body: string): number => body.split('\n').length - (body.endsWith('\n') ? 1 : 0)

/**
 * True when the answer cites a `path:line` (or `path:start-end`) that does not
 * exist in the fixture: an unknown file or a line past its end. A citation of
 * real code (say, the neighbouring validator the user asked about) is
 * verifiable and allowed; an invented location is not. Absolute paths match
 * by their fixture-relative suffix.
 */
export function citesInventedLocation(answer: string): boolean {
  for (const match of answer.matchAll(/([\w./-]+\.(?:ts|js|json|md)):(\d+)(?:-(\d+))?/g)) {
    const cited = match[1]!.replace(/^\.\//, '')
    const file = Object.keys(FIXTURE_FILES).find((relative) => cited === relative || cited.endsWith(`/${relative}`))
    if (file === undefined) return true
    const last = Math.max(Number(match[2]), Number(match[3] ?? match[2]))
    if (last < 1 || last > lineCount(FIXTURE_FILES[file]!)) return true
  }
  return false
}

export const PROMPT_EVAL_CASES: readonly PromptEvalCase[] = [
  {
    id: 'misspelled-symbol',
    prompt: 'Where is `calculateShipingFee` defined, and what does it return when the subtotal is 150?',
    facts: [
      { name: 'corrected symbol', anyOf: [/calculateShippingFee/] },
      { name: 'defining file', anyOf: [/src\/shipping\/fees\.ts/] },
      { name: 'returns 0 at subtotal 150', anyOf: [/(?<![\d.])0(?![\d.])/, /\bfree\b/i] },
    ],
    forbidden: [],
    minToolCalls: 1,
    maxToolCalls: 8,
  },
  {
    id: 'wrong-path-alias',
    prompt: 'Open lib/format/currency.ts (the cart code imports it as @fmt/currency) and tell me how many decimal places formatPrice uses.',
    facts: [
      { name: 'resolved file', anyOf: [/src\/shared\/format\/currency\.ts/] },
      { name: 'two decimal places', anyOf: [/toFixed\(2\)/, /\b2\b[^.\n]{0,20}decimal/i, /\btwo\b[^.\n]{0,20}decimal/i] },
    ],
    forbidden: [],
    minToolCalls: 1,
    maxToolCalls: 8,
  },
  {
    id: 'nonexistent-feature',
    prompt: 'Where does this project validate `fraudScore` on orders? Give the file and line.',
    facts: [
      {
        name: 'reports absence',
        anyOf: [
          /\b(?:not|never|isn['’]t|aren['’]t)\b[^.\n]{0,40}\b(?:found|present|exist|exists|defined|validated|referenced|mentioned|anywhere)\b/i,
          /\bno\b[^.\n]{0,30}\b(?:validation|reference|references|mention|mentions|occurrence|occurrences|match|matches|usage|code)\b/i,
          /\b(?:does|do)\s*(?:n['’]t|\s+not)\s+(?:exist|appear|validate|contain|have|check|reference)\b/i,
          /\bnowhere\b/i,
          /\babsent\b/i,
        ],
      },
    ],
    forbidden: [{ name: 'cites an invented file:line', hit: citesInventedLocation }],
    minToolCalls: 1,
    maxToolCalls: 8,
  },
]

/** What the scorer needs from one turn. Holds no provider or key data. */
export interface PromptEvalTranscript {
  /** The turn ended with reason `completed` (not stopped, errored or timed out). */
  readonly completed: boolean
  readonly toolCalls: readonly { readonly name: string; readonly args: Record<string, unknown> }[]
  /** The last non-empty assistant message of the turn. */
  readonly finalAnswer: string
}

export interface PromptEvalScore {
  readonly id: string
  readonly pass: boolean
  readonly completed: boolean
  readonly recalled: number
  readonly factCount: number
  readonly missing: readonly string[]
  readonly forbiddenHits: readonly string[]
  readonly toolCalls: number
  /** Calls whose name and arguments exactly repeat an earlier call. */
  readonly duplicateCalls: number
  /** Tool name → call count, for the report. */
  readonly toolsByName: Readonly<Record<string, number>>
  readonly reasons: readonly string[]
}

/** Stable key: object keys sorted at every depth, so key order is not "new information". */
function callKey(name: string, args: unknown): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]))
    }
    return value
  }
  return `${name}\u0000${JSON.stringify(canonical(args))}`
}

/** The transcript of the LAST turn in a session's events. */
export function transcriptOf(events: readonly SessionEvent[]): PromptEvalTranscript {
  const start = events.findLastIndex((event) => event.type === 'turn/start')
  const turn = start === -1 ? events : events.slice(start)
  const end = turn.findLast((event) => event.type === 'turn/end')
  const toolCalls = turn.flatMap((event) => event.type === 'tool/call' ? [{ name: event.call.name, args: event.call.args }] : [])
  const answers = turn.flatMap((event) => event.type === 'assistant/message' && event.content.trim() !== '' ? [event.content] : [])
  return {
    completed: end?.type === 'turn/end' && end.reason === 'completed',
    toolCalls,
    finalAnswer: answers.at(-1) ?? '',
  }
}

export function scoreCase(testCase: PromptEvalCase, transcript: PromptEvalTranscript): PromptEvalScore {
  const answer = transcript.finalAnswer
  const missing = testCase.facts.filter((fact) => !fact.anyOf.some((pattern) => pattern.test(answer))).map((fact) => fact.name)
  const forbiddenHits = testCase.forbidden.filter((rule) => rule.hit(answer)).map((rule) => rule.name)
  const seen = new Set<string>()
  let duplicateCalls = 0
  const toolsByName: Record<string, number> = {}
  for (const call of transcript.toolCalls) {
    const key = callKey(call.name, call.args)
    if (seen.has(key)) duplicateCalls++
    seen.add(key)
    toolsByName[call.name] = (toolsByName[call.name] ?? 0) + 1
  }
  const toolCalls = transcript.toolCalls.length
  const reasons: string[] = []
  if (!transcript.completed) reasons.push('turn did not complete')
  if (missing.length > 0) reasons.push(`missing: ${missing.join(', ')}`)
  if (forbiddenHits.length > 0) reasons.push(`forbidden: ${forbiddenHits.join(', ')}`)
  if (toolCalls < testCase.minToolCalls) reasons.push(`ungrounded: ${toolCalls} tool calls < ${testCase.minToolCalls}`)
  if (toolCalls > testCase.maxToolCalls) reasons.push(`over threshold: ${toolCalls} tool calls > ${testCase.maxToolCalls}`)
  if (duplicateCalls > 0) reasons.push(`repeated identical calls: ${duplicateCalls}`)
  return {
    id: testCase.id,
    pass: reasons.length === 0,
    completed: transcript.completed,
    recalled: testCase.facts.length - missing.length,
    factCount: testCase.facts.length,
    missing,
    forbiddenHits,
    toolCalls,
    duplicateCalls,
    toolsByName,
    reasons,
  }
}

/** One line per case with counts only — never answer text, arguments or keys. */
export function formatScore(score: PromptEvalScore): string {
  const tools = Object.entries(score.toolsByName).map(([name, count]) => `${name}:${count}`).join(',') || '-'
  return `prompt-eval ${score.pass ? 'pass' : 'FAIL'}: case=${score.id} recall=${score.recalled}/${score.factCount} toolCalls=${score.toolCalls} (${tools}) duplicates=${score.duplicateCalls} completed=${score.completed}${score.reasons.length > 0 ? ` reasons=[${score.reasons.join('; ')}]` : ''}`
}
