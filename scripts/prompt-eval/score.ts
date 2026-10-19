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

const PATH = /[\w./-]*[\w-]\.(?:ts|js|json|md)\b/g
/** `path:N`, `path:N-M`, or `line(s) N[-M]` in prose. */
const LINE_REF = /\.(?:ts|js|json|md):(\d+)(?:-(\d+))?|\blines?\s+(\d+)(?:\s*(?:-|–|to)\s*(\d+))?/gi

const sentencesOf = (answer: string): string[] => answer.split(/(?<=[.!?])\s+|\n+/).filter((sentence) => sentence.trim() !== '')

/** The fixture file a cited path names: exact, an absolute path's suffix, or a unique basename-style suffix. */
function fixtureFileOf(cited: string): string | undefined {
  const normalized = cited.replace(/^\.\//, '')
  const keys = Object.keys(FIXTURE_FILES)
  const exact = keys.find((relative) => normalized === relative || normalized.endsWith(`/${relative}`))
  if (exact !== undefined) return exact
  const partial = keys.filter((relative) => relative.endsWith(`/${normalized}`))
  return partial.length === 1 ? partial[0] : undefined
}

/**
 * True when the answer cites a location that does not exist in the fixture:
 * a path naming no fixture file, or a line (as `path:N` or "line N" in the
 * same sentence) past the cited file's end. A citation of real code (say,
 * the neighbouring validator the user asked about) is verifiable and allowed.
 */
export function citesInventedLocation(answer: string): boolean {
  // A bare "line N" refers to the file most recently cited: the same
  // sentence's, or else the previous one that cited any ("Its interface
  // (line 1) …" after naming the file). With no file cited yet it is invented.
  let previous: string[] = []
  for (const sentence of sentencesOf(answer)) {
    const cited: string[] = []
    for (const match of sentence.matchAll(PATH)) {
      const file = fixtureFileOf(match[0])
      if (file === undefined) return true
      cited.push(file)
    }
    if (cited.length > 0) previous = cited
    const files = cited.length > 0 ? cited : previous
    for (const match of sentence.matchAll(LINE_REF)) {
      const numbers = [match[1], match[2], match[3], match[4]].filter((value) => value !== undefined).map(Number)
      const last = Math.max(...numbers)
      const first = Math.min(...numbers)
      // A line must fall inside at least one file this sentence cites.
      if (first < 1 || !files.some((file) => last <= lineCount(FIXTURE_FILES[file]!))) return true
    }
  }
  return false
}

/** "no `fraudScore` field", "without fraud …": a negator just before the mention. */
const NEGATED_BEFORE = /\b(?:no|without)\b[^.\n\w]{0,4}$/i
/** "search for `fraud` …": the mention is what a search looked for. */
const SEARCHED_FOR = /\b(?:search(?:ed|ing|es)?|grep(?:ped|ping)?|look(?:ed|ing)?|query|queried)\b(?:\s+for)?[^.\n\w]{0,4}$/i
/** "… returns no matches": that search found nothing (only counts after {@link SEARCHED_FOR}). */
const NEGATED_AFTER = /^[^.\n]{0,60}?\b(?:returns?|returned|gave|gives|found)\s+(?:no\s+(?:matches|results|hits|occurrences)|nothing)\b/i
/** A contrast turns an absence back into a claim ("no X, but it is checked at …"). */
const CONTRAST = /\b(?:but|except|however|although|though)\b/i

/**
 * A sentence that names the symbol (outside any path) and also gives a line
 * location for it. A mention that is itself negated — "has no `fraudScore`
 * field", or the object of a search that "returns no matches" — claims nothing about
 * the symbol, so a line in that sentence locates the real code it describes;
 * unless the sentence turns on a contrast ("but", "except").
 */
export function attributesLocationTo(symbol: RegExp): (answer: string) => boolean {
  const global = new RegExp(symbol.source, symbol.flags.includes('g') ? symbol.flags : `${symbol.flags}g`)
  return (answer) => sentencesOf(answer).some((sentence) => {
    if (!new RegExp(LINE_REF.source, 'i').test(sentence)) return false
    const prose = sentence.replace(PATH, '')
    const mentions = [...prose.matchAll(global)]
    if (mentions.length === 0) return false
    if (CONTRAST.test(prose)) return true
    return mentions.some((mention) => {
      const at = mention.index ?? 0
      const before = prose.slice(Math.max(0, at - 30), at)
      const after = prose.slice(at + mention[0].length)
      return !NEGATED_BEFORE.test(before) && !(SEARCHED_FOR.test(before) && NEGATED_AFTER.test(after))
    })
  })
}

/** "not … directly, but …", "indirectly": an absence hedged into a partial claim. */
const HEDGED_ABSENCE = [
  /\b(?:not|n['’]t)\b[^.\n]{0,40}\bdirectly\b/i,
  /\bindirectly\b/i,
  /\b(?:not|n['’]t)\b[^.\n]{0,60}\bbut\s+(?:it|this|that|fraudScore)\s+is\b/i,
]

export const PROMPT_EVAL_CASES: readonly PromptEvalCase[] = [
  {
    id: 'misspelled-symbol',
    prompt: 'Where is `calculateShipingFee` defined, and what does it return when the subtotal is 150?',
    facts: [
      { name: 'corrected symbol', anyOf: [/calculateShippingFee/] },
      { name: 'defining file', anyOf: [/src\/shipping\/fees\.ts/] },
      {
        name: 'returns 0 at subtotal 150',
        anyOf: [
          /\breturn(?:s|ed)?\b[^.\d\n]{0,20}?(?<![\w.])[`$]{0,2}0(?:\.00)?(?!\d|\.\d|\s*(?:kg|%))/i,
          /(?<!\b(?:not|no)\s+(?:\w+\s+)?)\b(?:free shipping|shipping is free)\b/i,
        ],
      },
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
    forbidden: [
      { name: 'cites an invented location', hit: citesInventedLocation },
      { name: 'attributes a location to the nonexistent symbol', hit: attributesLocationTo(/fraud/i) },
      { name: 'hedges the absence', hit: (answer) => HEDGED_ABSENCE.some((pattern) => pattern.test(answer)) },
    ],
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
